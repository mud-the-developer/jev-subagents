import assert from "node:assert/strict";
import { test } from "node:test";
import { beginMemoryWalk, memoryCandidates, memoryDecisionData, memoryDigest, memoryProjectKey, memorySnapshot, stepMemoryWalk,
  validMemoryInput, validMemorySnapshot, validMemoryState, reduceMemoryFlow, type MemoryFlow, type MemoryState } from "../src/project-memory.ts";

function state(count = 2): MemoryState {
  return { version: 1, projectKey: memoryProjectKey("/fixture"), revision: 1,
    facts: Array.from({ length: count }, (_, i) => ({ id: `fact_${String(i).padStart(2, "0")}`, kind: "decision", title: `Public record ${i}`,
      content: `PRIVATE_BODY_${i}`, provenance: "Reviewed fixture, not an independent certificate.", createdRevision: 1 })),
    edges: count > 1 ? [{ from: "fact_00", to: "fact_01" }] : [] };
}
test("memory consent/freshness/disclosure reducer is deterministic, single-use and cannot create authority", () => {
  const input: MemoryFlow = { phase: "preparing", operation: "search" }, digest = "a".repeat(64);
  const review = reduceMemoryFlow(input, { type: "prepared", digest }); assert.deepEqual(review, reduceMemoryFlow(input, { type: "prepared", digest }));
  assert.deepEqual(review.effects, ["review"]);
  for (const accepted of [false, "true", 1]) assert.equal(reduceMemoryFlow(review.state, { type: "approval", digest, accepted }).state.phase, "done");
  assert.equal(reduceMemoryFlow(review.state, { type: "approval", digest: "b".repeat(64), accepted: true }).state.phase, "done");
  const checking = reduceMemoryFlow(review.state, { type: "approval", digest, accepted: true }); assert.deepEqual(checking.effects, ["check"]);
  assert.equal(reduceMemoryFlow(checking.state, { type: "fresh", current: false }).state.phase, "done");
  const navigating = reduceMemoryFlow(checking.state, { type: "fresh", current: true }); assert.deepEqual(navigating.effects, ["navigate"]);
  const handedOff = reduceMemoryFlow(navigating.state, { type: "navigation", uncertain: true, selected: 0 });
  assert.deepEqual(handedOff.state, { phase: "done", outcome: "parent_lookup" }); assert.deepEqual(handedOff.effects, ["parent_lookup"]);
  assert.equal(reduceMemoryFlow(handedOff.state, { type: "prepared", digest }).state, handedOff.state);
  assert.deepEqual(reduceMemoryFlow(navigating.state, { type: "navigation", uncertain: true, selected: 9 }).state, { phase: "done", outcome: "needs_review" });
  const disclosing = reduceMemoryFlow(navigating.state, { type: "navigation", uncertain: false, selected: 1 }); assert.deepEqual(disclosing.effects, ["disclose"]);
  assert.equal(reduceMemoryFlow(disclosing.state, { type: "disclosure", accepted: "true" }).state.phase, "done");
  const finalCheck = reduceMemoryFlow(disclosing.state, { type: "disclosure", accepted: true }); assert.deepEqual(finalCheck.effects, ["check"]);
  const returning = reduceMemoryFlow(finalCheck.state, { type: "fresh", current: true }); assert.deepEqual(returning.effects, ["return_snapshot"]);
  const done = reduceMemoryFlow(returning.state, { type: "complete" }).state;
  assert.deepEqual(done, { phase: "done", outcome: "completed" }); assert.equal(reduceMemoryFlow(done, { type: "prepared", digest }).state, done);
  for (const operation of ["create", "remember", "forget"] as const) {
    let state: MemoryFlow = { phase: "preparing", operation };
    state = reduceMemoryFlow(state, { type: "prepared", digest }).state; state = reduceMemoryFlow(state, { type: "approval", digest, accepted: true }).state;
    assert.deepEqual(reduceMemoryFlow(state, { type: "fresh", current: true }).effects, ["mutate"]);
  }
});

test("memory API is closed, explicit and project-bound; proposed facts are not grants", () => {
  const value = { operation: "remember", directory: "/private", expectedRevision: 1,
    record: { kind: "decision", title: "Public title", content: "Reviewed fact.", provenance: "Parent review only.", relatedIds: [] } };
  assert.equal(validMemoryInput(value), true);
  for (const invalid of [{ ...value, approved: true }, { ...value, record: { ...value.record, verified: true } },
    { ...value, record: { ...value.record, relatedIds: ["a", "a"] } }, { operation: "search", directory: "/private", query: "Find notes", maxVisits: 17, seconds: 30 }]) assert.equal(validMemoryInput(invalid), false);
  assert.notEqual(memoryProjectKey("/a"), memoryProjectKey("/b")); assert.equal(validMemoryState(state()), true);
  assert.equal(validMemoryState({ ...state(), edges: [{ from: "fact_01", to: "fact_00" }] }), false);
});
test("readonly memory snapshots bind original data, revision and project without granting authority", () => {
  const input = state(), before = structuredClone(input), snapshot = memorySnapshot(input, ["fact_00"]);
  assert.equal(validMemorySnapshot(snapshot, input.projectKey), true); assert.equal(snapshot.records[0]?.content, "PRIVATE_BODY_0");
  assert.equal(validMemorySnapshot(snapshot, memoryProjectKey("/other")), false);
  assert.equal(validMemorySnapshot({ ...snapshot, revision: 2 }), false);
  assert.equal(validMemorySnapshot({ ...snapshot, authority: true }), false);
  assert.throws(() => memorySnapshot(input, ["foreign"])); assert.deepEqual(input, before);
  const wide = { ...state(8), facts: state(8).facts.map(fact => ({ ...fact, content: "a".repeat(2000) })) };
  assert.throws(() => memorySnapshot(wide, wide.facts.map(fact => fact.id)));
  assert.equal(snapshot.digest, memoryDigest({ version: snapshot.version, projectKey: snapshot.projectKey, revision: snapshot.revision, records: snapshot.records }));
});
test("navigation pages retain every candidate within16 choices and send no full memory bodies", () => {
  let walk = beginMemoryWalk(state(64), "Find the reviewed decision.", 16);
  walk = stepMemoryWalk(walk, "node_decision", 1);
  const pages = memoryCandidates(walk).filter(candidate => candidate.target), found: string[] = [];
  assert.equal(pages.length, 5);
  for (const page of pages) {
    const current = stepMemoryWalk(walk, page.id, 1), choices = memoryCandidates(current);
    assert.ok(choices.length <= 16); found.push(...choices.flatMap(choice => choice.target ? [choice.target] : []));
    assert.doesNotMatch(JSON.stringify(memoryDecisionData(current)), /PRIVATE_BODY|provenance|createdRevision/);
  }
  assert.equal(new Set(found).size, 64);
});
test("each visited state makes one choice; acceptance, backtracking, limits and uncertainty never modify stored facts", () => {
  const input = state(), before = structuredClone(input); let walk = beginMemoryWalk(input, "Find the reviewed decision.", 8);
  for (const choice of ["node_decision", "node_0", "node_0", "accept"]) walk = stepMemoryWalk(walk, choice, 1);
  assert.deepEqual(walk.selected, ["fact_00"]); assert.equal(walk.visits, 4); assert.equal(walk.trail.length, 4);
  assert.equal(memoryCandidates(walk).some(candidate => candidate.target === "fact_00"), false);
  assert.equal(memoryCandidates(walk).some(candidate => candidate.target === "fact_01"), true);
  walk = stepMemoryWalk(walk, "back", 1); assert.equal(walk.current, "kind_decision");
  const weak = stepMemoryWalk(beginMemoryWalk(input, "Find notes.", 8), "node_decision", 0.49);
  assert.equal(weak.status, "uncertain"); assert.deepEqual(weak.selected, []); assert.deepEqual(weak.catalog, before);
  const limited = stepMemoryWalk(beginMemoryWalk(input, "Find notes.", 1), "node_decision", 1);
  assert.equal(limited.status, "limit"); assert.equal(limited.current, "catalog"); assert.deepEqual(limited.seen, []);
  assert.throws(() => stepMemoryWalk(beginMemoryWalk(input, "Find notes.", 8), "foreign", 1));
  assert.equal(beginMemoryWalk({ ...input, facts: [], edges: [] }, "Find notes.", 8).status, "done");
  assert.deepEqual(input, before);
});

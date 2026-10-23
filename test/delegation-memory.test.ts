import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryProjectKey, memorySnapshot, type MemoryFact } from "../src/project-memory.ts";
import { validDelegationMemoryInput, validDelegationMemorySource, validDelegationMemorySelection, delegationMemoryChoice,
  delegationMemoryRequest, selectDelegationMemory, type DelegationMemorySource } from "../src/delegation-memory.ts";

const old: MemoryFact = { id: "fact_old", kind: "decision", title: "Preserve parser API", content: "PRIVATE_APPROVED_BODY", provenance: "PRIVATE_APPROVED_PROVENANCE", createdRevision: 1 };
function source(): DelegationMemorySource { return { version: 1, projectKey: memoryProjectKey("/project"), directoryRef: "a".repeat(64), revision: 1,
  query: "Find the reviewed parser compatibility decision.", records: [{ ...old }], additions: [] }; }
function catalog(value = source()) { return memorySnapshot({ version: 1, projectKey: value.projectKey, revision: value.revision + value.additions.length, facts: value.records, edges: [] }, value.records.map(record => record.id)); }

test("delegation memory scope is closed, bounded and never accepts caller approval or ambient authority", () => {
  const input = { directory: "/private", query: "Find the parser decision.", ids: ["fact_old"] };
  assert.equal(validDelegationMemoryInput(input), true);
  for (const invalid of [{ ...input, approved: true }, { ...input, create: true }, { ...input, ids: ["fact_old", "fact_old"] }, { ...input, allowAll: true }]) assert.equal(validDelegationMemoryInput(invalid), false);
  const data = source(); assert.equal(validDelegationMemorySource(data, data.projectKey), true);
  assert.equal(validDelegationMemorySource(data, memoryProjectKey("/other")), false);
  assert.equal(validDelegationMemorySource({ ...data, directory: "/private" }), false);
  assert.equal(validDelegationMemorySource({ ...data, records: Array.from({ length: 9 }, (_, i) => ({ ...old, id: `fact_${i}` })) }), false);
  assert.equal(validDelegationMemorySource({ ...data, records: Array.from({ length: 8 }, (_, i) => ({ ...old, id: `fact_${i}`, content: "a".repeat(2000) })) }), false);
});

test("one bounded lookup sends visible title/kind choices, not bodies, provenance or storage references", () => {
  const data = source(), snapshot = catalog(data), request = delegationMemoryRequest(data, snapshot);
  assert.deepEqual(request.agents.map(item => item.name), ["record_0", "no_match"]);
  assert.match(request.agents[0]!.description, /Preserve parser API/);
  assert.match(request.task, /policy\/rule question/); assert.match(request.task, /exact value, identifier or date/);
  assert.match(request.agents.at(-1)!.description, /general rule does not supply a missing value/);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_APPROVED|directoryRef|\/private|\/project/);
  assert.deepEqual(delegationMemoryChoice(snapshot, "record_0", 0.9), { kind: "selected", ids: ["fact_old"] });
  assert.deepEqual(delegationMemoryChoice(snapshot, "no_match", 0.9), { kind: "selected", ids: [] });
  assert.deepEqual(delegationMemoryChoice(snapshot, "record_0", 0.49), { kind: "parent" });
  assert.throws(() => delegationMemoryChoice(snapshot, "foreign", 1));
});

test("child memory is only an exact approved subset, including exact predeclared additions", () => {
  const data = source(), snapshot = catalog(data);
  assert.equal(validDelegationMemorySelection(data, snapshot), true);
  assert.equal(selectDelegationMemory(data, snapshot, []), undefined);
  assert.throws(() => selectDelegationMemory(data, snapshot, ["foreign"]));
  const altered = memorySnapshot({ version: 1, projectKey: data.projectKey, revision: 1, facts: [{ ...old, content: "UNREVIEWED_BODY" }], edges: [] }, [old.id]);
  assert.equal(validDelegationMemorySelection(data, altered), false);
  const record = { kind: "constraint", title: "Protect tokens", content: "DECLARED_ADDITION_BODY", provenance: "Parent-reviewed synthetic source.", relatedIds: [] };
  data.additions = [record];
  const added = { id: "fact_" + "b".repeat(32), kind: record.kind, title: record.title, content: record.content, provenance: record.provenance, createdRevision: 2 };
  const next = memorySnapshot({ version: 1, projectKey: data.projectKey, revision: 2, facts: [old, added], edges: [] }, [old.id, added.id]);
  assert.equal(validDelegationMemorySelection(data, next), true);
  assert.deepEqual(selectDelegationMemory(data, next, [added.id])?.records, [added]);
  const wrong = memorySnapshot({ version: 1, projectKey: data.projectKey, revision: 2, facts: [{ ...added, createdRevision: 1 }], edges: [] }, [added.id]);
  assert.equal(validDelegationMemorySelection(data, wrong), false);
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prepareDelegationMemory, applyDelegationMemory, delegationMemoryIO } from "../src/delegation-memory-effects.ts";
import { memoryDigest, memoryProjectKey, type MemoryState } from "../src/project-memory.ts";
import { ProjectMemoryError } from "../src/project-memory-store.ts";
import { delegationMemoryRequest } from "../src/delegation-memory.ts";

function fixture(t: TestContext) {
  let state: MemoryState = { version: 1, projectKey: memoryProjectKey("/project"), revision: 1,
    facts: [{ id: "fact_old", kind: "decision", title: "Public existing note", content: "EXACT_OLD_BODY", provenance: "Reviewed fixture.", createdRevision: 1 }], edges: [] };
  let reads = 0, writes = 0, absent = false, epoch = 0;
  const token = () => memoryDigest({ state, epoch, absent });
  t.mock.method(delegationMemoryIO, "canonical", async (value: string) => value);
  t.mock.method(delegationMemoryIO, "probe", async (directory: string) => { assert.ok(absent); return { directory, token: token() }; });
  t.mock.method(delegationMemoryIO, "read", async (directory: string) => { reads++; assert.equal(absent, false); return { directory, token: token(), state: structuredClone(state) }; });
  t.mock.method(delegationMemoryIO, "mutate", async (input: Parameters<typeof delegationMemoryIO.mutate>[0], _key: string, expected: string) => {
    assert.equal(expected, token()); writes++;
    if (input.operation === "create") { assert.ok(absent); absent = false; state = { ...state, revision: 0, facts: [], edges: [] }; return { directory: input.directory, state: structuredClone(state), token: token() }; }
    assert.equal(input.operation, "remember"); if (input.operation !== "remember") assert.fail(); assert.equal(input.expectedRevision, state.revision);
    const id = `fact_${writes.toString(16).padStart(32, "0")}`; state = { ...state, revision: state.revision + 1, facts: [...state.facts,
      { id, kind: input.record.kind, title: input.record.title, content: input.record.content, provenance: input.record.provenance, createdRevision: state.revision + 1 }] };
    return { directory: input.directory, state: structuredClone(state), token: token(), id };
  });
  return { counts: () => ({ reads, writes }), empty: () => { absent = true; }, change: () => { epoch++; } };
}
test("memory preparation has no writes; the immutable approved catalog requires only one fresh store read", async t => {
  const f = fixture(t), signal = t.signal;
  const prepared = await prepareDelegationMemory({ directory: "/private", query: "Find existing note." }, "/project", signal);
  assert.deepEqual(f.counts(), { reads: 1, writes: 0 }); assert.doesNotMatch(JSON.stringify(prepared.data), /\/private/);
  const catalog = await applyDelegationMemory(prepared, signal); assert.ok(catalog); assert.equal(catalog.records[0]?.content, "EXACT_OLD_BODY");
  assert.deepEqual(f.counts(), { reads: 2, writes: 0 });
  delegationMemoryRequest(prepared.data, catalog); delegationMemoryRequest(prepared.data, catalog);
  assert.deepEqual(f.counts(), { reads: 2, writes: 0 }, "No store/ACL IPC per model decision");
});
test("one approved declaration creates and appends its known records without internal approval callbacks", async t => {
  const f = fixture(t); f.empty();
  const input = { directory: "/private", query: "Find the declared note.", create: true,
    remember: [{ kind: "decision", title: "Declared note", content: "EXACT_DECLARED_BODY", provenance: "Reviewed fixture.", relatedIds: [] }] };
  const prepared = await prepareDelegationMemory(input, "/project", t.signal);
  assert.equal(f.counts().writes, 0); input.remember[0]!.content = "UNAPPROVED_MUTATION";
  const catalog = await applyDelegationMemory(prepared, t.signal);
  assert.equal(f.counts().writes, 2); assert.equal(catalog?.records[0]?.content, "EXACT_DECLARED_BODY"); assert.equal(catalog?.revision, 1);
});
test("changed storage, extra permission flags and workspace-overlapping storage reject without writes", async t => {
  const f = fixture(t), prepared = await prepareDelegationMemory({ directory: "/private", query: "Find notes." }, "/project", t.signal);
  f.change(); await assert.rejects(applyDelegationMemory(prepared, t.signal)); assert.equal(f.counts().writes, 0);
  await assert.rejects(prepareDelegationMemory({ directory: "/project/private", query: "Find notes." }, "/project", t.signal));
  await assert.rejects(prepareDelegationMemory({ directory: "/private", query: "Find notes.", approved: true } as never, "/project", t.signal));
  assert.equal(f.counts().writes, 0);
});
test("an unknown application is propagated, never recovered, repeated or represented as rollback", async t => {
  const f = fixture(t), prepared = await prepareDelegationMemory({ directory: "/private", query: "Find new note.", remember: [
    { kind: "decision", title: "New note", content: "Declared content.", provenance: "Reviewed fixture.", relatedIds: [] }] }, "/project", t.signal);
  let attempts = 0; t.mock.method(delegationMemoryIO, "mutate", async () => { attempts++; throw new ProjectMemoryError("storage", "unknown"); });
  await assert.rejects(applyDelegationMemory(prepared, t.signal), (error: unknown) => error instanceof ProjectMemoryError && error.application === "unknown");
  assert.equal(attempts, 1); assert.equal(f.counts().writes, 0);
});

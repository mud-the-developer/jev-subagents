import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { delegationMemoryOwner } from "../src/delegation-memory-owner.ts";
import { memoryProjectKey, memorySnapshot } from "../src/project-memory.ts";
import type { OrdinaryPublicResult } from "../src/ordinary-effects.ts";

const result = (started: boolean): OrdinaryPublicResult => ({ kind: "ordinary_scope", status: started ? "completed_unverified" : "stopped", taskAcceptance: "needs_human_review",
  reason: "Synthetic owned job only.", skillSuggestions: [], workersStarted: started ? 1 : 0, modelCalls: started ? 1 : 0, reservedModelCalls: 0,
  jevRequests: 1, reservedJevRequests: 0, jevReports: [], cleanupConfirmed: true, lockRetained: false, diagnostic: null, costEstimate: { observedUsd: 0, delegationTotalUsd: 0 }, reports: [] });
function fixture() {
  let session = "fixture", selections = 0, starts = 0;
  const controller = new AbortController(), owner = delegationMemoryOwner();
  const catalog = memorySnapshot({ version: 1, projectKey: memoryProjectKey("/project"), revision: 1,
    facts: [{ id: "fact_a", kind: "decision", title: "Public approved source", content: "APPROVED_FULL_BODY", provenance: "Synthetic exact reviewed source.", createdRevision: 1 }], edges: [] }, ["fact_a"]);
  const ctx = { cwd: "/project", hasUI: true, sessionManager: { getSessionId: () => session }, ui: { select: async (_title: string, rows: string[]) => { selections++; return rows[1]; } } } as unknown as ExtensionContext;
  const run = () => owner.start(ctx, async parent => {
    try { const ids = await parent({ jobId: "job", query: "Find approved source.", catalog }, controller.signal); if (ids === null) return result(false); starts++; return result(true); }
    catch { return result(false); }
  });
  return { owner, ctx, controller, run, changeSession: () => { session = "changed"; }, counts: () => ({ selections, starts }) };
}
test("weak memory pauses the same live job; the current parent selects without another user dialog", async () => {
  const f = fixture(), paused = await f.run(); assert.equal(paused.kind, "delegation_memory_choice");
  if (paused.kind !== "delegation_memory_choice") assert.fail();
  assert.equal(paused.catalog.records[0]?.content, "APPROVED_FULL_BODY"); assert.equal(paused.workersStarted, 0); assert.equal(f.counts().starts, 0);
  const done = await f.owner.choose({ jobId: paused.jobId, ids: ["fact_a"] }, f.ctx);
  assert.equal(done.workersStarted, 1); assert.deepEqual(f.counts(), { selections: 0, starts: 1 });
  await assert.rejects(f.owner.choose({ jobId: paused.jobId, ids: ["fact_a"] }, f.ctx), /No matching live/);
});
test("only explicit parent uncertainty opens one native user choice within the original approval", async () => {
  const f = fixture(); await f.run(); assert.equal(f.counts().selections, 0);
  const done = await f.owner.choose({ jobId: "job", askUser: true }, f.ctx);
  assert.equal(done.workersStarted, 1); assert.deepEqual(f.counts(), { selections: 1, starts: 1 });
});
test("a pending user picker consumes its handle before any concurrent replay can open another", async () => {
  const f = fixture(); await f.run(); let reply!: (value: string | undefined) => void, row = "", dialogs = 0;
  f.ctx.ui.select = async (_title, rows) => { dialogs++; row = rows[1]!; return await new Promise<string | undefined>(resolve => { reply = resolve; }); };
  const work = f.owner.choose({ jobId: "job", askUser: true }, f.ctx);
  await assert.rejects(f.owner.choose({ jobId: "job", askUser: true }, f.ctx), /No matching live/);
  assert.equal(dialogs, 1); assert.equal(f.counts().starts, 0); reply(row);
  assert.equal((await work).workersStarted, 1);
});
test("foreign or copied handles are not grants; an out-of-catalog selection consumes the original job without a worker", async () => {
  const f = fixture(); await f.run();
  const broken = { ...f.ctx, sessionManager: { getSessionId: () => { throw new Error("PRIVATE_CONTEXT_CAUSE"); } } } as unknown as ExtensionContext;
  await assert.rejects(f.owner.start(broken, async () => result(true)), error => error instanceof Error && error.message.includes("No matching live") && !error.message.includes("PRIVATE_CONTEXT_CAUSE"));
  const foreign = { ...f.ctx, sessionManager: { getSessionId: () => "foreign" } } as unknown as ExtensionContext;
  await assert.rejects(f.owner.choose({ jobId: "job", ids: ["fact_a"] }, foreign), /No matching live/);
  assert.equal(f.counts().starts, 0);
  await assert.rejects(f.owner.choose({ jobId: "job", ids: ["not_approved"] }, f.ctx), /No matching live/);
  assert.equal(f.counts().starts, 0);
  await assert.rejects(f.owner.choose({ jobId: "job", ids: [] }, f.ctx), /No matching live/);
});
test("lifecycle cancellation discards the pending selection and all approval continuation callbacks", async () => {
  const f = fixture(); await f.run(); assert.equal(getEventListeners(f.controller.signal, "abort").length, 1);
  f.controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  await assert.rejects(f.owner.choose({ jobId: "job", ids: ["fact_a"] }, f.ctx), /No matching live/); assert.equal(f.counts().starts, 0);
});
test("user refusal or session movement during the decision never dispatches a child", async () => {
  for (const mode of ["cancel", "move"] as const) {
    const f = fixture(); await f.run();
    f.ctx.ui.select = async () => { if (mode === "move") f.changeSession(); return undefined; };
    if (mode === "move") await assert.rejects(f.owner.choose({ jobId: "job", askUser: true }, f.ctx), /No matching live/);
    else assert.equal((await f.owner.choose({ jobId: "job", askUser: true }, f.ctx)).workersStarted, 0);
    assert.equal(f.counts().starts, 0);
  }
});
test("a user selector that ignores cancellation cannot keep an expired original memory job awaiting a reply", async () => {
  const f = fixture(); await f.run(); let reply!: (value: string | undefined) => void;
  f.ctx.ui.select = async () => await new Promise<string | undefined>(resolve => { reply = resolve; });
  const waiting = f.owner.choose({ jobId: "job", askUser: true }, f.ctx);
  f.controller.abort(); await assert.rejects(waiting, /No matching live/);
  assert.equal(f.counts().starts, 0); assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  reply("Forged late selection"); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.counts().starts, 0);
});
test("the current resume call's cancellation cancels the same original job, never a replacement", async () => {
  const f = fixture(); await f.run(); const caller = new AbortController(); let cancellations = 0;
  f.ctx.ui.select = async (_title, _rows, options) => await new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true }));
  const work = f.owner.choose({ jobId: "job", askUser: true }, f.ctx, caller.signal, () => { cancellations++; f.controller.abort(); });
  caller.abort(); await assert.rejects(work, /No matching live/); assert.equal(cancellations, 1); assert.equal(f.counts().starts, 0);
});

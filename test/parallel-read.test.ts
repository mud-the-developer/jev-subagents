import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { ApprovalPolicySchema, validParallelReadInput, validParallelReadPrepared, validReadOnlyRun, startParallelLedger, reserveParallelTask,
  observeParallelTask, parallelLedgerMetrics, parallelReadText } from "../src/parallel-read.ts";
import { parallelRead, parallelReadApproval } from "../src/parallel-read-effects.ts";
import { parallelFixture } from "./helpers/parallel-read-fixture.ts";
import { WORKER_ERROR } from "../src/delegate-machine.ts";
import { DirectoryValidationError } from "../src/directory-diagnostics.ts";
import { markOwnedReplyIncomplete } from "../src/windows-goal-process.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Hold only initial sibling checks; the first receipt's freshness check must still complete.
function holdSiblingAdmission(f: ReturnType<typeof parallelFixture>) {
  let checks = 0;
  f.io.context = async (_input, signal) => {
    if (++checks > 3 && checks <= 2 + f.input.tasks.length) {
      assert.ok(signal);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  };
}

test("read-only batch/policy schemas are closed, fixed-profile and bounded; config never supplies an approval", () => {
  const f = parallelFixture(); assert.equal(validParallelReadInput(f.input), true); assert.equal(validParallelReadPrepared(f.prepared), true);
  for (const invalid of [{ ...f.input, approved: true }, { ...f.input, after: [] }, { ...f.input, tasks: [...f.input.tasks, f.input.tasks[0]] },
    { ...f.input, tasks: [f.input.tasks[0], f.input.tasks[0]] }, { ...f.input, limits: { seconds: 60, modelCalls: 6 } },
    { ...f.input, limits: { seconds: 60, modelCalls: 5, perWorkerCalls: 2 } }]) assert.equal(validParallelReadInput(invalid), false);
  assert.equal(validParallelReadInput({ ...f.input, limits: { seconds: 60 } }), true);
  for (const level of ["trusted", "never", true]) assert.equal(Value.Check(ApprovalPolicySchema, { version: 1, approval: { level } }), false);
  assert.equal(Value.Check(ApprovalPolicySchema, { ...f.prepared.policy, approved: true }), false);
  assert.equal(Value.Check(ApprovalPolicySchema, { ...f.prepared.policy, approval: { level: "balanced", maxConcurrency: 1 } }), false);
  for (const parallel of [{}, null, ...[1, 2, 3, 4].map(maxConcurrency => ({ maxConcurrency }))]) {
    const policy = { ...f.prepared.policy, parallel };
    assert.equal(Value.Check(ApprovalPolicySchema, policy), false);
    assert.equal(validParallelReadPrepared({ ...f.prepared, policy }), false);
  }
  assert.equal(validParallelReadInput({ ...f.input, tasks: [] }), false);
  assert.equal(validParallelReadInput({ ...f.input, tasks: [...f.input.tasks, { ...f.input.tasks[0], id: "fourth" }] }), false);
  assert.equal(validParallelReadInput({ ...f.input, maxConcurrency: 1 }), false);
  for (const tool of ["edit", "write", "bash", "subagent"]) assert.equal(validReadOnlyRun({ ...f.prepared.tasks[0]!.run, agent: { ...f.prepared.tasks[0]!.run.agent, tools: [tool] } }), false);
  assert.equal(validReadOnlyRun({ ...f.prepared.tasks[0]!.run, verification: { command: "test", args: [] } }), false);
});
test("complete native review keeps original source but quotes terminal-control and bidi data safely", () => {
  const f = parallelFixture(); f.prepared.tasks[0]!.run.agent.systemPrompt = "Reviewed literal source \u001b]unsafe\u0007 \u202e data";
  const review = parallelReadApproval(f.prepared);
  assert.doesNotMatch(review.text, /[\u001b\u0007\u202e]/); assert.match(review.text, /unsafe/); assert.match(review.packet, /systemPrompt/);
});
test("owned transport invalidates a late bare worker accounting receipt rather than accepting completion after stop", () => {
  const f = parallelFixture(), reply = f.reply(); markOwnedReplyIncomplete(reply);
  assert.equal(reply.report.accounting.status, "reported"); if (reply.report.accounting.status === "reported") assert.equal(reply.report.accounting.complete, false);
});
test("parallel ledger reserves without forecasting and retains unknown usage instead of a known zero", () => {
  const f = parallelFixture(), before = startParallelLedger(f.prepared, 1000);
  const active = f.input.tasks.reduce((state, task) => reserveParallelTask(state, task.id, 1001), before);
  assert.equal(active.peak, 3); assert.equal(parallelLedgerMetrics(active).reservedModelCalls, 6);
  const known = observeParallelTask(active, "runtime", { outcome: "completed", started: true, modelCalls: 1, accountingComplete: true, cleanupConfirmed: true, observedUsd: 0.001 });
  const unknown = observeParallelTask(known, "storage", { outcome: "failed", started: true, modelCalls: null, accountingComplete: false, cleanupConfirmed: true, observedUsd: null });
  assert.equal(unknown.stopped, true); assert.equal(parallelLedgerMetrics(unknown).modelCalls, null); assert.equal(parallelLedgerMetrics(unknown).totalUsd, null);
  assert.equal(reserveParallelTask(unknown, "tests", 1002).stopped, true); assert.equal(before.rows.every(row => row.phase === "queued"), true);
  assert.equal(reserveParallelTask(before, "runtime", before.deadline).stopped, true);
});
for (const width of [1, 2, 3] as const) {
  test(`balanced approves once then actually starts ${width} catalog lanes before any task finishes, without JEV`, async t => {
    const f = parallelFixture(width); let active = 0, peak = 0, ready!: () => void;
    const http = t.mock.method(globalThis, "fetch", async () => assert.fail("No width, planner or selection request for a fixed catalog"));
    const ledger = startParallelLedger(f.prepared, 1000); assert.equal(ledger.maximum, width);
    const allStarted = new Promise<void>(resolve => { ready = resolve; }), release: (() => void)[] = [];
    const progress: { active: number; settled: number; maximum: number }[] = [];
    f.io.run = async input => await new Promise(resolve => {
      assert.equal(f.counts().confirmations, 1); active++; peak = Math.max(peak, active);
      release.push(() => { active--; resolve({ started: true, cleanupConfirmed: true, result: f.reply(input.run.task) }); });
      if (release.length === width) ready();
    });
    const work = parallelRead(f.input, f.ctx, t.signal, f.io, value => { progress.push(value); }); await allStarted;
    assert.equal(active, width); assert.equal(peak, width);
    assert.deepEqual(progress.at(-1), { active: width, settled: 0, maximum: width });
    assert.match(parallelReadText({ kind: "parallel_read_progress", ...progress.at(-1) }), new RegExp(`active ${width}/${width} catalog lanes`));
    release.toReversed().forEach(done => done());
    const result = await work; assert.equal(result.status, "completed_unverified"); assert.equal(result.approvals, 1); assert.equal(result.peakActiveTasks, width);
    assert.equal(result.modelCalls, width); assert.equal(result.reservedModelCalls, 0); assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(result.rows.map(row => row.id), ["runtime", "storage", "tests"].slice(0, width));
    assert.equal(f.packets.length, 1); for (const task of f.input.tasks) assert.ok(f.packets[0]!.includes(task.summary));
    assert.match(f.packets[0]!, new RegExp(`concurrent lanes ${width} from the exact task catalog`));
    assert.doesNotMatch(f.packets[0]!, /maxConcurrency/);
    assert.equal(progress.every(value => value.maximum === width && value.active <= width), true);
    assert.equal(http.mock.callCount(), 0);
  });
  test(`strict waits for ALL ${width} literal reviews then starts ${width} catalog lanes on one original deadline`, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
    const f = parallelFixture(width); f.prepared.policy.approval.level = "strict";
    const confirm = f.ctx.ui.confirm, opened = Array.from({ length: width }, () => deferred<void>());
    const answers = Array.from({ length: width }, () => deferred<boolean>()), allStarted = deferred<void>();
    const release: (() => void)[] = []; let active = 0;
    f.ctx.ui.confirm = async (...args) => {
      const index = f.counts().confirmations; await confirm(...args);
      assert.equal(active, 0); opened[index]!.resolve(); return await answers[index]!.promise;
    };
    f.io.run = async input => await new Promise(resolve => {
      assert.equal(f.counts().confirmations, width);
      assert.equal(input.approvedAt, 1000000 + width * 86400000); assert.equal(input.deadline, input.approvedAt + 60000);
      active++; release.push(() => { active--; resolve({ started: true, cleanupConfirmed: true, result: f.reply() }); });
      if (active === width) allStarted.resolve();
    });
    const work = parallelRead(f.input, f.ctx, t.signal, f.io);
    for (let index = 0; index < width; index++) {
      await opened[index]!.promise; t.mock.timers.tick(86400000);
      assert.equal(active, 0); assert.equal(release.length, 0); answers[index]!.resolve(true);
    }
    await allStarted.promise; assert.equal(active, width); release.forEach(done => done());
    const result = await work; assert.equal(result.status, "completed_unverified"); assert.equal(result.approvals, width); assert.equal(result.peakActiveTasks, width);
    assert.equal(result.cleanupConfirmed, true); assert.equal(result.modelCalls, width);
    for (const [index, packet] of f.packets.entries()) {
      assert.ok(packet.includes(`Current task review: ${f.input.tasks[index]!.id}`));
      for (const task of f.input.tasks) assert.ok(packet.includes(task.summary));
    }
  });
}
test("missing UI, declined/nonliteral review and changed policy perform zero child execution", async t => {
  for (const mode of ["no_ui", "declined", "nonliteral", "policy", "session"] as const) {
    const f = parallelFixture(), confirm = f.ctx.ui.confirm;
    if (mode === "no_ui") f.ctx.hasUI = false;
    else f.ctx.ui.confirm = async (...args) => {
      await confirm(...args); if (mode === "policy") f.prepared.policyVersion = "b".repeat(64); if (mode === "session") f.move();
      return mode === "declined" ? false : mode === "nonliteral" ? "true" as unknown as boolean : true;
    };
    const result = await parallelRead(f.input, f.ctx, t.signal, f.io); assert.equal(result.status, "stopped"); assert.equal(f.counts().starts, 0);
    if (mode === "no_ui") assert.equal(f.counts().preparations, 0);
  }
});
test("a removed policy field or changed prepared task catalog stops before review or child admission", async t => {
  for (const prepared of [
    (() => { const f = parallelFixture(); return { ...f.prepared, policy: { ...f.prepared.policy, parallel: { maxConcurrency: 1 } } }; })(),
    (() => { const f = parallelFixture(); return { ...f.prepared, tasks: f.prepared.tasks.slice(0, 2) }; })(),
    (() => { const f = parallelFixture(); return { ...f.prepared, tasks: f.prepared.tasks.toReversed() }; })(),
  ]) {
    const f = parallelFixture(); f.io.prepare = async () => prepared;
    const result = await parallelRead(f.input, f.ctx, t.signal, f.io);
    assert.equal(result.status, "stopped"); assert.equal(f.counts().confirmations, 0); assert.equal(f.counts().starts, 0);
  }
});
test("unknown native preparation cleanup is never projected as clean just because no SDK child started", async t => {
  const f = parallelFixture(); f.io.prepare = async () => { throw new DirectoryValidationError("PRIVATE_HELPER_CAUSE", "unknown", false); };
  const result = await parallelRead(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "stopped"); assert.equal(result.cleanupConfirmed, false); assert.equal(result.attemptedTasks, 0);
  assert.equal(f.counts().confirmations, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HELPER_CAUSE/);
});
test("any strict review refusal or nonliteral reply never executes earlier accepted tasks", async t => {
  for (const refused of [1, 2, 3]) for (const answer of [false, "true"]) {
    const f = parallelFixture(); f.prepared.policy.approval.level = "strict"; const confirm = f.ctx.ui.confirm;
    f.ctx.ui.confirm = async (...args) => { await confirm(...args); return f.counts().confirmations === refused ? answer as boolean : true; };
    const result = await parallelRead(f.input, f.ctx, t.signal, f.io);
    assert.equal(result.status, "stopped"); assert.equal(result.approvals, refused - 1); assert.equal(f.counts().confirmations, refused); assert.equal(f.counts().starts, 0);
  }
});
test("a missing worker receipt preserves unknown row call counts and blocks pending sibling admission", async t => {
  const f = parallelFixture(); holdSiblingAdmission(f);
  f.io.run = async () => ({ started: true, cleanupConfirmed: false, result: null });
  const result = await parallelRead(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "stopped"); assert.equal(result.modelCalls, null); assert.equal(result.rows[0]!.modelCalls, null); assert.equal(result.rows[0]!.accounting, "unknown");
  assert.equal(result.cleanupConfirmed, false); assert.equal(result.costEstimate.delegationTotalUsd, null);
  assert.equal(result.attemptedTasks, 1); assert.equal(result.rows.filter(row => row.status === "not_started").length, 2);
  assert.equal(result.rows[0]!.maxModelCalls, 2); assert.deepEqual(result.rows[0]!.model, f.prepared.tasks[0]!.run.model);
});
test("unknown usage stops pending admission and keeps its reservation/cost unknown without model or provider retries", async t => {
  const f = parallelFixture(); holdSiblingAdmission(f); let attempts = 0;
  f.io.run = async () => { attempts++; return { started: true, cleanupConfirmed: true,
    result: { type: "failed", error: WORKER_ERROR, report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "unknown" } } } }; };
  const result = await parallelRead(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "stopped"); assert.equal(attempts, 1); assert.equal(result.attemptedTasks, 1); assert.equal(result.reservedModelCalls, 2);
  assert.equal(result.costEstimate.delegationTotalUsd, null); assert.equal(result.rows.filter(row => row.status === "not_started").length, 2);
});
test("a scope change after worker completion stops new admission but preserves its actual usage/cost receipt", async t => {
  const f = parallelFixture(); holdSiblingAdmission(f); let attempts = 0;
  f.io.run = async () => { attempts++; f.move(); return { started: true, cleanupConfirmed: true, result: f.reply() }; };
  const result = await parallelRead(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "stopped"); assert.equal(attempts, 1); assert.equal(result.modelCalls, 1); assert.equal(result.reservedModelCalls, 0);
  assert.equal(result.costEstimate.observedUsd, 0.001); assert.equal(result.costEstimate.delegationTotalUsd, 0.001); assert.equal(result.cleanupConfirmed, true);
});
test("first failure cancels siblings and drains their late receipts before returning", async t => {
  const f = parallelFixture(); let attempts = 0, finishFirst!: () => void, started!: () => void, released = 0;
  const all = new Promise<void>(resolve => { started = resolve; });
  f.io.run = async (_input, signal) => await new Promise(resolve => {
    const index = attempts++;
    if (index === 0) finishFirst = () => resolve({ started: true, cleanupConfirmed: true, result: { type: "failed", error: WORKER_ERROR,
      report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "unknown" } } } });
    else signal.addEventListener("abort", () => { setImmediate(() => { released++; resolve({ started: true, cleanupConfirmed: true,
      result: { type: "cancel", report: { startupMs: 1, executionMs: null, modelCalls: 0, accounting: { status: "not_started" } } } }); }); }, { once: true });
    if (attempts === 3) started();
  });
  const work = parallelRead(f.input, f.ctx, t.signal, f.io); await all; finishFirst(); const result = await work;
  assert.equal(result.status, "stopped"); assert.equal(attempts, 3); assert.equal(released, 2); assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.costEstimate.delegationTotalUsd, null);
});
test("the original shared budget starts at final literal approval and expires even during post-review freshness", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
  const f = parallelFixture(); f.input.limits.seconds = 1; f.prepared.input.limits.seconds = 1; for (const task of f.prepared.tasks) task.run.seconds = 1;
  let checks = 0, entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  f.io.context = async (_input, signal) => { checks++; if (checks > 1) { entered(); await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true })); } };
  const work = parallelRead(f.input, f.ctx, t.signal, f.io); await pending; t.mock.timers.tick(1001);
  const result = await work; assert.equal(result.status, "stopped"); assert.equal(result.approvals, 1); assert.equal(result.attemptedTasks, 0);
});

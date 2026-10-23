import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { ordinaryRetainOwner } from "../src/ordinary-protocol.ts";
import { test } from "node:test";
import { ordinaryScopeDigest, reduceOrdinaryAuthorization as reduce, validOrdinaryPreparedScope, validOrdinaryScopeInput,
  type OrdinaryAuthorizationEvent, type OrdinaryAuthorizationState, type OrdinaryAuthorizationStep,
  type OrdinaryObservation, type OrdinaryPreparedScope, type OrdinaryScopeInput } from "../src/ordinary-authorization.ts";

const spec: OrdinaryScopeInput = { task: "Fix only the approved source file and preserve existing restrictions.", agents: ["worker", "strong"],
  files: [{ path: "src/example.ts", access: "read_write" }],
  tasks: [{ id: "first", summary: "Fix the approved typo.", agent: "worker" }, { id: "second", summary: "Review the approved change." }],
  selection: "parent_or_jev", limits: { workerRuns: 2, modelCalls: 12, perWorkerCalls: 6, seconds: 120 } };
const model = { provider: "offline", id: "offline-worker" };
const prepared: OrdinaryPreparedScope = { id: "job-1", sessionId: "session-1", input: spec, approvalDeadline: null, contextDigest: "c".repeat(64),
  routingTarget: "Anonymous loopback JEV fixture; approved task/candidate prose only.", fileProtocol: "scoped_existing_files",
  workerTargets: ["worker", "strong"].map(agent => ({ agent, api: "openai-completions", endpoint: "http://127.0.0.1:8000/v1" })),
  agents: ["worker", "strong"].map(name => ({ name, description: "Bounded file work.", systemPrompt: "Use only the approved file IDs and tools.",
    tools: ["read", "edit"], model, file: `/private/agents/${name}.md` })),
  files: { id: "scope-1", root: "/workspace", rootIdentity: { dev: 1, ino: 2 }, files: [{ id: "file-1", path: "src/example.ts", access: "read_write",
    version: { identity: { dev: 1, ino: 3 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 10 } }] } };
function frozen<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const part of Object.values(value)) frozen(part); } return value; }
function step(state: OrdinaryAuthorizationState, event: OrdinaryAuthorizationEvent) {
  const before = structuredClone(state), beforeEvent = structuredClone(event), next = reduce(frozen(state), frozen(event));
  assert.deepEqual(state, before); assert.deepEqual(event, beforeEvent); assert.deepEqual(next, reduce(state, event));
  return next;
}
function grant(value = prepared): OrdinaryAuthorizationStep {
  let next = step({ phase: "idle" }, { type: "start", input: value.input, sessionId: value.sessionId, now: 1000 });
  assert.equal(next.state.phase, "preparing"); assert.equal(next.effects[0]?.type, "prepare");
  next = step(next.state, { type: "prepared", grant: value, now: 1001 });
  assert.equal(next.state.phase, "awaiting_approval"); assert.equal(next.effects[0]?.type, "confirm_scope");
  return next;
}
function approved(value = prepared) {
  const next = grant(value);
  return step(next.state, { type: "approval", id: value.id, digest: ordinaryScopeDigest(value), approved: true, now: 1002 });
}
function running(value = prepared) {
  const choice = step(approved(value).state, { type: "selected", id: value.id, taskId: value.input.tasks[0]!.id,
    selection: { agent: "worker", source: "parent" }, now: 1003 });
  assert.equal(choice.state.phase, "checking"); assert.equal(choice.effects[0]?.type, "check_current");
  return step(choice.state, { type: "fresh", id: value.id, taskId: value.input.tasks[0]!.id, sessionId: value.sessionId,
    digest: ordinaryScopeDigest(value), current: true, now: 1004 });
}
function observation(files = prepared.files, modelCalls: number | null = 2): OrdinaryObservation {
  return { outcome: "completed", modelCalls, accountingComplete: true, cleanupConfirmed: true, files: structuredClone(files) };
}

test("scope syntax is bounded, English and closed; it is not authority or automatic execution", async t => {
  assert.equal(validOrdinaryScopeInput(spec), true); assert.equal(validOrdinaryPreparedScope(prepared), true);
  assert.equal(validOrdinaryScopeInput({ ...spec, limits: { ...spec.limits, perWorkerCalls: 12 } }), true);
  for (const invalid of [
    { ...spec, task: "비공개 작업을 그대로 수행" }, { ...spec, tasks: [{ id: "a", summary: "한국어 작업" }] },
    { ...spec, tasks: [spec.tasks[0], spec.tasks[0]] }, { ...spec, tasks: [{ ...spec.tasks[0], agent: "outside" }] },
    { ...spec, files: [spec.files[0], spec.files[0]] }, { ...spec, files: [{ path: "../secret", access: "read" }] },
    { ...spec, files: [{ path: ".env", access: "read" }] }, { ...spec, files: [{ path: "auth.json", access: "read" }] },
    { ...spec, limits: { ...spec.limits, workerRuns: 1 } }, { ...spec, limits: { ...spec.limits, modelCalls: 0 } },
    { ...spec, limits: { ...spec.limits, perWorkerCalls: Number.POSITIVE_INFINITY } }, { ...spec, limits: { ...spec.limits, seconds: 86_401 } },
    { ...spec, approval: true }, { ...spec, restoreGrant: prepared }, { ...spec, bash: "PRIVATE_COMMAND" },
  ]) await t.test("invalid scope", () => {
    assert.equal(validOrdinaryScopeInput(invalid), false);
    const next = step({ phase: "idle" }, { type: "start", input: invalid, sessionId: "session-1", now: 1000 });
    assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, []);
  });
});

test("an approved longer scope keeps one shared deadline without extending an existing short grant", () => {
  const longer = structuredClone(prepared); longer.input.limits.seconds = 600;
  assert.equal(validOrdinaryScopeInput({ ...spec, limits: { ...spec.limits, seconds: 3600 } }), true);
  assert.equal(validOrdinaryScopeInput({ ...spec, limits: { ...spec.limits, seconds: 86_400 } }), true);
  assert.equal(validOrdinaryScopeInput({ ...spec, limits: { ...spec.limits, seconds: 86_401 } }), false);
  const active = running(longer).state; assert.equal(active.phase, "running");
  if (active.phase === "running") assert.equal(active.expiresAt, 601002);
  const progress = step(active, { type: "observed", id: longer.id, taskId: "first", observation: observation(longer.files), now: 121003 });
  assert.equal(progress.state.phase, "selecting");
  if (progress.state.phase === "selecting") assert.equal(progress.state.expiresAt, 601002);
  const expired = step(active, { type: "observed", id: longer.id, taskId: "first", observation: observation(longer.files), now: 601002 });
  assert.equal(expired.state.phase, "revoked");
  if (expired.state.phase === "revoked") assert.equal(expired.state.reason, "expired");
  const old = running(prepared).state;
  if (old.phase === "running") assert.equal(old.expiresAt, 121002);
  assert.deepEqual(step(old, { type: "start", input: longer.input, sessionId: longer.sessionId, now: 1005 }).state, old);
  const day = structuredClone(prepared); day.input.limits.seconds = 86_400;
  const dayActive = running(day).state;
  assert.equal(dayActive.phase, "running");
  if (dayActive.phase === "running") {
    assert.equal(dayActive.expiresAt, 86_401_002);
    assert.equal(step(dayActive, { type: "stop", reason: "cancelled", now: dayActive.expiresAt - 1 }).state.phase, "revoked");
    const expired = step(dayActive, { type: "stop", reason: "cancelled", now: dayActive.expiresAt }).state;
    assert.equal(expired.phase, "revoked");
    if (expired.phase === "revoked") assert.equal(expired.reason, "expired");
  }
});

test("cancelled stops become expired only at an active approved deadline; explicit causes and terminals stay fixed", () => {
  const selecting = approved().state;
  const checking = step(selecting, { type: "selected", id: prepared.id, taskId: "first", selection: { agent: "worker", source: "parent" }, now: 1003 }).state;
  for (const state of [selecting, checking, running().state]) {
    assert.ok("expiresAt" in state);
    for (const offset of [-1, 0, 1]) for (const reason of ["cancelled", "changed", "failed"] as const) {
      const stopped = step(state, { type: "stop", reason, now: state.expiresAt + offset });
      assert.equal(stopped.state.phase, "revoked"); if (stopped.state.phase !== "revoked") assert.fail();
      assert.equal(stopped.state.reason, reason === "cancelled" && offset >= 0 ? "expired" : reason);
      assert.equal(stopped.state.cleanupPending, state.phase === "running");
      assert.deepEqual(stopped.effects, state.phase === "running" ? [{ type: "abort_worker" }] : []);
      assert.equal(step(stopped.state, { type: "stop", reason: "cancelled", now: state.expiresAt + 2 }).state, stopped.state);
    }
  }
  const preparing = step({ phase: "idle" }, { type: "start", input: spec, sessionId: prepared.sessionId, now: 1000 }).state;
  for (const state of [preparing, grant().state]) {
    const stopped = step(state, { type: "stop", reason: "cancelled", now: 86_401_000 });
    assert.equal(stopped.state.phase, "revoked"); if (stopped.state.phase !== "revoked") assert.fail();
    assert.equal(stopped.state.reason, "cancelled"); assert.equal(stopped.state.cleanupPending, false); assert.deepEqual(stopped.effects, []);
  }
});

test("deadline cancellation keeps finite/native pending obligations and settles late usage exactly once", () => {
  const routing = { tasks: [], pending: [], reports: [], blocked: false };
  for (const native of [false, true]) for (const cleanupConfirmed of [false, true]) for (const accountingComplete of [false, true]) {
    const value = structuredClone(prepared);
    if (native) { value.input.limits.modelCalls = null; value.input.limits.perWorkerCalls = null; }
    const active = running(value).state; assert.equal(active.phase, "running"); if (active.phase !== "running") assert.fail();
    const stopped = step(active, { type: "stop", reason: "cancelled", now: active.expiresAt }).state;
    assert.equal(stopped.phase, "revoked"); if (stopped.phase !== "revoked") assert.fail();
    assert.equal(stopped.reason, "expired"); assert.equal(stopped.reservedCalls, native ? null : 6);
    assert.equal(stopped.pending?.observed, false); assert.equal(stopped.cleanupPending, true);
    assert.equal(ordinaryRetainOwner(stopped, routing, true), true);
    const calls = native ? 13 : 2;
    const event: OrdinaryAuthorizationEvent = { type: "observed", id: value.id, taskId: "first", now: active.expiresAt + 1,
      observation: { ...observation(value.files, calls), outcome: "cancelled", cleanupConfirmed, accountingComplete } };
    const late = step(stopped, event);
    assert.equal(late.state.phase, "revoked"); if (late.state.phase !== "revoked") assert.fail();
    assert.equal(late.state.reason, "expired"); assert.equal(late.state.spentCalls, calls);
    assert.equal(late.state.reservedCalls, cleanupConfirmed && accountingComplete ? 0 : native ? null : 6 - calls);
    assert.equal(late.state.cleanupPending, !cleanupConfirmed); assert.equal(late.state.pending?.observed, true);
    assert.equal(late.state.history.length, 1); assert.deepEqual(late.effects, []);
    assert.equal(ordinaryRetainOwner(late.state, routing, true), !cleanupConfirmed || !accountingComplete);
    assert.equal(step(late.state, event).state, late.state);
    const cleaned = step(late.state, { type: "cleanup", id: value.id, confirmed: true }).state;
    assert.equal(cleaned.phase, "revoked"); if (cleaned.phase !== "revoked") assert.fail();
    assert.equal(cleaned.cleanupPending, false); assert.equal(cleaned.reservedCalls, late.state.reservedCalls);
    assert.equal(ordinaryRetainOwner(cleaned, routing, true), !cleanupConfirmed || !accountingComplete);
    assert.equal(step(cleaned, { type: "approval", id: value.id, digest: ordinaryScopeDigest(value), approved: true, now: active.expiresAt + 2 }).state, cleaned);
  }
});

test("SDK-native scope needs the same exact approval and keeps actual counts beyond twelve across sequential workers", () => {
  const value = structuredClone(prepared); value.input.limits = { workerRuns: 2, seconds: 120 };
  let next = running(value); assert.equal(next.state.phase, "running");
  assert.equal(next.effects[0]?.type, "run_worker");
  if (next.effects[0]?.type === "run_worker") assert.equal(next.effects[0].maxModelCalls, null);
  if (next.state.phase === "running") assert.equal(next.state.reservedCalls, null);
  next = step(next.state, { type: "observed", id: value.id, taskId: "first", observation: observation(value.files, 14), now: 1005 });
  assert.equal(next.state.phase, "selecting");
  next = step(next.state, { type: "selected", id: value.id, taskId: "second", selection: { agent: "strong", source: "parent" }, now: 1006 });
  next = step(next.state, { type: "fresh", id: value.id, taskId: "second", sessionId: value.sessionId, digest: ordinaryScopeDigest(value), current: true, now: 1007 });
  next = step(next.state, { type: "observed", id: value.id, taskId: "second", observation: observation(value.files, 15), now: 1008 });
  assert.equal(next.state.phase, "finished");
  if (next.state.phase === "finished") { assert.equal(next.state.spentCalls, 29); assert.equal(next.state.reservedCalls, 0); assert.equal(next.state.expiresAt, 121002); }
});

test("SDK-native uncertainty and cancellation retain unbounded obligations until a complete late receipt", () => {
  const value = structuredClone(prepared); value.input.limits.modelCalls = null; value.input.limits.perWorkerCalls = null;
  const active = running(value).state;
  const unknown = step(active, { type: "observed", id: value.id, taskId: "first", observation: { ...observation(value.files, 13), accountingComplete: false }, now: 1005 }).state;
  assert.equal(unknown.phase, "revoked");
  if (unknown.phase === "revoked") { assert.equal(unknown.reservedCalls, null); assert.equal(ordinaryRetainOwner(unknown, { tasks: [], pending: [], reports: [], blocked: false }, true), true); }
  const cancelled = step(active, { type: "stop", reason: "cancelled", now: 1005 }).state;
  const late = step(cancelled, { type: "observed", id: value.id, taskId: "first", observation: observation(value.files, 13), now: 1006 });
  assert.equal(late.state.phase, "revoked"); assert.deepEqual(late.effects, []);
  if (late.state.phase === "revoked") { assert.equal(late.state.spentCalls, 13); assert.equal(late.state.reservedCalls, 0); }
  assert.equal(step(late.state, { type: "start", input: value.input, sessionId: value.sessionId, now: 1007 }).state, late.state);
});

test("preparation requires exact candidate/file binding, fixed models and scoped tools; no shell/profile-pool expansion", () => {
  for (const alter of [
    (x: OrdinaryPreparedScope) => { x.agents[0]!.tools = ["bash"]; },
    (x: OrdinaryPreparedScope) => { x.agents[0]!.tools = ["find"]; },
    (x: OrdinaryPreparedScope) => { x.agents[0]!.name = "outside"; },
    (x: OrdinaryPreparedScope) => { x.agents[0]!.systemPrompt = "한국어 지시"; },
    (x: OrdinaryPreparedScope) => { x.files.files[0]!.access = "read"; },
    (x: OrdinaryPreparedScope) => { x.routingTarget = null; },
    (x: OrdinaryPreparedScope) => { Object.assign(x.agents[0]!, { pool: { models: [model], thinking: ["low"] } }); },
  ]) {
    const value = structuredClone(prepared); alter(value); assert.equal(validOrdinaryPreparedScope(value), false);
  }
  const state = step({ phase: "idle" }, { type: "start", input: spec, sessionId: "session-1", now: 1000 }).state;
  for (const value of [{ ...prepared, sessionId: "other" }, { ...prepared, approvalDeadline: 1001 }, { ...prepared, approvalDeadline: 61002 }])
    assert.equal(step(state, { type: "prepared", grant: value as OrdinaryPreparedScope, now: 1001 }).state.phase, "revoked");
});

test("one exact scope approval precedes every selection; denial, stale or foreign receipts cannot admit a worker", () => {
  const current = grant().state;
  const foreign = step(current, { type: "approval", id: "other", digest: ordinaryScopeDigest(prepared), approved: true, now: 1002 });
  assert.equal(foreign.state, current); assert.deepEqual(foreign.effects, []);
  const wrong = step(current, { type: "approval", id: prepared.id, digest: "a".repeat(64), approved: true, now: 1002 });
  assert.equal(wrong.state, current);
  for (const [approved, now] of [[false, 1002], [true, 999]] as const) {
    const next = step(current, { type: "approval", id: prepared.id, digest: ordinaryScopeDigest(prepared), approved, now });
    assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, []);
  }
  for (const phase of [{ phase: "idle" } as const, current])
    assert.deepEqual(step(phase, { type: "selected", id: prepared.id, taskId: "first", selection: { agent: "worker", source: "parent" }, now: 1002 }).effects, []);
});

test("human waiting has no expiry and the execution deadline starts only after positive approval", () => {
  const current = grant().state, now = 86_401_000;
  const next = step(current, { type: "approval", id: prepared.id, digest: ordinaryScopeDigest(prepared), approved: true, now });
  assert.equal(next.state.phase, "selecting"); if (next.state.phase !== "selecting") assert.fail();
  assert.equal(next.state.expiresAt, now + spec.limits.seconds * 1000);
  assert.equal(next.state.startedWorkers, 0); assert.equal(next.state.reservedCalls, 0);
  const expired = step(next.state, { type: "selected", id: prepared.id, taskId: "first", selection: { agent: "worker", source: "parent" }, now: next.state.expiresAt });
  assert.equal(expired.state.phase, "revoked"); assert.deepEqual(expired.effects, []);
});

test("parent and JEV choose only reviewed candidates; JEV advice never grants missing permission", () => {
  for (const selection of [{ agent: "outside", source: "parent" }, { agent: "strong", source: "parent" }, { agent: "worker", source: "jev" }]) {
    const next = step(approved().state, { type: "selected", id: prepared.id, taskId: "first", selection: selection as { agent: string; source: "parent" | "jev" }, now: 1003 });
    assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, []);
  }
  const value = structuredClone(prepared); value.input.tasks.forEach(task => { task.agent = "worker"; }); value.input.selection = "parent_only";
  const denied = step(approved(value).state, { type: "selected", id: value.id, taskId: "first", selection: { agent: "strong", source: "jev" }, now: 1003 });
  assert.equal(denied.state.phase, "revoked");
});

test("two sequential workers share one approval, one deadline and SDK budget; updated writable versions do not expand files", () => {
  let next = running(); assert.equal(next.state.phase, "running");
  assert.equal(next.effects[0]?.type, "run_worker");
  const writable = structuredClone(prepared.files); writable.files[0]!.version.digest = "d".repeat(64);
  next = step(next.state, { type: "observed", id: prepared.id, taskId: "first", observation: observation(writable, 2), now: 1005 });
  assert.equal(next.state.phase, "selecting"); assert.equal(next.effects[0]?.type, "select_worker");
  const deadline = "expiresAt" in next.state ? next.state.expiresAt : 0;
  next = step(next.state, { type: "selected", id: prepared.id, taskId: "second", selection: { agent: "strong", source: "jev" }, now: 1006 });
  next = step(next.state, { type: "fresh", id: prepared.id, taskId: "second", sessionId: "session-1", digest: ordinaryScopeDigest(prepared), current: true, now: 1007 });
  assert.equal(next.effects[0]?.type, "run_worker");
  if (next.effects[0]?.type !== "run_worker") assert.fail("Worker admission missing");
  assert.equal(next.effects[0].deadline, deadline); assert.equal(next.effects[0].agent.name, "strong"); assert.deepEqual(next.effects[0].files, writable);
  next = step(next.state, { type: "observed", id: prepared.id, taskId: "second", observation: observation(writable, 3), now: 1008 });
  assert.equal(next.state.phase, "finished"); assert.deepEqual(next.effects, []);
  if (next.state.phase !== "finished") assert.fail("Completion missing");
  assert.equal(next.state.startedWorkers, 2); assert.equal(next.state.spentCalls, 5); assert.equal(next.state.reservedCalls, 0); assert.equal(next.state.history.length, 2);
  for (const event of [{ type: "stop", reason: "cancelled", now: 1009 },
    { type: "approval", id: prepared.id, digest: ordinaryScopeDigest(prepared), approved: true, now: 1009 }] as const) assert.equal(step(next.state, event).state, next.state);
});

test("SDK exhaustion stops rather than allocating a reset budget or another approval/worker", () => {
  const value = structuredClone(prepared); value.input.limits.modelCalls = 2;
  const active = running(value);
  assert.equal(active.state.phase, "running"); if (active.state.phase !== "running") assert.fail("Admission missing");
  assert.equal(active.state.reservedCalls, 2);
  const next = step(active.state, { type: "observed", id: value.id, taskId: "first", observation: observation(value.files, 2), now: 1005 });
  assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, []);
  if (next.state.phase !== "revoked") assert.fail("Revocation missing");
  assert.equal(next.state.reason, "budget"); assert.equal(next.state.cleanupPending, false); assert.equal(next.state.spentCalls, 2);
});

test("changed session/profile/context/file scope and expired admission revoke without starting work", () => {
  const checking = step(approved().state, { type: "selected", id: prepared.id, taskId: "first", selection: { agent: "worker", source: "parent" }, now: 1003 }).state;
  for (const extra of [{ current: false }, { sessionId: "other" }, { digest: "d".repeat(64) }, { now: 121002 }, { now: NaN }, { now: 1002 }]) {
    const next = step(checking, { type: "fresh", id: prepared.id, taskId: "first", sessionId: "session-1", digest: ordinaryScopeDigest(prepared), current: true, now: 1004, ...extra });
    assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, []);
  }
  for (const change of [
    (x: OrdinaryPreparedScope["files"]) => { x.root = "/outside"; },
    (x: OrdinaryPreparedScope["files"]) => { x.files[0]!.path = "other.ts"; },
    (x: OrdinaryPreparedScope["files"]) => { x.files[0]!.version.identity.ino = 77; },
    (x: OrdinaryPreparedScope["files"]) => { x.files.push({ ...x.files[0]!, id: "new-file", path: "new.ts" }); },
  ]) {
    const files = structuredClone(prepared.files); change(files);
    const next = step(running().state, { type: "observed", id: prepared.id, taskId: "first", observation: observation(files), now: 1005 });
    assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, []);
  }
  const readonly = structuredClone(prepared); readonly.input.files[0]!.access = "read"; readonly.files.files[0]!.access = "read";
  const altered = structuredClone(readonly.files); altered.files[0]!.version.digest = "d".repeat(64);
  assert.equal(step(running(readonly).state, { type: "observed", id: readonly.id, taskId: "first", observation: observation(altered), now: 1005 }).state.phase, "revoked");
});

test("failure, cancellation, missing accounting or unknown cleanup stop the job and preserve reservations", () => {
  for (const extra of [{ outcome: "failed" }, { outcome: "cancelled" }, { modelCalls: null }, { accountingComplete: false }, { cleanupConfirmed: false }]) {
    const observed = { ...observation(), ...extra } as OrdinaryObservation;
    const next = step(running().state, { type: "observed", id: prepared.id, taskId: "first", observation: observed, now: 1005 });
    assert.equal(next.state.phase, "revoked"); if (next.state.phase !== "revoked") assert.fail("Revocation missing");
    assert.equal(next.state.spentCalls, observed.modelCalls ?? 0); assert.equal(next.state.history.length, 1);
    assert.equal(next.state.cleanupPending, !observed.cleanupConfirmed);
    assert.equal(next.effects.some(effect => effect.type === "select_worker" || effect.type === "run_worker" || effect.type === "confirm_scope"), false);
    if (observed.modelCalls === null) assert.equal(next.state.reservedCalls, 6);
  }
});

test("lifecycle cancellation revokes once, keeps late observed usage exactly once and cannot restore permission", () => {
  for (const reason of ["cancelled", "changed", "failed"] as const) {
    let next = step(running().state, { type: "stop", reason, now: 1005 });
    assert.equal(next.state.phase, "revoked"); assert.deepEqual(next.effects, [{ type: "abort_worker" }]);
    const event = { type: "observed" as const, id: prepared.id, taskId: "first", observation: { ...observation(), outcome: "cancelled" as const, accountingComplete: false }, now: 1006 };
    next = step(next.state, event);
    assert.equal(next.state.phase, "revoked"); if (next.state.phase !== "revoked") assert.fail("Revocation missing");
    assert.equal(next.state.spentCalls, 2); assert.equal(next.state.reservedCalls, 4); assert.equal(next.state.cleanupPending, false);
    assert.equal(next.state.history.length, 1); assert.deepEqual(next.effects, []);
    assert.equal(step(next.state, event).state, next.state);
    assert.equal(step(next.state, { type: "approval", id: prepared.id, digest: ordinaryScopeDigest(prepared), approved: true, now: 1007 }).state, next.state);
  }
});

test("late deadline observations remain usage evidence, never revive a next task", () => {
  for (const now of [121002, NaN, 1]) {
    const next = step(running().state, { type: "observed", id: prepared.id, taskId: "first", observation: observation(), now });
    assert.equal(next.state.phase, "revoked"); if (next.state.phase !== "revoked") assert.fail("Revocation missing");
    assert.equal(next.state.spentCalls, 2); assert.equal(next.state.history.length, 1); assert.equal(next.state.cleanupPending, false); assert.deepEqual(next.effects, []);
  }
});

test("foreign worker/cleanup receipts and replayed approvals do not spend or certify another job", () => {
  const active = running().state;
  for (const extra of [{ id: "foreign" }, { taskId: "foreign" }]) {
    const event = { type: "observed" as const, id: prepared.id, taskId: "first", observation: observation(), now: NaN, ...extra };
    assert.equal(step(active, event).state, active);
  }
  const stopped = step(active, { type: "stop", reason: "cancelled", now: 1005 }).state;
  assert.equal(step(stopped, { type: "cleanup", id: "foreign", confirmed: true }).state, stopped);
  const clean = step(stopped, { type: "cleanup", id: prepared.id, confirmed: true }).state;
  assert.equal(clean.phase, "revoked"); if (clean.phase !== "revoked") assert.fail("Revocation missing"); assert.equal(clean.cleanupPending, false);
});

test("policy kernel never reads profiles, creates grants from memory, launches processes or transmits", t => {
  const http = t.mock.method(globalThis, "fetch", async () => { throw new Error("No policy HTTP."); });
  const fork = t.mock.method(childProcess, "fork", () => { throw new Error("No policy process."); });
  grant(); running(); approved();
  assert.equal(http.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0);
});

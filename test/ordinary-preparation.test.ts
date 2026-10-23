import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalOrdinaryDirectories, goalDirectoryIO } from "../src/goal-run-effects.ts";
import { ordinaryDelegate, ordinaryIO, prepareOrdinaryScope } from "../src/ordinary-effects.ts";
import { OrdinaryPreparationError, ORDINARY_PREPARATION_STAGES, ordinaryPreparationStage } from "../src/ordinary-diagnostics.ts";
import type { OrdinaryScopeInput } from "../src/ordinary-authorization.ts";
import { DirectoryValidationError, DirectoryPreparationError } from "../src/directory-diagnostics.ts";

const paths = ["/synthetic/work", "/synthetic/config"] as const;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test("ordinary directory preparation overlaps both fresh readonly checks with the real signal and no journal", async t => {
  const reads = paths.map(() => deferred<string>()), signal = new AbortController().signal;
  const canonical = t.mock.method(goalDirectoryIO, "canonical", (value: string) => reads[paths.indexOf(value as typeof paths[number])]!.promise);
  let finished = false;
  const work = canonicalOrdinaryDirectories(...paths, signal).then(value => { finished = true; return value; });
  await Promise.resolve(); assert.equal(canonical.mock.callCount(), 2);
  assert.deepEqual(canonical.mock.calls.map(call => call.arguments), [[paths[0], false, signal], [paths[1], false, signal]]);
  reads[1]!.resolve("/canonical/config"); await Promise.resolve(); assert.equal(finished, false);
  reads[0]!.resolve("/canonical/work");
  assert.deepEqual(await work, { cwd: "/canonical/work", agentDirectory: "/canonical/config" });
});
test("a synchronous or asynchronous ordinary directory refusal drains its sibling and never leaks the native error", async t => {
  for (const synchronous of [false, true]) {
    const reads = paths.map(() => deferred<string>());
    const canonical = t.mock.method(goalDirectoryIO, "canonical", (value: string) => {
      const index = paths.indexOf(value as typeof paths[number]);
      if (index === 0 && synchronous) throw new Error("SYNTHETIC_PRIVATE_DIRECTORY_ERROR");
      return reads[index]!.promise;
    });
    let finished = false;
    const work = canonicalOrdinaryDirectories(...paths).then(() => assert.fail("No partial result"), error => { finished = true; return error; });
    await Promise.resolve(); if (!synchronous) reads[0]!.reject(new Error("SYNTHETIC_PRIVATE_DIRECTORY_ERROR"));
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); assert.equal(canonical.mock.callCount(), 2);
    reads[1]!.resolve(paths[1]); const error = await work;
    assert.ok(error instanceof Error); assert.ok(!error.message.includes("SYNTHETIC_PRIVATE")); canonical.mock.restore();
  }
});
test("cancellation drains in-flight ordinary directory checks; already cancelled starts none", async t => {
  const controller = new AbortController(), reads = paths.map(() => deferred<string>());
  const canonical = t.mock.method(goalDirectoryIO, "canonical", (value: string) => reads[paths.indexOf(value as typeof paths[number])]!.promise);
  let finished = false;
  const work = canonicalOrdinaryDirectories(...paths, controller.signal).then(() => assert.fail("No authority after cancel"), () => { finished = true; });
  await Promise.resolve(); controller.abort(); await Promise.resolve(); assert.equal(finished, false);
  reads[0]!.resolve(paths[0]); reads[1]!.resolve(paths[1]); await work;
  assert.equal(finished, true); assert.equal(canonical.mock.callCount(), 2);
  await assert.rejects(canonicalOrdinaryDirectories(...paths, controller.signal)); assert.equal(canonical.mock.callCount(), 2);
});
test("preparation stage markers accept only known own literal values and never read private error getters", () => {
  for (const stage of ORDINARY_PREPARATION_STAGES) assert.equal(ordinaryPreparationStage(new OrdinaryPreparationError(stage)), stage);
  const forged = new Error("PRIVATE_ERROR"); Object.assign(forged, { stage: "file_scope" }); assert.equal(ordinaryPreparationStage(forged), undefined);
  const marked = new OrdinaryPreparationError("input"); Object.defineProperty(marked, "stage", { get() { assert.fail("Never read diagnostic getters"); } });
  assert.equal(ordinaryPreparationStage(marked), undefined);
  for (const stage of ["__proto__", "PRIVATE_PATH_OR_KEY", "constructor"]) {
    const value = new OrdinaryPreparationError("input"); Object.defineProperty(value, "stage", { value: stage }); assert.equal(ordinaryPreparationStage(value), undefined);
  }
  assert.equal(ordinaryPreparationStage(null), undefined);
});
const input: OrdinaryScopeInput = { task: "Read one existing fixture file.", agents: ["scout"], files: [{ path: "fixture.txt", access: "read" }],
  tasks: [{ id: "read", agent: "scout", summary: "Read file-1 and report one limitation." }], selection: "parent_only",
  limits: { workerRuns: 1, modelCalls: 2, perWorkerCalls: 2, seconds: 30 } };
test("every known preparation refusal reports only its safe stage, with no approval, ownership, worker or JEV", async t => {
  const ctx = { cwd: "/synthetic", mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "synthetic-session" },
    ui: { confirm: async () => assert.fail("No approval after preparation refusal") } } as unknown as ExtensionContext;
  for (const stage of ORDINARY_PREPARATION_STAGES) {
    const io = { ...ordinaryIO, prepare: async () => { throw new OrdinaryPreparationError(stage); },
      own: async () => assert.fail("No owner"), run: async () => assert.fail("No worker"), select: async () => assert.fail("No JEV") };
    const result = await ordinaryDelegate(input, ctx, t.signal, undefined, io);
    assert.equal(result.status, "stopped"); assert.equal(result.reason, "failed");
    assert.deepEqual(result.diagnostic, { phase: "preparing", preparationStage: stage });
    assert.equal(result.workersStarted, 0); assert.equal(result.modelCalls, 0); assert.equal(result.jevRequests, 0);
    assert.equal(result.cleanupConfirmed, true); assert.equal(result.lockRetained, false);
  }
});
test("uncertain preparation cleanup is preserved for both native and aggregated read errors", async t => {
  const ctx = { cwd: "/synthetic", mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "synthetic-session" },
    ui: { confirm: async () => assert.fail("No approval after uncertain preparation") } } as unknown as ExtensionContext;
  const issue = { target: "workspace" as const, reason: "unknown" as const, cleanupConfirmed: false };
  for (const error of [new DirectoryValidationError("Fixed", "unknown", false), new DirectoryPreparationError("Fixed", [issue]), new OrdinaryPreparationError("freshness", [issue])]) {
    const io = { ...ordinaryIO, prepare: async () => { throw error; }, run: async () => assert.fail("No worker"), own: async () => assert.fail("No owner") };
    const result = await ordinaryDelegate(input, ctx, t.signal, undefined, io);
    assert.equal(result.status, "stopped"); assert.equal(result.cleanupConfirmed, false);
    assert.deepEqual(result.diagnostic?.directoryIssues, [issue]); assert.equal(result.workersStarted, 0);
  }
});
test("invalid public input is marked before directory IO and pre-cancel propagates only a safe directory stage", async t => {
  const ctx = { cwd: "/synthetic" } as ExtensionContext, signal = new AbortController().signal;
  const canonical = t.mock.method(goalDirectoryIO, "canonical", async () => assert.fail("No native IO"));
  await assert.rejects(prepareOrdinaryScope({ ...input, agents: [] }, ctx, signal), error => ordinaryPreparationStage(error) === "input");
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(prepareOrdinaryScope(input, ctx, cancelled.signal), error => ordinaryPreparationStage(error) === "directories");
  assert.equal(canonical.mock.callCount(), 0);
});

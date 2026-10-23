import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDirectory, canonicalGoalDirectories, checkFreshReadPair, goalDirectoryIO } from "../src/goal-run-effects.ts";
import { GOAL_RUN_ERROR } from "../src/goal-run.ts";
import { DirectoryValidationError, DirectoryPreparationError, directoryError } from "../src/directory-diagnostics.ts";

const paths = ["/synthetic/work", "/synthetic/private-journal", "/synthetic/config"] as const;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("independent directory preparation starts all three read-only validations but returns only fully drained exact results", async t => {
  const reads = paths.map(() => deferred<string>()), signal = new AbortController().signal;
  const canonical = t.mock.method(goalDirectoryIO, "canonical", (value: string) => reads[paths.indexOf(value as typeof paths[number])]!.promise);
  let finished = false;
  const prepared = canonicalGoalDirectories(...paths, signal).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(canonical.mock.callCount(), 3);
  assert.deepEqual(canonical.mock.calls.map(call => call.arguments), [[paths[0], false, signal], [paths[1], true, signal], [paths[2], false, signal]]);
  reads[2]!.resolve("/canonical/config"); reads[0]!.resolve("/canonical/work"); await Promise.resolve();
  assert.equal(finished, false);
  reads[1]!.resolve("/canonical/private-journal");
  assert.deepEqual(await prepared, { cwd: "/canonical/work", journalDirectory: "/canonical/private-journal", agentDirectory: "/canonical/config" });
});

test("one rejected or synchronously throwing directory never abandons the other owned validations or exposes its raw failure", async t => {
  for (const synchronous of [false, true]) {
    const reads = paths.map(() => deferred<string>());
    const canonical = t.mock.method(goalDirectoryIO, "canonical", (value: string) => {
      const index = paths.indexOf(value as typeof paths[number]);
      if (index === 0 && synchronous) throw new Error("SYNTHETIC_PRIVATE_DIRECTORY_ERROR");
      return reads[index]!.promise;
    });
    let finished = false;
    const checked = canonicalGoalDirectories(...paths).then(() => assert.fail("No partial grant"), error => { finished = true; return error; });
    await Promise.resolve();
    if (!synchronous) reads[0]!.reject(new Error("SYNTHETIC_PRIVATE_DIRECTORY_ERROR"));
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false); assert.equal(canonical.mock.callCount(), 3);
    reads[1]!.resolve(paths[1]); reads[2]!.resolve(paths[2]);
    const error = await checked;
    assert.ok(error instanceof Error); assert.equal(error.message, GOAL_RUN_ERROR);
    canonical.mock.restore();
  }
});

test("cancellation after read-only startup drains outstanding validations before refusal and never produces directory authority", async t => {
  const controller = new AbortController(), reads = paths.map(() => deferred<string>());
  const canonical = t.mock.method(goalDirectoryIO, "canonical", (value: string) => reads[paths.indexOf(value as typeof paths[number])]!.promise);
  let finished = false;
  const checked = canonicalGoalDirectories(...paths, controller.signal).then(() => assert.fail("Aborted preparation cannot proceed"), () => { finished = true; });
  await Promise.resolve(); controller.abort(); await Promise.resolve(); assert.equal(finished, false);
  for (const [index, value] of paths.entries()) reads[index]!.resolve(value);
  await checked; assert.equal(finished, true); assert.equal(canonical.mock.callCount(), 3);
});

test("already cancelled preparation starts no native validation, retries or model work", async t => {
  const controller = new AbortController(); controller.abort();
  const canonical = t.mock.method(goalDirectoryIO, "canonical", async () => assert.fail("No work after cancellation"));
  await assert.rejects(canonicalGoalDirectories(...paths, controller.signal));
  assert.equal(canonical.mock.callCount(), 0);
});

test("fresh read pair overlaps independent checks and waits for both exact results", async () => {
  const first = deferred<void>(), second = deferred<void>(), started: string[] = [];
  let finished = false;
  const work = checkFreshReadPair(() => { started.push("context"); return first.promise; }, () => { started.push("files"); return second.promise; })
    .then(() => { finished = true; });
  await Promise.resolve(); assert.deepEqual(started, ["context", "files"]);
  first.resolve(); await Promise.resolve(); assert.equal(finished, false);
  second.resolve(); await work; assert.equal(finished, true);
});
test("fresh read refusal and synchronous errors drain the other read without partial admission", async () => {
  for (const synchronous of [false, true]) {
    const first = deferred<void>(), second = deferred<void>(), failure = new Error("Synthetic first refusal");
    let siblingStarted = false, finished = false;
    const work = checkFreshReadPair(() => { if (synchronous) throw failure; return first.promise; }, () => { siblingStarted = true; return second.promise; })
      .then(() => assert.fail("No partial admission"), error => { finished = true; return error; });
    await Promise.resolve(); assert.equal(siblingStarted, true);
    if (!synchronous) first.reject(failure);
    await Promise.resolve(); await Promise.resolve(); assert.equal(finished, false);
    second.resolve(); assert.equal(await work, failure);
  }
});
test("any late unknown cleanup survives an earlier refusal or cancellation", async () => {
  for (const cancelled of [false, true]) for (const preparation of [false, true]) {
    const controller = new AbortController(), first = deferred<void>(), second = deferred<void>();
    const work = checkFreshReadPair(() => first.promise, () => second.promise, controller.signal).then(() => assert.fail("No unknown cleanup admission"), error => error);
    await Promise.resolve(); first.reject(new Error("Synthetic early refusal"));
    if (cancelled) controller.abort();
    second.reject(preparation ? new DirectoryPreparationError("Fixed", [{ target: "workspace", reason: "unknown", cleanupConfirmed: false }])
      : new DirectoryValidationError("Fixed", "helper_timeout", false));
    assert.deepEqual(directoryError(await work), { reason: "unknown", cleanupConfirmed: false });
  }
});
test("pre-cancelled read pair starts nothing; late cancellation drains both reads", async () => {
  const controller = new AbortController(); controller.abort(); let started = 0;
  await assert.rejects(checkFreshReadPair(async () => { started++; }, async () => { started++; }, controller.signal));
  assert.equal(started, 0);
  const live = new AbortController(), first = deferred<void>(), second = deferred<void>(); let finished = false;
  const work = checkFreshReadPair(() => first.promise, () => second.promise, live.signal).then(() => assert.fail("No admission after cancellation"), () => { finished = true; });
  await Promise.resolve(); live.abort(); first.resolve(); await Promise.resolve(); assert.equal(finished, false);
  second.resolve(); await work; assert.equal(finished, true);
});
test("real directory adapter preserves early native cancellation and rejects relative syntax before OS facts or I/O", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(canonicalDirectory(paths[0], false, controller.signal));
  await assert.rejects(canonicalDirectory("relative-path", true), { message: GOAL_RUN_ERROR });
});

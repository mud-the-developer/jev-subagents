import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { verify } from "../src/delegate-effects.ts";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-verify-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const spawn = childProcess.spawn;
  const launches = t.mock.method(childProcess, "spawn", (...[command, args, options]: Parameters<typeof spawn>) => {
    assert.equal(options?.shell, false);
    assert.equal(options?.env?.TYPESAFE_API_KEY, undefined);
    assert.equal(options?.env?.NODE_OPTIONS, undefined);
    if (process.platform === "win32") {
      assert.ok(args?.includes("-EncodedCommand"));
      assert.deepEqual(options?.stdio, ["pipe", "pipe", "ignore"]);
      return spawn(command, args, { ...options, env: { ...options?.env, HOME: cwd } });
    }
    assert.equal(options?.stdio, "ignore");
    return spawn(command, args, { ...options, env: { PATH: process.env.PATH, HOME: cwd } });
  });
  return { cwd, launches };
}

test("verification executes argv literally, discards output, and reports exit status", async (t) => {
  const { cwd, launches } = await fixture(t);
  const literal = "$(touch must-not-exist); echo untrusted";
  const args = ["-e", "require('node:assert/strict').equal(process.argv[1], '$(touch must-not-exist); echo untrusted'); console.log('offline-secret')", literal];
  assert.deepEqual(await verify(cwd, { command: process.execPath, args }), { type: "verified", result: { status: "passed", exitCode: 0 } });
  assert.deepEqual(await readdir(cwd), []);
  assert.equal(launches.mock.callCount(), 1);
  const failure = await verify(cwd, { command: process.execPath, args: ["-e", "console.error('offline-secret');process.exit(3)"] });
  assert.deepEqual(failure, { type: "verified", result: { status: "failed", exitCode: 3 } });
  assert.ok(!JSON.stringify(failure).includes("offline-secret"));
  assert.deepEqual(await verify(cwd, { command: path.join(cwd, "missing"), args: [] }),
    { type: "verified", result: { status: "failed", exitCode: null } });
});

test("verification times out without retry and pre-cancellation does not spawn", { timeout: 10_000 }, async (t) => {
  const { cwd, launches } = await fixture(t);
  const command = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };
  assert.deepEqual(await verify(cwd, command, AbortSignal.abort()), { type: "cancel" });
  assert.equal(launches.mock.callCount(), 0);
  assert.deepEqual(await verify(cwd, command, undefined, 100), { type: "verified", result: { status: "timed_out", exitCode: null } });
  assert.equal(launches.mock.callCount(), 1);
});

test("verification cancellation cleans the command group, including a SIGTERM-ignoring child", { timeout: 15_000 }, async (t) => {
  const { cwd } = await fixture(t);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, t.signal]);
  const childScript = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)";
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const pending = verify(cwd, { command: process.execPath, args: ["-e", script] }, signal);
  t.after(() => controller.abort());
  let pid: number;
  for (;;) {
    try { pid = Number(await readFile(path.join(cwd, "child.pid"), "utf8")); break; }
    catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      await delay(10, undefined, { signal: t.signal });
    }
  }
  assert.ok(Number.isInteger(pid) && pid > 1);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } });
  controller.abort();
  assert.deepEqual(await pending, { type: "cancel" });
  assert.equal(getEventListeners(signal, "abort").length, 0);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return; }
    await delay(10, undefined, { signal: t.signal });
  }
  assert.fail("Verification left a child process running.");
});

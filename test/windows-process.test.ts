import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ownWindowsProcess } from "../src/windows-job.ts";
import { verify } from "../src/delegate-effects.ts";

const options = { skip: process.platform !== "win32", timeout: 25_000 };
const fixtureFile = fileURLToPath(new URL("./fixtures/windows-process.ts", import.meta.url));
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function directory(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-windows-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
async function gone(pid: number, signal: AbortSignal) {
  for (let i = 0; i < 200; i++) { if (!alive(pid)) return; await delay(20, undefined, { signal }); }
  assert.fail("An owned Windows descendant survived cleanup.");
}
async function marker(filename: string, signal: AbortSignal): Promise<number> {
  for (;;) {
    try { return Number(await readFile(filename, "utf8")); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); await delay(20, undefined, { signal }); }
  }
}

test("Windows Job Object reaps detached descendants after their leader exits", options, async (t) => {
  const cwd = await directory(t), filename = path.join(cwd, "child.pid"), earliest = Date.now();
  const child = childProcess.fork(fixtureFile, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => child.kill("SIGKILL"));
  const job = await ownWindowsProcess(child, earliest);
  t.after(() => job.close());
  const closed = once(child, "close");
  child.send({ filename });
  const pid = await marker(filename, t.signal);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } });
  await closed;
  assert.ok(alive(pid));
  assert.equal(await job.close(), true);
  assert.equal(await job.close(), true);
  await gone(pid, t.signal);
});

test("Windows guardian fails closed for a process not owned by its parent", options, async () => {
  const fake = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, signalCode: null }) as childProcess.ChildProcess;
  await assert.rejects(ownWindowsProcess(fake, Date.now()), /ownership unavailable/);
});

test("Windows parent death closes the guardian job and kills its detached child", options, async (t) => {
  const cwd = await directory(t), filename = path.join(cwd, "child.pid");
  const parent = childProcess.fork(fixtureFile, ["coordinator", filename], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => parent.kill("SIGKILL"));
  const pid = await marker(filename, t.signal);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } });
  assert.ok(alive(pid));
  parent.kill("SIGKILL");
  await gone(pid, t.signal);
});

test("Windows native verification preserves literal argv, discards output and checks exit status", options, async (t) => {
  const cwd = await directory(t), literal = "$(touch impossible); & untrusted";
  const command = { command: process.execPath, args: ["-e", "require('node:assert/strict').equal(process.argv[1], '$(touch impossible); & untrusted');console.log('secret')", literal] };
  assert.deepEqual(await verify(cwd, command), { type: "verified", result: { status: "passed", exitCode: 0 } });
  assert.deepEqual(await verify(cwd, { command: process.execPath, args: ["-e", "process.exit(7)"] }),
    { type: "verified", result: { status: "failed", exitCode: 7 } });
});

test("Windows verification admits no command after cancellation or an expired startup budget", options, async (t) => {
  const cwd = await directory(t), filename = path.join(cwd, "unexpected");
  const command = { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(filename)},'unexpected')`] };
  assert.deepEqual(await verify(cwd, command, AbortSignal.abort()), { type: "cancel" });
  assert.deepEqual(await verify(cwd, command, undefined, 1), { type: "verified", result: { status: "timed_out", exitCode: null } });
  await assert.rejects(readFile(filename), { code: "ENOENT" });
});

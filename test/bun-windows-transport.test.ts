import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { bunWorkerOptions, WORKER_BUN_VERSION } from "../src/worker-runtime.ts";
import { ownWindowsProcess, type WindowsJob } from "../src/windows-job.ts";
import { runWindowsGoalProcess, windowsGoalProcessIO } from "../src/windows-goal-process.ts";
import type { GoalWorkerReply } from "../src/goal-run.ts";
import { createWindowsProfiles } from "../src/windows-profile-files.ts";

const windows = { skip: process.platform !== "win32", timeout: 30000 };
const worker = fileURLToPath(new URL("./fixtures/bun-runtime-child.ts", import.meta.url));
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-bun-transport-")), directory = path.join(root, "private"), cwd = path.join(directory, "task");
  await createWindowsProfiles([{ file: path.join(directory, "seed.md"), content: "Disposable Bun transport fixture only.\n" }]); await mkdir(cwd);
  const canary = path.join(directory, "unexpected-preload");
  await writeFile(path.join(cwd, ".env"), "UNAPPROVED_BUN_ENV=dotenv-must-not-load\n");
  await writeFile(path.join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\nenv = true\n');
  await writeFile(path.join(cwd, "preload.ts"), `import fs from "node:fs";fs.writeFileSync(${JSON.stringify(canary)},"forbidden");`);
  await writeFile(path.join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@earendil-works/pi-coding-agent": ["./preload.ts"] } } }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { cwd, canary };
}
function launch(t: TestContext, cwd: string) {
  const runtime = bunWorkerOptions({ ...process.env, BUN_OPTIONS: "--preload=unapproved-hook" }), born = Date.now();
  const child = cp.fork(worker, [], { ...runtime, cwd, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { child.kill("SIGKILL"); });
  return { child, born };
}
test("Bun worker JSON IPC suppresses task dotenv/preload and flushes its complete reply before exit", windows, async t => {
  const f = await fixture(t), { child, born } = launch(t, f.cwd), closed = once(child, "close"), reply = once(child, "message");
  const job = await ownWindowsProcess(child, born); t.after(() => job.close());
  const text = "Synthetic 漢字 한글 " + "x".repeat(32768); child.send({ type: "echo", text });
  const [value] = await reply; const [code] = await closed;
  assert.deepEqual(value, { type: "echo", text, bun: WORKER_BUN_VERSION, mainMatches: true, poison: null, ambientHook: null, sdkImport: true });
  assert.equal(code, 0); assert.equal(await job.close(), true); await assert.rejects(access(f.canary), { code: "ENOENT" });
});
test("late runtime ownership cannot spend a fresh worker timeout or admit a payload after the original budget", windows, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const child = Object.assign(new EventEmitter(), { connected: true, send: t.mock.fn(() => {}), kill: t.mock.fn(() => true) });
  let admit!: (job: WindowsJob) => void;
  t.mock.method(windowsGoalProcessIO, "fork", () => child as unknown as cp.ChildProcess);
  t.mock.method(windowsGoalProcessIO, "own", () => new Promise<WindowsJob>(resolve => { admit = resolve; }));
  const work = runWindowsGoalProcess({ script: "ordinary-worker.ts", cwd: process.cwd(), input: { synthetic: true }, deadline: Date.now() + 60000, timeoutMs: 100 },
    (_value: unknown): _value is GoalWorkerReply => false);
  child.emit("spawn"); assert.equal(typeof admit, "function"); t.mock.timers.tick(200);
  admit({ async close() { child.emit("close", 0); return true; } });
  const result = await work; assert.equal(child.send.mock.callCount(), 0); assert.equal(result.cleanupConfirmed, true); assert.equal(result.result, null);
});
test("Bun IPC cancellation closes its owned Windows process tree including a detached Bun descendant", windows, async t => {
  const f = await fixture(t), { child, born } = launch(t, f.cwd), closed = once(child, "close"), ready = once(child, "message");
  const job = await ownWindowsProcess(child, born); t.after(() => job.close()); child.send({ type: "hold" });
  const [value] = await ready; assert.equal(value.type, "ready"); assert.ok(Number.isSafeInteger(value.pid)); const pid: number = value.pid;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Owned descendant already reaped. */ } });
  process.kill(pid, 0); const cancelled = once(child, "message"); child.send({ type: "cancel" }); assert.deepEqual((await cancelled)[0], { type: "cancelled" });
  assert.equal((await closed)[0], 0); assert.equal(await job.close(), true);
  let alive = true;
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { alive = false; break; } await new Promise<void>(resolve => setTimeout(resolve, 20)); }
  assert.equal(alive, false); await assert.rejects(access(f.canary), { code: "ENOENT" });
});

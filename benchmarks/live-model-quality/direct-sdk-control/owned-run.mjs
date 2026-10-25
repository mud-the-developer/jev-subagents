// Parent-owned benchmark process only. No JEV routing/delegation/execution API.
import assert from "node:assert/strict";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const worker = fileURLToPath(new URL("./direct-worker.mjs", import.meta.url));
export async function runOwnedDirect(input, { signal, childFile = worker, seconds = 300 } = {}) {
  assert.equal(process.platform, "win32"); assert.ok(seconds > 0 && seconds <= 300);
  const local = name => import(pathToFileURL(path.join(input.runtimeRoot, "src", name)).href);
  const { bunWorkerOptions } = await local("worker-runtime.ts"), { ownWindowsProcess } = await local("windows-job.ts");
  const options = bunWorkerOptions(), born = Date.now(), started = performance.now();
  const env = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", DO_NOT_TRACK: "1" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "LOCALAPPDATA"]) if (process.env[key]) env[key] = process.env[key];
  env.PATH = [path.dirname(options.execPath), path.join(process.env.SystemRoot, "System32")].join(path.delimiter);
  const child = fork(childFile, [], { ...options, env, cwd: input.cwd, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let job, timer, forceTimer, reply, transportFailure = false, exited = false, deadlineReached = false;
  let settle, rejectReply;
  const received = new Promise((resolve, reject) => { settle = resolve; rejectReply = reject; });
  // Register before ownership: early exits cannot be missed while the guardian starts.
  const exit = new Promise(resolve => child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); if (!reply) rejectReply(new Error("Direct child exited before a result.")); }));
  received.catch(() => {});
  child.once("error", () => { transportFailure = true; rejectReply(new Error("Direct child transport failed.")); });
  child.on("message", message => {
    try {
      assert.equal(reply, undefined); assert.ok(message && typeof message === "object");
      assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 262144);
      assert.equal(message.type, "direct_sdk_result"); assert.equal(message.id, input.id);
      assert.ok(Number.isInteger(message.sdkCalls) && message.sdkCalls >= 0); assert.equal(message.sdkCallCap, null);
      assert.ok(["completed_unverified", "failed", "cancelled", "offline_probe"].includes(message.status));
      reply = message; settle(message);
    } catch { transportFailure = true; rejectReply(new Error("Direct child result refused.")); }
  });
  const cancel = () => {
    if (child.connected) child.send({ type: "direct_control_cancel" }, () => {});
    forceTimer ??= setTimeout(() => { void job?.close(); }, 2000);
    rejectReply(new Error("Direct control cancelled or expired."));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let result, cleanupConfirmed = false, leader;
  try {
    job = await ownWindowsProcess(child, born); signal?.throwIfAborted();
    // This trusted child has done no SDK work while waiting for ownership.
    const deadline = Date.now() + seconds * 1000;
    timer = setTimeout(() => { deadlineReached = true; cancel(); }, seconds * 1000);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...input, deadline })) <= 262144);
    child.send({ ...input, deadline }, error => { if (error) { transportFailure = true; rejectReply(new Error("Direct child IPC failed.")); } });
    result = await received;
    // Receipt delivery is not proof of process exit. A bounded drain precedes Job closure.
    leader = await Promise.race([exit, new Promise(resolve => { forceTimer = setTimeout(() => resolve(null), 2000); })]);
    if (!leader) { await job.close(); leader = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 1000))]); }
  } catch {
    result = reply ?? { type: "direct_sdk_result", id: input.id, status: deadlineReached ? "cancelled" : "failed",
      failureStage: job ? "transport_or_deadline" : "ownership", sdkCalls: null, sdkCallCap: null,
      accounting: { status: "unknown", complete: false, observedUsdEstimate: null }, disposed: false, files: { ioFinished: false } };
  } finally {
    clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener("abort", cancel);
    if (job) cleanupConfirmed = await job.close();
    else { child.kill(); cleanupConfirmed = false; }
    if (!exited) leader = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
  }
  const complete = !transportFailure && !deadlineReached && result.status === "completed_unverified" && result.disposed && result.files?.ioFinished
    && result.accounting?.status === "reported_complete" && cleanupConfirmed && exited && leader?.code === 0;
  return { ...result, status: result.status === "offline_probe" ? "offline_probe" : complete ? "completed_unverified" : "failed",
    parentOwnedElapsedMs: performance.now() - started, cleanupConfirmed, childExitConfirmed: exited,
    leaderExitCode: leader?.code ?? null, transportFailure, deadlineReached, jevExecutionCalls: 0 };
}

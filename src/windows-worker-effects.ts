import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { progressReceiver, type WorkerProgressObserver } from "./worker-progress.ts";
import { WorkerReplySchema, RunSchema, executionSeconds, executionTimeoutMessage, type Run, type Event, type WorkerReply } from "./delegate-machine.ts";
import { ownWindowsProcess, type WindowsJob } from "./windows-job.ts";
import { bunWorkerOptions } from "./worker-runtime.ts";

type Result = { reply?: unknown; code: number | null; cancelled: boolean; timedOut: boolean; clean: boolean };

// An explicit effect boundary also lets offline transport tests replace OS ownership, not approvals.
export const windowsProcessIO = { own: ownWindowsProcess };

/** Effect-local transport only. Never sends the approved payload until Windows owns the process tree. */
async function windowsTask(filename: string, input: Run | NonNullable<Run["verification"]>, cwd: string, env: NodeJS.ProcessEnv,
  validReply: (value: unknown) => boolean, timeoutMs: number, signal?: AbortSignal, onProgress?: WorkerProgressObserver): Promise<Result> {
  const empty: Result = { code: null, cancelled: signal?.aborted === true, timedOut: false, clean: false };
  if (signal?.aborted) return empty;
  const earliest = Date.now(), runtime = bunWorkerOptions(env);
  if (signal?.aborted) return { ...empty, cancelled: true, clean: true };
  if (Date.now() - earliest >= timeoutMs) return { ...empty, timedOut: true, clean: true };
  const child = childProcess.fork(filename, [], {
    ...runtime, cwd, detached: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise<Result>((resolve) => {
    const receiveProgress = progressReceiver(onProgress), isWorker = Value.Check(RunSchema, input);
    let reply: unknown, invalid = false, stopped = false, timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let job: WindowsJob | undefined;
    let closed = false;
    const stop = () => {
      if (stopped || closed) return;
      stopped = true;
      // Windows signals are not graceful SDK cancellation. Ask through owned IPC first.
      if (job && child.connected) child.send({ type: "jev_worker_cancel" }, () => {});
      else child.kill("SIGKILL"); // No payload has been admitted, so it cannot have launched task children.
      killTimer = setTimeout(() => { if (job) void job.close(); else child.kill("SIGKILL"); }, 2_000);
    };
    const onAbort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutMs - (Date.now() - earliest)));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("message", (value: unknown) => {
      const progress = isWorker && job && reply === undefined ? receiveProgress(value) : "not_progress";
      if (progress === "accepted") return;
      if (progress === "invalid" || reply !== undefined || !validReply(value)) { invalid = true; stop(); }
      else reply = value;
    });
    child.once("error", () => { invalid = true; stop(); });
    const ownership = windowsProcessIO.own(child, earliest);
    void ownership.then((owned) => {
      job = owned;
      if (stopped || closed || signal?.aborted || Date.now() - earliest >= timeoutMs) {
        timedOut ||= !signal?.aborted && Date.now() - earliest >= timeoutMs; void owned.close(); return;
      }
      child.send(input, (error) => { if (error) { invalid = true; stop(); } });
    }, () => { invalid = true; stop(); });
    child.once("close", async (code) => {
      closed = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      let clean = false;
      try { clean = await (await ownership).close(); } catch { /* Fail closed; never certify unobserved cleanup. */ }
      resolve({ ...(reply === undefined ? {} : { reply }), code,
        cancelled: signal?.aborted === true, timedOut, clean: clean && !invalid && (!stopped || timedOut || signal?.aborted === true) });
    });
    if (signal?.aborted) onAbort();
  });
}

export async function runWindowsSubagent(run: Run, env: NodeJS.ProcessEnv, signal?: AbortSignal, onProgress?: WorkerProgressObserver): Promise<Event> {
  if (signal?.aborted) return { type: "cancel" };
  if (!Value.Check(RunSchema, run)) return { type: "failed", error: "Invalid approved worker input." };
  try {
    const result = await windowsTask(fileURLToPath(new URL("./subagent-worker.ts", import.meta.url)), run, run.cwd, env,
      (value) => Value.Check(WorkerReplySchema, value), executionSeconds(run) * 1000, signal, onProgress);
    const reply = result.reply as WorkerReply | undefined;
    let outcome: Event;
    if (result.cancelled) outcome = { type: "cancel" };
    else if (result.timedOut) outcome = { type: "failed", error: executionTimeoutMessage(run) };
    else if (result.clean && result.code === 0 && reply) outcome = reply;
    else outcome = { type: "failed", error: "Windows subagent execution or process-tree cleanup failed. Changes may be incomplete." };
    return reply?.report ? { ...outcome, report: { ...reply.report, accounting:
      reply.report.accounting.status === "reported" && (!result.clean || result.cancelled || result.timedOut || result.code !== 0)
        ? { ...reply.report.accounting, complete: false } : reply.report.accounting } } : outcome;
  } catch { return signal?.aborted ? { type: "cancel" } : { type: "failed", error: "Unable to start the Windows subagent." }; }
}

function validVerificationReply(value: unknown): value is { exitCode: number | null } {
  return typeof value === "object" && value !== null && Object.keys(value).length === 1 && "exitCode" in value &&
    (value.exitCode === null || typeof value.exitCode === "number" && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 0xffffffff);
}

export async function verifyWindows(cwd: string, command: NonNullable<Run["verification"]>, env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined, timeoutMs: number): Promise<Event> {
  if (signal?.aborted) return { type: "cancel" };
  try {
    const result = await windowsTask(fileURLToPath(new URL("./windows-verification-worker.ts", import.meta.url)), command,
      cwd, env, validVerificationReply, timeoutMs, signal);
    if (result.cancelled) return { type: "cancel" };
    if (result.timedOut) return { type: "verified", result: { status: "timed_out", exitCode: null } };
    const reply = result.reply as { exitCode: number | null } | undefined;
    const exitCode = result.clean && result.code === 0 && reply ? reply.exitCode : null;
    return { type: "verified", result: exitCode === 0 ? { status: "passed", exitCode: 0 } : { status: "failed", exitCode } };
  } catch { return signal?.aborted ? { type: "cancel" } : { type: "verified", result: { status: "failed", exitCode: null } }; }
}

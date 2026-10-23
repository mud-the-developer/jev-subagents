import childProcess, { type Serializable } from "node:child_process";
import { fileURLToPath } from "node:url";
import { windowsProcessIO } from "./windows-worker-effects.ts";
import type { WindowsJob } from "./windows-job.ts";
import type { GoalWorkerReply } from "./goal-run.ts";
import type { WorkerReply } from "./delegate-machine.ts";
export type OwnedProcessReply = GoalWorkerReply | WorkerReply;
export function markOwnedReplyIncomplete(result: OwnedProcessReply): void {
  const reply = result.type === "goal_result" ? result.reply : result;
  if (reply.report.accounting.status === "reported") reply.report.accounting.complete = false;
  if (result.type === "goal_result") result.files.finished = false;
}
import { stripJevEnvironment } from "./jev-config.ts";
import { progressReceiver, type WorkerProgressObserver } from "./worker-progress.ts";
import { bunWorkerOptions } from "./worker-runtime.ts";

// Existing effect-only Windows Job boundary, not a new scheduler/execution framework.
export const windowsGoalProcessIO = { fork: (...args: Parameters<typeof childProcess.fork>) => childProcess.fork(...args), own: windowsProcessIO.own };
export async function runWindowsGoalProcess<R extends OwnedProcessReply>(request: {
  readonly script: "goal-worker.ts" | "goal-sequence-worker.ts" | "context-worker.ts" | "ordinary-worker.ts" | "parallel-read-worker.ts" | "task-tree-worker.ts";
  readonly cwd: string; readonly input: Serializable; readonly deadline: number; readonly timeoutMs: number;
}, validReply: (value: unknown) => value is R, signal?: AbortSignal, onProgress?: WorkerProgressObserver): Promise<{ started: boolean; cleanupConfirmed: boolean; result: R | null }> {
  const empty = { started: false, cleanupConfirmed: true, result: null };
  if (signal?.aborted) return empty;
  const startedAt = Date.now();
  let attempted = false;
  try {
    const payload = structuredClone(request.input), bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > 393216 || !Number.isSafeInteger(request.deadline) || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || Date.now() >= request.deadline ||
      !["goal-worker.ts", "goal-sequence-worker.ts", "context-worker.ts", "ordinary-worker.ts", "parallel-read-worker.ts", "task-tree-worker.ts"].includes(request.script)) return empty;
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_DISABLE_ANALYTICS: "1", PI_DISABLE_INSTALL_TELEMETRY: "1" };
    stripJevEnvironment(env); delete env.NODE_OPTIONS;
    const runtime = bunWorkerOptions(env);
    if (signal?.aborted || Date.now() >= request.deadline || Date.now() - startedAt >= request.timeoutMs) return empty;
    const born = Date.now(); attempted = true;
    const child = windowsGoalProcessIO.fork(fileURLToPath(new URL(request.script, import.meta.url)), [], {
      ...runtime, cwd: request.cwd, detached: false, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    return await new Promise((resolve) => {
      const receiveProgress = progressReceiver(onProgress);
      let started = false, admitted = false, stopped = false, finishing = false, exited = false, exitCode: number | null = null;
      let job: WindowsJob | undefined, result: R | null = null, killTimer: ReturnType<typeof setTimeout> | undefined;
      const force = () => { if (job) void job.close().catch(() => false); else child.kill("SIGKILL"); };
      const stop = () => {
        if (stopped || finishing) return; stopped = true;
        if (admitted && child.connected) { try { child.send({ type: "jev_worker_cancel" }, () => {}); } catch { force(); } }
        else child.kill("SIGKILL");
        killTimer = setTimeout(force, 2000);
      };
      const timer = setTimeout(stop, Math.max(1, Math.min(request.timeoutMs - (Date.now() - startedAt), request.deadline - Date.now())));
      signal?.addEventListener("abort", stop, { once: true });
      child.once("spawn", () => { started = true; });
      child.on("message", (message: unknown) => {
        if (finishing) return;
        try {
          const progress = admitted && !result && ["ordinary-worker.ts", "parallel-read-worker.ts", "task-tree-worker.ts"].includes(request.script) ? receiveProgress(message) : "not_progress";
          if (progress === "accepted") return;
          if (progress === "invalid" || !admitted || result || !validReply(message) || Buffer.byteLength(JSON.stringify(message)) > 65536) stop();
          else result = structuredClone(message);
        }
        catch { stop(); }
      });
      child.once("error", stop);
      const ownership = windowsGoalProcessIO.own(child, born);
      void ownership.then(owned => {
        job = owned;
        if (stopped || finishing || signal?.aborted || Date.now() >= request.deadline || Date.now() - startedAt >= request.timeoutMs) { void owned.close().catch(() => false); return; }
        admitted = true;
        try { child.send(payload, error => { if (error) stop(); }); } catch { stop(); }
      }, stop);
      const finish = async (code: number | null) => {
        if (finishing) return; finishing = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop);
        let clean = false;
        try { clean = await (await ownership).close() === true; } catch { /* Unknown is not a process-tree receipt. */ }
        if (result && (stopped || code !== 0 || !clean)) markOwnedReplyIncomplete(result);
        resolve({ started, cleanupConfirmed: clean, result });
      };
      child.once("close", finish);
      // A transport may omit close after explicit IPC disconnect with ignored stdio. Job settlement
      // still owns descendant cleanup, even if the leader exited before its descendants.
      child.once("exit", code => { exited = true; exitCode = code; if (!child.connected) void finish(code); });
      child.once("disconnect", () => { if (exited) void finish(exitCode); else if (!result) stop(); });
      if (signal?.aborted) stop();
    });
  } catch { return { started: false, cleanupConfirmed: !attempted, result: null }; }
}

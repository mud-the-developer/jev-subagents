import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { executeGoalSession } from "./goal-worker.ts";
import { checkGoalContext } from "./goal-run-effects.ts";
import { snapshotGoalText } from "./goal-file-effects.ts";
import { snapshotWindowsGoalTexts } from "./windows-goal-files.ts";
import { OrdinaryWorkerInputSchema, ordinaryControlBatches, ordinaryLock, ordinaryPrompts, validOrdinaryWorkerInput, type OrdinaryWorkerInput, type OrdinaryWorkerReply } from "./ordinary-protocol.ts";
import type { executeWorker } from "./subagent-worker.ts";
import { Value } from "typebox/value";
import { sendWorkerProgress, type WorkerProgressObserver } from "./worker-progress.ts";

const stopped = () => { throw new Error("Scoped worker stopped; no retry or rollback."); };
/** Native process entry only. This is not a public tool accepting caller authority. */
export async function checkOrdinaryLease(input: OrdinaryWorkerInput, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (Date.now() >= input.deadline) stopped();
  const lock = ordinaryLock(input);
  const batches = process.platform === "win32" ? ordinaryControlBatches(input.context, lock.path, input.lockVersion.bytes) : undefined;
  const snapshots = batches ? await snapshotWindowsGoalTexts(batches[0]!, signal) : undefined;
  const snapshot = snapshots ? snapshots[0] : await snapshotGoalText(lock.path, signal);
  if (!snapshot || snapshot.text !== lock.text || !isDeepStrictEqual(snapshot.version, input.lockVersion)) stopped();
  if (batches?.length === 1) {
    for (const [index, entry] of input.context.entries()) if (!isDeepStrictEqual(snapshots?.[index + 1]?.version ?? null, entry.version)) stopped();
  } else await checkGoalContext({ body: { context: input.context } }, signal);
  signal.throwIfAborted();
  if (Date.now() >= input.deadline) stopped();
}
export async function executeOrdinaryWorker(input: unknown, signal?: AbortSignal, io?: Parameters<typeof executeWorker>[1], onProgress?: WorkerProgressObserver): Promise<OrdinaryWorkerReply> {
  if (!validOrdinaryWorkerInput(input) || signal?.aborted || Date.now() >= input.deadline) return stopped();
  const value = structuredClone(input), prompts = ordinaryPrompts(value.scope, value.run.agent, value.run.task, value.context, value.memory);
  return executeGoalSession({ run: value.run, files: value.files, agentDirectory: value.agentDirectory, journalDirectory: value.agentDirectory,
    ...prompts, deadline: value.deadline }, current => checkOrdinaryLease(value, current), "worker", signal, io, "scope", onProgress);
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 2000).unref(); }, { once: true });
  process.once("SIGTERM", () => controller.abort()); process.once("disconnect", () => controller.abort());
  let received = false;
  process.on("message", async input => {
    if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel" && Object.keys(input).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; }
    received = true;
    const deadline = Value.Check(OrdinaryWorkerInputSchema, input) ? input.deadline : Date.now();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now())); timer.unref();
    try { const reply = await executeOrdinaryWorker(input, controller.signal, undefined, sendWorkerProgress); process.send!(reply, () => process.exit(0)); }
    catch { process.exit(1); } finally { clearTimeout(timer); }
  });
}

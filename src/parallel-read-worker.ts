import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { executeWorker } from "./subagent-worker.ts";
import { checkGoalContext } from "./goal-run-effects.ts";
import { readApprovalPolicy, PARALLEL_READ_ERROR } from "./parallel-read-effects.ts";
import { ParallelReadWorkerInputSchema, validParallelReadWorker } from "./parallel-read.ts";
import { sendWorkerProgress, type WorkerProgressObserver } from "./worker-progress.ts";

/** An owned native IPC entry, not a public tool or caller-provided execution grant. */
export async function executeParallelReadWorker(input: unknown, signal?: AbortSignal,
  io?: Parameters<typeof executeWorker>[1], progress?: WorkerProgressObserver) {
  if (!validParallelReadWorker(input) || signal?.aborted || Date.now() >= input.deadline) throw new Error(PARALLEL_READ_ERROR);
  const owned = structuredClone(input);
  return executeWorker(owned.run, io, signal, undefined, progress, async model => {
    signal?.throwIfAborted();
    if (model.provider !== owned.run.model.provider || model.id !== owned.run.model.id || model.api !== owned.target.api || model.baseUrl !== owned.target.endpoint) throw new Error(PARALLEL_READ_ERROR);
    if (Date.now() >= owned.deadline || (await readApprovalPolicy(owned.run.cwd, signal)).version !== owned.policyVersion) throw new Error(PARALLEL_READ_ERROR);
    await checkGoalContext({ body: { context: owned.context } }, signal);
    signal?.throwIfAborted(); if (Date.now() >= owned.deadline) throw new Error(PARALLEL_READ_ERROR);
  });
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 2000).unref(); }, { once: true });
  process.once("disconnect", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  let received = false;
  process.on("message", async (input: unknown) => {
    if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel" && Object.keys(input).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; } received = true;
    const deadline = Value.Check(ParallelReadWorkerInputSchema, input) ? input.deadline : Date.now();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now())); timer.unref();
    try { const reply = await executeParallelReadWorker(input, controller.signal, undefined, sendWorkerProgress); process.send!(reply, () => process.exit(0)); }
    catch { process.exit(1); }
    finally { clearTimeout(timer); }
  });
}

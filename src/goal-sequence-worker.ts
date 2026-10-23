import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { GOAL_RUN_ERROR, GOAL_WORKER_MS } from "./goal-run.ts";
import { executeGoalSession } from "./goal-worker.ts";
import { checkSequenceLease } from "./goal-sequence-effects.ts";
import { GOAL_PLANNER_MS, SequenceWorkerInputSchema, validSequenceGrant, validSequenceOperation, sequenceSession, type SequenceReply } from "./goal-sequence.ts";

export async function executeSequenceWorker(input: unknown, signal?: AbortSignal): Promise<SequenceReply> {
  if (!Value.Check(SequenceWorkerInputSchema, input) || !validSequenceGrant(input.grant) ||
    !validSequenceOperation(input.grant, input.operation) || Buffer.byteLength(JSON.stringify(input)) > 393_216) throw new Error(GOAL_RUN_ERROR);
  const { grant, lease, operation } = structuredClone(input);
  if (!["planner", "worker", "repair"].includes(operation.kind)) throw new Error(GOAL_RUN_ERROR);
  const session = sequenceSession(grant, operation);
  if (Buffer.byteLength(session.prompt) > 32_768) throw new Error(GOAL_RUN_ERROR);
  await checkSequenceLease(grant, lease, operation, signal);
  const reply = await executeGoalSession(session, (signal) => checkSequenceLease(grant, lease, operation, signal), operation.kind === "planner" ? "planner" : "worker", signal);
  return { ...reply, operationId: operation.id };
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 2_000).unref(); }, { once: true });
  process.once("SIGTERM", () => controller.abort());
  process.once("disconnect", () => controller.abort());
  let received = false;
  process.on("message", async (input) => {
    if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel" && Object.keys(input).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; } received = true;
    const valid = Value.Check(SequenceWorkerInputSchema, input);
    const remaining = valid ? input.operation.deadline - Date.now() : 0;
    const limit = valid && input.operation.kind === "planner" ? GOAL_PLANNER_MS : GOAL_WORKER_MS;
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(limit, remaining)));
    timer.unref();
    try { process.send!(await executeSequenceWorker(input, controller.signal), () => process.exit(0)); }
    catch { process.exit(1); }
    finally { clearTimeout(timer); }
  });
}

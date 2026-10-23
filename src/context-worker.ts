import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { executeWorker } from "./subagent-worker.ts";
import { checkContextLease } from "./context-control-effects.ts";
import { ContextWorkerInputSchema, validContextGrant, SUMMARY_MS, CONTEXT_ERROR } from "./context-control.ts";
import type { GoalWorkerReply } from "./goal-run.ts";

export async function executeContextWorker(input: unknown, signal?: AbortSignal, io?: Parameters<typeof executeWorker>[1]): Promise<GoalWorkerReply> {
  if (!Value.Check(ContextWorkerInputSchema, input) || !validContextGrant(input.grant) || Buffer.byteLength(JSON.stringify(input)) > 393_216) throw new Error(CONTEXT_ERROR);
  const { grant, lease } = structuredClone(input), deadline = Math.min(grant.body.deadline, Date.now() + SUMMARY_MS);
  const check = async () => {
    await checkContextLease(grant, lease, signal);
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(CONTEXT_ERROR);
  };
  await check();
  const reply = await executeWorker(grant.body.run, io, signal, { tools: [], systemPrompt: grant.body.systemPrompt, prompt: grant.body.prompt,
    beforeModelCall: check,
    afterTurn(context) { if (context.toolResults.length || context.message.content.some(x => x.type === "toolCall")) throw new Error(CONTEXT_ERROR); },
  });
  let current = false;
  try { await check(); current = true; } catch { /* Preserve actual usage, not a false fresh success. */ }
  return { type: "goal_result", reply, files: { operations: 0, readBytes: 0, writtenBytes: 0, changed: false, uncertain: false,
    finished: current && reply.type === "completed" } };
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 2_000).unref(); }, { once: true });
  process.once("SIGTERM", () => controller.abort()); process.once("disconnect", () => controller.abort());
  let received = false;
  process.on("message", async input => {
    if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel" && Object.keys(input).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; } received = true;
    const timer = setTimeout(() => controller.abort(), SUMMARY_MS); timer.unref();
    try { process.send!(await executeContextWorker(input, controller.signal), () => process.exit(0)); }
    catch { process.exit(1); }
    finally { clearTimeout(timer); }
  });
}

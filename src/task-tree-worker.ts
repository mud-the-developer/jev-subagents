import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executeWorker } from "./subagent-worker.ts";
import { executeGoalSession } from "./goal-worker.ts";
import { checkGoalContext } from "./goal-run-effects.ts";
import { ordinaryControlBatches } from "./ordinary-protocol.ts";
import { readApprovalPolicy } from "./parallel-read-effects.ts";
import { treePrompts, validTreeWorker, type TreeWorkerInput } from "./task-tree-protocol.ts";
import { sendWorkerProgress, type WorkerProgressObserver } from "./worker-progress.ts";

const fail = (): never => { throw new Error("Task tree worker stopped. No retry, fallback or restored authority."); };
async function checkTreeLease(input: TreeWorkerInput, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted(); if (Date.now() >= input.deadline || (await readApprovalPolicy(input.run.cwd, signal)).version !== input.policyVersion) fail();
  if (input.owner && ordinaryControlBatches(input.context, input.owner.path, input.owner.version!.bytes).length > 1) {
    await checkGoalContext({ body: { context: [input.owner] } }, signal);
    await checkGoalContext({ body: { context: input.context } }, signal);
  } else await checkGoalContext({ body: { context: [...input.context, ...(input.owner ? [input.owner] : [])] } }, signal);
  signal.throwIfAborted(); if (Date.now() >= input.deadline) fail();
}
export async function executeTreeWorker(input: unknown, signal?: AbortSignal, io?: Parameters<typeof executeWorker>[1], progress?: WorkerProgressObserver) {
  if (!validTreeWorker(input) || signal?.aborted || Date.now() >= input.deadline) return fail();
  const owned = structuredClone(input), current = signal ?? new AbortController().signal;
  const admission: NonNullable<Parameters<typeof executeWorker>[5]> = async model => {
    if (model.provider !== owned.run.model.provider || model.id !== owned.run.model.id || model.api !== owned.target.api || model.baseUrl !== owned.target.endpoint) fail();
    await checkTreeLease(owned, current);
  };
  const prompts = treePrompts(owned);
  if (owned.task.mode === "mutation") return executeGoalSession({ run: owned.run, files: owned.files!, agentDirectory: path.dirname(path.dirname(owned.run.agent.file)),
    journalDirectory: path.dirname(path.dirname(owned.run.agent.file)), deadline: owned.deadline, ...prompts }, signal => checkTreeLease(owned, signal), "worker", current, io, "scope", progress, admission);
  function wrap<T extends TSchema, D>(tool: ToolDefinition<T, D>): ToolDefinition {
    return { name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
      async execute(id, args, signal, onUpdate, ctx) {
        if (!Value.Check(tool.parameters, args)) return fail();
        await checkTreeLease(owned, signal ?? current); return tool.execute(id, args, signal, onUpdate, ctx);
      } };
  }
  const factories: Record<string, () => ToolDefinition> = { read: () => wrap(createReadToolDefinition(owned.run.cwd)), grep: () => wrap(createGrepToolDefinition(owned.run.cwd)),
    find: () => wrap(createFindToolDefinition(owned.run.cwd)), ls: () => wrap(createLsToolDefinition(owned.run.cwd)) };
  const tools = owned.run.agent.tools.map(name => factories[name]!());
  // Parent-side freshness checks preserve the worker's observed usage receipt.
  return executeWorker(owned.run, io, current, { ...prompts, tools, beforeModelCall: () => checkTreeLease(owned, current),
    afterTurn(context) { if (context.toolResults.some(result => result.isError) || context.message.content.some(block => block.type === "toolCall" && !owned.run.agent.tools.includes(block.name))) fail(); },
  }, progress, admission);
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }, 2000).unref(); }, { once: true });
  process.once("disconnect", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  let received = false;
  process.on("message", async (input: unknown) => {
    if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel" && Object.keys(input).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; } received = true;
    if (!validTreeWorker(input)) { process.exit(1); return; }
    const timer = setTimeout(() => controller.abort(), Math.max(1, input.deadline - Date.now())); timer.unref();
    try { const reply = await executeTreeWorker(input, controller.signal, undefined, sendWorkerProgress); process.send!(reply, () => process.exit(0)); }
    catch { process.exit(1); } finally { clearTimeout(timer); }
  });
}

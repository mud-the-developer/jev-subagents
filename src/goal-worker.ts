import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executeWorker } from "./subagent-worker.ts";
import type { WorkerProgressObserver } from "./worker-progress.ts";
import type { Run } from "./delegate-machine.ts";
import { executeGoalFileEffect, checkGoalFileScope } from "./goal-file-effects.ts";
import { checkGoalLease, checkFreshReadPair } from "./goal-run-effects.ts";
import { withWindowsGoalReadBatch } from "./windows-goal-files.ts";
import { directoryError } from "./directory-diagnostics.ts";
import { GOAL_RUN_ERROR, GOAL_WORKER_MS, GoalWorkerInputSchema, validGoalGrant, goalWorkerTools, reduceGoalExecution, EMPTY_FILE_REPORT,
  type GoalExecutionState, type GoalExecutionEvent, type GoalWorkerReply, type GoalGrant } from "./goal-run.ts";
import { reduceGoalFiles, type GoalFileRequest, type GoalFileIoEvent, type GoalFileScope } from "./goal-files.ts";

export async function executeGoalWorker(input: unknown, signal?: AbortSignal, io?: Parameters<typeof executeWorker>[1]): Promise<GoalWorkerReply> {
  if (!Value.Check(GoalWorkerInputSchema, input) || !validGoalGrant(input.grant) || Buffer.byteLength(JSON.stringify(input)) > 262_144) {
    return { type: "goal_result", reply: await executeWorker(null, io, signal), files: { ...EMPTY_FILE_REPORT } };
  }
  const { grant, lease } = structuredClone(input);
  const { scope: _scope, ...reply } = await executeGoalSession(grant.body, (signal) => checkGoalLease(grant, lease, signal), "worker", signal, io);
  return reply;
}
// Trusted effect entry: callers validate the grant, operation and live lease before using this shared SDK/file runtime.
export async function executeGoalSession(body: Pick<GoalGrant["body"], "files" | "journalDirectory" | "agentDirectory" | "systemPrompt" | "prompt" | "deadline"> & { readonly run: Run },
  checkLease: (signal: AbortSignal) => Promise<void>, mode: "planner" | "worker", signal?: AbortSignal,
  io?: Parameters<typeof executeWorker>[1], namespace: "goal" | "scope" = "goal", onProgress?: WorkerProgressObserver,
  beforeModelAdmission?: Parameters<typeof executeWorker>[5],
): Promise<GoalWorkerReply & { scope: GoalFileScope }> {
  const grant = { body: structuredClone(body) }, ownAbort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, ownAbort.signal]) : ownAbort.signal;
  const initialized = reduceGoalFiles({ status: "idle" }, { type: "start", scope: grant.body.files });
  let state: GoalExecutionState = { status: "running", files: reduceGoalFiles(initialized.state, { type: "approval", scopeId: grant.body.files.id, approved: true }).state };
  let pending: Promise<GoalFileIoEvent> | undefined;
  let sequence = 0;
  const send = (event: GoalExecutionEvent) => {
    const next = reduceGoalExecution(state, event);
    state = next.state;
    for (const effect of next.effects) if (effect.type === "stop_worker" || effect.type === "abort_file_io") ownAbort.abort();
    return next.effects;
  };
  const onAbort = () => { send({ type: "cancel" }); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const names = mode === "planner" ? [] : goalWorkerTools(grant).map(name => `${namespace}_${name.slice(5)}`);
  const tools: ToolDefinition[] = (["read", "edit", "write"] as const).filter((action) => names.includes(`${namespace}_${action}`)).map((action) => {
    const fields = { fileId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }) };
    const text = Type.String({ maxLength: 32_768 });
    const parameters = Type.Object(action === "read" ? fields : action === "write" ? { ...fields, text }
      : { ...fields, oldText: Type.String({ minLength: 1, maxLength: 32_768 }), newText: text }, { additionalProperties: false });
    return { name: `${namespace}_${action}`, label: `${namespace === "goal" ? "Goal" : "Scope"} ${action}`, description: `Restricted ${action} of an approved existing file ID only. No paths, discovery or new files.`,
      executionMode: "sequential", parameters,
      async execute(_toolCallId, args, toolSignal) {
        const id = `request-${++sequence}`;
        const request = { ...(Value.Check(parameters, args) ? args : { invalid: true }), id, action } as GoalFileRequest;
        const effects = send({ type: "file", event: { type: "request", scopeId: grant.body.files.id, request } });
        const effect = effects.find((item) => item.type === "file_io");
        if (!effect || effect.type !== "file_io") throw new Error(GOAL_RUN_ERROR);
        const fileSignal = toolSignal ? AbortSignal.any([combined, toolSignal]) : combined;
        pending = (async () => {
          try {
            await checkLease(fileSignal);
            return await executeGoalFileEffect(effect, { journalDirectory: grant.body.journalDirectory, agentDirectory: grant.body.agentDirectory }, fileSignal);
          } catch { return { type: "file_failed", scopeId: grant.body.files.id, requestId: id, cancelled: fileSignal.aborted, mayHaveWritten: false }; }
        })();
        const event = await pending;
        pending = undefined;
        const result = send({ type: "file", event }).find((item) => item.type === "file_reply");
        if (!result || result.type !== "file_reply") throw new Error(GOAL_RUN_ERROR);
        return { content: [{ type: "text", text: result.reply.action === "read" ? result.reply.text : JSON.stringify(result.reply) }], details: {} };
      },
    };
  });
  const observeScope = async () => {
    try {
      const scope = "scope" in state.files ? state.files.scope : grant.body.files;
      await checkFreshReadPair(() => checkLease(combined),
        () => checkGoalFileScope(scope, { journalDirectory: grant.body.journalDirectory, agentDirectory: grant.body.agentDirectory }, combined), combined);
      return !combined.aborted;
    } catch { return false; }
  };
  let completed: (GoalWorkerReply & { scope: GoalFileScope }) | undefined;
  const execute = async () => {
    const reply = await executeWorker(grant.body.run, io, combined, { systemPrompt: grant.body.systemPrompt, prompt: grant.body.prompt, tools,
      async beforeModelCall() {
        const effects = send({ type: "admission", current: await observeScope(), now: Date.now(), deadline: grant.body.deadline });
        if (!effects.some((effect) => effect.type === "allow_model")) throw new Error(GOAL_RUN_ERROR);
      },
      afterTurn(context) {
        const valid = context.toolResults.every((result) => !result.isError) && context.message.content.every((block) => block.type !== "toolCall" || names.includes(block.name));
        send({ type: "turn", valid });
        if (!valid) throw new Error(GOAL_RUN_ERROR);
      },
    }, onProgress, beforeModelAdmission);
    // Agent abort is not proof that an async file handler has finished closing its descriptor.
    if (pending) send({ type: "file", event: await pending });
    send({ type: "finish", current: await observeScope(), now: Date.now(), deadline: grant.body.deadline });
    const files = state.files;
    const progress = "scope" in files ? files : "progress" in files ? files.progress : null;
    completed = { type: "goal_result", reply, scope: structuredClone(progress?.scope ?? grant.body.files), files: progress ? { operations: progress.operations, readBytes: progress.readBytes,
      writtenBytes: progress.writtenBytes, changed: progress.changed, uncertain: progress.uncertain,
      finished: state.status === "completed" && files.status === "closed" } : { ...EMPTY_FILE_REPORT } };
    return completed;
  };
  try { return await withWindowsGoalReadBatch(execute, combined); }
  catch (error) {
    if (!completed || directoryError(error)?.cleanupConfirmed !== false) throw error;
    completed.files.uncertain = true; completed.files.finished = false;
    if (completed.reply.report.accounting.status === "reported") completed.reply.report.accounting.complete = false;
    return completed;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    ownAbort.abort();
    if (pending) await pending;
  }
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  // Parent loss must not remove the child's own stop/cleanup bound.
  controller.signal.addEventListener("abort", () => { setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
  }, 2_000).unref(); }, { once: true });
  process.once("SIGTERM", () => controller.abort());
  process.once("disconnect", () => controller.abort());
  let received = false;
  process.on("message", async (input) => {
    if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel" && Object.keys(input).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; } received = true;
    const deadline = Value.Check(GoalWorkerInputSchema, input) ? input.grant.body.deadline : Date.now();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(GOAL_WORKER_MS, deadline - Date.now())));
    timer.unref();
    try {
      const reply = await executeGoalWorker(input, controller.signal);
      process.send!(reply, () => process.exit(0));
    } catch { process.exit(1); }
    finally { clearTimeout(timer); }
  });
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { progressEmitter, sendWorkerProgress, type WorkerProgressObserver } from "./worker-progress.ts";
import { MAX_OUTPUT, RunSchema, RunStatsSchema, WorkerReplySchema, WORKER_ERROR, MODEL_CALL_LIMIT_ERROR,
  reduceWorker, type WorkerState, type WorkerReply, type WorkerReport } from "./delegate-machine.ts";
import { codexThinkingLevels } from "./planning.ts";
import { workerPrompt } from "./assessment.ts";
import { englishModelData, englishProse } from "./internal-language.ts";
import { summarizeWorkerRound, workerRoundCoverage, MAX_RECORDED_WORKER_ROUNDS, type WorkerRound, type WorkerRoundCoverage } from "./worker-rounds.ts";

// SDK seams keep offline checks independent of credentials and real model calls.
const sdk = { createModelRuntime: ModelRuntime.create, createAgentSession };

// Diagnostic hints only: never return the provider text or use these to retry/change a plan.
export function diagnose(error: unknown, httpStatus: number | null, aborted: boolean): NonNullable<WorkerReport["diagnostic"]> {
  const message = (error instanceof Error ? error.message : typeof error === "string" ? error : "").slice(0, 2_048);
  let category: NonNullable<WorkerReport["diagnostic"]>["category"] = "unknown";
  if (aborted) category = "cancelled";
  else if (httpStatus === 401 || httpStatus === 403) category = "authentication";
  else if (httpStatus === 429) category = "rate_limited";
  else if (httpStatus !== null && httpStatus >= 500) category = "provider_error";
  else if (/\b(model_not_found|unsupported_model)\b|\bmodel\b.{0,100}\b(not supported|not available|does not exist)\b/i.test(message)) category = "model_unavailable";
  else if (/\bunsupported[_ ](parameter|value)\b|\b(reasoning|thinking)\b.{0,100}\b(not supported|unsupported|invalid)\b/i.test(message)) category = "unsupported_setting";
  else if (httpStatus !== null && httpStatus >= 400) category = "request_rejected";
  else if (/\b(fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|network error|connection error|timed out)\b/i.test(message)) category = "transport";
  return { category, httpStatus };
}

export type RestrictedWorkerRuntime = {
  readonly systemPrompt: string; readonly prompt: string; readonly tools: ToolDefinition[];
  beforeModelCall(): Promise<void>;
  afterTurn(context: Parameters<NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]["agent"]["shouldStopAfterTurn"]>>[0]): void;
};
export async function executeWorker(input: unknown, io = sdk, signal?: AbortSignal, restricted?: RestrictedWorkerRuntime,
  onProgress?: WorkerProgressObserver, beforeModelAdmission?: (model: NonNullable<Awaited<ReturnType<typeof createAgentSession>>["session"]["model"]>) => Promise<void>): Promise<WorkerReply> {
  const started = performance.now(), emit = progressEmitter(onProgress);
  let toolCalls = 0, unsubscribe: (() => void) | undefined;
  let promptStarted: number | undefined;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let restoreHooks: (() => void) | undefined;
  let thinking: WorkerReport["thinking"];
  let worker: WorkerState | undefined;
  let httpStatus: number | null = null;
  let failureStage: NonNullable<NonNullable<WorkerReport["diagnostic"]>["stage"]> = "input";
  const report = (complete = false): WorkerReport => {
    const now = performance.now();
    let accounting: WorkerReport["accounting"] = { status: promptStarted === undefined ? "not_started" : "unknown" };
    let rounds: WorkerRound[] | undefined, roundsCoverage: WorkerRoundCoverage = "unknown";
    if (session && promptStarted !== undefined) {
      try {
        const replies = session.messages.filter((message) => message.role === "assistant");
        rounds = replies.slice(0, MAX_RECORDED_WORKER_ROUNDS).flatMap((message, index) => {
          const names = message.content.filter(block => block.type === "toolCall").map(block => block.type === "toolCall" && typeof block.name === "string" ? block.name : "other");
          const round = summarizeWorkerRound(index + 1, message.stopReason, names);
          return round ? [round] : [];
        });
        roundsCoverage = workerRoundCoverage(worker?.modelCalls ?? null, replies.length, rounds.length);
        const stats = session.getSessionStats();
        const normalized = { turns: stats.assistantMessages, usage: {
          input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite,
        }, cost: stats.cost };
        if (Value.Check(RunStatsSchema, normalized)) {
          accounting = { status: "reported", stats: normalized, complete: false };
          // SDK aggregates default missing usage to zero. Check every response, not just the totals.
          accounting.complete = complete && replies.length > 0 && replies.length === normalized.turns && replies.every((message) => {
            const u = message.usage;
            const observed = { turns: 1, usage: { input: u?.input, output: u?.output, cacheRead: u?.cacheRead, cacheWrite: u?.cacheWrite }, cost: u?.cost?.total };
            return ["stop", "toolUse"].includes(message.stopReason) && Value.Check(RunStatsSchema, observed)
              && Object.values(observed.usage).some((tokens) => tokens > 0);
          });
        }
      } catch { /* Missing usage is unknown, never a zero-cost success. */ }
    }
    return { startupMs: (promptStarted ?? now) - started, executionMs: promptStarted === undefined ? null : now - promptStarted, accounting,
      modelCalls: worker?.modelCalls ?? 0, ...(rounds ? { rounds } : {}), roundsCoverage, ...(thinking ? { thinking } : {}) };
  };
  const failed = (error?: unknown): WorkerReply => {
    if (worker) worker = reduceWorker(worker, { type: signal?.aborted ? "cancel" : "failed" }).state;
    if (!signal?.aborted && worker?.status === "failed" && worker.reason === "model_call_limit") {
      return { type: "failed", error: MODEL_CALL_LIMIT_ERROR, report: { ...report(), diagnostic: { category: "unknown", httpStatus, stage: failureStage } } };
    }
    const failureReport = { ...report(), diagnostic: { ...diagnose(error, httpStatus, signal?.aborted === true), stage: failureStage } };
    return signal?.aborted ? { type: "cancel", report: failureReport } : { type: "failed", error: WORKER_ERROR, report: failureReport };
  };
  const abort = () => { void session?.abort().catch(() => {}); };
  if (signal?.aborted || !Value.Check(RunSchema, input) || input.solPi) return failed();
  if (input.model.provider !== input.agent.model.provider || input.model.id !== input.agent.model.id) return failed();
  if (!englishModelData({ task: input.task, criteria: input.acceptanceCriteria,
    description: input.agent.description, systemPrompt: input.agent.systemPrompt,
    restrictedPrompt: restricted?.prompt, restrictedSystemPrompt: restricted?.systemPrompt })) return failed();
  worker = { status: "running", modelCalls: 0, maxModelCalls: input.maxModelCalls };
  thinking = { requested: input.agent.thinking ?? "off", applied: null };
  const agentDir = path.dirname(path.dirname(input.agent.file));
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false },
    enableAnalytics: false, enableInstallTelemetry: false, packages: [],
  });
  try {
    failureStage = "model_loading";
    const modelRuntime = await io.createModelRuntime({
      authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const model = modelRuntime.getModel(input.model.provider, input.model.id);
    if (!model) return failed(); // Never silently choose a different/paid fallback model.
    if (input.agent.thinking && !codexThinkingLevels(model).includes(input.agent.thinking)) return failed();
    failureStage = "session_setup";
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      noContextFiles: restricted !== undefined,
      systemPromptOverride: () => restricted?.systemPrompt,
      appendSystemPromptOverride: () => restricted ? [] : [input.agent.systemPrompt],
    });
    await resourceLoader.reload();
    signal?.throwIfAborted();
    const created = await io.createAgentSession({
      cwd: input.cwd, agentDir, modelRuntime, model, resourceLoader, settingsManager,
      tools: restricted ? restricted.tools.map((tool) => tool.name) : [...input.agent.tools],
      ...(restricted ? { customTools: restricted.tools, ...(restricted.tools.length === 0 ? { noTools: "all" as const } : {}) } : {}),
      thinkingLevel: input.agent.thinking ?? "off", sessionManager: SessionManager.inMemory(input.cwd),
    });
    session = created.session;
    if (typeof session.subscribe === "function") unsubscribe = session.subscribe(event => {
      if (event.type === "tool_execution_start") { toolCalls++; emit("tool_start", worker?.modelCalls ?? 0, toolCalls, event.toolName); }
      else if (event.type === "tool_execution_end") emit("tool_end", worker?.modelCalls ?? 0, toolCalls, event.toolName);
    });
    thinking = { requested: input.agent.thinking ?? "off", applied: session.thinkingLevel ?? null };
    if ((input.agent.thinking || restricted) && session.thinkingLevel !== (input.agent.thinking ?? "off")) return failed();
    if (restricted && session.systemPrompt !== `${restricted.systemPrompt}\nCurrent working directory: ${input.cwd.replace(/\\/g, "/")}\n`) return failed();
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    if (created.modelFallbackMessage || session.model?.provider !== input.model.provider || session.model.id !== input.model.id) return failed();
    const stopAfterTurn = session.agent.shouldStopAfterTurn;
    session.agent.shouldStopAfterTurn = async (context, turnSignal) => {
      restricted?.afterTurn(context);
      const next = reduceWorker(worker!, signal?.aborted ? { type: "cancel" } : {
        type: "turn_end", stopReason: context.message.stopReason,
        hasToolCalls: context.message.content.some((block) => block.type === "toolCall"),
      });
      worker = next.state;
      emit("turn_end", worker.modelCalls, toolCalls);
      const stopped = await stopAfterTurn?.(context, turnSignal);
      return next.effects.some((effect) => effect.type === "stop") || stopped === true;
    };
    const stream = session.agent.streamFunction;
    const ownedAgent = session.agent;
    restoreHooks = () => {
      ownedAgent.streamFunction = stream;
      if (stopAfterTurn) ownedAgent.shouldStopAfterTurn = stopAfterTurn;
      else delete ownedAgent.shouldStopAfterTurn;
    };
    const recordStatus = (status: number) => {
      if (Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
    };
    session.agent.streamFunction = async (model, context, options) => {
      failureStage = "model_request";
      signal?.throwIfAborted();
      await beforeModelAdmission?.(model);
      signal?.throwIfAborted();
      worker = reduceWorker(worker!, { type: "model_call" }).state;
      if (worker.status !== "running") throw new Error(MODEL_CALL_LIMIT_ERROR);
      await restricted?.beforeModelCall();
      signal?.throwIfAborted();
      emit("model_request", worker.modelCalls, toolCalls);
      httpStatus = null; // Never attach an earlier request's status to a later transport failure.
      const requestFetch = options?.fetch ?? globalThis.fetch;
      return stream(model, context, { ...options,
        // Some SDK providers throw on non-2xx before calling onResponse.
        fetch: async (...args) => {
          const response = await requestFetch(...args);
          recordStatus(response.status);
          return response; // Do not consume bodies, change transport, or add requests/retries.
        },
        onResponse: async (response, responseModel) => {
          recordStatus(response.status);
          await options?.onResponse?.(response, responseModel);
        },
      });
    };
    promptStarted = performance.now();
    await session.prompt(restricted?.prompt ?? workerPrompt(input));
    signal?.throwIfAborted();
    failureStage = "model_response";
    const last = session.messages.findLast((message) => message.role === "assistant");
    if (!last || last.role !== "assistant" || last.stopReason !== "stop") return failed(last?.role === "assistant" ? last.errorMessage : undefined);
    worker = reduceWorker(worker, { type: "turn_end", stopReason: last.stopReason,
      hasToolCalls: last.content.some((block) => block.type === "toolCall") }).state;
    if (worker.status !== "succeeded") return failed();
    const output = last.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    failureStage = "internal_report";
    if (!englishProse(output)) return failed(); // Preserve accounting; never translate or retry a non-English internal report.
    failureStage = "accounting";
    const usage = report(true);
    if (usage.accounting.status !== "reported") return failed();
    const reply = { type: "completed", report: usage, result: {
      ...usage.accounting.stats, text: output.slice(0, MAX_OUTPUT), truncated: output.length > MAX_OUTPUT,
    } };
    return Value.Check(WorkerReplySchema, reply) ? reply : failed();
  } catch (error) {
    return failed(error);
  } finally {
    signal?.removeEventListener("abort", abort);
    try { unsubscribe?.(); session?.dispose(); restoreHooks?.(); } catch { failureStage = "cleanup"; return failed(); }
  }
}

if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("disconnect", () => controller.abort());
  process.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && Object.keys(message).length === 1 &&
      "type" in message && message.type === "jev_worker_cancel") controller.abort();
  });
  process.once("message", async (input) => {
    const reply = await executeWorker(input, sdk, controller.signal, undefined, sendWorkerProgress);
    process.send!(reply, () => process.exit(0));
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { RunSchema, WorkerReplySchema, WORKER_ERROR, MAX_OUTPUT, type WorkerReply, type WorkerReport, type Run } from "./delegate-machine.ts";
import { codexThinkingLevels } from "./planning.ts";
import { snapshotGoalText } from "./goal-file-effects.ts";
import { goalLockText } from "./goal-run.ts";
import { checkSolPi, inspectSolStorage, solOwner, solSource } from "./sol-pi-effects.ts";
import { SOL_ERROR, SOL_RECORD, SOL_INPUT_BYTES, SOL_OUTPUT_TOKENS, initialSolState, reduceSol, solTools,
  type SolState, type SolEvent, type SolCallKind, type SolUsage } from "./sol-pi.ts";

const sdk = { createModelRuntime: ModelRuntime.create, createAgentSession };
type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Model = Parameters<ModelRuntime["streamSimple"]>[0];
type Packet = Parameters<ModelRuntime["streamSimple"]>[1];
type Options = NonNullable<Parameters<ModelRuntime["streamSimple"]>[2]>;
function fail(): never { throw new Error(SOL_ERROR); }
export async function checkSolLease(run: Run, signal?: AbortSignal): Promise<void> {
  await checkSolPi(run, signal);
  for (const storage of [false, true]) {
    const owner = solOwner(run, storage), snapshot = await snapshotGoalText(path.join(owner.body.run.cwd, ".jev-goal.lock"), signal);
    if (!snapshot || snapshot.text !== goalLockText(owner)) fail();
  }
  const record = await snapshotGoalText(path.join(run.solPi!.options.storageDirectory, SOL_RECORD), signal);
  if (!record || record.text !== JSON.stringify({ version: 1, kind: "admitted", operationId: run.solPi!.operationId,
    runDigest: run.solPi!.runDigest, sourceDigest: run.solPi!.sourceDigest }) + "\n") fail();
  await solSource(path.join(run.solPi!.options.storageDirectory, "source"), signal);
}

/** Dedicated process only: owns its private umask/runtime; requires an acknowledged, current Sol lease. */
export async function executeSolPiWorker(input: unknown, signal?: AbortSignal, io = sdk): Promise<WorkerReply> {
  const started = performance.now(), controller = new AbortController();
  const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const origin = new AsyncLocalStorage<SolCallKind>();
  const settlements = new Set<Promise<unknown>>();
  let state: SolState | undefined, session: Session | undefined, promptStarted: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, cleanupConfirmed = false, completed = false, output = "";
  let failureStage: NonNullable<NonNullable<WorkerReport["diagnostic"]>["stage"]> = "input";
  let unsubscribe = () => {};
  const send = (event: SolEvent) => {
    if (!state) return [];
    const next = reduceSol(state, event); state = next.state;
    if (next.effects.some(effect => effect.type === "stop")) {
      controller.abort(); session?.abortCompaction(); void session?.abort().catch(() => {});
    }
    return next.effects;
  };
  const cancelled = () => { send({ type: "cancel" }); };
  signal?.addEventListener("abort", cancelled, { once: true });
  let run: Run | undefined;
  try {
    if (!Value.Check(RunSchema, input) || !input.solPi || input.maxModelCalls === null || signal?.aborted) fail();
    process.umask(0o077);
    run = structuredClone(input);
    const grant = run.solPi!, agentDir = path.dirname(path.dirname(run.agent.file));
    const tools = solTools(run.agent.tools, grant.options), now = Date.now();
    state = initialSolState({ maxCalls: input.maxModelCalls, maxReducerCalls: grant.options.maxReducerCalls,
      maxSummaryCalls: grant.options.maxSummaryCalls, maxCompactions: grant.options.maxCompactions, deadline: now + 120_000, tools }, now);
    timer = setTimeout(() => send({ type: "failed" }), 120_000);
    const inspect = async () => {
      const storage = await inspectSolStorage(grant.options.storageDirectory);
      send({ type: "storage", ...storage, now: Date.now() });
      if (state?.status !== "running" || abortSignal.aborted) fail();
    };
    const current = async () => {
      abortSignal.throwIfAborted(); await checkSolLease(run!, abortSignal); await inspect();
      if (session && (!isDeepStrictEqual([...session.getActiveToolNames()].sort(), [...tools].sort()) ||
          session.model?.provider !== run!.model.provider || session.model.id !== run!.model.id ||
          session.thinkingLevel !== run!.agent.thinking || session.autoCompactionEnabled || session.autoRetryEnabled)) fail();
    };
    await current(); failureStage = "model_loading";
    const runtime = await io.createModelRuntime({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false, signal: abortSignal });
    const model = runtime.getModel(run.model.provider, run.model.id);
    if (!model || !run.agent.thinking) fail();
    const approvedThinking = codexThinkingLevels(model).find(level => level === run!.agent.thinking);
    if (!approvedThinking) fail();
    const nativeStream = runtime.streamSimple.bind(runtime);
    const startCall = (kind: SolCallKind, selected: Model, packet: Packet, options?: Options) => {
      // Upstream deliberately aborts a turn at a compaction boundary. Do not spend
      // another SDK call on the core loop's already-aborted next iteration.
      options?.signal?.throwIfAborted();
      if (abortSignal.aborted || state?.status !== "running" || selected.provider !== run!.model.provider || selected.id !== run!.model.id ||
          Buffer.byteLength(JSON.stringify(packet)) > SOL_INPUT_BYTES || kind === "reducer" && !grant.options.evidencePreservingReducer ||
          kind === "summary" && !grant.options.onlineContextCompact) fail();
      const admitted = send({ type: "call", kind, now: Date.now() }).find(effect => effect.type === "admit");
      if (!admitted || admitted.type !== "admit") fail();
      const remaining = Math.max(1, Math.min(30_000, state!.budget.deadline - Date.now()));
      const callSignal = AbortSignal.any([abortSignal, AbortSignal.timeout(remaining), ...(options?.signal ? [options.signal] : [])]);
      const stream = nativeStream(selected, packet, { ...options, reasoning: approvedThinking,
        maxTokens: Math.min(options?.maxTokens ?? SOL_OUTPUT_TOKENS, SOL_OUTPUT_TOKENS), maxRetries: 0, maxRetryDelayMs: 0, transport: "sse",
        timeoutMs: remaining, signal: callSignal });
      const push = stream.push.bind(stream);
      stream.push = event => {
        if ("partial" in event && Buffer.byteLength(JSON.stringify(event.partial)) > 65_536) send({ type: "failed" });
        // Neither native persistence nor the upstream reducer journal receives provider exception text.
        if (event.type === "error") push({ ...event, error: { ...event.error, content: [], errorMessage: WORKER_ERROR } });
        else push(event);
      };
      const settled = stream.result().then(message => {
        const usage = message.usage;
        const observation: SolUsage | null = usage ? { input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite, cost: usage.cost?.total } : null;
        send({ type: "settled", id: admitted.id, usage: observation,
          ok: (kind === "worker" ? ["stop", "toolUse"].includes(message.stopReason)
            : message.stopReason === "stop" && !message.content.some(block => block.type === "toolCall") &&
              message.content.some(block => block.type === "text" && block.text.trim().length > 0)) &&
            message.provider === selected.provider && message.model === selected.id && usage?.output <= SOL_OUTPUT_TOKENS &&
            Buffer.byteLength(JSON.stringify(message)) <= 65_536,
          now: Date.now() });
        return message.errorMessage === undefined ? message : { ...message, content: [], errorMessage: WORKER_ERROR };
      }, () => {
        send({ type: "settled", id: admitted.id, usage: null, ok: false, now: Date.now() }); return fail();
      });
      settlements.add(settled); void settled.then(() => settlements.delete(settled), () => settlements.delete(settled));
      stream.result = () => settled;
      return stream;
    };
    runtime.streamSimple = (selected, packet, options) => startCall(origin.getStore() ?? "worker", selected, packet, options);
    runtime.stream = () => fail(); // The pinned reducer uses complete(); no unclassified raw/deferred transport.
    runtime.complete = (async (selected, packet, options) => { await current(); return startCall("reducer", selected, packet, options as Options).result(); }) as ModelRuntime["complete"];
    runtime.completeSimple = async (selected, packet, options) => { await current(); return startCall("summary", selected, packet, options).result(); };
    runtime.streamDeferred = () => fail(); runtime.fetchDeferred = async () => fail(); runtime.cancelDeferred = async () => fail();

    failureStage = "session_setup";
    const guard: ExtensionFactory = pi => {
      pi.on("tool_call", async event => {
        try {
          await current(); send({ type: "tool", name: event.toolName, now: Date.now() });
          if (state?.status !== "running") return { block: true, reason: SOL_ERROR };
        } catch { send({ type: "failed" }); return { block: true, reason: SOL_ERROR }; }
        return undefined;
      });
      pi.on("tool_result", async event => {
        // New session: also stop on pre-candidate fallbacks without a toolCallId
        // (oversize/likely-secret), rather than forwarding the original output.
        const entries = session!.sessionManager.getBranch();
        if (entries.some(entry => entry.type === "custom" && entry.customType === "sol-pi-evidence-preserving-reducer-v1" &&
            typeof entry.data === "object" && entry.data !== null && "kind" in entry.data &&
            (entry.data.kind === "fallback" || entry.data.kind === "applied" && "uncertain" in entry.data && entry.data.uncertain === true))) {
          send({ type: "failed" });
          return { content: [{ type: "text", text: SOL_ERROR }], details: {}, isError: true };
        }
        await inspect();
        if (event.isError) send({ type: "failed" });
        return undefined;
      });
      pi.on("context", async () => { await current(); });
      pi.on("session_before_switch", () => ({ cancel: true }));
      pi.on("session_before_fork", () => ({ cancel: true }));
      pi.on("session_before_tree", () => ({ cancel: true }));
    };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 20_000 },
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, packages: [], enableAnalytics: false, enableInstallTelemetry: false });
    const loader = new DefaultResourceLoader({ cwd: run.cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.join(grant.options.storageDirectory, "extension.ts")],
      extensionFactories: [guard], systemPromptOverride: () => grant.systemPrompt, appendSystemPromptOverride: () => [] });
    failureStage = "extension_loading";
    await loader.reload();
    if (loader.getExtensions().errors.length || loader.getExtensions().extensions.length !== 2) fail();
    failureStage = "session_setup";
    const sm = SessionManager.create(run.cwd, path.join(grant.options.storageDirectory, "sessions"));
    const created = await io.createAgentSession({ cwd: run.cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: run.agent.thinking!,
      settingsManager, resourceLoader: loader, tools, sessionManager: sm });
    session = created.session;
    if (created.modelFallbackMessage || session.thinkingLevel !== run.agent.thinking || session.sessionManager !== sm || session.messages.length) fail();
    const nativeCompact = session.compact.bind(session);
    session.compact = async instructions => {
      await current(); send({ type: "compact", now: Date.now() }); if (state?.status !== "running") return fail();
      try { return await origin.run("summary", () => nativeCompact(instructions)); }
      catch { send({ type: "failed" }); return fail(); }
    };
    const nativeSend = session.sendCustomMessage.bind(session);
    session.sendCustomMessage = async (message, options) => {
      if (options?.triggerTurn) {
        send({ type: "continue", now: Date.now() }); if (state?.status !== "running") return fail();
      }
      return origin.run("worker", () => nativeSend(message, options));
    };
    const agentStream = session.agent.streamFunction;
    session.agent.streamFunction = async (...args) => { await current(); return agentStream(...args); };
    unsubscribe = session.subscribe(event => {
      if (event.type === "auto_retry_start" || event.type === "compaction_start" && origin.getStore() !== "summary" ||
          event.type === "compaction_end" && event.errorMessage !== undefined) send({ type: "failed" });
    });
    await session.bindExtensions({ onError: () => { send({ type: "failed" }); } });
    await current();
    if (session.systemPrompt !== `${grant.systemPrompt}\nCurrent working directory: ${run.cwd.replace(/\\/g, "/")}\n`) fail();
    promptStarted = performance.now(); failureStage = "model_request";
    await session.prompt(grant.prompt, { expandPromptTemplates: false });
    await current();
    const last = session.messages.findLast(message => message.role === "assistant");
    completed = last?.role === "assistant" && last.stopReason === "stop" && !last.content.some(block => block.type === "toolCall");
    if (last?.role === "assistant") output = last.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  } catch { send({ type: signal?.aborted ? "cancel" : "failed" }); }
  finally {
    clearTimeout(timer); signal?.removeEventListener("abort", cancelled);
    // This invocation owns the runtime. Never restore unmetered transports for
    // late upstream callbacks, even after a successful reply.
    controller.abort();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = (async () => {
        session?.abortCompaction(); if (session && !session.isIdle) await session.abort();
        await Promise.allSettled([...settlements]);
      })();
      await Promise.race([drained, new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error(SOL_ERROR)), 1500); })]);
      unsubscribe(); session?.dispose(); cleanupConfirmed = true;
    } catch { send({ type: "failed" }); }
    finally { clearTimeout(cleanupTimer); }
  }
  if (state) send({ type: "finish", completed, cleanupConfirmed, now: Date.now() });
  const final = state as SolState | undefined, now = performance.now(), total = final ? final.calls.worker + final.calls.reducer + final.calls.summary : 0;
  const success = final?.status === "done" && final.result === "succeeded";
  const usage = final?.usage;
  const stats = { turns: final?.settled.length ?? 0, usage: { input: usage?.input ?? 0, output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0 }, cost: usage?.cost ?? 0 };
  const report: WorkerReport = { startupMs: (promptStarted ?? now) - started, executionMs: promptStarted === undefined ? null : now - promptStarted,
    ...(!success ? { diagnostic: { category: "unknown" as const, httpStatus: null, stage: failureStage } } : {}),
    modelCalls: total, accounting: !total ? { status: "not_started" } : { status: "reported", stats, complete: success && final?.known === true },
    ...(run?.agent.thinking ? { thinking: { requested: run.agent.thinking, applied: session?.thinkingLevel ?? null } } : {}),
    ...(run?.solPi ? { solPi: { sourceDigest: run.solPi.sourceDigest, storageDirectory: run.solPi.options.storageDirectory,
      calls: final?.calls ?? { worker: 0, reducer: 0, summary: 0 }, toolCalls: final?.toolCalls ?? 0, compactions: final?.compactions ?? 0,
      continuations: final?.continuations ?? 0, storageBytes: final?.storageBytes ?? null, cleanupConfirmed, lockRetained: true, sessionDurability: "not_asserted" as const } } : {}) };
  const reply: WorkerReply = success ? { type: "completed", report, result: { ...stats, text: output.slice(0, MAX_OUTPUT), truncated: output.length > MAX_OUTPUT } }
    : signal?.aborted ? { type: "cancel", report } : { type: "failed", report, error: WORKER_ERROR };
  return Value.Check(WorkerReplySchema, reply) ? reply : { type: "failed", error: WORKER_ERROR,
    report: { startupMs: null, executionMs: null, modelCalls: total, accounting: { status: "unknown" } } };
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort()); process.once("disconnect", () => controller.abort());
  process.once("message", async input => {
    const reply = await executeSolPiWorker(input, controller.signal);
    process.send!(reply, () => process.exit(0));
  });
}

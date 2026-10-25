// Benchmark-only direct SDK session. No JEV execution/orchestration functions.
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createControlTools } from "./scope-tools.mjs";
const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export function accountingProjection(session, calls, completed) {
  try {
    const messages = session.messages.filter(message => message.role === "assistant"), stats = session.getSessionStats();
    const complete = completed && calls > 0 && calls === messages.length && calls === stats.assistantMessages && finite(stats.cost)
      && ["input", "output", "cacheRead", "cacheWrite"].every(key => finite(stats.tokens?.[key]))
      && messages.every(message => ["stop", "toolUse"].includes(message.stopReason) && message.usage
        && ["input", "output", "cacheRead", "cacheWrite"].every(key => finite(message.usage[key]))
        && ["input", "output", "cacheRead", "cacheWrite"].some(key => message.usage[key] > 0) && finite(message.usage.cost?.total));
    return { status: complete ? "reported_complete" : calls === 0 ? "not_started" : "unknown", observedUsdEstimate: finite(stats.cost) ? stats.cost : null,
      assistantMessages: messages.length, complete };
  } catch { return { status: calls === 0 ? "not_started" : "unknown", observedUsdEstimate: null, complete: false }; }
}
export async function runDirectControl(input, signal, injectedSdk) {
  assert.equal(input.type, "direct_sdk_control"); assert.ok(input.deadline > Date.now());
  const sdk = injectedSdk ?? await import(pathToFileURL(path.join(input.runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  assert.equal(sdk.VERSION, "0.85.1");
  const started = performance.now(); let phase = "file_scope", calls = 0, toolCalls = 0, session, unsubscribe, tools, promptStarted;
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  let result, fileReport = { ioFinished: false }, disposed = false;
  const abort = () => { void session?.abort().catch(() => {}); };
  combined.addEventListener("abort", abort, { once: true });
  try {
    tools = await createControlTools({ ...input, signal: combined });
    result = await tools.withinBatch(async () => {
      await tools.fresh(); phase = "model_loading";
      const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
        compaction: { enabled: false }, enableAnalytics: false, enableInstallTelemetry: false, packages: [] });
      const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(input.agentDirectory, "auth.json"), modelsPath: path.join(input.agentDirectory, "models.json"), allowModelNetwork: false, signal: combined });
      combined.throwIfAborted();
      const model = modelRuntime.getModel(input.model.provider, input.model.id); assert.ok(model);
      phase = "session_setup";
      const resourceLoader = new sdk.DefaultResourceLoader({ cwd: input.cwd, agentDir: input.agentDirectory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPromptOverride: () => input.systemPrompt, appendSystemPromptOverride: () => [] });
      await resourceLoader.reload(); combined.throwIfAborted();
      const created = await sdk.createAgentSession({ cwd: input.cwd, agentDir: input.agentDirectory, modelRuntime, model, resourceLoader, settingsManager,
        tools: tools.tools.map(tool => tool.name), customTools: tools.tools, thinkingLevel: input.thinking, sessionManager: sdk.SessionManager.inMemory(input.cwd) });
      session = created.session;
      assert.ok(!created.modelFallbackMessage); assert.equal(session.model?.provider, input.model.provider); assert.equal(session.model?.id, input.model.id);
      assert.equal(session.thinkingLevel, input.thinking);
      assert.equal(session.systemPrompt, `${input.systemPrompt}\nCurrent working directory: ${input.cwd.replace(/\\/g, "/")}\n`);
      assert.deepEqual([...session.getActiveToolNames()].sort(), tools.tools.map(tool => tool.name).sort());
      if (input.preflightOnly === true) {
        await tools.fresh();
        return { status: "offline_probe", checks: ["pinned_sdk_session", "exact_model_thinking_system", "file_tools_only", "no_prompt_started"],
          accounting: { status: "not_started", complete: false, observedUsdEstimate: null } };
      }
      unsubscribe = session.subscribe(event => { if (event.type === "tool_execution_start") toolCalls++; });
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = async (selected, context, options) => {
        combined.throwIfAborted(); assert.equal(selected.provider, input.model.provider); assert.equal(selected.id, input.model.id);
        await tools.fresh(); combined.throwIfAborted(); phase = "model_request"; calls++;
        return stream(selected, context, options);
      };
      const stop = session.agent.shouldStopAfterTurn;
      session.agent.shouldStopAfterTurn = async (context, turnSignal) => {
        if (!context.toolResults.every(reply => !reply.isError) || !["stop", "toolUse"].includes(context.message.stopReason)
          || !context.message.content.every(block => block.type !== "toolCall" || tools.tools.some(tool => tool.name === block.name))) {
          controller.abort(); throw new Error("Direct control turn stopped.");
        }
        return await stop?.(context, turnSignal);
      };
      combined.throwIfAborted(); promptStarted = performance.now();
      await session.prompt(input.prompt, { expandPromptTemplates: false }); combined.throwIfAborted(); await tools.fresh();
      const messages = session.messages.filter(message => message.role === "assistant"), last = messages.at(-1);
      assert.equal(last?.stopReason, "stop"); assert.ok(last.content.every(block => block.type !== "toolCall"));
      const output = last.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      assert.ok(Buffer.byteLength(output) <= 65536);
      const accounting = accountingProjection(session, calls, true); assert.equal(accounting.status, "reported_complete");
      return { status: "completed_unverified", output, accounting };
    });
  } catch (error) {
    result = { status: combined.aborted ? "cancelled" : "failed", failureStage: phase,
      httpStatus: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
      accounting: session ? accountingProjection(session, calls, false) : { status: "not_started", complete: false, observedUsdEstimate: null } };
  } finally {
    try { if (session) { await session.abort(); unsubscribe?.(); session.dispose(); } disposed = true; } catch { disposed = false; }
    try { if (tools) fileReport = await tools.close(); } catch { fileReport = { ioFinished: false }; }
    combined.removeEventListener("abort", abort);
  }
  return { type: "direct_sdk_result", id: input.id, ...result, sdkCalls: calls, sdkCallCap: null, toolCalls, elapsedMs: performance.now() - started,
    startupMs: (promptStarted ?? performance.now()) - started, generationMs: promptStarted === undefined ? null : performance.now() - promptStarted,
    disposed, files: fileReport, systemPromptSha256: createHash("sha256").update(input.systemPrompt).digest("hex"),
    sdkDirect: true, jevExecutionCalls: 0, injectedOfflineSdk: injectedSdk !== undefined };
}
if (process.send && process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(); let received = false, timer;
  process.once("disconnect", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  process.on("message", async message => {
    if (message?.type === "direct_control_cancel" && Object.keys(message).length === 1) { controller.abort(); return; }
    if (received || controller.signal.aborted) { controller.abort(); return; } received = true;
    try {
      assert.ok(message && message.type === "direct_sdk_control" && Number.isSafeInteger(message.deadline));
      assert.ok(Buffer.byteLength(JSON.stringify(message)) <= 262144);
      timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(300000, message.deadline - Date.now())));
      const reply = await runDirectControl(message, controller.signal);
      process.send(reply, error => process.exit(error ? 1 : 0));
    } catch { process.send?.({ type: "direct_sdk_start_failed", sdkCalls: 0 }, () => process.exit(1)); }
    finally { clearTimeout(timer); }
  });
}

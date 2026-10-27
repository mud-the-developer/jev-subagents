import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { MAX_OUTPUT, WORKER_ERROR, MODEL_CALL_LIMIT_ERROR, estimateCost, initialState, reduceWorker,
  type Event, type Run, type WorkerEvent, type WorkerState } from "../src/delegate-machine.ts";
import { diagnose, executeWorker } from "../src/subagent-worker.ts";
import { workerPrompt } from "../src/assessment.ts";
import { runSubagent } from "../src/delegate-effects.ts";

type SDK = NonNullable<Parameters<typeof executeWorker>[1]>;
function assertFailed(reply: Event) {
  assert.ok(reply.type === "failed");
  assert.equal(reply.error, WORKER_ERROR);
  assert.ok(reply.report);
  assert.ok(!JSON.stringify(reply).includes("offline-secret"));
  return reply;
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-worker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live HTTP is forbidden."); });
  const cwd = path.join(dir, "workspace");
  const agentDir = path.join(dir, "config");
  await mkdir(cwd);
  await mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await writeFile(path.join(cwd, "AGENTS.md"), "Use a pure reducer and isolate effects.\n");
  await writeFile(path.join(agentDir, "extensions", "forbidden.ts"), 'throw new Error("Extensions must not load");');
  await writeFile(path.join(agentDir, "APPEND_SYSTEM.md"), "UNAPPROVED GLOBAL PROMPT");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultModel: "wrong", retry: { enabled: true } }));
  const model = { provider: "test-provider", id: "test-model" };
  const run: Run = {
    cwd, task: "Fix one typo.", model, maxModelCalls: 6,
    agent: { name: "worker", model, description: "Edits code.", systemPrompt: "Only fix the explicit task.", tools: ["read", "edit"], file: path.join(agentDir, "agents", "worker.md") },
  };
  const session = {
    model,
    agent: { streamFunction: async (_model: unknown, _context: unknown, _options?: unknown) => {} },
    prompt: t.mock.fn(async (_task: string) => {}),
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.007 } } }],
    getSessionStats: () => ({ assistantMessages: 1, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.007 }),
    dispose: t.mock.fn(() => {}),
    abort: t.mock.fn(async () => {}),
  };
  session.prompt = t.mock.fn(async (_task: string) => { await session.agent.streamFunction(run.model, {}); });
  const sdk = {
    createModelRuntime: t.mock.fn(async (_options: unknown) => ({ getModel: () => model })),
    createAgentSession: t.mock.fn(async (_options: CreateAgentSessionOptions) => ({ session })),
  };
  return { run, session, sdk, io: sdk as unknown as SDK };
}

test("non-English task/profile prose never reaches the SDK; internal report failure retains accounting", async t => {
  const { run, session, sdk, io } = await fixture(t);
  for (const invalid of [{ ...run, task: "버그를 고치세요" }, { ...run, agent: { ...run.agent, systemPrompt: "작업을 수행하세요" } }]) {
    assert.equal((await executeWorker(invalid, io)).type, "failed");
  }
  assert.equal(sdk.createModelRuntime.mock.callCount(), 0); assert.equal(sdk.createAgentSession.mock.callCount(), 0);
  session.messages[0]!.content = [{ type: "text", text: "수정했습니다" }];
  const reply = await executeWorker(run, io); assert.equal(reply.type, "failed"); assert.equal(reply.report.modelCalls, 1);
  assert.equal(reply.report.diagnostic?.stage, "internal_report");
  assert.equal(reply.report.accounting.status, "reported"); assert.ok(!JSON.stringify(reply).includes("수정했습니다"));
});

test("SDK entry independently enforces the call cap even without an after-turn hook", async (t) => {
  const { run, session, io } = await fixture(t);
  const native = t.mock.method(session.agent, "streamFunction", async () => {});
  session.prompt = t.mock.fn(async () => {
    await session.agent.streamFunction(run.model, {});
    await session.agent.streamFunction(run.model, {});
  });
  const reply = await executeWorker({ ...run, maxModelCalls: 1 }, io);
  assert.equal(reply.type, "failed");
  if (reply.type === "failed") assert.equal(reply.error, MODEL_CALL_LIMIT_ERROR);
  assert.equal(reply.report.modelCalls, 1); assert.equal(native.mock.callCount(), 1);
});

test("SDK-native worker passes twelve rounds and keeps bounded partial traces without losing actual usage", async t => {
  const { run, session, io } = await fixture(t), calls = 150, message = structuredClone(session.messages[0]!);
  session.messages = Array.from({ length: calls }, () => structuredClone(message));
  session.getSessionStats = () => ({ assistantMessages: calls, tokens: { input: 10 * calls, output: 5 * calls, cacheRead: 0, cacheWrite: 0 }, cost: 0.007 * calls });
  session.prompt = t.mock.fn(async () => { for (let i = 0; i < calls; i++) await session.agent.streamFunction(run.model, {}); });
  const result = await executeWorker({ ...run, maxModelCalls: null }, io);
  assert.equal(result.type, "completed"); assert.equal(result.report.modelCalls, calls);
  assert.equal(result.report.rounds?.length, 128); assert.equal(result.report.roundsCoverage, "partial");
  assert.equal(result.report.accounting.status, "reported");
  if (result.report.accounting.status === "reported") { assert.equal(result.report.accounting.complete, true); assert.equal(result.report.accounting.stats.turns, calls); }
  assert.equal(session.dispose.mock.callCount(), 1);
});

test("SDK-native reducer still terminates on completion, provider error, cancellation and counter overflow", () => {
  let active: WorkerState = { status: "running", modelCalls: 0, maxModelCalls: null };
  for (let i = 0; i < 20; i++) {
    active = reduceWorker(active, { type: "model_call" }).state;
    assert.equal(active.status, "running");
    assert.equal(reduceWorker(active, { type: "turn_end", stopReason: "toolUse", hasToolCalls: true }).state, active);
  }
  for (const event of [{ type: "turn_end", stopReason: "stop", hasToolCalls: false }, { type: "turn_end", stopReason: "error", hasToolCalls: false }, { type: "cancel" }] as const) {
    const terminal: WorkerState = reduceWorker(active, event).state;
    assert.notEqual(terminal.status, "running"); assert.equal(reduceWorker(terminal, { type: "model_call" }).state, terminal);
  }
  assert.equal(reduceWorker({ ...active, modelCalls: Number.MAX_SAFE_INTEGER }, { type: "model_call" }).state.status, "failed");
});

test("worker call reducer is deterministic, allows final-call success, and ignores terminal events", () => {
  const again: WorkerEvent = { type: "turn_end", stopReason: "toolUse", hasToolCalls: true };
  const finished: WorkerEvent = { type: "turn_end", stopReason: "stop", hasToolCalls: false };
  const events: WorkerEvent[] = [{ type: "model_call" }, again, finished, { type: "failed" }, { type: "cancel" }];
  for (const maxModelCalls of [1, 6, 12]) {
    let state: WorkerState = { status: "running", modelCalls: 0, maxModelCalls };
    for (let call = 1; call <= maxModelCalls; call++) {
      const before: WorkerState = structuredClone(state);
      const next = reduceWorker(Object.freeze(state), { type: "model_call" });
      assert.deepEqual(next, reduceWorker(state, { type: "model_call" }));
      assert.deepEqual(state, before);
      state = next.state;
      assert.equal(state.modelCalls, call);
      if (call < maxModelCalls) assert.deepEqual(reduceWorker(state, again), { state, effects: [] });
    }
    const limited = reduceWorker(state, again);
    assert.deepEqual(limited.state, { ...state, status: "failed", reason: "model_call_limit" });
    assert.deepEqual(limited.effects, [{ type: "stop" }]);
    assert.equal(reduceWorker(state, { ...again, stopReason: "stop" }).state.status, "failed");
    const success = reduceWorker(state, finished);
    assert.equal(success.state.status, "succeeded");
    for (const terminal of [limited, success, reduceWorker(state, { type: "failed" }), reduceWorker(state, { type: "cancel" })]) {
      for (const event of events) assert.deepEqual(reduceWorker(Object.freeze(terminal.state), event), { state: terminal.state, effects: [] });
    }
  }
});

test("worker uses only approved model/tools/task, isolated settings, and bounded output", async (t) => {
  const { run, session, sdk, io } = await fixture(t);
  session.messages[0]!.content[0]!.text = "x".repeat(MAX_OUTPUT + 1);
  const reply = await executeWorker(run, io);
  assert.equal(reply.type, "completed");
  if (reply.type !== "completed") return;
  assert.equal(reply.result.text.length, MAX_OUTPUT);
  assert.equal(reply.result.truncated, true);
  assert.equal(reply.result.cost, 0.007);
  assert.equal(reply.report.modelCalls, 1);
  assert.deepEqual(reply.report.rounds, [{ call: 1, stopReason: "stop", toolCount: 0, tools: [] }]);
  assert.equal(reply.report.roundsCoverage, "complete");
  assert.ok(reply.report.startupMs! >= 0);
  assert.ok(reply.report.executionMs! >= 0);
  assert.ok(reply.report.accounting.status === "reported" && reply.report.accounting.complete);
  assert.equal(session.prompt.mock.callCount(), 1);
  assert.deepEqual(session.prompt.mock.calls[0]!.arguments, [workerPrompt(run)]);
  assert.equal(session.dispose.mock.callCount(), 1);
  const options = sdk.createAgentSession.mock.calls[0]!.arguments[0];
  assert.deepEqual(options.model, run.model);
  assert.deepEqual(options.tools, run.agent.tools);
  assert.equal(options.thinkingLevel, "off");
  assert.equal(options.settingsManager?.getRetrySettings().enabled, false);
  assert.equal(options.settingsManager?.getRetrySettings().maxRetries, 0);
  assert.equal(options.settingsManager?.getProviderRetrySettings().maxRetries, 0);
  assert.equal(options.settingsManager?.getCompactionEnabled(), false);
  assert.equal(options.sessionManager?.getSessionFile(), undefined);
  assert.deepEqual(options.resourceLoader?.getExtensions().extensions, []);
  assert.deepEqual(options.resourceLoader?.getSkills().skills, []);
  assert.deepEqual(options.resourceLoader?.getPrompts().prompts, []);
  assert.deepEqual(options.resourceLoader?.getAppendSystemPrompt(), [run.agent.systemPrompt]);
  assert.ok(options.resourceLoader?.getAgentsFiles().agentsFiles.some((file) => file.content.includes("pure reducer")));
  assert.equal(sdk.createModelRuntime.mock.callCount(), 1);
});

test("worker applies exact Codex thinking and acceptance criteria, rejecting aliases or SDK clamping before prompt", async (t) => {
  const { run, session, sdk } = await fixture(t);
  const model = { provider: "openai-codex", id: "offline-codex", api: "openai-codex-responses", reasoning: true,
    thinkingLevelMap: { high: "high" } };
  const selected: Run = { ...run, model: { provider: model.provider, id: model.id }, acceptanceCriteria: ["Only the typo changes."],
    agent: { ...run.agent, model: { provider: model.provider, id: model.id }, thinking: "high" } };
  const effective = Object.assign(session, { model, thinkingLevel: "high" });
  const io = { ...sdk, createModelRuntime: async () => ({ getModel: () => model }),
    createAgentSession: sdk.createAgentSession } as unknown as SDK;
  const success = await executeWorker(selected, io);
  assert.equal(success.type, "completed");
  assert.deepEqual(success.report.thinking, { requested: "high", applied: "high" });
  assert.equal(sdk.createAgentSession.mock.calls[0]!.arguments[0].thinkingLevel, "high");
  assert.match(session.prompt.mock.calls[0]!.arguments[0], /Only the typo changes/);
  effective.thinkingLevel = "low";
  const clamped = assertFailed(await executeWorker(selected, io));
  assert.deepEqual(clamped.report!.thinking, { requested: "high", applied: "low" });
  assert.equal(session.prompt.mock.callCount(), 1);
  model.thinkingLevelMap.high = "medium";
  assertFailed(await executeWorker(selected, io));
  assert.equal(sdk.createAgentSession.mock.callCount(), 2);
  assert.equal(session.prompt.mock.callCount(), 1);
});

test("worker rejects invalid IPC and missing models before any prompt", async (t) => {
  const { run, sdk, io, session } = await fixture(t);
  assertFailed(await executeWorker({ ...run, agent: { ...run.agent, tools: ["unapproved"] } }, io));
  assertFailed(await executeWorker({ ...run, model: { ...run.model, id: "unapproved" } }, io));
  for (const maxModelCalls of [undefined, 0, Number.MAX_SAFE_INTEGER + 1, 1.5, "6", NaN, Infinity]) {
    assertFailed(await executeWorker({ ...run, maxModelCalls }, io));
  }
  assert.equal(sdk.createModelRuntime.mock.callCount(), 0);
  const missing = { ...io, createModelRuntime: async () => ({ getModel: () => undefined }) } as unknown as SDK;
  const reply = assertFailed(await executeWorker(run, missing));
  assert.equal(reply.report!.accounting.status, "not_started");
  assert.equal(sdk.createAgentSession.mock.callCount(), 0);
  assert.equal(session.prompt.mock.callCount(), 0);
});

test("worker refuses fallback, incomplete/error messages, and raw provider errors", async (t) => {
  const { run, session, io } = await fixture(t);
  session.model = { ...session.model, id: "wrong-model" };
  assertFailed(await executeWorker(run, io));
  assert.equal(session.prompt.mock.callCount(), 0);
  session.model = run.model;
  for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
    session.messages[0]!.stopReason = stopReason;
    const reply = assertFailed(await executeWorker(run, io));
    assert.ok(reply.report!.accounting.status === "reported" && !reply.report!.accounting.complete);
  }
  session.messages[0]!.stopReason = "stop";
  session.prompt = t.mock.fn(async () => { throw new Error("request containing offline-secret"); });
  const reply = assertFailed(await executeWorker(run, io));
  assert.ok(reply.report!.accounting.status === "reported" && reply.report!.accounting.stats.cost === 0.007);
  assert.equal(session.dispose.mock.callCount(), 6);
});

test("worker cancellation reaches session.abort and disposes the session", async (t) => {
  const { run, session, io } = await fixture(t);
  const controller = new AbortController();
  session.prompt = t.mock.fn(async () => { controller.abort(); });
  const reply = await executeWorker(run, io, controller.signal);
  assert.equal(reply.type, "cancel");
  assert.ok(reply.report.accounting.status === "reported" && !reply.report.accounting.complete);
  assert.equal(session.abort.mock.callCount(), 1);
  assert.equal(session.dispose.mock.callCount(), 1);
});

test("actual Node worker loads and rejects invalid IPC before model/auth access", { timeout: 10_000 }, async (t) => {
  const { run } = await fixture(t);
  const fork = childProcess.fork;
  let intercepted = 0;
  const launches = t.mock.method(childProcess, "fork", (modulePath: string | URL, args: readonly string[], options: childProcess.ForkOptions) => {
    const child = fork(modulePath, args, { ...options,
      env: { PATH: process.env.PATH, HOME: run.cwd, PI_CODING_AGENT_DIR: path.dirname(path.dirname(run.agent.file)), PI_OFFLINE: "1" } });
    const send = child.send.bind(child);
    // Trusted transport fault: parent validates its packet, the actual owned child must validate again.
    child.send = ((message: unknown, ...rest: unknown[]) => {
      const payload = message && typeof message === "object" && "task" in message
        ? (intercepted++, { ...run, agent: { ...run.agent, tools: ["invalid"] } }) : message;
      return Reflect.apply(send, child, [payload, ...rest]);
    }) as typeof child.send;
    return child;
  });
  const early = await runSubagent({ ...run, seconds: 86_401 });
  assert.equal(early.type, "failed"); assert.equal(launches.mock.callCount(), 0);
  const result = assertFailed(await runSubagent(run));
  assert.equal(launches.mock.callCount(), 1); assert.equal(intercepted, 1);
  assert.equal(result.report?.accounting.status, "not_started");
});

test("worker completeness requires valid usage on every response, but preserves observed totals", async (t) => {
  const { run, session, io } = await fixture(t);
  const reported = structuredClone(session.messages[0]!);
  const missing = { ...reported, usage: undefined } as unknown as typeof reported;
  const zero = { ...reported, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
  for (const replies of [
    [missing], [zero], [{ ...reported, usage: { ...reported.usage, input: -1 } }],
    [{ ...reported, usage: { ...reported.usage, cost: { total: NaN } } }],
    [{ ...reported, stopReason: "toolUse" }, missing], [{ ...reported, stopReason: "toolUse" }, zero],
  ]) {
    session.messages = replies;
    t.mock.method(session, "getSessionStats", () => ({ assistantMessages: replies.length,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.007 }));
    const reply = await executeWorker(run, io);
    assert.equal(reply.type, "completed"); // Usage uncertainty is not task failure or permission to retry.
    assert.ok(reply.report.accounting.status === "reported" && !reply.report.accounting.complete);
    const costs = estimateCost({ ...initialState().metrics, worker: reply.report });
    assert.equal(costs.observedUsd, 0.007);
    assert.equal(costs.workerUsd, null);
    assert.equal(costs.delegationTotalUsd, null);
  }
  session.messages = [reported];
  const mismatch = await executeWorker(run, io); // Aggregate still claims two replies.
  assert.ok(mismatch.report.accounting.status === "reported" && !mismatch.report.accounting.complete);
  t.mock.method(session, "getSessionStats", () => ({ assistantMessages: 1,
    tokens: { input: 0, output: 0, cacheRead: 10, cacheWrite: 0 }, cost: 0 }));
  session.messages = [{ ...reported, usage: { input: 0, output: 0, cacheRead: 10, cacheWrite: 0, cost: { total: 0 } } }];
  const free = await executeWorker(run, io);
  assert.ok(free.report.accounting.status === "reported" && free.report.accounting.complete);
});

test("automatic worker entry preserves canonical non-Codex thinking and refuses target changes or aliases", async t => {
  const { run, session, sdk, io } = await fixture(t);
  const selected = { ...run.model, api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", reasoning: true };
  let available = true, alias = false, changedTarget = false;
  t.mock.method(sdk, "createModelRuntime", async () => ({ getModel: () => ({ ...selected, ...(alias ? { thinkingLevelMap: { minimal: "low" } } : {}),
    baseUrl: changedTarget ? "http://127.0.0.1:2/v1" : selected.baseUrl }), getAvailableSnapshot: () => available ? [selected] : [] }));
  Object.assign(session, { thinkingLevel: "minimal" });
  const request: Run = { ...run, agent: { ...run.agent, thinking: "minimal" }, modelTarget: { api: selected.api, endpoint: selected.baseUrl } };
  assert.equal((await executeWorker(request, io)).type, "completed");
  const started = sdk.createAgentSession.mock.callCount();
  for (const mode of ["target", "availability", "alias"] as const) {
    changedTarget = mode === "target"; available = mode !== "availability"; alias = mode === "alias";
    assertFailed(await executeWorker(request, io));
    assert.equal(sdk.createAgentSession.mock.callCount(), started, "An unavailable, changed or aliased selection must stop before SDK session setup.");
  }
});

test("worker diagnostics whitelist HTTP status and categories, preserving callbacks and clearing stale status", async (t) => {
  const { run, session, io } = await fixture(t);
  let status: number | undefined;
  const header = { "x-private": "offline-secret" };
  const callback = t.mock.fn(async () => {});
  t.mock.method(session.agent, "streamFunction", async (model: unknown, _context: unknown, options?: unknown) => {
    if (status !== undefined) await (options as { onResponse: (response: unknown, model: unknown) => Promise<void> }).onResponse({ status, headers: header }, model);
  });
  for (const [code, message, category] of [
    [401, "offline-secret", "authentication"], [403, "offline-secret", "authentication"],
    [429, "offline-secret", "rate_limited"], [500, "offline-secret", "provider_error"],
    [400, "The 'offline-secret' model is not supported.", "model_unavailable"],
    [400, "Unsupported value: reasoning.effort offline-secret", "unsupported_setting"],
    [400, "offline-secret", "request_rejected"],
    [undefined, "fetch failed: offline-secret", "transport"],
    [NaN, "offline-secret", "unknown"], [999, "offline-secret", "unknown"],
  ] as const) {
    status = code;
    session.prompt = t.mock.fn(async () => {
      await session.agent.streamFunction(run.model, {}, { onResponse: callback });
      Object.assign(session.messages[0]!, { stopReason: "error", errorMessage: message });
    });
    const reply = assertFailed(await executeWorker(run, io));
    assert.deepEqual(reply.report!.diagnostic, { category, httpStatus: Number.isInteger(code) && code! <= 599 ? code : null, stage: "model_response" });
  }
  assert.equal(callback.mock.callCount(), 9);
  session.prompt = t.mock.fn(async () => {
    status = 200;
    await session.agent.streamFunction(run.model, {}, { onResponse: callback });
    status = undefined;
    await session.agent.streamFunction(run.model, {}, {});
    throw new Error("ECONNRESET offline-secret");
  });
  const reply = assertFailed(await executeWorker(run, io));
  assert.deepEqual(reply.report!.diagnostic, { category: "transport", httpStatus: null, stage: "model_request" });
  assert.equal(reply.report!.modelCalls, 2); // Stream invocations, not the single mocked assistant message.
  assert.equal(reply.report!.roundsCoverage, "partial");
});

test("only pinned SDK incomplete Responses errors receive a finite diagnostic without implying HTTP success", () => {
  for (const message of ["OpenAI Responses stream ended before a terminal response event", "OpenAI Responses stream ended without a stop reason"]) {
    assert.deepEqual(diagnose(Error(message), 200, false), { category: "response_incomplete", httpStatus: 200 });
    assert.deepEqual(diagnose(message, 200, true), { category: "cancelled", httpStatus: 200 });
    assert.deepEqual(diagnose(message, 401, false), { category: "authentication", httpStatus: 401 });
    assert.deepEqual(diagnose(message, 500, false), { category: "provider_error", httpStatus: 500 });
    assert.deepEqual(diagnose(`${message} PRIVATE_PROVIDER_BODY`, 200, false), { category: "unknown", httpStatus: 200 });
  }
  assert.deepEqual(diagnose("PRIVATE_PROVIDER_BODY", 200, false), { category: "unknown", httpStatus: 200 });
});

test("a failed model request with no assistant response keeps an explicitly partial empty trace", async t => {
  const { run, session, io } = await fixture(t); session.messages = [];
  const reply = assertFailed(await executeWorker(run, io)); assert.equal(reply.report!.modelCalls, 1);
  assert.deepEqual(reply.report!.rounds, []); assert.equal(reply.report!.roundsCoverage, "partial");
});
test("unavailable usage and cleanup failures are sanitized, not reported as complete zero usage", async (t) => {
  const { run, session, io } = await fixture(t);
  t.mock.method(session, "getSessionStats", () => { throw new Error("offline-secret"); });
  const reply = assertFailed(await executeWorker(run, io));
  assert.equal(reply.report!.accounting.status, "unknown");
  assert.equal(reply.report!.roundsCoverage, "complete"); // Metadata coverage survives unavailable billing.
  t.mock.method(session, "dispose", () => { throw new Error("offline-secret"); });
  assertFailed(await executeWorker(run, io));
});

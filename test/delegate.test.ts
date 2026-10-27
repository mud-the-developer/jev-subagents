import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import { initTheme, ModelRuntime, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { delegate, executeEffect, loadAgents, runSubagent } from "../src/delegate-effects.ts";
import { windowsProcessIO } from "../src/windows-worker-effects.ts";
import { estimateCost, initialState, reduce, RUN_TIMEOUT_MS, WORKER_ERROR, type Agent, type Event, type Job, type Run, type RunResult, type State } from "../src/delegate-machine.ts";
import jevRouter from "../src/index.ts";
import { DelegateToolInputSchema, OrdinaryDelegateInputSchema } from "../src/ordinary-effects.ts";
import { Value } from "typebox/value";
import { nativeTaskReviewText, taskReviewContent } from "../src/task-review-machine.ts";
import { validPlanReceipt } from "../src/plan-state.ts";
import { withJevSession } from "../src/jev-config.ts";
import { BACKEND_ENTRY } from "../src/jev-backend.ts";
import { approvalUiText, type ApprovalUiDiagnostic } from "../src/approval-ui-diagnostics.ts";

const input = { task: "Fix the typo and verify the change.", agents: ["scout", "worker"] };
const model = { provider: "test-provider", id: "test-model" };
const decision = { agent: "worker", model: "jev-test", confidence: 1, usage: { inputTokens: 50, outputTokens: 10 } };
const stats = { turns: 1, usage: { input: 30, output: 15, cacheRead: 0, cacheWrite: 0 }, cost: 0.005 };
const result: RunResult = { ...stats, text: "Changed one file; checks passed.", truncated: false };
const completed = { type: "completed", result, report: {
  startupMs: 2, executionMs: 3, modelCalls: 1, accounting: { status: "reported", stats, complete: true },
} } as const;
const agents: readonly Agent[] = ["scout", "worker"].map((name) => Object.freeze({
  name, model, description: `${name} work`, systemPrompt: `Be a ${name}.`, tools: name === "scout" ? ["read"] : ["read", "edit"], file: `/config/agents/${name}.md`,
}));
const job: Job = { input, cwd: "/workspace" };
const run: Run = { task: input.task, cwd: job.cwd, agent: agents[1]!, model, maxModelCalls: null };

beforeEach(async (t) => {
  assert.ok("mock" in t);
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-delegate-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.TYPESAFE_API_KEY = "offline-test-key";
  t.after(async () => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(path.join(dir, "agents"));
  for (const name of input.agents) await writeFile(path.join(dir, "agents", `${name}.md`),
    (await readFile(new URL(`../agents/${name}.md`, import.meta.url), "utf8")).replace('model: ""', "model: test-provider/test-model"));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live HTTP is forbidden."); });
  t.mock.method(childProcess, "fork", () => { throw new Error("Unmocked worker execution is forbidden."); });
});

function context(confirm: ExtensionContext["ui"]["confirm"]): ExtensionContext {
  return { mode: "rpc", cwd: process.env.PI_CODING_AGENT_DIR!, hasUI: true, model, sessionManager: { getSessionId: () => "mock-native-session" },
    ui: { confirm, select: async () => assert.fail("No ordinary approval menu") } } as unknown as ExtensionContext;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fakeChild(t: TestContext, send: (child: EventEmitter) => void) {
  let closed = false;
  const child = Object.assign(new EventEmitter(), {
    pid: 123456, connected: true,
    kill: t.mock.fn((_signal: string) => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    }),
    send: t.mock.fn((input: unknown, callback: (error: null) => void) => {
      callback(null);
      if (typeof input === "object" && input !== null && "type" in input && input.type === "jev_worker_cancel") child.kill("SIGTERM");
      else queueMicrotask(() => send(child));
      return true;
    }),
  });
  child.once("close", () => { closed = true; });
  if (process.platform === "win32") t.mock.method(windowsProcessIO, "own", async () => ({ close: async () => {
    if (!closed) process.kill(child.pid, "SIGKILL");
    return true;
  } }));
  const fork = t.mock.method(childProcess, "fork", () => child as unknown as ChildProcess);
  const kill = t.mock.method(process, "kill", () => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  });
  return { child, fork, kill };
}

function mockRouting(t: TestContext, choice = "worker") {
  return t.mock.method(globalThis, "fetch", async () => Response.json({
    model: "jev-test", answers: { agent: { type: "choice", choice, confidence: 1 } }, usage: { input_tokens: 50, output_tokens: 10 },
  }));
}

test("delegation reducer requires matching candidates and explicit approval before one run", () => {
  const start = { type: "start", job, canConfirm: true } as const;
  const loading = reduce(initialState(), start);
  assert.deepEqual(loading, reduce(initialState(), start));
  const routing = reduce(Object.freeze(loading.state), { type: "agents_loaded", agents });
  assert.equal(routing.state.status, "routing");
  assert.equal(routing.effects[0]?.type, "call_jev");
  assert.deepEqual(reduce(routing.state, { type: "approval", approved: true }).effects, []);
  assert.equal(reduce(loading.state, { type: "agents_loaded", agents: [agents[0]!] }).state.status, "failed");
  assert.equal(reduce(routing.state, { type: "resolved", decision: { ...decision, agent: "outsider" } }).state.status, "failed");
  const waiting = reduce(routing.state, { type: "resolved", decision });
  assert.equal(waiting.effects[0]?.type, "confirm_run");
  assert.equal(reduce(waiting.state, completed).state.status, "awaiting_approval");
  const declined = reduce(waiting.state, { type: "approval", approved: false });
  assert.equal(declined.state.status, "cancelled");
  assert.deepEqual(declined.effects, []);
  const running = reduce(Object.freeze(waiting.state), { type: "approval", approved: true });
  assert.deepEqual(running.effects, [{ type: "run_agent", run: { ...run, seconds: 86_400 } }]);
  assert.deepEqual(reduce(running.state, { type: "approval", approved: true }).effects, []);
  const success = reduce(running.state, completed);
  assert.equal(success.state.status, "succeeded");
  for (const active of [loading.state, routing.state, waiting.state, running.state]) {
    assert.equal(reduce(active, { type: "cancel" }).state.status, "cancelled");
    assert.equal(reduce(active, { type: "failed", error: "offline" }).state.status, "failed");
    assert.deepEqual(reduce(active, start).effects, []);
  }
  for (const terminal of [success.state, declined.state, reduce(loading.state, { type: "failed", error: "offline" }).state]) {
    for (const event of [start, completed, { type: "cancel" }, { type: "approval", approved: true }] as Event[]) {
      assert.deepEqual(reduce(Object.freeze(terminal), event), { state: terminal, effects: [] });
    }
  }
});

test("worker results, accounting and verifier events are owned snapshots across approval and terminal states", () => {
  for (const check of [false, true]) {
    const task = { ...input, agents: ["worker"], ...(check ? {
      verification: { command: "node", args: ["check.mjs"], description: "Fixture coverage" }, acceptanceCriteria: ["Typo fixed"],
    } : {}) };
    const loaded = reduce(initialState(), { type: "start", canConfirm: true, job: { ...job, input: task } });
    const approved = reduce(loaded.state, { type: "agents_loaded", agents: [agents[1]!] });
    const running = reduce(approved.state, { type: "approval", approved: true }).state;
    const message = structuredClone(completed);
    const done = reduce(running, message).state;
    assert.equal(done.status, check ? "verifying" : "succeeded");
    const snapshot = structuredClone(done);
    Object.assign(message.result, { text: "Changed after delivery", truncated: true });
    Object.assign(message.result.usage, { input: 999 });
    Object.assign(message.report.accounting.stats, { cost: 999 });
    Object.assign(message.report, { modelCalls: 12 });
    assert.deepEqual(done, snapshot);
    if (done.status !== "verifying") continue;
    for (const verification of [{ status: "passed", exitCode: 0 }, { status: "failed", exitCode: 2 }, { status: "timed_out", exitCode: null }] as const) {
      const event = { type: "verified" as const, result: { ...verification } };
      const next = reduce(done, event);
      assert.equal(next.state.status, verification.status === "passed" ? "awaiting_assessment_approval" : "failed");
      const owned = structuredClone(next);
      Object.assign(event.result, { status: "failed", exitCode: 3 });
      assert.deepEqual(next, owned);
      if (next.state.status === "awaiting_assessment_approval") assert.equal(next.state.packet.workerClaim, result.text);
    }
  }
});

test("malformed worker completion fails closed and never verifies; cancellation still takes precedence", () => {
  const loaded = reduce(initialState(), { type: "start", canConfirm: true, job: { ...job, input: { ...input, agents: ["worker"],
    verification: { command: "node", args: ["check.mjs"] } } } }).state;
  const waiting = reduce(loaded, { type: "agents_loaded", agents: [agents[1]!] }).state;
  const running = reduce(waiting, { type: "approval", approved: true }).state;
  for (const report of [undefined, null, {}, { ...completed.report, modelCalls: "1" }]) {
    const event = { ...completed, report } as unknown as Event;
    assert.equal(reduce(waiting, event).state, waiting);
    const failed = reduce(running, event);
    assert.equal(failed.state.status, "failed");
    assert.deepEqual(failed.effects, []);
    assert.equal(estimateCost(failed.state.metrics).workerUsd, null);
    const cancelled = reduce(running, { ...event, aborted: true });
    assert.equal(cancelled.state.status, "cancelled");
    assert.deepEqual(cancelled.effects, []);
    assert.equal(estimateCost(cancelled.state.metrics).workerUsd, null);
  }
});

test("missing UI, invalid inputs, missing files/models, and declined approval never fork", async (t) => {
  const confirm = t.mock.fn(async () => false);
  const ctx = context(confirm);
  const http = mockRouting(t);
  const fork = t.mock.method(childProcess, "fork");
  assert.equal((await delegate(input, { ...ctx, hasUI: false })).status, "failed");
  for (const invalid of [{ ...input, task: " " }, { ...input, agents: ["../secret", "worker"] }, { ...input, agents: ["worker", "worker"] }]) {
    assert.equal((await delegate(invalid, ctx)).status, "failed");
  }
  assert.equal((await delegate({ ...input, agents: ["missing", "worker"] }, ctx)).status, "failed");
  const file = path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "worker.md");
  const configured = await readFile(file, "utf8");
  await writeFile(file, configured.replace("model: test-provider/test-model", ""));
  assert.equal((await delegate(input, ctx)).status, "failed");
  await writeFile(file, configured);
  assert.equal(http.mock.callCount(), 0);
  assert.equal(confirm.mock.callCount(), 0);
  const declined = await delegate(input, { ...ctx, model: undefined });
  assert.equal(declined.status, "cancelled");
  assert.equal(estimateCost(declined.metrics).workerUsd, 0);
  assert.ok(estimateCost(declined.metrics).jevUsd! > 0);
  assert.equal(confirm.mock.callCount(), 1);
  assert.equal(http.mock.callCount(), 1);
  assert.equal(fork.mock.callCount(), 0);
});

test("full mock flow approves an exact snapshot, excludes credentials, and spawns once", async (t) => {
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const http = mockRouting(t);
  const { child, fork } = fakeChild(t, (child) => { child.emit("message", completed); child.emit("close", 0); });
  const state = await delegate(input, context(confirm));
  assert.equal(state.status, "succeeded");
  assert.equal(http.mock.callCount(), 1);
  assert.equal(fork.mock.callCount(), 1);
  const options = fork.mock.calls[0]!.arguments[2]!;
  assert.equal(options.env?.TYPESAFE_API_KEY, undefined);
  assert.equal(options.env?.NODE_OPTIONS, undefined);
  assert.equal(options.detached, process.platform !== "win32");
  assert.match(path.basename(options.execPath!).toLowerCase(), /^bun(?:\.exe)?$/);
  assert.equal(options.serialization, "json");
  assert.deepEqual(options.execArgv?.slice(0, 2), ["--no-env-file", "--no-install"]);
  assert.match(options.execArgv?.[2] ?? "", /^--config=.+worker-bunfig\.toml$/);
  const sent = child.send.mock.calls[0]!.arguments[0] as Run;
  const snapshot = confirm.mock.calls[0]!.arguments[1];
  assert.equal(snapshot, nativeTaskReviewText(taskReviewContent(sent)), "The complete reviewed projection binds the actual IPC input");
  assert.equal(confirm.mock.callCount(), 1, "one exact native execution review");
  assert.ok(!JSON.stringify(state).includes("offline-test-key"));
  assert.ok(!String(http.mock.calls[0]!.arguments[1]?.body).includes("Do not delegate further"));
  assert.equal(state.metrics.profile?.maxModelCalls, null);
  assert.equal(state.metrics.worker.modelCalls, 1);
});

test("direct and registered defaults wait for one exact native receipt and preserve the dispatched input and budgets", async t => {
  for (const registered of [false, true]) for (const maxModelCalls of [undefined, null, 2]) {
    const opened = deferred<void>(), receipt = deferred<boolean>();
    let displayed = "", requests = 0;
    const ctx = context(async (_title, text, options) => {
      requests++; displayed = text; assert.equal(options?.timeout, undefined); opened.resolve(); return await receipt.promise;
    });
    const tools: ToolDefinition[] = [];
    jevRouter({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    const params = { task: "Read only the synthetic fixture and report.", agents: ["worker"],
      ...(maxModelCalls === undefined ? {} : { maxModelCalls }), ...(maxModelCalls === 2 ? { seconds: 600 } : {}) };
    const { child, fork } = fakeChild(t, child => { child.emit("message", completed); child.emit("close", 0); });
    const work = registered ? tools.find(tool => tool.name === "jev_delegate")!.execute("synthetic", params, t.signal, undefined, ctx)
      : delegate(params, ctx, t.signal);
    await opened.promise;
    assert.equal(requests, 1); assert.equal(fork.mock.callCount(), 0); assert.equal(child.send.mock.callCount(), 0);
    receipt.resolve(true); await work;
    assert.equal(requests, 1); assert.equal(fork.mock.callCount(), 1);
    const sent = child.send.mock.calls[0]!.arguments[0] as Run;
    assert.equal(sent.task, params.task); assert.equal(sent.maxModelCalls, maxModelCalls ?? null);
    assert.equal(sent.seconds, maxModelCalls === 2 ? 600 : 86_400);
    assert.equal(displayed, nativeTaskReviewText(taskReviewContent(sent)));
    receipt.resolve(true); await Promise.resolve(); assert.equal(fork.mock.callCount(), 1);
  }
});

test("registered TUI waits for unchanged submission AND the actual SDK receipt before any worker", async t => {
  initTheme("dark", false);
  const tools: ToolDefinition[] = [];
  jevRouter({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const opened = deferred<void>(), receipt = deferred<boolean>();
  let view!: { handleInput(data: string): void }, requested: unknown, requests = 0;
  const ctx = context(async () => assert.fail("No confirm fallback")); ctx.mode = "tui";
  ctx.ui.custom = (async (factory: (...args: unknown[]) => unknown) => {
    requests++;
    view = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, {}, { matches: () => false }, (value: unknown) => { requested = value; }) as typeof view;
    opened.resolve(); return await receipt.promise;
  }) as ExtensionContext["ui"]["custom"];
  const { fork } = fakeChild(t, child => { child.emit("message", completed); child.emit("close", 0); });
  const work = tools.find(tool => tool.name === "jev_delegate")!.execute("synthetic", { ...input, agents: ["worker"] }, t.signal, undefined, ctx);
  await opened.promise; assert.equal(fork.mock.callCount(), 0);
  view.handleInput("\r"); assert.equal(requested, true);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  assert.equal(fork.mock.callCount(), 0, "Requesting SDK closure is not its receipt");
  receipt.resolve(true); await work; assert.equal(requests, 1); assert.equal(fork.mock.callCount(), 1);
});

test("registered ordinary overlap and every lifecycle cancellation consume pending review without a worker or fallback", async t => {
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) {
    const tools: ToolDefinition[] = [], hooks = new Map<string, (() => unknown)[]>();
    jevRouter({ registerTool(tool: ToolDefinition) { tools.push(tool); }, registerCommand() {},
      on(name: string, hook: () => unknown) { hooks.set(name, [...hooks.get(name) ?? [], hook]); } } as unknown as ExtensionAPI);
    const opened = deferred<void>(), receipt = deferred<boolean>(); let requests = 0, uiSignal: AbortSignal | undefined;
    const ctx = context(async (_title, _text, options) => { requests++; uiSignal = options?.signal; opened.resolve(); return await receipt.promise; });
    const tool = tools.find(tool => tool.name === "jev_delegate")!, params = { ...input, agents: ["worker"] };
    const fork = t.mock.method(childProcess, "fork", () => assert.fail("No worker before approval"));
    const work = assert.rejects(tool.execute("synthetic", params, t.signal, undefined, ctx), /approval not received/);
    await opened.promise;
    await assert.rejects(tool.execute("overlap", params, t.signal, undefined, ctx), /closed, busy or uncertain/);
    assert.equal(requests, 1); assert.equal(uiSignal?.aborted, false);
    for (const hook of hooks.get(event)!) await hook();
    await work; assert.equal(uiSignal?.aborted, true);
    receipt.resolve(true); await Promise.resolve(); assert.equal(requests, 1); assert.equal(fork.mock.callCount(), 0);
  }
});

test("OpenJEV routing preserves requested/canonical model and unknown pricing through approved worker admission without leaking its credentials", async (t) => {
  const keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  Object.assign(process.env, { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8080", OPENJEV_MODEL: "laya-1.0", OPENJEV_API_KEY: "offline-openjev-key" });
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const http = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "http://127.0.0.1:8080/v1/systemone");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-openjev-key");
    assert.equal(JSON.parse(String(init?.body)).model, "laya-1.0");
    return Response.json({ model: "laya-1.0", usage: { input_tokens: 50, output_tokens: 0 },
      answers: { agent: { type: "choice", choice: "worker", confidence: 1, probabilities: { scout: 0, worker: 1 } } } });
  });
  const { fork } = fakeChild(t, child => { child.emit("message", completed); child.emit("close", 0); });
  const state = await delegate(input, context(confirm));
  assert.equal(state.status, "succeeded"); assert.equal(http.mock.callCount(), 1); assert.equal(fork.mock.callCount(), 1);
  assert.equal(state.metrics.jev.status, "reported");
  if (state.metrics.jev.status === "reported") {
    assert.equal(state.metrics.jev.provider, "openjev"); assert.equal(state.metrics.jev.requestedModel, "laya-1.0"); assert.equal(state.metrics.jev.model, "laya-1.0");
  }
  assert.equal(estimateCost(state.metrics).jevUsd, null);
  const env = fork.mock.calls[0]!.arguments[2]!.env!;
  for (const key of [...keys, "TYPESAFE_API_KEY"]) assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(state).includes("offline-openjev-key"));
  assert.ok(!confirm.mock.calls.some(call => String(call.arguments[1]).includes("offline-openjev-key")));
});

test("branch-local Clef routing reaches approved mock worker admission, reports unknown price and strips Clef credentials", async t => {
  const saved = process.env.CLEF_API_KEY;
  process.env.CLEF_API_KEY = "offline-clef-key";
  t.after(() => { if (saved === undefined) delete process.env.CLEF_API_KEY; else process.env.CLEF_API_KEY = saved; });
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const ctx = { ...context(confirm), sessionManager: { getSessionId: () => "fixture-clef-session", getBranch: () => [{ type: "custom", customType: BACKEND_ENTRY,
    data: { version: 1, selection: { mode: "local", preset: "clef", origin: "http://127.0.0.1:30000" } } }] } } as unknown as ExtensionContext;
  const http = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "http://127.0.0.1:30000/v1/systemone"); assert.equal(JSON.parse(String(init?.body)).model, "Cloudflare/clef");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-clef-key");
    return Response.json({ model: "Cloudflare/clef", usage: { input_tokens: 50, output_tokens: 0 },
      answers: { agent: { type: "choice", choice: "worker", confidence: 0.8, probabilities: { scout: 0.2, worker: 0.8 } } } });
  });
  const { fork } = fakeChild(t, child => { child.emit("message", completed); child.emit("close", 0); });
  const state = await withJevSession(ctx, () => delegate(input, ctx));
  assert.equal(state.status, "succeeded"); assert.equal(http.mock.callCount(), 1); assert.equal(fork.mock.callCount(), 1);
  assert.equal(state.metrics.jev.status, "reported");
  if (state.metrics.jev.status === "reported") { assert.equal(state.metrics.jev.provider, "clef"); assert.equal(state.metrics.jev.requestedModel, "Cloudflare/clef"); }
  assert.equal(estimateCost(state.metrics).jevUsd, null);
  for (const key of ["CLEF_API_KEY", "CLEF_MODEL", "CLEF_BASE_URL", "OPENJEV_API_KEY", "TYPESAFE_API_KEY"]) assert.equal(fork.mock.calls[0]!.arguments[2]!.env?.[key], undefined);
  assert.ok(!JSON.stringify(state).includes("offline-clef-key"));
});

test("model-call limits validate before I/O and the exact override survives approval and execution", async (t) => {
  const http = mockRouting(t);
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const { child, fork } = fakeChild(t, (child) => { child.emit("message", completed); child.emit("close", 0); });
  for (const maxModelCalls of [0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5, "6", NaN, Infinity]) {
    assert.equal((await delegate({ ...input, maxModelCalls: maxModelCalls as number }, context(confirm))).status, "failed");
  }
  assert.equal(http.mock.callCount(), 0);
  assert.equal(confirm.mock.callCount(), 0);
  assert.equal(fork.mock.callCount(), 0);
  for (const maxModelCalls of [1, 6, 12, 100]) {
    const params = Object.freeze({ ...input, maxModelCalls });
    const before = structuredClone(params);
    const state = await delegate(params, context(confirm));
    assert.equal(state.status, "succeeded");
    assert.equal(state.metrics.profile?.maxModelCalls, maxModelCalls);
    const sent = child.send.mock.calls.at(-1)!.arguments[0] as Run;
    assert.equal(sent.maxModelCalls, maxModelCalls);
    const snapshot = confirm.mock.calls.at(-1)!.arguments[1];
    assert.equal(snapshot, nativeTaskReviewText(taskReviewContent(sent)));
    assert.deepEqual(params, before);
  }
  assert.equal(fork.mock.callCount(), 4);
});

test("invalid or over-limit completed worker counts cannot advance to verification", () => {
  let transition = reduce(initialState(), { type: "start", job: { ...job, input: {
    ...input, maxModelCalls: 1, verification: { command: "node", args: [] },
  } }, canConfirm: true });
  transition = reduce(transition.state, { type: "agents_loaded", agents });
  transition = reduce(transition.state, { type: "resolved", decision });
  transition = reduce(transition.state, { type: "approval", approved: true });
  for (const modelCalls of [null, 0, 2, 13, -1, 1.5, NaN]) {
    const invalid = reduce(transition.state, { ...completed, report: { ...completed.report, modelCalls } });
    assert.equal(invalid.state.status, "failed");
    assert.deepEqual(invalid.effects, []);
  }
});

test("agent files validate model/tool types, filename matching, size, and traversal", async () => {
  const workerFile = path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "worker.md");
  const original = await readFile(workerFile, "utf8");
  for (const content of [original.replace("name: worker", "name: different"), original.replace("read, bash, edit, write, grep, find, ls", "read, unknown_tool"), original.replace("model: test-provider/test-model", "model: ambiguous-model"), "x".repeat(32_769)]) {
    await writeFile(workerFile, content);
    await assert.rejects(loadAgents(input.agents));
  }
  await assert.rejects(loadAgents(["../outside"]));
  await writeFile(workerFile, original.replace("model: test-provider/test-model", "model: provider/model-id"));
  assert.deepEqual((await loadAgents(input.agents))[1]!.model, { provider: "provider", id: "model-id" });
});

test("approval cancellation wins over late approval and never starts a child", async (t) => {
  const controller = new AbortController();
  mockRouting(t);
  const fork = t.mock.method(childProcess, "fork");
  const ctx = context(async (_title, _message, options) => {
    assert.ok(options?.signal); assert.equal(options.signal.aborted, false);
    controller.abort(); assert.equal(options.signal.aborted, true);
    return true;
  });
  const state = await delegate(input, ctx, controller.signal);
  assert.equal(state.status, "cancelled");
  assert.equal(estimateCost(state.metrics).workerUsd, 0);
  assert.equal(fork.mock.callCount(), 0);
});

test("worker cancellation requests SDK cleanup and ignores late success", async (t) => {
  const controller = new AbortController();
  const { child, fork, kill } = fakeChild(t, (child) => {
    controller.abort();
    child.emit("message", completed);
  });
  assert.deepEqual(await runSubagent(run, AbortSignal.abort()), { type: "cancel" });
  assert.equal(fork.mock.callCount(), 0);
  const stopped = await runSubagent(run, controller.signal);
  assert.equal(stopped.type, "cancel");
  assert.deepEqual(stopped.report?.accounting, { status: "reported", stats, complete: false });
  assert.deepEqual(child.kill.mock.calls[0]!.arguments, ["SIGTERM"]);
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("ordinary worker progress is advisory and never replaces the final usage result", async t => {
  const seen: unknown[] = [];
  fakeChild(t, child => {
    child.emit("message", { type: "jev_worker_progress", version: 1, sequence: 1, phase: "model_request", elapsedMs: 0, modelCalls: 1, toolCalls: 0 });
    child.emit("message", completed); child.emit("close", 0);
  });
  const result = await runSubagent(run, undefined, progress => { seen.push(progress); });
  assert.equal(result.type, "completed"); assert.equal(seen.length, 1);
  assert.deepEqual(result.report?.accounting, completed.report.accounting);
});

test("a new 24-hour worker survives the former 30-minute cutoff and stops at the approved deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, fork } = fakeChild(t, () => {});
  let settled = false;
  const pending = runSubagent({ ...run, seconds: 86_400 }).then(event => { settled = true; return event; });
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  t.mock.timers.tick(1_800_000); await Promise.resolve();
  assert.equal(settled, false); assert.equal(child.kill.mock.callCount(), 0);
  t.mock.timers.tick(84_599_999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); const event = await pending;
  assert.equal(event.type, "failed");
  if (event.type === "failed") assert.match(event.error, /86400-second time limit/);
  assert.equal(fork.mock.callCount(), 1); assert.equal(child.kill.mock.callCount(), 1);
});

test("an explicit thirty-minute worker retains its approved deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, fork } = fakeChild(t, () => {});
  let settled = false;
  const pending = runSubagent({ ...run, seconds: 1800 }).then(event => { settled = true; return event; });
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  t.mock.timers.tick(600000); await Promise.resolve();
  assert.equal(settled, false); assert.equal(child.kill.mock.callCount(), 0);
  t.mock.timers.tick(1199999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); const event = await pending;
  assert.equal(event.type, "failed");
  if (event.type === "failed") assert.match(event.error, /1800-second time limit/);
  assert.equal(fork.mock.callCount(), 1); assert.equal(child.kill.mock.callCount(), 1);
});

test("an explicit ten-minute worker survives the legacy cutoff and stops only at its approved deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, fork } = fakeChild(t, () => {});
  let settled = false;
  const pending = runSubagent({ ...run, seconds: 600 }).then(event => { settled = true; return event; });
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  t.mock.timers.tick(RUN_TIMEOUT_MS); await Promise.resolve();
  assert.equal(settled, false); assert.equal(child.kill.mock.callCount(), 0);
  t.mock.timers.tick(479999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); const event = await pending;
  assert.equal(event.type, "failed");
  if (event.type === "failed") assert.match(event.error, /600-second time limit/);
  assert.equal(fork.mock.callCount(), 1); assert.equal(child.kill.mock.callCount(), 1);
});

test("worker deadline terminates the process, with no retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, fork } = fakeChild(t, () => {});
  const pending = runSubagent(run);
  await Promise.resolve(); // Windows ownership admission is asynchronous, even in the offline mock.
  t.mock.timers.tick(RUN_TIMEOUT_MS);
  const event = await pending;
  assert.equal(event.type, "failed");
  assert.equal(child.kill.mock.callCount(), 1);
  assert.equal(fork.mock.callCount(), 1);
});

test("unresponsive workers are force-killed after the cleanup grace period", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const { child, kill } = fakeChild(t, () => {});
  t.mock.method(child, "kill", () => true);
  const pending = runSubagent(run, controller.signal);
  await Promise.resolve();
  controller.abort();
  assert.equal(kill.mock.callCount(), 0);
  t.mock.timers.tick(2_000);
  assert.deepEqual(await pending, { type: "cancel" });
  assert.deepEqual(kill.mock.calls[0]!.arguments, [process.platform === "win32" ? 123456 : -123456, "SIGKILL"]);
});

test("invalid IPC, exit failures, and spawn errors are sanitized", async (t) => {
  for (const mode of ["invalid", "exit", "spawn"] as const) {
    fakeChild(t, (child) => {
      if (mode === "invalid") child.emit("message", { type: "completed", result: { text: "offline-test-key" } });
      if (mode === "exit") { child.emit("message", completed); child.emit("close", 1); }
      if (mode === "spawn") child.emit("error", new Error("offline-test-key"));
    });
    const event = await runSubagent(run);
    assert.equal(event.type, "failed");
    assert.ok(!JSON.stringify(event).includes("offline-test-key"));
  }
  const http = t.mock.method(globalThis, "fetch");
  const event = await executeEffect({ type: "load_agents", names: ["missing"] }, context(async () => true));
  assert.equal(event.type, "failed");
  if (event.type === "failed") {
    assert.match(event.error, /\/jev-subagents setup/);
    assert.match(event.error, /\/jev-subagents status/);
    assert.match(event.error, /No routing or worker execution was attempted/);
  }
  assert.equal(http.mock.callCount(), 0);
});

test("Windows ownership failure never admits the task and never leaks its raw error", { skip: process.platform !== "win32" }, async (t) => {
  const { child } = fakeChild(t, () => assert.fail("An unowned task was admitted."));
  t.mock.method(windowsProcessIO, "own", async () => { throw new Error("offline-secret-must-not-escape"); });
  const outcome = await runSubagent(run);
  assert.equal(outcome.type, "failed");
  assert.equal(child.send.mock.callCount(), 0);
  assert.ok(!JSON.stringify(outcome).includes("offline-secret-must-not-escape"));
});

test("Windows unconfirmed tree cleanup cannot certify worker success or complete accounting", { skip: process.platform !== "win32" }, async (t) => {
  fakeChild(t, (child) => { child.emit("message", completed); child.emit("close", 0); });
  t.mock.method(windowsProcessIO, "own", async () => ({ close: async () => false }));
  const outcome = await runSubagent(run);
  assert.equal(outcome.type, "failed");
  assert.deepEqual(outcome.report?.accounting, { status: "reported", stats, complete: false });
});

function checkedProgress(updates: readonly { readonly details?: unknown; readonly content: unknown }[], status: "positive_reply" | "non_positive_reply", requests: number): { readonly phase: string }[] {
  const workflow: { phase: string }[] = [], diagnostics: ApprovalUiDiagnostic[] = [];
  for (const update of updates) {
    const data = update.details as { kind?: string; phase?: string; approvalUi?: ApprovalUiDiagnostic; plan?: unknown };
    if (data.kind === "approval_ui_diagnostic") {
      assert.equal(data.phase, undefined); assert.deepEqual(Object.keys(data).sort(), ["approvalUi", "kind"]);
      const text = approvalUiText(data.approvalUi); assert.ok(text); assert.ok(data.approvalUi);
      assert.deepEqual(update.content, [{ type: "text", text: `JEV · ${text}` }]);
      assert.equal(data.approvalUi.executionAuthorized, false); diagnostics.push(data.approvalUi);
    } else if (data.kind === "execution_plan") {
      assert.deepEqual(Object.keys(data).sort(), ["kind", "plan"]); assert.equal(validPlanReceipt(data.plan), true);
      assert.doesNotMatch(JSON.stringify(data.plan), /systemPrompt|private-progress-error/);
    } else {
      assert.equal(typeof data.phase, "string"); assert.deepEqual(Object.keys(data), ["phase"]); workflow.push({ phase: data.phase! });
    }
  }
  assert.equal(diagnostics.at(-1)?.phase, "finished"); assert.equal(diagnostics.at(-1)?.status, status);
  assert.equal(diagnostics.at(-1)?.requests, requests); assert.equal(diagnostics.at(-1)?.replies, requests);
  assert.equal(diagnostics.filter(value => value.phase === "requesting").length, requests);
  assert.equal(diagnostics.filter(value => value.phase === "returned").length, requests);
  assert.doesNotMatch(JSON.stringify(diagnostics), /systemPrompt|test-provider|test-model|private-progress-error/);
  return workflow;
}

test("delegate pi tool is sequential and has no approval bypass parameter", async (t) => {
  const tools: ToolDefinition[] = [];
  jevRouter({ registerTool: (tool: ToolDefinition) => { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find((tool) => tool.name === "jev_delegate")!;
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(tool.parameters, DelegateToolInputSchema);
  assert.equal("auto" in DelegateToolInputSchema.anyOf[0]!.properties, true);
  assert.deepEqual(DelegateToolInputSchema.anyOf[1], OrdinaryDelegateInputSchema);
  for (const key of ["approved", "grant", "restore", "state", "reviewText", "receipt", "execution_reply", "fullAccess"]) {
    assert.equal(Value.Check(tool.parameters, { ...input, [key]: true }), false);
    assert.equal(Value.Check(tool.parameters, { scope: {}, [key]: true }), false);
  }
  assert.deepEqual(Object.keys(OrdinaryDelegateInputSchema.properties), ["task", "agents", "skillCandidates", "verification", "acceptanceCriteria", "maxModelCalls", "seconds", "softRouting"]);
  mockRouting(t);
  const updates = t.mock.fn<NonNullable<Parameters<ToolDefinition["execute"]>[3]>>(() => { throw new Error("private-progress-error"); });
  await assert.rejects(tool.execute("test", input, undefined, updates, context(async () => false)), (error: Error) => {
    assert.match(error.message, /declined/);
    assert.ok(!error.message.includes("private-progress-error"));
    const record = JSON.parse(error.message.split("\n").at(-1)!);
    assert.equal(record.metrics.jev.status, "reported");
    assert.equal(record.costEstimate.workerUsd, 0);
    return true;
  });
  assert.deepEqual(checkedProgress(updates.mock.calls.map(call => call.arguments[0]), "non_positive_reply", 1),
    ["loading", "routing", "awaiting_approval"].map((phase) => ({ phase })));
});

test("removed Sol-Pi and advanced inputs stop before routing, native approval, child launch or source loading", async t => {
  const tools: ToolDefinition[] = [];
  jevRouter({ registerTool: (tool: ToolDefinition) => { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!;
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("No routing"));
  const fork = t.mock.method(childProcess, "fork", () => assert.fail("No worker/harness"));
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => assert.fail("No approval"));
  const ctx = context(confirm);
  for (const value of [{ ...input, solPi: { sourceDirectory: "PRIVATE_STANDALONE_SOURCE", storageDirectory: "PRIVATE_STORE" } },
    { ...input, solPi: undefined }, { ...input, planner: "worker" }, { ...input, journalDirectory: "PRIVATE_JOURNAL" }]) {
    assert.equal(Value.Check(DelegateToolInputSchema, value), false);
    await assert.rejects(tool.execute("removed", value, t.signal, undefined, ctx), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /not available/); assert.doesNotMatch(error.message, /PRIVATE_/); return true;
    });
  }
  assert.equal(fetch.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0); assert.equal(confirm.mock.callCount(), 0);
  assert.match(tool.promptGuidelines!.join("\n"), /standalone SoL-Pi stays separate/);
});

test("tool-only progress cannot fail approved work or touch the footer, widgets, or notifications", async (t) => {
  const tools: ToolDefinition[] = [];
  jevRouter({ registerTool: (tool: ToolDefinition) => { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find((tool) => tool.name === "jev_delegate")!;
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const ctx = context(confirm);
  const otherUI = t.mock.fn(() => {});
  Object.assign(ctx.ui, { setStatus: otherUI, setWidget: otherUI, setFooter: otherUI, notify: otherUI });
  const http = t.mock.method(globalThis, "fetch");
  for (const asyncFailure of [false, true]) {
    const updates = t.mock.fn<NonNullable<Parameters<ToolDefinition["execute"]>[3]>>(() => {
      if (asyncFailure) return Promise.reject(new Error("private-progress-error"));
      throw new Error("private-progress-error");
    });
    const { fork } = fakeChild(t, (child) => { child.emit("message", completed); child.emit("close", 0); });
    const response = await tool.execute("test", { ...input, agents: ["worker"] }, undefined, updates, ctx);
    assert.equal((response.details as State).status, "succeeded");
    assert.ok(!JSON.stringify(response).includes("private-progress-error"));
    assert.deepEqual(checkedProgress(updates.mock.calls.map(call => call.arguments[0]), "positive_reply", 1),
      ["loading", "awaiting_approval", "running"].map((phase) => ({ phase })));
    assert.equal(fork.mock.callCount(), 1);
  }
  assert.equal(confirm.mock.callCount(), 2);
  assert.equal(confirm.mock.calls.filter(c => c.arguments[0].startsWith("JEV · Approve this exact execution?")).length, 2);
  assert.equal(http.mock.callCount(), 0);
  assert.equal(otherUI.mock.callCount(), 0);
});

test("successful tool summaries preserve model, thinking, raw worker text and incomplete cost without controlling parent turns", async (t) => {
  const tools: ToolDefinition[] = [];
  jevRouter({ registerTool: (tool: ToolDefinition) => { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find((tool) => tool.name === "jev_delegate")!;
  const explicitModel = { provider: "openai-codex", id: "offline-codex" };
  for (const name of input.agents) await writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: Offline fixture\ntools: read\nmodel: openai-codex/offline-codex\nthinking: high\n---\nOffline fixture.`);
  t.mock.method(ModelRuntime, "create", async () => ({ getAvailableSnapshot: () => [
    { ...explicitModel, api: "openai-codex-responses", reasoning: true, contextWindow: 32_000 },
  ] } as unknown as ModelRuntime));
  const http = mockRouting(t);
  const workerResult = { ...result, text: "First line.\n\n둘째 줄.\n", truncated: true };
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  for (const source of ["direct", "jev"] as const) {
    const reply = { ...completed, result: workerResult, report: { ...completed.report,
      thinking: { requested: "high", applied: "high" }, accounting: { ...completed.report.accounting, complete: false } } };
    const { fork } = fakeChild(t, (child) => { child.emit("message", reply); child.emit("close", 0); });
    const response = await tool.execute("test", { ...input, agents: source === "direct" ? ["worker"] : input.agents }, undefined, undefined, context(confirm));
    const state = response.details as State;
    assert.ok(state.status === "succeeded");
    const text = response.content[0]!;
    assert.ok(text.type === "text");
    const end = text.text.indexOf("\n\n");
    assert.deepEqual(JSON.parse(text.text.slice(0, end)), {
      status: "succeeded", taskAcceptance: "needs_human_review", agent: "worker", model: explicitModel, thinking: "high", decision: { source },
      verification: { status: "not_requested" }, assessment: { status: "not_requested" },
      costEstimate: { observedUsd: estimateCost(state.metrics).observedUsd, delegationTotalUsd: null }, truncated: true,
    });
    assert.equal(text.text.slice(end + 2), workerResult.text);
    assert.deepEqual(state.result, workerResult);
    assert.equal(state.decision.agent, "worker");
    assert.deepEqual(state.metrics.worker.accounting, reply.report.accounting);
    assert.deepEqual(state.metrics.worker.thinking, reply.report.thinking);
    assert.equal("terminate" in response, false);
    assert.equal(fork.mock.callCount(), 1);
  }
  assert.equal(confirm.mock.callCount(), 2);
  assert.equal(confirm.mock.calls.filter(c => c.arguments[0].startsWith("JEV · Approve this exact execution?")).length, 2);
  assert.equal(http.mock.callCount(), 1);
});

test("one explicit candidate skips JEV and parent-model inheritance, but still requires approval", async (t) => {
  delete process.env.TYPESAFE_API_KEY;
  const http = t.mock.method(globalThis, "fetch");
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const { fork } = fakeChild(t, (child) => { child.emit("message", completed); child.emit("close", 0); });
  const state = await delegate({ ...input, agents: ["worker"] }, { ...context(confirm), model: undefined });
  assert.equal(state.status, "succeeded");
  if (state.status !== "succeeded") return;
  assert.deepEqual(state.decision, { source: "direct", agent: "worker" });
  assert.deepEqual(state.model, model);
  assert.deepEqual(state.verification, { status: "not_requested" });
  assert.equal(http.mock.callCount(), 0);
  assert.equal(confirm.mock.callCount(), 1);
  assert.match(confirm.mock.calls[0]!.arguments[0], /Approve this exact execution/);
  assert.equal(fork.mock.callCount(), 1);
  assert.equal(state.metrics.jev.status, "not_requested");
  assert.equal(estimateCost(state.metrics).delegationTotalUsd, stats.cost);
  for (const phase of ["loading", "awaiting_approval", "running"] as const) assert.ok(state.metrics.phasesMs[phase]! >= 0);
  assert.equal(state.metrics.worker.startupMs, 2);
  assert.equal(state.metrics.worker.executionMs, 3);
});

test("verification is a separate approved effect; exit failure cannot become success or retry", () => {
  const verification = { command: "node", args: ["--test"] };
  let transition = reduce(initialState(), { type: "start", canConfirm: true,
    job: { ...job, input: { ...input, agents: ["worker"], verification } } });
  transition = reduce(transition.state, { type: "agents_loaded", agents: [agents[1]!] });
  assert.equal(transition.effects[0]?.type, "confirm_run");
  assert.equal(transition.state.status, "awaiting_approval");
  if (transition.state.status !== "awaiting_approval") return;
  assert.deepEqual(transition.state.run.verification, verification);
  transition = reduce(transition.state, { type: "approval", approved: true });
  const before = structuredClone(transition.state);
  const verifying = reduce(Object.freeze(transition.state), { ...completed, timing: { effectMs: 5, elapsedMs: 9 } });
  assert.deepEqual(transition.state, before);
  assert.equal(verifying.state.status, "verifying");
  assert.deepEqual(verifying.effects, [{ type: "verify", cwd: job.cwd, command: verification }]);
  const invalid = reduce(verifying.state, { type: "verified", result: { status: "passed", exitCode: 1 } } as unknown as Event);
  assert.equal(invalid.state.status, "failed");
  for (const result of [{ status: "passed", exitCode: 0 }, { status: "failed", exitCode: 1 }, { status: "timed_out", exitCode: null }] as const) {
    const done = reduce(verifying.state, { type: "verified", result, timing: { effectMs: 2, elapsedMs: 11 } });
    assert.equal(done.state.status, result.status === "passed" ? "succeeded" : "failed");
    assert.deepEqual(done.effects, []);
    assert.equal(done.state.metrics.phasesMs.verifying, 2);
    assert.equal(done.state.metrics.elapsedMs, 11);
    assert.equal(estimateCost(done.state.metrics).workerUsd, stats.cost);
    assert.deepEqual(reduce(done.state, completed), { state: done.state, effects: [] });
  }
  assert.equal(reduce(verifying.state, { type: "cancel" }).state.status, "cancelled");
});

test("failed/cancelled executions retain partial costs; unknown usage never becomes a zero total", () => {
  let t = reduce(initialState(), { type: "start", job, canConfirm: true });
  t = reduce(t.state, { type: "agents_loaded", agents });
  const routeFailure = reduce(t.state, { type: "failed", error: "offline" });
  assert.equal(estimateCost(routeFailure.state.metrics).delegationTotalUsd, null);
  t = reduce(t.state, { type: "resolved", decision });
  t = reduce(t.state, { type: "approval", approved: true });
  const killed = reduce(t.state, { type: "cancel" });
  assert.equal(estimateCost(killed.state.metrics).workerUsd, null);
  assert.deepEqual(killed.state.metrics.profile, { agent: "worker", model, source: "jev", maxModelCalls: null, seconds: 86_400 });
  const partial = reduce(t.state, { type: "cancel", report: {
    ...completed.report, accounting: { status: "reported", stats, complete: false },
  } });
  assert.equal(partial.state.status, "cancelled");
  const cost = estimateCost(partial.state.metrics);
  assert.equal(cost.delegationTotalUsd, null);
  assert.ok(cost.observedUsd >= stats.cost);
  assert.ok(cost.jevUsd! > 0);
  const cancelledLateSuccess = reduce(t.state, { ...completed, aborted: true });
  assert.equal(cancelledLateSuccess.state.status, "cancelled");
  assert.equal(cancelledLateSuccess.state.metrics.worker.accounting.status, "reported");
});

test("worker diagnostics cross the reducer boundary only as validated data and never trigger work", () => {
  let transition = reduce(initialState(), { type: "start", job, canConfirm: true });
  transition = reduce(transition.state, { type: "agents_loaded", agents });
  transition = reduce(transition.state, { type: "resolved", decision });
  transition = reduce(transition.state, { type: "approval", approved: true });
  const before = structuredClone(transition.state);
  const event = { type: "failed", error: WORKER_ERROR, report: { ...completed.report,
    accounting: { ...completed.report.accounting, complete: false },
    diagnostic: { category: "request_rejected", httpStatus: 400 },
  } } as const;
  const failed = reduce(Object.freeze(transition.state), event);
  assert.deepEqual(transition.state, before);
  assert.equal(failed.state.status, "failed");
  assert.deepEqual(failed.state.metrics.worker.diagnostic, event.report.diagnostic);
  assert.equal(estimateCost(failed.state.metrics).workerUsd, null);
  assert.deepEqual(failed.effects, []);
  assert.deepEqual(reduce(failed.state, completed), { state: failed.state, effects: [] });
  for (const diagnostic of [
    { category: "offline-secret", httpStatus: 400 }, { category: "unknown", httpStatus: 999 },
    { category: "unknown", httpStatus: NaN }, { category: "unknown", httpStatus: 400.5 },
    { category: "unknown", httpStatus: null, message: "offline-secret" },
  ]) {
    const invalid = reduce(transition.state, { ...event, report: { ...event.report, diagnostic } } as unknown as Event);
    assert.equal(invalid.state.status, "failed");
    assert.ok(!JSON.stringify(invalid).includes("offline-secret"));
    assert.deepEqual(invalid.effects, []);
  }
});

test("invalid verification input never routes, approves, or executes", async (t) => {
  const http = t.mock.method(globalThis, "fetch");
  const confirm = t.mock.fn(async () => true);
  for (const verification of [
    { command: "", args: [] }, { command: "node\u0000", args: [] }, { command: "node", args: ["\u0000"] },
    { command: "node", args: [], shell: true }, { command: "node", args: Array(33).fill("x") },
  ]) {
    assert.equal((await delegate({ ...input, verification }, context(confirm))).status, "failed");
  }
  assert.equal(http.mock.callCount(), 0);
  assert.equal(confirm.mock.callCount(), 0);
});

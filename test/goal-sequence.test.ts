import assert from "node:assert/strict";
import { dockerFixture, IMAGE, type Container } from "./helpers/goal-docker-fixture.ts";
import childProcess from "node:child_process";
import { once } from "node:events";
import { teardownOwnedFixture } from "./helpers/owned-fixture-teardown.ts";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm, lstat, open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareSequence, goalSequence, checkSequenceLease, runSequenceOperation } from "../src/goal-sequence-effects.ts";
import { goalRun } from "../src/goal-run-effects.ts";
import { SequenceInputSchema, reduceSequence, validSequenceGrant, validSequenceInput, validSequenceOperation, sequenceSession, singleRunInput,
  type SequenceInput, type SequenceState, type SequenceResult, type SequenceOperation, type SequenceObservation, type SequenceEvent, type SequenceEffect } from "../src/goal-sequence.ts";
import { GOAL_PROJECT_LOCK, EMPTY_FILE_REPORT, goalLockText } from "../src/goal-run.ts";
import { goalFileDigest } from "../src/goal-files.ts";
import { syntheticPacketCustom } from "./helpers/native-packet.ts";
import { decodeGoalJournal } from "../src/goal-journal.ts";
import { executeSequenceWorker } from "../src/goal-sequence-worker.ts";

async function fixture(t: TestContext, mode = "edit") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "jev-sequence-"))), cwd = path.join(root, "work"), agentDir = path.join(root, "config"), journal = path.join(root, "journal");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const invocations: Promise<unknown>[] = [];
  let stop = async () => {}, release = async () => {};
  t.after(() => teardownOwnedFixture({ stop: () => stop(), invocations: () => invocations, release: () => release(),
    async hasMarker() {
      for (const marker of [path.join(cwd, GOAL_PROJECT_LOCK), path.join(journal, "owner.lock")]) {
        try { await lstat(marker); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
      }
      return false;
    }, remove: () => rm(root, { recursive: true, force: true }),
    reset() { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; },
  }).then(() => {}));
  for (const dir of [cwd, agentDir, journal, path.join(agentDir, "agents")]) await mkdir(dir, { mode: 0o700 });
  const file = path.join(cwd, "fixture.txt"), initial = "A=BEFORE\nB=BEFORE\nSOURCE_ONLY_DO_NOT_FORWARD\n";
  await writeFile(file, initial); await writeFile(path.join(cwd, "AGENTS.md"), "Only change the approved fixture. Do not claim verification.");
  for (const name of ["planner", "worker"]) await writeFile(path.join(agentDir, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: Offline ${name}\nmodel: offline/offline-${name}\ntools: read,edit,write,bash\n---\nFollow the approved task and response format.\n`);
  await writeFile(path.join(agentDir, "SYSTEM.md"), "UNAPPROVED_GLOBAL_PROMPT");
  await mkdir(path.join(cwd, ".pi/extensions"), { recursive: true });
  await writeFile(path.join(cwd, ".pi/extensions/forbidden.ts"), 'throw new Error("PROJECT_EXTENSION_MUST_NOT_LOAD");');
  type Request = { model: string; messages: { role: string; content: string | { type: string; text?: string }[] }[]; tools?: { function: { name: string } }[] };
  const requests: Request[] = [];
  let received = () => {};
  const firstRequest = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw) as Request;
    requests.push(request); received();
    const planner = request.model === "offline-planner";
    if (mode === "hold" || mode === "worker_hold" && !planner) return;
    if (mode === "error") { res.writeHead(400); res.end('{"error":{"message":"PRIVATE_PROVIDER_ERROR"}}'); return; }
    const user = request.messages.find((message) => message.role === "user")!.content;
    const packet = JSON.parse(typeof user === "string" ? user : user.map((part) => part.text ?? "").join(""));
    const step = planner ? packet.history.length : Number(packet.assigned.criteriaIds[0].slice(-1)) - 1;
    const done = request.messages.some((message) => message.role === "tool");
    let content: string;
    if (planner) content = mode === "malformed" ? "```json\n{}\n```" : JSON.stringify(mode === "stop" ? { action: "stop", reason: "Needs human input" } :
      { action: "work", criteriaIds: [mode === "foreign" ? "criterion-8" : mode === "repeat" ? "criterion-1" : `criterion-${step + 1}`], task: mode === "repeat_task" ? "Same task under another criterion." : `Change ${step === 0 ? "A" : "B"}=BEFORE to AFTER.` });
    else content = JSON.stringify({ status: mode === "blocked" ? "blocked" : "reported_done", summary: "WORKER_SUMMARY_DO_NOT_FORWARD" });
    let tools: { index: number; id: string; type: string; function: { name: string; arguments: string } }[] = [];
    const tool = (index: number, name: string, args: unknown) => ({ index, id: `call-${requests.length}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
    if (planner && mode === "planner_tool") tools = [tool(0, "goal_read", { fileId: "file-1" })];
    if (!planner && (!done || mode === "loop")) tools = [tool(0, "goal_read", { fileId: "file-1" }),
      tool(1, "goal_edit", { fileId: "file-1", oldText: `${step === 0 ? "A" : "B"}=${packet.repairOf ? "PARTIAL" : "BEFORE"}`, newText: `${step === 0 ? "A" : "B"}=${mode === "repair" && step === 0 && !packet.repairOf ? "PARTIAL" : "AFTER"}` })];
    if (!planner && done && mode === "last_change") await writeFile(file, "EXTERNAL CHANGE\n");
    const delta = tools.length ? { role: "assistant", tool_calls: tools } : { role: "assistant", content };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: request.model,
      choices: [{ index: 0, delta, finish_reason: tools.length ? "tool_calls" : "stop" }],
      ...(mode === "missing_usage" ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const closeServer = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  release = closeServer;
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { offline: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "offline-sequence-key",
    models: ["planner", "worker"].map((name) => ({ id: `offline-${name}`, reasoning: false, contextWindow: 65536, maxTokens: 1024, cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 } })) } } }));
  const fork = childProcess.fork;
  const launches = t.mock.method(childProcess, "fork", (modulePath: string | URL, args: readonly string[], options: childProcess.ForkOptions) => fork(modulePath, args,
    { ...options, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) } }));
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("External HTTP forbidden"); });
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "legacy-sequence-fixture" }, ui: { confirm } } as unknown as ExtensionContext;
  const input: SequenceInput = { task: "Change A and B from BEFORE to AFTER in the approved file.", agent: "worker", planner: "planner", files: [{ path: "fixture.txt", access: "read_write" }],
    journalDirectory: journal, acceptanceCriteria: ["A is changed.", "B is changed."], nonGoals: ["Do not alter the sentinel."], maxModelCalls: 2,
    budget: { workerRuns: 2, plannerCalls: 3, workerCalls: 4, totalCalls: 7, durationSeconds: 120 } };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("./helpers/legacy-goal-extension.ts", import.meta.url))] });
  await loader.reload(); const loaded = loader.getExtensions();
  release = async () => { await closeServer(); loaded.runtime.invalidate(); };
  assert.deepEqual(loaded.errors, []); const extension = loaded.extensions[0]!;
  stop = async () => {
    for (const handler of extension.handlers.get("session_shutdown") ?? []) await Reflect.apply(handler, undefined, [{ type: "session_shutdown" }, ctx]);
  };
  const tool = [...extension.tools.values()].find((entry) => entry.definition.name === "jev_goal_sequence")!.definition;
  const invoke = async (signal?: AbortSignal): Promise<SequenceResult> => {
    try { const work = tool.execute("sequence", input, signal, undefined, ctx); invocations.push(work); return (await work).details as SequenceResult; }
    catch (error) { assert.ok(error instanceof Error); assert.ok(!error.message.includes("PRIVATE_PROVIDER_ERROR")); assert.ok(error.message.includes("\n"), error.message);
      return JSON.parse(error.message.slice(error.message.indexOf("\n") + 1)); }
  };
  const revoke = async (name = "session_before_tree") => { for (const handler of extension.handlers.get(name) ?? []) await Reflect.apply(handler, undefined, [{ type: name }, ctx]); };
  const inspect = async () => decodeGoalJournal(await readFile(path.join(journal, "goal.jsonl")));
  return { root, cwd, agentDir, journal, file, initial, input, ctx, confirm, requests, firstRequest, launches, fetch, invoke, revoke, inspect, tool, extension };
}
async function routingFixture(t: TestContext, mode = "edit") {
  const f = await fixture(t, mode);
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "offline-goal-routing-key";
  t.after(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  await writeFile(path.join(f.agentDir, "agents/strong.md"),
    "---\nname: strong\ndescription: Another explicitly permitted worker\nmodel: offline/offline-strong\ntools: read,edit,write\n---\nSTRONG_PROFILE_DO_NOT_FORWARD. Follow the approved task and response format.\n");
  const modelPath = path.join(f.agentDir, "models.json"), models = JSON.parse(await readFile(modelPath, "utf8"));
  models.providers.offline.models.push({ ...models.providers.offline.models[1], id: "offline-strong" });
  await writeFile(modelPath, JSON.stringify(models));
  Object.assign(f.input, { routing: { additionalAgents: ["strong"], summary: "Change the two declared values.", maxCalls: 2 } });
  f.input.budget.totalCalls = 8;
  // Exercise the same exact SDK editor receipt as the native production boundary.
  const custom = t.mock.fn(syntheticPacketCustom());
  Object.assign(f.ctx.ui, { custom });
  f.fetch.mock.mockImplementation(async (_url, options) => {
    assert.equal(String(_url), "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(options?.body)), state = JSON.parse(body.state);
    const agent = state.criteria[0].id === "criterion-1" ? "strong" : "worker";
    return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
      answers: { agent: { type: "choice", choice: agent, confidence: 0.9,
        probabilities: { worker: agent === "worker" ? 0.9 : 0.1, strong: agent === "strong" ? 0.9 : 0.1 } } } }));
  });
  return { ...f, custom };
}

test("parent dispatch assigns approved fixed workers without JEV or per-subtask approval", { timeout: 30_000 }, async t => {
  const f = await routingFixture(t); delete f.input.routing;
  f.input.dispatch = { additionalAgents: ["strong"], assignments: [{ criterionId: "criterion-1", agent: "strong" }, { criterionId: "criterion-2", agent: "worker" }] };
  f.fetch.mock.mockImplementation(async () => { throw new Error("Parent dispatch must not call JEV"); });
  assert.ok(validSequenceInput(f.input));
  for (const dispatch of [
    { ...f.input.dispatch, assignments: [{ criterionId: "criterion-1", agent: "strong" }] },
    { ...f.input.dispatch, assignments: [{ criterionId: "criterion-1", agent: "outside" }, { criterionId: "criterion-2", agent: "worker" }] },
  ]) assert.equal(validSequenceInput({ ...f.input, dispatch }), false);
  assert.equal(validSequenceInput({ ...f.input, routing: { additionalAgents: [], summary: "Public", maxCalls: 0 } }), false);
  const done = await f.invoke(t.signal);
  assert.equal(done.status, "completed_unverified", JSON.stringify({ reason: done.reason, history: done.history.map(item => item.plan), spent: done.ledger?.spent,
    lastKind: done.lastOperation?.operation.kind, started: done.lastOperation?.observation?.started, cleanup: done.lastOperation?.observation?.cleanupConfirmed,
    reply: done.lastOperation?.observation?.result?.reply.type, fixtureModels: f.requests.map(request => request.model) }));
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.confirm.mock.callCount(), 1); assert.match(f.confirm.mock.calls[0]!.arguments[1], /PARENT DISPATCH/);
  assert.match(f.confirm.mock.calls[0]!.arguments[1], /No per-subtask approval/);
  assert.deepEqual(f.requests.filter(r => r.model !== "offline-planner").map(r => r.model), ["offline-strong", "offline-strong", "offline-worker", "offline-worker"]);
  assert.deepEqual(done.history.map(task => task.plan?.source), ["parent", "parent"]); assert.deepEqual(done.history.map(task => task.plan?.agent), ["strong", "worker"]);
  assert.equal(done.ledger?.spent.jevCalls, 0); assert.equal(done.taskAcceptance, "needs_review");
});

test("parent dispatch decline cannot start planner, worker, JEV or journal activation", { timeout: 30_000 }, async t => {
  const f = await routingFixture(t); delete f.input.routing;
  f.input.dispatch = { additionalAgents: ["strong"], assignments: [{ criterionId: "criterion-1", agent: "strong" }, { criterionId: "criterion-2", agent: "worker" }] };
  f.confirm.mock.mockImplementation(async () => false);
  const done = await f.invoke(t.signal); assert.equal(done.status, "cancelled"); assert.equal(f.requests.length, 0); assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.fetch.mock.callCount(), 0);
});

test("JEV Goal selects each worker inside the shared budget; only approved summary/criteria/rubrics leave the process", { timeout: 30_000 }, async (t) => {
  const f = await routingFixture(t), done = await f.invoke(t.signal);
  assert.equal(done.status, "completed_unverified", JSON.stringify(done));
  assert.equal(done.ledger?.spent.jevCalls, 2);
  assert.equal(done.ledger?.spent.plannerCalls, 2); assert.equal(done.ledger?.spent.workerCalls, 4);
  assert.equal(f.fetch.mock.callCount(), 2); assert.equal(f.custom.mock.callCount(), 1);
  assert.deepEqual(f.requests.map(request => request.model), ["offline-planner", "offline-strong", "offline-strong", "offline-planner", "offline-worker", "offline-worker"]);
  for (const call of f.fetch.mock.calls) {
    const wire = String(call.arguments[1]?.body);
    for (const forbidden of [f.cwd, f.agentDir, "STRONG_PROFILE_DO_NOT_FORWARD", "SOURCE_ONLY_DO_NOT_FORWARD", "WORKER_SUMMARY_DO_NOT_FORWARD", "Change A=BEFORE", "offline-goal-routing-key"])
      assert.ok(!wire.includes(forbidden), forbidden);
  }
  const stored = await f.inspect(); assert.deepEqual(done.ledger, stored.ledger);
  assert.equal(done.lockRetained, false); assert.equal(done.taskAcceptance, "needs_review");
  assert.equal(await readFile(f.file, "utf8"), f.initial.replaceAll("BEFORE", "AFTER"));
});

function result(state: SequenceState) { assert.equal(state.status, "done"); if (state.status !== "done") throw new Error("Nonterminal"); return state.result; }
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }
function report(operation: SequenceOperation, answer?: unknown): SequenceObservation {
  const stats = { turns: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 };
  return { started: true, cleanupConfirmed: true, result: { type: "goal_result", operationId: operation.id, scope: structuredClone(operation.scope), files: { ...EMPTY_FILE_REPORT, uncertain: false, finished: true },
    reply: { type: "completed", result: { ...stats, text: JSON.stringify(answer ?? (operation.kind === "planner" ?
      { action: "work", criteriaIds: [`criterion-${operation.history.length + 1}`], task: `One bounded task ${operation.history.length + 1}.` } : { status: "reported_done", summary: "Unverified claim" })), truncated: false },
      report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "reported", complete: true, stats } } } } };
}

test("JEV Goal fails closed before calls on denial, missing UI/key, unsupported candidates and approval-time changes", async (t) => {
  for (const mode of ["no_ui", "no_custom", "decline", "key", "profile", "models", "files", "unsupported", "duplicate"]) await t.test(mode, async (t) => {
    const f = await routingFixture(t);
    if (mode === "no_ui") f.ctx.hasUI = false;
    if (mode === "no_custom") delete (f.ctx.ui as Partial<ExtensionContext["ui"]>).custom;
    if (mode === "decline") f.custom.mock.mockImplementation(async <T>() => false as T);
    if (mode === "key") delete process.env.TYPESAFE_API_KEY;
    if (mode === "duplicate") f.input.routing!.additionalAgents = ["worker"];
    if (mode === "unsupported") await writeFile(path.join(f.agentDir, "agents/strong.md"),
      "---\nname: strong\ndescription: Unsupported effort\nmodel: offline/offline-strong\nthinking: max\ntools: read,edit,write\n---\nNo automatic substitute.\n");
    if (["profile", "models", "files"].includes(mode)) f.custom.mock.mockImplementation(syntheticPacketCustom(async () => {
      const file = mode === "profile" ? path.join(f.agentDir, "agents/strong.md") : mode === "models" ? path.join(f.agentDir, "models.json") : f.file;
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
    }));
    const done = await f.invoke(t.signal);
    assert.ok(["failed", "cancelled", "needs_review"].includes(done.status));
    assert.equal(f.requests.length, 0); assert.equal(f.fetch.mock.callCount(), 0); assert.equal(f.launches.mock.callCount(), 0);
    await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK)));
  });
});

test("JEV Goal rejects failed, malformed, foreign, unpinned or insufficient advice without a paid fallback", async (t) => {
  for (const mode of ["http", "transport", "json", "foreign", "model", "usage", "distribution", "weak", "scope", "key_removed"]) await t.test(mode, async (t) => {
    const f = await routingFixture(t);
    if (mode === "weak") {
      await writeFile(path.join(f.agentDir, "agents/other.md"), "---\nname: other\ndescription: Third candidate\nmodel: offline/offline-strong\ntools: read,edit,write\n---\nOnly approved work.\n");
      f.input.routing!.additionalAgents.push("other");
    }
    f.fetch.mock.mockImplementation(async () => {
      if (mode === "http") return new Response("PRIVATE_HTTP_ROUTING_BODY", { status: 400 });
      if (mode === "transport") throw new Error("PRIVATE_TRANSPORT_ROUTING_ERROR");
      if (mode === "json") return new Response("PRIVATE_INVALID_ROUTING_BODY");
      if (mode === "scope") await writeFile(f.file, "EXTERNAL CHANGE\n");
      return new Response(JSON.stringify({ model: mode === "model" ? "unapproved-version" : "jev-1.13.0",
        ...(mode === "usage" ? {} : { usage: { input_tokens: 100, output_tokens: 10 } }),
        answers: { agent: { type: "choice", choice: mode === "foreign" ? "unapproved" : "strong", confidence: 0.9,
          ...(mode === "distribution" ? {} : { probabilities: mode === "weak" ? { strong: 0.4, worker: 0.35, other: 0.25 } : { strong: 0.9, worker: 0.1 } }) } } }));
    });
    const operations: string[] = [];
    const done = result(await goalSequence(f.input, f.ctx, t.signal, undefined, async (grant, lease, operation, signal) => {
      operations.push(operation.kind);
      if (operation.kind === "routing" && mode === "key_removed") delete process.env.TYPESAFE_API_KEY;
      return operation.kind === "routing" ? runSequenceOperation(grant, lease, operation, signal) : report(operation);
    }));
    assert.equal(done.status, "needs_review"); assert.deepEqual(operations, ["planner", "routing"]);
    assert.equal(f.fetch.mock.callCount(), mode === "key_removed" ? 0 : 1); assert.equal(done.ledger?.spent.jevCalls, mode === "key_removed" ? 0 : 1); assert.equal(done.ledger?.spent.workerRuns, 0);
    assert.equal(done.routing[0]?.agent, null); assert.equal(done.lockRetained, true);
    if (mode === "weak") assert.equal(done.routing[0]?.reason, "weak_support");
    if (mode === "key_removed") assert.equal(done.routing[0]?.attempted, false);
    assert.ok(!JSON.stringify(done).includes("PRIVATE_"));
    if (["http", "transport", "json", "model", "usage", "scope"].includes(mode)) assert.equal(done.ledger?.totalUsd, null);
    else assert.ok(done.ledger!.totalUsd! > 0);
  });
});

test("JEV Goal one-candidate bypass and cumulative lookahead never buy a route or planner without worker budget", async (t) => {
  for (const mode of ["single", "route_limit", "total_limit"]) await t.test(mode, async (t) => {
    const f = await routingFixture(t);
    if (mode === "single") { f.input.routing!.additionalAgents = []; f.input.routing!.maxCalls = 0; delete process.env.TYPESAFE_API_KEY; }
    if (mode === "route_limit") f.input.routing!.maxCalls = 1;
    if (mode === "total_limit") f.input.budget.totalCalls = 4;
    const operations: string[] = [];
    const done = result(await goalSequence(f.input, f.ctx, t.signal, (_phase, progress) => {
      if (progress?.settled) progress.settled.jevCalls = 999; // Presentation receives copies, never mutable machine state.
      throw new Error("PRIVATE_UI_ERROR");
    }, async (grant, lease, operation, signal) => {
      operations.push(operation.kind);
      return operation.kind === "routing" ? runSequenceOperation(grant, lease, operation, signal) : report(operation);
    }));
    assert.equal(done.status, mode === "single" ? "completed_unverified" : "needs_review");
    assert.deepEqual(operations, mode === "single" ? ["planner", "worker", "planner", "worker"] : ["planner", "routing", "worker"]);
    assert.equal(f.fetch.mock.callCount(), mode === "single" ? 0 : 1);
    assert.equal(done.ledger?.spent.jevCalls, mode === "single" ? 0 : 1);
    assert.equal(done.history[0]?.plan?.source, mode === "single" ? "single_candidate" : "jev");
    assert.equal(done.lockRetained, false);
  });
});

test("JEV Goal cancellation keeps observed response usage and cannot authorize a worker or late restart", async (t) => {
  const f = await routingFixture(t), controller = new AbortController(), operations: string[] = [];
  f.fetch.mock.mockImplementation(async () => {
    controller.abort();
    return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 100, output_tokens: 10 },
      answers: { agent: { type: "choice", choice: "strong", confidence: 0.9, probabilities: { worker: 0.1, strong: 0.9 } } } }));
  });
  const state = await goalSequence(f.input, f.ctx, controller.signal, undefined, async (grant, lease, operation, signal) => {
    operations.push(operation.kind);
    return operation.kind === "routing" ? runSequenceOperation(grant, lease, operation, signal) : report(operation);
  });
  const done = result(state);
  assert.equal(done.status, "cancelled"); assert.deepEqual(operations, ["planner", "routing"]);
  assert.equal(done.routing[0]?.report?.usage.inputTokens, 100); assert.equal(done.ledger?.spent.jevCalls, 1);
  assert.ok(done.ledger!.observedUsd > 0); assert.equal(done.ledger?.totalUsd, null);
  for (const event of [{ type: "cancel" }, { type: "failed" }] satisfies SequenceEvent[]) assert.deepEqual(reduceSequence(state, event), { state, effects: [] });
});

test("JEV Goal admitted selections are journal-bound, never replaceable by another allowed candidate", async (t) => {
  const f = await routingFixture(t);
  let checked = 0;
  const done = result(await goalSequence(f.input, f.ctx, t.signal, undefined, async (grant, lease, operation, signal) => {
    if (operation.kind === "routing") return runSequenceOperation(grant, lease, operation, signal);
    if (operation.kind === "worker") {
      assert.ok(operation.selection); assert.equal(sequenceSession(grant, operation).run.agent.name, operation.selection.agent);
      const tampered = structuredClone(operation); tampered.selection!.agent = operation.selection.agent === "worker" ? "strong" : "worker";
      await assert.rejects(checkSequenceLease(grant, lease, tampered, signal));
      await assert.rejects(executeSequenceWorker({ grant, lease, operation: tampered }, signal));
      delete tampered.selection; assert.equal(validSequenceOperation(grant, tampered), false);
      checked++;
    }
    return report(operation);
  }));
  assert.equal(done.status, "completed_unverified"); assert.equal(checked, 2); assert.equal(f.requests.length, 0);
});

test("JEV Goal C2 repair keeps the original selected model and consumes no extra route", { timeout: 30_000 }, async (t) => {
  const f = await routingFixture(t, "repair"); await enableVerification(t, f); f.input.budget.totalCalls = 11;
  const done = await f.invoke(t.signal);
  assert.equal(done.status, "completed_checked", JSON.stringify(done));
  assert.equal(done.ledger?.spent.workerRuns, 3); assert.equal(done.ledger?.spent.workerCalls, 6);
  assert.equal(done.ledger?.spent.plannerCalls, 2); assert.equal(done.ledger?.spent.jevCalls, 2); assert.equal(done.ledger?.spent.repairs, 1);
  assert.equal(f.fetch.mock.callCount(), 2);
  assert.deepEqual(f.requests.map(request => request.model), ["offline-planner", "offline-strong", "offline-strong", "offline-strong", "offline-strong", "offline-planner", "offline-worker", "offline-worker"]);
  assert.deepEqual(done.checks?.map(check => check.exitCode), [0, 42, 0, 0, 0]);
  assert.equal(done.history[0]?.selection?.agent, "strong"); assert.ok(done.history[0]?.repair);
  assert.equal(done.lockRetained, false); assert.equal(done.taskAcceptance, "needs_review");
});

test("JEV Goal reducer pins thinking, owns observations, and never advances before routing settlement acknowledgement", async (t) => {
  const f = await routingFixture(t), modelPath = path.join(f.agentDir, "models.json"), models = JSON.parse(await readFile(modelPath, "utf8"));
  models.providers["openai-codex"] = { api: "openai-codex-responses", baseUrl: "http://127.0.0.1:9", apiKey: "offline-not-used",
    models: [{ id: "goal-codex", reasoning: true, contextWindow: 65536, maxTokens: 1024, cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 } }] };
  await writeFile(modelPath, JSON.stringify(models));
  await writeFile(path.join(f.agentDir, "agents/strong.md"), "---\nname: strong\ndescription: Explicit high-thinking candidate\nmodel: openai-codex/goal-codex\nthinking: high\ntools: read,edit,write\n---\nOnly the approved task.\n");
  for (const routing of [{ ...f.input.routing!, maxCalls: 4 }, { ...f.input.routing!, maxCalls: 0 },
    { ...f.input.routing!, summary: "\ud800" }, { ...f.input.routing!, additionalAgents: ["strong", "strong"] }])
    assert.equal(validSequenceInput({ ...f.input, routing }), false);
  const grant = await prepareSequence({ cwd: f.cwd, input: f.input }, t.signal);
  for (const mode of ["normal", "lost_ack", "invalid_clock", "cancel", "wrong_thinking", "missing_thinking"]) {
    let state: SequenceState = { status: "idle" }, now = grant.body.preparedAt;
    const queue: SequenceEffect[] = [], dispatched: string[] = [];
    const send = (event: SequenceEvent) => {
      const owned = freeze(structuredClone(event)), before = freeze(state), next = reduceSequence(before, owned);
      assert.deepEqual(next, reduceSequence(before, owned)); state = next.state; queue.push(...next.effects);
    };
    send({ type: "start", job: { cwd: f.cwd, input: f.input }, hasUI: true });
    for (let i = 0; queue.length; i++) {
      assert.ok(i < 60); const effect = queue.shift()!;
      if (effect.type === "prepare_sequence") send({ type: "prepared", grant });
      else if (effect.type === "confirm_sequence") send({ type: "approval", digest: grant.ref.scopeDigest, approved: true, now: ++now });
      else if (effect.type === "open_sequence") send({ type: "opened", now: ++now, lockVersion: { ...grant.body.files.files[0]!.version,
        digest: goalFileDigest(goalLockText(grant)), bytes: Buffer.byteLength(goalLockText(grant)) } });
      else if (effect.type === "close_sequence") send({ type: "closed", ok: true, lockRetained: effect.keepLock });
      else {
        const current = effect.effect;
        if (current.type === "append_goal") {
          if (mode === "lost_ack" && current.record.type === "settled" && current.record.result.routing)
            send({ type: "control", event: { type: "storage_failed", expected: current.expected, record: current.record } });
          else send({ type: "control", event: { type: "persisted", expected: current.expected, record: current.record,
            head: { sequence: current.expected.sequence + 1, hash: goalFileDigest(JSON.stringify(current.record)) }, now: ++now } });
        } else if (current.type === "check_goal_admission") send({ type: "control", event: { type: "admission", ref: current.ref,
          activationId: current.activationId, intentId: current.intent.id, head: current.head, current: true, now: ++now } });
        else if (current.type === "stop_goal_operation") send({ type: "stop_ack" });
        else {
          assert.ok(effect.operation); const operation = effect.operation; dispatched.push(operation.kind);
          const observation: SequenceObservation = operation.kind === "routing" ? { started: true, cleanupConfirmed: true, result: null, routingCurrent: true,
            routing: { type: "resolved", decision: { agent: "strong", model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 10 }, confidence: 0.9,
              probabilities: { worker: 0.1, strong: 0.9 } } } } : report(operation);
          if (operation.kind === "worker") {
            const session = sequenceSession(grant, operation);
            assert.equal(session.run.agent.name, "strong"); assert.equal(session.run.agent.thinking, "high");
            assert.deepEqual(session.run.model, { provider: "openai-codex", id: "goal-codex" });
            if (mode !== "missing_thinking") observation.result!.reply.report.thinking = { requested: "high", applied: mode === "wrong_thinking" ? "low" : "high" };
          }
          assert.deepEqual(reduceSequence(state, { type: "observed", operationId: "foreign", observation, now }).state, state);
          if (mode === "cancel" && operation.kind === "routing") send({ type: "cancel" });
          send({ type: "observed", operationId: operation.id, observation, now: mode === "invalid_clock" && operation.kind === "routing" ? NaN : ++now });
        }
      }
    }
    const done = result(state);
    assert.equal(done.status, mode === "normal" ? "completed_unverified" : mode === "cancel" ? "cancelled" : "needs_review");
    assert.deepEqual(dispatched, mode === "normal" ? ["planner", "routing", "worker", "planner", "routing", "worker"] :
      ["wrong_thinking", "missing_thinking"].includes(mode) ? ["planner", "routing", "worker"] : ["planner", "routing"]);
    if (mode === "normal") assert.equal(done.history[0]?.plan?.thinking, "high");
    if (["wrong_thinking", "missing_thinking"].includes(mode)) {
      assert.equal(done.ledger?.totalUsd, null); assert.ok((done.ledger?.observedUsd ?? 0) > 0);
      assert.equal(done.history.length, 0); assert.equal(done.routing.length, 1); assert.equal(done.lockRetained, true);
    }
    if (mode === "lost_ack" || mode === "invalid_clock") {
      assert.equal(done.ledger?.held.jevCalls, 1); assert.equal(done.ledger?.totalUsd, null); assert.equal(done.lockRetained, true);
      assert.equal(done.lastOperation?.observation?.routing?.type, "resolved"); assert.equal(done.routing.length, 0);
    }
    if (mode === "lost_ack") assert.ok(done.unconfirmedRecord?.type === "settled" && done.unconfirmedRecord.result.routing);
    for (const event of [{ type: "cancel" }, { type: "failed" }, { type: "prepared", grant }] satisfies SequenceEvent[])
      assert.deepEqual(reduceSequence(state, event), { state, effects: [] });
  }
  assert.equal(f.requests.length, 0); assert.equal(f.fetch.mock.callCount(), 0); assert.equal(f.launches.mock.callCount(), 0);
});

test("C1 grant and reducer own snapshots, bind exact policies, and reject expanded or stale approval", async (t) => {
  const f = await fixture(t), original = structuredClone(f.input), preparing = prepareSequence({ cwd: f.cwd, input: f.input }, t.signal);
  f.input.planner = "unapproved"; f.input.budget.workerRuns = 3;
  const grant = await preparing; Object.assign(f.input, original);
  assert.ok(validSequenceGrant(grant)); assert.deepEqual(grant.body.request.input, original);
  assert.ok(!JSON.stringify(grant).includes("offline-sequence-key")); assert.deepEqual(f.tool.parameters, SequenceInputSchema);
  const start: SequenceEvent = freeze({ type: "start", job: { cwd: f.cwd, input: f.input }, hasUI: true });
  const started = reduceSequence(freeze({ status: "idle" }), start);
  const prepared = reduceSequence(freeze(started.state), freeze({ type: "prepared", grant }));
  assert.deepEqual(prepared, reduceSequence(started.state, { type: "prepared", grant })); assert.equal(prepared.state.status, "awaiting_approval");
  assert.deepEqual(reduceSequence(prepared.state, { type: "approval", digest: "foreign", approved: true, now: grant.body.preparedAt }).state, prepared.state);
  for (const approval of [{ approved: false, now: grant.body.preparedAt }, { approved: true, now: grant.body.approvalDeadline }, { approved: true, now: NaN }])
    assert.equal(reduceSequence(prepared.state, { type: "approval", digest: grant.ref.scopeDigest, ...approval }).state.status, "closing");
  const altered = structuredClone(grant); altered.body.planner.model.id = "other"; assert.equal(validSequenceGrant(altered), false);
  for (const budget of [{ ...original.budget, workerRuns: 4 }, { ...original.budget, plannerCalls: 5 }, { ...original.budget, workerCalls: 19 },
    { ...original.budget, totalCalls: 23 }, { ...original.budget, durationSeconds: 601 }, { ...original.budget, workerCalls: 1 }]) assert.equal(validSequenceInput({ ...original, budget }), false);
  const operation: SequenceOperation = { kind: "planner", id: `${grant.intentId}-planner-1`, deadline: grant.body.deadline, scope: grant.body.files, history: [], proposal: null };
  assert.ok(validSequenceOperation(grant, operation)); assert.equal(sequenceSession(grant, operation).run.maxModelCalls, 1);
  assert.ok(!validSequenceOperation(grant, { ...operation, kind: "worker" }));
  await assert.rejects(executeSequenceWorker({ grant, operation, approval: true }), /Goal run stopped/);
  assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.requests.length, 0);
});

test("fixed profiles remain version-pinned through asynchronous model setup, before any approval or launch", async (t) => {
  const f = await fixture(t), create = ModelRuntime.create;
  t.mock.method(ModelRuntime, "create", async (...args: Parameters<typeof ModelRuntime.create>) => {
    const runtime = await Reflect.apply(create, ModelRuntime, args);
    const profile = path.join(f.agentDir, "agents/worker.md");
    await writeFile(profile, (await readFile(profile, "utf8")) + "\nChanged during model setup.\n");
    return runtime;
  });
  const done = await f.invoke(t.signal);
  assert.equal(done.status, "needs_review"); assert.equal(f.confirm.mock.callCount(), 0); assert.equal(f.launches.mock.callCount(), 0);
  assert.equal(f.requests.length, 0); await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK)));
});

test("native C1 performs two sequential fresh workers, shares exact versions and settles before proceeding; planner never receives worker/source text", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  // This historical managed factory owns lifecycle hooks, never ordinary startup discovery.
  assert.deepEqual([...f.extension.handlers.keys()].sort(), ["session_before_compact", "session_before_fork", "session_before_switch", "session_before_tree", "session_shutdown"]);
  assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.requests.length, 0);
  assert.deepEqual(await readdir(f.journal), []);
  await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK)));
  const done = await f.invoke(t.signal);
  assert.equal(done.status, "completed_unverified", JSON.stringify(done)); assert.equal(done.verification, "not_run"); assert.equal(done.taskAcceptance, "needs_review");
  assert.equal(done.history.length, 2); assert.equal(done.cleanupConfirmed, true); assert.equal(done.lockRetained, false);
  assert.equal(await readFile(f.file, "utf8"), f.initial.replaceAll("BEFORE", "AFTER"));
  assert.deepEqual(f.requests.map((request) => request.model), ["offline-planner", "offline-worker", "offline-worker", "offline-planner", "offline-worker", "offline-worker"]);
  for (const request of f.requests.filter((request) => request.model === "offline-planner")) {
    assert.deepEqual(request.tools ?? [], []);
    assert.ok(!JSON.stringify(request).includes("WORKER_SUMMARY_DO_NOT_FORWARD")); assert.ok(!JSON.stringify(request).includes("SOURCE_ONLY_DO_NOT_FORWARD"));
  }
  assert.ok(JSON.stringify(f.requests.filter((request) => request.model === "offline-worker")).includes("SOURCE_ONLY_DO_NOT_FORWARD"));
  for (const request of f.requests.filter((request) => request.model === "offline-worker")) assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["goal_read", "goal_edit", "goal_write"]);
  const wire = JSON.stringify(f.requests); assert.ok(!wire.includes("UNAPPROVED_GLOBAL_PROMPT")); assert.ok(!wire.includes("PROJECT_EXTENSION_MUST_NOT_LOAD"));
  const stored = await f.inspect(); assert.deepEqual(done.ledger, stored.ledger);
  assert.deepEqual(stored.records.map((record) => record.type), ["created", "approved", "reserved", "settled", "reserved", "settled", "reserved", "settled", "reserved", "settled", "closed"]);
  assert.equal(done.ledger?.spent.workerRuns, 2); assert.equal(done.ledger?.spent.workerCalls, 4); assert.equal(done.ledger?.spent.plannerCalls, 2);
  assert.equal(done.ledger?.held.workerCalls, 0); assert.equal(done.ledger?.pending, null); assert.ok(done.ledger!.totalUsd! > 0);
  assert.equal(f.confirm.mock.callCount(), 1); assert.equal(f.launches.mock.callCount(), 4); assert.equal(f.fetch.mock.callCount(), 0);
  const approval = f.confirm.mock.calls[0]!.arguments[1];
  for (const phrase of [/OPT-IN AUTONOMY/, /NO TOOLS/, /30 seconds/, /120 seconds/, /not HTTP attempts/, /No file contents, worker summaries/, /UNVERIFIED/, /derived-task policy/, /No repeated approvals/]) assert.match(approval, phrase);
  await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK))); await assert.rejects(lstat(path.join(f.journal, "owner.lock")));
  const reused = await f.invoke(t.signal); assert.equal(reused.status, "needs_review"); assert.equal(f.launches.mock.callCount(), 4);
});

test("C1 no UI, decline, or approval-time profile/config/file changes create no worker or journal", async (t) => {
  for (const mode of ["no_ui", "decline", "planner", "models", "file"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    if (mode === "no_ui") f.ctx.hasUI = false;
    else f.confirm.mock.mockImplementation(async () => {
      if (mode === "decline") return false;
      const target = mode === "planner" ? path.join(f.agentDir, "agents/planner.md") : mode === "models" ? path.join(f.agentDir, "models.json") : f.file;
      await writeFile(target, (await readFile(target, "utf8")) + "\n"); return true;
    });
    const done = await f.invoke(t.signal); assert.notEqual(done.status, "completed_unverified");
    assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.requests.length, 0);
    await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK))); await assert.rejects(lstat(path.join(f.journal, "goal.jsonl")));
  });
});

test("native planner/worker failures never retry, repair, repeat a criterion or admit the next worker", async (t) => {
  for (const mode of ["malformed", "foreign", "stop", "planner_tool", "error", "missing_usage", "repeat", "repeat_task", "blocked", "last_change", "loop"]) await t.test(mode, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, mode);
    if (mode === "loop") { f.input.maxModelCalls = 1; f.input.budget.workerCalls = 2; }
    const done = await f.invoke(t.signal);
    assert.equal(done.status, "needs_review"); assert.equal(done.lockRetained, true); assert.equal(done.ledger?.blocked, true);
    const planners = f.requests.filter((request) => request.model === "offline-planner").length, workers = f.requests.length - planners;
    assert.equal(planners, mode.startsWith("repeat") ? 2 : 1); assert.ok(workers <= 2); assert.equal(f.confirm.mock.callCount(), 1);
    assert.ok(!JSON.stringify(done).includes("PRIVATE_PROVIDER_ERROR"));
    if (["planner_tool", "error", "missing_usage", "last_change", "loop"].includes(mode)) assert.equal(done.ledger?.totalUsd, null);
    else assert.ok(done.ledger!.totalUsd! > 0);
    assert.ok(done.history.length <= 1); assert.ok(!JSON.stringify(f.requests).includes('"name":"bash"'));
  });
});

test("C1 accumulates actual counts and stops before an unaffordable next planner, without treating claims as verification", async (t) => {
  for (const budget of ["planner", "worker", "total", "runs", "three"]) await t.test(budget, async (t) => {
    const f = await fixture(t);
    f.input.maxModelCalls = 1;
    f.input.acceptanceCriteria = budget === "three" ? ["A", "B", "C"] : ["A", "B"];
    f.input.budget = { workerRuns: budget === "runs" ? 1 : 3, workerCalls: budget === "worker" ? 1 : 18,
      plannerCalls: budget === "planner" ? 1 : 4, totalCalls: budget === "total" ? 2 : 22, durationSeconds: 600 };
    const operations: string[] = [];
    const done = result(await goalSequence(f.input, f.ctx, t.signal, () => Promise.reject(new Error("PRIVATE_PROGRESS")), async (grant, lease, operation) => {
      await checkSequenceLease(grant, lease, operation); operations.push(operation.kind);
      return report(operation);
    }));
    assert.equal(done.status, budget === "three" ? "completed_unverified" : "needs_review"); assert.equal(done.verification, "not_run");
    assert.equal(done.history.length, budget === "three" ? 3 : 1); assert.equal(operations.length, budget === "three" ? 6 : 2);
    assert.ok(Math.abs(done.ledger!.observedUsd - (budget === "three" ? 0.06 : 0.02)) < 1e-12); assert.equal(done.ledger?.totalUsd, done.ledger?.observedUsd);
    assert.equal(done.ledger?.held.workerCalls, 0); assert.equal(done.lockRetained, false); assert.equal(f.requests.length, 0);
  });
});

test("C1 unknown accounting, corrupt scope, foreign completion and cleanup failure keep reservations and ownership", async (t) => {
  for (const mode of ["unknown", "calls", "scope", "foreign", "cleanup"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    const done = result(await goalSequence(f.input, f.ctx, t.signal, undefined, async (_grant, _lease, operation) => {
      if (mode === "unknown") return { started: true, cleanupConfirmed: false, result: null };
      const observed = report(operation);
      if (mode === "calls") observed.result!.reply.report.modelCalls = null;
      if (mode === "scope") observed.result!.scope.files[0]!.path = "unapproved.txt";
      if (mode === "foreign") observed.result!.operationId = "foreign";
      if (mode === "cleanup") observed.cleanupConfirmed = false;
      return observed;
    }));
    assert.equal(done.status, "needs_review"); assert.equal(done.ledger?.totalUsd, null); assert.equal(done.lockRetained, true);
    assert.equal(done.ledger?.held.plannerCalls, ["unknown", "calls"].includes(mode) ? 1 : 0);
    assert.equal(done.ledger?.observedUsd, mode === "unknown" ? 0 : 0.01); assert.equal(done.history.length, 0);
    assert.equal(done.ledger?.spent.workerRuns, 0); assert.equal(f.launches.mock.callCount(), 0);
  });
});

test("C1 cancellation in planner and worker awaits native cleanup and retains unknown accounting without another step", async (t) => {
  for (const mode of ["hold", "worker_hold"]) await t.test(mode, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, mode), pending = f.invoke(t.signal);
    try {
      await Promise.race([f.firstRequest, pending.then(() => assert.fail("No request"))]);
      if (mode === "worker_hold") {
        for (let i = 0; i < 500 && f.requests.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(f.requests.length, 2);
      }
      for (const name of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) assert.ok(f.extension.handlers.has(name));
      await f.revoke(); const done = await pending;
      assert.equal(done.status, "cancelled"); assert.equal(done.cleanupConfirmed, true); assert.equal(done.ledger?.totalUsd, null); assert.equal(done.lockRetained, true);
      assert.equal(f.launches.mock.callCount(), mode === "hold" ? 1 : 2); assert.equal(done.history.length, 0);
      assert.equal(await readFile(f.file, "utf8"), f.initial);
    } finally { await f.revoke("session_shutdown"); await pending; }
  });
});

test("C1 lost settlement sync preserves the unconfirmed report and never admits a worker", async (t) => {
  const f = await fixture(t), handle = await open(f.file, "r"), prototype = Object.getPrototypeOf(handle); await handle.close();
  const done = result(await goalSequence(f.input, f.ctx, t.signal, undefined, async (_grant, _lease, operation) => {
    t.mock.method(prototype, "sync", async () => { throw new Error("PRIVATE_SYNC_ERROR"); }); return report(operation);
  }));
  assert.equal(done.status, "needs_review"); assert.equal(done.unconfirmedRecord?.type, "settled"); assert.equal(done.ledger?.held.plannerCalls, 1);
  assert.equal(done.ledger?.totalUsd, null); assert.equal(done.ledger?.observedUsd, 0); assert.equal(done.lockRetained, true);
  assert.equal(done.lastOperation?.observation?.result?.reply.report.accounting.status, "reported"); assert.equal(f.requests.length, 0);
  assert.ok(!JSON.stringify(done).includes("PRIVATE_SYNC_ERROR"));
});

test("journal startup cleanup uncertainty retains project ownership in both single and sequential Goals", async (t) => {
  for (const mode of ["single", "sequence"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    const nativeOpen = fs.open;
    let release = async () => {};
    const opening = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await Reflect.apply(nativeOpen, fs, args);
      if (args[0] === path.join(f.journal, "goal.jsonl")) {
        await handle.write(Buffer.from("invalid startup journal\n"));
        release = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => { throw new Error("PRIVATE_CLOSE_ERROR"); });
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const state = mode === "single" ? await goalRun(singleRunInput(f.input), f.ctx, t.signal) : await goalSequence(f.input, f.ctx, t.signal);
      assert.equal(state.status, "done"); if (state.status !== "done") throw new Error("Nonterminal");
      assert.equal(state.result.cleanupConfirmed, false); assert.equal(state.result.lockRetained, true);
      assert.ok((await lstat(path.join(f.cwd, GOAL_PROJECT_LOCK))).isFile());
      assert.ok((await lstat(path.join(f.journal, "owner.lock"))).isFile());
      assert.equal(f.requests.length, 0); assert.equal(f.launches.mock.callCount(), 0);
      assert.ok(!JSON.stringify(state).includes("PRIVATE_CLOSE_ERROR"));
    } finally { opening.mock.restore(); syncBuiltinESMExports(); await release(); }
  });
});

test("C1 pure transition table is deterministic, fenced, terminal, and drains invalid settlement clocks", async (t) => {
  const f = await fixture(t), grant = await prepareSequence({ cwd: f.cwd, input: f.input }, t.signal);
  for (const mode of ["normal", "cancel", "invalid_clock"]) {
    let state: SequenceState = { status: "idle" }, now = grant.body.preparedAt;
    const queue: SequenceEffect[] = [], dispatched: string[] = [];
    const send = (event: SequenceEvent) => {
      const owned = freeze(structuredClone(event)), before = freeze(state);
      const next = reduceSequence(before, owned);
      assert.deepEqual(next, reduceSequence(before, owned));
      state = next.state; queue.push(...next.effects);
    };
    send({ type: "start", job: { cwd: f.cwd, input: f.input }, hasUI: true });
    for (let i = 0; queue.length; i++) {
      assert.ok(i < 40);
      const effect = queue.shift()!;
      if (effect.type === "prepare_sequence") send({ type: "prepared", grant });
      else if (effect.type === "confirm_sequence") send({ type: "approval", digest: grant.ref.scopeDigest, approved: true, now: ++now });
      else if (effect.type === "open_sequence") send({ type: "opened", now: ++now, lockVersion: { ...grant.body.files.files[0]!.version,
        digest: goalFileDigest(goalLockText(grant)), bytes: Buffer.byteLength(goalLockText(grant)) } });
      else if (effect.type === "close_sequence") send({ type: "closed", ok: true, lockRetained: effect.keepLock });
      else if (effect.type === "sequence_control") {
        const current = effect.effect;
        if (current.type === "append_goal") {
          assert.deepEqual(reduceSequence(state, { type: "control", event: { type: "storage_failed", expected: { sequence: 999, hash: null }, record: current.record } }).state, state);
          send({ type: "control", event: { type: "persisted", expected: current.expected, record: current.record,
            head: { sequence: current.expected.sequence + 1, hash: goalFileDigest(JSON.stringify(current.record)) }, now: ++now } });
        } else if (current.type === "check_goal_admission") send({ type: "control", event: { type: "admission", ref: current.ref,
          activationId: current.activationId, intentId: current.intent.id, head: current.head, current: true, now: ++now } });
        else if (current.type === "stop_goal_operation") send({ type: "stop_ack" });
        else {
          assert.ok(effect.operation); dispatched.push(effect.operation.kind);
          const observation = report(effect.operation);
          assert.deepEqual(reduceSequence(state, { type: "observed", operationId: "foreign", observation, now }).state, state);
          if (mode === "cancel" && effect.operation.kind === "worker") send({ type: "cancel" });
          send({ type: "observed", operationId: effect.operation.id, observation, now: mode === "invalid_clock" ? NaN : ++now });
        }
      }
    }
    const done = result(state);
    assert.equal(done.status, mode === "normal" ? "completed_unverified" : mode === "cancel" ? "cancelled" : "needs_review");
    assert.equal(dispatched.length, mode === "normal" ? 4 : mode === "cancel" ? 2 : 1);
    if (mode === "invalid_clock") { assert.ok(done.ledger?.pending); assert.equal(done.ledger?.held.plannerCalls, 1); assert.ok(done.lastOperation?.observation?.result); }
    for (const late of [{ type: "cancel" }, { type: "prepared", grant }, { type: "failed" }] satisfies SequenceEvent[])
      assert.deepEqual(reduceSequence(state, late), { state, effects: [] });
  }
});

test("C1 planner timer, activation timer and IPC disconnect each stop native work without resetting the budget", async (t) => {
  for (const mode of ["planner", "activation", "disconnect"]) await t.test(mode, { timeout: 15_000 }, async (t) => {
    const f = await fixture(t, "hold"); f.input.budget.durationSeconds = 600;
    const nativeTimeout = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      // Native planner time is the remainder after discovery, not a freshly restarted30s.
      if (mode === "planner" && !expire && f.launches.mock.callCount() > 0 && ms !== undefined && ms > 2_000 && ms <= 30_000 || mode === "activation" && ms !== undefined && ms > 590_000) expire = () => callback(...args);
      return nativeTimeout(callback, ms, ...args);
    });
    const pending = f.invoke(t.signal);
    try {
      await Promise.race([f.firstRequest, pending.then(() => assert.fail("No request"))]);
      if (mode === "disconnect") f.launches.mock.calls[0]!.result!.disconnect(); else { assert.ok(expire); expire(); }
      const done = await pending;
      assert.equal(done.status, "needs_review"); assert.equal(done.cleanupConfirmed, true); assert.equal(done.lockRetained, true); assert.equal(done.ledger?.totalUsd, null);
      assert.equal(f.requests.length, 1); assert.equal(f.launches.mock.callCount(), 1);
    } finally { await f.revoke("session_shutdown"); await pending; }
  });
});

test("C1 launch uncertainty or an existing project owner fails closed, never steals ownership or claims free cleanup", async (t) => {
  for (const mode of ["launch", "owner"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    if (mode === "owner") await writeFile(path.join(f.cwd, GOAL_PROJECT_LOCK), "FOREIGN OWNER", { mode: 0o600 });
    else f.launches.mock.mockImplementation(() => { throw new Error("PRIVATE_LAUNCH_ERROR"); });
    const done = await f.invoke(t.signal);
    assert.equal(done.status, "needs_review"); assert.equal(done.cleanupConfirmed, false); assert.equal(done.lockRetained, true); assert.equal(f.requests.length, 0);
    if (mode === "owner") { assert.equal(await readFile(path.join(f.cwd, GOAL_PROJECT_LOCK), "utf8"), "FOREIGN OWNER"); assert.equal(f.launches.mock.callCount(), 0); }
    else { assert.equal(done.ledger?.held.plannerCalls, 1); assert.equal(done.ledger?.totalUsd, null); assert.equal(done.ledger?.spent.plannerCalls, 0); }
    assert.ok(!JSON.stringify(done).includes("PRIVATE_LAUNCH_ERROR"));
  });
});

async function enableVerification(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, mode = "ok", decideExit?: (container: Container) => Promise<number> | number) {
  await writeFile(path.join(f.cwd, "check.mjs"), "// CHECKER_SOURCE_NOT_FOR_PLANNER; protocol fixture supplies the observed exit.\n");
  const docker = await dockerFixture(t, mode, async (container) => {
    if (decideExit) return decideExit(container);
    const packet = JSON.parse(container.body.Cmd[1]!);
    if (packet.command === "/bin/sh") return 0;
    const source = container.body.HostConfig.Mounts.find((mount) => mount.Target === "/workspace/fixture.txt")!;
    const text = await readFile(source.Source, "utf8"), which = packet.args[1];
    return (which === "b" || text.includes("A=AFTER")) && (which === "a" || text.includes("B=AFTER")) ? 0 : 42;
  });
  const check = { command: "/usr/local/bin/node", entry: "check.mjs", coverage: "Declared fixture string assertion only" };
  f.input.budget = { workerRuns: 3, plannerCalls: 3, workerCalls: 6, totalCalls: 9, durationSeconds: 120 };
  f.input.verification = { socketPath: docker.socketPath, image: IMAGE, nodePath: "/usr/local/bin/node", files: ["check.mjs"],
    checks: [{ ...check, id: "a", criteriaIds: ["criterion-1"], args: ["check.mjs", "a"] }, { ...check, id: "b", criteriaIds: ["criterion-2"], args: ["check.mjs", "b"] }],
    final: { ...check, id: "all", criteriaIds: ["criterion-1", "criterion-2"], args: ["check.mjs", "all"] },
    budget: { runs: 5, repairs: 1 }, failureProtocol: "exit_42_assertions_only" };
  return docker;
}

test("C2 native SDK sequence: sync the actual checker failure, same-task repair once, recheck then final check (Docker protocol fixture)", async (t) => {
  const f = await fixture(t, "repair"), docker = await enableVerification(t, f), done = await f.invoke();
  assert.equal(done.status, "completed_checked", JSON.stringify(done)); assert.equal(done.verification, "passed"); assert.equal(done.taskAcceptance, "needs_review");
  assert.equal(f.confirm.mock.callCount(), 1); assert.equal(done.cleanupConfirmed, true); assert.equal(done.lockRetained, false);
  assert.equal(done.ledger?.spent.workerRuns, 3); assert.equal(done.ledger?.spent.repairs, 1); assert.equal(done.ledger?.spent.plannerCalls, 2);
  assert.equal(done.ledger?.spent.workerCalls, 6); assert.equal(done.ledger?.spent.verificationRuns, 5);
  assert.deepEqual(done.checks?.map((check) => [check.stage, check.checkId, check.exitCode]), [["probe", "probe", 0], ["step", "a", 42], ["step", "a", 0], ["step", "b", 0], ["final", "all", 0]]);
  assert.equal(done.history.length, 2); assert.ok(done.history[0]?.repair); assert.equal(done.history[1]?.repair, undefined);
  assert.equal(await readFile(f.file, "utf8"), f.initial.replaceAll("BEFORE", "AFTER"));
  assert.equal(docker.containers.length, 5); assert.ok(docker.containers.every((container) => container.removed));
  const journal = await f.inspect(); assert.deepEqual(journal.ledger, done.ledger);
  const failure = journal.records.findIndex((record) => record.type === "settled" && record.result.verification?.exitCode === 42);
  const repair = journal.records.findIndex((record) => record.type === "reserved" && record.intent.reserve.repairs === 1);
  assert.ok(failure > 0 && repair > failure);
  const packets = f.requests.map((request) => { const value = request.messages.find((message) => message.role === "user")!.content;
    return { model: request.model, packet: JSON.parse(typeof value === "string" ? value : value.map((part) => part.text ?? "").join("")) }; });
  const initial = packets.find((item) => item.model === "offline-worker")!.packet;
  const fixed = packets.find((item) => item.packet.repairOf)!.packet;
  assert.deepEqual(fixed.assigned, initial.assigned); assert.equal(fixed.repairOf.exitCode, 42);
  for (const item of packets.filter((item) => item.model === "offline-planner")) {
    assert.ok(!JSON.stringify(item).includes("SOURCE_ONLY_DO_NOT_FORWARD")); assert.ok(!JSON.stringify(item).includes("CHECKER_SOURCE_NOT_FOR_PLANNER"));
    assert.ok(!JSON.stringify(item).includes("WORKER_SUMMARY_DO_NOT_FORWARD")); assert.ok(!JSON.stringify(item).includes(docker.socketPath));
    assert.deepEqual(item.packet.allowedWorkGroups, [["criterion-1"], ["criterion-2"]]);
  }
});

test("C2 generic, repeated, final and runtime failures never grant an extra repair", async (t) => {
  for (const mode of ["generic", "repeated", "later_failure", "final", "timeout", "runtime", "unsupported", "remove", "last_change", "no_repair"]) await t.test(mode, async (t) => {
    const f = await fixture(t, "repair"); let aChecks = 0;
    const docker = await enableVerification(t, f, ["unsupported", "remove"].includes(mode) ? mode : "ok", async (container) => {
      const packet = JSON.parse(container.body.Cmd[1]!);
      if (packet.command === "/bin/sh") return 0;
      if (mode === "last_change") { await writeFile(f.file, "EXTERNAL CHANGE"); return 0; }
      if (mode === "generic") return 1;
      if (mode === "timeout") return 124;
      if (mode === "runtime") return 125;
      if (mode === "final") return packet.args[1] === "all" ? 42 : 0;
      if (mode === "later_failure" && packet.args[1] === "a") return aChecks++ === 0 ? 42 : 0;
      return 42;
    });
    if (mode === "no_repair") { f.input.verification!.budget.repairs = 0; f.input.verification!.failureProtocol = "no_automatic_repair"; }
    const done = await f.invoke(); assert.equal(done.status, "needs_review"); assert.notEqual(done.verification, "passed");
    assert.equal(done.ledger?.spent.repairs, mode === "repeated" || mode === "later_failure" ? 1 : 0);
    assert.ok((done.ledger?.spent.workerRuns ?? 0) <= (mode === "later_failure" ? 3 : mode === "final" || mode === "repeated" ? 2 : mode === "unsupported" || mode === "remove" ? 0 : 1));
    if (mode === "remove") { assert.equal(done.cleanupConfirmed, false); assert.equal(done.lockRetained, true); assert.equal(done.ledger?.totalUsd, null); }
    if (mode === "unsupported" || mode === "remove") assert.equal(f.requests.length, 0);
    assert.ok(docker.containers.length <= 4);
  });
});

test("C2 missing approval or changed registered checker cannot reach Docker or a model", async (t) => {
  for (const mode of ["no_ui", "decline", "changed", "writable_checker", "budget"]) await t.test(mode, async (t) => {
    const f = await fixture(t), docker = await enableVerification(t, f);
    if (mode === "no_ui") Object.assign(f.ctx, { hasUI: false });
    if (mode === "decline") f.confirm.mock.mockImplementation(async () => false);
    if (mode === "changed") f.confirm.mock.mockImplementation(async () => { await writeFile(path.join(f.cwd, "check.mjs"), "CHANGED"); return true; });
    if (mode === "writable_checker") f.input.files.push({ path: "check.mjs", access: "read_write" });
    if (mode === "budget") f.input.verification!.budget.runs = 3;
    const done = await f.invoke(); assert.notEqual(done.status, "completed_checked"); assert.equal(f.requests.length, 0); assert.equal(docker.requests.length, 0);
  });
});

test("C2 lost failure acknowledgement keeps its observation and never admits repair", async (t) => {
  const f = await fixture(t, "repair"); let failed = false;
  await enableVerification(t, f, "ok", (container) => {
    if (JSON.parse(container.body.Cmd[1]!).command === "/bin/sh") return 0;
    failed = true; return 42;
  });
  const handle = await open(path.join(f.root, "prototype"), "w"), prototype = Object.getPrototypeOf(handle), sync = prototype.sync;
  await handle.close();
  t.mock.method(prototype, "sync", async function (this: Awaited<ReturnType<typeof open>>) {
    const source = failed ? await readFile(path.join(f.journal, "goal.jsonl"), "utf8").catch(() => "") : "";
    if (failed && source.includes('"exitCode":42')) throw new Error("PRIVATE_SETTLEMENT_ERROR");
    return sync.call(this);
  });
  const done = await f.invoke();
  assert.equal(done.status, "needs_review"); assert.equal(done.ledger?.spent.repairs, 0); assert.equal(done.ledger?.totalUsd, null); assert.equal(done.lockRetained, true);
  assert.equal(done.unconfirmedRecord?.type, "settled"); assert.equal(done.lastOperation?.observation?.verification?.exitCode, 42);
  assert.ok(!JSON.stringify(done).includes("PRIVATE_SETTLEMENT_ERROR"));
});

test("C2 frozen transition matrix preserves failure facts, cancellation, unknown reservations and terminal fences", async (t) => {
  const f = await fixture(t); await enableVerification(t, f);
  const grant = await prepareSequence({ cwd: f.cwd, input: f.input }, t.signal);
  for (const mode of ["normal", "probe", "planner", "worker", "check", "repair", "final", "closing", "unknown", "invalid_clock", "not_started"]) {
    let state: SequenceState = { status: "idle" }, now = grant.body.preparedAt, checks = 0;
    const queue: SequenceEffect[] = [], kinds: string[] = [];
    const send = (event: SequenceEvent) => { const before = freeze(state), owned = freeze(structuredClone(event));
      const next = reduceSequence(before, owned); assert.deepEqual(next, reduceSequence(before, owned)); state = next.state; queue.push(...next.effects); };
    send({ type: "start", job: { cwd: f.cwd, input: f.input }, hasUI: true });
    for (let steps = 0; queue.length; steps++) {
      assert.ok(steps < 100, mode); const effect = queue.shift()!;
      if (effect.type === "prepare_sequence") send({ type: "prepared", grant });
      else if (effect.type === "confirm_sequence") send({ type: "approval", digest: grant.ref.scopeDigest, approved: true, now: ++now });
      else if (effect.type === "open_sequence") send({ type: "opened", now: ++now, lockVersion: { ...grant.body.files.files[0]!.version,
        digest: goalFileDigest(goalLockText(grant)), bytes: Buffer.byteLength(goalLockText(grant)) } });
      else if (effect.type === "close_sequence") { if (mode === "closing") send({ type: "cancel" }); send({ type: "closed", ok: true, lockRetained: effect.keepLock }); }
      else {
        const current = effect.effect;
        if (current.type === "append_goal") send({ type: "control", event: { type: "persisted", expected: current.expected, record: current.record,
          head: { sequence: current.expected.sequence + 1, hash: goalFileDigest(JSON.stringify(current.record)) }, now: ++now } });
        else if (current.type === "check_goal_admission") send({ type: "control", event: { type: "admission", ref: current.ref,
          activationId: current.activationId, intentId: current.intent.id, head: current.head, current: true, now: ++now } });
        else if (current.type === "stop_goal_operation") send({ type: "stop_ack" });
        else {
          const op = effect.operation!; kinds.push(op.kind);
          const stage = op.verification?.stage === "step" ? "check" : op.verification?.stage ?? op.kind;
          let observation: SequenceObservation;
          if (op.kind === "verification") {
            const exitCode = op.verification!.stage === "step" && checks++ === 0 ? 42 : 0;
            observation = { started: true, cleanupConfirmed: mode !== "unknown", result: null,
              verification: { type: "verification_result", operationId: op.id, containerId: "a".repeat(64), status: "exited", exitCode, isolated: true, filesCurrent: true, elapsedMs: 1 } };
            if (mode === "not_started") observation = { started: false, cleanupConfirmed: true, result: null };
          } else observation = report(op);
          assert.deepEqual(reduceSequence(state, { type: "observed", operationId: "foreign", observation, now }).state, state);
          if (mode === stage) send({ type: "cancel" });
          send({ type: "observed", operationId: op.id, observation, now: mode === "invalid_clock" ? NaN : ++now });
        }
      }
    }
    const done = result(state), stopped = ["unknown", "invalid_clock", "not_started"].includes(mode);
    assert.equal(done.status, mode === "normal" ? "completed_checked" : stopped ? "needs_review" : "cancelled", mode);
    assert.ok(kinds.filter((kind) => kind === "repair").length <= 1); assert.equal(done.taskAcceptance, "needs_review");
    if (mode === "normal" || mode === "closing") { assert.equal(done.verification, "passed"); assert.equal(done.checks?.length, 5); }
    if (mode === "unknown" || mode === "invalid_clock") { assert.equal(done.ledger?.totalUsd, null); assert.equal(done.lockRetained, true); }
    if (mode === "not_started") { assert.equal(done.ledger?.held.verificationRuns, 0); assert.equal(done.ledger?.totalUsd, 0); }
    for (const late of [{ type: "cancel" }, { type: "failed" }, { type: "prepared", grant }] satisfies SequenceEvent[])
      assert.deepEqual(reduceSequence(state, late), { state, effects: [] });
  }
  assert.equal(f.requests.length, 0);
});

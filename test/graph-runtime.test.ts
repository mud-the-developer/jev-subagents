import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ordinaryDelegate, ordinaryIO, type OrdinaryPublicResult } from "../src/ordinary-effects.ts";
import { ordinaryContextDigest, validOrdinaryWorkerInput, type OrdinaryWorkerInput, type OrdinaryWorkerReply } from "../src/ordinary-protocol.ts";
import { ordinaryRoutingMaximum, type OrdinaryGraphInput, type OrdinaryPreparedScope } from "../src/ordinary-authorization.ts";
import { evaluatePlanGraph, type PlanGraph } from "../src/plan-graph.ts";
import { describeJevTarget, readJevConnection } from "../src/jev-config.ts";
import { validPlanReceipt } from "../src/plan-state.ts";
import { delegateResultView } from "../src/delegate-presentation.ts";
import { registerJevTools } from "../src/index.ts";

const branch = (id: string): PlanGraph["nodes"][number] => ({ id, kind: "choice", summary: `PRIVATE_CHOICE_${id}`,
  choices: [{ id: "a", description: "Approved first route." }, { id: "b", description: "Approved second route." }] });
function diamond(): PlanGraph {
  return { version: 2, entry: "choose", nodes: [{ id: "next", kind: "task" }, { id: "join", kind: "join" }, { id: "b1", kind: "task" },
    { id: "a2", kind: "task" }, branch("choose"), { id: "a1", kind: "task" }],
  edges: [{ from: "join", to: "next" }, { from: "b1", to: "join" }, { from: "a2", to: "join" }, { from: "a1", to: "a2" },
    { from: "choose", to: "b1", when: "b" }, { from: "choose", to: "a1", when: "a" }] };
}
function nested(): PlanGraph {
  return { version: 2, entry: "outer", nodes: [branch("outer"), branch("inner"), { id: "short", kind: "task" },
    { id: "long1", kind: "task" }, { id: "long2", kind: "task" }, { id: "right", kind: "task" },
    { id: "branch_join", kind: "join" }, { id: "merge", kind: "join" }, { id: "next", kind: "task" }],
  edges: [{ from: "outer", to: "inner", when: "a" }, { from: "outer", to: "right", when: "b" },
    { from: "inner", to: "short", when: "a" }, { from: "inner", to: "long1", when: "b" }, { from: "long1", to: "long2" },
    { from: "short", to: "branch_join" }, { from: "long2", to: "branch_join" }, { from: "branch_join", to: "merge" },
    { from: "right", to: "merge" }, { from: "merge", to: "next" }] };
}
function offline(t: TestContext) {
  const keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"], saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
  Object.assign(process.env, { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8000", OPENJEV_MODEL: "openjev-0.1" });
  delete process.env.OPENJEV_API_KEY;
  t.mock.method(globalThis, "fetch", async () => assert.fail("No model, translation, verification or network calls in this fixture."));
  t.mock.method(childProcess, "fork", () => assert.fail("No real worker process."));
  t.mock.method(childProcess, "spawn", () => assert.fail("No process or verifier."));
}
function fixture(plan = diamond()) {
  let session = "session", approvals = 0, owners = 0, closed = 0, kept = false;
  const trace: string[] = [], dtos: OrdinaryWorkerInput[] = [], requests: unknown[] = [];
  const assertFreshReads = () => {
    const boundary = trace.findLastIndex(item => item === "own" || item === "jev" || item.startsWith("worker:"));
    const checks = trace.slice(boundary + 1);
    assert.ok(checks.includes("owner_check")); assert.ok(checks.includes("files_check"));
    if (checks.includes("context_check")) assert.ok(checks.lastIndexOf("owner_check") > checks.lastIndexOf("context_check"), "Split context and owner batches stay ordered.");
  };
  const decisions: Record<string, string> = {}, target = readJevConnection(); assert.ok(target.ok);
  const scope: Omit<OrdinaryPreparedScope, "input"> & { input: OrdinaryGraphInput } = { id: "graph", sessionId: session,
    input: { task: "Perform only the chosen approved path.", agents: ["worker"], files: [{ path: "sample.txt", access: "read_write" }],
      tasks: plan.nodes.filter(node => node.kind === "task").map(node => ({ id: node.id, summary: `PRIVATE_WORKER_INPUT_${node.id}`, agent: "worker" })),
      plan, selection: "parent_or_jev", limits: { workerRuns: 3, modelCalls: 6, perWorkerCalls: 2, seconds: 120 } },
    agents: [{ name: "worker", file: "/account/agents/worker.md", description: "Approved file work.",
      systemPrompt: "PRIVATE_PROFILE_SOURCE", tools: ["read", "edit"], model: { provider: "offline", id: "fixture" } }],
    workerTargets: [{ agent: "worker", api: "openai-completions", endpoint: "http://127.0.0.1:8000/v1" }],
    contextDigest: ordinaryContextDigest([], "/account"), routingTarget: describeJevTarget(target.connection), approvalDeadline: null, fileProtocol: "scoped_existing_files",
    files: { id: "files", root: "/workspace", rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "sample.txt", access: "read_write",
      version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 7 } }] } };
  const ctx = { cwd: scope.files.root, hasUI: true, mode: "rpc", ui: { confirm: async () => true },
    sessionManager: { getSessionId: () => session } } as unknown as ExtensionContext;
  const reply = (dto: OrdinaryWorkerInput): OrdinaryWorkerReply => ({ type: "goal_result", scope: dto.files,
    files: { operations: 0, readBytes: 0, writtenBytes: 0, changed: false, uncertain: false, finished: true },
    reply: { type: "completed", result: { text: "PRIVATE_RAW_WORKER_REPLY", truncated: false, turns: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 },
    report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "reported", complete: true,
      stats: { turns: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 } } } } });
  const io: typeof ordinaryIO = { ...ordinaryIO,
    prepare: async () => { trace.push("prepare"); return { scope: structuredClone(scope), context: [], agentDirectory: "/account" }; },
    confirm: async (_ctx, _title, packet, deadline, _signal, _kind, _observe, text) => {
      approvals++; trace.push("approve"); assert.equal(deadline, null); assert.equal(owners, 0); assert.equal(dtos.length, 0); assert.equal(requests.length, 0);
      const approved = JSON.parse(packet); assert.deepEqual(approved.scope, scope); assert.equal(approved.routing.maximumRequests, ordinaryRoutingMaximum(scope.input));
      assert.ok(text); assert.ok(text.includes("Complete approved DAG v2"));
      for (const task of scope.input.tasks) assert.ok(text.includes(task.summary));
      return true;
    },
    canonicalDirectory: async () => scope.files.root,
    own: async () => { owners++; trace.push("own"); assert.equal(approvals, 1);
      return { version: scope.files.files[0]!.version, close: async keep => { closed++; kept = keep; return keep; } }; },
    checkContext: async value => { trace.push(value.body.context.some(file => file.path.endsWith(".jev-goal.lock")) ? "owner_check" : "context_check"); },
    checkFiles: async () => { trace.push("files_check"); },
    select: async (effect, signal, attempted, connection) => {
      assert.equal(effect.type, "call_jev"); if (effect.type !== "call_jev") assert.fail();
      assert.equal(signal?.aborted, false); assert.equal(approvals, 1); assert.equal(owners, 1); assert.equal(connection?.apiKey, null);
      assertFreshReads(); attempted?.();
      requests.push(structuredClone(effect.request)); trace.push("jev");
      let node = ""; try { node = (JSON.parse(effect.request.task) as { summary: string }).summary.replace("PRIVATE_CHOICE_", ""); } catch { /* Agent routing uses a reviewed task summary. */ }
      const agent = effect.request.agents.some(candidate => candidate.name === "worker") ? "worker" : decisions[node] ?? "a";
      return { type: "resolved", decision: { agent, confidence: 1, model: "openjev-0.1", provider: "openjev", requestedModel: "openjev-0.1",
        usage: { inputTokens: 3, outputTokens: 1 } } };
    },
    run: async (dto, signal) => {
      assert.equal(signal.aborted, false); assert.equal(approvals, 1); assert.equal(owners, 1);
      assertFreshReads(); assert.equal(validOrdinaryWorkerInput(dto), true);
      assert.deepEqual(evaluatePlanGraph(scope.input.plan, dto.graphEvents).next, { kind: "task", nodeId: dto.taskId });
      dtos.push(structuredClone(dto)); trace.push(`worker:${dto.taskId}`);
      return { started: true, cleanupConfirmed: true, result: reply(dto) };
    },
  };
  return { scope, ctx, io, reply, dtos, requests, decisions, trace,
    counts: () => ({ approvals, owners, closed, kept }), switchSession: () => { session = "other"; } };
}

test("native DAG dispatch handles unordered diamonds, selected-path joins and nested skipped choices", async t => {
  offline(t);
  for (const [plan, decisions, expected, skipped] of [
    [diamond(), { choose: "a" }, ["a1", "a2", "next"], ["b1"]],
    [diamond(), { choose: "b" }, ["b1", "next"], ["a1", "a2"]],
    [nested(), { outer: "b" }, ["right", "next"], ["inner", "long1", "long2", "short", "branch_join"]],
    [nested(), { outer: "a", inner: "b" }, ["long1", "long2", "next"], ["short", "right"]],
  ] as const) {
    const f = fixture(plan); Object.assign(f.decisions, decisions);
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
    assert.equal(result.status, "completed_unverified"); assert.deepEqual(f.dtos.map(dto => dto.taskId), expected);
    assert.equal(result.workersStarted, expected.length); assert.equal(result.modelCalls, expected.length);
    assert.equal(result.jevRequests, Object.keys(decisions).length); assert.equal(result.reservedJevRequests, 0);
    assert.deepEqual(f.counts(), { approvals: 1, owners: 1, closed: 1, kept: false });
    assert.equal(result.costEstimate.delegationTotalUsd, null); assert.equal(validPlanReceipt(result.plan), true);
    for (const id of skipped) assert.equal(result.plan?.nodes.find(node => node.id === id)?.state, "skipped");
    assert.equal(JSON.stringify(result.plan).includes("PRIVATE_"), false);
    for (const request of f.requests) for (const privateValue of ["PRIVATE_RAW_WORKER_REPLY", "PRIVATE_PROFILE_SOURCE", "PRIVATE_WORKER_INPUT", "sample.txt", "/workspace", "lockVersion"])
      assert.equal(JSON.stringify(request).includes(privateValue), false);
    if (f.requests.length === 2) assert.match(JSON.stringify(f.requests[1]), /previousGraph/);
  }
});

test("independent ready tasks use deterministic lexical replay and no JEV for pinned agents", async t => {
  offline(t);
  const f = fixture({ version: 2, entry: "root", nodes: [{ id: "z", kind: "task" }, { id: "root", kind: "join" }, { id: "a", kind: "task" }],
    edges: [{ from: "root", to: "z" }, { from: "root", to: "a" }] });
  f.scope.input.selection = "parent_only"; f.scope.routingTarget = null;
  const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
  assert.equal(result.status, "completed_unverified"); assert.deepEqual(f.dtos.map(dto => dto.taskId), ["a", "z"]);
  assert.equal(result.jevRequests, 0); assert.equal(result.costEstimate.delegationTotalUsd, 0.002);
});

test("automatic joins and choice-only paths consume no worker allowance or invented SDK calls", async t => {
  offline(t);
  for (const choice of [false, true]) {
    const f = fixture(choice ? { version: 2, entry: "choose", nodes: [branch("choose"), { id: "join", kind: "join" }],
      edges: [{ from: "choose", to: "join", when: "a" }, { from: "choose", to: "join", when: "b" }] }
      : { version: 2, entry: "join", nodes: [{ id: "join", kind: "join" }], edges: [] });
    if (!choice) f.scope.routingTarget = null;
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
    assert.equal(result.status, "completed_unverified"); assert.equal(result.workersStarted, 0); assert.equal(result.modelCalls, 0);
    assert.equal(result.jevRequests, choice ? 1 : 0); assert.equal(f.counts().owners, choice ? 1 : 0);
    assert.equal(result.plan?.nodes.find(node => node.id === "join")?.state, "joined");
  }
});

test("owner freshness batches split before native IO instead of widening path limits or retrying", async t => {
  offline(t);
  const f = fixture(), context = Array.from({ length: 128 }, (_, i) => ({ path: `/control-${i}`, text: null, version: null, active: false }));
  f.scope.contextDigest = ordinaryContextDigest(context, "/account");
  f.io.prepare = async () => ({ scope: structuredClone(f.scope), context, agentDirectory: "/account" });
  const check = f.io.checkContext, sizes: number[] = [];
  f.io.checkContext = async (...args) => { sizes.push(args[0].body.context.length); assert.ok(args[0].body.context.length <= 128); await check(...args); };
  const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
  assert.equal(result.status, "completed_unverified"); assert.ok(sizes.includes(128)); assert.ok(sizes.includes(1));
});

test("choice support below 0.5 admits zero workers; exactly 0.5 runs once; failure never falls back", async t => {
  offline(t);
  for (const mode of ["weak", "threshold", "failed", "unknown_route", "unknown_receipt"] as const) {
    const f = fixture(), select = f.io.select, run = f.io.run;
    f.io.select = async (...args) => {
      const event = await select(...args); if (event.type !== "resolved") assert.fail();
      if (mode === "unknown_route") return { type: "failed", error: "PRIVATE_TRANSPORT_FAILURE" };
      if (mode === "unknown_receipt") return { ...event, decision: { ...event.decision, usage: null } } as unknown as typeof event;
      return { ...event, decision: { ...event.decision, confidence: mode === "weak" ? 0.49 : 0.5 } };
    };
    f.io.run = async (...args) => { const result = await run(...args); if (mode === "failed") result.result!.files.finished = false; return result; };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
    assert.equal(result.jevRequests, 1); assert.equal(f.requests.length, 1);
    assert.equal(result.status, mode === "threshold" ? "completed_unverified" : "stopped");
    assert.equal(f.dtos.length, mode === "threshold" ? 3 : mode === "failed" ? 1 : 0);
    if (mode === "weak") assert.equal(result.reason, "undecided");
    if (mode.startsWith("unknown")) { assert.equal(result.lockRetained, true); assert.equal(result.reservedJevRequests, 1); }
    assert.equal(JSON.stringify(result).includes("PRIVATE_TRANSPORT_FAILURE"), false);
    assert.equal(f.dtos.some(dto => dto.taskId === "b1"), false);
  }
});

test("no UI, denied/cancelled review and invalid maximum have no owner, JEV or worker effects", async t => {
  offline(t);
  for (const mode of ["no_ui", "denied", "cancelled", "static_max"] as const) {
    const f = fixture(), controller = new AbortController();
    if (mode === "no_ui") f.ctx.hasUI = false;
    if (mode === "static_max") f.scope.input.limits.workerRuns = 2;
    const confirm = f.io.confirm;
    f.io.confirm = async (...args) => { await confirm(...args); if (mode === "cancelled") controller.abort(); return mode !== "denied"; };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, controller.signal, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(f.counts().owners, 0); assert.equal(result.jevRequests, 0); assert.equal(result.workersStarted, 0);
  }
});

test("freshness/session/ownership changes before choices, before workers and at completion stop all advancement", async t => {
  offline(t);
  for (const mode of ["session", "initial", "ownership", "after_choice", "worker_admission", "completion"] as const) {
    const f = fixture(), confirm = f.io.confirm, context = f.io.checkContext, run = f.io.run;
    let changed = false, running = false;
    if (mode === "session") f.io.confirm = async (...args) => { const result = await confirm(...args); f.switchSession(); return result; };
    f.io.checkContext = async (...args) => {
      await context(...args);
      if (mode === "initial" || mode === "ownership" && f.counts().owners > 0 || mode === "after_choice" && f.requests.length > 0 ||
        mode === "worker_admission" && running || changed) throw new Error("PRIVATE_FRESHNESS_FAILURE");
    };
    f.io.run = async (...args) => { const result = await run(...args); if (mode === "completion") changed = true; return result; };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, phase => { if (phase === "running") running = true; }, f.io);
    assert.equal(result.status, "stopped"); assert.ok(f.dtos.length <= 1); assert.ok(f.requests.length <= 1);
    assert.equal(JSON.stringify(result).includes("PRIVATE_FRESHNESS_FAILURE"), false);
    if (mode === "completion") {
      assert.equal(result.modelCalls, 1); assert.equal(f.dtos.length, 1);
      assert.equal(result.plan?.nodes.find(node => node.id === "a1")?.state, "failed");
      assert.equal(result.plan?.nodes.find(node => node.id === "a2")?.state, "blocked");
    } else assert.equal(f.dtos.length, 0);
  }
});

test("unknown worker accounting/cleanup and file identity changes retain diagnostics and never append success events", async t => {
  offline(t);
  for (const mode of ["accounting", "capped_accounting", "native_accounting", "cleanup", "files", "identity", "throw"] as const) {
    const f = fixture(), run = f.io.run;
    if (mode === "capped_accounting") f.scope.input.limits.perWorkerCalls = 1;
    if (mode === "native_accounting") { f.scope.input.limits.modelCalls = null; f.scope.input.limits.perWorkerCalls = null; }
    f.io.run = async (...args) => {
      const result = await run(...args); if (mode === "throw") throw new Error("PRIVATE_NATIVE_FAILURE");
      if (mode.endsWith("accounting")) result.result!.reply.report.accounting = { status: "unknown" };
      if (mode === "cleanup") result.cleanupConfirmed = false;
      if (mode === "files") result.result!.files.uncertain = true;
      if (mode === "identity") { result.result!.scope = structuredClone(result.result!.scope); result.result!.scope.files[0]!.version.identity.ino = 99; }
      return result;
    };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(f.dtos.length, 1); assert.equal(result.jevRequests, 1);
    assert.equal(result.lockRetained, mode !== "identity"); assert.equal(result.costEstimate.delegationTotalUsd, null);
    assert.equal(result.plan?.nodes.find(node => node.id === "choose")?.chosenChoiceId, "a");
    assert.equal(result.plan?.nodes.find(node => node.id === "a1")?.state, "failed");
    assert.equal(result.plan?.nodes.find(node => node.id === "b1")?.state, "skipped");
  }
});

test("cancel/expiry while a worker is pending settles late usage without graph advance or retry", async t => {
  offline(t);
  for (const expiry of [false, true]) for (const cleanup of [false, true]) {
    await t.test(`expiry=${expiry}, cleanup=${cleanup}`, async t => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
      const f = fixture(), controller = new AbortController(), run = f.io.run;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), receipt = new Promise<void>(resolve => { release = resolve; });
      f.io.run = async (...args) => { const result = await run(...args); entered(); await receipt; return { ...result, cleanupConfirmed: cleanup }; };
      const pending = ordinaryDelegate(f.scope.input, f.ctx, controller.signal, undefined, f.io);
      await Promise.race([ready, pending.then(() => assert.fail("Fixture stopped before worker admission."))]);
      if (expiry) t.mock.timers.tick(120_000); else controller.abort();
      t.mock.timers.tick(1); release(); const result = await pending;
      assert.equal(result.status, "stopped"); assert.equal(result.reason, expiry ? "expired" : "cancelled");
      assert.equal(result.modelCalls, 1); assert.equal(result.workersStarted, 1); assert.equal(result.reservedModelCalls, cleanup ? 0 : 1);
      assert.equal(result.lockRetained, !cleanup); assert.equal(f.dtos.length, 1); assert.equal(result.jevRequests, 1);
      assert.equal(result.plan?.nodes.find(node => node.id === "a1")?.state, "failed");
      assert.equal(result.plan?.nodes.find(node => node.id === "a2")?.state, "blocked");
    });
  }
});

test("cancelled branch requests retain pending ownership or settle a late receipt without recording a choice", async t => {
  offline(t);
  for (const known of [false, true]) {
    const f = fixture(), controller = new AbortController(), select = f.io.select;
    f.io.select = async (...args) => { const result = await select(...args); controller.abort();
      return known ? result : { type: "cancel" }; };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, controller.signal, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(result.reason, "cancelled"); assert.equal(result.workersStarted, 0);
    assert.equal(result.jevRequests, 1); assert.equal(result.reservedJevRequests, known ? 0 : 1); assert.equal(result.lockRetained, !known);
    assert.equal(result.plan?.nodes.find(node => node.id === "choose")?.chosenChoiceId, undefined);
    assert.equal(f.dtos.length, 0); assert.equal(result.costEstimate.delegationTotalUsd, null);
  }
});

test("validated v2 routing exceeds three only within its approved upper bound and uses bounded prior outcomes", async t => {
  offline(t);
  const graph: PlanGraph = { version: 2, entry: "c1", nodes: [], edges: [] };
  for (let i = 1; i <= 3; i++) {
    graph.nodes.push(branch(`c${i}`), { id: `t${i}`, kind: "task" });
    graph.edges.push({ from: `c${i}`, to: `t${i}`, when: "a" }, { from: `c${i}`, to: `t${i}`, when: "b" });
    if (i < 3) graph.edges.push({ from: `t${i}`, to: `c${i + 1}` });
  }
  const f = fixture(graph); f.scope.input.agents.push("strong"); f.scope.input.tasks.forEach(task => { delete task.agent; });
  f.scope.agents.push({ ...f.scope.agents[0]!, name: "strong", file: "/account/agents/strong.md" });
  f.scope.workerTargets.push({ ...f.scope.workerTargets[0]!, agent: "strong" });
  const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(result.jevRequests, 6); assert.equal(result.workersStarted, 3);
  assert.equal(result.reservedJevRequests, 0); assert.equal(result.lockRetained, false); assert.equal(ordinaryRoutingMaximum(f.scope.input), 6);
  const third = f.requests[2] as { task: string }, state = JSON.parse(third.task);
  assert.deepEqual(state.previousGraph, [{ type: "choice", nodeId: "c1", choiceId: "a" }, { type: "task", nodeId: "t1" }]);
  assert.deepEqual(state.outcomes, [{ id: "t1", agent: "worker", outcome: "completed", modelCalls: 1, accountingComplete: true, cleanupConfirmed: true }]);
  assert.equal(third.task.includes("PRIVATE_RAW_WORKER_REPLY"), false);
  const render = (value: OrdinaryPublicResult) => delegateResultView({ details: value }, { isPartial: false, expanded: true, isError: false }).text;
  assert.match(render(result), /JEV requests 6/);
  const { plan: _plan, ...noPlan } = result; assert.match(render(noPlan), /JEV requests unknown/);
  assert.match(render({ ...result, plan: { ...result.plan!, edges: [] } }), /JEV requests unknown/);
});

test("graph tool input runs through the same native lifecycle owner and remains closed after shutdown", async t => {
  offline(t);
  const f = fixture(), tools: ToolDefinition[] = [], handlers = new Map<string, (() => Promise<void>)[]>();
  for (const key of ["prepare", "confirm", "canonicalDirectory", "own", "checkContext", "checkFiles", "run", "select"] as const)
    t.mock.method(ordinaryIO, key, f.io[key] as never);
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, handler: () => Promise<void>) {
    handlers.set(event, [...handlers.get(event) ?? [], handler]);
  } } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!;
  assert.equal(tool.executionMode, "sequential");
  const result = await tool.execute("graph-call", { graph: f.scope.input }, t.signal, undefined, f.ctx);
  assert.equal((result.details as OrdinaryPublicResult).status, "completed_unverified");
  assert.equal(f.counts().approvals, 1); assert.ok(handlers.has("session_before_tree")); assert.ok(handlers.has("session_before_compact"));
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  await assert.rejects(tool.execute("graph-after-shutdown", { graph: f.scope.input }, t.signal, undefined, f.ctx), /owner is closed/);
  assert.equal(f.counts().approvals, 1);
});

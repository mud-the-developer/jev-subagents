import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { OrdinaryScopeInputSchema, OrdinaryGraphInputSchema, ordinaryRoutingMaximum, ordinaryScopeDigest, ordinaryBranchPlan,
  reduceOrdinaryAuthorization as reduce, validOrdinaryGraphInput, validOrdinaryPreparedScope, validOrdinaryScopeInput,
  type OrdinaryGraphInput, type OrdinaryPreparedScope, type OrdinaryAuthorizationState, type OrdinaryAuthorizationEvent } from "../src/ordinary-authorization.ts";
import { evaluatePlanGraph, maximumGraphTasks, type PlanGraph, type PlanGraphEvent } from "../src/plan-graph.ts";
import { ordinaryContextDigest, ordinaryRun, OrdinaryWorkerInputSchema, validOrdinaryWorkerInput, reduceOrdinaryRoutingAccounting } from "../src/ordinary-protocol.ts";
import { DelegateToolInputSchema, ordinaryApprovalPacket, ordinaryApprovalText } from "../src/ordinary-effects.ts";
import { ordinaryPlanView, planReceipt, validPlanReceipt } from "../src/plan-state.ts";

const branch = (id: string): PlanGraph["nodes"][number] => ({ id, kind: "choice", summary: `PRIVATE_CHOICE_SUMMARY_${id}`,
  choices: [{ id: "a", description: "PRIVATE_RUBRIC_A" }, { id: "b", description: "PRIVATE_RUBRIC_B" }] });
function diamond(): PlanGraph {
  return { version: 2, entry: "choose", nodes: [{ id: "next", kind: "task" }, { id: "join", kind: "join" },
    { id: "b1", kind: "task" }, { id: "a2", kind: "task" }, branch("choose"), { id: "a1", kind: "task" }],
  edges: [{ from: "join", to: "next" }, { from: "b1", to: "join" }, { from: "a2", to: "join" }, { from: "a1", to: "a2" },
    { from: "choose", to: "b1", when: "b" }, { from: "choose", to: "a1", when: "a" }] };
}
function fixture(plan = diamond()): Omit<OrdinaryPreparedScope, "input"> & { input: OrdinaryGraphInput } {
  const model = { provider: "offline", id: "fixture" };
  return { id: "graph", sessionId: "session", approvalDeadline: null, contextDigest: ordinaryContextDigest([], "/account"),
    routingTarget: "Approved anonymous JEV fixture", fileProtocol: "scoped_existing_files",
    input: { task: "Run only the chosen approved path.", agents: ["worker"], files: [{ path: "sample.txt", access: "read_write" }],
      tasks: plan.nodes.filter(node => node.kind === "task").map(node => ({ id: node.id, summary: `PRIVATE_TASK_${node.id}`, agent: "worker" })),
      plan, selection: "parent_or_jev", limits: { workerRuns: 3, seconds: 120, modelCalls: 6, perWorkerCalls: 2 } },
    agents: [{ name: "worker", model, file: "/account/agents/worker.md", description: "PRIVATE_PROFILE_RUBRIC", systemPrompt: "PRIVATE_PROFILE_SOURCE", tools: ["read", "edit"] }],
    workerTargets: [{ agent: "worker", api: "openai-completions", endpoint: "http://127.0.0.1:8000/v1" }],
    files: { id: "files", root: "/workspace", rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "sample.txt", access: "read_write",
      version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 7 } }] } };
}
function approved(scope = fixture()) {
  let result = reduce({ phase: "idle" }, { type: "start", input: scope.input, sessionId: scope.sessionId, now: 1000 });
  assert.deepEqual(result.effects.map(effect => effect.type), ["prepare"]);
  result = reduce(result.state, { type: "prepared", grant: scope, now: 1001 });
  assert.deepEqual(result.effects.map(effect => effect.type), ["confirm_scope"]);
  return reduce(result.state, { type: "approval", id: scope.id, digest: ordinaryScopeDigest(scope), approved: true, now: 1002 });
}
function choose(state: OrdinaryAuthorizationState, scope: OrdinaryPreparedScope, nodeId = "choose", choiceId = "a", confidence = 1) {
  return reduce(state, { type: "branch_selected", id: scope.id, nodeId, choiceId, confidence, now: 1003 });
}
function running(state: OrdinaryAuthorizationState, scope: OrdinaryPreparedScope, taskId: string) {
  const selected = reduce(state, { type: "selected", id: scope.id, taskId, selection: { source: "parent", agent: "worker" }, now: 1003 });
  assert.equal(selected.state.phase, "checking");
  return reduce(selected.state, { type: "fresh", id: scope.id, taskId, sessionId: scope.sessionId, digest: ordinaryScopeDigest(scope), current: true, now: 1003 });
}
function observation(scope: OrdinaryPreparedScope, taskId: string): Extract<OrdinaryAuthorizationEvent, { type: "observed" }> {
  return { type: "observed", id: scope.id, taskId, now: 1003,
    observation: { outcome: "completed", modelCalls: 1, accountingComplete: true, cleanupConfirmed: true, files: scope.files } };
}

test("graph input is a separate closed schema; legacy object/properties/max3 and ordinary inputs stay compatible", () => {
  const scope = fixture(), { plan: _plan, ...legacy } = scope.input;
  legacy.tasks = legacy.tasks.slice(0, 3);
  assert.equal(OrdinaryScopeInputSchema.type, "object"); assert.equal(Reflect.get(OrdinaryScopeInputSchema.properties.tasks, "maxItems"), 3);
  assert.equal(validOrdinaryScopeInput(legacy), true); assert.equal(Value.Check(DelegateToolInputSchema, { scope: legacy }), true);
  assert.equal(validOrdinaryGraphInput(scope.input), true); assert.equal(validOrdinaryPreparedScope(scope), true);
  assert.equal(Value.Check(DelegateToolInputSchema, { graph: scope.input }), true);
  assert.equal(Value.Check(DelegateToolInputSchema, { task: "Read the approved file.", agents: ["worker"] }), true);
  for (const property of ["events", "graphEvents", "grant", "state", "status", "restore"]) {
    assert.equal(Value.Check(DelegateToolInputSchema, { graph: scope.input, [property]: [] }), false);
    assert.equal(Value.Check(DelegateToolInputSchema, { graph: { ...scope.input, [property]: [] } }), false);
  }
  for (const field of ["after", "alternatives"]) assert.equal(Value.Check(OrdinaryGraphInputSchema,
    { ...scope.input, tasks: scope.input.tasks.map(task => ({ ...task, [field]: [] })) }), false);
  assert.equal(Value.Check(DelegateToolInputSchema, { scope: scope.input }), false);
  assert.equal(Value.Check(DelegateToolInputSchema, { graph: scope.input, scope: legacy }), false);
  assert.equal(Value.Check(OrdinaryGraphInputSchema, { ...scope.input, tasks: Array.from({ length: 17 }, () => scope.input.tasks[0]) }), false);
  assert.equal(validOrdinaryGraphInput({ ...scope.input, tasks: scope.input.tasks.slice(1) }), false);
  assert.equal(validOrdinaryGraphInput({ ...scope.input, tasks: [...scope.input.tasks, scope.input.tasks[0]] }), false);
  assert.equal(validOrdinaryGraphInput({ ...scope.input, selection: "parent_only" }), false);
  assert.equal(validOrdinaryPreparedScope({ ...scope, routingTarget: null }), false);
  const nonEnglish = structuredClone(scope.input), node = nonEnglish.plan.nodes.find(node => node.kind === "choice")!;
  if (node.kind !== "choice") assert.fail();
  node.summary = "비공개 작업"; assert.equal(validOrdinaryGraphInput(nonEnglish), false);
  node.summary = "Select an approved path."; node.choices[0]!.description = "비공개 작업";
  assert.equal(validOrdinaryGraphInput(nonEnglish), false);
  node.choices[0]!.description = "Preserve `비공개 작업` as literal data."; assert.equal(validOrdinaryGraphInput(nonEnglish), true);
});

test("static maximum path tasks, not shorter selections or catalog length, binds the original worker ceiling", () => {
  const scope = fixture(); assert.equal(scope.input.tasks.length, 4); assert.equal(maximumGraphTasks(scope.input.plan), 3);
  assert.equal(validOrdinaryGraphInput(scope.input), true);
  assert.equal(validOrdinaryGraphInput({ ...scope.input, limits: { ...scope.input.limits, workerRuns: 2 } }), false);
  assert.equal(validOrdinaryGraphInput({ ...scope.input, limits: { ...scope.input.limits, workerRuns: 4 } }), false);
  const tooLong = structuredClone(scope.input);
  tooLong.tasks.push({ id: "extra", summary: "An extra approved task." }); tooLong.plan.nodes.push({ id: "extra", kind: "task" });
  tooLong.plan.edges.push({ from: "next", to: "extra" });
  assert.equal(maximumGraphTasks(tooLong.plan), 4); assert.equal(validOrdinaryGraphInput(tooLong), false);
  for (const limits of [{ seconds: 86401 }, { workerRuns: 0 }, { modelCalls: 0 }, { perWorkerCalls: 0 }])
    assert.equal(validOrdinaryGraphInput({ ...scope.input, limits: { ...scope.input.limits, ...limits } }), false);
});

test("unordered unequal A/B diamond dispatches ready IDs and only the selected path joins", () => {
  for (const choiceId of ["a", "b"]) {
    const scope = fixture(); let result = approved(scope);
    assert.deepEqual(result.effects, [{ type: "select_branch", id: scope.id, nodeId: "choose" }]);
    result = choose(result.state, scope, "choose", choiceId, 0.5);
    const tasks = choiceId === "a" ? ["a1", "a2", "next"] : ["b1", "next"];
    for (const taskId of tasks) {
      assert.deepEqual(result.effects, [{ type: "select_worker", id: scope.id, taskId }]);
      result = running(result.state, scope, taskId);
      assert.equal(result.state.phase, "running");
      result = reduce(result.state, observation(scope, taskId));
    }
    assert.equal(result.state.phase, "finished"); assert.deepEqual(result.effects, []);
    if (!("graphEvents" in result.state)) assert.fail();
    assert.deepEqual(result.state.graphEvents, [{ type: "choice", nodeId: "choose", choiceId }, ...tasks.map(nodeId => ({ type: "task", nodeId }))]);
    const receipt = planReceipt(ordinaryPlanView(scope, result.state, 1)); assert.equal(validPlanReceipt(receipt), true);
    assert.equal(receipt.nodes.find(node => node.id === "join")?.state, "joined");
    assert.equal(receipt.nodes.find(node => node.id === (choiceId === "a" ? "b1" : "a1"))?.state, "skipped");
    assert.equal(receipt.nodes.find(node => node.id === "choose")?.chosenChoiceId, choiceId);
    assert.ok(receipt.edges?.some(edge => edge.status === "inactive"));
    assert.equal(JSON.stringify(receipt).includes("PRIVATE_"), false);
    assert.equal(validPlanReceipt({ ...receipt, status: "authorized" }), false);
    assert.equal(validPlanReceipt({ ...receipt, edges: receipt.edges?.map(edge => ({ ...edge, description: "PRIVATE_RUBRIC" })) }), false);
  }
});

test("independent readiness and nested skips are delegated to graph replay, never catalog order", () => {
  const independent: PlanGraph = { version: 2, entry: "root", nodes: [{ id: "z", kind: "task" }, { id: "a", kind: "task" }, { id: "root", kind: "join" }],
    edges: [{ from: "root", to: "z" }, { from: "root", to: "a" }] };
  const scope = fixture(independent); scope.input.selection = "parent_only"; scope.routingTarget = null;
  let result = approved(scope);
  for (const id of ["a", "z"]) {
    assert.deepEqual(result.effects, [{ type: "select_worker", id: scope.id, taskId: id }]);
    result = reduce(running(result.state, scope, id).state, observation(scope, id));
  }
  assert.equal(result.state.phase, "finished");
  const graph = diamond(); graph.nodes.push(branch("outer"), { id: "right", kind: "task" }); graph.entry = "outer";
  graph.edges.push({ from: "outer", to: "choose", when: "a" }, { from: "outer", to: "right", when: "b" });
  const nested = fixture(graph); result = choose(approved(nested).state, nested, "outer", "b");
  assert.deepEqual(result.effects, [{ type: "select_worker", id: nested.id, taskId: "right" }]);
  result = reduce(running(result.state, nested, "right").state, observation(nested, "right"));
  assert.equal(result.state.phase, "finished");
  const view = ordinaryPlanView(nested, result.state, 1);
  for (const id of ["choose", "a1", "a2", "b1", "join", "next"]) assert.equal(view.nodes.find(node => node.id === id)?.state, "skipped");
});

test("failure, weak/malformed choice support and uncertainty stop without another branch or task event", () => {
  const scope = fixture(), selected = choose(approved(scope).state, scope).state;
  for (const confidence of [0.49, -1, NaN, Infinity, 1.1]) {
    const result = choose(approved(scope).state, scope, "choose", "a", confidence);
    assert.equal(result.state.phase, "revoked"); assert.deepEqual(result.effects, []);
    assert.ok("startedWorkers" in result.state); assert.equal(result.state.startedWorkers, 0);
    assert.deepEqual("graphEvents" in result.state && result.state.graphEvents, []);
  }
  for (const extra of [{ outcome: "failed" }, { outcome: "cancelled" }, { cleanupConfirmed: false }, { accountingComplete: false }, { modelCalls: null }, { files: null }]) {
    const event = observation(scope, "a1"); Object.assign(event.observation, extra);
    const result = reduce(running(selected, scope, "a1").state, event);
    assert.equal(result.state.phase, "revoked"); assert.ok("graphEvents" in result.state);
    assert.deepEqual(result.state.graphEvents, [{ type: "choice", nodeId: "choose", choiceId: "a" }]);
    assert.ok(result.effects.every(effect => effect.type === "abort_worker"));
    assert.deepEqual(choose(result.state, scope, "choose", "b").state, result.state);
  }
});

test("v2 retains shared finite SDK caps, native round accounting and freshness admission", () => {
  const scope = fixture(); scope.input.limits.modelCalls = 1;
  const selected = choose(approved(scope).state, scope).state;
  const capped = reduce(running(selected, scope, "a1").state, observation(scope, "a1"));
  assert.equal(capped.state.phase, "revoked"); if (capped.state.phase !== "revoked") assert.fail();
  assert.equal(capped.state.reason, "budget"); assert.equal(capped.state.spentCalls, 1); assert.deepEqual(capped.effects, []);
  assert.deepEqual(capped.state.graphEvents, [{ type: "choice", nodeId: "choose", choiceId: "a" }, { type: "task", nodeId: "a1" }]);
  const checking = reduce(selected, { type: "selected", id: scope.id, taskId: "a1", selection: { source: "parent", agent: "worker" }, now: 1003 });
  const stale = reduce(checking.state, { type: "fresh", id: scope.id, taskId: "a1", sessionId: scope.sessionId, digest: ordinaryScopeDigest(scope), current: false, now: 1003 });
  assert.equal(stale.state.phase, "revoked"); assert.deepEqual(stale.effects, []);
  scope.input.limits.modelCalls = null; scope.input.limits.perWorkerCalls = null;
  let native = choose(approved(scope).state, scope);
  for (const taskId of ["a1", "a2", "next"]) {
    native = running(native.state, scope, taskId);
    assert.equal(native.effects[0]?.type, "run_worker"); if (native.effects[0]?.type !== "run_worker") assert.fail();
    assert.equal(native.effects[0].maxModelCalls, null);
    const event = observation(scope, taskId);
    native = reduce(native.state, { ...event, observation: { ...event.observation, modelCalls: 13 } });
  }
  assert.equal(native.state.phase, "finished"); assert.ok("spentCalls" in native.state); assert.equal(native.state.spentCalls, 39);
});

test("cancel/expiry preserves graph and selection diagnostics; late measured usage settles once without advance", () => {
  const scope = fixture(), state = running(choose(approved(scope).state, scope).state, scope, "a1").state;
  for (const now of [1004, 121002]) {
    const stopped = reduce(state, { type: "stop", reason: "cancelled", now });
    assert.equal(stopped.state.phase, "revoked"); if (stopped.state.phase !== "revoked") assert.fail();
    assert.equal(stopped.state.reason, now === 1004 ? "cancelled" : "expired");
    assert.deepEqual(stopped.state.selection, { source: "parent", agent: "worker" });
    const event = { ...observation(scope, "a1"), now: 121003 };
    const late = reduce(stopped.state, event);
    assert.equal(late.state.phase, "revoked"); if (late.state.phase !== "revoked") assert.fail();
    assert.equal(late.state.spentCalls, 1); assert.equal(late.state.reservedCalls, 0); assert.equal(late.state.cleanupPending, false);
    assert.deepEqual(late.state.graphEvents, stopped.state.graphEvents); assert.deepEqual(late.effects, []);
    assert.equal(reduce(late.state, event).state, late.state);
    assert.equal(reduce(late.state, { type: "start", input: scope.input, sessionId: scope.sessionId, now: 121004 }).state, late.state);
    const receipt = planReceipt(ordinaryPlanView(scope, late.state, 1));
    assert.equal(receipt.nodes.find(node => node.id === "choose")?.chosenChoiceId, "a");
    assert.equal(receipt.nodes.find(node => node.id === "b1")?.state, "skipped");
    assert.equal(receipt.nodes.find(node => node.id === "a1")?.state, "failed");
  }
});

test("private worker DTO requires exact graph replay; missing, reordered, skipped and nonready events are rejected", () => {
  const scope = fixture(), graphEvents: PlanGraphEvent[] = [{ type: "choice", nodeId: "choose", choiceId: "a" }];
  const dto = { scope, digest: ordinaryScopeDigest(scope), taskId: "a1", graphEvents,
    run: ordinaryRun(scope, "a1", scope.agents[0]!, 2), files: scope.files, context: [], agentDirectory: "/account",
    lockVersion: scope.files.files[0]!.version, approvedAt: 1002, deadline: 121002 };
  assert.equal(Value.Check(OrdinaryWorkerInputSchema, dto), true); assert.equal(validOrdinaryWorkerInput(dto), true);
  const { graphEvents: _events, ...missing } = dto;
  assert.equal(Value.Check(OrdinaryWorkerInputSchema, missing), false); assert.equal(validOrdinaryWorkerInput(missing), false);
  for (const events of [[], [{ type: "choice", nodeId: "choose", choiceId: "b" }], [...graphEvents, { type: "task", nodeId: "b1" }],
    [...graphEvents, { type: "task", nodeId: "a2" }], [...graphEvents, { type: "task", nodeId: "a1" }],
    [{ type: "task", nodeId: "a1" }, ...graphEvents], [...graphEvents, ...graphEvents], [{ ...graphEvents[0], grant: true }]])
    assert.equal(validOrdinaryWorkerInput({ ...dto, graphEvents: events }), false);
  for (const change of [{ deadline: dto.deadline + 1 }, { run: { ...dto.run, task: "PRIVATE_TAMPER" } },
    { run: { ...dto.run, maxModelCalls: null } }, { run: { ...dto.run, model: { provider: "offline", id: "other" } } },
    { scope: { ...scope, input: { ...scope.input, plan: { ...scope.input.plan, entry: "a1" } } } }])
    assert.equal(validOrdinaryWorkerInput({ ...dto, ...change }), false);
  const { plan: _plan, ...input } = scope.input; input.tasks = input.tasks.filter(task => task.id === "a1");
  const legacy = { ...scope, input }, legacyDto = { ...missing, scope: legacy, digest: ordinaryScopeDigest(legacy) };
  assert.equal(validOrdinaryWorkerInput(legacyDto), true);
  assert.equal(Value.Check(OrdinaryWorkerInputSchema, { ...legacyDto, graphEvents: [] }), false);
  assert.equal(validOrdinaryWorkerInput({ ...legacyDto, graphEvents: [] }), false);
});

test("approval reviews every source and routing upper bound; branch transmissions and receipts exclude worker/source prose", () => {
  const scope = fixture();
  const prepared = { scope, context: [], agentDirectory: "/account" }, packet = ordinaryApprovalPacket(prepared), text = ordinaryApprovalText(prepared);
  assert.deepEqual(JSON.parse(packet).scope, scope); assert.equal(JSON.parse(packet).maximumGraphTasks, 3);
  assert.equal(JSON.parse(packet).routing.maximumRequests, 1);
  for (const task of scope.input.tasks) assert.ok(text.includes(task.summary));
  for (const node of scope.input.plan.nodes) {
    assert.ok(text.includes(`${node.id} · ${node.kind}`));
    if (node.kind === "choice") { assert.ok(text.includes(node.summary)); for (const option of node.choices) assert.ok(text.includes(option.description)); }
  }
  for (const edge of scope.input.plan.edges) assert.ok(text.includes(`${edge.from} → ${edge.to}${edge.when ? ` · when ${edge.when}` : ""}`));
  for (const agent of scope.agents) { assert.ok(text.includes(agent.file)); assert.ok(text.includes(agent.systemPrompt)); assert.ok(text.includes(agent.description)); }
  assert.match(text, /maximumGraphTasks\(plan\) · 3/); assert.match(text, /Routing upper bound · 1/);
  const request = ordinaryBranchPlan(scope, "choose", [], [{ taskId: "prior", selection: { source: "parent", agent: "worker" },
    observation: { outcome: "completed", modelCalls: 1, accountingComplete: true, cleanupConfirmed: true, files: scope.files } }]);
  assert.ok(request); const wire = JSON.stringify(request);
  for (const forbidden of ["PRIVATE_TASK", "PRIVATE_PROFILE", "/workspace", "sample.txt", "systemPrompt", "files", "digest"]) assert.equal(wire.includes(forbidden), false);
  assert.ok(wire.includes("PRIVATE_CHOICE_SUMMARY")); assert.ok(wire.includes("PRIVATE_RUBRIC_A"));
  assert.deepEqual(evaluatePlanGraph(scope.input.plan, []).next, { kind: "choice", nodeId: "choose" });
});

test("routing ledger defaults stay at three; only a validated v2 scope admits its bounded larger catalog", () => {
  const scope = fixture(); scope.input.agents.push("strong"); scope.input.tasks.forEach(task => { delete task.agent; });
  assert.equal(validOrdinaryGraphInput(scope.input), true); assert.equal(ordinaryRoutingMaximum(scope.input), 5);
  const empty = { tasks: [], pending: [], reports: [], blocked: false };
  assert.equal(reduceOrdinaryRoutingAccounting(empty, { type: "attempt", taskId: "choose", maximum: 5 }).blocked, true);
  let ledger = reduceOrdinaryRoutingAccounting(empty, { type: "attempt", taskId: "choose", maximum: 5, input: scope.input });
  for (const task of scope.input.tasks) ledger = reduceOrdinaryRoutingAccounting(ledger, { type: "attempt", taskId: task.id, maximum: 5, input: scope.input });
  assert.equal(ledger.blocked, false); assert.equal(ledger.pending.length, 5);
  for (const maximum of [4, 6, 17]) assert.equal(reduceOrdinaryRoutingAccounting(empty, { type: "attempt", taskId: "choose", maximum, input: scope.input }).blocked, true);
  assert.equal(reduceOrdinaryRoutingAccounting(ledger, { type: "attempt", taskId: "choose", maximum: 5, input: scope.input }).blocked, true);
});

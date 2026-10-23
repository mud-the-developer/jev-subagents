import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DelegateToolInputSchema } from "../src/ordinary-effects.ts";
import { reduceTaskTree, validTaskTree, validTreePrepared, treeLive, treeMetrics, treeOptions, treeRequest, type TaskTreeInput, type TreeState } from "../src/task-tree.ts";
import { prepareTaskTree, taskTree } from "../src/task-tree-effects.ts";
import { taskTreeView } from "../src/task-tree-view.ts";
import { planReceipt, validPlanReceipt } from "../src/plan-state.ts";
import { treeFixture, treeRouting } from "./helpers/task-tree-fixture.ts";

const observation = { outcome: "completed" as const, started: true, modelCalls: 1, accountingComplete: true, cleanupConfirmed: true, observedUsd: 0.001, current: true };
const jev = { model: "openjev-0.1", provider: "openjev" as const, usage: { inputTokens: 1, outputTokens: 1 } };
function approved() {
  const f = treeFixture();
  let state = reduceTaskTree({ phase: "idle" }, { type: "start", input: f.input }).state;
  state = reduceTaskTree(state, { type: "prepared", tree: f.tree }).state;
  return { ...f, step: reduceTaskTree(state, { type: "approval", accepted: true, now: 1000 }) };
}
test("closed tree schema rejects malformed, cyclic, over-bound and caller authority before IO", async () => {
  const f = treeFixture(); assert.ok(validTaskTree(f.input)); assert.ok(validTreePrepared(f.tree));
  assert.equal(Value.Check(DelegateToolInputSchema, { tree: f.input }), true);
  const cases: unknown[] = [null, { ...f.input, approved: true }, { ...f.input, parallel: {} }, { ...f.input, limits: { ...f.input.limits, workerRuns: 4 } },
    { ...f.input, nodes: [...f.input.nodes, { ...f.input.nodes[0], id: "d" }] }, { ...f.input, edges: [...f.input.edges, { from: "c", to: "a", kind: "dependency" }] },
    { ...f.input, edges: [{ from: "a", to: "missing", kind: "dependency" }] }, { ...f.input, nodes: [f.input.nodes[0], f.input.nodes[0]] },
    { ...f.input, limits: { ...f.input.limits, modelCalls: 3 } }, { ...f.input, limits: { ...f.input.limits, perWorkerCalls: null } },
    { ...f.input, files: [{ path: "AGENTS.md", access: "read_write" }] }];
  for (const input of cases) { assert.equal(validTaskTree(input), false); const result = await taskTree(input, f.ctx, undefined, f.io); assert.equal(result.metrics.workersStarted, 0); assert.equal(result.metrics.jevRequests, 0); }
  assert.equal(f.counts().preparations, 0); assert.equal(f.counts().confirmations, 0);
  for (const property of ["grant", "events", "state", "memory", "parallelRead"]) assert.equal(Value.Check(DelegateToolInputSchema, { tree: f.input, [property]: {} }), false);
});
test("human-only display labels name declared tasks and never widen transcript receipt fields", () => {
  const f = treeFixture();
  assert.equal(validTaskTree({ ...f.input, display: { labels: { a: "Inspect the approved source" } } }), true);
  for (const labels of [{ missing: "Inspect source" }, { a: " " }, { a: "x".repeat(121) }, { a: 1 }, { a: "Inspect", b: "Read", c: "Review", d: "Extra" }])
    assert.equal(validTaskTree({ ...f.input, display: { labels } }), false);
  const view = taskTreeView(f.tree, { phase: "approval", tree: f.tree, reviews: 0 }, 0);
  assert.equal(validPlanReceipt({ ...planReceipt(view), display: { labels: { a: "DISPLAY_ONLY" } } }), false);
});
test("task dependency depth defaults to3, is order-independent, and uses the maximum join predecessor", () => {
  const f = treeFixture();
  for (const edges of [
    [],
    [{ from: "a", to: "c", kind: "dependency" as const }, { from: "b", to: "c", kind: "dependency" as const }],
    [{ from: "a", to: "b", kind: "dependency" as const }, { from: "b", to: "c", kind: "dependency" as const }, { from: "a", to: "c", kind: "dependency" as const }],
  ]) {
    const required = edges.length === 0 ? 1 : edges.length === 2 ? 2 : 3;
    for (const nodes of [f.input.nodes, [...f.input.nodes].reverse()]) for (const maxDepth of [1, 2, 3, undefined]) {
      const input = { ...f.input, nodes, edges, limits: { ...f.input.limits, ...(maxDepth !== undefined ? { maxDepth } : {}) } };
      assert.equal(validTaskTree(input), (maxDepth ?? 3) >= required);
    }
  }
  // The task->info->task path is not an extra dependency level.
  f.input.nodes.push({ kind: "info", id: "finding", infoKind: "warning", title: "Generated finding" });
  f.input.edges.push({ from: "a", to: "finding", kind: "produced" }, { from: "finding", to: "c", kind: "reference" });
  f.input.limits.maxDepth = 2; assert.equal(validTaskTree(f.input), true);
  f.input.limits.maxDepth = 1; assert.equal(validTaskTree(f.input), false);
});
test("malformed depth/display settings and excess depth have zero preparation, network, review or dispatch effects", async t => {
  const f = treeFixture(), forbidden = () => { throw new Error("Invalid input must not reach IO."); };
  const mocks = Object.keys(f.io).map(key => t.mock.method(f.io, key as keyof typeof f.io, forbidden));
  const network = t.mock.method(globalThis, "fetch", forbidden);
  const invalid: unknown[] = [
    ...[0, -1, 4, 1.5, "2", null, NaN, Infinity, true, {}].map(maxDepth => ({ ...f.input, limits: { ...f.input.limits, maxDepth } })),
    ...[null, false, [], "static", { maxDepth: 0 }, { maxDepth: 4 }, { maxDepth: 1.5 }, { maxDepth: "1" }, { maxDepth: null },
      { animations: 1 }, { animations: "false" }, { animations: null }, { frame: 1 }, { maxDepth: 1, approved: true }].map(display => ({ ...f.input, display })),
    { ...f.input, limits: { ...f.input.limits, maxDepth: 1 }, display: { maxDepth: 3 } },
    { ...f.input, edges: [...f.input.edges, { from: "c", to: "a", kind: "dependency" }], limits: { ...f.input.limits, maxDepth: 3 } },
  ];
  for (const input of invalid) {
    const step = reduceTaskTree({ phase: "idle" }, { type: "start", input });
    assert.deepEqual(step.effects, []); assert.equal(step.state.phase, "terminal");
    const result = await taskTree(input, f.ctx, t.signal, f.io);
    assert.equal(result.status, "stopped"); assert.equal(result.metrics.workersStarted, 0); assert.equal(result.metrics.jevRequests, 0);
    await assert.rejects(prepareTaskTree(input as TaskTreeInput, f.ctx, t.signal), /Task tree stopped/);
  }
  for (const mock of [...mocks, network]) assert.equal(mock.mock.callCount(), 0);
});
test("execution depth and display depth are independent; receipts retain only safe preferences", async t => {
  for (const maxDepth of [1, 2, 3]) for (const animations of [true, false]) {
    const f = treeFixture();
    f.input.edges = [{ from: "a", to: "b", kind: "dependency" }, { from: "b", to: "c", kind: "dependency" }];
    f.input.limits.maxDepth = 3; f.input.display = { maxDepth, animations };
    const result = await taskTree(f.input, f.ctx, t.signal, f.io);
    assert.equal(result.status, "completed_unverified"); assert.deepEqual(f.packets.map(packet => packet.task.id), ["a", "b", "c"]);
    assert.equal(result.metrics.workersStarted, 3); assert.equal(result.metrics.peak, 1);
    assert.deepEqual(result.plan?.display, { maxDepth, animations }); assert.ok(validPlanReceipt(planReceipt(result.plan!)));
    assert.ok(f.packets.every(packet => !("display" in packet) && packet.run.maxModelCalls === 2 && packet.run.seconds === 60));
  }
  const f = treeFixture(); f.input.edges = []; f.input.limits.maxDepth = 1;
  assert.equal((await taskTree(f.input, f.ctx, t.signal, f.io)).metrics.workersStarted, 3);
  const view = taskTreeView(f.tree, { phase: "approval", tree: f.tree, reviews: 0 }, 0);
  assert.deepEqual(view.display, { maxDepth: 3, animations: true }, "Full display defaults independently of the execution cap");
  assert.equal(validTaskTree({ ...f.input, display: {} }), true);
  const receipt = planReceipt({ ...view, display: { maxDepth: 1, animations: false, frame: 4, source: "PRIVATE" } } as typeof view);
  assert.deepEqual(receipt.display, { maxDepth: 1, animations: false });
  assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|frame|source/);
  for (const extra of [{ tick: 1 }, { elapsedMs: 2 }, { source: "PRIVATE" }, { grant: true }, { maxDepth: 4 }, { animations: "false" }]) {
    assert.equal(validPlanReceipt({ ...receipt, display: { ...receipt.display, ...extra } }), false);
  }
});
test("readiness is order-independent; completion unlocks descendants without waiting for an unrelated branch", () => {
  const f = approved(); let step = f.step;
  assert.deepEqual(step.effects, [{ type: "check", taskId: "a" }]);
  step = reduceTaskTree(step.state, { type: "fresh", taskId: "a", current: true, now: 1001 });
  assert.deepEqual(step.effects, [{ type: "run", taskId: "a" }, { type: "check", taskId: "b" }]);
  step = reduceTaskTree(step.state, { type: "fresh", taskId: "b", current: true, now: 1002 });
  assert.deepEqual(step.effects, [{ type: "run", taskId: "b" }]);
  step = reduceTaskTree(step.state, { type: "observed", taskId: "a", observation });
  assert.deepEqual(step.effects, [{ type: "check", taskId: "c" }]); assert.equal(treeLive(step.state)?.rows.find(row => row.id === "b")?.phase, "running");
  const reverse = treeFixture(); reverse.input.nodes.reverse(); reverse.tree.input = reverse.input;
  let state = reduceTaskTree({ phase: "idle" }, { type: "start", input: reverse.input }).state;
  state = reduceTaskTree(state, { type: "prepared", tree: reverse.tree }).state;
  assert.deepEqual(reduceTaskTree(state, { type: "approval", accepted: true, now: 1000 }).effects, f.step.effects);
});
test("tree view keeps admitted but unobserved SDK counts unknown and retains only observed partial counts", () => {
  const f = approved();
  let state = reduceTaskTree(f.step.state, { type: "fresh", taskId: "a", current: true, now: 1001 }).state;
  const unknown = taskTreeView(f.tree, state, 1002);
  assert.equal(unknown.nodes.find(node => node.id === "a")?.modelCalls, null);
  assert.equal(unknown.modelCallsKnown, false); assert.equal(unknown.modelCalls, 0);
  state = reduceTaskTree(state, { type: "progress", taskId: "a", progress: { type: "jev_worker_progress", version: 1,
    sequence: 1, phase: "model_request", elapsedMs: 10, modelCalls: 2, toolCalls: 0 } }).state;
  assert.equal(taskTreeView(f.tree, state, 1011).nodes.find(node => node.id === "a")?.modelCalls, 2);
  state = reduceTaskTree(state, { type: "observed", taskId: "a", observation: { ...observation, modelCalls: null } }).state;
  const partial = taskTreeView(f.tree, state, 1012);
  assert.equal(partial.modelCallsKnown, false); assert.equal(partial.modelCalls, 2);
  assert.equal(partial.nodes.find(node => node.id === "a")?.modelCalls, null);
});
test("failure, unknown usage/cleanup and cancellation prevent descendants while late observations settle exactly once", () => {
  for (const bad of [{ ...observation, cleanupConfirmed: false }, { ...observation, accountingComplete: false }, { ...observation, modelCalls: null }, { ...observation, current: false }, { ...observation, outcome: "failed" as const }]) {
    const f = approved(); let step = reduceTaskTree(f.step.state, { type: "fresh", taskId: "a", current: true, now: 1001 });
    step = reduceTaskTree(step.state, { type: "fresh", taskId: "b", current: true, now: 1002 });
    step = reduceTaskTree(step.state, { type: "observed", taskId: "a", observation: bad });
    assert.equal(step.state.phase, "draining"); assert.deepEqual(step.effects, [{ type: "abort" }]);
    step = reduceTaskTree(step.state, { type: "observed", taskId: "b", observation });
    assert.equal(treeLive(step.state)?.rows.find(row => row.id === "c")?.phase, "stopped");
    const metrics = treeMetrics(step.state);
    assert.deepEqual(treeMetrics(reduceTaskTree(step.state, { type: "observed", taskId: "b", observation }).state), metrics);
    const end = reduceTaskTree(step.state, { type: "drained", cleanupConfirmed: bad.cleanupConfirmed }).state;
    assert.equal(end.phase, "terminal"); assert.deepEqual(reduceTaskTree(end, { type: "approval", accepted: true, now: 2000 }), { state: end, effects: [] });
  }
  const f = approved(); let state = reduceTaskTree(f.step.state, { type: "fresh", taskId: "a", current: true, now: 1001 }).state;
  state = reduceTaskTree(state, { type: "stop", reason: "cancelled" }).state;
  assert.equal(reduceTaskTree(state, { type: "fresh", taskId: "b", current: true, now: 1002 }).effects.length, 0);
  state = reduceTaskTree(state, { type: "observed", taskId: "a", observation }).state;
  assert.equal(treeMetrics(state).modelCalls, 1); assert.equal(treeMetrics(state).reservedModelCalls, 0);
});
test("metadata-only per-node tuple/information decisions exclude bodies, private worker input and unreferenced records", t => {
  const f = treeFixture(); treeRouting(t, f.tree);
  f.input.nodes.push({ kind: "info", id: "rule", infoKind: "constraint", title: "Public compatibility rule", body: { content: "PRIVATE_RECORD_BODY", provenance: "PRIVATE_PROVENANCE" } });
  f.input.edges.push({ kind: "reference", from: "rule", to: "a" });
  f.tree.agents.push({ ...f.tree.agents[0]!, name: "scout_two", model: { provider: "offline", id: "second" } });
  f.tree.targets.push({ ...f.tree.targets[0]!, agent: "scout_two" });
  const a = f.input.nodes.find(node => node.id === "a")!; if (a.kind !== "task") assert.fail(); a.agents.push("scout_two");
  assert.ok(validTreePrepared(f.tree)); assert.equal(treeOptions(f.tree, "a").length, 4);
  const request = JSON.stringify(treeRequest(f.tree, "a")); assert.match(request, /Public compatibility rule/); assert.match(request, /second/);
  assert.doesNotMatch(request, /PRIVATE|systemPrompt|provenance|content/); assert.doesNotMatch(JSON.stringify(treeRequest(f.tree, "b")), /compatibility|rule/);
  let state: TreeState = reduceTaskTree({ phase: "idle" }, { type: "start", input: f.input }).state;
  state = reduceTaskTree(state, { type: "prepared", tree: f.tree }).state; state = reduceTaskTree(state, { type: "approval", accepted: true, now: 1000 }).state;
  state = reduceTaskTree(state, { type: "attempt", taskId: "a" }).state;
  const step = reduceTaskTree(state, { type: "decision", taskId: "a", option: "option_1_1", support: 0.49, report: jev });
  assert.deepEqual(step.effects, [{ type: "choose", taskId: "a" }]); assert.equal(treeMetrics(step.state).jevRequests, 1);
  assert.equal(reduceTaskTree(step.state, { type: "choice", taskId: "a", selection: { agent: "scout_two", ids: ["unknown"] } }).state.phase, "draining");
  const accepted = reduceTaskTree(step.state, { type: "choice", taskId: "a", selection: { agent: "scout_two", ids: ["rule"] } });
  assert.deepEqual(accepted.effects, [{ type: "check", taskId: "a" }]);
  assert.equal(treeLive(accepted.state)?.rows.find(row => row.id === "a")?.selection?.agent, "scout_two");
  const boundary = reduceTaskTree(state, { type: "decision", taskId: "a", option: "option_1_1", support: 0.5, report: jev });
  assert.deepEqual(boundary.effects, [{ type: "check", taskId: "a" }]);
});
test("graph and snapshot caps reject excess rather than truncating or widening a grant", () => {
  const f = treeFixture();
  const oversized = structuredClone(f.input);
  for (let i = 0; i < 8; i++) { oversized.nodes.push({ kind: "info", id: `info_${i}`, infoKind: "warning", title: "Public warning", body: { content: "x".repeat(2000), provenance: "Synthetic data." } }); oversized.edges.push({ from: `info_${i}`, to: "a", kind: "reference" }); }
  assert.equal(validTaskTree(oversized), false);
  const cyclic: TaskTreeInput = { ...f.input, nodes: [...f.input.nodes, { kind: "info", id: "generated", infoKind: "decision", title: "Generated result" }],
    edges: [...f.input.edges, { from: "c", to: "generated", kind: "produced" }, { from: "generated", to: "a", kind: "reference" }] };
  assert.equal(validTaskTree(cyclic), false);
  const noDependency = { ...cyclic, edges: [{ from: "a", to: "generated", kind: "produced" }, { from: "generated", to: "c", kind: "reference" }] };
  assert.equal(validTaskTree(noDependency), false);
  const badProfile = structuredClone(f.tree); badProfile.agents[0]!.tools.push("bash"); assert.equal(validTreePrepared(badProfile), false);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PlanGraphSchema, PlanGraphEventSchema, PlanGraphEventsSchema, validPlanGraph, evaluatePlanGraph, maximumGraphTasks,
  type PlanGraph, type PlanGraphEvent, type PlanGraphEvents } from "../src/plan-graph.ts";

const task = (nodeId: string): PlanGraphEvent => ({ type: "task", nodeId });
const choice = (nodeId: string, choiceId: string): PlanGraphEvent => ({ type: "choice", nodeId, choiceId });
const choiceNode = (id: string, a = "a", b = "b"): PlanGraph["nodes"][number] => ({ id, kind: "choice", summary: "Select an approved branch.",
  choices: [{ id: a, description: "First approved branch." }, { id: b, description: "Second approved branch." }] });
const catalog = (graph: PlanGraph) => graph.nodes.filter(node => node.kind === "task").map(node => node.id);
function diamond(): PlanGraph {
  return { version: 2, entry: "choose", nodes: [choiceNode("choose"), { id: "a1", kind: "task" }, { id: "a2", kind: "task" },
    { id: "b1", kind: "task" }, { id: "join", kind: "join" }, { id: "next", kind: "task" }],
  edges: [{ from: "choose", to: "a1", when: "a" }, { from: "choose", to: "b1", when: "b" }, { from: "a1", to: "a2" },
    { from: "a2", to: "join" }, { from: "b1", to: "join" }, { from: "join", to: "next" }] };
}
function nested(): PlanGraph {
  return { version: 2, entry: "outer", nodes: [choiceNode("outer", "left", "right"), choiceNode("inner", "short", "long"),
    { id: "short", kind: "task" }, { id: "long1", kind: "task" }, { id: "long2", kind: "task" }, { id: "right", kind: "task" },
    { id: "branch_join", kind: "join" }, { id: "merge", kind: "join" }, { id: "next", kind: "task" }],
  edges: [{ from: "outer", to: "inner", when: "left" }, { from: "outer", to: "right", when: "right" },
    { from: "inner", to: "short", when: "short" }, { from: "inner", to: "long1", when: "long" }, { from: "long1", to: "long2" },
    { from: "short", to: "branch_join" }, { from: "long2", to: "branch_join" }, { from: "branch_join", to: "merge" },
    { from: "right", to: "merge" }, { from: "merge", to: "next" }] };
}
function fanout(mergeKind: "task" | "join" | "choice" = "join"): PlanGraph {
  return { version: 2, entry: "start", nodes: [{ id: "start", kind: "join" }, { id: "a", kind: "task" }, choiceNode("z"),
    { id: "b", kind: "task" }, { id: "c", kind: "task" }, mergeKind === "choice" ? choiceNode("merge") : { id: "merge", kind: mergeKind },
    { id: "next", kind: "task" }],
  edges: [{ from: "start", to: "a" }, { from: "start", to: "z" }, { from: "a", to: "merge" },
    { from: "z", to: "b", when: "a" }, { from: "z", to: "c", when: "b" }, { from: "b", to: "merge" }, { from: "c", to: "merge" },
    ...(mergeKind === "choice" ? [{ from: "merge", to: "next", when: "a" }, { from: "merge", to: "next", when: "b" }]
      : [{ from: "merge", to: "next" }])] };
}
function chain(length: number): PlanGraph {
  return { version: 2, entry: "n0", nodes: Array.from({ length }, (_, i) => ({ id: `n${i}`, kind: "task" })),
    edges: Array.from({ length: Math.max(0, length - 1) }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })) };
}
function binaryStages(count: number): PlanGraph {
  const graph: PlanGraph = { version: 2, entry: "c0", nodes: [{ id: "end", kind: "join" }], edges: [] };
  for (let i = 0; i < count; i++) {
    graph.nodes.push(choiceNode(`c${i}`), { id: `a${i}`, kind: "task" }, { id: `b${i}`, kind: "task" });
    graph.edges.push({ from: `c${i}`, to: `a${i}`, when: "a" }, { from: `c${i}`, to: `b${i}`, when: "b" },
      { from: `a${i}`, to: i + 1 === count ? "end" : `c${i + 1}` }, { from: `b${i}`, to: i + 1 === count ? "end" : `c${i + 1}` });
  }
  return graph;
}
function route(graph: PlanGraph, selections: Readonly<Record<string, string>> = {}): PlanGraphEvents {
  const events: PlanGraphEvents = [];
  for (let i = 0; i <= 16; i++) {
    const { next } = evaluatePlanGraph(graph, events);
    if (next.kind === "finished") return events;
    if (next.kind === "task") events.push(task(next.nodeId));
    else {
      assert.ok(selections[next.nodeId], "The fixture must explicitly select each reached choice.");
      events.push(choice(next.nodeId, selections[next.nodeId]!));
    }
  }
  assert.fail("The bounded fixture did not finish.");
}
function rejects(graph: unknown, events: unknown = []) {
  assert.throws(() => evaluatePlanGraph(graph, events), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Invalid plan graph input.");
    assert.deepEqual(Object.keys(error), []);
    return true;
  });
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("v2 graph and event schemas are closed, bounded and use the existing lowercase IDs", () => {
  const graph = diamond();
  assert.equal(Value.Check(PlanGraphSchema, graph), true);
  assert.equal(validPlanGraph(graph, catalog(graph)), true);
  assert.equal(Value.Check(PlanGraphEventSchema, choice("choose", "a")), true);
  assert.equal(Value.Check(PlanGraphEventsSchema, [choice("choose", "a"), task("a1")]), true);
  for (const invalid of [
    { ...graph, version: 1 }, { ...graph, private: "PRIVATE_DATA" }, { ...graph, entry: "Choose" },
    { ...graph, nodes: graph.nodes.map(node => ({ ...node, state: "completed" })) },
    { ...graph, nodes: [{ ...choiceNode("choose"), choices: [{ id: "a", description: "First.", selected: true }, { id: "b", description: "Second." }] }] },
    { ...graph, edges: graph.edges.map(edge => ({ ...edge, active: true })) },
  ]) {
    assert.equal(Value.Check(PlanGraphSchema, invalid), false);
    assert.equal(validPlanGraph(invalid, catalog(graph)), false);
    rejects(invalid);
  }
  for (const invalidId of ["", "UPPER", "has space", "_first", "a.b", "a\n", "a".repeat(65)]) {
    const invalid = { version: 2, entry: invalidId, nodes: [{ id: invalidId, kind: "task" }], edges: [] };
    assert.equal(validPlanGraph(invalid, [invalidId]), false);
    assert.equal(Value.Check(PlanGraphEventSchema, task(invalidId)), false);
  }
  for (const id of ["0", "a_b-c", "a".repeat(64), "constructor"]) {
    const valid = { version: 2, entry: id, nodes: [{ id, kind: "task" }], edges: [] };
    assert.equal(validPlanGraph(valid, [id]), true);
    assert.equal(evaluatePlanGraph(valid, [task(id)]).nodes[id], "completed");
  }
});

test("task nodes bijectively match the supplied catalog without imposing a new worker allowance", () => {
  const graph = diamond(), ids = catalog(graph);
  assert.equal(ids.length, 4);
  assert.equal(validPlanGraph(graph, [...ids].reverse()), true);
  for (const invalid of [null, {}, ["a1"], [...ids, "foreign"], [...ids, ids[0]], ["choose", "a2", "b1", "next"],
    ["a1", "a1", "b1", "next"]]) assert.equal(validPlanGraph(graph, invalid), false);
  assert.equal(validPlanGraph(chain(4), catalog(chain(4))), true);
  assert.equal(maximumGraphTasks(chain(4)), 4);
});

test("permuting node, edge and option arrays preserves every replay snapshot and ready sequence", () => {
  for (const [graph, selections] of [[diamond(), { choose: "a" }], [diamond(), { choose: "b" }],
    [nested(), { outer: "left", inner: "long" }], [fanout(), { z: "b" }]] as const) {
    const expected = route(graph, selections);
    for (let shift = 0; shift < graph.nodes.length; shift++) {
      const permuted: PlanGraph = { ...graph,
        nodes: [...graph.nodes.slice(shift), ...graph.nodes.slice(0, shift)].reverse().map(node => node.kind === "choice"
          ? { ...node, choices: [...node.choices].reverse() } : node),
        edges: [...graph.edges.slice(shift), ...graph.edges.slice(0, shift)].reverse() };
      assert.equal(validPlanGraph(permuted, catalog(graph)), true);
      assert.deepEqual(route(permuted, selections), expected);
      assert.equal(maximumGraphTasks(permuted), maximumGraphTasks(graph));
      for (let i = 0; i <= expected.length; i++) {
        assert.deepEqual(evaluatePlanGraph(permuted, expected.slice(0, i)), evaluatePlanGraph(graph, expected.slice(0, i)));
      }
    }
  }
});

test("the unequal diamond skips recursively and rejoins only after the selected tasks complete", () => {
  const graph = diamond(), initial = evaluatePlanGraph(graph, []);
  assert.deepEqual(initial.next, { kind: "choice", nodeId: "choose" });
  assert.ok(initial.edges.every(edge => edge.status === "pending"));
  const selected = evaluatePlanGraph(graph, [choice("choose", "a")]);
  assert.deepEqual(selected.nodes, { choose: "completed", a1: "ready", a2: "waiting", b1: "skipped", join: "waiting", next: "waiting" });
  assert.deepEqual(selected.edges, [
    { from: "a1", to: "a2", status: "active" }, { from: "a2", to: "join", status: "active" },
    { from: "b1", to: "join", status: "inactive" }, { from: "choose", to: "a1", when: "a", status: "active" },
    { from: "choose", to: "b1", when: "b", status: "inactive" }, { from: "join", to: "next", status: "active" },
  ]);
  const first = evaluatePlanGraph(graph, [choice("choose", "a"), task("a1")]);
  assert.deepEqual(first.next, { kind: "task", nodeId: "a2" });
  assert.equal(first.nodes.join, "waiting");
  const joined = evaluatePlanGraph(graph, [choice("choose", "a"), task("a1"), task("a2")]);
  assert.equal(joined.nodes.join, "completed");
  assert.deepEqual(joined.next, { kind: "task", nodeId: "next" });
  const other = evaluatePlanGraph(graph, [choice("choose", "b")]);
  assert.equal(other.nodes.a1, "skipped"); assert.equal(other.nodes.a2, "skipped");
  assert.equal(other.nodes.join, "waiting");
  assert.deepEqual(route(graph, { choose: "a" }), [choice("choose", "a"), task("a1"), task("a2"), task("next")]);
  const short = route(graph, { choose: "b" });
  assert.deepEqual(short, [choice("choose", "b"), task("b1"), task("next")]);
  assert.deepEqual(evaluatePlanGraph(graph, short).next, { kind: "finished" });
});

test("nested inactive choices and their descendants skip without choice events", () => {
  const graph = nested(), selected = evaluatePlanGraph(graph, [choice("outer", "right")]);
  for (const id of ["inner", "short", "long1", "long2", "branch_join"]) assert.equal(selected.nodes[id], "skipped");
  assert.equal(selected.nodes.merge, "waiting");
  assert.ok(selected.edges.filter(edge => edge.from === "inner").every(edge => edge.status === "inactive"));
  assert.deepEqual(route(graph, { outer: "right" }), [choice("outer", "right"), task("right"), task("next")]);
  assert.deepEqual(route(graph, { outer: "left", inner: "long" }),
    [choice("outer", "left"), choice("inner", "long"), task("long1"), task("long2"), task("next")]);
  assert.deepEqual(route(graph, { outer: "left", inner: "short" }),
    [choice("outer", "left"), choice("inner", "short"), task("short"), task("next")]);
  rejects(graph, [choice("outer", "short")]);
  rejects(graph, [choice("outer", "left"), choice("inner", "right")]);
  rejects(graph, [choice("outer", "right"), choice("inner", "short")]);
});

test("joins, tasks and choices wait for all incoming resolutions and all active predecessors", () => {
  for (const kind of ["join", "task", "choice"] as const) {
    const graph = fanout(kind), initial = evaluatePlanGraph(graph, []);
    assert.equal(validPlanGraph(graph, catalog(graph)), true);
    assert.equal(initial.nodes.start, "completed");
    assert.equal(initial.nodes.a, "ready"); assert.equal(initial.nodes.z, "ready");
    assert.deepEqual(initial.next, { kind: "task", nodeId: "a" });
    const waiting = evaluatePlanGraph(graph, [task("a")]);
    assert.equal(waiting.nodes.merge, "waiting");
    assert.equal(waiting.edges.find(edge => edge.from === "b")?.status, "pending");
    assert.deepEqual(waiting.next, { kind: "choice", nodeId: "z" });
    rejects(graph, [task("a"), kind === "choice" ? choice("merge", "a") : task("merge")]);
    const events = [task("a"), choice("z", "a")];
    assert.equal(evaluatePlanGraph(graph, events).nodes.merge, "waiting");
    events.push(task("b"));
    const joined = evaluatePlanGraph(graph, events);
    assert.equal(joined.nodes.c, "skipped");
    assert.equal(joined.nodes.merge, kind === "join" ? "completed" : "ready");
    assert.deepEqual(joined.next, kind === "join" ? { kind: "task", nodeId: "next" } : { kind, nodeId: "merge" });
    assert.deepEqual(evaluatePlanGraph(graph, route(graph, { z: "a", merge: "b" })).next, { kind: "finished" });
  }
});

test("lexical readiness is recomputed after each event, without task/choice priority", () => {
  const graph: PlanGraph = { version: 2, entry: "start", nodes: [{ id: "start", kind: "join" }, choiceNode("a"),
    { id: "b", kind: "task" }, { id: "0", kind: "task" }, { id: "1", kind: "task" }],
  edges: [{ from: "start", to: "a" }, { from: "start", to: "b" }, { from: "a", to: "0", when: "a" }, { from: "a", to: "1", when: "b" }] };
  assert.deepEqual(route(graph, { a: "a" }), [choice("a", "a"), task("0"), task("b")]);
  rejects(graph, [task("b")]);
  rejects(graph, [choice("a", "a"), task("b")]);
});

test("closed event replay rejects foreign, duplicate, skipped, nonready, reordered and after-finish events", () => {
  const graph = diamond(), valid = route(graph, { choose: "a" });
  const tampered: unknown[] = [null, {}, { events: valid, nodes: { next: "completed" } },
    [task("choose")], [choice("a1", "a")], [choice("choose", "foreign")], [task("foreign")], [task("a1")],
    [choice("choose", "a"), choice("choose", "b")], [choice("choose", "a"), task("a2")],
    [choice("choose", "a"), task("a1"), task("a1")], [choice("choose", "b"), task("a1")],
    [choice("choose", "a"), task("a1"), task("join")], valid.slice(1), [...valid].reverse(), [...valid, task("next")],
    [{ ...choice("choose", "a"), state: "completed" }], [{ type: "task", nodeId: "choose", choiceId: "a" }],
    [{ type: "choice", nodeId: "choose" }], [{ type: "failure", nodeId: "choose" }],
    [choice("choose", "a"), { ...task("a1"), outcome: "failed" }], Array.from({ length: 17 }, () => task("a1")),
  ];
  for (const events of tampered) rejects(graph, events);
  const changed = structuredClone(valid);
  changed[0] = choice("choose", "b");
  rejects(graph, changed);
  // A failed worker has no event: replaying the unchanged prefix cannot advance.
  assert.deepEqual(evaluatePlanGraph(graph, valid.slice(0, 1)).next, { kind: "task", nodeId: "a1" });
});

test("cycles, disconnected work, duplicate identities and malformed choice edges fail closed", () => {
  const graph = diamond();
  const invalidGraphs: PlanGraph[] = [
    { ...graph, entry: "absent" }, { ...graph, entry: "next" }, { ...graph, nodes: [...graph.nodes, graph.nodes[1]!] },
    { ...graph, nodes: [...graph.nodes, { id: "orphan", kind: "task" }] },
    { ...graph, edges: [...graph.edges, graph.edges[0]!] },
    { ...graph, edges: [...graph.edges, { from: "next", to: "absent" }] },
    { ...graph, edges: [...graph.edges, { from: "absent", to: "next" }] },
    { ...graph, edges: [...graph.edges, { from: "next", to: "next" }] },
    { ...graph, edges: [...graph.edges, { from: "next", to: "choose" }] },
    { ...graph, edges: [...graph.edges, { from: "next", to: "a1" }] },
    { ...graph, nodes: [...graph.nodes, { id: "x", kind: "join" }, { id: "y", kind: "join" }],
      edges: [...graph.edges, { from: "x", to: "y" }, { from: "y", to: "x" }] },
    { ...graph, nodes: graph.nodes.map(node => node.kind === "choice" ? choiceNode(node.id, "a", "a") : node) },
    { ...graph, edges: graph.edges.slice(1) },
    { ...graph, edges: graph.edges.map(edge => edge.from === "choose" ? { from: edge.from, to: edge.to } : edge) },
    { ...graph, edges: graph.edges.map(edge => edge.when === "a" ? { ...edge, when: "foreign" } : edge) },
    { ...graph, edges: [...graph.edges, { from: "choose", to: "next", when: "a" }] },
    { ...graph, edges: [...graph.edges, { from: "choose", to: "next" }] },
    { ...graph, edges: graph.edges.map(edge => edge.from === "a1" ? { ...edge, when: "a" } : edge) },
    { ...graph, edges: graph.edges.map(edge => edge.from === "join" ? { ...edge, when: "a" } : edge) },
  ];
  for (const invalid of invalidGraphs) {
    assert.equal(validPlanGraph(invalid, catalog(invalid)), false);
    rejects(invalid);
    assert.throws(() => maximumGraphTasks(invalid), { message: "Invalid plan graph input." });
  }
  rejects({ ...graph, edges: graph.edges.map(edge => edge.from === "a1" ? { ...edge, when: undefined } : edge) });
});

test("node, edge, choice, prose and event limits include their boundaries", () => {
  const sixteen = chain(16), events = route(sixteen);
  assert.equal(validPlanGraph(sixteen, catalog(sixteen)), true);
  assert.equal(events.length, 16);
  assert.equal(Value.Check(PlanGraphEventsSchema, events), true);
  assert.equal(Value.Check(PlanGraphEventsSchema, [...events, task("n0")]), false);
  assert.equal(maximumGraphTasks(sixteen), 16);
  for (const graph of [chain(0), chain(17), binaryStages(5)]) {
    assert.equal(Value.Check(PlanGraphSchema, graph), false);
    assert.equal(validPlanGraph(graph, catalog(graph)), false);
    rejects(graph);
  }
  const dense: PlanGraph = { version: 2, entry: "n0", nodes: chain(10).nodes, edges: [] };
  for (let from = 0; from < 10; from++) for (let to = from + 1; to < 10; to++) dense.edges.push({ from: `n${from}`, to: `n${to}` });
  const atLimit = { ...dense, edges: dense.edges.slice(0, 32) };
  assert.equal(validPlanGraph(atLimit, catalog(atLimit)), true);
  assert.equal(maximumGraphTasks(atLimit), 10);
  const overLimit = { ...dense, edges: dense.edges.slice(0, 33) };
  assert.equal(validPlanGraph(overLimit, catalog(overLimit)), false);
  rejects(overLimit);
  const graph = diamond(), node = graph.nodes[0]!;
  assert.equal(node.kind, "choice");
  if (node.kind !== "choice") assert.fail();
  for (const changed of [{ ...node, choices: node.choices.slice(0, 1) }, { ...node, choices: [...node.choices, node.choices[0]!] },
    { ...node, summary: "" }, { ...node, summary: "   " }, { ...node, summary: "s".repeat(4_001) },
    { ...node, choices: [{ id: "a", description: " " }, node.choices[1]!] },
    { ...node, choices: [{ id: "a", description: "d".repeat(257) }, node.choices[1]!] }]) {
    const invalid = { ...graph, nodes: [changed, ...graph.nodes.slice(1)] };
    assert.equal(validPlanGraph(invalid, catalog(graph)), false);
    rejects(invalid);
  }
  const boundary = { ...graph, nodes: [{ ...node, summary: "s".repeat(4_000),
    choices: node.choices.map(option => ({ ...option, description: "d".repeat(256) })) }, ...graph.nodes.slice(1)] };
  assert.equal(validPlanGraph(boundary, catalog(graph)), true);
});

test("maximum task count explores branches rather than counting catalog entries or automatic joins", () => {
  assert.equal(maximumGraphTasks(diamond()), 3);
  assert.equal(maximumGraphTasks(nested()), 3);
  assert.equal(maximumGraphTasks(fanout()), 3);
  assert.equal(maximumGraphTasks(fanout("task")), 4);
  const independent = fanout();
  independent.nodes.push(choiceNode("zz"), { id: "d", kind: "task" }, { id: "e", kind: "task" }, { id: "f", kind: "task" });
  independent.edges.push({ from: "start", to: "zz" }, { from: "zz", to: "d", when: "a" }, { from: "zz", to: "f", when: "b" },
    { from: "d", to: "e" }, { from: "e", to: "merge" }, { from: "f", to: "merge" });
  assert.equal(validPlanGraph(independent, catalog(independent)), true);
  assert.equal(route(independent, { z: "a", zz: "b" }).filter(event => event.type === "task").length, 4);
  assert.equal(maximumGraphTasks(independent), 5);
  const four = binaryStages(4);
  assert.equal(catalog(four).length, 8);
  assert.equal(validPlanGraph(four, catalog(four)), true);
  assert.equal(maximumGraphTasks(four), 4);
  const empty: PlanGraph = { version: 2, entry: "start", nodes: [{ id: "start", kind: "join" }], edges: [] };
  assert.equal(validPlanGraph(empty, []), true);
  assert.deepEqual(evaluatePlanGraph(empty, []), { next: { kind: "finished" }, nodes: { start: "completed" }, edges: [] });
  assert.equal(maximumGraphTasks(empty), 0);
  rejects(empty, [task("start")]);
  const direct: PlanGraph = { version: 2, entry: "choose", nodes: [choiceNode("choose"), { id: "end", kind: "join" }],
    edges: [{ from: "choose", to: "end", when: "a" }, { from: "choose", to: "end", when: "b" }] };
  assert.equal(validPlanGraph(direct, []), true);
  assert.equal(maximumGraphTasks(direct), 0);
  assert.deepEqual(evaluatePlanGraph(direct, [choice("choose", "b")]).next, { kind: "finished" });
});

test("invalid input errors are fixed and never echo payloads or thrown accessor errors", () => {
  const privateValue = "PRIVATE_SNAPSHOT_VALUE";
  const hostile = { get version() { throw new Error(privateValue); } };
  assert.equal(validPlanGraph(hostile, []), false);
  rejects(hostile);
  assert.throws(() => maximumGraphTasks(hostile), { message: "Invalid plan graph input." });
  rejects(diamond(), [{ type: "choice", nodeId: "choose", get choiceId() { throw new Error(privateValue); } }]);
  rejects(diamond(), [{ type: "choice", nodeId: "choose", choiceId: privateValue }]);
});

test("frozen inputs stay unchanged and the kernel has no IO, clock, randomness or runtime imports", t => {
  const source = readFileSync(new URL("../src/plan-graph.ts", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^import .* from "([^"]+)";/gm)].map(match => match[1]), ["typebox", "typebox/value"]);
  assert.doesNotMatch(source, /\b(?:Date|performance|process|console|fetch|crypto|globalThis|require|setTimeout|setInterval|eval|Function)\b|\bMath\s*\.\s*random\b|\bimport\s*\(/);
  const graph = freeze(nested()), events = freeze([choice("outer", "left"), choice("inner", "long"), task("long1")]), ids = freeze(catalog(graph));
  const before = structuredClone({ graph, events, ids });
  const forbidden = () => { throw new Error("The pure kernel attempted an effect."); };
  t.mock.method(Date, "now", forbidden);
  t.mock.method(Math, "random", forbidden);
  t.mock.method(performance, "now", forbidden);
  t.mock.method(globalThis, "fetch", forbidden);
  t.mock.method(globalThis, "setTimeout", forbidden);
  t.mock.method(globalThis, "setInterval", forbidden);
  try {
    assert.equal(validPlanGraph(graph, ids), true);
    assert.deepEqual(evaluatePlanGraph(graph, events).next, { kind: "task", nodeId: "long2" });
    assert.equal(maximumGraphTasks(graph), 3);
    assert.deepEqual({ graph, events, ids }, before);
    const first = evaluatePlanGraph(graph, events);
    assert.deepEqual(evaluatePlanGraph(graph, events), first);
    assert.notEqual(first.edges[0], graph.edges[0]);
  } finally { t.mock.restoreAll(); }
});

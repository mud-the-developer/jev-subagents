import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { evaluatePlanGraph, type PlanGraph, type PlanGraphEvent } from "../src/plan-graph.ts";
import { planReceipt, validPlanReceipt } from "../src/plan-state.ts";
import { planText, renderPlan, type GraphPlanNodeState, type PlanTheme, type PlanView } from "../src/plan-presentation.ts";

const graph: PlanGraph = { version: 2, entry: "route", nodes: [
  { id: "review", kind: "task" }, { id: "merge", kind: "join" }, { id: "a2", kind: "task" },
  { id: "route", kind: "choice", summary: "Choose the reviewed path.", choices: [{ id: "a", description: "Use two steps." }, { id: "b", description: "Use one step." }] },
  { id: "b1", kind: "task" }, { id: "a1", kind: "task" } ], edges: [
  { from: "merge", to: "review" }, { from: "b1", to: "merge" }, { from: "route", to: "b1", when: "b" },
  { from: "a2", to: "merge" }, { from: "a1", to: "a2" }, { from: "route", to: "a1", when: "a" } ] };
function view(events: PlanGraphEvent[] = [{ type: "choice", nodeId: "route", choiceId: "b" }]): PlanView {
  const evaluation = evaluatePlanGraph(graph, events);
  return { version: 2, entry: graph.entry, phase: "running", elapsedMs: 1234, seconds: 86400, modelCalls: 2, currentTool: "scope_read", edges: evaluation.edges,
    nodes: graph.nodes.map(node => ({ id: node.id, kind: node.kind, title: node.id,
      after: [...new Set(graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from))],
      state: (evaluation.nodes[node.id] === "completed" ? node.kind === "choice" ? "chosen" : node.kind === "join" ? "joined" : "completed"
        : evaluation.next.kind === "task" && evaluation.next.nodeId === node.id ? "running" : evaluation.nodes[node.id]) as GraphPlanNodeState,
      ...(node.kind === "task" ? { agent: "worker", model: "offline/fixture", thinking: "low" } : {}),
      ...(node.kind === "choice" ? { chosenChoiceId: "b", alternatives: node.choices.map(option => ({ id: option.id, title: option.id, selected: option.id === "b" })) } : {}) })) };
}
const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);
const flow = (text: string) => text.replace(/│/g, " ").replace(/\s+/g, " ");
function bounded(lines: readonly string[], width: number) {
  for (const line of plain(lines)) assert.equal(truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, width, 0).visualLines.length, 1, line);
}
const colors: PlanTheme = { fg: (color, text) => `\u001b[${color === "error" ? 31 : color === "accent" ? 36 : color === "warning" ? 33 : 90}m${text}\u001b[0m` } as PlanTheme;

test("DAG view renders every node and actual conditional edge in topological order, including a shared join", () => {
  const input = view(), text = planText(input);
  assert.equal(validPlanReceipt(planReceipt(input)), true);
  assert.match(text, /DAG v2/); assert.match(text, /6 NODES \/ 6 LINKS/);
  for (const id of ["route", "a1", "a2", "b1", "merge", "review"]) assert.ok(text.includes(id));
  assert.ok(text.indexOf("CHOICE route") < text.indexOf("TASK a1"));
  assert.ok(text.indexOf("TASK a1") < text.indexOf("TASK a2"));
  assert.ok(text.indexOf("TASK b1") < text.indexOf("JOIN merge"));
  assert.ok(text.indexOf("JOIN merge") < text.indexOf("TASK review"));
  assert.match(text, /\[a\] → a1 · INACTIVE/); assert.match(text, /\[b\] → b1 · ACTIVE/);
  assert.match(text, /TASK a1 · SKIPPED/); assert.match(text, /TASK b1 · RUNNING/);
  assert.match(text, /IN ← a2 \[INACTIVE\], b1 \[ACTIVE\]/);
  assert.match(text, /→ review · ACTIVE/); assert.doesNotMatch(text, /additional stages omitted/);
  assert.match(text, /ACTIVE = selected dependency/);
});

test("DAG layout does not depend on node, edge or predecessor array order and never invents states", () => {
  const input = view(), before = structuredClone(input);
  const permuted = { ...input, nodes: [...input.nodes].reverse().map(node => ({ ...node, after: [...node.after].reverse() })), edges: [...input.edges!].reverse() };
  assert.equal(planText(input), planText(permuted)); assert.deepEqual(input, before);
  const joined = view([{ type: "choice", nodeId: "route", choiceId: "b" }, { type: "task", nodeId: "b1" }]);
  assert.match(planText(joined), /JOIN merge · JOINED/); assert.match(planText(joined), /TASK review · RUNNING/);
  assert.match(planText(joined), /ENDED \/ UNVERIFIED/); assert.doesNotMatch(planText(joined), /verified success|tests passed|100%/i);
});

test("DAG native colors preserve selected/inactive paths and measured narrow widths", () => {
  for (const width of [24, 48, 80, 120]) {
    const input = view(), unthemed = renderPlan(input, width), themed = renderPlan(input, width, colors);
    bounded(unthemed, width); bounded(themed, width);
    assert.deepEqual(plain(themed), unthemed);
    assert.match(flow(unthemed.join("\n")), /\[a\] → a1 · INACTIVE/);
    assert.match(flow(unthemed.join("\n")), /\[b\] → b1 · ACTIVE/);
  }
  const seen = new Map<string, string>(); renderPlan(view(), 120, { fg: (color, text) => { seen.set(text, color); return text; } } as PlanTheme);
  assert.equal([...seen].find(([text]) => text.includes("[a] → a1"))?.[1], "dim");
  assert.equal([...seen].find(([text]) => text.includes("[b] → b1"))?.[1], "accent");
});

test("compact DAG keeps the active task and chosen branch and explicitly marks hidden nodes", () => {
  const input = view(), full = renderPlan(input, 80), compact = renderPlan(input, 80, undefined, true), text = compact.join("\n");
  bounded(compact, 80); assert.ok(compact.length < full.length);
  assert.match(text, /CHOICE route · CHOSEN/); assert.match(text, /TASK b1 · RUNNING/); assert.match(text, /JOIN merge · WAITING/);
  assert.match(text, /more nodes · expand/); assert.match(text, /\[a\] → a1/); assert.match(text, /\[b\] → b1/);
  assert.match(text, /summary is not approval/); assert.doesNotMatch(text, /PRIVATE|%|\$/);
});

test("DAG terminal/control text is quoted and malformed or resource-clipped diagrams are explicit", () => {
  const input = view(), noisy = { ...input, entry: "route\u001b[2J", nodes: input.nodes.map(node => ({ ...node, title: 'Read "data"\n\u202ehidden http://private.invalid' })) };
  const text = planText(noisy); assert.match(text, /\\u001b/); assert.match(text, /\\n/); assert.match(text, /address withheld/);
  assert.doesNotMatch(text, /\u001b|\u202e|private\.invalid/);
  assert.match(planText({ ...input, edges: [{ from: "foreign", to: "route", status: "pending" }] }), /Invalid graph connections/);
  const clipped = { ...input, nodes: Array.from({ length: 17 }, (_, index) => ({ id: `n${index}`, title: `n${index}`, state: "waiting" as const, kind: "task" as const, after: [] })), edges: [] };
  assert.match(planText(clipped), /additional stages omitted/);
  assert.match(planText({ ...input, edges: Array(33).fill(input.edges![0]) }), /Additional graph links omitted/);
});

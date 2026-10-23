import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false } as const;
const id = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$", minLength: 1, maxLength: 64 });
const ChoiceNodeSchema = Type.Object({
  id, kind: Type.Literal("choice"), summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  choices: Type.Array(Type.Object({ id, description: Type.String({ minLength: 1, maxLength: 256 }) }, closed),
    { minItems: 2, maxItems: 2 }),
}, closed);
export const PlanGraphSchema = Type.Object({
  version: Type.Literal(2), entry: id,
  nodes: Type.Array(Type.Union([
    Type.Object({ id, kind: Type.Literal("task") }, closed),
    Type.Object({ id, kind: Type.Literal("join") }, closed),
    ChoiceNodeSchema,
  ]), { minItems: 1, maxItems: 16, contains: ChoiceNodeSchema, minContains: 0, maxContains: 4 }),
  edges: Type.Array(Type.Object({ from: id, to: id, when: Type.Optional(id) }, closed), { maxItems: 32 }),
}, closed);
export type PlanGraph = Static<typeof PlanGraphSchema>;

export const PlanGraphEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("choice"), nodeId: id, choiceId: id }, closed),
  Type.Object({ type: Type.Literal("task"), nodeId: id }, closed),
]);
export const PlanGraphEventsSchema = Type.Array(PlanGraphEventSchema, { maxItems: 16 });
export type PlanGraphEvent = Static<typeof PlanGraphEventSchema>;
export type PlanGraphEvents = Static<typeof PlanGraphEventsSchema>;
export type PlanGraphNodeState = "waiting" | "ready" | "completed" | "skipped";
export type PlanGraphEdgeStatus = "active" | "inactive" | "pending";
export type PlanGraphEvaluation = {
  readonly next: { readonly kind: "task" | "choice"; readonly nodeId: string } | { readonly kind: "finished" };
  readonly nodes: Readonly<Record<string, PlanGraphNodeState>>;
  readonly edges: readonly (PlanGraph["edges"][number] & { readonly status: PlanGraphEdgeStatus })[];
};

type Node = PlanGraph["nodes"][number];
type Edge = PlanGraph["edges"][number];
const TaskIdsSchema = Type.Array(id, { maxItems: 16, uniqueItems: true });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const edgeKey = (edge: Edge) => `${edge.from}\0${edge.to}\0${edge.when ?? ""}`;
function invalid(): never { throw new Error("Invalid plan graph input."); }

/** Structural checks beyond the closed schema; option IDs are local to a choice. */
function orderedNodes(graph: PlanGraph): Node[] | null {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) return null;
  for (const node of graph.nodes) {
    if (node.kind === "choice" && (!node.summary.trim() || new Set(node.choices.map(option => option.id)).size !== 2 ||
      node.choices.some(option => !option.description.trim()))) return null;
  }
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    if (!from || !nodes.has(edge.to) || edge.from === edge.to || edges.has(edgeKey(edge))) return null;
    edges.add(edgeKey(edge));
    if (from.kind === "choice") {
      if (!from.choices.some(option => option.id === edge.when)) return null;
    } else if ("when" in edge) return null;
  }
  for (const node of graph.nodes) {
    if (node.kind === "choice" && node.choices.some(option =>
      graph.edges.filter(edge => edge.from === node.id && edge.when === option.id).length !== 1)) return null;
  }
  const roots = graph.nodes.filter(node => !graph.edges.some(edge => edge.to === node.id));
  if (roots.length !== 1 || roots[0]!.id !== graph.entry) return null;

  // One root plus acyclicity also proves that every node is reachable from entry.
  const remaining = [...graph.nodes].sort((a, b) => compare(a.id, b.id));
  const visited = new Set<string>(), ordered: Node[] = [];
  while (remaining.length) {
    const index = remaining.findIndex(node => graph.edges.every(edge => edge.to !== node.id || visited.has(edge.from)));
    if (index < 0) return null;
    const node = remaining.splice(index, 1)[0]!;
    visited.add(node.id);
    ordered.push(node);
  }
  return ordered;
}

/** Validate against the exact approved task catalog; this does not grant execution. */
export function validPlanGraph(graph: unknown, taskIds: unknown): graph is PlanGraph {
  try {
    if (!Value.Check(PlanGraphSchema, graph) || !Value.Check(TaskIdsSchema, taskIds)) return false;
    const tasks = graph.nodes.filter(node => node.kind === "task");
    return tasks.length === taskIds.length && tasks.every(node => taskIds.includes(node.id)) && orderedNodes(graph) !== null;
  } catch { return false; }
}

function snapshot(graph: PlanGraph, ordered: readonly Node[], completed: ReadonlyMap<string, PlanGraphEvent>): PlanGraphEvaluation {
  const nodes = new Map<string, PlanGraphNodeState>(), edges = new Map<Edge, PlanGraphEdgeStatus>();
  for (const node of ordered) {
    const incoming = graph.edges.filter(edge => edge.to === node.id);
    const activation: PlanGraphEdgeStatus = node.id === graph.entry || incoming.some(edge => edges.get(edge) === "active")
      ? "active" : incoming.some(edge => edges.get(edge) === "pending") ? "pending" : "inactive";
    const ready = activation === "active" && incoming.every(edge => edges.get(edge) === "inactive" ||
      edges.get(edge) === "active" && nodes.get(edge.from) === "completed");
    nodes.set(node.id, activation === "inactive" ? "skipped" : !ready ? "waiting"
      : node.kind === "join" || completed.has(node.id) ? "completed" : "ready");
    const event = completed.get(node.id);
    for (const edge of graph.edges.filter(edge => edge.from === node.id)) {
      // Active is a live dependency, not a completion receipt. Unresolved choices stay pending.
      edges.set(edge, activation === "inactive" ? "inactive" : node.kind !== "choice" ? activation
        : event?.type === "choice" ? edge.when === event.choiceId ? "active" : "inactive" : "pending");
    }
  }
  const next = [...ordered].sort((a, b) => compare(a.id, b.id)).find(node => nodes.get(node.id) === "ready");
  if (!next && [...nodes.values()].some(state => state === "waiting")) invalid();
  return {
    next: next && next.kind !== "join" ? { kind: next.kind, nodeId: next.id } : { kind: "finished" },
    nodes: Object.fromEntries(nodes),
    edges: [...graph.edges].sort((a, b) => compare(edgeKey(a), edgeKey(b))).map(edge => ({ ...edge, status: edges.get(edge)! })),
  };
}

/** Replay only successful task completions and recorded choices from empty state.
 * Failures stop at the caller; events/snapshots are neither verification nor authority.
 * The caller must separately bind this graph to its approved catalog with validPlanGraph.
 */
export function evaluatePlanGraph(graph: unknown, events: unknown): PlanGraphEvaluation {
  try {
    if (!Value.Check(PlanGraphSchema, graph) || !Value.Check(PlanGraphEventsSchema, events)) invalid();
    const ordered = orderedNodes(graph);
    if (!ordered) invalid();
    const completed = new Map<string, PlanGraphEvent>();
    let result = snapshot(graph, ordered, completed);
    for (const event of events) {
      if (result.next.kind === "finished" || result.next.kind !== event.type || result.next.nodeId !== event.nodeId) invalid();
      const node = ordered.find(node => node.id === event.nodeId)!;
      if (event.type === "choice" && (node.kind !== "choice" || !node.choices.some(option => option.id === event.choiceId))) invalid();
      completed.set(event.nodeId, event);
      result = snapshot(graph, ordered, completed);
    }
    return result;
  } catch { return invalid(); }
}

/** Explore at most four binary choices through the same replay rules.
 * Counts task events, not catalog entries, model calls, verification or permission.
 */
export function maximumGraphTasks(graph: unknown): number {
  try {
    if (!Value.Check(PlanGraphSchema, graph)) invalid();
    const plan = graph;
    function visit(events: PlanGraphEvents): number {
      const { next } = evaluatePlanGraph(plan, events);
      if (next.kind === "finished") return 0;
      if (next.kind === "task") return 1 + visit([...events, { type: "task", nodeId: next.nodeId }]);
      const node = plan.nodes.find(node => node.id === next.nodeId);
      if (node?.kind !== "choice") invalid();
      return Math.max(...node.choices.map(option => visit([...events, { type: "choice", nodeId: node.id, choiceId: option.id }])));
    }
    return visit([]);
  } catch { return invalid(); }
}

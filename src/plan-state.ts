import type { OrdinaryAuthorizationState, OrdinaryPreparedScope } from "./ordinary-authorization.ts";
import type { PlanView, GraphPlanNodeState as PlanNodeState } from "./plan-presentation.ts";
import { WorkerProgressSchema, type WorkerProgress } from "./worker-progress.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { evaluatePlanGraph, validPlanGraph } from "./plan-graph.ts";
import { TreeDisplaySchema } from "./task-tree.ts";

const id = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
const label = Type.String({ minLength: 1, maxLength: 384, pattern: "^[A-Za-z0-9_.:/+-]+$" });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const choice = (...values: string[]) => Type.String({ enum: values });
const closed = { additionalProperties: false } as const;
const ReceiptSchema = Type.Object({ phase: choice("preparing", "approval", "selecting", "checking", "running", "finished", "stopped"),
  elapsedMs: count, seconds: Type.Integer({ minimum: 1, maximum: 86_400 }), modelCalls: count,
  currentTool: WorkerProgressSchema.properties.currentTool,
  nodes: Type.Array(Type.Object({ id, title: id, after: Type.Array(id, { maxItems: 2, uniqueItems: true }),
    state: choice("waiting", "selecting", "running", "completed", "failed", "blocked"),
    agent: Type.Optional(label), model: Type.Optional(label), thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_ /()-]+$" })),
    alternatives: Type.Optional(Type.Array(Type.Object({ id, title: id, selected: Type.Optional(Type.Boolean()) }, closed), { maxItems: 2 })),
  }, closed), { maxItems: 3 }) }, closed);
const GraphReceiptSchema = Type.Object({ ...ReceiptSchema.properties, version: Type.Literal(2), entry: id,
  nodes: Type.Array(Type.Object({ ...ReceiptSchema.properties.nodes.items.properties,
    kind: choice("task", "choice", "join"), after: Type.Array(id, { maxItems: 16, uniqueItems: true }),
    state: choice("waiting", "ready", "selecting", "running", "completed", "failed", "blocked", "skipped", "chosen", "joined"),
    chosenChoiceId: Type.Optional(id),
  }, closed), { minItems: 1, maxItems: 16 }),
  edges: Type.Array(Type.Object({ from: id, to: id, when: Type.Optional(id), status: choice("active", "inactive", "pending") }, closed), { maxItems: 32 }),
}, closed);
const TreeReceiptSchema = Type.Object({ ...ReceiptSchema.properties, version: Type.Literal(3), modelCallsKnown: Type.Optional(Type.Boolean()),
  display: Type.Optional(TreeDisplaySchema),
  nodes: Type.Array(Type.Object({ id, title: id, kind: choice("task", "info"), after: Type.Array(id, { maxItems: 2, uniqueItems: true }),
    state: choice("pending", "selecting", "running", "completed_unverified", "stopped", "ready"), modelCalls: Type.Optional(Type.Union([count, Type.Null()])),
    agent: Type.Optional(label), model: Type.Optional(label), thinking: ReceiptSchema.properties.nodes.items.properties.thinking,
  }, closed), { minItems: 1, maxItems: 11 }),
  edges: Type.Array(Type.Object({ from: id, to: id, kind: choice("dependency", "produced", "reference"), status: choice("active", "inactive", "pending") }, closed), { maxItems: 32 }),
}, closed);
export function validPlanReceipt(value: unknown): value is PlanView {
  try {
    if (Value.Check(TreeReceiptSchema, value)) {
      const ids = new Set(value.nodes.map(node => node.id)), tasks = value.nodes.filter(node => node.kind === "task");
      if (ids.size !== value.nodes.length || tasks.length < 1 || tasks.length > 3 || value.nodes.length - tasks.length > 8 ||
        value.nodes.some(node => node.id !== node.title || node.after.length !== value.edges.filter(edge => edge.kind === "dependency" && edge.to === node.id).length ||
          node.after.some(id => !value.edges.some(edge => edge.kind === "dependency" && edge.from === id && edge.to === node.id))) ||
        new Set(value.edges.map(edge => `${edge.from}:${edge.to}`)).size !== value.edges.length || value.edges.some(edge => {
          const from = value.nodes.find(node => node.id === edge.from), to = value.nodes.find(node => node.id === edge.to);
          return !from || !to || (edge.kind === "dependency" ? from.kind !== "task" || to.kind !== "task" : edge.kind === "produced" ? from.kind !== "task" || to.kind !== "info" : from.kind !== "info" || to.kind !== "task");
        })) return false;
      while (ids.size) {
        const ready = [...ids].filter(id => !value.edges.some(edge => edge.to === id && ids.has(edge.from)));
        if (!ready.length) return false; ready.forEach(id => ids.delete(id));
      }
      return true;
    }
    if (Value.Check(ReceiptSchema, value)) return value.nodes.every(node => node.title === node.id && (node.alternatives ?? []).every(alternative => alternative.title === alternative.id));
    if (!Value.Check(GraphReceiptSchema, value) || !value.nodes.every(node => node.title === node.id &&
      (node.alternatives ?? []).every(option => option.title === option.id) &&
      (node.kind === "choice" ? node.alternatives?.length === 2 && (node.chosenChoiceId === undefined || node.alternatives.some(option => option.id === node.chosenChoiceId))
        : node.alternatives === undefined && node.chosenChoiceId === undefined) &&
      node.after.length === new Set(value.edges.filter(edge => edge.to === node.id).map(edge => edge.from)).size &&
      node.after.every(prior => value.edges.some(edge => edge.from === prior && edge.to === node.id)))) return false;
    return validPlanGraph({ version: 2, entry: value.entry,
      nodes: value.nodes.map(node => node.kind === "choice" ? { id: node.id, kind: node.kind, summary: node.id,
        choices: node.alternatives!.map(option => ({ id: option.id, description: option.id })) } : { id: node.id, kind: node.kind }),
      edges: value.edges.map(({ from, to, when }) => ({ from, to, ...(when !== undefined ? { when } : {}) })) },
    value.nodes.filter(node => node.kind === "task").map(node => node.id));
  } catch { return false; }
}

/** Transcript-safe receipt: no task/branch prose, prompts, arguments or worker output. */
export function planReceipt(view: PlanView): PlanView {
  return { phase: view.phase, elapsedMs: view.elapsedMs, seconds: view.seconds, modelCalls: view.modelCalls,
    ...(view.version === 3 && view.modelCallsKnown !== undefined ? { modelCallsKnown: view.modelCallsKnown } : {}),
    ...(view.version === 3 && view.display ? { display: {
      ...(view.display.maxDepth !== undefined ? { maxDepth: view.display.maxDepth } : {}),
      ...(view.display.animations !== undefined ? { animations: view.display.animations } : {}),
    } } : {}),
    ...(view.currentTool !== undefined ? { currentTool: view.currentTool } : {}),
    ...(view.version === 2 || view.version === 3 ? { version: view.version, ...(view.entry !== undefined ? { entry: view.entry } : {}), edges: (view.edges ?? []).map(edge => ({ from: edge.from, to: edge.to,
      status: edge.status, ...(edge.when !== undefined ? { when: edge.when } : {}), ...(view.version === 3 && edge.kind ? { kind: edge.kind } : {}) })) } : {}),
    nodes: view.nodes.map(node => ({ id: node.id, title: node.id, after: [...node.after], state: node.state,
      ...(view.version === 2 || view.version === 3 ? { ...(node.kind !== undefined ? { kind: node.kind } : {}), ...(node.chosenChoiceId !== undefined ? { chosenChoiceId: node.chosenChoiceId } : {}),
        ...(view.version === 3 && node.modelCalls !== undefined ? { modelCalls: node.modelCalls } : {}) } : {}),
      ...(node.agent !== undefined ? { agent: node.agent } : {}), ...(node.model !== undefined ? { model: node.model } : {}),
      ...(node.thinking !== undefined ? { thinking: node.thinking } : {}),
      ...(node.alternatives ? { alternatives: node.alternatives.map(alternative => ({ id: alternative.id, title: alternative.id,
        ...(alternative.selected !== undefined ? { selected: alternative.selected } : {}) })) } : {}) })) };
}

/** Human-only projection; neither this checklist nor a worker's completion is verification or authority. */
export function ordinaryPlanView(scope: OrdinaryPreparedScope, state: OrdinaryAuthorizationState,
  elapsedMs: number, progress?: WorkerProgress, lastTaskId?: string): PlanView {
  const currentId = "nodeId" in state && state.nodeId !== undefined ? state.nodeId : "index" in state ? scope.input.tasks[state.index]?.id : lastTaskId;
  const history = "history" in state ? state.history : [];
  const phase = state.phase === "awaiting_approval" ? "approval" : state.phase === "revoked" ? "stopped"
    : state.phase === "idle" ? "preparing" : state.phase;
  if ("plan" in scope.input) {
    const graph = scope.input.plan;
    const events = "graphEvents" in state ? state.graphEvents ?? [] : [], evaluation = evaluatePlanGraph(scope.input.plan, events);
    return { version: 2, entry: scope.input.plan.entry, edges: evaluation.edges, phase, elapsedMs, seconds: scope.input.limits.seconds,
      modelCalls: ("spentCalls" in state ? state.spentCalls : 0) + (state.phase === "running" ? progress?.modelCalls ?? 0 : 0),
      ...(state.phase === "running" && progress?.currentTool ? { currentTool: progress.currentTool } : {}),
      nodes: scope.input.plan.nodes.map(node => {
        const task = scope.input.tasks.find(task => task.id === node.id), previous = history.find(entry => entry.taskId === node.id);
        const selection = previous?.selection ?? ("selection" in state && currentId === node.id ? state.selection : undefined);
        const agent = node.kind === "task" ? scope.agents.find(candidate => candidate.name === (selection?.agent ?? task?.agent ?? (scope.agents.length === 1 ? scope.agents[0]!.name : undefined))) : undefined;
        const chosen = events.find(event => event.type === "choice" && event.nodeId === node.id);
        const graphState = evaluation.nodes[node.id];
        const nodeState: PlanNodeState = graphState === "skipped" ? "skipped"
          : graphState === "completed" ? node.kind === "choice" ? "chosen" : node.kind === "join" ? "joined" : "completed"
          : state.phase === "revoked" ? currentId === node.id ? "failed" : "blocked"
          : currentId === node.id && state.phase === "running" ? "running"
          : currentId === node.id && (state.phase === "selecting" || state.phase === "checking") ? "selecting"
          : graphState === "ready" ? "ready" : "waiting";
        return { id: node.id, kind: node.kind, title: node.kind === "choice" ? node.summary : task?.summary ?? node.id,
          after: [...new Set(graph.edges.filter(edge => edge.to === node.id).map(edge => edge.from))], state: nodeState,
          ...(agent ? { agent: agent.name, model: `${agent.model.provider}/${agent.model.id}`, thinking: agent.thinking ?? "off" } : {}),
          ...(chosen?.type === "choice" ? { chosenChoiceId: chosen.choiceId } : {}),
          ...(node.kind === "choice" ? { alternatives: node.choices.map(option => ({ id: option.id, title: option.description,
            ...(chosen?.type === "choice" ? { selected: option.id === chosen.choiceId } : {}) })) } : {}) };
      }) };
  }
  return { phase, elapsedMs, seconds: scope.input.limits.seconds,
    modelCalls: ("spentCalls" in state ? state.spentCalls : 0) + (state.phase === "running" ? progress?.modelCalls ?? 0 : 0),
    ...(state.phase === "running" && progress?.currentTool ? { currentTool: progress.currentTool } : {}),
    nodes: scope.input.tasks.map((task, index) => {
      const previous = history.find(entry => entry.taskId === task.id);
      const selection = previous?.selection ?? ("selection" in state && currentId === task.id ? state.selection : undefined);
      const agent = scope.agents.find(candidate => candidate.name === (selection?.agent ?? task.agent ?? (scope.agents.length === 1 ? scope.agents[0]!.name : undefined)));
      const nodeState: PlanNodeState = state.phase === "revoked" && currentId === task.id ? "failed"
        : previous ? previous.observation.outcome === "completed" && previous.observation.accountingComplete && previous.observation.cleanupConfirmed ? "completed" : "failed"
        : state.phase === "revoked" ? "blocked"
        : currentId === task.id && state.phase === "running" ? "running"
        : currentId === task.id && (state.phase === "selecting" || state.phase === "checking") ? "selecting" : "waiting";
      return { id: task.id, title: task.summary, after: task.after ?? (index ? [scope.input.tasks[index - 1]!.id] : []), state: nodeState,
        ...(agent ? { agent: agent.name, model: `${agent.model.provider}/${agent.model.id}`, thinking: agent.thinking ?? "off" } : {}),
        ...(task.alternatives ? { alternatives: task.alternatives.map(alternative => ({ id: alternative.id, title: alternative.description,
          ...(selection?.alternativeId ? { selected: selection.alternativeId === alternative.id } : {}) })) } : {}) };
    }) };
}

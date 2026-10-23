import type { PlanView } from "./plan-presentation.ts";
import { treeDependencies, treeLive, type TreePrepared, type TreeState } from "./task-tree.ts";

/** Pure observer projection. No bodies, prompts, reports or execution decisions. */
export function taskTreeView(tree: TreePrepared, state: TreeState, now: number): PlanView {
  const live = treeLive(state), terminal = state.phase === "terminal", stopped = state.phase === "draining" && state.reason !== "completed_unverified" || terminal && state.outcome === "stopped";
  const observed = (row: NonNullable<typeof live>["rows"][number]) => row.observation ? row.observation.modelCalls : row.progress?.modelCalls ?? (row.reserved === undefined ? 0 : null);
  const calls = (live?.rows ?? []).reduce<number | null>((sum, row) => { const count = observed(row); return sum === null || count === null || !Number.isSafeInteger(sum + count) ? null : sum + count; }, 0);
  const partialCalls = (live?.rows ?? []).reduce((sum, row) => { const next = sum + (observed(row) ?? row.progress?.modelCalls ?? 0); return Number.isSafeInteger(next) ? next : sum; }, 0);
  return { version: 3, display: { maxDepth: tree.input.display?.maxDepth ?? 3, animations: tree.input.display?.animations ?? true }, phase: stopped ? "stopped" : terminal ? "finished" : state.phase === "approval" ? "approval" : state.phase === "preparing" ? "preparing"
    : live?.rows.some(row => row.phase === "running") ? "running" : "selecting", seconds: tree.input.limits.seconds,
    elapsedMs: live && Number.isSafeInteger(now) ? Math.max(0, now - live.approvedAt) : 0, modelCalls: calls ?? partialCalls, modelCallsKnown: calls !== null,
    nodes: tree.input.nodes.map(node => {
      const row = live?.rows.find(row => row.id === node.id), agent = tree.agents.find(agent => agent.name === row?.selection?.agent);
      return { id: node.id, title: node.id, kind: node.kind, after: node.kind === "task" ? treeDependencies(tree.input, node.id) : [],
        state: node.kind === "info" ? live?.records.some(record => record.id === node.id) ? "ready" : "pending" : row?.phase === "completed_unverified" ? "completed_unverified" : stopped ? "stopped" : row?.phase ?? "pending",
        ...(agent ? { agent: agent.name, model: `${agent.model.provider}/${agent.model.id}`, thinking: agent.thinking ?? "off" } : {}),
        ...(row ? { modelCalls: observed(row) } : {}) };
    }),
    edges: tree.input.edges.map(edge => {
      const target = live?.rows.find(row => row.id === edge.to);
      const status = edge.kind === "reference" ? target?.selection ? target.selection.ids.includes(edge.from) ? "active" : "inactive" : "pending"
        : edge.kind === "produced" ? live?.records.some(record => record.id === edge.to) ? "active" : "pending"
          : live?.rows.some(row => row.id === edge.from && row.phase === "completed_unverified") ? "active" : "pending";
      return { ...edge, status };
    }),
  };
}

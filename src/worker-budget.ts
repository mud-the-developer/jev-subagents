import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { MAX_WORKER_MODEL_CALLS } from "./delegate-machine.ts";
import { DecisionInputSchema, reduceDecision, type DecisionInput, type DecisionState } from "./decision.ts";
import { englishProse } from "./internal-language.ts";

const closed = { additionalProperties: false } as const;
export const WorkerBudgetInputSchema = Type.Object({
  kind: Type.Literal("worker_budget"),
  taskSummary: Type.String({ pattern: "\\S", minLength: 1, maxLength: 3000, description: "Explicit non-sensitive English task summary. No source, paths, credentials, transcript or worker output." }),
  fileCount: Type.Integer({ minimum: 0, maximum: 128 }),
  readOnly: Type.Boolean({ description: "When true, the budget tools must be read-only: unrestricted bash and edit/write tools are excluded." }),
  tools: Type.Array(Type.String({ enum: ["read", "grep", "find", "ls", "bash", "edit", "write", "scope_read", "scope_edit", "scope_write"] }), { minItems: 1, maxItems: 10, uniqueItems: true, description: "Declared per-task tools, not the entire profile capability list. Read-only budgets exclude unrestricted bash and write tools." }),
  callCeiling: Type.Integer({ minimum: 2, maximum: MAX_WORKER_MODEL_CALLS, description: "Harness/operator upper bound, not the selected actual worker budget. A human-pinned smaller bound remains binding." }),
  requiresHuman: Type.Boolean({ description: "True bypasses JEV for mandatory approval/high-stakes budget decisions. Budget advice is never execution permission." }),
}, closed);
export type WorkerBudgetInput = Static<typeof WorkerBudgetInputSchema>;
export const WORKER_BUDGET_ERROR = "Worker budget advice stopped. No fixed-budget fallback, execution, retry or authority was created.";
export type WorkerBudgetDiagnostic = "read_only_tool_conflict" | "invalid_input" | "non_english_summary" | "invalid_decision_packet";
export const WORKER_BUDGET_REMEDIES: Readonly<Record<WorkerBudgetDiagnostic, string>> = {
  read_only_tool_conflict: "For this read-only task, remove unrestricted bash and edit/write tools. Do not change readOnly or widen permissions to bypass this refusal.",
  invalid_input: "Provide the closed worker_budget fields with valid bounded values.",
  non_english_summary: "Provide a concise non-sensitive English task summary.",
  invalid_decision_packet: "Reduce the supplied metadata so the bounded decision packet remains valid; no budget was selected.",
};
export function workerBudgetDiagnostic(value: unknown): WorkerBudgetDiagnostic | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid_input";
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(WorkerBudgetInputSchema.properties).some(key => !fields[key] || !("value" in fields[key]!)) ||
      Object.values(fields).some(field => !("value" in field))) return "invalid_input";
    const tools: unknown = fields.tools?.value;
    if (Array.isArray(tools) && Object.values(Object.getOwnPropertyDescriptors(tools)).some(field => !("value" in field))) return "invalid_input";
    if (!Value.Check(WorkerBudgetInputSchema, value)) return "invalid_input";
    if (!englishProse(value.taskSummary)) return "non_english_summary";
    if (value.readOnly && value.tools.some(tool => ["bash", "edit", "write", "scope_edit", "scope_write"].includes(tool))) return "read_only_tool_conflict";
    return undefined;
  } catch { return "invalid_input"; }
}
const ranges: Readonly<Record<number, string | undefined>> = {
  2: "One declared read plus one final report; no repository discovery or iterative changes.",
  4: "Small, tightly scoped inspection with few tool-use follow-ups and a final report.",
  8: "Moderate multi-file investigation or bounded edits, tool follow-ups and a final report.",
  12: "Broader bounded repository work with discovery, several tool-use turns, checking and final reporting.",
};
/** Builds one ordinary JEV option packet. Never discovers files/profiles or changes an approved run. */
export function workerBudgetDecision(value: unknown): DecisionInput | undefined {
  if (workerBudgetDiagnostic(value) || !Value.Check(WorkerBudgetInputSchema, value)) return undefined;
  const counts = [...new Set([2, 4, 8, 12].filter(count => count <= value.callCeiling).concat(value.callCeiling))];
  // A two-call ceiling still admits a direct-answer-only one-call proposal. No budget is fabricated on failure.
  if (counts.length === 1) counts.unshift(1);
  const decision: DecisionInput = {
    question: "Which supplied SDK model-round budget best fits this new bounded worker task?",
    context: JSON.stringify({ taskSummary: value.taskSummary, declaredFileCount: value.fileCount, readOnly: value.readOnly,
      allowedToolNames: value.tools, workerCallCeiling: value.callCeiling,
      policy: "Count model round trips, not files or individual tool operations. Discovery, tool-use follow-ups, reasoning and a final report can require separate calls. Select sufficient room without needless cost. This is an advisory proposal before exact native execution approval, not a success estimate, permission or permission to extend an active task." }),
    options: counts.map(count => ({ id: `calls_${count}`, title: `${count} SDK model calls`, description: ranges[count]
      ?? (count === 1 ? "One direct answer with no tool follow-up or separate final reporting." : "An intermediate bounded model-round budget for tool follow-ups and final reporting; never exceed the supplied ceiling.") })),
    requiresHuman: value.requiresHuman,
  };
  return Value.Check(DecisionInputSchema, decision) ? decision : undefined;
}
/** Validated advice is returned as a number for a NEW execution packet, not a caller grant. */
export function workerBudgetOutcome(input: WorkerBudgetInput, state: DecisionState) {
  const decision = workerBudgetDecision(input);
  if (!decision) {
    const diagnostic = workerBudgetDiagnostic(input) ?? "invalid_decision_packet";
    return { status: "failed" as const, error: WORKER_BUDGET_ERROR, diagnostic, remedy: WORKER_BUDGET_REMEDIES[diagnostic], executionAuthorized: false as const };
  }
  if (state.status !== "recommended") return { ...state, selectionKind: "worker_budget" as const,
    callCeiling: input.callCeiling, executionAuthorized: false as const };
  // Revalidate the actual reply against this packet; a displayed option is not a budget receipt.
  const pending = reduceDecision({ status: "idle" }, { type: "start", input: decision }).state;
  const verified = reduceDecision(pending, { type: "judged", reply: state.reply }).state;
  if (verified.status !== "recommended" || verified.option.id !== state.option.id) return {
    status: "failed" as const, error: WORKER_BUDGET_ERROR, executionAuthorized: false as const,
    ...("jev" in verified && verified.jev ? { jev: verified.jev } : {}) };
  const selected = Number(verified.option.id.slice("calls_".length));
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > input.callCeiling) return {
    status: "failed" as const, error: WORKER_BUDGET_ERROR, executionAuthorized: false as const };
  return { ...verified, selectionKind: "worker_budget" as const, callCeiling: input.callCeiling,
    maxModelCalls: selected, executionAuthorized: false as const };
}

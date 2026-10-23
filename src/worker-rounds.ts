import { Type, type Static } from "typebox";

const closed = { additionalProperties: false } as const;
export const MAX_RECORDED_WORKER_ROUNDS = 128; // Trace payload bound, never an execution/SDK call limit.
const tools = ["read", "bash", "edit", "write", "grep", "find", "ls", "scope_read", "scope_edit", "scope_write", "goal_read", "goal_edit", "goal_write", "other"] as const;
const stops = ["stop", "toolUse", "error", "aborted", "length", "other"] as const;
export const WorkerRoundSchema = Type.Object({
  call: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  stopReason: Type.Union([Type.Literal("stop"), Type.Literal("toolUse"), Type.Literal("error"), Type.Literal("aborted"), Type.Literal("length"), Type.Literal("other")]),
  toolCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  tools: Type.Array(Type.String({ enum: [...tools] }), { maxItems: 14, uniqueItems: true }),
}, closed);
export const WorkerRoundsSchema = Type.Array(WorkerRoundSchema, { maxItems: MAX_RECORDED_WORKER_ROUNDS });
export type WorkerRound = Static<typeof WorkerRoundSchema>;
export const WorkerRoundCoverageSchema = Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unknown")]);
export type WorkerRoundCoverage = Static<typeof WorkerRoundCoverageSchema>;
/** Response metadata coverage only; never task completion, accounting or cleanup certification. */
export function workerRoundCoverage(modelCalls: number | null, observedResponses: number | null, recordedResponses: number): WorkerRoundCoverage {
  if (modelCalls === null || observedResponses === null || ![modelCalls, observedResponses, recordedResponses].every(value => Number.isSafeInteger(value) && value >= 0) ||
    recordedResponses > MAX_RECORDED_WORKER_ROUNDS || recordedResponses > observedResponses) return "unknown";
  return modelCalls === observedResponses && observedResponses === recordedResponses ? "complete" : "partial";
}
/** Metadata only. Unknown names/stops map to fixed literals; no arguments, outputs, source or provider errors. */
export function summarizeWorkerRound(call: number, stopReason: string | undefined, names: readonly string[]): WorkerRound | undefined {
  if (!Number.isSafeInteger(call) || call < 1) return undefined;
  return { call, stopReason: stops.includes(stopReason as WorkerRound["stopReason"]) ? stopReason as WorkerRound["stopReason"] : "other",
    toolCount: names.length, tools: [...new Set(names.map(name => tools.some(value => value === name) ? name : "other"))] };
}
export function workerRoundsText(rounds: readonly WorkerRound[], coverage: WorkerRoundCoverage = "unknown"): string {
  const labels = { complete: "complete (response metadata only)", partial: "partial / omissions or bounds", unknown: "unknown" };
  return ["Recorded model rounds (no tool arguments, results or source)", `Round coverage · ${labels[coverage]} · not task completion/accounting/cleanup`, ...rounds.map(round =>
    `  ${round.call} · ${round.stopReason} · tool requests ${round.toolCount}${round.tools.length ? ` (${round.tools.join(", ")})` : ""}`),
    "Missing rounds are not inferred. A toolUse response can require more model calls for decisions or final reporting.",
  ].join("\n");
}

import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { Event as DelegateEvent, Run, WorkerReport } from "./delegate-machine.ts";

export const SOL_PI_COMMIT = "bd005888b9b8a3fcdb511feb91fc27d3dfa8f2b1";
export const SOL_PI_VERSION = "0.1.0";
export const SOL_ERROR = "SoL-Pi execution stopped. No retry, model fallback, restored authority or rollback. Review accounting, retained ownership and artifacts.";
export const SOL_STORAGE_BYTES = 8 * 1024 * 1024;
export const SOL_STORAGE_FILES = 256;
export const SOL_TOOL_CALLS = 64;
export const SOL_INPUT_BYTES = 256 * 1024;
export const SOL_OUTPUT_TOKENS = 4096;
export const SOL_RECORD = ".jev-sol-execution.jsonl";
const closed = { additionalProperties: false } as const;
const location = Type.String({ minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000-\\u001f\\u007f]*$" });
const digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });
const count = Type.Integer({ minimum: 0, maximum: 12 });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const identity = Type.Object({ dev: time, ino: time }, closed);
export const SolPiInputSchema = Type.Object({
  sourceDirectory: location,
  storageDirectory: location,
  actionFusion: Type.Boolean(), observationPack: Type.Boolean(), evidencePreservingReducer: Type.Boolean(), onlineContextCompact: Type.Boolean(),
  maxReducerCalls: Type.Integer({ minimum: 0, maximum: 2 }),
  maxSummaryCalls: Type.Integer({ minimum: 0, maximum: 4 }),
  maxCompactions: Type.Integer({ minimum: 0, maximum: 2 }),
  cacheWriteReadRatio: Type.Number({ minimum: 0, maximum: 100 }),
}, closed);
export type SolPiInput = Readonly<Static<typeof SolPiInputSchema>>;
export const SolPiPreparedSchema = Type.Object({
  options: SolPiInputSchema, operationId: Type.String({ pattern: "^[a-f0-9-]{36}$", minLength: 36, maxLength: 36 }),
  sourceDigest: digest, contextDigest: digest, runDigest: digest,
  rootIdentity: identity, storageIdentity: identity,
  systemPrompt: Type.String({ minLength: 1, maxLength: 65536 }), prompt: Type.String({ minLength: 1, maxLength: 32768 }),
  preparedAt: time, approvalDeadline: time,
}, closed);
export type SolPiPrepared = Readonly<Static<typeof SolPiPreparedSchema>>;
export const SolPiReportSchema = Type.Object({
  sourceDigest: digest, storageDirectory: location,
  calls: Type.Union([Type.Object({ worker: count, reducer: count, summary: count }, closed), Type.Null()]),
  toolCalls: Type.Union([Type.Integer({ minimum: 0, maximum: SOL_TOOL_CALLS }), Type.Null()]),
  compactions: Type.Union([count, Type.Null()]), continuations: Type.Union([count, Type.Null()]),
  storageBytes: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  cleanupConfirmed: Type.Boolean(), lockRetained: Type.Boolean(),
  sessionDurability: Type.Literal("not_asserted"),
}, closed);
export const solHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type SolCallKind = "worker" | "reducer" | "summary";
export type SolUsage = { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cost: number };
export type SolBudget = {
  readonly maxCalls: number; readonly maxReducerCalls: number; readonly maxSummaryCalls: number; readonly maxCompactions: number;
  readonly deadline: number; readonly tools: readonly string[];
};
type SolView = {
  readonly budget: SolBudget; readonly lastAt: number; readonly calls: Readonly<Record<SolCallKind, number>>;
  readonly pending: readonly number[]; readonly settled: readonly number[]; readonly usage: SolUsage; readonly known: boolean;
  readonly toolCalls: number; readonly compactions: number; readonly continuations: number; readonly storageBytes: number | null;
};
export type SolState = SolView & (
  | { readonly status: "running" }
  | { readonly status: "draining"; readonly reason: "failed" | "cancelled" | "limit" }
  | { readonly status: "done"; readonly result: "succeeded" | "failed" | "cancelled" | "limit" }
);
export type SolEvent =
  | { readonly type: "call"; readonly kind: SolCallKind; readonly now: number }
  | { readonly type: "settled"; readonly id: number; readonly usage: SolUsage | null; readonly ok: boolean; readonly now: number }
  | { readonly type: "tool"; readonly name: string; readonly now: number }
  | { readonly type: "compact"; readonly now: number }
  | { readonly type: "continue"; readonly now: number }
  | { readonly type: "storage"; readonly bytes: number; readonly files: number; readonly valid: boolean; readonly now: number }
  | { readonly type: "failed" }
  | { readonly type: "cancel" }
  | { readonly type: "finish"; readonly completed: boolean; readonly cleanupConfirmed: boolean; readonly now: number };
export type SolEffect = { readonly type: "admit"; readonly id: number; readonly kind: SolCallKind } | { readonly type: "stop" };
export function initialSolState(budget: SolBudget, now: number): SolState {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(budget.deadline) || budget.deadline <= now || budget.deadline - now > 120_000 ||
      !Number.isInteger(budget.maxCalls) || budget.maxCalls < 1 || budget.maxCalls > 12 ||
      !Number.isInteger(budget.maxReducerCalls) || budget.maxReducerCalls < 0 || budget.maxReducerCalls > 2 ||
      !Number.isInteger(budget.maxSummaryCalls) || budget.maxSummaryCalls < 0 || budget.maxSummaryCalls > 4 ||
      !Number.isInteger(budget.maxCompactions) || budget.maxCompactions < 0 || budget.maxCompactions > 2) throw new Error(SOL_ERROR);
  return { status: "running", budget: structuredClone(budget), lastAt: now, calls: { worker: 0, reducer: 0, summary: 0 }, pending: [], settled: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, known: true, toolCalls: 0, compactions: 0, continuations: 0, storageBytes: null };
}
const validUsage = (usage: SolUsage) => Object.values(usage).every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) &&
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(Number.isSafeInteger) && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
export function reduceSol(state: SolState, event: SolEvent): { state: SolState; effects: readonly SolEffect[] } {
  if (state.status === "done") return { state, effects: [] };
  const stop = (reason: "failed" | "cancelled" | "limit", view: SolView = state) => ({
    state: { ...view, status: "draining" as const, reason }, effects: [{ type: "stop" as const }],
  });
  const total = state.calls.worker + state.calls.reducer + state.calls.summary;
  if (event.type === "settled") {
    if (!state.pending.includes(event.id)) return { state, effects: [] };
    const valid = event.usage !== null && validUsage(event.usage);
    const usage = { ...state.usage };
    if (valid) for (const key of Object.keys(usage) as (keyof SolUsage)[]) usage[key] += event.usage![key];
    const next = { ...state, usage, known: state.known && valid && event.ok,
      pending: state.pending.filter(id => id !== event.id), settled: [...state.settled, event.id] };
    if (!Number.isSafeInteger(event.now) || event.now < state.lastAt || !valid || !event.ok || !validUsage(usage)) return stop(state.status === "draining" ? state.reason : "failed", { ...next, known: false });
    return { state: { ...next, lastAt: event.now }, effects: [] };
  }
  if (event.type === "finish") {
    const success = state.status === "running" && event.completed && event.cleanupConfirmed && state.known && !state.pending.length && total > 0 &&
      Number.isSafeInteger(event.now) && event.now >= state.lastAt && event.now < state.budget.deadline;
    return { state: { ...state, known: state.known && !state.pending.length,
      status: "done", result: success ? "succeeded" : state.status === "draining" ? state.reason : "failed" }, effects: [] };
  }
  if (state.status === "draining") return { state, effects: [] };
  if (event.type === "cancel") return stop("cancelled");
  if (event.type === "failed") return stop("failed");
  if (!Number.isSafeInteger(event.now) || event.now < state.lastAt) return stop("failed");
  if (event.now >= state.budget.deadline) return stop("limit");
  const next = { ...state, lastAt: event.now };
  if (event.type === "call") {
    if (total >= state.budget.maxCalls || event.kind === "reducer" && state.calls.reducer >= state.budget.maxReducerCalls ||
        event.kind === "summary" && state.calls.summary >= state.budget.maxSummaryCalls) return stop("limit", next);
    return { state: { ...next, calls: { ...state.calls, [event.kind]: state.calls[event.kind] + 1 }, pending: [...state.pending, total + 1] },
      effects: [{ type: "admit", kind: event.kind, id: total + 1 }] };
  }
  if (event.type === "tool") return state.toolCalls >= SOL_TOOL_CALLS || !state.budget.tools.includes(event.name) ? stop("limit", next)
    : { state: { ...next, toolCalls: state.toolCalls + 1 }, effects: [] };
  if (event.type === "compact") return state.compactions >= state.budget.maxCompactions || state.calls.summary >= state.budget.maxSummaryCalls ? stop("limit", next)
    : { state: { ...next, compactions: state.compactions + 1 }, effects: [] };
  if (event.type === "continue") return state.continuations >= state.compactions ? stop("failed", next)
    : { state: { ...next, continuations: state.continuations + 1 }, effects: [] };
  if (!event.valid || !Number.isSafeInteger(event.bytes) || event.bytes < 0 || event.bytes > SOL_STORAGE_BYTES ||
      !Number.isSafeInteger(event.files) || event.files < 0 || event.files > SOL_STORAGE_FILES) return stop("failed", next);
  return { state: { ...next, storageBytes: event.bytes }, effects: [] };
}
export function validSolOptions(input: unknown): input is SolPiInput {
  return Value.Check(SolPiInputSchema, input) &&
    (input.evidencePreservingReducer ? input.maxReducerCalls > 0 : input.maxReducerCalls === 0) &&
    (input.onlineContextCompact ? input.maxSummaryCalls > 0 && input.maxCompactions > 0 : input.maxSummaryCalls === 0 && input.maxCompactions === 0);
}
export function solTools(tools: readonly string[], options: SolPiInput): string[] {
  return [...tools, ...(options.observationPack ? ["obs_recall"] : []), ...(options.onlineContextCompact ? ["update_plan"] : [])];
}

export function solReportComplete(run: Run, report: WorkerReport | undefined): boolean {
  const grant = run.solPi, detail = report?.solPi, calls = detail?.calls;
  if (!grant || !report || !detail || !calls || report.accounting.status !== "reported" || !report.accounting.complete) return false;
  const total = calls.worker + calls.reducer + calls.summary;
  return run.maxModelCalls !== null && total > 0 && total <= run.maxModelCalls && total === report.modelCalls && total === report.accounting.stats.turns &&
    detail.sourceDigest === grant.sourceDigest && detail.storageDirectory === grant.options.storageDirectory &&
    calls.reducer <= grant.options.maxReducerCalls && calls.summary <= grant.options.maxSummaryCalls &&
    detail.compactions !== null && detail.compactions <= grant.options.maxCompactions &&
    detail.continuations !== null && detail.continuations <= detail.compactions &&
    detail.toolCalls !== null && detail.toolCalls <= SOL_TOOL_CALLS && detail.storageBytes !== null && detail.storageBytes <= SOL_STORAGE_BYTES &&
    detail.cleanupConfirmed && report.thinking?.applied === run.agent.thinking;
}

type SolJobView = { readonly run: Run; readonly outcome: DelegateEvent | null; readonly attempted: boolean; readonly cancelled: boolean; readonly keep: boolean; readonly lastAt: number };
export type SolJobState = SolJobView & (
  | { readonly status: "idle" | "opening" | "running" | "recording" | "closing" }
  | { readonly status: "done"; readonly result: DelegateEvent }
);
export type SolJobEvent = { readonly type: "start"; readonly now: number } | { readonly type: "opened"; readonly now: number } | { readonly type: "observed"; readonly outcome: DelegateEvent }
  | { readonly type: "recorded" } | { readonly type: "failed" } | { readonly type: "cancel" }
  | { readonly type: "closed"; readonly ok: boolean; readonly retained: boolean };
export type SolJobEffect = { readonly type: "open" } | { readonly type: "execute" } | { readonly type: "record" } | { readonly type: "close"; readonly keep: boolean };
export function reduceSolJob(state: SolJobState, event: SolJobEvent): { state: SolJobState; effects: readonly SolJobEffect[] } {
  if (state.status === "done") return { state, effects: [] };
  if (event.type === "cancel") return { state: { ...state, cancelled: true }, effects: [] };
  if (event.type === "failed") return { state: { ...state, status: "closing", keep: true,
    outcome: { ...(state.cancelled ? { type: "cancel" as const } : { type: "failed" as const, error: SOL_ERROR }),
      ...(state.outcome?.report ? { report: state.outcome.report } : {}) } },
    effects: [{ type: "close", keep: true }] };
  if (state.status === "idle" && event.type === "start" || state.status === "opening" && event.type === "opened") {
    if (state.cancelled || !Number.isSafeInteger(event.now) || event.now < state.lastAt || event.now >= state.run.solPi!.approvalDeadline) {
      return { state: { ...state, status: "closing", keep: state.status === "opening",
        outcome: state.cancelled ? { type: "cancel" } : { type: "failed", error: SOL_ERROR } },
        effects: [{ type: "close", keep: state.status === "opening" }] };
    }
    return event.type === "start"
      ? { state: { ...state, lastAt: event.now, status: "opening" }, effects: [{ type: "open" }] }
      : { state: { ...state, lastAt: event.now, status: "running", attempted: true }, effects: [{ type: "execute" }] };
  }
  if (state.status === "running" && event.type === "observed") {
    const report = event.outcome.report;
    const keep = event.outcome.type !== "completed" || !solReportComplete(state.run, report);
    return { state: { ...state, status: "recording", outcome: structuredClone(event.outcome), keep }, effects: [{ type: "record" }] };
  }
  if (state.status === "recording" && event.type === "recorded") return { state: { ...state, status: "closing" }, effects: [{ type: "close", keep: state.keep }] };
  if (state.status === "closing" && event.type === "closed") {
    const prior = state.outcome?.report;
    const clean = event.ok && (!state.attempted || prior?.solPi?.cleanupConfirmed === true);
    const report: WorkerReport = { ...(prior ?? { startupMs: null, executionMs: null, modelCalls: state.attempted ? null : 0,
      accounting: { status: state.attempted ? "unknown" as const : "not_started" as const } }),
      solPi: { sourceDigest: state.run.solPi!.sourceDigest, storageDirectory: state.run.solPi!.options.storageDirectory,
        calls: prior?.solPi?.calls ?? (state.attempted ? null : { worker: 0, reducer: 0, summary: 0 }),
        toolCalls: prior?.solPi?.toolCalls ?? (state.attempted ? null : 0), compactions: prior?.solPi?.compactions ?? (state.attempted ? null : 0),
        continuations: prior?.solPi?.continuations ?? (state.attempted ? null : 0), storageBytes: prior?.solPi?.storageBytes ?? null,
        cleanupConfirmed: clean, lockRetained: event.retained, sessionDurability: "not_asserted" } };
    const result: DelegateEvent = state.cancelled ? { type: "cancel", report } : !event.ok || event.retained || !state.outcome
      ? { type: "failed", error: SOL_ERROR, report } : { ...state.outcome, report };
    return { state: { ...state, status: "done", result }, effects: [] };
  }
  return { state, effects: [] };
}

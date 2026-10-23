import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { JevReportSchema } from "./choice.ts";

export const MAX_GOAL_RECORDS = 4_096;
const closed = { additionalProperties: false } as const;
const id = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
export const GoalDigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const count = Type.Integer({ minimum: 0, maximum: 1_000_000 });
const timestamp = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const money = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const GoalUnitsSchema = Type.Object({
  workerRuns: count, workerCalls: count, plannerCalls: count, summaryCalls: count,
  jevCalls: count, verificationRuns: count, repairs: count,
}, closed);
export const GoalRefSchema = Type.Object({
  goalId: id, revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), scopeDigest: GoalDigestSchema,
}, closed);
// A scope digest binds a snapshot; it does not validate permissions or authorize a worker.
export const GoalDefinitionSchema = Type.Object({
  ref: GoalRefSchema, limits: GoalUnitsSchema, maxTotalCalls: count, deadlineMs: timestamp,
}, closed);
export const GoalIntentSchema = Type.Object({ id, planDigest: GoalDigestSchema, reserve: GoalUnitsSchema }, closed);
// Durable, bounded facts; kept at the ledger layer to avoid a machine → files → machine schema cycle.
export const VerificationEvidenceSchema = Type.Object({
  stage: Type.Union([Type.Literal("probe"), Type.Literal("step"), Type.Literal("final")]), checkId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
  operationId: id, sourceDigest: GoalDigestSchema, containerId: Type.Union([GoalDigestSchema, Type.Null()]),
  status: Type.Union([Type.Literal("exited"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timed_out")]),
  exitCode: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]), isolated: Type.Boolean(), filesCurrent: Type.Boolean(), elapsedMs: money,
}, closed);
export type VerificationEvidence = Static<typeof VerificationEvidenceSchema>;
export const RoutingEvidenceSchema = Type.Object({
  operationId: id, proposalDigest: GoalDigestSchema, sourceDigest: GoalDigestSchema,
  attempted: Type.Union([Type.Boolean(), Type.Null()]),
  status: Type.Union([Type.Literal("selected"), Type.Literal("needs_review"), Type.Literal("cancelled")]),
  reason: Type.Union([Type.Literal("selected"), Type.Literal("not_requested"), Type.Literal("unconfirmed"), Type.Literal("cancelled"),
    Type.Literal("request_or_response_failed"), Type.Literal("model_mismatch"), Type.Literal("scope_changed"),
    Type.Literal("missing_distribution"), Type.Literal("weak_support")]),
  agent: Type.Union([Type.String({ pattern: "^[a-z][a-z0-9_-]*$", maxLength: 64 }), Type.Null()]),
  report: Type.Union([JevReportSchema, Type.Null()]), support: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
}, closed);
export type RoutingEvidence = Static<typeof RoutingEvidenceSchema>;
export const GoalSettlementSchema = Type.Object({
  outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("not_started"), Type.Literal("unknown")]),
  used: GoalUnitsSchema, observedUsd: money, accountingComplete: Type.Boolean(), cleanupConfirmed: Type.Boolean(),
  verification: Type.Optional(VerificationEvidenceSchema), routing: Type.Optional(RoutingEvidenceSchema),
}, closed);
const binding = { ref: GoalRefSchema, activationId: id, at: timestamp };
export const GoalRecordSchema = Type.Union([
  Type.Object({ type: Type.Literal("created"), definition: GoalDefinitionSchema, at: timestamp }, closed),
  Type.Object({ type: Type.Literal("approved"), ...binding }, closed),
  Type.Object({ type: Type.Literal("reserved"), ...binding, intent: GoalIntentSchema }, closed),
  Type.Object({ type: Type.Literal("settled"), ...binding, intentId: id, result: GoalSettlementSchema }, closed),
  Type.Object({ type: Type.Literal("closed"), ...binding, reason: Type.Union([Type.Literal("paused"), Type.Literal("cancelled")]) }, closed),
]);
export type GoalUnits = Static<typeof GoalUnitsSchema>;
export type GoalRef = Static<typeof GoalRefSchema>;
export type GoalDefinition = Static<typeof GoalDefinitionSchema>;
export type GoalIntent = Static<typeof GoalIntentSchema>;
export type GoalSettlement = Static<typeof GoalSettlementSchema>;
export type GoalRecord = Static<typeof GoalRecordSchema>;
const keys = Object.keys(GoalUnitsSchema.properties) as (keyof GoalUnits)[];
export const ZERO_GOAL_UNITS: Readonly<GoalUnits> = Object.freeze(Object.fromEntries(keys.map((key) => [key, 0])) as GoalUnits);
const units = (f: (key: keyof GoalUnits) => number): GoalUnits => Object.fromEntries(keys.map((key) => [key, f(key)])) as GoalUnits;
const calls = (u: GoalUnits) => u.workerCalls + u.plannerCalls + u.summaryCalls + u.jevCalls;
const validTime = (value: number) => Value.Check(timestamp, value);
const invalid = (): never => { throw new Error("Invalid goal record or transition."); };
export type GoalLedger = {
  readonly definition: GoalDefinition; readonly sequence: number; readonly lastAt: number;
  readonly activationId: string | null; readonly activationIds: readonly string[]; readonly intentIds: readonly string[];
  readonly spent: GoalUnits; readonly held: GoalUnits; readonly pending: GoalIntent | null;
  readonly observedUsd: number; readonly totalUsd: number | null; readonly blocked: boolean;
};

/** Pure strict fold. Persisted approval is history, never a live activation. */
export function applyGoalRecord(previous: GoalLedger | null, input: unknown): GoalLedger {
  if (!Value.Check(GoalRecordSchema, input)) return invalid();
  const record = structuredClone(input);
  if (!previous) {
    if (record.type !== "created" || record.at >= record.definition.deadlineMs) return invalid();
    return { definition: record.definition, sequence: 1, lastAt: record.at, activationId: null,
      activationIds: [], intentIds: [], spent: { ...ZERO_GOAL_UNITS }, held: { ...ZERO_GOAL_UNITS }, pending: null,
      observedUsd: 0, totalUsd: 0, blocked: false };
  }
  if (record.type === "created" || previous.sequence >= MAX_GOAL_RECORDS || record.at < previous.lastAt ||
      !isDeepStrictEqual(record.ref, previous.definition.ref)) return invalid();
  const next = { ...previous, sequence: previous.sequence + 1, lastAt: record.at };
  if (record.type === "approved") {
    if (previous.pending || previous.blocked || previous.activationIds.includes(record.activationId) || record.at >= previous.definition.deadlineMs) return invalid();
    return { ...next, activationId: record.activationId, activationIds: [...previous.activationIds, record.activationId] };
  }
  if (previous.activationId !== record.activationId) return invalid();
  if (record.type === "closed") {
    if (previous.pending) return invalid();
    return { ...next, activationId: null };
  }
  if (record.type === "reserved") {
    const reserve = record.intent.reserve;
    if (previous.pending || previous.blocked || previous.sequence + 2 > MAX_GOAL_RECORDS || previous.intentIds.includes(record.intent.id) ||
        record.at >= previous.definition.deadlineMs || !keys.some((key) => reserve[key] > 0) ||
        keys.some((key) => previous.spent[key] + previous.held[key] + reserve[key] > previous.definition.limits[key]) ||
        calls(previous.spent) + calls(previous.held) + calls(reserve) > previous.definition.maxTotalCalls) return invalid();
    return { ...next, pending: record.intent, totalUsd: null, held: units((key) => previous.held[key] + reserve[key]),
      intentIds: [...previous.intentIds, record.intent.id] };
  }
  if (!previous.pending || previous.pending.id !== record.intentId || previous.blocked) return invalid();
  const result = record.result, pending = previous.pending;
  if (keys.some((key) => result.used[key] > pending.reserve[key])) return invalid();
  if (result.verification && (pending.reserve.verificationRuns !== 1 || result.verification.operationId !== record.intentId ||
    keys.some((key) => key !== "verificationRuns" && result.used[key] !== 0) ||
    result.verification.status === "exited" && result.verification.exitCode === null)) return invalid();
  if (result.routing && (result.verification || pending.reserve.jevCalls !== 1 || result.routing.operationId !== record.intentId ||
    keys.some((key) => key !== "jevCalls" && result.used[key] !== 0) || result.used.jevCalls !== (result.routing.attempted === true ? 1 : 0) ||
    result.routing.attempted === null && result.accountingComplete ||
    result.routing.status === "selected" && (result.routing.reason !== "selected" || result.routing.attempted !== true || !result.routing.agent || !result.routing.report ||
      result.routing.support === null || result.routing.support < 0.5))) return invalid();
  if (result.outcome === "not_started" && (keys.some((key) => result.used[key] !== 0) || result.observedUsd !== 0 ||
      !result.accountingComplete || !result.cleanupConfirmed)) return invalid();
  const known = result.accountingComplete && result.cleanupConfirmed && result.outcome !== "unknown";
  const observedUsd = previous.observedUsd + result.observedUsd;
  if (!Number.isFinite(observedUsd) || observedUsd > Number.MAX_SAFE_INTEGER) return invalid();
  return { ...next, pending: null, spent: units((key) => previous.spent[key] + result.used[key]),
    held: units((key) => previous.held[key] - (known ? pending.reserve[key] : result.used[key])),
    observedUsd, totalUsd: known ? observedUsd : null,
    blocked: !known || !["succeeded", "not_started"].includes(result.outcome) };
}
// ponytail: bounded full replay (4096 records); add an indexed checkpoint only if that cap must grow.
export function replayGoal(records: readonly unknown[]): GoalLedger | null {
  if (!Array.isArray(records) || records.length > MAX_GOAL_RECORDS) return invalid();
  let ledger: GoalLedger | null = null;
  for (const record of records) ledger = applyGoalRecord(ledger, record);
  return ledger;
}
export type GoalHead = { readonly sequence: number; readonly hash: string | null };
export const EMPTY_GOAL_HEAD: GoalHead = Object.freeze({ sequence: 0, hash: null });
export const GoalHeadSchema = Type.Object({ sequence: Type.Integer({ minimum: 0, maximum: MAX_GOAL_RECORDS }),
  hash: Type.Union([GoalDigestSchema, Type.Null()]) }, closed);
type View = { readonly ledger: GoalLedger; readonly head: GoalHead; readonly activationId: string; readonly now: number };
type Destination = "awaiting_approval" | "ready" | "checking" | "paused" | "cancelled" | "needs_review" | "settled";
export type GoalState =
  | { readonly status: "idle" }
  | ({ readonly status: "awaiting_approval" | "ready" | "checking" | "active" } & View)
  | ({ readonly status: "draining"; readonly reason: "paused" | "cancelled" | "needs_review" } & View)
  | { readonly status: "persisting"; readonly ledger: GoalLedger | null; readonly head: GoalHead;
      readonly activationId: string; readonly now: number; readonly record: GoalRecord; readonly destination: Destination }
  | { readonly status: "paused" | "cancelled" | "failed" | "needs_review"; readonly ledger: GoalLedger | null;
      readonly reason: string; readonly unconfirmedRecord?: GoalRecord };
export type GoalStorageEffect = { readonly type: "append_goal"; readonly expected: GoalHead; readonly record: GoalRecord };
export type GoalEffect = GoalStorageEffect
  | { readonly type: "check_goal_admission"; readonly ref: GoalRef; readonly activationId: string; readonly intent: GoalIntent; readonly head: GoalHead }
  | { readonly type: "dispatch_goal_operation" | "stop_goal_operation"; readonly ref: GoalRef; readonly activationId: string; readonly intent: GoalIntent };
export type GoalEvent =
  | { readonly type: "create"; readonly definition: GoalDefinition; readonly activationId: string; readonly now: number }
  | { readonly type: "restore"; readonly records: readonly unknown[]; readonly head: GoalHead; readonly activationId: string; readonly now: number }
  | { readonly type: "approval"; readonly ref: GoalRef; readonly activationId: string; readonly approved: boolean; readonly now: number }
  | { readonly type: "reserve"; readonly ref: GoalRef; readonly activationId: string; readonly intent: GoalIntent; readonly now: number }
  | { readonly type: "persisted"; readonly expected: GoalHead; readonly record: GoalRecord; readonly head: GoalHead; readonly now: number }
  | { readonly type: "admission"; readonly ref: GoalRef; readonly activationId: string; readonly intentId: string; readonly head: GoalHead;
      readonly current: boolean; readonly now: number }
  | { readonly type: "settlement"; readonly ref: GoalRef; readonly activationId: string; readonly intentId: string;
      readonly result: GoalSettlement; readonly now: number }
  | { readonly type: "pause" | "cancel" }
  | { readonly type: "storage_failed"; readonly expected: GoalHead; readonly record: GoalRecord };
export type GoalTransition = { readonly state: GoalState; readonly effects: readonly GoalEffect[] };
const terminal = (status: "paused" | "cancelled" | "failed" | "needs_review", ledger: GoalLedger | null, reason: string,
  unconfirmedRecord?: GoalRecord): GoalTransition => ({ state: { status, ledger, reason,
    ...(unconfirmedRecord ? { unconfirmedRecord: structuredClone(unconfirmedRecord) } : {}) }, effects: [] });
function persist(ledger: GoalLedger | null, head: GoalHead, activationId: string, now: number,
  record: GoalRecord, destination: Destination): GoalTransition {
  applyGoalRecord(ledger, record); // Validate before emitting a write, but do not publish its projection before ack.
  return { state: { status: "persisting", ledger, head, activationId, now, record: structuredClone(record), destination },
    effects: [{ type: "append_goal", expected: { ...head }, record: structuredClone(record) }] };
}
function scoped(view: View, ref: GoalRef, activationId: string): boolean {
  return activationId === view.activationId && isDeepStrictEqual(ref, view.ledger.definition.ref);
}
function drain(view: View, reason: "paused" | "cancelled" | "needs_review"): GoalTransition {
  const intent = view.ledger.pending;
  if (!intent) return terminal("needs_review", view.ledger, "Missing admitted operation.");
  return { state: { ...view, status: "draining", reason }, effects: [{ type: "stop_goal_operation",
    ref: structuredClone(view.ledger.definition.ref), activationId: view.activationId, intent: structuredClone(intent) }] };
}

/** Stage A only: dispatch/stop/admission effects have no production executor or pi tool. */
export function reduceGoal(state: GoalState, event: GoalEvent): GoalTransition {
  const unchanged = { state, effects: [] };
  if (["paused", "cancelled", "failed", "needs_review"].includes(state.status)) return unchanged;
  const ledger = "ledger" in state ? state.ledger : null;
  try {
    if (event.type === "cancel" || event.type === "pause") {
      const reason = event.type === "cancel" || (state.status === "persisting" && state.destination === "cancelled") ? "cancelled" : "paused";
      if (state.status === "draining") return event.type === "cancel"
        ? { state: { ...state, reason: "cancelled" }, effects: [] } : unchanged;
      if (state.status === "active") return drain(state, reason);
      if (state.status === "ready") return persist(state.ledger, state.head, state.activationId, state.now,
        { type: "closed", ref: state.ledger.definition.ref, activationId: state.activationId, at: state.now, reason }, reason);
      return terminal(reason, ledger, "Activation stopped; pending writes or reservations require inspection.",
        state.status === "persisting" ? state.record : undefined);
    }
    if (event.type === "storage_failed") {
      if (state.status !== "persisting" || !isDeepStrictEqual(event.expected, state.head) || !isDeepStrictEqual(event.record, state.record)) return unchanged;
      return terminal(state.destination === "cancelled" ? "cancelled" : "needs_review", ledger,
        "Goal storage failed; application may be unknown. No retry.", state.record);
    }
    if (state.status === "idle") {
      if (event.type !== "create" && event.type !== "restore") return unchanged;
      if (!Value.Check(id, event.activationId) || !validTime(event.now)) return terminal("failed", null, "Invalid activation input.");
      if (event.type === "create") return persist(null, EMPTY_GOAL_HEAD, event.activationId, event.now,
        { type: "created", definition: event.definition, at: event.now }, "awaiting_approval");
      const restored = replayGoal(event.records);
      if (!restored || !Value.Check(GoalHeadSchema, event.head) || event.head.sequence !== restored.sequence || event.head.hash === null ||
          event.now < restored.lastAt || event.now >= restored.definition.deadlineMs || restored.activationIds.includes(event.activationId)) {
        return terminal("needs_review", restored, "Invalid, stale, expired, or reused activation snapshot.");
      }
      if (restored.pending || restored.blocked) return terminal("needs_review", restored, "Unresolved operation or failed goal; no automatic replay.");
      return { state: { status: "awaiting_approval", ledger: restored, head: { ...event.head }, activationId: event.activationId, now: event.now }, effects: [] };
    }
    if (state.status === "persisting" && event.type === "persisted") {
      if (!isDeepStrictEqual(event.expected, state.head)) return unchanged;
      if (!isDeepStrictEqual(event.record, state.record) || !Value.Check(GoalHeadSchema, event.head) ||
          event.head.sequence !== state.head.sequence + 1 || event.head.hash === null || !validTime(event.now) || event.now < state.now) {
        return terminal(state.destination === "cancelled" ? "cancelled" : "needs_review", ledger, "Invalid goal storage acknowledgement.", state.record);
      }
      const committed = applyGoalRecord(ledger, state.record);
      if (state.destination === "paused" || state.destination === "cancelled" || state.destination === "needs_review") return terminal(state.destination, committed, "Activation stopped.");
      if (state.destination === "settled" && committed.blocked) return terminal("needs_review", committed, "Operation failed or accounting/cleanup is uncertain.");
      if (event.now >= committed.definition.deadlineMs) return terminal("needs_review", committed, "Goal deadline reached; no admission.");
      const view = { ledger: committed, head: { ...event.head }, activationId: state.activationId, now: event.now };
      if (state.destination === "checking") {
        if (!committed.pending) return invalid();
        return { state: { status: "checking", ...view }, effects: [{ type: "check_goal_admission",
          ref: structuredClone(committed.definition.ref), activationId: view.activationId, intent: structuredClone(committed.pending), head: { ...view.head } }] };
      }
      return { state: { status: state.destination === "awaiting_approval" ? "awaiting_approval" : "ready", ...view }, effects: [] };
    }
    if (state.status === "awaiting_approval" && event.type === "approval") {
      if (!scoped(state, event.ref, event.activationId)) return unchanged;
      if (!validTime(event.now) || event.now < state.now) return terminal("needs_review", ledger, "Invalid approval observation.");
      if (event.approved !== true) return terminal("cancelled", ledger, "Goal activation was not approved.");
      return persist(state.ledger, state.head, state.activationId, event.now,
        { type: "approved", ref: event.ref, activationId: state.activationId, at: event.now }, "ready");
    }
    if (state.status === "ready" && event.type === "reserve") {
      if (!scoped(state, event.ref, event.activationId)) return unchanged;
      if (!validTime(event.now) || event.now < state.now) return terminal("needs_review", ledger, "Invalid reservation observation.");
      return persist(state.ledger, state.head, state.activationId, event.now,
        { type: "reserved", ref: event.ref, activationId: state.activationId, intent: event.intent, at: event.now }, "checking");
    }
    if (state.status === "checking" && event.type === "admission") {
      if (!scoped(state, event.ref, event.activationId) || event.intentId !== state.ledger.pending?.id) return unchanged;
      if (event.current !== true || !isDeepStrictEqual(event.head, state.head) || !validTime(event.now) || event.now < state.now ||
          event.now >= state.ledger.definition.deadlineMs) return terminal("needs_review", ledger, "Goal admission is stale, revoked, or expired.");
      if (!state.ledger.pending) return invalid();
      return { state: { ...state, status: "active", now: event.now }, effects: [{ type: "dispatch_goal_operation",
        ref: structuredClone(state.ledger.definition.ref), activationId: state.activationId, intent: structuredClone(state.ledger.pending) }] };
    }
    if ((state.status === "active" || state.status === "draining") && event.type === "settlement") {
      if (!scoped(state, event.ref, event.activationId) || event.intentId !== state.ledger.pending?.id) return unchanged;
      if (!validTime(event.now) || event.now < state.now || !Value.Check(GoalSettlementSchema, event.result)) return invalid();
      const record: GoalRecord = { type: "settled", ref: event.ref, activationId: state.activationId,
        intentId: event.intentId, result: event.result, at: event.now };
      if (state.status === "draining") {
        applyGoalRecord(state.ledger, record); // Validate the original report before mapping the stop reason.
        record.result = { ...record.result, outcome: state.reason === "needs_review" || record.result.outcome === "unknown" ? "unknown" : "cancelled" };
      }
      return persist(state.ledger, state.head, state.activationId, event.now, record,
        state.status === "draining" ? state.reason : "settled");
    }
    return unchanged;
  } catch {
    if (state.status === "active") return drain(state, "needs_review");
    if (state.status === "draining") return unchanged; // Await bounded cleanup/accounting; do not abandon an admitted operation.
    return terminal(state.status === "persisting" && state.destination === "cancelled" ? "cancelled" : "needs_review", ledger,
      "Invalid goal input, record, or budget transition; no dispatch.", state.status === "persisting" ? state.record : undefined);
  }
}

import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BoundedRunSchema as RunSchema, type WorkerReport } from "./delegate-machine.ts";
import { GoalContextFileSchema, GoalGrantSchema, GoalLeaseSchema, GoalObservationSchema, goalLockText, settlementFor, type GoalObservation, type GoalLease } from "./goal-run.ts";
import { GoalFileScopeSchema, GoalFileVersionSchema, goalTextBytes, goalFileDigest as memoryHashRaw } from "./goal-files.ts";
import { ZERO_GOAL_UNITS, reduceGoal, type GoalState, type GoalEvent, type GoalEffect, type GoalLedger, type GoalRecord } from "./goal-machine.ts";
import { MemoryBundleSchema, MEMORY_RULES, memoryHash, memoryMatchesScope, validMemoryBundle } from "./context-memory.ts";
import { INTERNAL_ENGLISH_POLICY, englishModelData, englishProse } from "./internal-language.ts";

export const CONTEXT_ERROR = "Context management stopped. No retry, default compaction, restored execution authority or rollback. Review the recorded accounting and application status.";
export const CONTEXT_MS = 180_000, SUMMARY_MS = 30_000, CONTEXT_APPROVAL_MS = 60_000;
export const CONTEXT_APPLICATION_FILE = ".jev-context-application.jsonl";
const closed = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const list = Type.Array(text(256), { maxItems: 8 });
export const ContextInputSchema = Type.Object({
  agent: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }), journalDirectory: text(4096), notes: text(8000),
  preserve: Type.Object({ goal: text(1000), scope: text(512), constraints: list, nonGoals: list, remaining: list,
    failedChecks: list, uncertainties: list, currentTurn: text(1000) }, closed), memory: Type.Optional(MemoryBundleSchema),
}, closed);
export type ContextInput = Static<typeof ContextInputSchema>;
export const ContextSourceSchema = Type.Object({ sessionId: text(256), leafId: text(64), branchDigest: hash, systemPromptDigest: hash,
  firstKeptEntryId: text(64), tokensBefore: time, entries: Type.Integer({ minimum: 1, maximum: 4096 }), splitTurn: Type.Boolean() }, closed);
export type ContextSource = Static<typeof ContextSourceSchema>;
export const ContextGrantSchema = Type.Object({ ...Type.Pick(GoalGrantSchema, ["ref", "activationId", "intentId"]).properties,
  body: Type.Object({ input: ContextInputSchema, source: ContextSourceSchema, run: RunSchema,
    files: Type.Object({ ...GoalFileScopeSchema.properties, files: Type.Tuple([]) }, closed),
    journalDirectory: text(4096), journalIdentity: GoalFileVersionSchema.properties.identity, agentDirectory: text(4096),
    context: Type.Array(GoalContextFileSchema, { maxItems: 128 }), systemPrompt: text(65_536), prompt: text(32_768),
    preparedAt: time, approvalDeadline: time, deadline: time }, closed),
}, closed);
export type ContextGrant = Static<typeof ContextGrantSchema>;
export const ContextWorkerInputSchema = Type.Object({ grant: ContextGrantSchema, lease: GoalLeaseSchema }, closed);
export const SUMMARY_TASK = "Summarize only the explicitly approved context packet. Return one JSON object with only a summary string (at most 2000 characters).";
export function summaryPrompts(input: ContextInput, run: ContextGrant["body"]["run"], context: ContextGrant["body"]["context"]) {
  return { systemPrompt: `${INTERNAL_ENGLISH_POLICY}\n${SUMMARY_TASK}\nNo tools, commands, browsing, memory writes, further calls or rework. Do not invent success, remove failures or change permissions. Preserve uncertainty. ${MEMORY_RULES}\n\n${run.agent.systemPrompt}\n\n${context.filter(x => x.active).map(x => JSON.stringify({ instructionFile: x.path, content: x.text })).join("\n\n")}`,
    prompt: JSON.stringify({ notes: input.notes, preserve: input.preserve, ...(input.memory ? { memory: input.memory } : {}) }) };
}
export function validContextInput(input: unknown): input is ContextInput {
  try {
    if (!Value.Check(ContextInputSchema, input) || Buffer.byteLength(JSON.stringify(input)) > 16_384 || input.memory && !validMemoryBundle(input.memory) ||
      !englishModelData({ notes: input.notes, preserve: input.preserve })) return false;
    for (const value of [input.journalDirectory, input.notes, ...Object.values(input.preserve).flat()]) goalTextBytes(value);
    return true;
  } catch { return false; }
}
export function validContextGrant(input: unknown): input is ContextGrant {
  try {
    if (!Value.Check(ContextGrantSchema, input) || Buffer.byteLength(JSON.stringify(input)) > 262_144) return false;
    const { body } = input;
    return validContextInput(body.input) && body.run.task === SUMMARY_TASK && body.run.maxModelCalls === 1 && body.run.agent.name === body.input.agent &&
      isDeepStrictEqual(body.run.model, body.run.agent.model) && body.run.cwd === body.files.root && memoryMatchesScope(body.input.memory, body.files) &&
      body.context.some(x => x.path === body.run.agent.file && !x.active && x.version !== null) &&
      isDeepStrictEqual(summaryPrompts(body.input, body.run, body.context), { systemPrompt: body.systemPrompt, prompt: body.prompt }) &&
      body.approvalDeadline === body.preparedAt + CONTEXT_APPROVAL_MS && body.deadline === body.preparedAt + CONTEXT_MS &&
      input.ref.revision === 1 && input.ref.scopeDigest === memoryHash(body);
  } catch { return false; }
}
function summary(observation: GoalObservation): string | null {
  try {
    const reply = observation.result?.reply;
    if (reply?.type !== "completed" || reply.result.truncated || Buffer.byteLength(reply.result.text) > 16_384) return null;
    const value: unknown = JSON.parse(reply.result.text);
    if (!Value.Check(Type.Object({ summary: text(2000) }, closed), value) || goalTextBytes(value.summary) > 8000 || !englishProse(value.summary)) return null;
    return value.summary;
  } catch { return null; }
}
export function contextSummaryText(grant: ContextGrant, draft: string): string {
  return "User-reviewed bounded context summary, not verification or a complete transcript. All prior execution approvals are historical; none is restored. Original pi entries are retained.\n\n" +
    JSON.stringify({ source: grant.body.source, generatedClaim: draft, preservedVerbatim: grant.body.input.preserve,
      ...(grant.body.input.memory ? { referenceOnlyMemory: grant.body.input.memory } : {}) });
}
export type ContextApplication = "not_applied" | "applied_in_session" | "unknown";
type Outcome = "applied" | "cancelled" | "failed" | "needs_review";
type View = { readonly grant: ContextGrant; readonly lockVersion: GoalLease["lockVersion"]; readonly core: GoalState; readonly launched: boolean;
  readonly cancelled: boolean; readonly observation?: GoalObservation; readonly draft?: string; readonly applyDeadline?: number;
  readonly application: ContextApplication; readonly entryId?: string; readonly uncertain: boolean };
export type ContextResult = { readonly status: Outcome; readonly application: ContextApplication; readonly sessionDurability: "not_asserted";
  readonly ledger: GoalLedger | null; readonly unconfirmedRecord?: GoalRecord; readonly report?: WorkerReport; readonly entryId?: string;
  readonly cleanupConfirmed: boolean; readonly lockRetained: boolean };
export type ContextState = { readonly status: "idle" } | { readonly status: "preparing"; readonly input: ContextInput }
  | { readonly status: "awaiting_approval" | "opening"; readonly grant: ContextGrant }
  | { readonly status: "working" | "awaiting_apply" | "recording_intent" | "applying" | "recording_result"; readonly view: View }
  | { readonly status: "closing"; readonly view: View | null; readonly outcome: Outcome; readonly keep: boolean }
  | { readonly status: "done"; readonly result: ContextResult };
export type ContextEvent = { readonly type: "start"; readonly input: ContextInput; readonly available: boolean }
  | { readonly type: "prepared"; readonly grant: ContextGrant }
  | { readonly type: "approval" | "apply_approval"; readonly digest: string; readonly approved: boolean; readonly now: number }
  | { readonly type: "opened"; readonly lockVersion: GoalLease["lockVersion"]; readonly now: number }
  | { readonly type: "control"; readonly event: GoalEvent }
  | { readonly type: "observed"; readonly observation: GoalObservation; readonly now: number }
  | { readonly type: "recorded"; readonly kind: "intent" | "applied"; readonly digest: string }
  | { readonly type: "applied"; readonly application: ContextApplication; readonly entryId?: string }
  | { readonly type: "closed"; readonly ok: boolean; readonly retained: boolean }
  | { readonly type: "failed"; readonly uncertain: boolean }
  | { readonly type: "cancel" };
export type ContextEffect = { readonly type: "prepare_context"; readonly input: ContextInput }
  | { readonly type: "confirm_context" | "open_context"; readonly grant: ContextGrant }
  | { readonly type: "context_control"; readonly grant: ContextGrant; readonly lease: GoalLease; readonly effect: GoalEffect }
  | { readonly type: "confirm_application" | "record_intent" | "apply_context" | "record_application"; readonly view: View }
  | { readonly type: "close_context"; readonly keep: boolean }
  | { readonly type: "abort_context" };
type Transition = { state: ContextState; effects: readonly ContextEffect[] };
export function applicationDigest(view: Pick<View, "grant" | "draft" | "applyDeadline">): string {
  return memoryHash({ ref: view.grant.ref, source: view.grant.body.source, text: contextSummaryText(view.grant, view.draft!), deadline: view.applyDeadline });
}
function closing(view: View | null, outcome: Outcome, uncertain = false): Transition {
  const core = view?.core, ledger = core && "ledger" in core ? core.ledger : null;
  const keep = uncertain || view?.uncertain === true || view?.application === "unknown" || ledger?.blocked === true || ledger?.pending != null ||
    !!(core && "unconfirmedRecord" in core && core.unconfirmedRecord) || view?.launched === true && view.observation?.cleanupConfirmed !== true;
  return { state: { status: "closing", view, outcome, keep }, effects: [{ type: "close_context", keep }] };
}
function advance(view: View, event: GoalEvent): Transition {
  let next = reduceGoal(view.core, event);
  const { grant } = view, { ref, activationId, intentId } = grant;
  if (next.state.status === "awaiting_approval") next = reduceGoal(next.state, { type: "approval", ref, activationId, approved: true, now: next.state.now });
  else if (next.state.status === "ready") next = reduceGoal(next.state, view.launched ? { type: "pause" } : { type: "reserve", ref, activationId,
    now: next.state.now, intent: { id: intentId, planDigest: ref.scopeDigest, reserve: { ...ZERO_GOAL_UNITS, summaryCalls: 1 } } });
  const updated = { ...view, core: next.state, launched: view.launched || next.effects.some(e => e.type === "dispatch_goal_operation") };
  if (next.state.status === "paused" && !view.cancelled && next.state.ledger?.blocked === false && next.state.ledger.totalUsd !== null &&
    view.observation?.cleanupConfirmed === true && summary(view.observation) !== null) {
    const ready = { ...updated, draft: summary(view.observation)!, applyDeadline: Math.min(grant.body.deadline, next.state.ledger!.lastAt + CONTEXT_APPROVAL_MS) };
    return { state: { status: "awaiting_apply", view: ready }, effects: [{ type: "confirm_application", view: structuredClone(ready) }] };
  }
  if (["paused", "cancelled", "failed", "needs_review"].includes(next.state.status)) return closing(updated, view.cancelled ? "cancelled" : "needs_review");
  if (next.state.status === "draining" && view.observation) return closing(updated, view.cancelled ? "cancelled" : "needs_review", true);
  const head = "head" in next.state ? next.state.head : { sequence: 0, hash: null };
  return { state: { status: "working", view: updated }, effects: next.effects.map(effect => ({ type: "context_control", grant: structuredClone(grant),
    lease: { head: structuredClone(head), lockVersion: structuredClone(view.lockVersion) }, effect })) };
}
export function reduceContext(state: ContextState, event: ContextEvent): Transition {
  const unchanged: Transition = { state, effects: [] };
  if (state.status === "done") return unchanged;
  if (state.status === "closing") {
    if (event.type === "cancel") return { state: { ...state, outcome: "cancelled" }, effects: [] };
    if (event.type === "failed") return reduceContext(state, { type: "closed", ok: false, retained: true });
    if (event.type !== "closed") return unchanged;
    const view = state.view, core = view?.core;
    return { state: { status: "done", result: { status: state.outcome === "cancelled" ? "cancelled" : event.ok ? state.outcome : "needs_review",
      application: view?.application ?? "not_applied", sessionDurability: "not_asserted", ledger: core && "ledger" in core ? core.ledger : null,
      ...(core && "unconfirmedRecord" in core ? { unconfirmedRecord: core.unconfirmedRecord } : {}),
      ...(view?.observation?.result ? { report: structuredClone(view.observation.result.reply.report) } : {}), ...(view?.entryId ? { entryId: view.entryId } : {}),
      cleanupConfirmed: event.ok && view?.observation?.cleanupConfirmed !== false, lockRetained: event.retained } }, effects: [] };
  }
  const view = "view" in state ? state.view : null;
  try {
    if (event.type === "cancel") {
      if (state.status === "working") return advance({ ...state.view, cancelled: true }, { type: "cancel" });
      if (view && ["recording_intent", "applying", "recording_result"].includes(state.status))
        return { state: { ...state, view: { ...view, cancelled: true } } as ContextState, effects: [{ type: "abort_context" }] };
      return { ...closing(view, "cancelled"), effects: [{ type: "abort_context" }, ...closing(view, "cancelled").effects] };
    }
    if (event.type === "failed") return closing(state.status === "applying" ? { ...state.view, application: "unknown" } : view,
      view?.cancelled ? "cancelled" : "needs_review", event.uncertain || state.status === "applying");
    if (state.status === "idle" && event.type === "start") {
      if (!event.available || !validContextInput(event.input)) return closing(null, "failed");
      return { state: { status: "preparing", input: structuredClone(event.input) }, effects: [{ type: "prepare_context", input: structuredClone(event.input) }] };
    }
    if (state.status === "preparing" && event.type === "prepared") {
      if (!validContextGrant(event.grant) || !isDeepStrictEqual(event.grant.body.input, state.input)) return closing(null, "failed");
      return { state: { status: "awaiting_approval", grant: structuredClone(event.grant) }, effects: [{ type: "confirm_context", grant: structuredClone(event.grant) }] };
    }
    if (state.status === "awaiting_approval" && event.type === "approval") {
      if (event.digest !== state.grant.ref.scopeDigest) return unchanged;
      if (!event.approved || !Value.Check(time, event.now) || event.now < state.grant.body.preparedAt || event.now >= state.grant.body.approvalDeadline) return closing(null, "cancelled");
      return { state: { status: "opening", grant: state.grant }, effects: [{ type: "open_context", grant: structuredClone(state.grant) }] };
    }
    if (state.status === "opening" && event.type === "opened") {
      if (!Value.Check(GoalFileVersionSchema, event.lockVersion) || event.lockVersion.digest !== memoryHashRaw(goalLockText(state.grant))) return closing(null, "needs_review", true);
      return advance({ grant: state.grant, lockVersion: structuredClone(event.lockVersion), core: { status: "idle" }, launched: false, cancelled: false,
        application: "not_applied", uncertain: false }, { type: "create", definition: { ref: state.grant.ref, limits: { ...ZERO_GOAL_UNITS, summaryCalls: 1 },
          maxTotalCalls: 1, deadlineMs: state.grant.body.deadline }, activationId: state.grant.activationId, now: event.now });
    }
    if (state.status === "working" && event.type === "control") return advance(state.view, event.event);
    if (state.status === "working" && event.type === "observed" && ["active", "draining"].includes(state.view.core.status)) {
      const observation = Value.Check(GoalObservationSchema, event.observation) ? structuredClone(event.observation) : { started: true, cleanupConfirmed: false, result: null };
      const settlement = settlementFor(state.view.grant, observation), result = { ...settlement,
        outcome: settlement.outcome === "succeeded" && summary(observation) === null ? "failed" as const : settlement.outcome,
        used: { ...ZERO_GOAL_UNITS, summaryCalls: settlement.used.workerCalls } };
      return advance({ ...state.view, observation }, { type: "settlement", ref: state.view.grant.ref, activationId: state.view.grant.activationId,
        intentId: state.view.grant.intentId, result, now: event.now });
    }
    if (state.status === "awaiting_apply" && event.type === "apply_approval") {
      if (event.digest !== applicationDigest(state.view)) return unchanged;
      const ledger = "ledger" in state.view.core ? state.view.core.ledger : null;
      if (!event.approved || !Value.Check(time, event.now) || event.now < (ledger?.lastAt ?? Infinity) || event.now >= state.view.applyDeadline!) return closing(state.view, "cancelled");
      return { state: { status: "recording_intent", view: state.view }, effects: [{ type: "record_intent", view: structuredClone(state.view) }] };
    }
    if (state.status === "recording_intent" && event.type === "recorded" && event.kind === "intent" && event.digest === applicationDigest(state.view)) {
      if (state.view.cancelled) return closing(state.view, "cancelled");
      return { state: { status: "applying", view: state.view }, effects: [{ type: "apply_context", view: structuredClone(state.view) }] };
    }
    if (state.status === "applying" && event.type === "applied") {
      const updated = { ...state.view, application: event.application, ...(event.entryId ? { entryId: event.entryId } : {}) };
      if (event.application !== "applied_in_session" || !event.entryId) return closing(updated, updated.cancelled ? "cancelled" : "needs_review", event.application !== "not_applied");
      return { state: { status: "recording_result", view: updated }, effects: [{ type: "record_application", view: structuredClone(updated) }] };
    }
    if (state.status === "recording_result" && event.type === "recorded" && event.kind === "applied" && event.digest === applicationDigest(state.view))
      return closing(state.view, state.view.cancelled ? "cancelled" : "applied");
    return unchanged;
  } catch { return closing(view, view?.cancelled ? "cancelled" : "needs_review", true); }
}

export type NativeApplicationState = { readonly status: "armed"; readonly source: ContextSource; readonly deadline: number } | { readonly status: "consumed" };
export function reduceNativeApplication(state: NativeApplicationState, event: { readonly type: "before"; readonly source: ContextSource; readonly now: number;
  readonly current: boolean; readonly aborted: boolean; readonly reason: string; readonly willRetry: boolean }): { state: NativeApplicationState; effects: readonly { type: "supply_summary" }[] } {
  if (state.status === "consumed") return { state, effects: [] };
  const valid = event.current && !event.aborted && event.reason === "manual" && !event.willRetry && Value.Check(time, event.now) &&
    event.now < state.deadline && isDeepStrictEqual(event.source, state.source);
  return { state: { status: "consumed" }, effects: valid ? [{ type: "supply_summary" }] : [] };
}
/** ponytail: SDK token estimates are a pressure heuristic, not a hard token cap; use provider counting if exact admission is required. */
export function managedParentAllowed(observation: { owned: boolean; busy: boolean; aborted: boolean; autoCompaction: boolean; autoRetry: boolean;
  tokens: number | null; estimatedTokens: number; contextWindow: number }): boolean {
  return observation.owned && !observation.busy && !observation.aborted && !observation.autoCompaction && !observation.autoRetry &&
    Number.isSafeInteger(observation.estimatedTokens) && observation.estimatedTokens > 0 && Number.isSafeInteger(observation.contextWindow) && observation.contextWindow > 0 &&
    (observation.tokens === null || Number.isSafeInteger(observation.tokens) && observation.tokens >= 0) &&
    Math.max(observation.estimatedTokens, observation.tokens ?? observation.estimatedTokens) < observation.contextWindow * 0.85;
}

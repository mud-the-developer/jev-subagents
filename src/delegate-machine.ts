import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AGENT_NAME_PATTERN, JEV_MODEL, LIMITS, SoftRoutingSchema, reduce as reduceRoute,
  type Decision, type BaselineDecision, type Effect as RouteEffect, type State as RouteState, type Transition as RouteTransition } from "./machine.ts";
import { JevReportSchema, readChoice, reportData, estimateJevUsd, type JevReport } from "./choice.ts";
import { ModelSchema, PoolSchema, ThinkingSchema, CapabilitySchema, buildPlans, type Capability, type Plan } from "./planning.ts";
import { CriteriaSchema, AssessmentPacketSchema, AssessmentReplySchema, MAX_REVIEW_SUMMARY, workerPrompt,
  type Assessment, type AssessmentPacket, type AssessmentReply } from "./assessment.ts";
import { SolPiInputSchema, SolPiPreparedSchema, SolPiReportSchema, validSolOptions, solReportComplete, solHash, SOL_ERROR, type SolPiInput, type SolPiPrepared } from "./sol-pi.ts";
import { englishModelData, englishProse, INTERNAL_LANGUAGE_ERROR } from "./internal-language.ts";
import { WorkerRoundSchema, WorkerRoundCoverageSchema, MAX_RECORDED_WORKER_ROUNDS } from "./worker-rounds.ts";
import { SkillCandidatesSchema, validSkills } from "./skill-suggestion.ts";
export { ModelSchema } from "./planning.ts";

export const RUN_TIMEOUT_MS = 120_000; // Legacy packets without an explicit approved duration keep their original limit.
export const DEFAULT_RUN_SECONDS = 86_400;
export const MAX_RUN_SECONDS = 86_400;
export const ExecutionSecondsSchema = Type.Integer({ minimum: 1, maximum: MAX_RUN_SECONDS,
  description: "Approved worker runtime in seconds, 1..86400; new ordinary runs default to 86400. Waiting for human approval is separate and unbounded. Existing approved deadlines are never extended." });
export const VERIFY_TIMEOUT_MS = 30_000;
export const MAX_OUTPUT = 12_000;
export const DEFAULT_MAX_MODEL_CALLS = 6; // Restricted Goal/sequence compatibility; not the ordinary delegation default.
export const DEFAULT_DELEGATE_MODEL_CALLS = null;
export const MAX_WORKER_MODEL_CALLS = 12; // Retired Goal/manual budget-adviser compatibility, not an ordinary SDK stop.
export const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const closed = { additionalProperties: false } as const;
const nameSchema = Type.String({ pattern: AGENT_NAME_PATTERN, minLength: 1, maxLength: LIMITS.name });
const text = (maxLength: number) => Type.String({ pattern: "\\S", minLength: 1, maxLength });
const amount = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableMs = Type.Union([amount, Type.Null()]);
const reportedThinking = Type.Union([ThinkingSchema, Type.Literal("off"), Type.Literal("minimal")]);
const modelCallLimit = Type.Integer({ minimum: 1, maximum: 12, default: DEFAULT_MAX_MODEL_CALLS,
  description: "Worker SDK model calls, not HTTP attempts/tokens/cost. Restricted defaults remain 6; no automatic continuation at the limit." });
export const ModelCallLimitSchema = Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()], {
  description: "Omit or use null for SDK natural completion with no model-round count limit. A supplied positive integer is an exact finite limit, including tool feedback and final reporting. Native approval and the exact approved execution deadline still apply; no extension of an approved run." });
export const VerificationCommandSchema = Type.Object({
  command: Type.String({ pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]+$", minLength: 1, maxLength: 512 }),
  args: Type.Array(Type.String({ pattern: "^[^\\u0000]*$", maxLength: 1_024 }), { maxItems: 32 }),
  description: Type.Optional(text(512)),
}, closed);
export const DelegateInputSchema = Type.Object({
  task: Type.String({ pattern: "\\S", minLength: 1, maxLength: LIMITS.task, description: "English task summary prepared by the parent. Preserve quoted artifacts verbatim; never include secrets or conversation history." }),
  agents: Type.Array(nameSchema, { minItems: 1, maxItems: LIMITS.agents, uniqueItems: true }),
  skillCandidates: Type.Optional(SkillCandidatesSchema),
  verification: Type.Optional(VerificationCommandSchema),
  acceptanceCriteria: Type.Optional(CriteriaSchema),
  maxModelCalls: Type.Optional(ModelCallLimitSchema),
  seconds: Type.Optional(ExecutionSecondsSchema),
  solPi: Type.Optional(SolPiInputSchema),
  softRouting: Type.Optional(Type.Object({
    ...SoftRoutingSchema.properties,
    baseline: Type.Union([nameSchema, Type.Object({ agent: nameSchema, model: ModelSchema, thinking: Type.Optional(ThinkingSchema) }, closed)]),
  }, closed)),
}, closed);
export const AgentSchema = Type.Object({
  name: nameSchema, description: text(LIMITS.description), systemPrompt: text(8_000),
  tools: Type.Array(Type.String({ enum: ["read", "bash", "edit", "write", "grep", "find", "ls"] }), {
    minItems: 1, maxItems: 7, uniqueItems: true,
  }),
  model: ModelSchema, thinking: Type.Optional(ThinkingSchema), file: text(4_096),
}, closed);
export const AgentDefinitionSchema = Type.Object({ ...AgentSchema.properties, pool: Type.Optional(PoolSchema) }, closed);
export const RunSchema = Type.Object({
  task: text(LIMITS.task), cwd: text(4_096), agent: AgentSchema, model: ModelSchema, maxModelCalls: ModelCallLimitSchema,
  seconds: Type.Optional(ExecutionSecondsSchema),
  verification: Type.Optional(VerificationCommandSchema), acceptanceCriteria: Type.Optional(CriteriaSchema),
  solPi: Type.Optional(SolPiPreparedSchema),
}, closed);
// Retired workflows retain their separately approved finite accounting contract.
export const BoundedRunSchema = Type.Object({ ...RunSchema.properties, maxModelCalls: modelCallLimit,
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: RUN_TIMEOUT_MS / 1000 })) }, closed);
export type BoundedRun = Static<typeof BoundedRunSchema>;
export function executionSeconds(run: Pick<Run, "seconds">): number {
  return run.seconds ?? RUN_TIMEOUT_MS / 1000;
}
export function executionTimeoutMessage(run: Pick<Run, "seconds">): string {
  return `Subagent exceeded its ${executionSeconds(run)}-second time limit. Changes may be incomplete.`;
}
export const RunStatsSchema = Type.Object({
  turns: count,
  usage: Type.Object({ input: count, output: count, cacheRead: count, cacheWrite: count }, closed), cost: amount,
}, closed);
export const RunResultSchema = Type.Object({
  ...RunStatsSchema.properties, text: Type.String({ maxLength: MAX_OUTPUT }), truncated: Type.Boolean(),
}, closed);
export const WorkerReportSchema = Type.Object({
  startupMs: nullableMs, executionMs: nullableMs,
  solPi: Type.Optional(SolPiReportSchema),
  modelCalls: Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()]),
  rounds: Type.Optional(Type.Array(WorkerRoundSchema, { maxItems: MAX_RECORDED_WORKER_ROUNDS })),
  roundsCoverage: Type.Optional(WorkerRoundCoverageSchema),
  thinking: Type.Optional(Type.Object({ requested: reportedThinking, applied: Type.Union([reportedThinking, Type.Null()]) }, closed)),
  diagnostic: Type.Optional(Type.Object({
    category: Type.Union([
      Type.Literal("authentication"), Type.Literal("rate_limited"), Type.Literal("model_unavailable"),
      Type.Literal("unsupported_setting"), Type.Literal("request_rejected"), Type.Literal("provider_error"),
      Type.Literal("transport"), Type.Literal("cancelled"), Type.Literal("unknown"),
    ]),
    httpStatus: Type.Union([Type.Integer({ minimum: 100, maximum: 599 }), Type.Null()]),
    stage: Type.Optional(Type.Union([Type.Literal("input"), Type.Literal("model_loading"), Type.Literal("session_setup"), Type.Literal("extension_loading"),
      Type.Literal("model_request"), Type.Literal("model_response"), Type.Literal("internal_report"), Type.Literal("accounting"), Type.Literal("cleanup")])),
  }, closed)),
  accounting: Type.Union([
    Type.Object({ status: Type.Literal("not_started") }, closed),
    Type.Object({ status: Type.Literal("unknown") }, closed),
    Type.Object({ status: Type.Literal("reported"), stats: RunStatsSchema, complete: Type.Boolean() }, closed),
  ]),
}, closed);
export const WORKER_ERROR = "Subagent failed. Check its model, authentication, and task; no automatic retry was attempted.";
export const MODEL_CALL_LIMIT_ERROR = "Subagent reached its approved SDK model-call limit and needs another call. Changes remain; no verification, assessment, or automatic retry was attempted.";
export const WorkerReplySchema = Type.Union([
  Type.Object({ type: Type.Literal("completed"), result: RunResultSchema, report: WorkerReportSchema }, closed),
  Type.Object({ type: Type.Literal("failed"), error: Type.Union([Type.Literal(WORKER_ERROR), Type.Literal(MODEL_CALL_LIMIT_ERROR)]), report: WorkerReportSchema }, closed),
  Type.Object({ type: Type.Literal("cancel"), report: WorkerReportSchema }, closed),
]);
export const VerificationResultSchema = Type.Union([
  Type.Object({ status: Type.Literal("passed"), exitCode: Type.Literal(0) }, closed),
  Type.Object({ status: Type.Literal("failed"), exitCode: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]) }, closed),
  Type.Object({ status: Type.Literal("timed_out"), exitCode: Type.Null() }, closed),
]);

export type DelegateInput = Readonly<Static<typeof DelegateInputSchema>>;
export type Agent = Readonly<Static<typeof AgentSchema>>;
export type AgentDefinition = Readonly<Static<typeof AgentDefinitionSchema>>;
export type Run = Readonly<Static<typeof RunSchema>>;
export type RunResult = Readonly<Static<typeof RunResultSchema>>;
export type WorkerReport = Readonly<Static<typeof WorkerReportSchema>>;
export type WorkerReply = Static<typeof WorkerReplySchema>;
export type VerificationResult = Static<typeof VerificationResultSchema>;
export type Selection = ({ readonly source: "jev"; readonly plan?: string } & Decision)
  | (BaselineDecision & { readonly plan?: string }) | { readonly source: "direct"; readonly agent: string };
export type Job = { readonly input: DelegateInput; readonly cwd: string };
type Phase = "loading" | "routing" | "preparing_harness" | "awaiting_approval" | "running" | "verifying" | "awaiting_assessment_approval" | "judging";
type JevMetrics = { readonly status: "not_requested" | "unknown" }
  | ({ readonly status: "reported"; readonly requestedModel: string } & JevReport);
export type Metrics = {
  readonly elapsedMs: number;
  readonly phasesMs: Readonly<Partial<Record<Phase, number>>>;
  readonly profile: { readonly agent: string; readonly model: Run["model"]; readonly thinking?: Agent["thinking"]; readonly source: Selection["source"]; readonly maxModelCalls: number | null; readonly seconds?: number } | null;
  readonly jev: JevMetrics;
  readonly assessmentJev: JevMetrics;
  readonly worker: WorkerReport;
};
type Execution = { readonly run: Run; readonly decision: Selection; readonly result: RunResult };
type Checked = Execution & { readonly verification: VerificationResult | { readonly status: "not_requested" } };
type WorkflowState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly job: Job }
  | { readonly status: "routing"; readonly job: Job; readonly plans: readonly Plan[]; readonly router: RouteState }
  | { readonly status: "preparing_harness"; readonly run: Run; readonly decision: Selection; readonly options: SolPiInput }
  | { readonly status: "awaiting_approval" | "running"; readonly run: Run; readonly decision: Selection }
  | ({ readonly status: "verifying" } & Execution)
  | ({ readonly status: "awaiting_assessment_approval" | "judging"; readonly packet: AssessmentPacket } & Checked)
  | { readonly status: "succeeded" | "incomplete" | "needs_review"; readonly agent: string; readonly model: Run["model"];
      readonly decision: Selection; readonly result: RunResult; readonly verification: Checked["verification"]; readonly assessment: Assessment;
      readonly acceptanceCriteria?: readonly string[] }
  | { readonly status: "failed"; readonly error: string; readonly verification?: VerificationResult }
  | { readonly status: "cancelled"; readonly reason: "aborted" | "declined" };
export type State = WorkflowState & { readonly metrics: Metrics };
export type Event = (
  | { readonly type: "start"; readonly job: Job; readonly canConfirm: boolean }
  | { readonly type: "agents_loaded"; readonly agents: readonly AgentDefinition[]; readonly capabilities?: readonly Capability[] }
  | { readonly type: "resolved"; readonly decision: Decision }
  | { readonly type: "route_draw"; readonly purpose: "gate" | "selection"; readonly value: number }
  | { readonly type: "sol_prepared"; readonly prepared: SolPiPrepared; readonly now: number }
  | { readonly type: "approval"; readonly approved: boolean; readonly now?: number }
  | WorkerReply
  | { readonly type: "verified"; readonly result: VerificationResult }
  | { readonly type: "assessment_approval"; readonly approved: boolean }
  | { readonly type: "assessed"; readonly reply: AssessmentReply }
  | { readonly type: "assessment_failed" }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "cancel" }
) & {
  readonly report?: WorkerReport;
  readonly jev?: JevReport;
  readonly timing?: { readonly effectMs: number; readonly elapsedMs: number };
  readonly aborted?: boolean;
};
export type Effect =
  | { readonly type: "load_agents"; readonly names: readonly string[]; readonly needsAssessment?: boolean }
  | RouteEffect
  | { readonly type: "prepare_sol"; readonly run: Run; readonly options: SolPiInput }
  | { readonly type: "confirm_run"; readonly run: Run; readonly selection?: Selection }
  | { readonly type: "run_agent"; readonly run: Run }
  | { readonly type: "verify"; readonly cwd: string; readonly command: Static<typeof VerificationCommandSchema> }
  | { readonly type: "confirm_assessment"; readonly packet: AssessmentPacket }
  | { readonly type: "assess"; readonly packet: AssessmentPacket };
export type Transition = { readonly state: State; readonly effects: readonly Effect[] };
type Step = { readonly state: WorkflowState; readonly effects: readonly Effect[] };

export function initialState(): State {
  return { status: "idle", metrics: {
    elapsedMs: 0, phasesMs: {}, profile: null, jev: { status: "not_requested" }, assessmentJev: { status: "not_requested" },
    worker: { startupMs: null, executionMs: null, modelCalls: 0, accounting: { status: "not_started" } },
  } };
}
function approve(job: Job, agent: Agent, decision: Selection): Step {
  const run = { task: job.input.task, cwd: job.cwd, agent, model: agent.model,
    maxModelCalls: job.input.maxModelCalls ?? (job.input.solPi ? MAX_WORKER_MODEL_CALLS : DEFAULT_DELEGATE_MODEL_CALLS),
    seconds: job.input.solPi ? RUN_TIMEOUT_MS / 1000 : job.input.seconds ?? DEFAULT_RUN_SECONDS,
    ...(job.input.verification ? { verification: job.input.verification } : {}),
    ...(job.input.acceptanceCriteria ? { acceptanceCriteria: job.input.acceptanceCriteria } : {}) };
  if (!Value.Check(RunSchema, run)) return { state: { status: "failed", error: "Invalid subagent execution plan." }, effects: [] };
  if (job.input.solPi) return { state: { status: "preparing_harness", run, decision, options: job.input.solPi },
    effects: [{ type: "prepare_sol", run, options: job.input.solPi }] };
  return { state: { status: "awaiting_approval", run, decision }, effects: [{ type: "confirm_run", run,
    ...("softRouting" in decision ? { selection: decision } : {}) }] };
}
function routed(job: Job, plans: readonly Plan[], transition: RouteTransition): Step {
  const router = transition.state;
  if (router.status === "failed") return { state: { status: "failed", error: router.error }, effects: [] };
  if (router.status === "cancelled") return { state: { status: "cancelled", reason: "aborted" }, effects: [] };
  if (router.status !== "succeeded") return { state: { status: "routing", job, plans, router }, effects: transition.effects };
  const decision = router.decision;
  const plan = plans.find((candidate) => candidate.id === decision.agent);
  if (!plan) return { state: { status: "failed", error: "JEV selected a plan outside the supplied candidates." }, effects: [] };
  const selected = { agent: plan.agent.name, ...(plan.id !== plan.agent.name ? { plan: plan.id } : {}) };
  return approve(job, plan.agent, decision.source === "baseline" ? { ...decision, ...selected }
    : { ...decision, ...selected, source: "jev" });
}
function finish(checked: Checked, assessment: Assessment): Step {
  return { state: {
    status: assessment.status === "incomplete" ? "incomplete" : assessment.status === "needs_review" ? "needs_review" : "succeeded",
    agent: checked.run.agent.name, model: checked.run.model, decision: checked.decision,
    result: checked.result, verification: checked.verification, assessment,
    ...(checked.run.acceptanceCriteria ? { acceptanceCriteria: checked.run.acceptanceCriteria } : {}),
  }, effects: [] };
}
function afterExecution(checked: Checked): Step {
  const { run, result, verification } = checked;
  if (!run.acceptanceCriteria) return finish(checked, { status: "not_requested" });
  if (verification.status !== "passed" || !run.verification?.description) {
    return finish(checked, { status: "needs_review", reason: "Independent verification and its declared coverage are required for completion assessment." });
  }
  if (result.truncated || !result.text.trim() || result.text.length > MAX_REVIEW_SUMMARY) {
    return finish(checked, { status: "needs_review", reason: "Worker summary is missing, truncated, or too large; no assessment data was sent." });
  }
  const packet = { task: run.task, criteria: run.acceptanceCriteria, workerClaim: result.text,
    verification: { status: "passed" as const, description: run.verification.description } };
  if (!Value.Check(AssessmentPacketSchema, packet)) {
    return finish(checked, { status: "needs_review", reason: "Invalid assessment evidence; nothing was sent." });
  }
  return { state: { status: "awaiting_assessment_approval", ...checked, packet }, effects: [{ type: "confirm_assessment", packet }] };
}
function step(state: State, event: Event): Step {
  const unchanged = { state, effects: [] };
  const fail = (error: string): Step => ({ state: { status: "failed", error }, effects: [] });
  if (event.type === "cancel" || event.aborted) return { state: { status: "cancelled", reason: "aborted" }, effects: [] };
  if (event.type === "failed" && state.status !== "idle") {
    return state.status === "judging" || state.status === "awaiting_assessment_approval"
      ? finish(state, { status: "needs_review", reason: "Completion assessment failed; execution is not certified complete." }) : fail(event.error);
  }
  switch (state.status) {
    case "idle": {
      if (event.type !== "start") return unchanged;
      if (!event.canConfirm) return fail("Interactive approval is required; no routing or agent execution was attempted.");
      if (!Value.Check(DelegateInputSchema, event.job.input)) return fail("Invalid task, candidate names, verification command, acceptance criteria, or model-call limit.");
      if (!englishModelData({ task: event.job.input.task, criteria: event.job.input.acceptanceCriteria, verificationDescription: event.job.input.verification?.description })) return fail(INTERNAL_LANGUAGE_ERROR);
      if (event.job.input.skillCandidates !== undefined && !validSkills(event.job.input.skillCandidates)) return fail("Invalid explicit English skill metadata; no discovery or execution.");
      // Own nested criteria/argv across awaits; caller mutations must not change approved work.
      if (event.job.input.solPi && (!validSolOptions(event.job.input.solPi) || event.job.input.agents.length !== 1 || event.job.input.softRouting || event.job.input.maxModelCalls === null || (event.job.input.maxModelCalls ?? 1) > MAX_WORKER_MODEL_CALLS || (event.job.input.seconds !== undefined && event.job.input.seconds !== RUN_TIMEOUT_MS / 1000))) return fail(SOL_ERROR);
      const job = { cwd: event.job.cwd, input: structuredClone(event.job.input) };
      return { state: { status: "loading", job }, effects: [{ type: "load_agents", names: job.input.agents,
        ...(job.input.acceptanceCriteria ? { needsAssessment: true } : {}) }] };
    }
    case "loading": {
      if (event.type !== "agents_loaded") return unchanged;
      if (event.agents.length !== state.job.input.agents.length ||
        !event.agents.every((agent, i) => Value.Check(AgentDefinitionSchema, agent) && agent.name === state.job.input.agents[i]) ||
        !Value.Check(Type.Array(CapabilitySchema, { maxItems: 128 }), event.capabilities ?? [])) {
        return fail("Loaded agents and model capabilities must match the explicit candidate policy.");
      }
      if (!event.agents.every(agent => englishProse(agent.description) && englishProse(agent.systemPrompt))) return fail(INTERNAL_LANGUAGE_ERROR);
      if (state.job.input.solPi && event.agents.some(agent => agent.pool || agent.model.provider !== "openai-codex" ||
          agent.model.id !== "gpt-5.6-sol" || !agent.thinking || state.job.input.solPi!.actionFusion &&
          !["bash", "edit", "write"].every(tool => agent.tools.includes(tool)))) return fail(SOL_ERROR);
      const plans = buildPlans(structuredClone(event.agents), structuredClone(event.capabilities ?? []));
      if (!plans.length) return fail("No supported execution plans, or the 128-plan limit was exceeded.");
      const policy = state.job.input.softRouting;
      const base = policy?.baseline;
      const matches = base === undefined ? [] : plans.filter(({ agent }) => typeof base === "string" ? agent.name === base
        : agent.name === base.agent && agent.model.provider === base.model.provider && agent.model.id === base.model.id && agent.thinking === base.thinking);
      if (policy && matches.length !== 1) return fail("Soft routing requires exactly one permitted baseline plan. Specify a fixed role or exact agent/model/thinking tuple; no automatic substitute.");
      const only = plans.length === 1 ? plans[0] : undefined;
      if (only) return approve(state.job, only.agent, { source: "direct", agent: only.agent.name });
      return routed(state.job, plans, reduceRoute({ status: "idle" }, { type: "route_plans", request: {
        task: workerPrompt(state.job.input), agents: plans.map((plan) => ({ name: plan.id, description: plan.description })),
        ...(policy ? { softRouting: { ...policy, baseline: matches[0]!.id } } : {}),
        ...(state.job.input.skillCandidates ? { skillCandidates: state.job.input.skillCandidates } : {}),
      } }));
    }
    case "routing": {
      if (event.type !== "resolved" && event.type !== "route_draw") return unchanged;
      const transition = reduceRoute(state.router, event);
      return transition.state === state.router ? unchanged : routed(state.job, state.plans, transition);
    }
    case "preparing_harness": {
      if (event.type !== "sol_prepared") return unchanged;
      if (!Value.Check(SolPiPreparedSchema, event.prepared) || solHash(event.prepared.options) !== solHash(state.options) ||
          event.prepared.runDigest !== solHash(state.run) || !Number.isSafeInteger(event.now) || event.now < event.prepared.preparedAt ||
          event.prepared.approvalDeadline !== event.prepared.preparedAt + 60_000 || event.now >= event.prepared.approvalDeadline) return fail(SOL_ERROR);
      const run = { ...state.run, solPi: structuredClone(event.prepared) };
      return { state: { status: "awaiting_approval", run, decision: state.decision }, effects: [{ type: "confirm_run", run }] };
    }
    case "awaiting_approval":
      if (event.type !== "approval") return unchanged;
      if (state.run.solPi && (!Number.isSafeInteger(event.now) || event.now! < state.run.solPi.preparedAt || event.now! >= state.run.solPi.approvalDeadline)) {
        return { state: { status: "cancelled", reason: "declined" }, effects: [] };
      }
      return event.approved === true ? { state: { ...state, status: "running" }, effects: [{ type: "run_agent", run: state.run }] }
        : { state: { status: "cancelled", reason: "declined" }, effects: [] };
    case "running":
      if (event.type !== "completed") return unchanged;
      if (!Value.Check(RunResultSchema, event.result)) return fail("Invalid subagent result.");
      if (!Value.Check(WorkerReportSchema, event.report)) return fail("Invalid worker accounting.");
      if (event.report.modelCalls === null || event.report.modelCalls < 1 || state.run.maxModelCalls !== null && event.report.modelCalls > state.run.maxModelCalls) {
        return fail("Invalid worker model-call count for the approved limit.");
      }
      if (state.run.solPi && (!solReportComplete(state.run, event.report) || event.report.solPi?.lockRetained)) return fail(SOL_ERROR);
      if (state.run.agent.thinking && (event.report?.thinking?.requested !== state.run.agent.thinking ||
          event.report.thinking.applied !== state.run.agent.thinking)) return fail("Worker thinking did not match the approved plan.");
      if (state.run.verification) return {
        state: { status: "verifying", run: state.run, decision: state.decision, result: structuredClone(event.result) },
        effects: [{ type: "verify", cwd: state.run.cwd, command: state.run.verification }],
      };
      return afterExecution({ run: state.run, decision: state.decision, result: structuredClone(event.result), verification: { status: "not_requested" } });
    case "verifying":
      if (event.type !== "verified") return unchanged;
      if (!Value.Check(VerificationResultSchema, event.result)) return fail("Invalid verification result.");
      return event.result.status === "passed" ? afterExecution({ run: state.run, decision: state.decision, result: state.result, verification: structuredClone(event.result) })
        : { state: { status: "failed", error: "Verification failed or timed out. Changes remain; no automatic retry or rollback.", verification: structuredClone(event.result) }, effects: [] };
    case "awaiting_assessment_approval":
      if (event.type !== "assessment_approval") return unchanged;
      return event.approved ? { state: { ...state, status: "judging" }, effects: [{ type: "assess", packet: state.packet }] }
        : finish(state, { status: "needs_review", reason: "Assessment transmission declined; no completion data was sent." });
    case "judging": {
      if (event.type === "assessment_failed") return finish(state, { status: "needs_review", reason: "JEV assessment unavailable; no automatic retry." });
      if (event.type !== "assessed") return unchanged;
      if (!Value.Check(AssessmentReplySchema, event.reply) || event.reply.judgments.length !== state.packet.criteria.length) {
        return finish(state, { status: "needs_review", reason: "Invalid or incomplete JEV assessment." });
      }
      try {
        for (const item of event.reply.judgments) readChoice({ type: "choice", choice: item.verdict,
          confidence: item.confidence, ...(item.probabilities ? { probabilities: item.probabilities } : {}) }, ["met", "unmet", "unknown"]);
      } catch { return finish(state, { status: "needs_review", reason: "Invalid JEV assessment probabilities; no automatic rework." }); }
      const judgments = structuredClone(event.reply.judgments);
      return judgments.some((item) => item.verdict === "unmet") ? finish(state, { status: "incomplete", judgments })
        : judgments.some((item) => item.verdict === "unknown") ? finish(state, { status: "needs_review", reason: "Evidence was insufficient or conflicting.", judgments })
        : finish(state, { status: "complete", judgments });
    }
    case "succeeded": case "incomplete": case "needs_review": case "failed": case "cancelled": return unchanged;
    default:
      state satisfies never;
      throw new Error("Unhandled delegation state.");
  }
}
export function reduce(state: State, event: Event): Transition {
  if (state.status === "succeeded" || state.status === "incomplete" || state.status === "needs_review" ||
      state.status === "failed" || state.status === "cancelled") return { state, effects: [] };
  const next = step(state, event);
  if (next.state === state) return { state, effects: [] };
  let metrics = state.metrics;
  const timing = event.timing;
  if (timing && Number.isFinite(timing.effectMs) && timing.effectMs >= 0 &&
      Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= metrics.elapsedMs && state.status !== "idle") {
    metrics = { ...metrics, elapsedMs: timing.elapsedMs, phasesMs: { ...metrics.phasesMs,
      [state.status]: (metrics.phasesMs[state.status] ?? 0) + timing.effectMs } };
  }
  const jev = event.type === "resolved" ? reportData(event.decision) : event.jev;
  if (state.status === "routing" && state.router.status === "routing" && jev && Value.Check(JevReportSchema, jev)) {
    metrics = { ...metrics, jev: { status: "reported", requestedModel: JEV_MODEL, ...structuredClone(jev) } };
  }
  if (state.status === "judging" && event.jev && Value.Check(JevReportSchema, event.jev)) {
    metrics = { ...metrics, assessmentJev: { status: "reported", requestedModel: JEV_MODEL, ...structuredClone(event.jev) } };
  }
  if (state.status === "judging" && event.type === "assessed" && Value.Check(AssessmentReplySchema, event.reply)) {
    metrics = { ...metrics, assessmentJev: { status: "reported", requestedModel: event.reply.requestedModel ?? JEV_MODEL, ...structuredClone(reportData(event.reply)!) } };
  }
  if (state.status === "running" && Value.Check(WorkerReportSchema, event.report)) {
    metrics = { ...metrics, worker: structuredClone(event.report) };
  }
  if (next.state.status === "awaiting_approval") metrics = { ...metrics, profile: {
    agent: next.state.run.agent.name, model: next.state.run.model, source: next.state.decision.source, maxModelCalls: next.state.run.maxModelCalls, seconds: executionSeconds(next.state.run),
    ...(next.state.run.agent.thinking ? { thinking: next.state.run.agent.thinking } : {}),
  } };
  if (next.effects.some((effect) => effect.type === "call_jev")) metrics = { ...metrics, jev: { status: "unknown" } };
  if (next.effects.some((effect) => effect.type === "assess")) metrics = { ...metrics, assessmentJev: { status: "unknown" } };
  if (next.effects.some((effect) => effect.type === "run_agent")) {
    metrics = { ...metrics, worker: { startupMs: null, executionMs: null, modelCalls: null, accounting: { status: "unknown" } } };
  }
  return { state: { ...next.state, metrics }, effects: next.effects };
}

export type WorkerState = { readonly modelCalls: number; readonly maxModelCalls: number | null } & (
  | { readonly status: "running" }
  | { readonly status: "succeeded" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: "worker_error" | "model_call_limit" }
);
export type WorkerEvent =
  | { readonly type: "model_call" }
  | { readonly type: "turn_end"; readonly stopReason: string; readonly hasToolCalls: boolean }
  | { readonly type: "failed" }
  | { readonly type: "cancel" };
export type WorkerEffect = { readonly type: "stop" };
// The isolated SDK loop calls the stop hook after tools and before any next model call.
export function reduceWorker(state: WorkerState, event: WorkerEvent): { state: WorkerState; effects: readonly WorkerEffect[] } {
  const unchanged = { state, effects: [] };
  if (state.status !== "running") return unchanged;
  if (event.type === "model_call") {
    if (!Number.isSafeInteger(state.modelCalls) || state.modelCalls < 0 || state.modelCalls >= Number.MAX_SAFE_INTEGER)
      return { state: { ...state, status: "failed", reason: "worker_error" }, effects: [{ type: "stop" }] };
    return state.maxModelCalls !== null && state.modelCalls >= state.maxModelCalls
      ? { state: { ...state, status: "failed", reason: "model_call_limit" }, effects: [{ type: "stop" }] }
      : { state: { ...state, modelCalls: state.modelCalls + 1 }, effects: [] };
  }
  const stop = (next: WorkerState) => ({ state: next, effects: [{ type: "stop" as const }] });
  if (event.type === "cancel") return stop({ ...state, status: "cancelled" });
  if (event.type === "failed" || ["error", "aborted"].includes(event.stopReason)) {
    return stop({ ...state, status: "failed", reason: "worker_error" });
  }
  if (event.hasToolCalls) return state.maxModelCalls === null || state.modelCalls < state.maxModelCalls ? unchanged
    : stop({ ...state, status: "failed", reason: "model_call_limit" });
  return event.stopReason === "stop" ? stop({ ...state, status: "succeeded" })
    : stop({ ...state, status: "failed", reason: "worker_error" });
}

// List-price/SDK estimates, not invoices. Parent pi usage is outside this invocation.
export function estimateCost(metrics: Metrics) {
  const jevCost = (metric: JevMetrics) => metric.status === "not_requested" ? 0 : metric.status === "reported"
    ? estimateJevUsd(metric.usage, metric.provider) : null;
  const routingJevUsd = jevCost(metrics.jev), assessmentJevUsd = jevCost(metrics.assessmentJev);
  const jevUsd = routingJevUsd === null || assessmentJevUsd === null ? null : routingJevUsd + assessmentJevUsd;
  const worker = metrics.worker.accounting;
  const observedWorkerUsd = worker.status === "reported" ? worker.stats.cost : 0;
  const workerUsd = worker.status === "not_started" ? 0 : worker.status === "reported" && worker.complete ? worker.stats.cost : null;
  return { routingJevUsd, assessmentJevUsd, jevUsd, workerUsd,
    observedUsd: (routingJevUsd ?? 0) + (assessmentJevUsd ?? 0) + observedWorkerUsd,
    delegationTotalUsd: jevUsd === null || workerUsd === null ? null : jevUsd + workerUsd };
}

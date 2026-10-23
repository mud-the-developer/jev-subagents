import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AGENT_NAME_PATTERN, LIMITS, type RouteRequest } from "./machine.ts";
import { SkillCandidatesSchema, validSkills } from "./skill-suggestion.ts";
import { AgentSchema, ModelCallLimitSchema, ExecutionSecondsSchema, type Agent } from "./delegate-machine.ts";
import { GoalFileScopeSchema, goalFileDigest, validGoalFilePath, validGoalFileScope, type GoalFileScope } from "./goal-files.ts";
import { englishModelData } from "./internal-language.ts";
import { PlanGraphSchema, evaluatePlanGraph, maximumGraphTasks, validPlanGraph, type PlanGraphEvent } from "./plan-graph.ts";
import { MemorySnapshotSchema, memoryProjectKey, validMemorySnapshot } from "./project-memory.ts";
import { DelegationMemorySourceSchema, validDelegationMemorySource } from "./delegation-memory.ts";

// First migration stage: a single job, never a reusable session permission.
// These types are NOT tool parameters or a way to restore execution authority.
const closed = { additionalProperties: false } as const;
const name = Type.String({ pattern: AGENT_NAME_PATTERN, minLength: 1, maxLength: LIMITS.name });
const id = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
export const OrdinaryScopeInputSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: LIMITS.task }),
  agents: Type.Array(name, { minItems: 1, maxItems: 8, uniqueItems: true }),
  files: Type.Array(Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }),
    access: Type.Union([Type.Literal("read"), Type.Literal("read_write")]) }, closed), { minItems: 1, maxItems: 16 }),
  tasks: Type.Array(Type.Object({ id, summary: Type.String({ minLength: 1, maxLength: LIMITS.task }), agent: Type.Optional(name),
    after: Type.Optional(Type.Array(id, { maxItems: 2, uniqueItems: true, description: "Dependencies must be earlier stage IDs. Ordered DAG stages execute sequentially; cycles and forward references are rejected." })),
    alternatives: Type.Optional(Type.Array(Type.Object({ id, summary: Type.String({ minLength: 1, maxLength: LIMITS.task }),
      description: Type.String({ minLength: 1, maxLength: 256, description: "Explicit non-sensitive English selection rubric for JEV; not the worker input or raw source." }), agent: Type.Optional(name) }, closed),
      { minItems: 2, maxItems: 2, description: "Exactly two preapproved mutually exclusive A/B variants. Requires parent_or_jev. Select once after approval; failure never retries the other variant." })),
  }, closed), { minItems: 1, maxItems: 3 }),
  selection: Type.Union([Type.Literal("parent_only"), Type.Literal("parent_or_jev")]),
  skillCandidates: Type.Optional(SkillCandidatesSchema),
  memorySnapshot: Type.Optional(MemorySnapshotSchema),
  limits: Type.Object({ workerRuns: Type.Integer({ minimum: 1, maximum: 3 }), modelCalls: Type.Optional(ModelCallLimitSchema),
    perWorkerCalls: Type.Optional(ModelCallLimitSchema), seconds: ExecutionSecondsSchema }, closed),
}, closed);
export type OrdinaryScopeInput = Static<typeof OrdinaryScopeInputSchema>;
/** Separate closed public graph input; legacy scope properties and limits stay unchanged. */
export const OrdinaryGraphInputSchema = Type.Object({
  ...OrdinaryScopeInputSchema.properties,
  tasks: Type.Array(Type.Object({ id, summary: Type.String({ minLength: 1, maxLength: LIMITS.task }), agent: Type.Optional(name) }, closed), { maxItems: 16 }),
  plan: PlanGraphSchema,
}, closed);
export type OrdinaryGraphInput = Omit<Static<typeof OrdinaryGraphInputSchema>, "tasks"> & {
  tasks: (Static<typeof OrdinaryGraphInputSchema>["tasks"][number] & { after?: never; alternatives?: never })[];
};
export type OrdinaryInput = OrdinaryScopeInput | OrdinaryGraphInput;
export const OrdinaryPreparedSchema = Type.Object({ id, sessionId: Type.String({ minLength: 1, maxLength: 128 }), input: Type.Union([OrdinaryScopeInputSchema, OrdinaryGraphInputSchema]),
  agents: Type.Array(AgentSchema, { minItems: 1, maxItems: 8 }), files: GoalFileScopeSchema,
  contextDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  memory: Type.Optional(DelegationMemorySourceSchema),
  routingTarget: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  workerTargets: Type.Array(Type.Object({ agent: name, api: Type.String({ minLength: 1, maxLength: 128 }),
    endpoint: Type.String({ minLength: 1, maxLength: 2048 }) }, closed), { minItems: 1, maxItems: 8 }),
  fileProtocol: Type.Literal("scoped_existing_files"), approvalDeadline: Type.Null() }, closed);
export type OrdinaryPreparedScope = Omit<Static<typeof OrdinaryPreparedSchema>, "input"> & { input: OrdinaryInput };
export type OrdinarySelection = { readonly agent: string; readonly source: "parent" | "jev"; readonly alternativeId?: string };
export type OrdinaryObservation = { readonly outcome: "completed" | "failed" | "cancelled"; readonly modelCalls: number | null;
  readonly accountingComplete: boolean; readonly cleanupConfirmed: boolean; readonly files: GoalFileScope | null };
type History = { readonly taskId: string; readonly selection: OrdinarySelection; readonly observation: OrdinaryObservation };
type Ledger = { readonly startedWorkers: number; readonly spentCalls: number; readonly reservedCalls: number | null; readonly history: readonly History[] };
type Active = Ledger & { readonly grant: OrdinaryPreparedScope; readonly files: GoalFileScope; readonly digest: string; readonly index: number;
  readonly expiresAt: number; readonly now: number; readonly graphEvents?: readonly PlanGraphEvent[]; readonly nodeId?: string };
type Selected = Active & { readonly selection: OrdinarySelection; readonly calls: number | null };
export type OrdinaryAuthorizationState =
  | { readonly phase: "idle" }
  | { readonly phase: "preparing"; readonly input: OrdinaryInput; readonly sessionId: string; readonly now: number }
  | { readonly phase: "awaiting_approval"; readonly grant: OrdinaryPreparedScope; readonly digest: string; readonly now: number }
  | (Active & { readonly phase: "selecting" })
  | (Selected & { readonly phase: "checking" | "running" })
  | (Active & { readonly phase: "finished" })
  | (Ledger & { readonly phase: "revoked"; readonly reason: "invalid" | "declined" | "cancelled" | "changed" | "expired" | "budget" | "failed" | "unknown" | "undecided";
      readonly cleanupPending: boolean; readonly id?: string; readonly graphEvents?: readonly PlanGraphEvent[]; readonly nodeId?: string; readonly selection?: OrdinarySelection; readonly pending?: { readonly id: string; readonly taskId: string; readonly selection: OrdinarySelection; readonly observed: boolean } });
export type OrdinaryAuthorizationEvent =
  | { readonly type: "start"; readonly input: unknown; readonly sessionId: string; readonly now: number }
  | { readonly type: "prepared"; readonly grant: OrdinaryPreparedScope; readonly now: number }
  | { readonly type: "approval"; readonly id: string; readonly digest: string; readonly approved: boolean; readonly now: number }
  | { readonly type: "selected"; readonly id: string; readonly taskId: string; readonly selection: OrdinarySelection; readonly now: number }
  | { readonly type: "branch_selected"; readonly id: string; readonly nodeId: string; readonly choiceId: string; readonly confidence: number; readonly now: number }
  | { readonly type: "fresh"; readonly id: string; readonly taskId: string; readonly sessionId: string; readonly digest: string; readonly current: boolean; readonly now: number }
  | { readonly type: "observed"; readonly id: string; readonly taskId: string; readonly observation: OrdinaryObservation; readonly now: number }
  | { readonly type: "stop"; readonly reason: "cancelled" | "changed" | "failed"; readonly now: number }
  | { readonly type: "cleanup"; readonly id: string; readonly confirmed: boolean };
export type OrdinaryAuthorizationEffect =
  | { readonly type: "prepare"; readonly input: OrdinaryInput; readonly sessionId: string }
  | { readonly type: "confirm_scope"; readonly grant: OrdinaryPreparedScope; readonly digest: string }
  | { readonly type: "select_worker"; readonly id: string; readonly taskId: string }
  | { readonly type: "select_branch"; readonly id: string; readonly nodeId: string }
  | { readonly type: "check_current"; readonly id: string; readonly taskId: string; readonly digest: string; readonly files: GoalFileScope }
  | { readonly type: "run_worker"; readonly id: string; readonly taskId: string; readonly agent: Agent; readonly maxModelCalls: number | null;
      readonly files: GoalFileScope; readonly deadline: number }
  | { readonly type: "abort_worker" };
export type OrdinaryAuthorizationStep = { readonly state: OrdinaryAuthorizationState; readonly effects: readonly OrdinaryAuthorizationEffect[] };
const empty: Ledger = { startedWorkers: 0, spentCalls: 0, reservedCalls: 0, history: [] };
const safeClock = (value: number) => Number.isSafeInteger(value) && value > 0;
const taskId = (state: Active) => state.nodeId ?? state.grant.input.tasks[state.index]!.id;
const done = (state: OrdinaryAuthorizationState): OrdinaryAuthorizationStep => ({ state, effects: [] });

export function validOrdinaryScopeInput(input: unknown): input is OrdinaryScopeInput {
  if (!Value.Check(OrdinaryScopeInputSchema, input)) return false;
  return (input.memorySnapshot === undefined || validMemorySnapshot(input.memorySnapshot)) &&
    englishModelData({ task: input.task, tasks: input.tasks.map(task => [task.summary, ...(task.alternatives ?? []).flatMap(choice => [choice.summary, choice.description])]) }) &&
    input.task.trim().length > 0 && input.tasks.every((task, index) => task.summary.trim().length > 0 && (!task.agent || input.agents.includes(task.agent)) &&
      (task.after ?? []).every(dependency => input.tasks.slice(0, index).some(prior => prior.id === dependency)) &&
      (!task.alternatives || input.selection === "parent_or_jev" && new Set(task.alternatives.map(choice => choice.id)).size === 2 &&
        task.alternatives.every(choice => choice.summary.trim().length > 0 && choice.description.trim().length > 0 &&
          (!choice.agent || input.agents.includes(choice.agent) && (!task.agent || choice.agent === task.agent))))) &&
    input.files.every(file => validGoalFilePath(file.path)) && new Set(input.files.map(file => file.path)).size === input.files.length &&
    new Set(input.tasks.map(task => task.id)).size === input.tasks.length && input.tasks.length <= input.limits.workerRuns &&
    (input.skillCandidates === undefined || validSkills(input.skillCandidates)) &&
    (input.selection !== "parent_only" || input.agents.length === 1 || input.tasks.every(task => task.agent));
}
export function validOrdinaryGraphInput(input: unknown): input is OrdinaryGraphInput {
  try {
    if (!Value.Check(OrdinaryGraphInputSchema, input) || !validPlanGraph(input.plan, input.tasks.map(task => task.id))) return false;
    const choices = input.plan.nodes.filter(node => node.kind === "choice");
    return (input.memorySnapshot === undefined || validMemorySnapshot(input.memorySnapshot)) && englishModelData({ task: input.task, tasks: input.tasks.map(task => task.summary),
      choices: choices.map(node => [node.summary, ...node.choices.map(option => option.description)]) }) &&
      input.task.trim().length > 0 && input.tasks.every(task => task.summary.trim().length > 0 && (!task.agent || input.agents.includes(task.agent))) &&
      input.files.every(file => validGoalFilePath(file.path)) && new Set(input.files.map(file => file.path)).size === input.files.length &&
      maximumGraphTasks(input.plan) <= input.limits.workerRuns &&
      (choices.length === 0 || input.selection === "parent_or_jev") &&
      (input.skillCandidates === undefined || validSkills(input.skillCandidates)) &&
      (input.selection !== "parent_only" || input.agents.length === 1 || input.tasks.every(task => task.agent)) &&
      ordinaryRoutingMaximum(input) <= 16;
  } catch { return false; }
}
export function validOrdinaryInput(input: unknown): input is OrdinaryInput {
  return validOrdinaryGraphInput(input) || validOrdinaryScopeInput(input);
}
export function ordinaryRoutingTasks(input: OrdinaryInput) {
  return input.tasks.filter(task => task.alternatives || !task.agent && input.agents.length > 1);
}
/** Conservative approved upper bound, including choices on paths that may be skipped. */
export function ordinaryRoutingMaximum(input: OrdinaryInput): number {
  return ordinaryRoutingTasks(input).length + ("plan" in input ? input.plan.nodes.filter(node => node.kind === "choice").length : 0);
}
/** Reviewed prose plus bounded code-owned observations only; never worker text or file snapshots. */
export function ordinaryBranchPlan(scope: OrdinaryPreparedScope, nodeId: string, events: readonly PlanGraphEvent[] = [], history: readonly History[] = []): RouteRequest | null {
  if (!("plan" in scope.input) || scope.input.selection !== "parent_or_jev" || !scope.routingTarget) return null;
  const node = scope.input.plan.nodes.find(node => node.id === nodeId);
  if (node?.kind !== "choice") return null;
  return { task: JSON.stringify({ summary: node.summary,
    previousGraph: events.slice(0, 16).map(event => event.type === "choice"
      ? { type: "choice", nodeId: event.nodeId, choiceId: event.choiceId } : { type: "task", nodeId: event.nodeId }),
    outcomes: history.slice(0, 3).map(entry => ({ id: entry.taskId, agent: entry.selection.agent, outcome: entry.observation.outcome,
      modelCalls: entry.observation.modelCalls, accountingComplete: entry.observation.accountingComplete, cleanupConfirmed: entry.observation.cleanupConfirmed })) }),
    agents: node.choices.map(option => ({ name: option.id, description: option.description })) };
}
export function ordinarySelectionPlan(scope: OrdinaryPreparedScope, taskId: string, history: readonly History[] = []):
  { readonly source: "parent"; readonly agent: string } | { readonly source: "jev"; readonly request: RouteRequest;
    readonly choices: readonly { readonly id: string; readonly agent: string; readonly alternativeId?: string }[] } | null {
  const task = scope.input.tasks.find(task => task.id === taskId);
  if (!task) return null;
  const agent = task.agent ?? (scope.agents.length === 1 ? scope.agents[0]!.name : undefined);
  if (agent && !task.alternatives) return { source: "parent", agent };
  if (scope.input.selection !== "parent_or_jev" || !scope.routingTarget) return null;
  const options = task.alternatives ? task.alternatives.flatMap((alternative, alternativeIndex) => scope.agents
    .filter(candidate => candidate.name === (alternative.agent ?? task.agent ?? candidate.name))
    .map(candidate => ({ id: `choice_${alternativeIndex}_${scope.agents.indexOf(candidate)}`, agent: candidate.name,
      alternativeId: alternative.id, description: JSON.stringify({ alternative: alternative.description, role: candidate.description,
        model: candidate.model, thinking: candidate.thinking ?? "off", performance: "Not benchmarked." }) })))
    : scope.agents.map(candidate => ({ id: candidate.name, agent: candidate.name, description: candidate.description }));
  return { source: "jev", choices: options.map(({ description: _description, ...choice }) => choice),
    request: { task: task.alternatives ? JSON.stringify({ task: task.summary,
      previousStages: history.map(entry => ({ id: entry.taskId, agent: entry.selection.agent,
        alternative: entry.selection.alternativeId ?? null, outcome: entry.observation.outcome,
        modelCalls: entry.observation.modelCalls, accountingComplete: entry.observation.accountingComplete,
        cleanupConfirmed: entry.observation.cleanupConfirmed })) }) : task.summary,
      agents: options.map(({ id: name, description }) => ({ name, description })),
      ...(scope.input.skillCandidates ? { skillCandidates: scope.input.skillCandidates } : {}) } };
}
/** Fingerprint/correlation only, never a signature or execution permission. */
export function ordinaryScopeDigest(grant: OrdinaryPreparedScope): string { return goalFileDigest(JSON.stringify(grant)); }
export function validOrdinaryPreparedScope(grant: unknown): grant is OrdinaryPreparedScope {
  return Value.Check(OrdinaryPreparedSchema, grant) && validOrdinaryInput(grant.input) && validGoalFileScope(grant.files) &&
    (grant.input.memorySnapshot === undefined || validMemorySnapshot(grant.input.memorySnapshot, memoryProjectKey(grant.files.root))) &&
    (grant.memory === undefined || grant.input.memorySnapshot === undefined && grant.routingTarget !== null && validDelegationMemorySource(grant.memory, memoryProjectKey(grant.files.root))) &&
    isDeepStrictEqual(grant.input.files, grant.files.files.map(({ path, access }) => ({ path, access }))) &&
    isDeepStrictEqual([...grant.input.agents].sort(), grant.agents.map(agent => agent.name).sort()) &&
    grant.agents.every(agent => agent.tools.every(tool => ["read", "edit", "write"].includes(tool))) &&
    englishModelData(grant.agents.map(({ description, systemPrompt }) => ({ description, systemPrompt }))) &&
    isDeepStrictEqual(grant.agents.map(agent => agent.name), grant.workerTargets.map(target => target.agent)) &&
    grant.workerTargets.every(target => { try {
      const url = new URL(target.endpoint);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
    } catch { return false; } }) &&
    (grant.routingTarget === null || englishModelData({ routingTarget: grant.routingTarget })) &&
    (grant.input.selection !== "parent_or_jev" || ordinaryRoutingMaximum(grant.input) === 0 || grant.routingTarget !== null);
}
function sameFiles(before: GoalFileScope, after: unknown): after is GoalFileScope {
  return validGoalFileScope(after) && before.id === after.id && before.root === after.root && isDeepStrictEqual(before.rootIdentity, after.rootIdentity) &&
    before.files.length === after.files.length && before.files.every((file, index) => {
      const next = after.files[index]!;
      return file.id === next.id && file.path === next.path && file.access === next.access && isDeepStrictEqual(file.version.identity, next.version.identity) &&
        (file.access === "read_write" || isDeepStrictEqual(file.version, next.version));
    });
}
function revoke(state: OrdinaryAuthorizationState, reason: Extract<OrdinaryAuthorizationState, { phase: "revoked" }>["reason"]): OrdinaryAuthorizationStep {
  const ledger = "spentCalls" in state ? { startedWorkers: state.startedWorkers, spentCalls: state.spentCalls, reservedCalls: state.reservedCalls, history: state.history } : empty;
  const pending = state.phase === "running";
  return { state: { phase: "revoked", reason, ...ledger, cleanupPending: pending,
    ...("grant" in state ? { id: state.grant.id } : {}),
    ...("selection" in state && state.selection ? { selection: structuredClone(state.selection) } : {}),
    ...("graphEvents" in state && state.graphEvents ? { graphEvents: structuredClone(state.graphEvents), nodeId: state.nodeId } : {}),
    ...(state.phase === "running" ? { pending: { id: state.grant.id, taskId: taskId(state), selection: state.selection, observed: false } } : {}) },
    effects: pending ? [{ type: "abort_worker" }] : [] };
}
/** Select exactly the kernel's next ready node, independent of catalog or edge ordering. */
function advance(state: Active): OrdinaryAuthorizationStep {
  if ("plan" in state.grant.input) {
    try {
      const { next } = evaluatePlanGraph(state.grant.input.plan, state.graphEvents);
      if (next.kind === "finished") {
        const { nodeId: _nodeId, ...finished } = state;
        return done({ ...finished, phase: "finished" });
      }
      const active = { ...state, nodeId: next.nodeId, index: state.grant.input.tasks.findIndex(task => task.id === next.nodeId) };
      if (next.kind === "choice") return { state: { ...active, phase: "selecting" }, effects: [{ type: "select_branch", id: state.grant.id, nodeId: next.nodeId }] };
      state = active;
    } catch { return revoke({ ...state, phase: "selecting" }, "invalid"); }
  } else if (state.index >= state.grant.input.tasks.length) return done({ ...state, phase: "finished" });
  if (state.grant.input.limits.modelCalls != null && state.spentCalls >= state.grant.input.limits.modelCalls || state.startedWorkers >= state.grant.input.limits.workerRuns)
    return revoke({ ...state, phase: "selecting" }, "budget");
  return { state: { ...state, phase: "selecting" }, effects: [{ type: "select_worker", id: state.grant.id, taskId: taskId(state) }] };
}
/** Pure, per-invocation kernel. Trusted native effects must own approval/freshness/
 * SDK/process receipts. Never expose or restore this state as caller authority. */
export function reduceOrdinaryAuthorization(state: OrdinaryAuthorizationState, event: OrdinaryAuthorizationEvent): OrdinaryAuthorizationStep {
  if (state.phase === "finished") return done(state);
  if (state.phase === "revoked") {
    if (event.type === "cleanup" && event.id === state.id && event.confirmed === true && state.cleanupPending) return done({ ...state, cleanupPending: false });
    if (event.type === "observed" && state.pending && !state.pending.observed && event.id === state.pending.id && event.taskId === state.pending.taskId) {
      const observed = event.observation, calls = observed.modelCalls;
      if (calls !== null && (!Number.isSafeInteger(calls) || calls < 0 || state.reservedCalls !== null && calls > state.reservedCalls || !Number.isSafeInteger(state.spentCalls + calls))) return done(state);
      return done({ ...state, spentCalls: state.spentCalls + (calls ?? 0),
        reservedCalls: observed.cleanupConfirmed === true && observed.accountingComplete === true && calls !== null ? 0 : state.reservedCalls === null ? null : state.reservedCalls - (calls ?? 0),
        cleanupPending: observed.cleanupConfirmed !== true && state.cleanupPending, pending: { ...state.pending, observed: true },
        history: [...state.history, { taskId: state.pending.taskId, selection: state.pending.selection, observation: structuredClone(observed) }] });
    }
    return done(state);
  }
  if (event.type === "cleanup") return done(state);
  if ("id" in event && "grant" in state && event.id !== state.grant.id) return done(state);
  if ("taskId" in event && "index" in state && event.taskId !== taskId(state)) return done(state);
  const invalidClock = !safeClock(event.now) || ("now" in state && event.now < state.now);
  const expired = "expiresAt" in state && event.now >= state.expiresAt;
  // An owned final observation remains accounting evidence after cancellation or
  // deadline expiry. It can never revive authority or start the next task.
  if (invalidClock && !(state.phase === "running" && event.type === "observed")) return revoke(state, "invalid");
  // The owned deadline timer also signals cancellation; only active grants can expire.
  if (event.type === "stop") return revoke(state, event.reason === "cancelled" && expired ? "expired" : event.reason);
  if (expired && !(state.phase === "running" && event.type === "observed")) return revoke(state, "expired");
  if (state.phase === "idle" && event.type === "start") {
    if (!validOrdinaryInput(event.input) || !event.sessionId || event.sessionId.length > 128 || /[\u0000-\u001f\u007f]/.test(event.sessionId)) return revoke(state, "invalid");
    const input = structuredClone(event.input);
    return { state: { phase: "preparing", input, sessionId: event.sessionId, now: event.now }, effects: [{ type: "prepare", input, sessionId: event.sessionId }] };
  }
  if (state.phase === "preparing" && event.type === "prepared") {
    if (!validOrdinaryPreparedScope(event.grant) || !isDeepStrictEqual(event.grant.input, state.input) || event.grant.sessionId !== state.sessionId) return revoke(state, "invalid");
    const grant = structuredClone(event.grant), digest = ordinaryScopeDigest(grant);
    return { state: { phase: "awaiting_approval", grant, digest, now: event.now }, effects: [{ type: "confirm_scope", grant, digest }] };
  }
  if (state.phase === "awaiting_approval" && event.type === "approval") {
    if (event.id !== state.grant.id || event.digest !== state.digest) return done(state);
    if (event.approved !== true) return revoke(state, "declined");
    if (!safeClock(event.now + state.grant.input.limits.seconds * 1000)) return revoke(state, "invalid");
    const next: Active = { ...empty, grant: state.grant, digest: state.digest, files: state.grant.files, index: 0, now: event.now,
      expiresAt: event.now + state.grant.input.limits.seconds * 1000,
      ...("plan" in state.grant.input ? { graphEvents: [] } : {}) };
    return advance(next);
  }
  if (state.phase === "selecting" && event.type === "branch_selected") {
    if (!("plan" in state.grant.input) || !state.graphEvents || event.nodeId !== state.nodeId) return revoke(state, "invalid");
    const node = state.grant.input.plan.nodes.find(node => node.id === event.nodeId);
    if (node?.kind !== "choice" || !node.choices.some(option => option.id === event.choiceId) || !Number.isFinite(event.confidence) || event.confidence < 0 || event.confidence > 1)
      return revoke(state, "invalid");
    if (event.confidence < 0.5) return revoke(state, "undecided");
    return advance({ ...state, now: event.now, graphEvents: [...state.graphEvents, { type: "choice", nodeId: node.id, choiceId: event.choiceId }] });
  }
  if (state.phase === "selecting" && event.type === "selected") {
    if (event.id !== state.grant.id || event.taskId !== taskId(state)) return done(state);
    const task = state.grant.input.tasks[state.index], choice = event.selection;
    if (!task) return revoke(state, "invalid");
    const plan = ordinarySelectionPlan(state.grant, task.id);
    const valid = !task.alternatives && choice.source === "parent" && choice.alternativeId === undefined &&
      state.grant.agents.some(candidate => candidate.name === choice.agent) && (!task.agent || task.agent === choice.agent) ||
      plan?.source === "jev" && choice.source === "jev" && plan.choices.some(candidate => candidate.agent === choice.agent && candidate.alternativeId === choice.alternativeId);
    if (!valid) return revoke(state, "invalid");
    const total = state.grant.input.limits.modelCalls ?? null, perWorker = state.grant.input.limits.perWorkerCalls ?? null;
    const remaining = total === null ? null : total - state.spentCalls;
    const calls = perWorker === null ? remaining : remaining === null ? perWorker : Math.min(perWorker, remaining);
    if (calls !== null && calls < 1 || state.reservedCalls !== 0 || state.startedWorkers >= state.grant.input.limits.workerRuns) return revoke(state, "budget");
    return { state: { ...state, phase: "checking", selection: structuredClone(choice), calls, now: event.now },
      effects: [{ type: "check_current", id: state.grant.id, taskId: taskId(state), digest: state.digest, files: state.files }] };
  }
  if (state.phase === "checking" && event.type === "fresh") {
    if (event.id !== state.grant.id || event.taskId !== taskId(state)) return done(state);
    if (event.current !== true || event.sessionId !== state.grant.sessionId || event.digest !== state.digest) return revoke(state, "changed");
    const next = { ...state, phase: "running" as const, reservedCalls: state.calls, startedWorkers: state.startedWorkers + 1, now: event.now };
    return { state: next, effects: [{ type: "run_worker", id: state.grant.id, taskId: taskId(state),
      agent: state.grant.agents.find(agent => agent.name === state.selection.agent)!, maxModelCalls: state.calls, files: state.files, deadline: state.expiresAt }] };
  }
  if (state.phase === "running" && event.type === "observed") {
    if (event.id !== state.grant.id || event.taskId !== taskId(state)) return done(state);
    const observation = event.observation, calls = observation.modelCalls;
    if (calls !== null && (!Number.isSafeInteger(calls) || calls < 0 || state.reservedCalls !== null && calls > state.reservedCalls || !Number.isSafeInteger(state.spentCalls + calls))) return revoke(state, "invalid");
    const next = { ...state, now: event.now, spentCalls: state.spentCalls + (calls ?? 0),
      reservedCalls: observation.cleanupConfirmed === true && observation.accountingComplete === true && calls !== null ? 0 : state.reservedCalls === null ? null : state.reservedCalls - (calls ?? 0),
      history: [...state.history, { taskId: taskId(state), selection: state.selection, observation: structuredClone(observation) }] };
    const stop = (reason: Extract<OrdinaryAuthorizationState, { phase: "revoked" }>["reason"]) => {
      const stopped = revoke(next, reason);
      if (stopped.state.phase !== "revoked") return stopped;
      const { pending: _pending, ...terminal } = stopped.state;
      return { state: { ...terminal, cleanupPending: observation.cleanupConfirmed !== true },
        effects: observation.cleanupConfirmed === true ? [] : stopped.effects } satisfies OrdinaryAuthorizationStep;
    };
    if (invalidClock || expired) return stop(invalidClock ? "invalid" : "expired");
    if (observation.cleanupConfirmed !== true || observation.accountingComplete !== true || calls === null) return stop("unknown");
    if (observation.outcome !== "completed") return stop(observation.outcome === "cancelled" ? "cancelled" : "failed");
    if (calls === 0 || !sameFiles(state.files, observation.files)) return stop("changed");
    const active: Active = { grant: state.grant, digest: state.digest, expiresAt: state.expiresAt, now: event.now, index: state.index + 1,
      files: structuredClone(observation.files), spentCalls: next.spentCalls, reservedCalls: 0, startedWorkers: next.startedWorkers, history: next.history,
      ...(state.graphEvents ? { graphEvents: [...state.graphEvents, { type: "task" as const, nodeId: taskId(state) }] } : {}) };
    return advance(active);
  }
  return done(state);
}

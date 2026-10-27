import { randomUUID } from "node:crypto";
import { AutomaticDelegateInputSchema } from "./automatic-input.ts";
import type { FullAccessLease } from "./delegation-access-effects.ts";
import path from "node:path";
import { withWindowsGoalReadBatch } from "./windows-goal-files.ts";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { DelegateInputSchema, type WorkerReport } from "./delegate-machine.ts";
import type { WorkerRound, WorkerRoundCoverage } from "./worker-rounds.ts";
import { Type } from "typebox";
import { OrdinaryScopeInputSchema, OrdinaryGraphInputSchema, ordinaryBranchPlan, ordinarySelectionPlan, ordinaryRoutingTasks, ordinaryRoutingMaximum, ordinaryScopeDigest,
  reduceOrdinaryAuthorization, validOrdinaryPreparedScope, validOrdinaryInput,
  type OrdinaryInput, type OrdinaryPreparedScope, type OrdinaryAuthorizationState, type OrdinaryAuthorizationEvent } from "./ordinary-authorization.ts";
import { maximumGraphTasks } from "./plan-graph.ts";
import type { RouteRequest } from "./machine.ts";
import { canonicalDirectory, canonicalOrdinaryDirectories, contextSnapshot, checkGoalContext, checkFreshReadPair, loadGoalProfile, openGoalProjectLock, runGoalProcess, type GoalProjectOwner } from "./goal-run-effects.ts";
import { prepareGoalFileScope, checkGoalFileScope } from "./goal-file-effects.ts";
import { confirmContextPacket, canConfirmContextPacket } from "./context-approval.ts";
import type { ApprovalUiObserver } from "./approval-ui-diagnostics.ts";
import { approvalUiDiagnostics } from "./approval-ui-diagnostics-effects.ts";
import { executeEffect } from "./effects.ts";
import { estimateJevUsd, reportData, type JevReport } from "./choice.ts";
import type { SkillSuggestion } from "./skill-suggestion.ts";
import { describeJevTarget, readJevConnection, sameJevConnection, type JevConnection } from "./jev-config.ts";
import { ordinaryContextDigest, ordinaryControlBatches, ordinaryOwner, ordinaryLock, ordinaryPrompts, ordinaryRun, OrdinaryWorkerReplySchema,
  reduceOrdinaryRoutingAccounting, ordinaryRetainOwner, type OrdinaryRoutingLedger,
  type OrdinaryWorkerInput, type OrdinaryWorkerReply } from "./ordinary-protocol.ts";
import type { GoalContextFile } from "./goal-run.ts";
import type { GoalFileScope } from "./goal-files.ts";
import { OrdinaryPreparationError, ordinaryPreparationStage, ordinaryDirectoryIssues, type OrdinaryPreparationStage, type OrdinaryDiagnostic, type OrdinaryFailurePhase } from "./ordinary-diagnostics.ts";
import { directoryError, directoryPreparationIssues, type DirectoryIssue } from "./directory-diagnostics.ts";
import { humanLiteral, durationText, callLimitText } from "./task-review-machine.ts";
import { ordinaryPlanView, planReceipt } from "./plan-state.ts";
import { planText, type PlanView } from "./plan-presentation.ts";
import type { WorkerProgress, WorkerProgressObserver } from "./worker-progress.ts";
import { DelegationMemoryInputSchema, MemoryChoiceInputSchema, DELEGATION_MEMORY_PROTOCOL, delegationMemoryRequest, delegationMemoryChoice,
  selectDelegationMemory, validDelegationMemoryInput, type DelegationMemoryInput, type DelegationMemoryParent } from "./delegation-memory.ts";
import { prepareDelegationMemory, applyDelegationMemory, type PreparedDelegationMemory } from "./delegation-memory-effects.ts";
import { ProjectMemoryError } from "./project-memory-store.ts";
import type { MemorySnapshot } from "./project-memory.ts";
import { ParallelReadInputSchema } from "./parallel-read.ts";
import { TaskTreeInputSchema, TreeContinueSchema } from "./task-tree.ts";

// Keep the standalone historical harness schema private to its regression code, not the public JEV tool.
export const OrdinaryDelegateInputSchema = Type.Omit(DelegateInputSchema, ["solPi"], { additionalProperties: false });
export const DelegateToolInputSchema = Type.Union([Type.Object({ auto: AutomaticDelegateInputSchema }, { additionalProperties: false }), OrdinaryDelegateInputSchema, Type.Object({ scope: OrdinaryScopeInputSchema, memory: Type.Optional(DelegationMemoryInputSchema) }, { additionalProperties: false,
  description: "Optional one-job preapproval. Parent supplies English task/ordered subtask summaries, explicit existing files/access, fixed profiles and limits (workers<=3, optional finite SDK caps or null for SDK completion, explicit shared seconds<=86400). Parent sets task.agent or permits JEV selection; parent_only requires pins unless there is one candidate. One exact native review covers model/thinking/effective read/edit/write file-ID tools/public JEV target and task/skill metadata. No shell/discovery/new files/install/verifier/SoL/secret transmission or caller grant/state restoration. Unknown cleanup/accounting/failure/cancellation stops. Credentials stay effect-local; no automatic retry/fallback or final acceptance." }), Type.Object({ graph: OrdinaryGraphInputSchema, memory: Type.Optional(DelegationMemoryInputSchema) }, { additionalProperties: false,
  description: "Explicit DAG v2: closed task catalog plus task/choice/join nodes and conditional edges. One exact review; maximum path workers<=3, shared existing limits. JEV selects each reached binary choice once at >=0.5 support; skips and joins never start workers. No caller events/state/grants, fallback, verifier or retry." }), Type.Object({ memoryChoice: MemoryChoiceInputSchema }, { additionalProperties: false,
  description: "Select approved memory IDs for the same still-active job, or explicitly ask the user when the parent is also uncertain. An opaque live job ID is not persisted or restored authority. No new worker/model/provider, permission or deadline." }), Type.Object({ parallelRead: ParallelReadInputSchema }, { additionalProperties: false }),
  Type.Object({ tree: TaskTreeInputSchema }, { additionalProperties: false }), Type.Object({ treeContinue: TreeContinueSchema }, { additionalProperties: false })]);
export const ORDINARY_ERROR = "Scoped delegation stopped. No retry, fallback or rollback; changes may remain.";
type Prepared = { scope: OrdinaryPreparedScope; context: GoalContextFile[]; agentDirectory: string; memory?: PreparedDelegationMemory };
export type OrdinaryMemoryOptions = { readonly memory?: DelegationMemoryInput; readonly onMemoryLookup?: DelegationMemoryParent };
function fail(): never { throw new Error(ORDINARY_ERROR); }
export async function prepareOrdinaryScope(input: OrdinaryInput, ctx: ExtensionContext, signal: AbortSignal): Promise<Prepared> {
  let stage: OrdinaryPreparationStage = "input";
  try {
    if (!validOrdinaryInput(input)) fail();
    stage = "directories";
    const { cwd: root, agentDirectory } = await canonicalOrdinaryDirectories(ctx.cwd, getAgentDir(), signal);
    stage = "file_scope";
    const files = await prepareGoalFileScope({ cwd: root, files: input.files }, { agentDirectory, journalDirectory: agentDirectory }, signal);
    const agents: OrdinaryPreparedScope["agents"] = [], workerTargets: OrdinaryPreparedScope["workerTargets"] = [], sources = new Map<string, GoalContextFile>();
    for (const name of input.agents) {
      stage = "model_profile";
      const loaded = await loadGoalProfile(name, agentDirectory, signal);
      const tools = loaded.agent.tools.filter(tool => tool === "read" || input.files.some(file => file.access === "read_write") && ["edit", "write"].includes(tool));
      if (!tools.includes("read")) fail();
      const agent = { ...loaded.agent, tools }; agents.push(agent);
      workerTargets.push({ agent: name, ...loaded.publicModel });
      stage = "instructions";
      const context = await contextSnapshot(root, agentDirectory, agent.file, input.files, signal);
      if (!isDeepStrictEqual(context.find(entry => entry.path === agent.file)?.version, loaded.profileVersion) ||
        !isDeepStrictEqual(context.find(entry => entry.path === path.join(agentDirectory, "models.json"))?.version ?? null, loaded.modelConfiguration)) fail();
      for (const entry of context) { if (sources.has(entry.path) && !isDeepStrictEqual(sources.get(entry.path), entry)) fail(); sources.set(entry.path, entry); }
    }
    const context = [...sources.values()]; if (context.length > 128) fail();
    stage = "routing_configuration";
    const configuration = input.selection === "parent_or_jev" && ordinaryRoutingMaximum(input) > 0 ? readJevConnection() : null;
    if (configuration && !configuration.ok) fail();
    stage = "prepared_scope";
    const scope: OrdinaryPreparedScope = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), input: structuredClone(input), agents, files, workerTargets,
      contextDigest: ordinaryContextDigest(context, agentDirectory), routingTarget: configuration?.ok ? describeJevTarget(configuration.connection) : null,
      fileProtocol: "scoped_existing_files", approvalDeadline: null };
    if (!validOrdinaryPreparedScope(scope)) fail();
    stage = "freshness";
    await checkFreshReadPair(() => checkGoalContext({ body: { context } }, signal),
      () => checkGoalFileScope(files, { agentDirectory, journalDirectory: agentDirectory }, signal), signal);
    return { scope, context, agentDirectory };
  } catch (error) {
    const detail = directoryError(error);
    throw new OrdinaryPreparationError(stage, directoryPreparationIssues(error) ?? (detail?.cleanupConfirmed === false ? [{ target: "workspace", ...detail }] : undefined));
  }
}
export function ordinaryApprovalPacket(prepared: Prepared): string {
  const { scope, context } = prepared;
  return JSON.stringify({ version: 1, purpose: "One bounded ordinary job, not persistent session authority", scope,
    ...("plan" in scope.input ? { maximumGraphTasks: maximumGraphTasks(scope.input.plan) } : {}),
    modelRounds: { jobLimit: scope.input.limits.modelCalls ?? null, perWorkerLimit: scope.input.limits.perWorkerCalls ?? null,
      notice: "Null means SDK natural completion with no model-round count limit, not a token or cost cap. The approved execution deadline still applies. Actual SDK calls and incomplete accounting remain reported." },
    ...(prepared.memory ? { memoryStorage: { directory: prepared.memory.directory, token: prepared.memory.token, create: prepared.memory.input.create === true },
      memoryProtocol: DELEGATION_MEMORY_PROTOCOL, memoryJevMaximum: 1, totalJevMaximum: ordinaryRoutingMaximum(scope.input) + 1 } : {}),
    workerPrompts: scope.agents.map(agent => ({ name: agent.name, ...ordinaryPrompts(scope, agent, "Each reviewed task summary is the exact worker prompt.", context) })),
    routing: { target: scope.routingTarget, maximumRequests: scope.routingTarget ? ordinaryRoutingMaximum(scope.input) : 0,
      runtimeObservationPolicy: "Selection state includes bounded prior approved graph/stage IDs, choices, selected agents/alternatives, outcomes, observed model-call counts and accounting/cleanup booleans only. No worker text, source, paths or credentials.",
      branchPackets: "plan" in scope.input ? scope.input.plan.nodes.filter(node => node.kind === "choice").map(node => ({ nodeId: node.id, request: ordinaryBranchPlan(scope, node.id) })) : [],
      timeoutPerRequestMs: 10_000, packets: scope.routingTarget ? ordinaryRoutingTasks(scope.input).map(task => {
        const plan = ordinarySelectionPlan(scope, task.id);
        return plan?.source === "jev" ? { task: plan.request.task, candidates: plan.request.agents,
          ...(scope.input.skillCandidates ? { skillCandidates: scope.input.skillCandidates } : {}) } : null;
      }) : [],
      notice: "Only supplied task/candidate/skill metadata and bounded prior-stage status/choice/call/accounting observations. No source, paths, profile prompts, instructions, replies, logs or memory are collected for JEV. No retries/fallback; provider billing may be unknown." },
    boundaries: "Scoped existing-file read/edit/write only, 64 file operations per worker. No shell, discovery, new files, install, external verification, automatic repair/retry or fallback. Not an OS sandbox or rollback; completion is unverified and needs human review. Credentials stay effect-local. Parent Pi cost excluded; unknown cost is not zero. Cancellation/navigation/reload revokes this invocation; no grant restoration.",
  }, null, 2);
}
/** Human-only exact-source projection. The original JSON packet remains the approval/correlation snapshot. */
export function ordinaryApprovalText(prepared: Prepared): string {
  const { scope, context } = prepared, limit = scope.input.limits;
  const graph = "plan" in scope.input ? scope.input.plan : undefined;
  const tasks = scope.input.tasks.map((task, index) => `${index + 1}. ${task.id} · ${task.agent ?? (scope.agents.length === 1 ? scope.agents[0]!.name : "JEV selects an approved candidate")}\n${humanLiteral(task.summary)}` +
    (task.after ? `\nDepends on · ${task.after.join(", ") || "none"}` : "") +
    (task.alternatives ? "\nApproved A/B alternatives · JEV selects one; execution failure never retries the other.\n" + task.alternatives.map(alternative =>
      `${alternative.id} · ${alternative.agent ?? task.agent ?? "approved candidates"}\nSelection rubric · ${humanLiteral(alternative.description)}\nExact worker input · ${humanLiteral(alternative.summary)}`).join("\n\n") : ""));
  const roles = scope.agents.map(agent => `${agent.name} · ${agent.model.provider}/${agent.model.id} · thinking ${agent.thinking ?? "off / model default"} · tools ${agent.tools.join(", ")}`);
  const files = scope.files.files.map(file => `${file.id} · ${humanLiteral(file.path)}\n  ${file.access === "read" ? "read only" : "read / edit / write"} · existing file ${file.version.bytes} bytes`);
  return ["JEV · Exact plan execution approval", planText(ordinaryPlanView(scope, { phase: "awaiting_approval", grant: scope, digest: "", now: 0 }, 0)),
    graph ? "DAG v2 dispatches one deterministic ready node at a time. JEV selects each reached binary choice once at >=0.5 support; joins are automatic and skipped nodes do not execute. Failure never tries another branch. Ended does not mean verified."
      : "Up to three sequential DAG stages. Only one approved A/B alternative runs. Execution errors never trigger another alternative. Ended does not mean verified.", "Review the execution boundary",
    `${scope.input.tasks.length} ${graph ? "catalog tasks" : "sequential stages"} / at most ${limit.workerRuns} workers\nWorkspace · ${humanLiteral(scope.files.root)}\nRuntime · after approval ${durationText(limit.seconds)} shared (not reset per worker)\nJob · ${callLimitText(limit.modelCalls ?? null)}\nPer worker · ${callLimitText(limit.perWorkerCalls ?? null)}`,
    "Cost warning · Model/subscription usage may be charged. Time and round limits are NOT token or money quotas.\nCancellation is not rollback. Uncertain accounting or cleanup stops work and retains ownership.\nApproval waits without a response deadline; the execution clock starts only after positive approval.",
    "── Approved existing files ──\n" + files.join("\n"), "── Candidates / fixed models / tools ──\n" + roles.map(humanLiteral).join("\n"),
    "── Exact overall task ──\n" + humanLiteral(scope.input.task), "── Exact stage inputs ──\n" + tasks.join("\n\n"),
    ...(graph ? ["── Complete approved DAG v2 ──\n" + `Entry · ${graph.entry}\nmaximumGraphTasks(plan) · ${maximumGraphTasks(graph)}\nRouting upper bound · ${ordinaryRoutingMaximum(scope.input)}\n` +
      graph.nodes.map(node => `${node.id} · ${node.kind}` + (node.kind === "choice" ? `\nSummary · ${humanLiteral(node.summary)}\n` +
        node.choices.map(option => `${option.id} · ${humanLiteral(option.description)}`).join("\n") : "")).join("\n\n") +
      "\n\nAll edges\n" + graph.edges.map(edge => `${edge.from} → ${edge.to}${edge.when !== undefined ? ` · when ${edge.when}` : ""}`).join("\n")] : []),
    ...(prepared.memory ? ["── Memory included in this one job approval ──\n" + DELEGATION_MEMORY_PROTOCOL +
      `\nExisting private storage · ${humanLiteral(prepared.memory.directory)}\nCreate database · ${prepared.memory.input.create === true}\nMemory JEV maximum · 1 (separate from worker routing)\nNo additional write/search/snapshot dialogs within these exact sources. The same original job deadline includes parent selection.\n` + humanLiteral(JSON.stringify(scope.memory, null, 2))] : []),
    "── Selection and transmission ──\n" + (scope.routingTarget ? `JEV target · ${humanLiteral(scope.routingTarget)}\nUnassigned stages and A/B choices are selected once. Only reviewed task/candidate/skill metadata and prior-stage IDs, selected branches, outcomes, observed call counts and accounting/cleanup booleans are sent. No source, worker replies, keys or profile prompts.` : "No JEV selection/transmission · fixed workers"),
    ...(scope.input.skillCandidates?.map(skill => `Explicit skill · ${humanLiteral(skill.name)}\n${humanLiteral(skill.description)}`) ?? []),
    ...scope.agents.map(agent => {
      const prompts = ordinaryPrompts(scope, agent, "Each reviewed task summary is the exact worker prompt.", context);
      const endpoint = scope.workerTargets.find(target => target.agent === agent.name);
      return `── ${agent.name} · Exact worker system source ──\nProfile · ${humanLiteral(agent.file)}\nDescription · ${humanLiteral(agent.description)}\nAPI · ${humanLiteral(endpoint?.api ?? "unknown")} · ${humanLiteral(endpoint?.endpoint ?? "unknown")}\n\n${humanLiteral(prompts.systemPrompt)}\n\nThe worker input is the exact task.summary or the selected approved alternative summary above.`;
    }),
    "── Technical correlation (not additional authority) ──\n" + `Plan ID · ${scope.id}\nInstruction/configuration fingerprint · ${scope.contextDigest}\nExisting root identity · ${JSON.stringify(scope.files.rootIdentity)}\n` + scope.files.files.map(file => `${file.id} · ${JSON.stringify(file.version)}`).join("\n"),
    "Existing file-ID read/edit/write only; 64 file operations per worker. No shell, discovery, new files, installation, external verifier, automatic retry or fallback. Not an OS sandbox; completion is unverified and needs human review.\nThis approval covers only this exact source, permission and duration snapshot. Editing the text, cancellation or session change denies it.",
  ].join("\n\n");
}
export const ordinaryIO = { prepare: prepareOrdinaryScope, prepareMemory: prepareDelegationMemory, applyMemory: applyDelegationMemory, confirm: confirmContextPacket, canonicalDirectory, own: openGoalProjectLock,
  checkContext: checkGoalContext, checkFiles: checkGoalFileScope, run: (input: OrdinaryWorkerInput, signal: AbortSignal, onProgress?: WorkerProgressObserver) => runGoalProcess({
    script: "ordinary-worker.ts", cwd: input.files.root, input, deadline: input.deadline, timeoutMs: Math.max(1, input.deadline - Date.now()),
  }, (value): value is OrdinaryWorkerReply => Value.Check(OrdinaryWorkerReplySchema, value), signal, onProgress), select: executeEffect };
export type OrdinaryPublicResult = { readonly kind: "ordinary_scope"; readonly status: "completed_unverified" | "stopped";
  readonly authorization?: "full_access";
  readonly taskAcceptance: "needs_human_review"; readonly reason: string; readonly skillSuggestions: readonly { taskId: string; suggestion: SkillSuggestion }[]; readonly workersStarted: number; readonly modelCalls: number;
  readonly reservedModelCalls: number | null; readonly jevRequests: number; readonly reservedJevRequests: number; readonly jevReports: readonly JevReport[]; readonly cleanupConfirmed: boolean; readonly lockRetained: boolean;
  readonly diagnostic: OrdinaryDiagnostic | null;
  readonly plan?: PlanView;
  readonly memory?: { readonly selected: readonly string[]; readonly declaredWrites: number; readonly jevRequests: number; readonly parentLookup: boolean };
  readonly automaticRecommendations?: readonly { readonly stage: "model" | "thinking"; readonly model: { readonly provider: string; readonly id: string }; readonly thinking?: string; readonly support: number; readonly executionAuthorized: false }[];
  readonly automaticAdvice?: { readonly stage: "model" | "thinking"; readonly model: { readonly provider: string; readonly id: string }; readonly thinking?: string; readonly support: number; readonly executionAuthorized: false };
  readonly automaticSelection?: { readonly model: { readonly provider: string; readonly id: string }; readonly thinking: string; readonly source: "only_choice" | "jev" };
  readonly workerFailure?: NonNullable<WorkerReport["diagnostic"]>;
  readonly workerRounds?: readonly WorkerRound[];
  readonly workerRoundsCoverage?: WorkerRoundCoverage;
  readonly costEstimate: { readonly observedUsd: number; readonly delegationTotalUsd: number | null }; readonly reports: readonly { taskId: string; agent: string; text: string }[] };
/** Effect interpreter. Native-only approval and private invocation state; never accept caller grants or restored state. */
export async function ordinaryDelegate(input: OrdinaryInput, ctx: ExtensionContext, signal?: AbortSignal,
  onProgress?: (phase: string) => void, io = ordinaryIO, observeUi?: ApprovalUiObserver,
  onPlan?: (view: PlanView) => void, memoryOptions?: OrdinaryMemoryOptions, access?: FullAccessLease): Promise<OrdinaryPublicResult> {
  let transition = reduceOrdinaryAuthorization({ phase: "idle" }, { type: "start", input, sessionId: ctx.sessionManager.getSessionId(), now: Date.now() });
  let prepared: Prepared | undefined, connection: JevConnection | null = null, owner: GoalProjectOwner | undefined;
  let ownerAttempted = false, failurePhase: OrdinaryFailurePhase = "interface";
  let preparationStage: OrdinaryPreparationStage | undefined, workerFailure: NonNullable<WorkerReport["diagnostic"]> | undefined, workerRounds: readonly WorkerRound[] | undefined;
  let workerRoundsCoverage: WorkerRoundCoverage | undefined;
  let directoryIssues: readonly DirectoryIssue[] | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, observedUsd = 0, costKnown = true, cleanupConfirmed = true, lockRetained = false, selectionUncertain = false;
  let routing: OrdinaryRoutingLedger = { tasks: [], pending: [], reports: [], blocked: false };
  let memoryRouting: OrdinaryRoutingLedger = { tasks: [], pending: [], reports: [], blocked: false };
  let memoryReady = false, memoryParentLookup = false, selectedMemory: MemorySnapshot | undefined;
  const allRouting = (): OrdinaryRoutingLedger => ({ tasks: [...routing.tasks, ...memoryRouting.tasks], pending: [...routing.pending, ...memoryRouting.pending],
    reports: [...routing.reports, ...memoryRouting.reports], blocked: routing.blocked || memoryRouting.blocked });
  const skillSuggestions: { taskId: string; suggestion: SkillSuggestion }[] = [];
  const reports: { taskId: string; agent: string; text: string }[] = [], controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(access ? [access.signal] : [])]);
  let workerProgress: WorkerProgress | undefined, activeTaskId: string | undefined, executionStarted: number | undefined;
  const view = () => prepared ? ordinaryPlanView(prepared.scope, transition.state,
    executionStarted === undefined ? 0 : Math.max(0, Math.floor(performance.now() - executionStarted)), workerProgress, activeTaskId) : undefined;
  const display = () => { const snapshot = view(); if (snapshot) { try { onPlan?.(snapshot); } catch { /* Display never grants or retries work. */ } } };
  const send = (event: OrdinaryAuthorizationEvent) => {
    if ("index" in transition.state) activeTaskId = transition.state.nodeId ?? transition.state.grant.input.tasks[transition.state.index]?.id;
    transition = reduceOrdinaryAuthorization(transition.state, event);
    if (event.type === "approval" && transition.state.phase === "selecting") executionStarted = performance.now();
    if (event.type === "observed") workerProgress = undefined;
    display();
  };
  const cancelled = () => send({ type: "stop", reason: "cancelled", now: Date.now() });
  combined.addEventListener("abort", cancelled, { once: true });
  const current = async (files: GoalFileScope) => {
    if (!prepared || combined.aborted || !("digest" in transition.state) || ordinaryScopeDigest(prepared.scope) !== transition.state.digest ||
      ctx.sessionManager.getSessionId() !== prepared.scope.sessionId || await io.canonicalDirectory(ctx.cwd, false, combined) !== prepared.scope.files.root) fail();
    if (connection) { const fresh = readJevConnection(); if (!fresh.ok || !sameJevConnection(fresh.connection, connection)) fail(); }
    const lock = ordinaryLock({ scope: prepared.scope });
    const ownership = owner ? [{ path: lock.path, text: lock.text, active: false, version: owner.version }] : [];
    // Split before IO when the existing native path/byte/frame bounds cannot fit the owner too.
    const currentPrepared = prepared;
    await checkFreshReadPair(async () => {
      const control = ownership[0];
      if (control && ordinaryControlBatches(currentPrepared.context, lock.path, control.version.bytes).length > 1) {
        await io.checkContext({ body: { context: currentPrepared.context } }, combined);
        await io.checkContext({ body: { context: ownership } }, combined);
      } else await io.checkContext({ body: { context: [...currentPrepared.context, ...ownership] } }, combined);
    }, () => io.checkFiles(files, { agentDirectory: currentPrepared.agentDirectory, journalDirectory: currentPrepared.agentDirectory }, combined), combined);
    if (combined.aborted || ctx.sessionManager.getSessionId() !== prepared.scope.sessionId || !("expiresAt" in transition.state) || Date.now() >= transition.state.expiresAt) fail();
  };
  const select = async (nodeId: string, request: RouteRequest) => {
    if (!prepared || !owner || !connection || transition.state.phase !== "selecting") fail();
    await current(transition.state.files);
    const response = await io.select({ type: "call_jev", request }, combined, () => {
      if (!prepared || !owner || transition.state.phase !== "selecting" || combined.aborted || Date.now() >= transition.state.expiresAt) fail();
      routing = reduceOrdinaryRoutingAccounting(routing, { type: "attempt", taskId: nodeId, maximum: ordinaryRoutingMaximum(prepared.scope.input),
        ...("plan" in prepared.scope.input ? { input: prepared.scope.input } : {}) });
      if (routing.blocked) fail(); costKnown = false;
    }, connection);
    const report = response.type === "resolved" ? reportData(response.decision) : "jev" in response ? response.jev : undefined;
    routing = reduceOrdinaryRoutingAccounting(routing, { type: "receipt", taskId: nodeId, report });
    if (response.type !== "resolved" || !routing.tasks.includes(nodeId) || routing.pending.includes(nodeId)) fail();
    return response.decision;
  };
  const useMemory = async () => {
    if (!prepared?.memory || memoryReady) return;
    if (transition.state.phase !== "selecting" || !connection || !prepared.scope.memory || !isDeepStrictEqual(prepared.scope.memory, prepared.memory.data)) fail();
    await current(transition.state.files);
    if (!owner) { ownerAttempted = true; owner = await io.own(ordinaryOwner(prepared.scope), combined); }
    try { onProgress?.("memory_lookup"); } catch { /* Advisory only. */ }
    const catalog = await io.applyMemory(prepared.memory, combined);
    if (catalog) {
      const response = await io.select({ type: "call_jev", request: delegationMemoryRequest(prepared.scope.memory, catalog) }, combined, () => {
        if (combined.aborted || transition.state.phase !== "selecting" || Date.now() >= transition.state.expiresAt) fail();
        memoryRouting = reduceOrdinaryRoutingAccounting(memoryRouting, { type: "attempt", taskId: "memory", maximum: 1 }); if (memoryRouting.blocked) fail();
      }, connection);
      const report = response.type === "resolved" ? reportData(response.decision) : "jev" in response ? reportData(response.jev) : undefined;
      memoryRouting = reduceOrdinaryRoutingAccounting(memoryRouting, { type: "receipt", taskId: "memory", report });
      if (report) { const amount = estimateJevUsd(report.usage, report.provider); if (amount === null) costKnown = false; else observedUsd += amount; }
      if (response.type !== "resolved" || memoryRouting.tasks.length !== 1 || memoryRouting.pending.length) fail();
      await current(transition.state.files);
      const choice = delegationMemoryChoice(catalog, response.decision.agent, response.decision.confidence);
      let ids: readonly string[];
      if (choice.kind === "parent") {
        memoryParentLookup = true; if (!memoryOptions?.onMemoryLookup) { selectionUncertain = true; fail(); }
        try { onProgress?.("memory_parent"); } catch { /* Advisory only. */ }
        const selected = await memoryOptions.onMemoryLookup({ jobId: prepared.scope.id, query: prepared.scope.memory.query, catalog }, combined);
        if (selected === null) fail(); ids = selected;
        await current(transition.state.files);
      } else ids = choice.ids;
      selectedMemory = selectDelegationMemory(prepared.scope.memory, catalog, ids);
    }
    memoryReady = true;
  };
  const execute = async () => {
    if (memoryOptions?.memory && !validDelegationMemoryInput(memoryOptions.memory)) fail();
    if (!canConfirmContextPacket(ctx) || combined.aborted) {
      approvalUiDiagnostics(null, ctx.mode, observeUi).finish(combined.aborted ? "cancelled" : "unsupported"); fail();
    }
    while (transition.effects.length) {
      const phase = transition.state.phase;
      if (phase === "preparing" || phase === "awaiting_approval" || phase === "selecting" || phase === "checking" || phase === "running") failurePhase = phase;
      try { onProgress?.(transition.state.phase); } catch { /* Presentation cannot grant or retry. */ }
      const effect = transition.effects[0]!;
      if (effect.type === "select_branch" || effect.type === "select_worker") await useMemory();
      if (effect.type === "prepare") {
        prepared = await io.prepare(effect.input, ctx, combined);
        if (memoryOptions?.memory) {
          if (prepared.scope.input.memorySnapshot) fail();
          prepared.memory = await io.prepareMemory(structuredClone(memoryOptions.memory), prepared.scope.files.root, combined);
          const selected = readJevConnection(); if (!selected.ok) fail();
          prepared.scope = { ...prepared.scope, memory: structuredClone(prepared.memory.data), routingTarget: describeJevTarget(selected.connection) };
        }
        if (prepared.scope.routingTarget) { const selected = readJevConnection(); if (!selected.ok || describeJevTarget(selected.connection) !== prepared.scope.routingTarget) fail(); connection = selected.connection; }
        send({ type: "prepared", grant: prepared.scope, now: Date.now() });
      } else if (effect.type === "confirm_scope") {
        if (!prepared) fail();
        const packet = ordinaryApprovalPacket(prepared), reviewText = ordinaryApprovalText(prepared);
        if (Buffer.byteLength(packet) > 262_144 || Buffer.byteLength(reviewText) > 262_144) fail();
        const shape = "plan" in prepared.scope.input ? `DAG v2 · ${prepared.scope.input.plan.nodes.length} nodes / at most ${prepared.scope.input.limits.workerRuns} workers`
          : `${prepared.scope.input.tasks.length} stages`;
        const approved = access ? access.authorize(ctx, combined) : await io.confirm(ctx, `JEV · ${shape} / ${prepared.scope.files.files.length} files\nAfter approval ${durationText(prepared.scope.input.limits.seconds)} · ${callLimitText(prepared.scope.input.limits.modelCalls ?? null)}`, packet, effect.grant.approvalDeadline, combined, "approval", observeUi, reviewText);
        send({ type: "approval", id: effect.grant.id, digest: effect.digest, approved, now: Date.now() });
        if (transition.state.phase === "selecting") { timer = setTimeout(() => controller.abort(), Math.max(1, transition.state.expiresAt - Date.now())); }
      } else if (effect.type === "select_branch") {
        if (!prepared || transition.state.phase !== "selecting") fail();
        await current(transition.state.files);
        if (!owner) { ownerAttempted = true; owner = await io.own(ordinaryOwner(prepared.scope), combined); }
        const request = ordinaryBranchPlan(prepared.scope, effect.nodeId, transition.state.graphEvents, transition.state.history);
        if (!request) fail();
        const decision = await select(effect.nodeId, request);
        // A late receipt settles routing above, but never records a choice or dispatches work.
        await current(transition.state.files);
        send({ type: "branch_selected", id: effect.id, nodeId: effect.nodeId, choiceId: decision.agent, confidence: decision.confidence, now: Date.now() });
      } else if (effect.type === "select_worker") {
        if (!prepared || transition.state.phase !== "selecting") fail();
        await current(transition.state.files);
        if (!owner) { ownerAttempted = true; owner = await io.own(ordinaryOwner(prepared.scope), combined); }
        const plan = ordinarySelectionPlan(prepared.scope, effect.taskId, transition.state.history); if (!plan) fail();
        let agent: string, alternativeId: string | undefined;
        if (plan.source === "parent") agent = plan.agent;
        else {
          const decision = await select(effect.taskId, plan.request);
          const choice = plan.choices.find(candidate => candidate.id === decision.agent);
          if (!choice) fail();
          if (choice.alternativeId && decision.confidence < 0.5) { selectionUncertain = true; fail(); }
          agent = choice.agent; alternativeId = choice.alternativeId;
          if (decision.skillSuggestion) skillSuggestions.push({ taskId: effect.taskId, suggestion: structuredClone(decision.skillSuggestion) });
        }
        send({ type: "selected", id: effect.id, taskId: effect.taskId, selection: { agent, source: plan.source, ...(alternativeId ? { alternativeId } : {}) }, now: Date.now() });
      } else if (effect.type === "check_current") {
        if (!prepared) fail();
        await current(effect.files);
        send({ type: "fresh", id: effect.id, taskId: effect.taskId, sessionId: ctx.sessionManager.getSessionId(), digest: effect.digest, current: true, now: Date.now() });
      } else if (effect.type === "run_worker") {
        if (!prepared || !owner || transition.state.phase !== "running") fail();
        await current(effect.files);
        const alternativeId = transition.state.selection.alternativeId;
        const result = await io.run({ scope: prepared.scope, digest: transition.state.digest, taskId: effect.taskId,
          ...(transition.state.graphEvents ? { graphEvents: structuredClone([...transition.state.graphEvents]) } : {}),
          ...(alternativeId ? { alternativeId } : {}),
          ...(selectedMemory ? { memory: structuredClone(selectedMemory) } : {}),
          run: ordinaryRun(prepared.scope, effect.taskId, effect.agent, effect.maxModelCalls, alternativeId), files: effect.files,
          context: prepared.context, agentDirectory: prepared.agentDirectory, lockVersion: owner.version,
          approvedAt: effect.deadline - prepared.scope.input.limits.seconds * 1000, deadline: effect.deadline }, combined, progress => {
          if (transition.state.phase !== "running" || transition.state.grant.input.tasks[transition.state.index]?.id !== effect.taskId) return;
          workerProgress = progress; display();
        });
        cleanupConfirmed &&= result.cleanupConfirmed;
        const reply = result.result, accounting = reply?.reply.report.accounting;
        if (reply?.reply.report.diagnostic) workerFailure = structuredClone(reply.reply.report.diagnostic);
        if (reply?.reply.report.rounds) workerRounds = structuredClone(reply.reply.report.rounds);
        workerRoundsCoverage = reply?.reply.report.roundsCoverage;
        if (accounting?.status === "reported") observedUsd += accounting.stats.cost;
        if (result.started && (accounting?.status !== "reported" || !accounting.complete)) costKnown = false;
        if (reply?.reply.type === "completed") reports.push({ taskId: effect.taskId, agent: effect.agent.name, text: reply.reply.result.text });
        if (transition.state.phase === "running" && reply?.reply.type === "completed" && reply.files.finished && result.cleanupConfirmed) {
          try { await current(reply.scope); }
          catch { send({ type: "stop", reason: combined.aborted || Date.now() >= effect.deadline ? "cancelled" : "changed", now: Date.now() }); }
        }
        send({ type: "observed", id: effect.id, taskId: effect.taskId, now: Date.now(), observation: {
          outcome: reply?.reply.type === "completed" && reply.files.finished ? "completed" : combined.aborted ? "cancelled" : "failed",
          modelCalls: reply?.reply.report.modelCalls ?? (result.started ? null : 0),
          accountingComplete: !result.started || accounting?.status === "reported" && accounting.complete,
          cleanupConfirmed: result.cleanupConfirmed && reply?.files.uncertain !== true,
          files: reply?.scope ?? null,
        } });
      } else { controller.abort(); transition = { state: transition.state, effects: [] }; }
    }
  };
  try { await withWindowsGoalReadBatch(execute, combined); }
  catch (error) {
    if (error instanceof ProjectMemoryError && error.application === "unknown") cleanupConfirmed = false;
    preparationStage = ordinaryPreparationStage(error);
    const detail = directoryError(error);
    directoryIssues = ordinaryDirectoryIssues(error) ?? directoryPreparationIssues(error) ?? (detail?.cleanupConfirmed === false ? [{ target: "workspace", ...detail }] : undefined);
    if (directoryIssues?.some(issue => !issue.cleanupConfirmed)) cleanupConfirmed = false;
    if (transition.state.phase === "running" || ownerAttempted && !owner) { cleanupConfirmed = false; costKnown = false; }
    send({ type: "stop", reason: combined.aborted || "expiresAt" in transition.state && Date.now() >= transition.state.expiresAt ? "cancelled" : "failed", now: Date.now() });
  }
  finally {
    clearTimeout(timer); combined.removeEventListener("abort", cancelled); controller.abort();
    const state = transition.state;
    lockRetained = ordinaryRetainOwner(state, allRouting(), cleanupConfirmed);
    if (owner) { try { lockRetained = await owner.close(lockRetained); } catch { lockRetained = true; cleanupConfirmed = false; } }
  }
  const state: OrdinaryAuthorizationState = transition.state;
  if (state.phase === "finished" && (!cleanupConfirmed || lockRetained)) failurePhase = "cleanup";
  const finalView = view(), plan = finalView ? { ...finalView, phase: state.phase === "finished" && cleanupConfirmed && !lockRetained ? "finished" as const : "stopped" as const } : undefined;
  if (plan) { try { onPlan?.(plan); } catch { /* Final display is still not an execution receipt. */ } }
  return { kind: "ordinary_scope", ...(access ? { authorization: access.source } : {}), status: state.phase === "finished" && cleanupConfirmed && !lockRetained ? "completed_unverified" : "stopped",
    taskAcceptance: "needs_human_review", ...(plan ? { plan: planReceipt(plan) } : {}), skillSuggestions, reason: selectionUncertain ? "undecided" : state.phase === "revoked" ? state.reason : "No independent verification or acceptance.",
    workersStarted: "startedWorkers" in state ? state.startedWorkers : 0, modelCalls: "spentCalls" in state ? state.spentCalls : 0,
    reservedModelCalls: "reservedCalls" in state ? state.reservedCalls : 0, jevRequests: allRouting().tasks.length, reservedJevRequests: allRouting().pending.length, jevReports: allRouting().reports, cleanupConfirmed: cleanupConfirmed && !lockRetained, lockRetained,
    diagnostic: state.phase === "finished" && cleanupConfirmed && !lockRetained ? null : { phase: failurePhase, ...(preparationStage ? { preparationStage } : {}), ...(directoryIssues ? { directoryIssues } : {}) },
    ...(prepared?.memory ? { memory: { selected: selectedMemory?.records.map(record => record.id) ?? [], declaredWrites: prepared.memory.data.additions.length, jevRequests: memoryRouting.tasks.length, parentLookup: memoryParentLookup } } : {}),
    ...(workerFailure ? { workerFailure } : {}), ...(workerRounds ? { workerRounds } : {}), ...(workerRoundsCoverage ? { workerRoundsCoverage } : {}),
    costEstimate: { observedUsd, delegationTotalUsd: costKnown && !lockRetained && cleanupConfirmed ? observedUsd : null }, reports };
}

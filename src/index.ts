import { truncateToVisualLines, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { route } from "./effects.ts";
import { withJevSession } from "./jev-config.ts";
import { AGENT_NAME_PATTERN, LIMITS, SoftRoutingSchema } from "./machine.ts";
import { delegate } from "./delegate-effects.ts";
import { estimateCost } from "./delegate-machine.ts";
import { DelegateToolInputSchema, ordinaryDelegate, type OrdinaryMemoryOptions, type OrdinaryPublicResult } from "./ordinary-effects.ts";
import type { OrdinaryInput } from "./ordinary-authorization.ts";
import { delegateResultView } from "./delegate-presentation.ts";
import { decide, DecisionInputSchema } from "./decision.ts";
import { registerOnboarding } from "./onboarding.ts";
import { registerNativeTaskReview } from "./native-task-review.ts";
import { registerDelegationAccess, type FullAccessLease } from "./delegation-access-effects.ts";
import { approvalUiText, type ApprovalUiDiagnostic, type ApprovalUiObserver } from "./approval-ui-diagnostics.ts";
import type { RunApproval } from "./task-review-machine.ts";
import { SkillCandidatesSchema } from "./skill-suggestion.ts";
import { basicRunSummary, type NativeExecutionHarness } from "./basic-execution.ts";
import { workerRoundsText } from "./worker-rounds.ts";
import { registerPlanWidgets } from "./plan-widget.ts";
import { registerProjectMemoryTool } from "./project-memory-effects.ts";
import { delegationMemoryOwner, type DelegationMemoryPause } from "./delegation-memory-owner.ts";
import type { DelegationMemoryParent } from "./delegation-memory.ts";
import { parallelRead } from "./parallel-read-effects.ts";
import { parallelReadText } from "./parallel-read.ts";
import { taskTree } from "./task-tree-effects.ts";
import { taskTreeOwner } from "./task-tree-owner.ts";
import { planReceipt, validPlanReceipt } from "./plan-state.ts";
import { planText, renderPlan, type PlanView } from "./plan-presentation.ts";
import { WorkerBudgetInputSchema, workerBudgetDecision, workerBudgetDiagnostic, workerBudgetOutcome, WORKER_BUDGET_REMEDIES } from "./worker-budget.ts";

const languageGuideline = (tool: string) => `${tool}: Prepare internal English task/query text; preserve literals as data; localize human output.`;

const progressLabels: Readonly<Record<string, string | undefined>> = {
  loading: "Loading profiles",
  routing: "Selecting candidates",
  gating: "Checking routing policy",
  sampling: "Selecting candidates",
  deciding: "Evaluating options",
  awaiting_approval: "Awaiting execution approval",
  running: "Worker running",
  verifying: "Running declared verification",
  awaiting_assessment_approval: "Awaiting assessment-transmission approval",
  judging: "Assessing approved evidence",
  preparing: "Preparing exact execution scope",
  memory_lookup: "Selecting within approved delegation memory",
  memory_parent: "Waiting for the current parent to choose memory",
  selecting: "Selecting an approved worker",
  checking: "Rechecking permissions and files",
};
// The SDK owns wrapping/ANSI width; do not depend on a hoisted transitive TUI
// package or hand-roll terminal width. No state, file, model or UI side effects.
function nativeToolText(text: string) {
  return { render: (width: number) => Number.isSafeInteger(width) && width > 0 ? truncateToVisualLines(text, 2000, width, 0).visualLines : [], invalidate() {} };
}
function updateProgress(onUpdate: Parameters<ToolDefinition["execute"]>[3], status: string, access?: FullAccessLease) {
  const label = access && (status === "awaiting_approval" || status === "awaiting_assessment_approval") ? "Using session Full Access" : progressLabels[status];
  if (label) {
    try { void Promise.resolve(onUpdate?.({ content: [{ type: "text", text: `JEV · ${label}` }], details: { phase: status } })).catch(() => {}); }
    catch { /* UI observations never change execution or authority. */ }
  }
}

function updatePlan(onUpdate: Parameters<ToolDefinition["execute"]>[3], view: PlanView) {
  const plan = planReceipt(view);
  try { void Promise.resolve(onUpdate?.({ content: [{ type: "text", text: planText(plan) }], details: { kind: "execution_plan", plan } })).catch(() => {}); }
  catch { /* A renderer cannot grant, stop or retry a task. */ }
}

export default function jevRouter(pi: ExtensionAPI) {
  const execution = registerJevToolsWithHarness(pi);
  registerOnboarding(pi, execution);
}

// Explicit managed sessions need tool contracts, not ordinary startup discovery
// or session preference writes. The default extension still owns onboarding.
export function registerJevTools(pi: ExtensionAPI): void { registerJevToolsWithHarness(pi); }

type GraphExecutionHarness = Omit<NativeExecutionHarness, "run"> & {
  readonly run: (input: OrdinaryInput, ctx: Parameters<NativeExecutionHarness["run"]>[1], signal?: AbortSignal,
    onProgress?: (phase: string) => void, observeUi?: ApprovalUiObserver, onPlan?: (view: PlanView) => void,
    memoryOptions?: OrdinaryMemoryOptions) => ReturnType<NativeExecutionHarness["run"]>;
};
/** Same native tools plus a shared owner for explicit command and graph execution. */
function registerJevToolsWithHarness(pi: ExtensionAPI): GraphExecutionHarness {
  const taskReview = registerNativeTaskReview(pi);
  const openPlan = registerPlanWidgets(pi);
  const memoryOwner = delegationMemoryOwner();
  const treeOwner = taskTreeOwner();
  // I/O lifecycle registry only. Every invocation keeps its own reducer state.
  const activeExecutions = new Map<AbortController, Promise<void>>();
  let lifecycleWired = false, executionClosed = false;
  const stopExecutions = async () => {
    for (const controller of activeExecutions.keys()) controller.abort();
    await Promise.allSettled([...activeExecutions.values()]);
  };
  const withActiveExecution = async <T>(ctx: Parameters<NativeExecutionHarness["run"]>[1], signal: AbortSignal | undefined,
    run: (signal: AbortSignal, access?: FullAccessLease) => Promise<T>): Promise<T> => {
    if (executionClosed) throw new Error("Native execution owner is closed; no retry.");
    if (!lifecycleWired) {
      try {
        pi.on("session_before_switch", stopExecutions); pi.on("session_before_fork", stopExecutions);
        pi.on("session_before_tree", stopExecutions); pi.on("session_before_compact", stopExecutions);
        pi.on("session_shutdown", async () => { executionClosed = true; await stopExecutions(); });
        lifecycleWired = true;
      } catch { throw new Error("Native execution lifecycle unavailable; no retry or fallback."); }
    }
    const controller = new AbortController(), lease = access.lease(ctx);
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(lease ? [lease.signal] : [])]);
    let done = () => {};
    activeExecutions.set(controller, new Promise<void>((resolve) => { done = resolve; }));
    try { return await run(combined, lease); }
    finally { activeExecutions.delete(controller); done(); }
  };
  let executionUncertain = false;
  const access = registerDelegationAccess(pi, { isBusy: () => executionClosed || executionUncertain || activeExecutions.size > 0, cancel: stopExecutions });
  let lastFailure: { readonly sessionId: string; readonly text: string } | undefined;
  let failureGeneration = 0;
  const clearFailure = () => { lastFailure = undefined; failureGeneration++; };
  pi.on("session_before_switch", clearFailure); pi.on("session_before_fork", clearFailure); pi.on("session_before_tree", clearFailure);
  pi.on("session_before_compact", clearFailure); pi.on("session_shutdown", clearFailure);
  const captureFailure = (ctx: Parameters<NativeExecutionHarness["run"]>[1], text: string, generation: number) => {
    if (generation !== failureGeneration) return;
    try { const sessionId = ctx.sessionManager.getSessionId(); if (sessionId) lastFailure = { sessionId, text }; } catch { /* No cross-session receipt. */ }
  };
  const execution: GraphExecutionHarness = {
    access,
    isBusy: () => executionClosed || executionUncertain || activeExecutions.size > 0,
    blockedReason: () => executionClosed ? "closed" : executionUncertain ? "uncertain" : undefined,
    lastFailure: ctx => { try { return lastFailure?.sessionId === ctx.sessionManager.getSessionId() ? lastFailure?.text : undefined; } catch { return undefined; } },
    cancel: stopExecutions,
    run: async (input, ctx, signal, onProgress, observeUi, onPlan, memoryOptions) => {
      if (executionUncertain) throw new Error("Native execution ownership is uncertain; no new task or recovery.");
      if (activeExecutions.size > 0) throw new Error("Another native execution is active; no parallel task or retry.");
      clearFailure(); const failureLease = failureGeneration;
      return await withActiveExecution(ctx, signal, (ownSignal, lease) => withJevSession(ctx, async () => {
        const panel = openPlan(ctx, ownSignal);
        try {
          const result = await ordinaryDelegate(input, ctx, ownSignal, onProgress, undefined, observeUi, view => {
            if (panel.isCurrent()) { panel.update(view); onPlan?.(planReceipt(view)); }
          }, memoryOptions, lease);
          if (!result.cleanupConfirmed || result.lockRetained) executionUncertain = true;
          if (result.status === "stopped") captureFailure(ctx, [basicRunSummary(result), ...(result.workerRounds ? [workerRoundsText(result.workerRounds, result.workerRoundsCoverage)] : [])].join("\n"), failureLease);
          return result;
        } catch {
          executionUncertain = true;
          throw new Error("Native execution stopped with uncertain ownership; no retry, fallback or recovery.");
        } finally { panel.close(); }
      }));
    },
  };
  pi.registerTool({
    name: "jev_route",
    label: "JEV Router",
    description: "Recommend an eligible agent via JEV or explicit baseline; never execute or authorize.",
    promptSnippet: "Agent recommendation only",
    promptGuidelines: [
      languageGuideline("jev_route"),
      "jev_route: Explicit non-sensitive task/rubrics only. No secrets/history or retries.",
      "jev_route: Execute via jev_delegate; never duplicate routing.",
    ],
    parameters: Type.Object({
      task: Type.String({ minLength: 1, maxLength: LIMITS.task, description: "Concise English task summary. Preserve quoted artifacts verbatim; do not include secrets." }),
      agents: Type.Array(Type.Object({
        name: Type.String({ minLength: 1, maxLength: LIMITS.name, pattern: AGENT_NAME_PATTERN }),
        description: Type.String({ minLength: 1, maxLength: LIMITS.description, description: "English rubric describing when this agent should handle the task." }),
      }), { minItems: 2, maxItems: LIMITS.agents }),
      softRouting: Type.Optional(SoftRoutingSchema),
      skillCandidates: Type.Optional(SkillCandidatesSchema),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = await withJevSession(ctx, () => route(params, signal, (status) => updateProgress(onUpdate, status)));
      if (state.status !== "succeeded") {
        const message = state.status === "failed" ? state.error : `JEV routing ${state.status}.`;
        throw new Error(`${message}${"jev" in state && state.jev ? `\n${JSON.stringify(state)}` : ""}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(state.decision) }],
        details: state,
      };
    },
  });

  pi.registerTool({
    name: "jev_decide",
    label: "JEV Decision",
    description: "Judge options or worker_budget once; >=50% support recommends, otherwise ask_user. Budget choice stays within its ceiling. Advice, not authority.",
    promptSnippet: "JEV option advice before ordinary clarification",
    promptGuidelines: [
      languageGuideline("jev_decide"),
      "jev_decide: Prefer ordinary advice before asking. Explicit non-sensitive context/options only; no source/paths/profiles/history/logs/secrets or auto-collection. Never repeat unchanged questions.",
      "jev_decide: requiresHuman=true bypasses JEV for mandatory/high-stakes approval. Execution/transmission/destructive approvals cannot be delegated or downgraded.",
      "jev_decide: Advice is not permission/proof. needs_user: pass askUser unchanged to ask_user; if unavailable stop. No invented support, auto-choice, retries or duplicate routing/completion assessment.",
      "jev_decide: worker_budget is optional legacy/manual advice, never an SDK execution prerequisite. Read-only tools exclude bash/write. Never copy profile capabilities or use advice to restore/extend a grant. Ordinary runs default to SDK completion; no predicted count is required."
    ],
    parameters: Type.Union([DecisionInputSchema, WorkerBudgetInputSchema]),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (Object.getOwnPropertyDescriptor(params, "kind")?.value === "worker_budget") {
        const diagnostic = workerBudgetDiagnostic(params);
        if (diagnostic || !Value.Check(WorkerBudgetInputSchema, params)) {
          const reason = diagnostic ?? "invalid_input";
          throw new Error(`Worker budget advice stopped (${reason}). ${WORKER_BUDGET_REMEDIES[reason]}`);
        }
        const budgetInput = structuredClone(params);
        const decision = workerBudgetDecision(budgetInput);
        if (!decision) {
          const reason = "invalid_decision_packet";
          throw new Error(`Worker budget advice stopped (${reason}). ${WORKER_BUDGET_REMEDIES[reason]}`);
        }
        const state = await withJevSession(ctx, () => decide(decision, signal, status => updateProgress(onUpdate, status)));
        const outcome = workerBudgetOutcome(budgetInput, state);
        if (outcome.status === "failed" || outcome.status === "cancelled") throw new Error(`Worker budget advice ${outcome.status}.\n${JSON.stringify(outcome)}`);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: outcome };
      }
      if (!Value.Check(DecisionInputSchema, params)) throw new Error("Invalid decision input; no JEV request or authority was created.");
      const state = await withJevSession(ctx, () => decide(params, signal, (status) => updateProgress(onUpdate, status)));
      if (state.status === "failed" || state.status === "cancelled") throw new Error(`JEV decision ${state.status}.\n${JSON.stringify(state)}`);
      return { content: [{ type: "text", text: JSON.stringify(state) }], details: state };
    },
  });

  pi.registerTool({
    name: "jev_delegate",
    label: "JEV Delegate",
    description: "Prefer for bounded repository investigation and coding.",
    promptSnippet: "Prefer approved delegation",
    promptGuidelines: [
      languageGuideline("jev_delegate"),
      "jev_delegate: Parent prepares candidates, files, trees/references and continuations; users delegate naturally, no JSON. Reviewed: exact job review. Only native /jev-subagents access full enables session execution/sharing/evidence; never config/history/tool grants.",
      "jev_delegate: Before parallelRead tasks, decide split/count via ordinary JEV advice/planning. Approved1..3 read-only tasks=1..3 lanes;3 is a safety ceiling. No pool JEV decision/extra width/planner call. scope/graph stay sequential; Reviewed retains tree/generated-body reviews.",
      "jev_delegate: prefer bounded delegation before doing the work yourself, without explicit request. Answer general questions directly; respect opt-outs. Clarify unclear/oversized tasks.",
      "jev_delegate: Defaults unless restricted: scout alone for read-only investigation; [\"worker\",\"worker_strong\"] for implementation so JEV chooses. Never widen read-only work to writing roles. Missing profiles need /jev-subagents setup; no invented/automatic profiles.",
      "jev_delegate: softRouting baseline:'worker', consultProbability=1 (not learned); invalid baseline stops.",
      "jev_delegate: Default Reviewed. SDK-native rounds (null/omitted); caps/seconds bind (default/max86400). No renewal; retain accounting/ownership. Full Access keeps tools/files/models/checks/limits.",
      "jev_delegate: Fixed model/thinking; never secrets/history. do not call jev_route first. One plan skips routing, not approval. No duplicate route/planner/judge calls or model inheritance.",
      "jev_delegate: No Goal/SoL-Pi control; standalone SoL-Pi stays separate. use only an agreed verification command/argv, no implicit shell. No verifier=unverified; no criteria=no assessment.",
      "jev_delegate: Criteria: passed verification.description; separate human approval to send bounded evidence in Reviewed, or live Full Access. Advice is not proof. stop on decline, cancellation, failure, incomplete or needs_review. No automatic retry/fallback/escalation/redelegation; fresh authorization required. No sandbox/rollback.",
    ],
    executionMode: "sequential",
    parameters: DelegateToolInputSchema,
    renderCall(_args, theme) {
      // Do not echo private task/argv/profile data in a default tool row.
      return nativeToolText(theme.fg("toolTitle", "JEV · Delegation"));
    },
    renderResult(result, options, theme, context) {
      const view = delegateResultView(result, { ...options, isError: context?.isError === true });
      let details: Record<string, unknown> | undefined;
      try {
        const data: unknown = Object.getOwnPropertyDescriptor(result, "details")?.value;
        if (data && typeof data === "object") details = data as Record<string, unknown>;
        const kind: unknown = details ? Object.getOwnPropertyDescriptor(details, "kind")?.value : undefined;
        if (kind === "parallel_read" || kind === "parallel_read_progress") return nativeToolText(theme.fg("muted", parallelReadText(details)));
      } catch { return nativeToolText(theme.fg("muted", "JEV · Inspect state / private data withheld")); }
      if (details && Object.getOwnPropertyDescriptor(details, "kind")?.value === "tree_parent")
        return nativeToolText(theme.fg("warning", "JEV · Task tree waiting for current-parent choice or generated information. No authority or deadline extension."));
      if (details && Object.getOwnPropertyDescriptor(details, "kind")?.value === "delegation_memory_choice")
        return nativeToolText(theme.fg("warning", "JEV · Current parent must select approved memory / no worker started. No new approval or model request."));
      const plan: unknown = details ? Object.getOwnPropertyDescriptor(details, "plan")?.value : undefined;
      if (validPlanReceipt(plan)) return { render: (width: number) => [...renderPlan(plan, width, theme, !options.expanded),
        ...nativeToolText(theme.fg(view.tone, view.text)).render(width)], invalidate() {} };
      return nativeToolText(theme.fg(view.tone, view.text));
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!Value.Check(DelegateToolInputSchema, params)) throw new Error("Invalid ordinary delegation input; Goal, memory grants and SoL-Pi integration are not available.");
      let approvalUi: ApprovalUiDiagnostic | undefined;
      const observeUi: ApprovalUiObserver = value => {
        approvalUi = value;
        const text = approvalUiText(value);
        if (text) return onUpdate?.({ content: [{ type: "text", text: `JEV · ${text}` }], details: { kind: "approval_ui_diagnostic", approvalUi: value } });
      };
      if ("tree" in params || "treeContinue" in params) {
        const result = "treeContinue" in params ? await treeOwner.continue(params.treeContinue, ctx, signal, () => { void stopExecutions(); }) : await treeOwner.start(ctx, parent => {
          if (executionClosed || executionUncertain || activeExecutions.size > 0) throw new Error("Execution owner closed, busy or uncertain; no task tree admission or retry.");
          clearFailure(); const generation = failureGeneration;
          return withActiveExecution(ctx, signal, (ownSignal, lease) => withJevSession(ctx, async () => {
            const panel = openPlan(ctx, ownSignal);
            try {
              const result = await taskTree(params.tree, ctx, ownSignal, undefined, view => {
                if (!ownSignal.aborted && panel.isCurrent()) { panel.update(view); updatePlan(onUpdate, view); }
              }, parent, observeUi, lease);
              if (!result.cleanupConfirmed || result.lockRetained || result.metrics.reservedModelCalls !== 0 || result.metrics.reservedJevRequests > 0) executionUncertain = true;
              if (result.status === "stopped") captureFailure(ctx, "Task tree stopped; inspect accounting and cleanup. No retry or fallback.", generation);
              return result;
            } catch { executionUncertain = true; throw new Error("Task tree ownership is uncertain; no retry or fallback."); }
            finally { panel.close(); }
          }));
        });
        if (result.kind === "tree_parent") return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        const observed = { ...result, ...(result.plan ? { plan: planReceipt(result.plan) } : {}), ...(approvalUi ? { approvalUi } : {}) };
        if (result.status === "stopped") throw new Error(`Task tree stopped; execution is not acceptance.\n${JSON.stringify(observed)}`);
        return { content: [{ type: "text", text: JSON.stringify(observed) }], details: observed };
      }
      if ("parallelRead" in params) {
        if (executionClosed || executionUncertain || activeExecutions.size > 0) throw new Error("Execution owner closed, busy or uncertain; no parallel batch admission or retry.");
        clearFailure(); const generation = failureGeneration;
        const result = await withActiveExecution(ctx, signal, (ownSignal, lease) => parallelRead(params.parallelRead, ctx, ownSignal, undefined, value => {
          const data = { kind: "parallel_read_progress", ...value };
          try { void Promise.resolve(onUpdate?.({ content: [{ type: "text", text: parallelReadText(data) }], details: data })).catch(() => {}); } catch { /* Display is not authority. */ }
        }, observeUi, lease));
        if (!result.cleanupConfirmed || result.reservedModelCalls === null || result.reservedModelCalls > 0) executionUncertain = true;
        const observed = { ...result, ...(approvalUi ? { approvalUi } : {}) };
        if (result.status === "stopped") { captureFailure(ctx, parallelReadText(result), generation); throw new Error(`Read-only batch stopped; no automatic retry or fallback.\n${JSON.stringify(observed)}`); }
        return { content: [{ type: "text", text: JSON.stringify(observed) }], details: observed };
      }
      if ("scope" in params || "graph" in params || "memoryChoice" in params) {
        let result: OrdinaryPublicResult | DelegationMemoryPause;
        if ("memoryChoice" in params) result = await memoryOwner.choose(params.memoryChoice, ctx, signal, () => { void execution.cancel(); });
        else {
          const run = (onMemoryLookup?: DelegationMemoryParent) => execution.run("graph" in params ? params.graph : params.scope, ctx, signal,
            phase => updateProgress(onUpdate, phase), observeUi, plan => { updatePlan(onUpdate, plan); },
            params.memory ? { memory: params.memory, ...(onMemoryLookup ? { onMemoryLookup } : {}) } : undefined);
          result = params.memory ? await memoryOwner.start(ctx, parent => run(parent)) : await run();
        }
        if (result.kind === "delegation_memory_choice") return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        const observed = { ...result, ...(approvalUi ? { approvalUi } : {}) };
        if (result.status === "stopped") throw new Error(`Scoped delegation stopped; no retry or rollback.\n${JSON.stringify(observed)}`);
        return { content: [{ type: "text", text: JSON.stringify(observed) }], details: observed };
      }
      if (executionClosed || executionUncertain || activeExecutions.size > 0) throw new Error("Execution owner closed, busy or uncertain; no competing single-worker admission or retry.");
      return await withActiveExecution(ctx, signal, async (signal, lease) => {
        const authorization = lease ? { authorization: lease.source } : {};
        const panel = openPlan(ctx, signal);
        let single: PlanView | undefined;
        const publish = (view: PlanView) => {
          if (!panel.isCurrent() || signal?.aborted) return;
          single = view; panel.update(view); updatePlan(onUpdate, view);
        };
        const presentApproval: RunApproval = (content, context, approvalSignal) => {
          const s = content.summary;
          publish({ phase: "approval", elapsedMs: 0, seconds: s.seconds ?? 120, modelCalls: 0,
            nodes: [{ id: "task-1", title: s.task, after: [], state: "waiting", agent: s.role, model: s.model, thinking: s.thinking }] });
          return taskReview.confirm(content, context, approvalSignal, observeUi);
        };
        clearFailure(); const failureLease = failureGeneration;
        let state: Awaited<ReturnType<typeof delegate>>;
        try {
          state = await withJevSession(ctx, () => delegate(params, ctx, signal, status => {
            updateProgress(onUpdate, status, lease);
            if (single && status === "running") publish({ ...single, phase: "running" });
            if (single && status === "verifying") {
              const { currentTool: _lastTool, ...view } = single;
              publish({ ...view, phase: "checking", nodes: view.nodes.map(node => ({ ...node, state: "completed" })) });
            }
          }, presentApproval, (progress, run) => {
            publish({ phase: "running", elapsedMs: progress.elapsedMs, seconds: run.seconds ?? 120, modelCalls: progress.modelCalls,
              ...(progress.currentTool ? { currentTool: progress.currentTool } : {}),
              nodes: [{ id: "task-1", title: run.task, after: [], state: "running", agent: run.agent.name,
                model: `${run.model.provider}/${run.model.id}`, thinking: run.agent.thinking ?? "off" }] });
          }, lease));
        } finally { panel.close(); }
        const finalPlan = single ? planReceipt({ ...single, phase: state.status === "succeeded" ? "finished" : "stopped",
          modelCalls: state.metrics.worker.modelCalls ?? single.modelCalls,
          nodes: single.nodes.map(node => ({ ...node, state: "result" in state ? "completed" : (state.metrics.worker.modelCalls ?? 0) > 0 ? "failed" : "blocked" })) }) : undefined;
        const costEstimate = estimateCost(state.metrics);
        if (state.status === "failed" || state.status === "cancelled" || state.status === "incomplete" || state.status === "needs_review") {
          const message = state.status === "failed" ? state.error : state.status === "cancelled"
            ? state.reason === "declined" ? "Execution approval not received. Human decline, cancellation, expiry or UI failure are not inferred from a missing positive reply. Do not retry."
              : "Delegation cancelled. Changes may be incomplete; no rollback was performed."
            : state.status === "incomplete" ? "Task assessed incomplete. No automatic rework or retry; changes remain."
              : "Task needs human review or more evidence. No automatic rework or retry; changes remain.";
          captureFailure(ctx, delegateResultView({ details: { ...state, ...authorization, costEstimate, ...(approvalUi ? { approvalUi } : {}) } },
            { isPartial: false, expanded: true, isError: true }).text, failureLease);
          // pi requires throwing to mark errors. Keep failure/cancellation accounting in that result, too.
          throw new Error(`${message}\n${JSON.stringify({ ...state, ...authorization, costEstimate, ...(finalPlan ? { plan: finalPlan } : {}), ...(approvalUi ? { approvalUi } : {}) })}`);
        }
        if (state.status !== "succeeded") throw new Error(`Delegation ${state.status}.`);
        const { result, metrics } = state;
        return {
          content: [{ type: "text", text: `${JSON.stringify({ status: state.status, ...authorization, taskAcceptance: "needs_human_review", agent: state.agent, model: state.model,
            thinking: metrics.profile?.thinking, decision: { source: state.decision.source,
              ...(state.decision.source === "jev" && state.decision.skillSuggestion ? { skillSuggestion: state.decision.skillSuggestion } : {}) },
            verification: state.verification, assessment: { status: state.assessment.status },
            costEstimate: { observedUsd: costEstimate.observedUsd, delegationTotalUsd: costEstimate.delegationTotalUsd },
            truncated: result.truncated })}\n\n${result.text}` }],
          details: { ...state, ...authorization, taskAcceptance: "needs_human_review", costEstimate, ...(finalPlan ? { plan: finalPlan } : {}), ...(approvalUi ? { approvalUi } : {}) },
        };
      });
    },
  });

  registerProjectMemoryTool(pi);
  return execution;
}

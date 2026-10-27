import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { approvalUiText } from "./approval-ui-diagnostics.ts";
import { MODEL_CALL_LIMIT_ERROR, WORKER_ERROR, MAX_RUN_SECONDS, executionTimeoutMessage } from "./delegate-machine.ts";
import { Value } from "typebox/value";
import { WorkerRoundsSchema, WorkerRoundCoverageSchema, workerRoundsText } from "./worker-rounds.ts";
import { directoryIssueRows } from "./directory-diagnostics.ts";
import { durationText } from "./task-review-machine.ts";
import { validPlanReceipt } from "./plan-state.ts";
import { workerDiagnosticView } from "./worker-diagnostic-view.ts";

export type DelegateView = { readonly text: string; readonly tone: "muted" | "warning" | "error" };
export type DelegateViewOptions = ToolRenderResultOptions & { readonly isError: boolean };
const phases: Readonly<Record<string, string | undefined>> = {
  loading: "Loading profiles", routing: "Selecting candidates", preparing_harness: "Checking the declared runtime",
  preparing: "Preparing scope", selecting: "Selecting an approved worker", checking: "Rechecking permissions and scope",
  awaiting_approval: "Awaiting execution approval", running: "Worker running", verifying: "Running declared verification",
  awaiting_assessment_approval: "Awaiting assessment-transmission approval", judging: "Assessing approved evidence",
};
const ordinaryPhaseLabels: Readonly<Record<string, string | undefined>> = {
  interface: "Approval UI support", preparing: "Preparation", awaiting_approval: "Exact-source approval", selecting: "Worker selection",
  checking: "Permission/scope recheck", running: "Worker execution", cleanup: "Owned cleanup",
};
const ordinaryPreparationLabels: Readonly<Record<string, string | undefined>> = {
  input: "Input validation", directories: "Workspace/configuration directory validation", file_scope: "Existing file/type/protected-path validation",
  model_profile: "Fixed model/profile validation", instructions: "Instruction/configuration version validation", routing_configuration: "JEV connection validation",
  prepared_scope: "Immutable scope preparation", freshness: "Prepared-scope freshness",
};
const failures = new Set(["failed", "cancelled", "incomplete", "needs_review", "stopped"]);
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const label = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 128 &&
  /^[\p{L}\p{N}_.:/+-]+$/u.test(value) ? value : undefined;
const amount = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const money = (value: number | undefined) => value === undefined ? "unknown" : `$${value === 0 ? 0 : Number(value.toPrecision(8))}`;
function workerFailureRows(data: Record<string, unknown>): readonly string[] {
  const metrics = record(data.metrics), worker = record(metrics?.worker), profile = record(metrics?.profile);
  const diagnostic = workerDiagnosticView(Object.getOwnPropertyDescriptor(worker ?? {}, "diagnostic")?.value);
  const category = diagnostic.cause, stage = diagnostic.stage;
  const error: unknown = data.error;
  const seconds = typeof profile?.seconds === "number" && Number.isSafeInteger(profile.seconds) && profile.seconds >= 1 && profile.seconds <= MAX_RUN_SECONDS ? profile.seconds : undefined;
  const timeout = error === executionTimeoutMessage(seconds === undefined ? {} : { seconds });
  const reason = timeout ? `Approved execution deadline reached (${durationText(seconds ?? 120)})` : error === MODEL_CALL_LIMIT_ERROR ? "Approved SDK model-round cap reached (no automatic increase/retry)"
    : error === "Windows subagent execution or process-tree cleanup failed. Changes may be incomplete." ? "Worker execution/process cleanup unconfirmed"
      : record(data.verification)?.status === "failed" ? "Declared verification command failed" : category ?? (error === WORKER_ERROR ? "Worker error / private details withheld" : "Cause unavailable");
  const validCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const calls = validCount(worker?.modelCalls), cap = validCount(profile?.maxModelCalls), accounting = record(worker?.accounting);
  const http = diagnostic.httpStatus;
  return [`Stop reason · ${reason}${stage ? ` · ${stage}` : ""}${http ? ` · HTTP ${http}` : ""}`,
    ...(calls !== undefined ? [`Worker SDK ${calls}${cap !== undefined ? `/${cap}` : profile?.maxModelCalls === null ? " · no round cap" : ""} · accounting ${accounting?.status === "reported" && accounting.complete === true ? "reported" : "partial/unknown"}`] : []),
  ];
}

// Pi throws tool errors with no details. Only read the bounded final JSON record
// produced by our adapter; never render the error string or a worker's text.
function failureRecord(result: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(result.content)) return undefined;
  const first = record(result.content[0]);
  if (first?.type !== "text" || typeof first.text !== "string" || first.text.length > 524_288) return undefined;
  const newline = first.text.lastIndexOf("\n");
  if (newline < 0) return undefined;
  try {
    const parsed = record(JSON.parse(first.text.slice(newline + 1)));
    return parsed && typeof parsed.status === "string" && failures.has(parsed.status) ? parsed : undefined;
  } catch { return undefined; }
}

/** Human-only, pure native tool projection. It cannot grant work, alter accounting,
 * start IO, localize model packets, or turn a worker claim into task acceptance. */
export function delegateResultView(input: unknown, options: DelegateViewOptions): DelegateView {
  try {
    const result = record(input), details = record(result?.details);
    if (options.isPartial && !options.isError) {
      const phase = typeof details?.phase === "string" && Object.hasOwn(phases, details.phase) ? phases[details.phase] : undefined;
      const diagnostic = details ? approvalUiText(Object.getOwnPropertyDescriptor(details, "approvalUi")?.value) : undefined;
      return { text: `JEV · ${diagnostic ?? phase ?? "Checking progress"}`, tone: "muted" };
    }
    const data = options.isError ? details && typeof details.status === "string" && failures.has(details.status)
      ? details : result ? failureRecord(result) : undefined : details;
    const status = data?.status;
    const approval = data ? approvalUiText(Object.getOwnPropertyDescriptor(data, "approvalUi")?.value) : undefined;
    if (data?.kind === "task_tree") {
      const metrics = record(data.metrics);
      const count = (key: string, max = Number.MAX_SAFE_INTEGER) => { const value = metrics ? Object.getOwnPropertyDescriptor(metrics, key)?.value : undefined;
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : "unknown"; };
      const complete = !options.isError && status === "completed_unverified" && data.taskAcceptance === "needs_human_review" && data.cleanupConfirmed === true &&
        metrics?.reservedModelCalls === 0 && metrics?.reservedJevRequests === 0;
      const observed = amount(metrics?.observedUsd), total = amount(metrics?.totalUsd);
      return { tone: complete ? "muted" : "warning", text: [
        `JEV · Task tree ${complete ? "ended / unverified / human review required" : "stopped / no automatic retry"}`,
        `Workers ${count("workersStarted", 3)} · reported SDK ${count("modelCalls")} · reserved ${metrics?.reservedModelCalls === null ? "pending / no round cap" : count("reservedModelCalls")} · JEV requests ${count("jevRequests", 3)}`,
        `Observed estimate ${money(observed)} · delegation total ${money(observed !== undefined && total !== undefined && total >= observed ? total : undefined)} (parent excluded / not an invoice)`,
        ...(complete ? [] : ["Changes may remain. Cancellation is not rollback; unknown accounting/cleanup is retained."]),
        ...(approval ? [approval] : []),
      ].join("\n") };
    }
    if (data?.kind === "ordinary_scope") {
      const complete = !options.isError && status === "completed_unverified" && data.taskAcceptance === "needs_human_review" && data.cleanupConfirmed === true && data.lockRetained === false;
      const count = (key: string, max: number) => typeof data[key] === "number" && Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= max ? data[key] : "unknown";
      const cost = record(data.costEstimate), observed = amount(cost?.observedUsd), total = amount(cost?.delegationTotalUsd);
      const lines = [`JEV · ${complete ? "Plan execution ended / unverified / human review required" : "Plan stopped / no automatic retry"}`,
        `Workers ${count("workersStarted", 3)} · reported SDK ${count("modelCalls", Number.MAX_SAFE_INTEGER)} · reserved ${data.reservedModelCalls === null ? "pending / no round cap" : count("reservedModelCalls", Number.MAX_SAFE_INTEGER)} · JEV requests ${count("jevRequests", validPlanReceipt(data.plan) && data.plan.version === 2 ? 16 : 3)}`,
        `Observed estimate ${money(observed)} · delegation total ${money(observed !== undefined && total !== undefined && total >= observed ? total : undefined)} (parent excluded / not an invoice)`];
      if (approval) lines.push(approval);
      const automatic = record(Object.getOwnPropertyDescriptor(data, "automaticSelection")?.value), selected = record(automatic?.model);
      const selectedProvider = label(selected?.provider), selectedId = label(selected?.id);
      if (selectedProvider && selectedId) lines.push(`Selected model ${selectedProvider}/${selectedId} · thinking ${label(automatic?.thinking) ?? "unconfirmed"}`);
      const recommendations = Object.getOwnPropertyDescriptor(data, "automaticRecommendations")?.value;
      if (Array.isArray(recommendations) && recommendations.length <= 2) for (const raw of recommendations) {
        const item = record(raw), model = record(item?.model), provider = label(model?.provider), id = label(model?.id), support = item?.support;
        if (item?.executionAuthorized === false && provider && id && typeof support === "number" && Number.isFinite(support) && support >= 0 && support < 0.5) {
          lines.push(`Weak JEV advice ${provider}/${id} · support ${support} · explicit worker review required`);
        }
      }
      const advice = record(Object.getOwnPropertyDescriptor(data, "automaticAdvice")?.value), recommended = record(advice?.model);
      const recommendedProvider = label(recommended?.provider), recommendedId = label(recommended?.id), support = advice?.support;
      if (advice?.executionAuthorized === false && recommendedProvider && recommendedId && typeof support === "number" && Number.isFinite(support) && support >= 0 && support <= 1) {
        lines.push(`JEV recommendation only ${recommendedProvider}/${recommendedId} · support ${support} · not executed`);
      }
      if (data.reason === "undecided") lines.push("JEV selection support below threshold / no alternative executed / fresh review required.");
      if (!complete) {
        const diagnostic = record(Object.getOwnPropertyDescriptor(data, "diagnostic")?.value);
        const stage: unknown = diagnostic ? Object.getOwnPropertyDescriptor(diagnostic, "preparationStage")?.value : undefined;
        const phase: unknown = diagnostic ? Object.getOwnPropertyDescriptor(diagnostic, "phase")?.value : undefined;
        const preparation = typeof stage === "string" && Object.hasOwn(ordinaryPreparationLabels, stage) ? ordinaryPreparationLabels[stage] : undefined;
        const operation = typeof phase === "string" && Object.hasOwn(ordinaryPhaseLabels, phase) ? ordinaryPhaseLabels[phase] : undefined;
        if (preparation ?? operation) lines.push(`Diagnostic: stopped during ${preparation ?? operation}; private error details withheld.`);
        const worker = workerDiagnosticView(Object.getOwnPropertyDescriptor(data, "workerFailure")?.value);
        const reported = [worker.cause, worker.stage, worker.httpStatus === undefined ? undefined : `HTTP ${worker.httpStatus}`].filter(value => value !== undefined);
        if (reported.length) lines.push(`Reported worker diagnostic · ${reported.join(" · ")}`);
        const issues = directoryIssueRows(Object.getOwnPropertyDescriptor(diagnostic ?? {}, "directoryIssues")?.value);
        lines.push(...issues);
        if (stage === "directories" && !issues.length) lines.push("No recorded cause code. Use /jev-subagents doctor for current read-only checks; no historical cause is inferred.");
        const beforeAdmission = phase === "preparing" && stage === "directories" &&
          data.workersStarted === 0 && data.modelCalls === 0 && data.reservedModelCalls === 0 && data.jevRequests === 0;
        lines.push(beforeAdmission ? "Directory preparation refused before approval: no worker/model/JEV admission or task-file changes. Uncertain native cleanup remains recorded."
          : "Changes may remain. Cancellation is not rollback. Uncertain ownership/accounting stays retained.");
      }
      if (options.expanded) {
        const rounds = data.workerRounds, coverage = data.workerRoundsCoverage;
        if (Value.Check(WorkerRoundsSchema, rounds) && (rounds.length || Value.Check(WorkerRoundCoverageSchema, coverage))) {
          lines.push(workerRoundsText(rounds, Value.Check(WorkerRoundCoverageSchema, coverage) ? coverage : "unknown"));
        }
        lines.push("Worker text, prompts, packets and raw logs are not displayed here. Execution ending is not final acceptance.");
      }
      return { text: lines.join("\n"), tone: complete ? "muted" : "warning" };
    }
    const succeeded = !options.isError && status === "succeeded" && data?.taskAcceptance === "needs_human_review";
    const declined = status === "cancelled" && data?.reason === "declined";
    const title = succeeded ? "Execution ended / final acceptance needs human review"
      : declined ? "Positive execution approval unconfirmed / no automatic retry"
      : status === "cancelled" ? "Execution cancelled / no automatic retry"
      : status === "incomplete" ? "Incomplete / no automatic repair or retry"
      : status === "needs_review" ? "Review required / no automatic repair or retry" : "Execution stopped / no automatic retry / inspect status";
    const lines = [`JEV · ${title}`], metrics = record(data?.metrics), profile = record(metrics?.profile);
    const agent = label(data?.agent) ?? label(profile?.agent), model = record(data?.model) ?? record(profile?.model);
    const provider = label(model?.provider), id = label(model?.id);
    const thinking = typeof profile?.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.thinking) ? profile.thinking : undefined;
    if (agent || (provider && id)) lines.push([agent ? `Worker ${agent}` : "", provider && id ? `Model ${provider}/${id}` : "",
      thinking ? `Requested thinking ${thinking}` : ""].filter(Boolean).join(" · "));
    if (succeeded) {
      const verification = record(data?.verification);
      lines.push(verification?.status === "passed" && verification.exitCode === 0 ? "Verification: declared checks passed (not proof of all requirements)"
        : verification?.status === "not_requested" ? "Verification: not requested / execution unverified" : "Verification: result unknown");
    } else if (!declined) lines.push("Changes may remain. Cancellation/failure is neither rollback nor proof of cleanup.");
    if (!succeeded && !declined && data) lines.push(...workerFailureRows(data));
    if (approval) lines.push(approval);
    const cost = record(data?.costEstimate), observed = amount(cost?.observedUsd), candidateTotal = amount(cost?.delegationTotalUsd);
    const total = observed !== undefined && candidateTotal !== undefined && candidateTotal >= observed ? candidateTotal : undefined;
    lines.push(`Observed estimate ${money(observed)} · delegation total ${money(total)} (parent excluded / not an invoice)`);
    if (options.expanded) {
      const worker = record(metrics?.worker);
      const category = workerDiagnosticView(Object.getOwnPropertyDescriptor(worker ?? {}, "diagnostic")?.value).cause;
      if (category) lines.push(`Diagnostic: ${category}`);
      const rounds = worker?.rounds, coverage = worker?.roundsCoverage;
      if (Value.Check(WorkerRoundsSchema, rounds) && (rounds.length || Value.Check(WorkerRoundCoverageSchema, coverage))) {
        lines.push(workerRoundsText(rounds, Value.Check(WorkerRoundCoverageSchema, coverage) ? coverage : "unknown"));
      }
      lines.push("Worker claims and assessment advice are not completion proof. Source, JSON and raw logs stay hidden here.");
    }
    return { text: lines.join("\n"), tone: succeeded ? "muted" : declined || status === "cancelled" || status === "needs_review" ? "warning" : "error" };
  } catch {
    return { text: "JEV · Inspect display state / private source withheld. Execution, verification and cleanup are unconfirmed.", tone: "warning" };
  }
}

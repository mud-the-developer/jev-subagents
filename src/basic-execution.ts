import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DelegationAccessCommands } from "./delegation-access-effects.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AGENT_NAME_PATTERN, LIMITS } from "./machine.ts";
import { DEFAULT_DELEGATE_MODEL_CALLS, DEFAULT_RUN_SECONDS, ExecutionSecondsSchema, ModelCallLimitSchema } from "./delegate-machine.ts";
import { OrdinaryScopeInputSchema, validOrdinaryScopeInput, type OrdinaryScopeInput } from "./ordinary-authorization.ts";
import type { OrdinaryPublicResult } from "./ordinary-effects.ts";
import type { ApprovalUiObserver } from "./approval-ui-diagnostics.ts";
import { directoryIssueRows } from "./directory-diagnostics.ts";
import { workerDiagnosticView } from "./worker-diagnostic-view.ts";
import { jevRequestFailureLabel } from "./jev-request-diagnostics.ts";
import type { PlanView } from "./plan-presentation.ts";
import { AutomaticDelegateInputSchema, validAutomaticInput, type AutomaticDelegateInput } from "./automatic-input.ts";

/** One explicit profile and one task. No planner, routing, verifier, pool or caller grant. */
export const BasicRunInputSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: LIMITS.task }),
  agent: Type.String({ minLength: 1, maxLength: LIMITS.name, pattern: AGENT_NAME_PATTERN }),
  modelSelection: Type.Optional(Type.Union([Type.Literal("fixed"), Type.Literal("available")])),
  files: OrdinaryScopeInputSchema.properties.files,
  maxModelCalls: Type.Optional(ModelCallLimitSchema),
  seconds: Type.Optional(ExecutionSecondsSchema),
}, { additionalProperties: false });
export type NativeExecutionHarness = {
  readonly access?: DelegationAccessCommands;
  readonly automatic?: (input: AutomaticDelegateInput, ctx: ExtensionContext, signal?: AbortSignal,
    onProgress?: (phase: string) => void) => Promise<OrdinaryPublicResult>;
  readonly isBusy: () => boolean;
  readonly blockedReason: () => "closed" | "uncertain" | undefined;
  readonly lastFailure: (ctx: ExtensionContext) => string | undefined;
  readonly cancel: () => Promise<void>;
  readonly run: (input: OrdinaryScopeInput, ctx: ExtensionContext, signal?: AbortSignal,
    onProgress?: (phase: string) => void, observeUi?: ApprovalUiObserver, onPlan?: (view: PlanView) => void) => Promise<OrdinaryPublicResult>;
};

/** Syntax and task mapping only. The existing ordinary reducer owns execution and authority. */
export function basicRunScope(value: unknown): OrdinaryScopeInput | undefined {
  if (!Value.Check(BasicRunInputSchema, value)) return undefined;
  const calls = value.maxModelCalls ?? DEFAULT_DELEGATE_MODEL_CALLS;
  const scope: OrdinaryScopeInput = { task: value.task, agents: [value.agent],
    files: value.files.map(file => ({ ...file })),
    tasks: [{ id: "task-1", summary: value.task, agent: value.agent }], selection: "parent_only",
    limits: { workerRuns: 1, modelCalls: calls, perWorkerCalls: calls, seconds: value.seconds ?? DEFAULT_RUN_SECONDS } };
  return validOrdinaryScopeInput(scope) ? scope : undefined;
}
export function parseBasicRun(text: string): OrdinaryScopeInput | undefined {
  if (!text || text.length > 20_000) return undefined;
  try { return basicRunScope(JSON.parse(text)); } catch { return undefined; }
}
export function fixedBasicRun(text: string): boolean {
  try { return JSON.parse(text)?.modelSelection === "fixed"; } catch { return false; }
}
export function parseAutomaticRun(text: string): AutomaticDelegateInput | undefined {
  if (!text || text.length > 20000) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    const schema = Type.Object({ ...AutomaticDelegateInputSchema.properties,
      agent: Type.Optional(BasicRunInputSchema.properties.agent), modelSelection: Type.Optional(Type.Literal("available")) }, { additionalProperties: false });
    if (!Value.Check(schema, value) || value.agent !== undefined && value.role !== undefined) return undefined;
    const { agent, modelSelection: _modelSelection, ...input } = value;
    const automatic = { ...input, ...(agent ? { role: agent } : {}) };
    return validAutomaticInput(automatic) ? automatic : undefined;
  } catch { return undefined; }
}
export const BASIC_RUN_HELP = [
  "JEV · Basic execution / current-task context and automatic available-model/thinking selection",
  'Default: worker permission template, or agent/role to choose a template. Profile model fields do not constrain automatic selection. modelSelection:"fixed" explicitly uses the profile model.',
  '/jev-subagents run {"agent":"scout","task":"Read sample.txt and report its content.","files":[{"path":"sample.txt","access":"read"}],"seconds":86400}',
  "Prepare task prose in English; only explicit existing workspace files with read/read_write access are approved.",
  "Default: one worker / SDK natural completion (no model-round cap) / up to 24 hours (seconds can narrow it). Rounds include tools and final reporting, not file count. Automatic mode selects model/thinking from the available worker catalog; explicit fixed mode uses the profile. Neither inherits the parent model.",
  "Reviewed requires fresh exact-source approval. Native /jev-subagents access full can authorize session delegation instead. Automatic mode separately reviews source/catalog before JEV selection. No Goal, verifier, assessment, install, fallback or retry.",
  "/jev-subagents cancel — stop and settle the owned run / /jev-subagents result — explicitly inspect the last unverified worker result in this session",
  "Stopping is not rollback. Uncertain ownership/accounting stays retained. Results are neither acceptance nor verification.",
].join("\n");
export function basicRunProgress(phase: string): string | undefined {
  const labels: Readonly<Record<string, string | undefined>> = { preparing: "Preparing task/files/permission template", awaiting_approval: "Awaiting exact-source approval",
    selecting: "Checking fixed worker/ownership", routing_models: "Selecting an available model via JEV", routing_thinking: "Selecting supported thinking for the chosen model", checking: "Rechecking permissions/files", running: "Worker running" };
  return Object.hasOwn(labels, phase) && labels[phase] ? `JEV · ${labels[phase]}` : undefined;
}
function basicRunStop(result: OrdinaryPublicResult): string {
  const reasons: Readonly<Record<string, string | undefined>> = { cancelled: "Cancelled", expired: "Deadline expired", budget: "Round/time limit reached",
    catalog_overflow: "Available catalog exceeds 128 models or 7 thinking levels per model; no candidates were silently dropped", no_available_models: "No configured worker-available model supports this task input",
    ambiguous_catalog: "Available model catalog contains ambiguous identities", invalid_catalog: "Available model metadata is invalid",
    changed: "Files/profile/session changed", declined: "Positive exact-source approval unconfirmed (not proof of user refusal)", invalid: "Input/permission scope mismatch", unknown: "Ownership/accounting unconfirmed", undecided: "JEV selection support below threshold / no alternative executed" };
  const phases: Readonly<Record<string, string | undefined>> = { interface: "UI/session check", preparing: "Task/files/profile preparation",
    awaiting_approval: "Exact-source approval", selecting: "Execution ownership", routing_models: "JEV model/thinking selection", routing_thinking: "JEV supported-thinking selection", checking: "Permissions/files recheck", running: "Worker execution", cleanup: "Owned cleanup" };
  const phase = result.diagnostic?.phase;
  const reason = Object.hasOwn(reasons, result.reason) ? reasons[result.reason] : undefined;
  const stage = phase && Object.hasOwn(phases, phase) ? phases[phase] : undefined;
  const routing = jevRequestFailureLabel(Object.getOwnPropertyDescriptor(result.diagnostic ?? {}, "routingFailure")?.value);
  const worker = workerDiagnosticView(Object.getOwnPropertyDescriptor(result, "workerFailure")?.value);
  const workerDetail = [worker.stage ? `Worker ${worker.stage}` : undefined, worker.cause,
    worker.httpStatus === undefined ? undefined : `HTTP ${worker.httpStatus}`].filter(value => value !== undefined).map(value => ` · ${value}`).join("");
  return `Stop reason · ${reason ?? (stage ? `Stopped during ${stage}` : "Execution unconfirmed")}${routing ? ` · ${routing}` : ""}${workerDetail} · Private error details withheld.`;
}
export function basicRunSummary(result: OrdinaryPublicResult): string {
  return [result.status === "completed_unverified" ? "JEV · Basic execution ended / unverified" : "JEV · Basic execution stopped / no automatic retry",
    `Workers ${result.workersStarted} · SDK ${result.modelCalls} · reserved ${result.reservedModelCalls === null ? "pending / no round cap" : result.reservedModelCalls}`,
    `JEV fetch attempts ${result.jevRequests} · pending ${result.reservedJevRequests} · reported usage receipts ${Array.isArray(result.jevReports) ? result.jevReports.length : "unknown"} · total cost ${result.costEstimate?.delegationTotalUsd == null ? "unknown" : `$${result.costEstimate.delegationTotalUsd}`}`,
    ...(result.automaticRecommendations?.map(advice => `JEV recommendation only / explicit worker review required · ${JSON.stringify(advice).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`) ?? []),
    ...(result.automaticAdvice ? [`JEV recommendation only / not executed · ${JSON.stringify(result.automaticAdvice).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`] : []),
    ...(result.automaticSelection ? [`Selected model/thinking · ${JSON.stringify(result.automaticSelection).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`] : []),
    ...(result.status === "stopped" ? [basicRunStop(result), ...directoryIssueRows(result.diagnostic?.directoryIssues)] : []),
    ...(result.diagnostic?.preparationStage === "directories" && result.workersStarted === 0 && result.modelCalls === 0 && result.jevRequests === 0
      ? ["Directory preparation refused before approval / no worker, model, JEV or task-file change"] : []),
    result.cleanupConfirmed && !result.lockRetained ? "Owned cleanup confirmed / not rollback" :
      result.workersStarted === 0 && !result.lockRetained && result.reservedJevRequests > 0 ? "JEV usage/accounting unconfirmed / no worker started / evidence retained / new execution blocked" :
      "Ownership/cleanup unknown / records retained / new execution blocked",
    result.reports.length ? "Result available / /jev-subagents result explicitly opens worker text (unverified)" : "No worker result",
    ...(result.status === "stopped" ? ["Next · inspect /jev-subagents doctor last and runtime",
      "Preserve retained files/locks; do not force cleanup or automatically retry."] : []),
  ].join("\n");
}
/** Explicit human output request only; never inject a worker claim into a collapsed tool row. */
export function basicRunOutput(result: OrdinaryPublicResult): string {
  return ["JEV · Worker source result / unverified / human review required",
    ...result.reports.map(report => `${report.agent}\n${report.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)}`),
    "A worker report is neither independent verification nor final acceptance.",
  ].join("\n\n");
}

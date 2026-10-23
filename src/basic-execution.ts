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
import type { PlanView } from "./plan-presentation.ts";

/** One explicit profile and one task. No planner, routing, verifier, pool or caller grant. */
export const BasicRunInputSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: LIMITS.task }),
  agent: Type.String({ minLength: 1, maxLength: LIMITS.name, pattern: AGENT_NAME_PATTERN }),
  files: OrdinaryScopeInputSchema.properties.files,
  maxModelCalls: Type.Optional(ModelCallLimitSchema),
  seconds: Type.Optional(ExecutionSecondsSchema),
}, { additionalProperties: false });
export type NativeExecutionHarness = {
  readonly access?: DelegationAccessCommands;
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
export const BASIC_RUN_HELP = [
  "JEV · Basic execution / one fixed profile and task",
  '/jev-subagents run {"agent":"scout","task":"Read sample.txt and report its content.","files":[{"path":"sample.txt","access":"read"}],"seconds":86400}',
  "Prepare task prose in English; only explicit existing workspace files with read/read_write access are approved.",
  "Default: one worker / SDK natural completion (no model-round cap) / up to 24 hours (seconds can narrow it). Rounds include tools and final reporting, not file count. Model/thinking come from the fixed user profile, never the parent model.",
  "Reviewed requires fresh exact-source approval. Native /jev-subagents access full can authorize session delegation instead. No JEV selection, Goal, verifier, assessment, install, fallback or retry.",
  "/jev-subagents cancel — stop and settle the owned run / /jev-subagents result — explicitly inspect the last unverified worker result in this session",
  "Stopping is not rollback. Uncertain ownership/accounting stays retained. Results are neither acceptance nor verification.",
].join("\n");
export function basicRunProgress(phase: string): string | undefined {
  const labels: Readonly<Record<string, string | undefined>> = { preparing: "Preparing input/files/fixed profile", awaiting_approval: "Awaiting exact-source approval",
    selecting: "Checking fixed worker/ownership", checking: "Rechecking permissions/files", running: "Worker running" };
  return Object.hasOwn(labels, phase) && labels[phase] ? `JEV · ${labels[phase]}` : undefined;
}
function basicRunStop(result: OrdinaryPublicResult): string {
  const reasons: Readonly<Record<string, string | undefined>> = { cancelled: "Cancelled", expired: "Deadline expired", budget: "Round/time limit reached",
    changed: "Files/profile/session changed", declined: "Positive exact-source approval unconfirmed (not proof of user refusal)", invalid: "Input/permission scope mismatch", unknown: "Ownership/accounting unconfirmed", undecided: "JEV branch support below threshold / no alternative executed" };
  const phases: Readonly<Record<string, string | undefined>> = { interface: "UI/session check", preparing: "Input/files/fixed profile preparation",
    awaiting_approval: "Exact-source approval", selecting: "Execution ownership", checking: "Permissions/files recheck", running: "Worker execution", cleanup: "Owned cleanup" };
  const phase = result.diagnostic?.phase;
  const reason = Object.hasOwn(reasons, result.reason) ? reasons[result.reason] : undefined;
  const stage = phase && Object.hasOwn(phases, phase) ? phases[phase] : undefined;
  const worker = result.workerFailure;
  const workerStages: Readonly<Record<string, string | undefined>> = { input: "Approved input", model_loading: "Fixed-model loading", session_setup: "SDK setup",
    model_request: "Model request", model_response: "Model response", internal_report: "Internal English report boundary", accounting: "Usage accounting", cleanup: "Worker cleanup" };
  const workerStage = worker?.stage && Object.hasOwn(workerStages, worker.stage) ? workerStages[worker.stage] : undefined;
  const workerDetail = workerStage ? ` · Worker ${workerStage}` : "";
  return `Stop reason · ${reason ?? (stage ? `Stopped during ${stage}` : "Execution unconfirmed")}${workerDetail} · Private error details withheld.`;
}
export function basicRunSummary(result: OrdinaryPublicResult): string {
  return [result.status === "completed_unverified" ? "JEV · Basic execution ended / unverified" : "JEV · Basic execution stopped / no automatic retry",
    `Workers ${result.workersStarted} · SDK ${result.modelCalls} · reserved ${result.reservedModelCalls === null ? "pending / no round cap" : result.reservedModelCalls}`,
    ...(result.status === "stopped" ? [basicRunStop(result), ...directoryIssueRows(result.diagnostic?.directoryIssues)] : []),
    ...(result.diagnostic?.preparationStage === "directories" && result.workersStarted === 0 && result.modelCalls === 0 && result.jevRequests === 0
      ? ["Directory preparation refused before approval / no worker, model, JEV or task-file change"] : []),
    result.cleanupConfirmed && !result.lockRetained ? "Owned cleanup confirmed / not rollback" : "Ownership/cleanup unknown / records retained / new execution blocked",
    result.reports.length ? "Result available / /jev-subagents result explicitly opens worker text (unverified)" : "No worker result",
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

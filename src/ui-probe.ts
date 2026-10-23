import { approvalUiViewText, type ApprovalUiDiagnostic } from "./approval-ui-diagnostics.ts";
// Pure diagnostic model. Positive UI replies never create execution authority.
export const UI_PROBE_TIMEOUT_MS = 15000;
export type UiProbeKind = "confirm" | "select" | "custom";
export type UiProbeStatus = "positive_reply" | "non_positive_reply" | "invalid_reply" | "no_reply_timeout" | "cancelled" | "session_changed" | "api_error" | "unsupported" | "busy";
export type UiProbeResult = { readonly kind: UiProbeKind; readonly status: UiProbeStatus; readonly elapsedMs: number; readonly requestStarted: boolean;
  readonly executionAuthorized: false; readonly modelWorkerJevCalls: 0; readonly approvalUi?: ApprovalUiDiagnostic };
export type UiProbeState = { readonly phase: "idle" } | { readonly phase: "waiting"; readonly kind: UiProbeKind; readonly started: number; readonly deadline: number; readonly requestStarted: boolean }
  | { readonly phase: "done"; readonly result: UiProbeResult };
export type UiProbeEvent = { readonly type: "start"; readonly kind: UiProbeKind; readonly now: number; readonly supported: boolean; readonly busy: boolean; readonly cancelled: boolean }
  | { readonly type: "request"; readonly now: number }
  | { readonly type: "finish"; readonly now: number; readonly status: UiProbeStatus };
export function reduceUiProbe(state: UiProbeState, event: UiProbeEvent): UiProbeState {
  if (!Number.isSafeInteger(event.now) || event.now < 0 || state.phase === "done") return state;
  if (event.type === "start" && state.phase === "idle") {
    const waiting: UiProbeState = { phase: "waiting", kind: event.kind, started: event.now, deadline: event.now + UI_PROBE_TIMEOUT_MS, requestStarted: false };
    return event.cancelled || event.busy || !event.supported ? reduceUiProbe(waiting, { type: "finish", now: event.now,
      status: event.cancelled ? "cancelled" : event.busy ? "busy" : "unsupported" }) : waiting;
  }
  if (event.type === "request" && state.phase === "waiting") return { ...state, requestStarted: true };
  if (event.type !== "finish" || state.phase !== "waiting") return state;
  const status = event.status === "cancelled" || event.status === "session_changed" ? event.status
    : event.now >= state.deadline ? "no_reply_timeout" : event.status;
  return { phase: "done", result: { kind: state.kind, status, elapsedMs: Math.max(0, Math.min(UI_PROBE_TIMEOUT_MS, event.now - state.started)),
    requestStarted: state.requestStarted, executionAuthorized: false, modelWorkerJevCalls: 0 } };
}
const labels: Record<UiProbeStatus, string> = { positive_reply: "Diagnostic reply returned (physical visibility needs user observation)", non_positive_reply: "No positive reply (cancel, closed window and host defaults are not distinguished)",
  invalid_reply: "Unexpected reply / original withheld", no_reply_timeout: "No reply within15s / expired (not user refusal)", cancelled: "Lifecycle cancelled / no execution",
  session_changed: "Session changed / late reply discarded", api_error: "UI API error / original withheld", unsupported: "UI API support unconfirmed", busy: "Another task/diagnostic is active / no request" };
export const UI_PROBE_HELP = ["JEV · standalone UI diagnostic (not execution approval)", "/jev-subagents ui-test confirm · one confirmation dialog",
  "/jev-subagents ui-test select · one selection dialog", "/jev-subagents ui-test custom · one synthetic TUI source editor (factory/render observations only)", "Each diagnostic lasts15s; no rerun or alternate UI fallback. Execution approval is separate.",
  "Fixed synthetic text only / no model, worker, JEV, file/configuration/authentication access or storage", "Confirmation/selection clicks create no execution authority."].join("\n");
export function uiProbeText(result: UiProbeResult): string {
  return ["JEV · standalone UI diagnostic / not execution approval", `API · ${result.kind} · ${labels[result.status]}`, `API request started · ${result.requestStarted ? "yes" : "no"} · waited ${result.elapsedMs}ms`,
    ...(result.kind === "custom" ? [approvalUiViewText(result.approvalUi) ?? "TUI stage not measured", "Function-call observations do not prove physical terminal visibility or execution approval."]
      : ["This view does not directly instrument GUI event delivery or renderer visibility."]), "Models/workers/JEV0 / no file/settings/permission changes / diagnostic replies do not execute work"].join("\n");
}

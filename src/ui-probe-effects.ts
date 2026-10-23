import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canConfirmContextPacket, confirmContextPacket } from "./context-approval.ts";
import type { ApprovalUiDiagnostic } from "./approval-ui-diagnostics.ts";
import { reduceUiProbe, type UiProbeState, type UiProbeKind, type UiProbeResult, type UiProbeStatus } from "./ui-probe.ts";
export const UI_PROBE_TITLE = "JEV · standalone UI diagnostic (no execution authority)";
export const UI_PROBE_MESSAGE = "Synthetic UI diagnostic. Confirm/Cancel are diagnostic replies only: no model, worker or JEV execution and no stored authority. Expires after15s without a reply.";
export const UI_PROBE_CUSTOM_MESSAGE = "SYNTHETIC TUI DIAGNOSTIC ONLY\nThis fixed public text is not a task or an execution/transmission approval.\nSubmit it unchanged to report one UI diagnostic receipt. This diagnostic expires in 15 seconds. No worker, model, JEV, file or configuration work is authorized.";
export const UI_PROBE_SELECTION = "Return diagnostic reply / no execution";
/** UI calls only. No model/runtime discovery, private snapshots, persistence or grants. */
export async function runUiProbe(kind: UiProbeKind, ctx: ExtensionContext, signal: AbortSignal, busy = false): Promise<UiProbeResult> {
  let original: string | undefined, supported = false;
  try { supported = kind === "custom" ? canConfirmContextPacket(ctx) && (ctx.mode === "tui" || ctx.mode === undefined)
    : ctx.hasUI && typeof ctx.ui[kind] === "function"; if (supported && !busy && !signal.aborted) original = ctx.sessionManager.getSessionId(); }
  catch { supported = false; }
  supported = supported && typeof original === "string" && original.length > 0;
  let state: UiProbeState = reduceUiProbe({ phase: "idle" }, { type: "start", kind, now: Date.now(), supported, busy, cancelled: signal.aborted });
  if (state.phase === "done") return state.result;
  if (state.phase !== "waiting") throw new Error("UI diagnostic state unavailable.");
  const deadline = state.deadline;
  return await new Promise<UiProbeResult>(resolve => {
    const controller = new AbortController(); let finished = false, approvalUi: ApprovalUiDiagnostic | undefined;
    const finish = (status: UiProbeStatus) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (original !== undefined) {
        try { if (ctx.sessionManager.getSessionId() !== original) status = "session_changed"; } catch { status = "session_changed"; }
      }
      state = reduceUiProbe(state, { type: "finish", status, now: Date.now() });
      controller.abort(); if (state.phase === "done") resolve({ ...state.result, ...(approvalUi ? { approvalUi } : {}) });
    };
    const cancel = () => finish("cancelled");
    const timer = setTimeout(() => finish("no_reply_timeout"), Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    try {
      const options = { signal: controller.signal, timeout: Math.max(1, deadline - Date.now()) };
      state = reduceUiProbe(state, { type: "request", now: Date.now() });
      if (kind === "custom") {
        void confirmContextPacket(ctx, UI_PROBE_TITLE, UI_PROBE_CUSTOM_MESSAGE, deadline, controller.signal, "diagnostic", value => { approvalUi = value; }).then(accepted => {
          const status: UiProbeStatus = approvalUi?.status === "api_error" ? "api_error" : approvalUi?.status === "invalid_reply" || approvalUi?.status === "invalid_review" ? "invalid_reply"
            : approvalUi?.status === "session_changed" ? "session_changed" : approvalUi?.status === "unsupported" ? "unsupported"
              : approvalUi?.status === "expired" ? "no_reply_timeout" : approvalUi?.status === "cancelled" ? "cancelled" : accepted ? "positive_reply" : "non_positive_reply";
          finish(status);
        }, () => finish("api_error"));
        return;
      }
      const request = kind === "confirm" ? ctx.ui.confirm(UI_PROBE_TITLE, UI_PROBE_MESSAGE, options)
        : ctx.ui.select(UI_PROBE_TITLE, [UI_PROBE_SELECTION, "Cancel / no execution"], options);
      void request.then(value => {
        const positive = kind === "confirm" ? value === true : value === UI_PROBE_SELECTION;
        const negative = kind === "confirm" ? value === false : value === undefined || value === "Cancel / no execution";
        finish(positive ? "positive_reply" : negative ? "non_positive_reply" : "invalid_reply");
      }, () => finish("api_error"));
    } catch { finish("api_error"); }
  });
}
/** Single diagnostic owner; lifecycle revocation only, never a worker owner. */
export function registerUiProbe(pi: Pick<ExtensionAPI, "on">) {
  let pending: AbortController | undefined, closed = false;
  const cancel = () => pending?.abort();
  pi.on("session_before_switch", cancel); pi.on("session_before_fork", cancel); pi.on("session_before_tree", cancel);
  pi.on("session_before_compact", cancel); pi.on("before_agent_start", cancel);
  pi.on("session_shutdown", () => { closed = true; cancel(); });
  return async (kind: UiProbeKind, ctx: ExtensionContext, otherPending = false) => {
    let busy = closed || pending !== undefined || otherPending;
    try { busy = busy || !ctx.isIdle(); } catch { busy = true; }
    const controller = new AbortController(); if (!busy) pending = controller;
    try { return await runUiProbe(kind, ctx, controller.signal, busy); }
    finally { if (pending === controller) pending = undefined; }
  };
}

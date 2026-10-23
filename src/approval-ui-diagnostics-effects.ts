import { reduceApprovalUi, startApprovalUi, type ApprovalUiObserver, type ApprovalUiStatus, type ApprovalUiStep, type ApprovalUiApi, type ApprovalUiDiagnostic, type ApprovalUiViewStage } from "./approval-ui-diagnostics.ts";
/** Observation only: callback failures never retry, alter approval or leak their cause. */
export function publishApprovalUi(observer: ApprovalUiObserver | undefined, diagnostic: ApprovalUiDiagnostic): void {
  if (!observer) return;
  try { void Promise.resolve(observer(diagnostic)).catch(() => {}); } catch { /* Observation has no authority. */ }
}
/** Clocks live only in effects. Null means no human response deadline; finite diagnostic deadlines stay bounded. */
export function approvalUiDiagnostics(deadline: number | null, mode: unknown, observer?: ApprovalUiObserver) {
  let state = startApprovalUi(Date.now(), deadline, mode), finished = false;
  return {
    request(step: ApprovalUiStep, api: ApprovalUiApi) {
      if (finished) return;
      state = reduceApprovalUi(state, { type: "request", step, api, now: Date.now() }); publishApprovalUi(observer, state.diagnostic);
    },
    view(stage: ApprovalUiViewStage) {
      if (finished) return;
      const next = reduceApprovalUi(state, { type: "view", stage, now: Date.now() });
      if (next === state) return;
      state = next; publishApprovalUi(observer, state.diagnostic);
    },
    reply(status: "positive_reply" | "non_positive_reply" | "invalid_reply") {
      if (finished) return;
      state = reduceApprovalUi(state, { type: "reply", status, now: Date.now() }); publishApprovalUi(observer, state.diagnostic);
    },
    finish(status: Exclude<ApprovalUiStatus, "waiting">) {
      if (finished) return;
      finished = true; state = reduceApprovalUi(state, { type: "finish", status, now: Date.now() }); publishApprovalUi(observer, state.diagnostic);
    },
  };
}

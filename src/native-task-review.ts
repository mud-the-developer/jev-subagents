import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmContextPacket } from "./context-approval.ts";
import { approvalUiDiagnostics, publishApprovalUi } from "./approval-ui-diagnostics-effects.ts";
import { rejectApprovalUiOwner, type ApprovalUiObserver, type ApprovalUiDiagnostic } from "./approval-ui-diagnostics.ts";
import { nativeTaskReviewText, type RunApproval, type TaskReviewContent } from "./task-review-machine.ts";
import { reduceNativeReview } from "./native-task-review-machine.ts";

/** One complete native execution review, not a source acknowledgement or a synthetic legacy approval sequence. */
export async function confirmNativeTaskReview(content: TaskReviewContent, ctx: ExtensionContext, signal?: AbortSignal, observer?: ApprovalUiObserver): Promise<boolean> {
  const started = reduceNativeReview({ phase: "idle" }, { type: "start_execution",
    review: { ...content, id: randomUUID(), deadline: null }, now: Date.now() });
  const effect = started.effects[0];
  if (effect?.type !== "review_execution") {
    approvalUiDiagnostics(null, ctx.mode, observer).finish("invalid_review"); return false;
  }
  // The reducer owns a copy; the human projection never replaces the original packet.
  const review = effect.review;
  const accepted = await confirmContextPacket(ctx, "JEV · Approve this exact execution?", review.packet, review.deadline,
    signal ?? new AbortController().signal, "approval", observer, nativeTaskReviewText(review));
  const ended = reduceNativeReview(started.state, signal?.aborted ? { type: "cancel" } : {
    type: "execution_reply", id: review.id, packet: review.packet, accepted, now: Date.now(),
  });
  return ended.state.phase === "approved";
}

/** Session lifecycle/overlap owner only; workflow decisions stay in the native reducer. */
export function registerNativeTaskReview(pi: ExtensionAPI): { readonly confirm: RunApproval } {
  let pending: AbortController | undefined, closed = false;
  const cancel = () => pending?.abort();
  pi.on("session_before_switch", cancel); pi.on("session_before_fork", cancel);
  pi.on("session_before_tree", cancel); pi.on("session_before_compact", cancel);
  pi.on("session_shutdown", () => { closed = true; cancel(); });
  return { confirm: async (content, ctx, signal, observer) => {
    if (closed || pending || !ctx.hasUI || signal?.aborted) {
      approvalUiDiagnostics(null, ctx.mode, observer).finish(signal?.aborted ? "cancelled" : !ctx.hasUI ? "unsupported" : "busy"); return false;
    }
    let session: string;
    try {
      session = ctx.sessionManager.getSessionId();
      if (typeof session !== "string" || !session) { approvalUiDiagnostics(null, ctx.mode, observer).finish("unsupported"); return false; }
    } catch {
      approvalUiDiagnostics(null, ctx.mode, observer).finish("session_changed"); return false;
    }
    const controller = pending = new AbortController(); let terminal: ApprovalUiDiagnostic | undefined;
    const observe: ApprovalUiObserver = value => { if (value.phase === "finished") terminal = value; else publishApprovalUi(observer, value); };
    try {
      const accepted = await confirmNativeTaskReview(content, ctx, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, observe);
      let sameSession = false; try { sameSession = ctx.sessionManager.getSessionId() === session; } catch { /* Uncertainty denies. */ }
      const allowed = accepted === true && !controller.signal.aborted && !closed && sameSession;
      if (terminal) publishApprovalUi(observer, !sameSession ? rejectApprovalUiOwner(terminal, "session_changed")
        : controller.signal.aborted || closed ? rejectApprovalUiOwner(terminal, "cancelled") : terminal);
      return allowed;
    } finally { if (pending === controller) pending = undefined; }
  } };
}

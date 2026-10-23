import { ExtensionEditorComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { approvalUiDiagnostics } from "./approval-ui-diagnostics-effects.ts";
import type { ApprovalUiObserver, ApprovalUiStatus } from "./approval-ui-diagnostics.ts";

/** UI capability selection only. A supported API is not execution or transmission permission. */
export function canConfirmContextPacket(ctx: Pick<ExtensionContext, "hasUI" | "mode" | "ui">): boolean {
  if (!ctx.hasUI) return false;
  if (ctx.mode === "rpc" || ctx.mode === "print") return typeof ctx.ui.confirm === "function";
  return (ctx.mode === undefined || ctx.mode === "tui") && typeof ctx.ui.custom === "function";
}

/** Exact native review: TUI unchanged submission or GUI/RPC readonly literal true. Every exit consumes the review. */
export async function confirmContextPacket(ctx: ExtensionContext, title: string, packet: string, deadline: number | null, signal: AbortSignal, purpose: "approval" | "review" | "diagnostic" = "approval", observer?: ApprovalUiObserver, reviewText: string = packet): Promise<boolean> {
  const diagnostic = approvalUiDiagnostics(deadline, ctx.mode, observer);
  // Trusted human projection only; callers still bind approval to the immutable original machine packet.
  if (!packet || !reviewText.trim() || Buffer.byteLength(reviewText) > 262_144) { diagnostic.finish("invalid_review"); return false; }
  const expired = () => deadline !== null && (!Number.isSafeInteger(deadline) || Date.now() >= deadline);
  if (!canConfirmContextPacket(ctx) || signal.aborted || expired()) {
    diagnostic.finish(signal.aborted ? "cancelled" : expired() ? "expired" : "unsupported"); return false;
  }
  // Choose a supported public native API before opening a review, never after a UI failure.
  if (ctx.mode === "rpc" || ctx.mode === "print") return confirmReadOnlyPacket(ctx, title, reviewText, deadline, signal, purpose, diagnostic);
  let originalSession: string;
  try {
    const id = ctx.sessionManager?.getSessionId();
    if (typeof id !== "string" || !id) { diagnostic.finish("unsupported"); return false; }
    originalSession = id;
  } catch { diagnostic.finish("session_changed"); return false; }
  const sameSession = () => { try { return ctx.sessionManager.getSessionId() === originalSession; } catch { return false; } };
  return new Promise<boolean>(resolve => {
    let finished = false, submitted = false, exactSubmission = false, close: ((approved: boolean) => void) | undefined;
    const finish = (approved: boolean, status: Exclude<ApprovalUiStatus, "waiting"> = approved ? "positive_reply" : "non_positive_reply") => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", cancelled);
      let accepted = approved === true && !signal.aborted && !expired() && sameSession();
      if (!sameSession()) status = "session_changed";
      // A close callback belongs to one UI instance and is consumed before invocation.
      const dismiss = close; close = undefined;
      try { dismiss?.(accepted); } catch { accepted = false; status = "api_error"; }
      const current = sameSession();
      if (!current) status = "session_changed";
      resolve(accepted && !signal.aborted && !expired() && current);
      diagnostic.finish(signal.aborted ? "cancelled" : expired() ? "expired" : status);
    };
    const cancelled = () => finish(false, "cancelled");
    // Only callers with a finite diagnostic/transmission deadline install a timer.
    const timer = deadline === null ? undefined : setTimeout(() => finish(false, "expired"), Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      if (signal.aborted) { cancelled(); return; }
      diagnostic.request("packet", "custom");
      if (finished || signal.aborted) { cancelled(); return; }
      if (expired()) { finish(false, "expired"); return; }
      const ui = ctx.ui.custom<boolean>((tui, _theme, keybindings, done) => {
        diagnostic.view("factory_called");
        if (finished) {
          try { done(false); } catch { /* A late UI cannot revive an expired review. */ }
          return { render: () => [], invalidate() {} };
        }
        close = done;
        let unchanged = false;
        const instruction = purpose === "diagnostic"
          ? "Synthetic UI diagnostic only. Submission is a diagnostic reply, not execution/transmission approval or stored authority."
          : purpose === "review"
          ? "Scroll through the exact source and submit unchanged. This acknowledges source review only; a separate final dialog approves execution."
          : "Review the complete source, then submit it unchanged to approve this exact invocation.";
        const component = new ExtensionEditorComponent(tui, keybindings,
          `${title}\n${instruction} Editing, Esc${deadline === null ? "" : " or expiry"} denies approval. External editing is disabled.`, reviewText, text => {
            if (finished || submitted) return;
            submitted = true; exactSubmission = unchanged && text === reviewText.trim();
            diagnostic.view("submitted");
            const complete = close; close = undefined;
            if (!complete) { finish(false, "invalid_review"); return; }
            try {
              diagnostic.view("completion_requested");
              complete(exactSubmission && !signal.aborted && !expired() && sameSession());
            }
            catch { finish(false, "api_error"); }
            // Submission requests closure, not permission. Await the SDK's literal receipt.
          }, cancelled);
        // The SDK trims submissions and clears the editor before onSubmit; check its public, expanded buffer first.
        const editors = component.children.filter(child => "getExpandedText" in child);
        const editor = editors.length === 1 ? editors[0] : undefined;
        if (!editor || !("getExpandedText" in editor) || typeof editor.getExpandedText !== "function") {
          finish(false, "invalid_review"); return { render: () => [], invalidate() {} };
        }
        diagnostic.view("constructed");
        const readText = editor.getExpandedText.bind(editor);
        const render = component.render.bind(component);
        component.render = width => { diagnostic.view("rendered"); return render(width); };
        const handleInput = component.handleInput.bind(component);
        component.handleInput = data => {
          if (finished || submitted) return;
          try {
            diagnostic.view("input_received");
            if (keybindings.matches(data, "app.editor.external")) return;
            unchanged = readText() === reviewText; handleInput(data);
          } catch { finish(false, "api_error"); }
        };
        // Normal SDK disposal follows done() before its promise continuation runs.
        return Object.assign(component, { dispose() { if (!submitted) finish(false, "cancelled"); } });
      });
      // Once the UI has exited on its own, never call its stale close callback.
      void ui.then(value => {
        if (finished) return;
        const status = value === false ? "non_positive_reply" : value === true && submitted && exactSubmission ? "positive_reply" : "invalid_reply";
        diagnostic.reply(status); close = undefined; finish(status === "positive_reply", status);
      }, () => { close = undefined; finish(false, "api_error"); });
    } catch { close = undefined; finish(false, "api_error"); }
  });
}

/** GUI/RPC cannot construct the TUI editor. Its native confirmation displays the same immutable full packet. */
async function confirmReadOnlyPacket(ctx: ExtensionContext, title: string, packet: string, deadline: number | null, signal: AbortSignal, purpose: "approval" | "review" | "diagnostic", diagnostic: ReturnType<typeof approvalUiDiagnostics>): Promise<boolean> {
  if (typeof ctx.ui.confirm !== "function" || typeof ctx.sessionManager?.getSessionId !== "function") { diagnostic.finish("unsupported"); return false; }
  const sessionId = () => ctx.sessionManager.getSessionId();
  const expired = () => deadline !== null && Date.now() >= deadline;
  let originalSession: string;
  try { originalSession = sessionId(); if (typeof originalSession !== "string" || !originalSession) { diagnostic.finish("unsupported"); return false; } }
  catch { diagnostic.finish("session_changed"); return false; }
  return new Promise<boolean>(resolve => {
    const controller = new AbortController();
    let finished = false;
    const finish = (accepted: boolean, status: Exclude<ApprovalUiStatus, "waiting"> = accepted ? "positive_reply" : "non_positive_reply") => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", cancelled);
      let approved = false;
      try {
        const sameSession = sessionId() === originalSession;
        approved = accepted === true && !signal.aborted && !expired() && sameSession;
        if (!sameSession) status = "session_changed";
      } catch { status = "session_changed"; /* Uncertainty denies without fallback. */ }
      controller.abort(); resolve(approved); diagnostic.finish(signal.aborted ? "cancelled" : status);
    };
    const cancelled = () => finish(false, "cancelled");
    const timer = deadline === null ? undefined : setTimeout(() => finish(false, "expired"), Math.max(1, deadline - Date.now()));
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      if (signal.aborted) { cancelled(); return; }
      const notice = purpose === "diagnostic" ? "Synthetic diagnostic / no execution or transmission authority" : purpose === "review" ? "Source review only / does not execute" : "Review exact source before approval / cancellation does not execute";
      diagnostic.request("packet", "confirm");
      if (finished || signal.aborted) { cancelled(); return; }
      if (expired()) { finish(false, "expired"); return; }
      const pending = ctx.ui.confirm(`${title} · ${notice}`, packet,
        { signal: controller.signal, ...(deadline === null ? {} : { timeout: Math.max(1, deadline - Date.now()) }) });
      void pending.then(value => {
        if (finished) return;
        const status = value === true ? "positive_reply" : value === false ? "non_positive_reply" : "invalid_reply";
        diagnostic.reply(status); finish(value === true, status);
      }, () => finish(false, "api_error"));
    } catch { finish(false, "api_error"); }
  });
}

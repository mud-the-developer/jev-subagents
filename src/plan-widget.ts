import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planHasActivity, renderPlan, type PlanView, type PlanTaskLabels } from "./plan-presentation.ts";
import { planReceipt } from "./plan-state.ts";

const FRAME_MS = 120; // ~8fps, only while the supplied view describes live work.

/** An ephemeral TUI observer, never an owner of execution, approval or persisted plan state. */
export function registerPlanWidgets(pi: ExtensionAPI) {
  let generation = 0, clearCurrent: (() => void) | undefined;
  const clear = () => { generation++; clearCurrent?.(); clearCurrent = undefined; };
  pi.on("session_before_switch", clear); pi.on("session_before_fork", clear); pi.on("session_before_tree", clear);
  pi.on("session_before_compact", clear); pi.on("session_shutdown", clear);
  return (ctx: ExtensionContext, signal?: AbortSignal) => {
    clear();
    const lease = generation;
    // Effect-local accessibility policy; never part of a receipt or execution packet.
    const staticSafe = process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";
    let closed = false, mounted = false, terminal = false, sessionId: string | undefined;
    let view: PlanView | undefined, displayed: PlanView | undefined, taskLabels: PlanTaskLabels | undefined, requestRender: (() => void) | undefined;
    let observedAt = 0, tick = 0, timer: ReturnType<typeof setInterval> | undefined;
    try { sessionId = ctx.sessionManager.getSessionId(); } catch { /* A missing session cannot receive a widget. */ }
    const stopTimer = () => { clearInterval(timer); timer = undefined; };
    const close = () => {
      if (closed) return;
      closed = true; stopTimer(); signal?.removeEventListener("abort", close);
      view = undefined; displayed = undefined; taskLabels = undefined; requestRender = undefined;
      const remove = mounted; mounted = false;
      if (clearCurrent === close) clearCurrent = undefined;
      if (remove) { try { ctx.ui.setWidget("jev-execution-plan", undefined); } catch { /* UI disposal cannot change task settlement. */ } }
    };
    const current = () => {
      try {
        if (!closed && lease === generation && !!sessionId && !signal?.aborted && ctx.sessionManager.getSessionId() === sessionId) return true;
      } catch { /* Stale UI/session handles are not reusable. */ }
      close(); return false;
    };
    const animated = () => !!view && !staticSafe && view.display?.animations !== false && planHasActivity(view);
    const paint = () => {
      if (!current()) return;
      try { requestRender?.(); } catch { close(); }
    };
    const animate = () => {
      if (!current()) return;
      try {
        if (ctx.mode !== "tui" || !ctx.hasUI) { close(); return; }
        if (!animated() || !view) { stopTimer(); return; }
        // Clock/frame data stay local. No polling, model work, counters or inferred progress.
        tick = (tick + 1) % 8;
        displayed = { ...view, elapsedMs: view.elapsedMs + Math.max(0, Math.floor(performance.now() - observedAt)) };
        paint();
      } catch { close(); }
    };
    clearCurrent = close;
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) close();
    return {
      isCurrent: current,
      update(value: PlanView, labels?: PlanTaskLabels) {
        if (!current() || terminal) return;
        try {
          if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.setWidget !== "function") { if (mounted) close(); return; }
          // Explicit projection strips private titles and any undeclared properties before retention.
          view = structuredClone(planReceipt(value)); displayed = view; observedAt = performance.now();
          taskLabels = value.version === 3 && labels ? Object.fromEntries(view.nodes.flatMap(node => {
            const text: unknown = Object.getOwnPropertyDescriptor(labels, node.id)?.value;
            return node.kind === "task" && typeof text === "string" && text.trim() ? [[node.id, text.slice(0, 120)]] : [];
          })) : undefined;
          terminal = view.phase === "finished" || view.phase === "stopped";
          if (!animated()) { stopTimer(); tick = 0; }
          if (!mounted) {
            mounted = true;
            ctx.ui.setWidget("jev-execution-plan", (tui, theme) => {
              if (typeof tui.requestRender !== "function") throw new Error("Native render port unavailable.");
              requestRender = () => tui.requestRender();
              return {
                render(width) {
                  if (!current() || !displayed) return [];
                  try { return renderPlan(displayed, width, staticSafe ? undefined : theme, true, animated() ? { tick } : undefined, taskLabels); }
                  catch { close(); return []; }
                },
                // Stateless themed rendering: invalidation cannot retain old ANSI colors.
                invalidate() { current(); },
                // Native widget replacement/disposal owns removal; do not clear its successor.
                dispose() { mounted = false; close(); },
              };
            }, { placement: "aboveEditor" });
            if (!requestRender) { close(); return; }
          } else paint();
          if (current() && mounted && requestRender && animated() && !timer) {
            timer = setInterval(animate, FRAME_MS); timer.unref();
          }
        } catch { close(); /* A display failure never approves, cancels or retries work. */ }
      },
      close,
    };
  };
}

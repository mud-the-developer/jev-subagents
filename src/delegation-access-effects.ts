import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmContextPacket, canConfirmContextPacket } from "./context-approval.ts";
import { humanLiteral } from "./task-review-machine.ts";
import { reduceDelegationAccess, type AccessBinding, type DelegationAccessEvent, type DelegationAccessState } from "./delegation-access.ts";

/** Private effect-local lease. Neither tool inputs nor serialized results can reconstruct it. */
export type FullAccessLease = { readonly source: "full_access"; readonly signal: AbortSignal;
  readonly authorize: (ctx: ExtensionContext, signal?: AbortSignal) => boolean };
export type DelegationAccessCommands = { readonly handle: (action: string, ctx: ExtensionContext) => Promise<void>;
  readonly revoke: () => Promise<void> };
export const ACCESS_HELP = "/jev-subagents access full — acknowledge session-wide delegation risks once\n/jev-subagents access reviewed — revoke and drain owned work\n/jev-subagents access — show the current mode";
const RISKS = [
  "Enable Full Access for JEV delegation in this active session only?",
  "Routine worker execution, declared verification, bounded parent/child information sharing, declared delegation-memory operations and completion-evidence transmission need no further approval dialogs.",
  "Explicit user profiles may select their configured provider/model/thinking/tools on each job. Ordinary workers run as your OS user, including accessible files outside the workspace and shell commands when their profile allows bash. Scoped jobs keep their existing file-ID restrictions. No administrator elevation; NOT a sandbox or rollback.",
  "Files may be damaged, sensitive data exposed and model/subscription usage charged. Jobs default to SDK natural completion and up to 24 hours; explicit finite limits remain binding. There is NO cumulative session token, money or runtime cap. Each new job has its own original limits; existing grants are never extended.",
  "Only bounded declared information is shared with selected recipients. JEV routing still receives metadata only; completion assessment may receive the validated worker summary after passed verification. No automatic full-history collection or deliberate secret transmission is authorized. Same-user shell access cannot enforce a credential boundary.",
  "Installation, profile creation, administrator elevation, standalone memory administration and other extensions are NOT covered. Model/tool/input validation, freshness checks, cancellation, cleanup, unknown accounting and no automatic retry/fallback remain unchanged. Completion is not task acceptance.",
  "Use /jev-subagents access reviewed to revoke and cancel/drain owned work. Session switch/fork/tree/compact/shutdown/reload and JEV connection/profile setup changes revoke this mode. It is never saved or restored from config, history, memory or a tool argument.",
].join("\n\n");
const binding = (ctx: ExtensionContext): AccessBinding => ({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });

/** Native command/lifecycle owner only. The pure reducer decides admission and revocation. */
export function registerDelegationAccess(pi: ExtensionAPI, owner: { isBusy: () => boolean; cancel: () => Promise<void> }): DelegationAccessCommands & {
  readonly lease: (ctx: ExtensionContext) => FullAccessLease | undefined;
} {
  let state: DelegationAccessState = { phase: "reviewed" }, controller: AbortController | undefined, ui: ExtensionContext | undefined;
  let draining: Promise<void> | undefined;
  const readState = (): DelegationAccessState => state;
  const status = () => {
    try { ui?.ui.setStatus("jev-access", state.phase === "full" ? "JEV · Full Access" : undefined); } catch { /* No authority from a status label. */ }
  };
  const notify = (ctx: ExtensionContext, text: string) => { try { ctx.ui.notify(text, "info"); } catch { /* Never retry through another UI. */ } };
  const settle = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      try { await owner.cancel(); send({ type: "drained" }); }
      finally { draining = undefined; }
    })();
    return draining;
  };
  const send = (event: DelegationAccessEvent) => {
    const step = reduceDelegationAccess(state, event); state = step.state;
    for (const effect of step.effects) if (effect.type === "cancel") controller?.abort();
    status(); return step.effects;
  };
  const revoke = async (close = false) => {
    send({ type: close ? "close" : "revoke" });
    if (state.phase === "revoking") await settle();
  };
  pi.on("session_before_switch", () => revoke()); pi.on("session_before_fork", () => revoke());
  pi.on("session_before_tree", () => revoke()); pi.on("session_before_compact", () => revoke());
  pi.on("session_shutdown", () => revoke(true));
  return {
    revoke: () => revoke(),
    lease(ctx) {
      if (state.phase === "reviewed") return undefined;
      if (state.phase !== "full") throw new Error("Delegation access is pending, revoking or closed; no admission or fallback.");
      const snapshot = state, signal = controller!.signal;
      const authorize = (context: ExtensionContext, callSignal?: AbortSignal) => {
        if (signal.aborted || callSignal?.aborted || !context.hasUI) return false;
        try {
          const effects = send({ type: "authorize", id: snapshot.id, binding: binding(context) });
          if (state.phase === "revoking") void settle().catch(() => {});
          return effects.some(effect => effect.type === "authorized");
        } catch { void revoke().catch(() => {}); return false; }
      };
      if (!authorize(ctx)) throw new Error("Full Access session ownership changed; no admission or fallback.");
      return { source: "full_access", signal, authorize };
    },
    async handle(action, ctx) {
      if (state.phase === "full") {
        try { send({ type: "authorize", id: state.id, binding: binding(ctx) }); }
        catch { await revoke(); }
        if (readState().phase === "revoking") await settle();
      }
      if (action === "reviewed") { await revoke(); notify(ctx, "JEV · Reviewed / Full Access revoked; owned work drained. Cancellation is not rollback."); return; }
      if (action !== "full") {
        notify(ctx, `JEV · ${state.phase === "full" ? "Full Access" : state.phase === "reviewed" ? "Reviewed" : "Access change pending / unavailable"}\n${ACCESS_HELP}`); return;
      }
      if (state.phase === "full") { notify(ctx, "JEV · Full Access already enabled for this session."); return; }
      if (state.phase !== "reviewed" || owner.isBusy() || !canConfirmContextPacket(ctx) || !ctx.isIdle()) {
        notify(ctx, "JEV · Full Access requires an idle native UI and a settled execution owner. Nothing enabled."); return;
      }
      let current: AccessBinding; try { current = binding(ctx); } catch { return; }
      const id = randomUUID(), effects = send({ type: "request", id, binding: current });
      if (!effects.some(effect => effect.type === "acknowledge")) return;
      ui = ctx; const pending = controller = new AbortController();
      try {
        const packet = `${RISKS}\n\nSession · ${humanLiteral(current.sessionId)}\nWorkspace · ${humanLiteral(current.cwd)}`;
        const accepted = await confirmContextPacket(ctx, "JEV · Enable Full Access?", packet, null, pending.signal);
        send({ type: "reply", id, binding: binding(ctx), accepted: accepted === true && !pending.signal.aborted });
        if (readState().phase === "revoking") await settle();
        notify(ctx, readState().phase === "full" ? "JEV · Full Access enabled / session only / no cumulative spending cap." : "JEV · Full Access not enabled.");
      } catch {
        const current = readState();
        if ((current.phase === "awaiting_ack" || current.phase === "full") && current.id === id) await revoke();
      } finally { if (readState().phase !== "full") pending.abort(); }
    },
  };
}

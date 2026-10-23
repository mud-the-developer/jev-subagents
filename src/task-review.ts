import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_REVIEW_SERVICE, reduceTaskReview, type RunApproval, type TaskReviewContent, type TaskReviewEvent, type TaskReviewState } from "./task-review-machine.ts";

type Invocation = { readonly abortSignal?: AbortSignal };
type Environment = { replicatedState(value: TaskReviewState): { replace(context: unknown, value: TaskReviewState): void };
  provide(token: typeof TASK_REVIEW_SERVICE, service: unknown): void; own(cleanup: () => unknown): void };
const background = Object.freeze({ value: () => undefined });

/** Effect owner scoped to one loaded extension/session; it never starts a worker or changes run data. */
export class TaskReviewOwner {
  #state: TaskReviewState = { phase: "idle" };
  #listeners = new Set<(state: TaskReviewState) => void>();
  #pending: { id: string; resolve: (value: boolean) => void } | undefined;
  #lease: string | undefined;
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;
  #session: string | undefined;
  #closed = false;
  get state() { return this.#state; }
  context(ctx: ExtensionContext) { this.#session = ctx.sessionManager.getSessionId(); }
  subscribe(listener: (state: TaskReviewState) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #dispatch(event: TaskReviewEvent) {
    const transition = reduceTaskReview(this.#state, event); this.#state = transition.state;
    // Display failures cannot drop an approval/cancellation resolver.
    for (const listener of this.#listeners) { try { listener(this.#state); } catch { /* Host will diagnose display failures. */ } }
    for (const effect of transition.effects) { const pending = this.#pending; this.#pending = undefined; pending?.resolve(effect.approved); }
  }
  async confirm(content: TaskReviewContent, ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
    if (!ctx.hasUI || this.#closed || this.#pending || !this.#session || ctx.sessionManager.getSessionId() !== this.#session || signal?.aborted) return false;
    const id = randomUUID();
    return new Promise<boolean>(resolve => {
      const cancelled = () => this.cancelLocal("Not executed: cancellation or session change.");
      this.#pending = { id, resolve: approved => {
        signal?.removeEventListener("abort", cancelled);
        resolve(approved === true && !signal?.aborted && !this.#closed);
      } };
      signal?.addEventListener("abort", cancelled, { once: true });
      this.#dispatch({ type: "request", review: { ...content, id, deadline: null } });
      if (this.#state.phase !== "review" || this.#state.review.id !== id) {
        const pending = this.#pending; this.#pending = undefined; pending?.resolve(false); return;
      }
      if (signal?.aborted) { cancelled(); return; }
      try { ctx.ui.notify("JEV · Awaiting execution approval (no response deadline). Use Alt+tab number for Task Review; initially Ctrl+K → Open JEV Task Review. Review the exact source and approve explicitly.", "info"); }
      catch { cancelled(); } // Never fall back to another approval path after this request starts.
    });
  }
  attach(_input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted();
    if (this.#closed) throw new Error("This session is closed.");
    if (this.#lease) this.cancelLocal("A new view revoked the previous review lease.");
    const lease = this.#lease = randomUUID(); this.heartbeat({ lease }, invocation); return { lease };
  }
  #authorize(input: unknown): asserts input is Record<string, unknown> {
    if (typeof input !== "object" || !input || !this.#lease || !("lease" in input) || input.lease !== this.#lease) throw new Error("This view's review lease has ended.");
  }
  heartbeat(input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted(); this.#authorize(input); clearTimeout(this.#leaseTimer);
    this.#leaseTimer = setTimeout(() => { this.#lease = undefined; this.cancelLocal("Not executed: view closed or disconnected."); }, 5_000);
    this.#leaseTimer.unref(); return { live: true };
  }
  decide(input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted(); this.#authorize(input);
    if (Object.keys(input).sort().join(",") !== "accepted,id,lease,packet,reviewed" || typeof input.id !== "string" || typeof input.packet !== "string" ||
      typeof input.accepted !== "boolean" || !Array.isArray(input.reviewed) || input.reviewed.length !== 3 || !input.reviewed.every(x => typeof x === "string")) throw new Error("Only exact review replies are accepted.");
    if (this.#state.phase !== "review" || input.id !== this.#state.review.id) throw new Error("This review was already consumed, cancelled or expired.");
    this.#dispatch({ type: "decide", id: input.id, packet: input.packet, reviewed: [...input.reviewed] as string[], accepted: input.accepted, now: Date.now() });
    return { approved: this.state.phase === "approved" };
  }
  cancel(input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted(); this.#authorize(input); this.cancelLocal("User cancelled. No worker execution."); return { cancelled: true };
  }
  cancelLocal(reason = "Not executed: session changed or closed.") { this.#dispatch({ type: "cancel", reason }); }
  dispose() { this.#closed = true; this.#lease = undefined; this.#session = undefined; clearTimeout(this.#leaseTimer); this.cancelLocal(); this.#listeners.clear(); }
}

export function registerTaskReview(pi: ExtensionAPI): { readonly owner: TaskReviewOwner; readonly available: boolean; readonly confirm: RunApproval } | undefined {
  if (!pi.events || typeof pi.events.emit !== "function" || typeof pi.events.on !== "function") return undefined;
  const owner = new TaskReviewOwner(); let available = false, disposed = false;
  const declaration = { id: "jev-task-review", title: "JEV Task Review", source: new URL("./index.ts", import.meta.url).href,
    frontend: new URL("./setup-desktop/task-review.js", import.meta.url),
    backend: () => ({ id: "jev.task-review.backend", setup(env: Environment) {
      const state = env.replicatedState(owner.state);
      env.own(owner.subscribe(next => state.replace(background, next))); env.own(() => owner.cancelLocal("Approval view closed."));
      env.provide(TASK_REVIEW_SERVICE, { state, attach: (input: unknown, context: Invocation) => owner.attach(input, context),
        heartbeat: (input: unknown, context: Invocation) => owner.heartbeat(input, context),
        decide: (input: unknown, context: Invocation) => owner.decide(input, context), cancel: (input: unknown, context: Invocation) => owner.cancel(input, context) });
    } }) };
  const publish = () => { if (!disposed) pi.events.emit("pi-gui:desktop-view:register", { declaration, accept: () => { if (!disposed) available = true; } }); };
  const off = pi.events.on("pi-gui:desktop-view:discover", publish);
  pi.on("session_start", (_event, ctx) => owner.context(ctx));
  pi.on("session_before_switch", () => owner.cancelLocal()); pi.on("session_before_fork", () => owner.cancelLocal());
  pi.on("session_before_tree", () => owner.cancelLocal()); pi.on("session_before_compact", () => owner.cancelLocal());
  pi.on("session_shutdown", () => { disposed = true; available = false; off(); pi.events.emit("pi-gui:desktop-view:unregister", declaration); owner.dispose(); });
  publish();
  return { owner, get available() { return available; }, confirm: async (content, ctx, signal) => {
    // Only an opted-in Desktop host is eligible. Missing support is decided BEFORE creating an approval.
    if (!available || ctx.mode === "tui" || ctx.mode === undefined) return undefined;
    return owner.confirm(content, ctx, signal);
  } };
}

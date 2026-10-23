import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSetup, type SetupState } from "../scripts/setup.ts";
import { withJevSession } from "./jev-config.ts";
import { reduceStudio, STUDIO_SERVICE, type StudioEvent, type StudioState, type StudioProfile } from "./setup-studio-machine.ts";

type Invocation = { readonly abortSignal?: AbortSignal };
type Replicated = { replace(context: unknown, value: StudioState): void };
type FacetEnvironment = { replicatedState(value: StudioState): Replicated; provide(token: typeof STUDIO_SERVICE, value: unknown): void;
  own(cleanup: () => unknown): void };
const background = Object.freeze({ value: () => undefined });
const REGISTER = "pi-gui:desktop-view:register", DISCOVER = "pi-gui:desktop-view:discover", UNREGISTER = "pi-gui:desktop-view:unregister";

/** Owns effects/lifecycle only. Every UI phase/approval decision is reduced as immutable data. */
export class SetupStudioOwner {
  #state: StudioState = { phase: "idle" };
  #listeners = new Set<(state: StudioState) => void>();
  #controller: AbortController | undefined;
  #work: Promise<void> | undefined;
  #resolve: ((accepted: boolean) => void) | undefined;
  #context: ExtensionContext | undefined;
  #closed = false;
  #lease: string | undefined;
  #leaseTimer: ReturnType<typeof setTimeout> | undefined;
  readonly root: string;
  readonly nativeBusy: () => boolean;
  constructor(root: string, nativeBusy: () => boolean) { this.root = root; this.nativeBusy = nativeBusy; }
  get state() { return this.#state; }
  get busy() { return this.#work !== undefined || ["checking", "review", "creating"].includes(this.#state.phase); }
  context(ctx: ExtensionContext) { this.#context = ctx; }
  subscribe(listener: (state: StudioState) => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #dispatch(event: StudioEvent) {
    const transition = reduceStudio(this.#state, event);
    this.#state = transition.state;
    for (const listener of this.#listeners) listener(this.#state);
    for (const effect of transition.effects) {
      if (effect.type === "run") this.#launch(effect.operation);
      else { const resolve = this.#resolve; this.#resolve = undefined; resolve?.(effect.accepted); }
    }
  }
  attach(_input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted();
    if (this.#closed) throw new Error("This session is closed.");
    this.#controller?.abort(); // A new view cannot restore the old view's pending authority.
    const lease = this.#lease = randomUUID(); this.heartbeat({ lease }, invocation); return { lease };
  }
  #authorize(input: unknown): asserts input is Record<string, unknown> {
    if (typeof input !== "object" || input === null || !("lease" in input) || input.lease !== this.#lease || !this.#lease) throw new Error("This view's review lease has ended.");
  }
  heartbeat(input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted(); this.#authorize(input);
    clearTimeout(this.#leaseTimer);
    this.#leaseTimer = setTimeout(() => { this.#lease = undefined; void this.cancel(); }, 5_000);
    this.#leaseTimer.unref(); return { live: true };
  }
  start(input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted();
    this.#authorize(input);
    const operation = Object.keys(input).sort().join(",") === "lease,operation" ? input.operation : undefined;
    if (operation !== "setup" && operation !== "status") throw new Error("Only setup or status operations are allowed.");
    if (this.#closed || !this.#context?.hasUI || !this.#context.isIdle() || this.busy || this.nativeBusy()) throw new Error("Wait for the current operation to finish before trying again.");
    this.#dispatch({ type: "start", operation });
    // Accepted work is not retried if its reply is lost. One owner per active Pi session.
    return { started: true };
  }
  #launch(operation: "setup" | "status") {
    const controller = this.#controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    this.#work = this.#run(operation, signal).finally(() => { this.#controller = undefined; this.#work = undefined; });
  }
  async #run(operation: "setup" | "status", signal: AbortSignal) {
    try {
      const result = await withJevSession(this.#context!, () => runSetup(this.root, async (message, profiles) => {
        if (!profiles?.length) return "no";
        return await this.#review(message, profiles, signal) ? "yes" : "no";
      }, signal, { mode: operation === "setup" ? "profiles" : "status", report: () => {} }));
      this.#settle(result);
    } catch { this.#dispatch({ type: "fail", reason: "Preparation failed. Partially created files are retained; no automatic retry." }); }
  }
  #settle(result: SetupState) {
    if (result.status === "succeeded") this.#dispatch({ type: "finish", ...(result.report ? { report: result.report } : {}) });
    else if (result.status === "failed") this.#dispatch({ type: "fail", reason: result.error });
    else this.#dispatch({ type: "cancel", reason: "Cancelled. Already-created files are not rolled back." });
  }
  #review(packet: string, profiles: readonly StudioProfile[], signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = randomUUID(), deadline = Date.now() + 60_000;
      const cancel = () => this.#dispatch({ type: "cancel", reason: "Review deadline expired or session closed." });
      const timer = setTimeout(cancel, 60_000);
      this.#resolve = accepted => { clearTimeout(timer); signal.removeEventListener("abort", cancel); resolve(accepted && !signal.aborted && Date.now() < deadline); };
      signal.addEventListener("abort", cancel, { once: true });
      this.#dispatch({ type: "review", review: { id, deadline, packet, profiles } });
      if (signal.aborted) cancel();
    });
  }
  decide(input: unknown, invocation: Invocation = {}) {
    invocation.abortSignal?.throwIfAborted();
    this.#authorize(input);
    if (Object.keys(input).sort().join(",") !== "accepted,id,lease,packet,reviewed" ||
      !("id" in input) || typeof input.id !== "string" || !("packet" in input) || typeof input.packet !== "string" ||
      !("accepted" in input) || typeof input.accepted !== "boolean" || !("reviewed" in input) || !Array.isArray(input.reviewed) ||
      input.reviewed.length > 4 || !input.reviewed.every(file => typeof file === "string")) throw new Error("Only exact-source review replies are accepted.");
    if (this.#state.phase !== "review" || input.id !== this.#state.review.id) throw new Error("This review expired, was consumed or belongs to another session.");
    this.#dispatch({ type: "decision", id: input.id, packet: input.packet, accepted: input.accepted,
      reviewed: [...input.reviewed] as string[], now: Date.now() });
    return { accepted: this.state.phase === "creating" };
  }
  async cancel() {
    this.#controller?.abort();
    if (this.busy) this.#dispatch({ type: "cancel", reason: "User cancelled. Partially created files are retained." });
    await this.#work;
  }
  async dispose() { this.#closed = true; this.#lease = undefined; clearTimeout(this.#leaseTimer); await this.cancel(); this.#context = undefined; this.#listeners.clear(); }
}

/** Public desktop event protocol; no GUI dependencies or second backend framework are bundled. */
export function registerSetupStudio(pi: ExtensionAPI, root: string, nativeBusy: () => boolean) {
  if (!pi.events || typeof pi.events.emit !== "function" || typeof pi.events.on !== "function") return undefined;
  const owner = new SetupStudioOwner(root, nativeBusy);
  let available = false, disposed = false;
  const declaration = {
    id: "jev-setup", title: "JEV Setup Studio", source: new URL("./index.ts", import.meta.url).href,
    frontend: new URL("./setup-desktop/frontend.js", import.meta.url),
    backend: () => ({ id: "jev.setup-studio.backend", setup(env: FacetEnvironment) {
      const state = env.replicatedState(owner.state);
      env.own(owner.subscribe(next => state.replace(background, next)));
      env.own(() => owner.cancel());
      env.provide(STUDIO_SERVICE, { state,
        attach: (input: unknown, context: Invocation) => owner.attach(input, context),
        heartbeat: (input: unknown, context: Invocation) => owner.heartbeat(input, context),
        start: (input: unknown, context: Invocation) => owner.start(input, context),
        decide: (input: unknown, context: Invocation) => owner.decide(input, context),
        cancel: async (_input: unknown, context: Invocation) => { context.abortSignal?.throwIfAborted(); await owner.cancel(); return { cancelled: true }; },
      });
    } }),
  };
  const publish = () => { if (!disposed) pi.events.emit(REGISTER, { declaration, accept: () => { if (!disposed) available = true; } }); };
  const removeDiscovery = pi.events.on(DISCOVER, publish);
  pi.on("session_start", (_event, ctx) => owner.context(ctx));
  pi.on("session_before_switch", () => owner.cancel()); pi.on("session_before_fork", () => owner.cancel());
  pi.on("session_before_tree", () => owner.cancel()); pi.on("session_before_compact", () => owner.cancel());
  pi.on("session_shutdown", async () => {
    disposed = true; available = false; removeDiscovery(); pi.events.emit(UNREGISTER, declaration); await owner.dispose();
  });
  publish();
  return { owner, get available() { return available; } };
}

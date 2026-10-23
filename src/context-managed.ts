import { isDeepStrictEqual } from "node:util";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION, createAgentSession, estimateTokens,
  type AgentSession, type ExtensionFactory, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { registerJevTools } from "./index.ts";
import { englishModelData } from "./internal-language.ts";
import { canonicalDirectory, contextSnapshot, loadGoalProfile, checkGoalContext } from "./goal-run-effects.ts";
import { GOAL_PROJECT_LOCK } from "./goal-run.ts";
import { memoryHash } from "./context-memory.ts";
import { manageContext, type NativeContext } from "./context-control-effects.ts";
import { CONTEXT_ERROR, ContextInputSchema, ContextSourceSchema, validContextInput, reduceNativeApplication, managedParentAllowed,
  type ContextInput, type ContextResult, type ContextSource, type NativeApplicationState } from "./context-control.ts";
import { Value } from "typebox/value";

export const MANAGED_PI_VERSION = "0.85.1";
export const CONTEXT_COMMAND_HELP = [
  "Usage: /jev_compact <JSON> / help: /jev_compact --help",
  "Help does not start summarization, authentication setup, storage or approval UI. Review and adapt the example profile/path/content explicitly.",
  "/jev_compact " + JSON.stringify({ agent: "scout", journalDirectory: "/absolute/private/new-context-journal", notes: "Short, reviewed notes for this summary only.",
    preserve: { goal: "Current goal", scope: "Permitted scope, not execution approval", constraints: ["Keep existing limits"], nonGoals: ["No additional work"],
      remaining: ["Remaining work"], failedChecks: ["Actual failed checks; use an empty array if none"], uncertainties: ["Unverified points"], currentTurn: "Current status and next review items" } } satisfies ContextInput),
  "Required: agent, journalDirectory, notes and all preserve fields. Use [] for empty lists; memory must be an explicitly selected same-project bundle.",
  "Serialized input ≤16 KiB; notes ≤8000 characters; goal/currentTurn ≤1000; scope ≤512; each list ≤8×256. Additional fields are forbidden.",
  "agent is the user Pi agents/<name>.md basename: starts with a lowercase letter, then lowercase letters/digits/_/-, at most64 characters. Fixed models only; no pool or parent-model inheritance.",
  "journalDirectory is an explicitly prepared absolute external private directory(0700), not a file or previously used journal. Never delete records/locks or change paths to bypass a stop.",
  "Input approval → tool-free summary, at most one SDK call/30s → separate exact-result application approval. Parent cost is separate; cancellation is neither refund nor rollback.",
  "The full conversation is not collected automatically. Application does not guarantee native-session fsync. See docs/context-management.md in the extension checkout.",
].join("\n\n");
function contextInputHint(input: unknown): string {
  if (Value.Check(ContextInputSchema, input) && !englishModelData({ notes: input.notes, preserve: input.preserve })) {
    return "Input check: prepare model-facing notes/preserve as English summaries; preserve code, paths and quoted source. Values are withheld. Stopped without translation, model calls or execution. /jev_compact --help";
  }
  const paths = [...Object.keys(ContextInputSchema.properties.preserve.properties).map(key => `/preserve/${key}`),
    ...Object.keys(ContextInputSchema.properties).map(key => `/${key}`)];
  // Render schema-owned field names and fixed categories, never values, unknown keys or validator messages.
  const field = (pointer: string) => paths.find(path => pointer === path || pointer.startsWith(path + "/")) ?? "input object";
  const reasons: Record<string, string> = { required: "missing required field", additionalProperties: "additional fields forbidden", type: "type mismatch",
    minLength: "empty string forbidden", maxLength: "length limit exceeded", maxItems: "item limit exceeded", pattern: "format mismatch" };
  const fields = [...new Set(Value.Errors(ContextInputSchema, input).flatMap(error => {
    const locations = error.keyword === "required" ? error.params.requiredProperties.map(key => `${error.instancePath}/${key}`) : [error.instancePath];
    return locations.map(pointer => `${field(pointer)}: ${reasons[error.keyword] ?? "check format"}`);
  }))];
  return `Input check: ${fields.join(", ") || "total size/UTF-8/memory-bundle consistency"}. Input values and raw errors are withheld. Nothing executed. Use /jev_compact --help for format and limits.`;
}
export function contextResultNotice(result: ContextResult): string {
  const status = { applied: "applied", cancelled: "cancelled", failed: "failed", needs_review: "review required" }[result.status];
  const application = { not_applied: "not applied", applied_in_session: "applied in this session — cancellation does not roll back; native-session fsync unconfirmed",
    unknown: "application unknown — do not assume not applied" }[result.application];
  const total = result.ledger?.totalUsd;
  const accounting = result.ledger ? `Summary-call ledger: observed ${result.ledger.spent.summaryCalls}, held ${result.ledger.held.summaryCalls}.` : "No summary ledger; do not assume zero cost.";
  const inspect = result.lockRetained || !result.cleanupConfirmed || result.application === "unknown" || result.unconfirmedRecord;
  return [`JEV context: ${status} (${result.status})`, `Application: ${application}`, accounting,
    `Estimated summary total: ${total == null ? "unknown(null)" : `USD ${Number(total.toPrecision(6))}`}. Not an invoice; parent cost excluded.`,
    inspect ? "Remain stopped: ownership/application/persistence need human inspection. Preserve .jev-goal.lock, owner.lock, goal.jsonl and .jev-context-application.jsonl. No bypass by deletion, new paths or automatic retry." :
      "This cleanup is confirmed. Refusal/cancellation does not erase incurred summary cost. Review the result before new work.",
    "Inspect the preceding result JSON for details. This is not task verification/acceptance or restoration of prior execution approval. See docs/context-management.md#\uBB38\uC81C-\uC0C1\uD669\uBCC4-\uD655\uC778"].join("\n");
}
const fail = (): never => { throw new Error(CONTEXT_ERROR); };
type Hook = (event: SessionBeforeCompactEvent) => Promise<{ cancel?: boolean; compaction?: Awaited<ReturnType<AgentSession["compact"]>> }>;
function branch(session: AgentSession) {
  const entries = session.sessionManager.getBranch(), serialized = JSON.stringify(entries);
  if (!entries.length || entries.length > 4096 || Buffer.byteLength(serialized) > 4 * 1024 * 1024) return fail();
  return { sessionId: session.sessionId, leafId: session.sessionManager.getLeafId()!, branchDigest: memoryHash(entries),
    systemPromptDigest: memoryHash(session.systemPrompt), entries: entries.length };
}
export function nativeSource(session: AgentSession, event: SessionBeforeCompactEvent): ContextSource {
  if (!isDeepStrictEqual(event.branchEntries, session.sessionManager.getBranch())) return fail();
  const source = { ...branch(session), firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore, splitTurn: event.preparation.isSplitTurn };
  if (!Value.Check(ContextSourceSchema, source)) return fail();
  return source;
}
function sameBranch(session: AgentSession, source: ContextSource): boolean {
  try { const { firstKeptEntryId, tokensBefore: _tokens, splitTurn: _split, ...expected } = source;
    return isDeepStrictEqual(branch(session), expected) && session.sessionManager.getBranch().some(x => x.id === firstKeptEntryId);
  } catch { return false; }
}
/** Per-invocation native I/O handles. The only handler always cancels unless the pure one-shot gate supplies an approved result. */
export function nativeContext(session: AgentSession, hooks: Set<Hook>, owned: () => boolean, compactNative: () => ReturnType<AgentSession["compact"]>): NativeContext {
  const pending = new Set<Promise<void>>(); let hook: Hook | undefined;
  const compact = async (handler: Hook, signal: AbortSignal) => {
    if (!owned() || hooks.size || signal.aborted || !session.isIdle) return fail();
    hook = handler; hooks.add(handler);
    const abort = () => session.abortCompaction(); signal.addEventListener("abort", abort, { once: true });
    const task = compactNative().then(() => {}, () => {}); pending.add(task);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => { abort(); reject(new Error(CONTEXT_ERROR)); }, 10_000); })]);
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      // Keep a possibly-live handler installed until its native call is actually settled.
      void task.finally(() => { pending.delete(task); hooks.delete(handler); if (hook === handler) hook = undefined; });
    }
  };
  return {
    async prepare(signal) {
      let source: ContextSource | undefined;
      await compact(async event => {
        try { if (owned() && !signal.aborted && !event.signal.aborted && event.reason === "manual" && !event.willRetry) source = nativeSource(session, event); }
        catch { /* A failed probe still cancels native compaction, never falls back. */ }
        return { cancel: true };
      }, signal);
      if (!source || !sameBranch(session, source)) return fail();
      return source;
    },
    current(source) { return owned() && sameBranch(session, source); },
    async apply(source, text, operationId, deadline, check, signal) {
      let gate: NativeApplicationState = { status: "armed", source, deadline };
      const details = { jevContextVersion: 1, operationId, sourceDigest: source.branchDigest, summaryDigest: memoryHash(text), authority: "not_restored" };
      try {
        await check();
        await compact(async event => {
          try {
            await check();
            const transition = reduceNativeApplication(gate, { type: "before", source: nativeSource(session, event), now: Date.now(),
              current: owned() && sameBranch(session, source), aborted: signal.aborted || event.signal.aborted, reason: event.reason, willRetry: event.willRetry });
            gate = transition.state;
            if (transition.effects.some(x => x.type === "supply_summary")) return { compaction: { summary: text, firstKeptEntryId: source.firstKeptEntryId, tokensBefore: source.tokensBefore, details } };
          } catch { /* Explicit cancellation, not an exception swallowed by pi's extension runner. */ }
          return { cancel: true };
        }, signal);
      } catch { /* Observe the actual native entry even when cancellation or callback completion was lost. */ }
      try {
        const entry = session.sessionManager.getLeafEntry();
        if (session.sessionId === source.sessionId && entry?.type === "compaction" && entry.parentId === source.leafId &&
          entry.summary === text && entry.firstKeptEntryId === source.firstKeptEntryId && entry.tokensBefore === source.tokensBefore && isDeepStrictEqual(entry.details, details) &&
          isDeepStrictEqual(session.messages, session.sessionManager.buildSessionContext().messages))
          return { application: "applied_in_session", entryId: entry.id };
        return { application: pending.size === 0 && sameBranch(session, source) ? "not_applied" : "unknown" };
      } catch { return { application: "unknown" }; }
    },
    async close() {
      if (pending.size) session.abortCompaction();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([...pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })]); }
      finally { clearTimeout(timer); }
      if (!pending.size && hook) hooks.delete(hook);
      return pending.size === 0;
    },
  };
}

/** New opt-in session only. Does not write the user's settings, load other extensions, or import a previous session/grant. */
export async function createManagedSession(options: { cwd: string; agentDirectory: string; parent: string; sessionManager?: SessionManager }) {
  if (VERSION !== MANAGED_PI_VERSION) return fail();
  const cwd = await canonicalDirectory(options.cwd), agentDir = await canonicalDirectory(options.agentDirectory);
  if (options.sessionManager && (options.sessionManager.getCwd() !== cwd || options.sessionManager.getSessionFile() !== undefined)) return fail();
  const { agent } = await loadGoalProfile(options.parent, agentDir);
  const context = await contextSnapshot(cwd, agentDir, agent.file, []);
  const systemPrompt = `${agent.systemPrompt}\n\n${context.filter(x => x.active).map(x => JSON.stringify({ instructionFile: x.path, content: x.text })).join("\n\n")}`;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    enableAnalytics: false, enableInstallTelemetry: false, packages: [] });
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), allowModelNetwork: false });
  const model = modelRuntime.getModel(agent.model.provider, agent.model.id); if (!model) return fail();
  let session: AgentSession | undefined, compactNative: () => ReturnType<AgentSession["compact"]>;
  const fatal = new AbortController(), active = new Map<AbortController, Promise<void>>(), hooks = new Set<Hook>();
  let extension: unknown;
  const owned = () => !!session && !fatal.signal.aborted && !session.autoCompactionEnabled && !session.autoRetryEnabled &&
    loader.getExtensions().errors.length === 0 && loader.getExtensions().extensions.length === 1 && loader.getExtensions().extensions[0] === extension &&
    session.model?.provider === agent.model.provider && session.model.id === agent.model.id && session.thinkingLevel === (agent.thinking ?? "off");
  const factory: ExtensionFactory = pi => {
    registerJevTools(pi);
    pi.on("session_before_compact", async event => {
      try { if (owned() && hooks.size === 1) return await [...hooks][0]!(event); } catch { /* Never permit pi's default summarizer on exceptions. */ }
      return { cancel: true };
    });
    pi.on("session_before_tree", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_shutdown", async () => { fatal.abort(); for (const controller of active.keys()) controller.abort(); await Promise.all(active.values()); });
    pi.registerCommand("jev_compact", { description: "Exact JSON packet → one approved summary → separately approved native parent compaction (managed mode only).",
      handler: async (args, ctx) => {
        if (["", "help", "--help"].includes(args.trim())) { ctx.ui.notify(CONTEXT_COMMAND_HELP, "info"); return; }
        if (!owned() || active.size || !session?.isIdle || !ctx.hasUI) {
          ctx.ui.notify(`${CONTEXT_ERROR}\nThis request did not start. Check managed mode/approval UI, fixed model/thinking, active work and cleanup. /jev_compact --help`, "error"); return;
        }
        let input: unknown;
        try { input = JSON.parse(args); }
        catch { ctx.ui.notify("Check JSON syntax: an object with double quotes and no trailing commas is required. Nothing executed; source withheld. /jev_compact --help", "error"); return; }
        if (!validContextInput(input)) { ctx.ui.notify(contextInputHint(input), "error"); return; }
        const controller = new AbortController(); let done = () => {};
        active.set(controller, new Promise<void>(resolve => { done = resolve; }));
        try {
          try {
            await lstat(path.join(cwd, GOAL_PROJECT_LOCK));
            ctx.ui.notify("This request did not start because the project has .jev-goal.lock. Other work or unknown cleanup may remain. Human inspection of ownership/records is required; never bypass by deleting the lock or changing paths.", "error"); return;
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(); }
          const result = await manageContext(input, ctx, nativeContext(session, hooks, owned, compactNative), AbortSignal.any([controller.signal, fatal.signal]));
          if (!result.cleanupConfirmed || result.lockRetained) fatal.abort();
          const level = result.status === "applied" ? "info" : "warning";
          ctx.ui.notify(JSON.stringify(result), level);
          ctx.ui.notify(contextResultNotice(result), level);
        } catch { ctx.ui.notify(`${CONTEXT_ERROR}\nNo cause is inferred. Check the fixed user profile/Pi authentication, existing private journal path/permissions, instruction/session changes and preceding result JSON. Never delete remaining locks/journals. docs/context-management.md#\uBB38\uC81C-\uC0C1\uD669\uBCC4-\uD655\uC778`, "error"); }
        finally { active.delete(controller); done(); }
      },
    });
  };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, extensionFactories: [factory],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => systemPrompt, appendSystemPromptOverride: () => [] });
  await loader.reload(); extension = loader.getExtensions().extensions[0];
  const created = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: agent.thinking ?? "off", settingsManager, resourceLoader: loader,
    tools: [...agent.tools, ...loader.getExtensions().extensions.flatMap(item => [...item.tools.keys()])], sessionManager: options.sessionManager ?? SessionManager.create(cwd) });
  session = created.session;
  // Only the managed port retains native entry; public /compact cannot even start auth/preparation.
  compactNative = session.compact.bind(session);
  session.compact = async () => fail();
  if (created.modelFallbackMessage || !owned()) { session.dispose(); return fail(); }
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (selectedModel, packet, request) => {
    await checkGoalContext({ body: { context } });
    if (!managedParentAllowed({ owned: owned(), busy: active.size > 0, aborted: fatal.signal.aborted, autoCompaction: session!.autoCompactionEnabled,
      autoRetry: session!.autoRetryEnabled, tokens: session!.getContextUsage()?.tokens ?? null,
      estimatedTokens: packet.messages.reduce((sum, message) => sum + estimateTokens(message), 0) + Math.ceil(Buffer.byteLength(JSON.stringify([packet.systemPrompt, packet.tools ?? []])) / 4),
      contextWindow: selectedModel.contextWindow })) return fail();
    return stream(selectedModel, packet, request);
  };
  const subscribe = session.subscribe.bind(session);
  session.subscribe = listener => subscribe(event => listener(event.type === "compaction_end" && event.errorMessage !== undefined ?
    { ...event, errorMessage: CONTEXT_ERROR } : event));
  const runtime = new AgentSessionRuntime(session, { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] }, async () => fail());
  return { ...created, runtime, resourceLoader: loader, async dispose() { fatal.abort(); for (const controller of active.keys()) controller.abort(); await runtime.dispose(); } };
}

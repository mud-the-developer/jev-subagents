import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { runSetup, type SetupReport } from "../scripts/setup.ts";
import { confirmContextPacket } from "./context-approval.ts";
import { describeJevTarget, readJevConnection, withJevSession } from "./jev-config.ts";
import { BACKEND_HELP, parseBackendAction, sessionBackend, sessionSetupHandled } from "./jev-backend.ts";
import { createGpuInstaller } from "./gpu-laya-effects.ts";
import { GPU_LAYA } from "./gpu-laya.ts";
import { runSessionSetup, sessionSetupResultText, setSessionSetupStatus } from "./session-setup-effects.ts";
import { backendStatus, backendResultText, runBackendCommand } from "./jev-backend-effects.ts";
import { readRuntimeHealth, runtimeHealthText } from "./runtime-health.ts";
import { UI_PROBE_HELP, uiProbeText } from "./ui-probe.ts";
import { registerUiProbe } from "./ui-probe-effects.ts";
import { BASIC_RUN_HELP, parseBasicRun, basicRunSummary, basicRunOutput, basicRunProgress, type NativeExecutionHarness } from "./basic-execution.ts";
import type { OrdinaryPublicResult } from "./ordinary-effects.ts";
import { DOCTOR_HELP, parseDoctorRun, doctorRunText, doctorEnvironmentText } from "./doctor.ts";
import { canonicalDirectory } from "./goal-run-effects.ts";
import { directoryError, type DirectoryIssue, type DirectoryTarget } from "./directory-diagnostics.ts";

export const JEV_HELP = [
  "jev-subagents · Getting started",
  "/jev-subagents run <JSON> — basic execution: one fixed worker / one task / fresh exact-source approval",
  "/jev-subagents cancel — stop owned execution / /jev-subagents result — open the last unverified worker result",
  "/jev-subagents access full — enable session-only Full Access after one risk acknowledgement / /jev-subagents access reviewed — revoke and drain / /jev-subagents access — status",
  "At session start, inspect the local model inventory and choose this session's method once in the native picker.",
  "If Laya is unavailable, Windows x64 GPU installation/start can be offered. Always uv-managed Python + uv venv + uv pip; download/run only after separate exact-source approval. No automatic CPU fallback.",
  "/jev-subagents or /jev-subagents setup — choose the method again (no HTML/dashboard)",
  "/jev-subagents status — current connection configuration / /jev-subagents doctor — environment/worker SDK checks (no live model)",
  '/jev-subagents doctor run {"agent":"scout","file":"sample.txt"} — real worker read test after fresh approval',
  "/jev-subagents runtime — current host scope schema/active tools (read-only; no model execution or approval request)",
  "/jev-subagents ui-test confirm / /jev-subagents ui-test select — standalone UI diagnostics (15s each; models/workers0; no execution authority)",
  "/jev-subagents profiles — create four missing user profiles after exact-source approval (one-time preparation; existing files retained)",
  "/jev-subagents on laya / /jev-subagents on clef / /jev-subagents on clef-flash — save local connection presets on this session branch (no server install/start)",
  "/jev-subagents backend / /jev-subagents backend detect — inspect local configuration / anonymously discover local model inventory after approval",
  "/jev-subagents off — disable JEV requests / /jev-subagents reset — restore startup shell configuration / /jev-subagents on typesafe — select TypeSafe",
  "Task-model login: /login / inspect models: /model. JEV is a separate decision backend. Never put keys in chat, command arguments or session settings.",
  "Example: Ask scout to inspect only this project's entry points.",
  "Example: Choose worker or worker_strong to fix the bug; verify with npm test.",
  "Delegation approves the exact task/model/tools/directory/verification command. A single candidate skips JEV selection.",
  "Assessment requires acceptanceCriteria, passed verification and evidence-transmission authority (separate approval in Reviewed, or live Full Access).",
  "Ordinary delegation only. Standalone SoL-Pi stays separate: JEV never loads, configures or duplicates it.",
].join("\n");

export function setupReportText(report: SetupReport): string {
  return [
    "JEV · local diagnostics (connection/account access/model support/price/task success unverified)",
    `checkout: ${JSON.stringify(report.root)}`,
    `User configuration: ${JSON.stringify(report.agentDir)}`,
    `Bun ${report.bun} · PATH pi ${report.piVersion} · tested SDK ${report.testedVersion}`,
    `Standalone Bun worker loading: ${report.workerVersion === report.testedVersion ? "passed" : "check required — ./install.sh from the checkout"}`,
    "Import scope: ordinary/scoped workers. Successful import proves neither model access nor task success.",
    ...(report.piVersion === report.testedVersion ? [] : ["Warning: current Pi and pinned SDK versions differ. No automatic update."]),
    ...(report.jevProvider ? [`Selected JEV backend: ${report.jevProvider.ready && report.jevProvider.target
      ? `${describeJevTarget(report.jevProvider.target)} (local configuration only; connection/key validity unconfirmed)` : report.jevProvider.error ?? "check required"}`]
      : [`TYPESAFE_API_KEY: ${report.jevKeyPresent ? "configured (validity unconfirmed)" : "missing — configure in the shell and restart Pi for JEV selection/assessment"}`]),
    ...report.profiles.map(profile => `${profile.name}: ${profile.status === "valid" ? `valid format · ${JSON.stringify(profile.plan)}`
      : profile.status === "missing" ? "missing — /jev-subagents setup" : "check required — review the existing file (no automatic overwrite)"}`),
    "No authentication files/shell settings changed and no model connection attempted. Check separately with /login and /model.",
    "Usage: /jev-subagents / model/profile configuration: docs/installation.md",
  ].join("\n");
}

export async function confirmOnboardingPacket(ctx: ExtensionContext, title: string, packet: string,
  deadline: number, signal: AbortSignal): Promise<boolean> {
  if (ctx.mode === "tui" || ctx.mode === undefined) return await confirmContextPacket(ctx, title, packet, deadline, signal);
  if (!ctx.hasUI || typeof ctx.ui.confirm !== "function" || !Number.isSafeInteger(deadline) || signal.aborted || Date.now() >= deadline) return false;
  // Only a real TUI may render custom components. Desktop SDK hosts bind UI with mode="print",
  // not "rpc"; every non-TUI host must review the complete, read-only native confirm packet.
  return new Promise<boolean>(resolve => {
    let finished = false;
    const finish = (accepted: boolean) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener("abort", cancelled);
      resolve(accepted && !signal.aborted && Date.now() < deadline);
    };
    const cancelled = () => finish(false);
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(cancelled, remaining);
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      if (signal.aborted) { cancelled(); return; }
      void ctx.ui.confirm(title, packet, { timeout: remaining, signal }).then(value => finish(value === true), cancelled);
    } catch { cancelled(); }
  });
}

export function registerOnboarding(pi: ExtensionAPI, execution?: NativeExecutionHarness) {
  let lastRun: { readonly sessionId: string; readonly result: OrdinaryPublicResult } | undefined, resultGeneration = 0;
  const clearResult = () => { lastRun = undefined; resultGeneration++; };
  pi.on("session_before_switch", clearResult); pi.on("session_before_fork", clearResult);
  pi.on("session_before_tree", clearResult); pi.on("session_before_compact", clearResult); pi.on("session_shutdown", clearResult);
  // Lifecycle ownership only: reducers decide selection, discovery and persistence.
  const pending = new Map<AbortController, Promise<void>>(), opened = new Set<string>();
  const uiProbe = registerUiProbe(pi);
  const gpu = createGpuInstaller((ctx, packet, signal) => confirmOnboardingPacket(ctx, "Approve Laya GPU installation/server start", packet, Date.now() + 60000, signal));
  // Human configuration waiting is not execution. Start the unchanged finite
  // installation envelope only after an explicit install choice, before review.
  const pickerGpu = { ...gpu, activate(ctx: ExtensionContext, signal: AbortSignal, current: () => boolean) {
    const active = AbortSignal.any([signal, AbortSignal.timeout(GPU_LAYA.timeoutMs + 125000)]);
    return gpu.activate(ctx, active, () => !active.aborted && current());
  } };
  const stop = async () => {
    for (const controller of pending.keys()) controller.abort();
    await Promise.allSettled(pending.values());
  };
  const stopAll = async () => { await stop(); if (!await gpu.close()) throw new Error("Managed Laya process-tree cleanup is uncertain. No restart or recovery."); };
  pi.on("session_before_switch", stopAll); pi.on("session_before_fork", stopAll);
  pi.on("session_before_tree", stop); pi.on("session_before_compact", stop); pi.on("session_shutdown", stopAll);
  pi.on("before_agent_start", stop); // New user work cancels an unfinished picker/install, not an already owned server.
  async function sessionPicker(ctx: ExtensionContext, automatic: boolean) {
    if (!ctx.hasUI || !ctx.isIdle() || pending.size > 0 || typeof ctx.ui.select !== "function") return;
    let id: string, handled: boolean;
    try {
      id = ctx.sessionManager.getSessionId();
      const entries = typeof ctx.sessionManager.getEntries === "function" ? ctx.sessionManager.getEntries() : ctx.sessionManager.getBranch();
      const saved = sessionBackend(entries, id), deadManaged = saved?.mode === "local" && saved.managed === true && !gpu.alive(id);
      handled = automatic && (opened.has(id) || sessionSetupHandled(entries, id) && !deadManaged);
    } catch { return; }
    // No response timer for configuration; lifecycle cancellation still owns it.
    // Installation review/startup retain their separate finite bounds above.
    const controller = new AbortController(), signal = controller.signal;
    let done = () => {};
    pending.set(controller, new Promise<void>(resolve => { done = resolve; })); opened.add(id);
    try {
      if (!automatic && execution?.access) await execution.access.revoke();
      if (signal.aborted) return;
      const state = await runSessionSetup(pi, ctx, signal, handled, pickerGpu), text = sessionSetupResultText(state);
      if (text) ctx.ui.notify(text, state.status === "failed" ? "warning" : "info");
    } finally { setSessionSetupStatus(ctx, undefined); pending.delete(controller); done(); }
  }
  pi.on("session_start", async (_event, ctx) => { await sessionPicker(ctx, true); });
  pi.registerCommand("jev-subagents", {
    description: "Choose this session's JEV method / local discovery",
    getArgumentCompletions: prefix => (prefix ? ["access", "access full", "access reviewed", "run", "cancel", "result", "setup", "status", "runtime", "ui-test", "ui-test confirm", "ui-test select", "ui-test custom", "profiles", "doctor", "doctor run", "doctor last", "doctor help", "help", "on", "on laya", "on openjev", "on clef", "on clef-flash", "on typesafe", "off", "reset", "backend", "backend detect"] : ["run", "doctor", "result", "help"])
      .filter(value => value !== prefix && value.startsWith(prefix)).map(value => ({ value, label: value })),
    async handler(args, ctx) {
      const action = args.trim();
      if (/^access(?:\s|$)/.test(action)) {
        if (action === "access full" && pending.size > 0) { ctx.ui.notify("JEV · Wait for setup or the current native operation before enabling Full Access.", "warning"); return; }
        if (execution?.access) await execution.access.handle(action.slice("access".length).trim(), ctx);
        else ctx.ui.notify("JEV · Access controller unavailable / Reviewed only. Nothing enabled.", "warning");
        return;
      }
      if (action === "cancel") {
        await stop(); await execution?.cancel();
        try { ctx.ui.notify("JEV · Stop request processed / owned cleanup wait ended / not rollback or unknown-cleanup certification", "info"); } catch { /* No alternate output path. */ }
        return;
      }
      if (action === "result") {
        let sameSession = false;
        try { sameSession = lastRun !== undefined && ctx.sessionManager.getSessionId() === lastRun.sessionId; } catch { /* No restored output. */ }
        const text = sameSession && lastRun && lastRun.result.reports.length ? basicRunOutput(lastRun.result) : "JEV · No last worker result in this session";
        try { ctx.ui.notify(text, "info"); } catch { /* Output cannot create authority. */ }
        return;
      }
      const doctorRun = /^doctor run(?:\s|$)/.test(action);
      if (/^run(?:\s|$)/.test(action) || doctorRun) {
        const scope = doctorRun ? parseDoctorRun(action.slice("doctor run".length).trim()) : parseBasicRun(action.slice(3).trim());
        if (!scope || !execution) { try { ctx.ui.notify(doctorRun ? DOCTOR_HELP : BASIC_RUN_HELP, "info"); } catch { /* Fixed help only. */ } return; }
        const blocked = execution.blockedReason();
        if (blocked) {
          const message = blocked === "uncertain" ? "JEV · Ownership/accounting unknown / new execution blocked / retain existing locks/records for human inspection."
            : "JEV · Execution owner closed / no execution. Authority/work is never recovered automatically.";
          try { ctx.ui.notify(message, "warning"); } catch { /* A new run never repairs ownership. */ }
          return;
        }
        if (!ctx.hasUI || !ctx.isIdle() || pending.size > 0 || execution.isBusy()) {
          try { ctx.ui.notify("JEV · Wait for the current operation before requesting basic execution. Nothing executed.", "warning"); } catch { /* No fallback. */ }
          return;
        }
        let sessionId: string;
        try { sessionId = ctx.sessionManager.getSessionId(); if (!sessionId) return; } catch { return; }
        clearResult(); const generation = resultGeneration;
        const controller = new AbortController(), signal = controller.signal;
        const preparationTimer = setTimeout(() => controller.abort(), 240000);
        let done = () => {};
        pending.set(controller, new Promise<void>(resolve => { done = resolve; }));
        let lastProgress: string | undefined;
        const progress = (phase: string) => {
          // Human waiting is unbounded; the ordinary core starts its execution deadline only after approval.
          if (phase === "awaiting_approval") clearTimeout(preparationTimer);
          const text = basicRunProgress(phase);
          if (!text || text === lastProgress || resultGeneration !== generation) return;
          try {
            if (ctx.sessionManager.getSessionId() !== sessionId) return;
            lastProgress = text; ctx.ui.notify(text, "info");
          } catch { /* Plain progress cannot fail execution or trigger another UI. */ }
        };
        try {
          const result = await execution.run(scope, ctx, signal, progress);
          if (resultGeneration !== generation || ctx.sessionManager.getSessionId() !== sessionId) return;
          lastRun = { sessionId, result: structuredClone(result) };
          try { ctx.ui.notify(doctorRun ? doctorRunText(result) : basicRunSummary(result), result.status === "completed_unverified" ? "info" : "warning"); } catch { /* Reporting failure never retries execution. */ }
        } catch {
          try { ctx.ui.notify("JEV · Basic execution stopped / no retry/fallback / ownership/cleanup uncertainty retained.", "warning"); } catch { /* No private error echo. */ }
        } finally { clearTimeout(preparationTimer); pending.delete(controller); done(); }
        return;
      }
      if (/^doctor(?:\s|$)/.test(action)) {
        if (action === "doctor last") {
          const last = execution?.lastFailure(ctx);
          try { ctx.ui.notify(last ? `JEV Doctor · Last recorded stop / no execution\n${last}`
            : "JEV Doctor · No recorded failure. Pre-reload/navigation transcripts are not collected automatically. Never automatically retry a failed task.", "info"); } catch { /* No private transcript access. */ }
          return;
        }
        if (action !== "doctor") { try { ctx.ui.notify(DOCTOR_HELP, "info"); } catch { /* No caller input echo. */ } return; }
        if (!ctx.hasUI || !ctx.isIdle() || pending.size > 0 || execution?.isBusy() && !execution.blockedReason()) {
          try { ctx.ui.notify("JEV Doctor · Wait for other work before checking. Nothing was cancelled or bypassed.", "warning"); } catch { /* No alternate path. */ }
          return;
        }
        const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
        let done = () => {};
        pending.set(controller, new Promise<void>(resolve => { done = resolve; }));
        try {
          const runtime = readRuntimeHealth(pi, ctx);
          const root = fileURLToPath(new URL("../", import.meta.url));
          const state = await withJevSession(ctx, () => runSetup(root, async () => { throw new Error("Doctor never requests setup/installation approval."); }, signal,
            { mode: "status", report: () => {} }));
          const targets: readonly DirectoryTarget[] = ["workspace", "agent_directory"];
          const results = await Promise.allSettled([ctx.cwd, getAgentDir()].map(folder => canonicalDirectory(folder, false, signal)));
          const issues: DirectoryIssue[] = results.flatMap((result, index) => {
            if (result.status === "fulfilled") return [];
            const detail = directoryError(result.reason);
            return [{ target: targets[index]!, reason: signal.aborted ? "cancelled" as const : detail?.reason ?? "unknown" as const, cleanupConfirmed: detail?.cleanupConfirmed ?? false }];
          });
          const workspace = results[0]!.status === "fulfilled" ? "passed" : "refused_or_unconfirmed";
          const agentDirectory = results[1]!.status === "fulfilled" ? "passed" : "refused_or_unconfirmed";
          const lastFailure = execution?.lastFailure(ctx);
          const text = doctorEnvironmentText({ runtime, workspace, agentDirectory, directoryIssues: issues, ...(state.status === "succeeded" && state.report ? { setup: state.report } : {}),
            cancelled: signal.aborted || state.status === "cancelled", blocked: execution?.blockedReason(), ...(lastFailure ? { lastFailure } : {}) });
          try { ctx.ui.notify(text, state.status === "succeeded" && workspace === "passed" ? "info" : "warning"); } catch { /* Inspection result is not authority. */ }
        } catch {
          try { ctx.ui.notify("JEV Doctor · Environment check incomplete / no live-model execution, installation or retry", "warning"); } catch { /* No private cause. */ }
        } finally { pending.delete(controller); done(); }
        return;
      }
      if (action === "help") { ctx.ui.notify(JEV_HELP, "info"); return; }
      if (action === "runtime") {
        const health = readRuntimeHealth(pi, ctx);
        try { ctx.ui.notify(runtimeHealthText(health), health.catalog === "scoped_visible" && health.active === "yes" ? "info" : "warning"); }
        catch { /* Unsupported presentation cannot certify host readiness or trigger fallback. */ }
        return;
      }
      if (/^ui-test(?:\s|$)/.test(action)) {
        if (action !== "ui-test confirm" && action !== "ui-test select" && action !== "ui-test custom") { ctx.ui.notify(UI_PROBE_HELP, "info"); return; }
        // A diagnostic must not cancel setup, installation or another picker.
        // Report busy instead of changing any existing task's lifecycle.
        const kind = action === "ui-test custom" ? "custom" : action === "ui-test confirm" ? "confirm" : "select";
        const result = await uiProbe(kind, ctx, pending.size > 0);
        try { ctx.ui.notify(uiProbeText(result), result.status === "positive_reply" ? "info" : "warning"); }
        catch { /* A missing notification is not a grant or an alternate UI path. */ }
        return;
      }
      if (action === "status") { ctx.ui.notify(withJevSession(ctx, () => {
        const cfg = readJevConnection(); return `${cfg.ok ? describeJevTarget(cfg.connection) : cfg.error}\nConfiguration inspected only. Live inference/connection unverified. Use /jev-subagents to change it.`;
      }), "info"); return; }
      if (action === "" || action === "setup" || action === "studio") {
        if (!ctx.hasUI || !ctx.isIdle() || pending.size > 0) { ctx.ui.notify("Wait for the current operation, then use /jev-subagents to choose again.", "warning"); return; }
        await sessionPicker(ctx, false); return;
      }
      const backend = parseBackendAction(action);
      if (/^(on|off|reset|backend)(\s|$)/.test(action) && !backend) { ctx.ui.notify(BACKEND_HELP, "warning"); return; }
      if (backend?.type === "status") { ctx.ui.notify(backendStatus(ctx), "info"); return; }
      if (!backend && action !== "profiles") { ctx.ui.notify(JEV_HELP, "info"); return; }
      if (!ctx.hasUI || !ctx.isIdle() || pending.size > 0) { ctx.ui.notify("Use interactive Pi after the current operation finishes. No settings changed.", "warning"); return; }
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
      let done = () => {};
      pending.set(controller, new Promise<void>(resolve => { done = resolve; }));
      try {
        if (execution?.access) await execution.access.revoke();
        if (signal.aborted) return;
        if (backend) {
          const state = await runBackendCommand(backend, pi, ctx, signal, packet => confirmOnboardingPacket(ctx,
            "Approve local JEV backend selection/discovery (no model execution)", packet, Date.now() + 60000, signal));
          ctx.ui.notify(backendResultText(state), state.status === "succeeded" || state.status === "detected" ? "info" : "warning"); return;
        }
        const root = fileURLToPath(new URL("../", import.meta.url));
        const state = await withJevSession(ctx, () => runSetup(root, async message => {
          const accepted = await confirmOnboardingPacket(ctx, "Approve JEV user-profile creation (no model execution)",
            `${message}\nFixed suggestions: Luna/low, Astra/max, Sol/low. Model/authentication/price unverified.\nNo SoL-Pi settings, keys or existing files change. Stopping does not roll back created files.`, Date.now() + 60000, signal);
          return accepted ? "yes" : "no";
        }, signal, { mode: action === "profiles" ? "profiles" : "status", report: () => {} }));
        if (state.status === "succeeded") ctx.ui.notify(state.report ? setupReportText(state.report)
          : "Profile preparation complete. Existing files preserved. No model execution or registration change.", "info");
        else ctx.ui.notify(state.status === "failed" ? state.error : "Cancelled. Already-created files are not deleted automatically.", "warning");
      } finally { pending.delete(controller); done(); }
    },
  });
}

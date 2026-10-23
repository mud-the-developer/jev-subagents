import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { SESSION_SETUP_ENTRY, SessionSetupRecordSchema, LOCAL_PRESETS, localOrigin, type BackendSelection, type SessionSetupRecord } from "./jev-backend.ts";
import { discoverLocalModels } from "./jev-backend-effects.ts";
import { resolveJevConnection, sameJevConnection, type JevConnection } from "./jev-config.ts";
import { reduceSessionSetup, type SessionChoice, type SessionSetupEvent, type SessionSetupState } from "./session-setup.ts";
import type { GpuInstaller } from "./gpu-laya-effects.ts";

export function setSessionSetupStatus(ctx: ExtensionContext, value: string | undefined): void {
  try { ctx.ui.setStatus?.("jev-setup", value); } catch { /* Cosmetic progress cannot admit/cancel configuration or block lifecycle cleanup. */ }
}
export function sessionDiscoveryOrigins(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const origin = (value: string | undefined, fallback: string) => { try { return value ? localOrigin(value) : fallback; } catch { return fallback; } };
  return [...new Set([origin(env.OPENJEV_BASE_URL, LOCAL_PRESETS.laya.origin), origin(env.CLEF_BASE_URL, LOCAL_PRESETS.clef.origin)])];
}
function recorded(entries: readonly unknown[], expected: SessionSetupRecord): boolean {
  const last = entries.findLast(e => e !== null && typeof e === "object" && "type" in e && e.type === "custom" && "customType" in e && e.customType === SESSION_SETUP_ENTRY);
  return !!last && typeof last === "object" && "data" in last && Value.Check(SessionSetupRecordSchema, last.data) && JSON.stringify(last.data) === JSON.stringify(expected);
}
function selectionConfiguration(selection: BackendSelection) {
  if (selection.mode === "off") return undefined;
  if (selection.mode === "environment") return resolveJevConnection(process.env);
  if (selection.mode === "typesafe") return resolveJevConnection({ ...process.env, JEV_BACKEND: "typesafe" });
  const preset = LOCAL_PRESETS[selection.preset];
  if (selection.managed === true) return resolveJevConnection({ JEV_BACKEND: "openjev", OPENJEV_BASE_URL: selection.origin, OPENJEV_MODEL: "laya-1.0" });
  return resolveJevConnection({ ...process.env, JEV_BACKEND: preset.backend,
    ...(preset.backend === "clef" ? { CLEF_BASE_URL: selection.origin, CLEF_MODEL: preset.model } : { OPENJEV_BASE_URL: selection.origin, OPENJEV_MODEL: preset.model }) });
}
async function choose(ctx: ExtensionContext, choices: readonly SessionChoice[], localCount: number, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return undefined;
  let cancel = () => {};
  const stopped = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); signal.addEventListener("abort", cancel, { once: true }); });
  try {
    const value = ctx.ui.select(["JEV · Choose this session's method", localCount ? `${localCount} local models discovered` : "No local model found",
      "Selection saves connection preferences only. Execution/evidence transmission require separate approval.", "Waits for a reply or Esc; session navigation/reload cancels it.",
      "Discovered ≠ inference/quality verified. Remote connections are not probed."].join("\n"),
      choices.map(c => c.label), { signal });
    return await Promise.race([value, stopped]);
  } finally { signal.removeEventListener("abort", cancel); }
}
export async function runSessionSetup(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal, handled = false, installer?: GpuInstaller): Promise<SessionSetupState> {
  const session = ctx.sessionManager;
  let id = "", leaf: string | null = null;
  try { id = session.getSessionId(); leaf = session.getLeafId(); } catch { return { status: "skipped" }; }
  const eligible = ctx.hasUI === true && ctx.isIdle() && typeof session.getBranch === "function" && typeof ctx.ui.select === "function";
  let transition = reduceSessionSetup({ status: "idle" }, { type: "start", sessionId: id, origins: sessionDiscoveryOrigins(process.env), eligible, handled });
  const current = () => { try { return !signal.aborted && ctx.hasUI === true && ctx.isIdle() && session.getSessionId() === id && session.getLeafId() === leaf; } catch { return false; } };
  const configurations = new Map<string, JevConnection>(); // Credentials stay effect-local; not UI/state/history.
  let installationRequested = false, succeeded = false;
  try {
  while (transition.effects.length) {
    if (!current()) return { status: "cancelled" };
    const effect = transition.effects[0]!; let event: SessionSetupEvent;
    try {
      switch (effect.type) {
        case "prepare":
          // Pending selection disables JEV before any dialog: no old/paid default while setup is open or interrupted.
          pi.appendEntry(SESSION_SETUP_ENTRY, structuredClone(effect.record));
          if (session.getSessionId() !== id || signal.aborted) return { status: "cancelled" };
          leaf = session.getLeafId();
          if (!recorded(session.getBranch(), effect.record)) throw new Error("Pending record not visible.");
          event = { type: "prepared" }; break;
        case "scan": {
          setSessionSetupStatus(ctx, "JEV · Checking local servers…");
          const results = (await discoverLocalModels(effect.origins, signal)).map(result => {
            const presets = result.presets.filter(preset => selectionConfiguration({ mode: "local", preset, origin: result.origin })?.ok);
            return { ...result, presets, status: result.status === "found" && !presets.length ? "unsupported" as const : result.status };
          });
          const remote = resolveJevConnection(process.env);
          const gpuLaya = !results.some(r => r.presets.includes("laya")) ? await installer?.available(id) : undefined;
          event = { type: "available", availability: { results, ...(gpuLaya ? { gpuLaya } : {}), typesafeReady: selectionConfiguration({ mode: "typesafe" })?.ok === true,
            ...(remote.ok && remote.connection.backend === "openjev" && remote.connection.endpoint === "https://api.codiv.ai/v1/systemone" ? { remoteOpenJevModel: remote.connection.model } : {}) } };
          break;
        }
        case "pick": {
          setSessionSetupStatus(ctx, undefined);
          for (const choice of effect.choices) { const cfg = selectionConfiguration(choice.selection); if (cfg?.ok) configurations.set(choice.id, cfg.connection); }
          const value = await choose(ctx, effect.choices, effect.localCount, signal);
          if (!current()) return { status: "cancelled" };
          const chosen = effect.choices.find(c => c.label === value);
          event = value === undefined ? { type: "choose" } : { type: "choose", id: chosen?.id ?? "invalid-native-selection" };
          if (chosen && chosen.selection.mode !== "off") {
            const now = selectionConfiguration(chosen.selection), before = configurations.get(chosen.id);
            if (!now?.ok || !before || !sameJevConnection(before, now.connection)) throw new Error("Configuration changed during selection.");
          }
          break;
        }
        case "install": {
          if (!installer) throw new Error("GPU installation is unavailable.");
          installationRequested = true;
          const selection = await installer.activate(ctx, signal, current);
          event = selection === undefined ? { type: "installed" } : { type: "installed", selection }; break;
        }
        case "save":
          if (!current()) return { status: "cancelled" };
          pi.appendEntry(SESSION_SETUP_ENTRY, structuredClone(effect.record));
          if (!recorded(session.getBranch(), effect.record)) throw new Error("Session record not visible.");
          event = { type: "saved" }; break;
      }
    } catch { event = signal.aborted ? { type: "cancel" } : { type: "fail", error: "JEV setup did not finish. Check /jev-subagents status for saved state. No automatic retry or bypass." }; }
    transition = reduceSessionSetup(transition.state, event);
  }
  succeeded = transition.state.status === "succeeded";
  return transition.state;
  } finally {
    if (installationRequested && !succeeded && installer && !await installer.close()) throw new Error("Managed Laya cleanup is uncertain. Files and ownership retained; no retry.");
  }
}
export function sessionSetupResultText(state: SessionSetupState): string | undefined {
  if (state.status === "succeeded") {
    const s = state.record.selection;
    return s.mode === "off" ? "JEV is disabled for this session. Use /jev-subagents to choose again." :
      `This session: ${s.mode === "local" ? `${s.preset} · ${LOCAL_PRESETS[s.preset].model}` : s.mode === "typesafe" ? "TypeSafe" : "OpenJEV environment configuration"}. Use /jev-subagents to change it.`;
  }
  return state.status === "failed" ? state.error : undefined;
}

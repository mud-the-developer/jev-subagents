import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { JEV_MODEL } from "./machine.ts";
import { branchBackend, sessionBackend, LOCAL_PRESETS, SESSION_SETUP_ENTRY, BACKEND_ENTRY } from "./jev-backend.ts";

export type JevTarget = { readonly backend: "typesafe" | "openjev" | "clef"; readonly endpoint: string; readonly model: string };
// Secret-bearing object: effect-local only. Never put in a reducer event, approval packet, log or result.
export type JevConnection = JevTarget & { readonly apiKey: string | null };
export type JevConfiguration = { readonly ok: true; readonly connection: JevConnection } | { readonly ok: false; readonly error: string };

export function resolveJevConnection(env: Readonly<Record<string, string | undefined>>): JevConfiguration {
  const backend = env.JEV_BACKEND ?? "typesafe";
  if (!["typesafe", "openjev", "clef"].includes(backend)) return { ok: false, error: "JEV_BACKEND must be typesafe, openjev or clef. No provider fallback." };
  let endpoint = "https://api.typesafe.ai/v1/systemone", model: string = JEV_MODEL, anonymous = false;
  if (backend !== "typesafe") {
    try {
      const base = backend === "clef" ? env.CLEF_BASE_URL : env.OPENJEV_BASE_URL;
      if (!base || base.length > 2048 || base !== base.trim()) throw new Error();
      const url = new URL(base);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !(loopback && ["http:", "https:"].includes(url.protocol) || backend === "openjev" && url.origin === "https://api.codiv.ai")) throw new Error();
      endpoint = `${url.origin}/v1/systemone`; anonymous = loopback;
      model = backend === "clef" ? env.CLEF_MODEL ?? "Cloudflare/clef" : env.OPENJEV_MODEL ?? "openjev-0.1";
      if (backend === "clef" ? !["Cloudflare/clef", "Cloudflare/clef-flash"].includes(model) : !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model) || model === JEV_MODEL) throw new Error();
    } catch { return { ok: false, error: "SystemOne requires a valid origin-only base and supported model. Clef is literal loopback only; OpenJEV allows Codiv HTTPS or literal loopback. No TypeSafe model or fallback." }; }
  }
  const apiKey = (backend === "typesafe" ? env.TYPESAFE_API_KEY : backend === "clef" ? env.CLEF_API_KEY : env.OPENJEV_API_KEY)?.trim() || null;
  if (!apiKey && !anonymous) return { ok: false, error: backend === "typesafe" ? "Set TYPESAFE_API_KEY before starting pi." : "Set OPENJEV_API_KEY before starting pi for a remote OpenJEV server. TypeSafe credentials are not reused." };
  if (apiKey && (apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(apiKey))) return { ok: false, error: "Invalid selected JEV provider credential; value withheld." };
  return { ok: true, connection: Object.freeze({ backend: backend as JevTarget["backend"], endpoint, model, apiKey }) };
}

// Revalidate at the HTTP sink: no model-controlled URL, cross-origin redirect or arbitrary HTTPS host.
export function validateJevEndpoint(target: JevTarget): string {
  try {
    const url = new URL(target.endpoint);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/v1/systemone" ||
      !(target.backend === "typesafe" && target.endpoint === "https://api.typesafe.ai/v1/systemone" ||
        target.backend === "openjev" && url.origin === "https://api.codiv.ai" ||
        ["openjev", "clef"].includes(target.backend) && loopback && ["http:", "https:"].includes(url.protocol))) throw new Error();
    return url.href;
  } catch { throw new Error("JEV endpoint is not allowlisted; value withheld."); }
}

// Async-local read handles only: never mutate process.env or share a mutable selection between sessions.
const scope = new AsyncLocalStorage<{ readonly ctx: ExtensionContext; readonly id: string }>();
// Effect-owned process handles, not saved permissions or credentials. A reload has no live ownership.
const managed = new Map<string, { readonly origin: string; readonly alive: () => boolean }>();
export function registerManagedJev(id: string, origin: string, alive: () => boolean): void {
  if (!id || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) || Number(origin.split(":").at(-1)) > 65535) throw new Error("Invalid owned local server.");
  managed.set(id, { origin, alive });
}
export function withJevSession<T>(ctx: ExtensionContext, run: () => T): T {
  if (!ctx.sessionManager || typeof ctx.sessionManager.getBranch !== "function") return run();
  return scope.run({ ctx, id: ctx.sessionManager.getSessionId() }, run);
}
export function readJevConnection(): JevConfiguration {
  const current = scope.getStore();
  if (!current) return resolveJevConnection(process.env);
  try {
    if (current.id !== current.ctx.sessionManager.getSessionId()) return { ok: false, error: "JEV session changed. No request or fallback." };
    const manager = current.ctx.sessionManager, branch = manager.getBranch();
    // Session preference, not execution authority: a tree move must not silently restore a paid default.
    const own = sessionBackend(typeof manager.getEntries === "function" ? manager.getEntries() : branch, current.id);
    const selection = own ?? branchBackend(branch.filter(e => !(e.type === "custom" && e.customType === SESSION_SETUP_ENTRY)));
    if (!own && current.ctx.hasUI === true && typeof manager.getEntries === "function" && selection.mode === "environment" &&
      !branch.some(e => e.type === "custom" && e.customType === BACKEND_ENTRY)) return { ok: false, error: "Choose this session's JEV method via /jev-subagents. No implicit environment fallback." };
    if (selection.mode === "invalid") return { ok: false, error: "Invalid saved JEV selection. Use /jev-subagents reset; no fallback." };
    if (selection.mode === "off") return { ok: false, error: "JEV requests are disabled for this session. Use /jev-subagents to choose; no fallback." };
    if (selection.mode === "environment") return resolveJevConnection(process.env);
    if (selection.mode === "typesafe") return resolveJevConnection({ ...process.env, JEV_BACKEND: "typesafe" });
    if (selection.mode !== "local") return { ok: false, error: "Invalid saved JEV selection; no fallback." };
    const preset = LOCAL_PRESETS[selection.preset];
    if (selection.managed === true) {
      const owned = managed.get(current.id);
      if (selection.preset !== "laya" || !owned || owned.origin !== selection.origin || !owned.alive()) return { ok: false, error: "Managed Laya is not running in this session. Use /jev-subagents to approve starting it; no restart or fallback." };
      // Never send a remote Codiv/provider key to an anonymous owned local installation.
      return resolveJevConnection({ JEV_BACKEND: "openjev", OPENJEV_BASE_URL: selection.origin, OPENJEV_MODEL: "laya-1.0" });
    }
    return resolveJevConnection({ ...process.env, JEV_BACKEND: preset.backend,
      ...(preset.backend === "clef" ? { CLEF_BASE_URL: selection.origin, CLEF_MODEL: preset.model } : { OPENJEV_BASE_URL: selection.origin, OPENJEV_MODEL: preset.model }) });
  } catch { return { ok: false, error: "JEV session configuration unavailable; no fallback." }; }
}
export function sameJevConnection(a: JevConnection, b: JevConnection): boolean {
  return a.backend === b.backend && a.endpoint === b.endpoint && a.model === b.model && a.apiKey === b.apiKey;
}
export function describeJevTarget(target: JevTarget): string {
  return `${target.backend === "typesafe" ? "TypeSafe JEV" : target.backend === "clef" ? "Local Clef" : "OpenJEV"} · ${target.model} · ${target.endpoint}`;
}
export function stripJevEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of ["TYPESAFE_API_KEY", "JEV_BACKEND", "OPENJEV_API_KEY", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "CLEF_API_KEY", "CLEF_BASE_URL", "CLEF_MODEL"]) delete env[key];
}

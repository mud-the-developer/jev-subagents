import { Type } from "typebox";
import { Value } from "typebox/value";

export const BACKEND_ENTRY = "jev.backend.v1";
export const SESSION_SETUP_ENTRY = "jev.session.setup.v1";
export const LOCAL_PRESETS = {
  laya: { backend: "openjev", model: "laya-1.0", origin: "http://127.0.0.1:8080", note: "421M text encoder · 1,024-token server limit. Good first local candidate; quality/fit not measured." },
  openjev: { backend: "openjev", model: "openjev-0.1", origin: "http://127.0.0.1:8080", note: "26B DiffusionGemma backend. GPU/server/quantization must be prepared separately." },
  clef: { backend: "clef", model: "Cloudflare/clef", origin: "http://127.0.0.1:30000", note: "27B model; BF16 weights alone exceed 16 GiB. No automatic quantization or substitution." },
  "clef-flash": { backend: "clef", model: "Cloudflare/clef-flash", origin: "http://127.0.0.1:30000", note: "9B model; BF16 weights alone exceed 16 GiB. Quantized serving support is not verified." },
} as const;
export type LocalPreset = keyof typeof LOCAL_PRESETS;
const closed = { additionalProperties: false } as const;
export const BackendSelectionSchema = Type.Union([
  Type.Object({ mode: Type.Union([Type.Literal("environment"), Type.Literal("off"), Type.Literal("typesafe")]) }, closed),
  Type.Object({ mode: Type.Literal("local"), preset: Type.Union(Object.keys(LOCAL_PRESETS).map(name => Type.Literal(name))),
    origin: Type.String({ minLength: 1, maxLength: 2048 }), managed: Type.Optional(Type.Literal(true)) }, closed),
]);
export type BackendSelection = { readonly mode: "environment" } | { readonly mode: "off" } | { readonly mode: "typesafe" }
  | { readonly mode: "local"; readonly preset: LocalPreset; readonly origin: string; readonly managed?: true };
export const BackendRecordSchema = Type.Object({ version: Type.Literal(1), selection: BackendSelectionSchema }, closed);
export function localOrigin(value: string): string {
  try {
    if (value !== value.trim() || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (!["127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    return url.origin;
  } catch { throw new Error("Invalid literal loopback origin; value withheld."); }
}
export function validBackendSelection(value: unknown): value is BackendSelection {
  if (!Value.Check(BackendSelectionSchema, value)) return false;
  if (value.mode !== "local") return true;
  try { return Object.hasOwn(LOCAL_PRESETS, value.preset) && localOrigin(value.origin) === value.origin &&
    (value.managed !== true || value.preset === "laya" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value.origin)); } catch { return false; }
}
export const SessionSetupRecordSchema = Type.Union([
  Type.Object({ version: Type.Literal(1), sessionId: Type.String({ minLength: 1, maxLength: 256 }), outcome: Type.Literal("selected"), selection: BackendSelectionSchema }, closed),
  Type.Object({ version: Type.Literal(1), sessionId: Type.String({ minLength: 1, maxLength: 256 }), outcome: Type.Union([Type.Literal("dismissed"), Type.Literal("pending")]), selection: Type.Object({ mode: Type.Literal("off") }, closed) }, closed),
]);
export type SessionSetupRecord = { readonly version: 1; readonly sessionId: string; readonly outcome: "selected" | "dismissed" | "pending"; readonly selection: BackendSelection };
export function sessionSetupHandled(entries: readonly unknown[], sessionId: string): boolean {
  return entries.some(entry => entry !== null && typeof entry === "object" && "type" in entry && entry.type === "custom" &&
    "customType" in entry && entry.customType === SESSION_SETUP_ENTRY && "data" in entry && entry.data !== null && typeof entry.data === "object" &&
    "sessionId" in entry.data && entry.data.sessionId === sessionId && "outcome" in entry.data && entry.data.outcome !== "pending");
}
export function sessionBackend(entries: readonly unknown[], sessionId: string): BackendSelection | { readonly mode: "invalid" } | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || typeof e !== "object" || !("type" in e) || e.type !== "custom" || !("customType" in e) || e.customType !== SESSION_SETUP_ENTRY ||
      !("data" in e) || !e.data || typeof e.data !== "object" || !("sessionId" in e.data) || e.data.sessionId !== sessionId) continue;
    if (!Value.Check(SessionSetupRecordSchema, e.data) || !validBackendSelection(e.data.selection)) return { mode: "invalid" };
    return structuredClone(e.data.selection);
  }
  return undefined;
}
export function branchBackend(entries: readonly unknown[]): BackendSelection | { readonly mode: "invalid" } {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "custom" || !("customType" in entry) || ![BACKEND_ENTRY, SESSION_SETUP_ENTRY].includes(String(entry.customType))) continue;
    if (!("data" in entry) || !(entry.customType === SESSION_SETUP_ENTRY ? Value.Check(SessionSetupRecordSchema, entry.data) : Value.Check(BackendRecordSchema, entry.data)) ||
      !entry.data || typeof entry.data !== "object" || !("selection" in entry.data) || !validBackendSelection(entry.data.selection)) return { mode: "invalid" };
    return structuredClone(entry.data.selection);
  }
  return { mode: "environment" };
}
export type BackendAction = { readonly type: "choose" } | { readonly type: "set"; readonly selection: BackendSelection }
  | { readonly type: "status" } | { readonly type: "detect"; readonly origins: readonly string[] };
export function parseBackendAction(text: string): BackendAction | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 1 && parts[0] === "backend") return { type: "status" };
  if (parts.length === 1 && (parts[0] === "off" || parts[0] === "reset")) return { type: "set", selection: { mode: parts[0] === "off" ? "off" : "environment" } };
  if (parts[0] === "backend" && parts[1] === "detect" && parts.length <= 3) {
    try { return { type: "detect", origins: parts[2] ? [localOrigin(parts[2])] : [LOCAL_PRESETS.laya.origin, LOCAL_PRESETS.clef.origin] }; } catch { return undefined; }
  }
  if (parts[0] !== "on" || parts.length > 3) return undefined;
  if (!parts[1]) return { type: "choose" };
  if (parts[1] === "typesafe" && parts.length === 2) return { type: "set", selection: { mode: "typesafe" } };
  if (!Object.hasOwn(LOCAL_PRESETS, parts[1])) return undefined;
  const preset = parts[1] as LocalPreset;
  try { return { type: "set", selection: { mode: "local", preset, origin: localOrigin(parts[2] ?? LOCAL_PRESETS[preset].origin) } }; } catch { return undefined; }
}
export const BACKEND_HELP = ["/jev-subagents on [laya|openjev|clef|clef-flash|typesafe] [literal-loopback-origin]", "/jev-subagents off · disable JEV requests, not workers",
  "/jev-subagents reset · restore launch environment", "/jev-subagents backend · local configuration only", "/jev-subagents backend detect [literal-loopback-origin] · explicit GET /v1/models only",
  "Selection is saved on this session branch, not process.env or user/project settings. No server install/start/download, inference probe, remote discovery or fallback."].join("\n");
export type Detection = { readonly origin: string; readonly presets: readonly LocalPreset[]; readonly status: "found" | "unavailable" | "unsupported" };
export type BackendState = { readonly status: "idle" } | { readonly status: "choosing" }
  | { readonly status: "reviewing"; readonly selection: BackendSelection } | { readonly status: "applying"; readonly selection: BackendSelection }
  | { readonly status: "reviewing_detect"; readonly origins: readonly string[] } | { readonly status: "detecting"; readonly origins: readonly string[] }
  | { readonly status: "succeeded"; readonly selection: BackendSelection } | { readonly status: "detected"; readonly results: readonly Detection[] }
  | { readonly status: "cancelled" } | { readonly status: "failed"; readonly error: string };
export type BackendEvent = { readonly type: "start"; readonly action: BackendAction; readonly canConfirm: boolean }
  | { readonly type: "chosen"; readonly selection?: BackendSelection } | { readonly type: "approval"; readonly approved: boolean }
  | { readonly type: "applied" } | { readonly type: "detected"; readonly results: readonly Detection[] } | { readonly type: "cancel" }
  | { readonly type: "fail"; readonly error: string };
export type BackendEffect = { readonly type: "choose" } | { readonly type: "confirm" | "apply"; readonly selection: BackendSelection }
  | { readonly type: "confirm_detect" | "detect"; readonly origins: readonly string[] };
export function reduceBackend(state: BackendState, event: BackendEvent): { state: BackendState; effects: readonly BackendEffect[] } {
  if (["succeeded", "detected", "failed", "cancelled"].includes(state.status)) return { state, effects: [] };
  if (event.type === "cancel") return { state: { status: "cancelled" }, effects: [] };
  if (event.type === "fail") return { state: { status: "failed", error: event.error }, effects: [] };
  if (state.status === "idle" && event.type === "start") {
    if (event.canConfirm !== true || event.action.type === "status") return { state: { status: "cancelled" }, effects: [] };
    if (event.action.type === "choose") return { state: { status: "choosing" }, effects: [{ type: "choose" }] };
    if (event.action.type === "detect") {
      try { if (event.action.origins.length < 1 || event.action.origins.length > 2 || !event.action.origins.every(origin => localOrigin(origin) === origin)) throw new Error(); }
      catch { return { state: { status: "failed", error: "Invalid discovery targets; value withheld." }, effects: [] }; }
      return { state: { status: "reviewing_detect", origins: [...event.action.origins] }, effects: [{ type: "confirm_detect", origins: [...event.action.origins] }] };
    }
    return validBackendSelection(event.action.selection) ? { state: { status: "reviewing", selection: structuredClone(event.action.selection) }, effects: [{ type: "confirm", selection: structuredClone(event.action.selection) }] }
      : { state: { status: "failed", error: "Invalid local selection; value withheld." }, effects: [] };
  }
  if (state.status === "choosing" && event.type === "chosen") return event.selection ? reduceBackend({ status: "idle" }, { type: "start", action: { type: "set", selection: event.selection }, canConfirm: true }) : { state: { status: "cancelled" }, effects: [] };
  if (event.type === "approval" && (state.status === "reviewing" || state.status === "reviewing_detect")) {
    if (event.approved !== true) return { state: { status: "cancelled" }, effects: [] };
    return state.status === "reviewing" ? { state: { status: "applying", selection: state.selection }, effects: [{ type: "apply", selection: state.selection }] }
      : { state: { status: "detecting", origins: state.origins }, effects: [{ type: "detect", origins: state.origins }] };
  }
  if (state.status === "applying" && event.type === "applied") return { state: { status: "succeeded", selection: structuredClone(state.selection) }, effects: [] };
  if (state.status === "detecting" && event.type === "detected") return { state: { status: "detected", results: structuredClone(event.results) }, effects: [] };
  return { state, effects: [] };
}

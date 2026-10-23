import { LOCAL_PRESETS, localOrigin, validBackendSelection, type BackendSelection, type Detection, type LocalPreset, type SessionSetupRecord } from "./jev-backend.ts";
import { JEV_MODEL } from "./machine.ts";

export type SessionChoice = { readonly id: string; readonly label: string; readonly selection: BackendSelection; readonly action?: "gpu-laya" };
export type Availability = { readonly results: readonly Detection[]; readonly typesafeReady: boolean;
  readonly remoteOpenJevModel?: string; readonly gpuLaya?: "install" | "start" | "running" };
export type SessionSetupState = { readonly status: "idle" } | { readonly status: "skipped" }
  | { readonly status: "preparing"; readonly sessionId: string; readonly origins: readonly string[] }
  | { readonly status: "scanning"; readonly sessionId: string; readonly origins: readonly string[] }
  | { readonly status: "choosing"; readonly sessionId: string; readonly choices: readonly SessionChoice[]; readonly localCount: number }
  | { readonly status: "installing"; readonly sessionId: string }
  | { readonly status: "saving"; readonly record: SessionSetupRecord }
  | { readonly status: "succeeded"; readonly record: SessionSetupRecord }
  | { readonly status: "cancelled" } | { readonly status: "failed"; readonly error: string };
export type SessionSetupEvent = { readonly type: "start"; readonly sessionId: string; readonly origins: readonly string[]; readonly eligible: boolean; readonly handled: boolean }
  | { readonly type: "available"; readonly availability: Availability } | { readonly type: "choose"; readonly id?: string }
  | { readonly type: "installed"; readonly selection?: BackendSelection }
  | { readonly type: "prepared" } | { readonly type: "saved" } | { readonly type: "cancel" } | { readonly type: "fail"; readonly error: string };
export type SessionSetupEffect = { readonly type: "prepare"; readonly record: SessionSetupRecord } | { readonly type: "scan"; readonly origins: readonly string[] }
  | { readonly type: "pick"; readonly choices: readonly SessionChoice[]; readonly localCount: number }
  | { readonly type: "install" } | { readonly type: "save"; readonly record: SessionSetupRecord };
const failure = (): SessionSetupState => ({ status: "failed", error: "Cannot validate the choices. No new connection was activated. Use /jev-subagents to choose again." });
export function sessionChoices(availability: Availability, origins: readonly string[]): readonly SessionChoice[] {
  if (availability.results.length !== origins.length || !availability.results.every((r, i) => r.origin === origins[i] &&
    ["found", "unsupported", "unavailable"].includes(r.status) && Array.isArray(r.presets) &&
    r.presets.length <= Object.keys(LOCAL_PRESETS).length && new Set(r.presets).size === r.presets.length &&
    r.presets.every(p => Object.hasOwn(LOCAL_PRESETS, p)) && (r.status === "found" ? r.presets.length > 0 : r.presets.length === 0))) throw new Error("Invalid local inventory.");
  const names: Record<LocalPreset, string> = { laya: "Laya", openjev: "OpenJEV", clef: "Clef", "clef-flash": "Clef Flash" };
  const choices: SessionChoice[] = availability.results.flatMap(result => result.presets.map(preset => ({
    id: `${preset}@${result.origin}`, label: `${names[preset]} · ${LOCAL_PRESETS[preset].model} · ${result.origin} (discovered)`,
    selection: { mode: "local" as const, preset, origin: result.origin },
  })));
  if (availability.gpuLaya !== undefined) {
    if (!["install", "start", "running"].includes(availability.gpuLaya)) throw new Error("Invalid GPU availability.");
    if (!choices.some(c => c.selection.mode === "local" && c.selection.preset === "laya")) choices.push({ id: "gpu-laya", action: "gpu-laya", selection: { mode: "off" },
      label: availability.gpuLaya === "install" ? "Install/start Laya · GPU / uv venv (download requires separate approval)" : availability.gpuLaya === "start" ? "Start Laya · GPU / uv venv (installed; execution approval required)" : "Use managed Laya · GPU / uv venv (running in this session)" });
  }
  if (availability.typesafeReady === true) choices.push({ id: "typesafe", label: `TypeSafe · ${JEV_MODEL} · https://api.typesafe.ai (remote; key configured)`, selection: { mode: "typesafe" } });
  if (availability.remoteOpenJevModel !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(availability.remoteOpenJevModel)) throw new Error("Invalid remote configuration.");
    choices.push({ id: "environment", label: `OpenJEV · ${availability.remoteOpenJevModel} · https://api.codiv.ai (remote; key configured)`, selection: { mode: "environment" } });
  }
  choices.push({ id: "off", label: "Do not use JEV in this session", selection: { mode: "off" } });
  return choices;
}
export function reduceSessionSetup(state: SessionSetupState, event: SessionSetupEvent): { state: SessionSetupState; effects: readonly SessionSetupEffect[] } {
  if (["skipped", "succeeded", "failed", "cancelled"].includes(state.status)) return { state, effects: [] };
  if (event.type === "cancel") return { state: { status: "cancelled" }, effects: [] };
  if (event.type === "fail") return { state: { status: "failed", error: event.error }, effects: [] };
  if (state.status === "idle" && event.type === "start") {
    if (event.eligible !== true || event.handled === true) return { state: { status: "skipped" }, effects: [] };
    try {
      if (typeof event.sessionId !== "string" || event.sessionId.length < 1 || event.sessionId.length > 256 || event.origins.length < 1 || event.origins.length > 2 ||
        new Set(event.origins).size !== event.origins.length || !event.origins.every(o => localOrigin(o) === o)) throw new Error();
    } catch { return { state: failure(), effects: [] }; }
    return { state: { status: "preparing", sessionId: event.sessionId, origins: [...event.origins] },
      effects: [{ type: "prepare", record: { version: 1, sessionId: event.sessionId, outcome: "pending", selection: { mode: "off" } } }] };
  }
  if (state.status === "preparing" && event.type === "prepared") return { state: { ...state, status: "scanning" }, effects: [{ type: "scan", origins: [...state.origins] }] };
  if (state.status === "scanning" && event.type === "available") {
    try {
      const choices = sessionChoices(event.availability, state.origins), localCount = choices.filter(c => c.selection.mode === "local").length;
      return { state: { status: "choosing", sessionId: state.sessionId, choices, localCount }, effects: [{ type: "pick", choices: structuredClone(choices), localCount }] };
    } catch { return { state: failure(), effects: [] }; }
  }
  if (state.status === "choosing" && event.type === "choose") {
    const chosen = event.id === undefined ? undefined : state.choices.find(c => c.id === event.id);
    if (event.id !== undefined && (!chosen || !validBackendSelection(chosen.selection))) return { state: failure(), effects: [] };
    if (chosen?.action === "gpu-laya") return { state: { status: "installing", sessionId: state.sessionId }, effects: [{ type: "install" }] };
    // Escape records only a disabled preference, never selection/execution approval. No paid environment fallback.
    const record: SessionSetupRecord = { version: 1, sessionId: state.sessionId, outcome: chosen ? "selected" : "dismissed", selection: chosen ? structuredClone(chosen.selection) : { mode: "off" } };
    return { state: { status: "saving", record }, effects: [{ type: "save", record: structuredClone(record) }] };
  }
  if (state.status === "installing" && event.type === "installed") {
    const selection = event.selection;
    if (selection === undefined) return { state: { status: "cancelled" }, effects: [] };
    if (!validBackendSelection(selection) || selection.mode !== "local" || selection.preset !== "laya" || selection.managed !== true) return { state: failure(), effects: [] };
    const record: SessionSetupRecord = { version: 1, sessionId: state.sessionId, outcome: "selected", selection: structuredClone(selection) };
    return { state: { status: "saving", record }, effects: [{ type: "save", record: structuredClone(record) }] };
  }
  if (state.status === "saving" && event.type === "saved") return { state: { status: "succeeded", record: structuredClone(state.record) }, effects: [] };
  return { state, effects: [] };
}

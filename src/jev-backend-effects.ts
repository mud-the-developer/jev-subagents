import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SESSION_SETUP_ENTRY, BACKEND_HELP, LOCAL_PRESETS, localOrigin, parseBackendAction, reduceBackend, validBackendSelection,
  type BackendAction, type BackendEvent, type BackendState, type Detection, type LocalPreset } from "./jev-backend.ts";
import { describeJevTarget, readJevConnection, withJevSession } from "./jev-config.ts";
import { record } from "./choice.ts";

export function backendStatus(ctx: ExtensionContext): string {
  return withJevSession(ctx, () => {
    const config = readJevConnection();
    return [config.ok ? describeJevTarget(config.connection) : config.error,
      "Local configuration only; server reachability/model fit/quality/authentication not tested.", BACKEND_HELP].join("\n\n");
  });
}
export function validateLocalModelsEndpoint(origin: string): string { return `${localOrigin(origin)}/v1/models`; }
async function boundedModels(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Metadata unavailable."); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength; if (bytes > 65536) { await reader.cancel(); throw new Error("Metadata bound exceeded."); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { reader.releaseLock(); }
}
export async function discoverLocalModels(origins: readonly string[], signal: AbortSignal): Promise<readonly Detection[]> {
  if (origins.length < 1 || origins.length > 2) throw new Error("Invalid discovery scope; value withheld.");
  const results: Detection[] = [];
  for (const input of origins) {
    signal.throwIfAborted(); const origin = localOrigin(input); const deadline = AbortSignal.timeout(1500);
    try {
      const response = await fetch(validateLocalModelsEndpoint(origin), { method: "GET", redirect: "error", signal: AbortSignal.any([signal, deadline]),
        headers: { Accept: "application/json" } }); // Anonymous metadata only; never transfer provider credentials to discovered services.
      const body = await boundedModels(response); signal.throwIfAborted(); deadline.throwIfAborted();
      if (!record(body) || !Array.isArray(body.data) || body.data.length > 256) throw new Error("Invalid metadata.");
      const ids = body.data.filter(record).map(item => item.id);
      const presets = (Object.keys(LOCAL_PRESETS) as LocalPreset[]).filter(name => ids.includes(LOCAL_PRESETS[name].model));
      results.push({ origin, presets, status: presets.length ? "found" : "unsupported" });
    } catch { signal.throwIfAborted(); results.push({ origin, presets: [], status: "unavailable" }); }
  }
  return results;
}
async function awaitUi<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) { void promise.catch(() => {}); return undefined; }
  let cancel = () => {};
  const aborted = new Promise<undefined>(resolve => { cancel = () => resolve(undefined); signal.addEventListener("abort", cancel, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener("abort", cancel); }
}
export async function runBackendCommand(action: BackendAction, pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal,
  confirm: (packet: string) => Promise<boolean>): Promise<BackendState> {
  const session = ctx.sessionManager;
  if (!session || typeof session.getBranch !== "function" || typeof session.getLeafId !== "function" || !ctx.hasUI || !ctx.isIdle()) {
    return { status: "failed", error: "Native idle session/UI required. No configuration changed." };
  }
  const id = session.getSessionId(), leaf = session.getLeafId();
  const current = () => !signal.aborted && session.getSessionId() === id && session.getLeafId() === leaf && ctx.isIdle();
  let transition = reduceBackend({ status: "idle" }, { type: "start", action, canConfirm: true });
  while (transition.effects.length) {
    if (!current()) return { status: "cancelled" };
    const effect = transition.effects[0]!; let event: BackendEvent;
    try {
      switch (effect.type) {
        case "choose": {
          const choices = [...Object.keys(LOCAL_PRESETS), "typesafe", "Cancel"];
          const value = await awaitUi(ctx.ui.select("JEV local backend · server must already be prepared", choices, { signal, timeout: 60000 }), signal);
          const parsed = value && value !== "Cancel" ? parseBackendAction(`on ${value}`) : undefined;
          event = { type: "chosen", ...(parsed?.type === "set" ? { selection: parsed.selection } : {}) }; break;
        }
        case "confirm": {
          const preset = effect.selection.mode === "local" ? LOCAL_PRESETS[effect.selection.preset] : undefined;
          const packet = ["Save this exact backend preference to this session (not an execution or transmission approval).",
            JSON.stringify({ version: 1, selection: effect.selection }, null, 2), preset?.note ?? "Environment/off/TypeSafe preference only.",
            "No shell environment, user/project settings, keys, worker model/auth, server installs, downloads, processes or inference probes are changed.",
            "This preference persists for this session through resume/reload and tree moves; different session IDs remain isolated. Missing local server fails without paid/remote fallback.",
            "Off disables JEV requests only; it does not stop active workers or grant new execution. Completion evidence still needs its separate exact approval."].join("\n\n");
          event = { type: "approval", approved: await confirm(packet) === true && current() }; break;
        }
        case "confirm_detect":
          event = { type: "approval", approved: await confirm(["Anonymous GET /v1/models to these literal loopback origins only:",
            JSON.stringify(effect.origins), "At most two requests, each 1.5 seconds/64 KiB; no Authorization, task, files, inference, retries, port scan or remote fallback.",
            "Server-side resource behavior is not guaranteed. Results do not activate or change a preference."].join("\n\n")) === true && current() }; break;
        case "apply":
          if (!current() || !validBackendSelection(effect.selection)) return { status: "cancelled" };
          pi.appendEntry(SESSION_SETUP_ENTRY, { version: 1, sessionId: id, outcome: "selected", selection: structuredClone(effect.selection) });
          event = { type: "applied" }; break;
        case "detect": event = { type: "detected", results: await discoverLocalModels(effect.origins, signal) }; break;
      }
    } catch { event = signal.aborted ? { type: "cancel" } : { type: "fail", error: "Local backend operation failed; no retry/fallback. Raw details withheld. Configuration may have been recorded if persistence failed; inspect /jev-subagents backend before further changes." }; }
    transition = reduceBackend(transition.state, event);
  }
  return transition.state;
}
export function backendResultText(state: BackendState): string {
  if (state.status === "succeeded") return `JEV preference saved for this session: ${JSON.stringify(state.selection)}\nNo server was installed/started/tested. Use /jev-subagents backend or explicit /jev-subagents backend detect. New task calls use this selection; no remote fallback.`;
  if (state.status === "detected") return ["Anonymous local metadata only; no activation or inference test.", ...state.results.map(result =>
    `${result.origin}: ${result.status}${result.presets.length ? ` · ${result.presets.join(", ")}\n${result.presets.map(preset => `/jev-subagents on ${preset} ${result.origin}`).join("\n")}` : ""}`)].join("\n");
  return state.status === "failed" ? state.error : "Cancelled; no new preference was approved. Existing settings preserved.";
}

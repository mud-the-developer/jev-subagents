// Pure, finite UI observations. No task data, error messages, identities or grants.
export const APPROVAL_UI_TRACE_VERSION = "tui-view/v1";
export type ApprovalUiStep = "preflight" | "menu" | "sources" | "task" | "profile" | "snapshot" | "packet" | "final";
export type ApprovalUiApi = "none" | "select" | "confirm" | "custom";
export type ApprovalUiViewStage = "not_observed" | "factory_called" | "constructed" | "rendered" | "input_received" | "submitted" | "completion_requested";
const viewStages: readonly ApprovalUiViewStage[] = ["not_observed", "factory_called", "constructed", "rendered", "input_received", "submitted", "completion_requested"];
export type ApprovalUiStatus = "waiting" | "positive_reply" | "non_positive_reply" | "invalid_reply" | "expired" | "cancelled" | "api_error" | "session_changed" | "unsupported" | "busy" | "invalid_review";
export type ApprovalUiDiagnostic = { readonly step: ApprovalUiStep; readonly api: ApprovalUiApi; readonly status: ApprovalUiStatus;
  readonly phase: "ready" | "requesting" | "returned" | "finished"; readonly mode: "tui" | "print" | "rpc" | "unknown";
  readonly elapsedMs: number; readonly remainingMs: number | null; readonly requests: number; readonly replies: number; readonly executionAuthorized: false; readonly viewStage?: ApprovalUiViewStage };
export type ApprovalUiObserver = (diagnostic: ApprovalUiDiagnostic) => void | Promise<void>;
export type ApprovalUiState = { readonly started: number; readonly deadline: number | null; readonly diagnostic: ApprovalUiDiagnostic };
export type ApprovalUiEvent = { readonly type: "request"; readonly now: number; readonly step: ApprovalUiStep; readonly api: ApprovalUiApi }
  | { readonly type: "reply"; readonly now: number; readonly status: "positive_reply" | "non_positive_reply" | "invalid_reply" }
  | { readonly type: "finish"; readonly now: number; readonly status: Exclude<ApprovalUiStatus, "waiting"> }
  | { readonly type: "view"; readonly now: number; readonly stage: ApprovalUiViewStage };
export function startApprovalUi(now: number, deadline: number | null, mode: unknown): ApprovalUiState {
  const valid = Number.isSafeInteger(now) && now >= 0 && (deadline === null || Number.isSafeInteger(deadline) && deadline > now);
  return { started: valid ? now : 0, deadline: valid ? deadline : 0, diagnostic: Object.freeze({ step: "preflight", api: "none", status: valid ? "waiting" : "expired",
    phase: valid ? "ready" : "finished", mode: mode === "tui" || mode === "print" || mode === "rpc" ? mode : "unknown",
    elapsedMs: 0, remainingMs: valid ? deadline === null ? null : deadline - now : 0, requests: 0, replies: 0, executionAuthorized: false, viewStage: "not_observed" }) };
}
export function reduceApprovalUi(state: ApprovalUiState, event: ApprovalUiEvent): ApprovalUiState {
  if (state.diagnostic.phase === "finished" || !Number.isSafeInteger(event.now) || event.now < state.started) return state;
  const previous = state.diagnostic, expired = state.deadline !== null && event.now >= state.deadline;
  if (event.type === "reply" && previous.phase !== "requesting") return state;
  if (event.type === "view" && (expired || previous.phase !== "requesting" || previous.api !== "custom"
    || viewStages.indexOf(event.stage) <= viewStages.indexOf(previous.viewStage ?? "not_observed"))) return state;
  const base = { ...previous, elapsedMs: state.deadline === null ? event.now - state.started : Math.min(state.deadline - state.started, event.now - state.started),
    remainingMs: state.deadline === null ? null : Math.max(0, state.deadline - event.now) };
  const diagnostic: ApprovalUiDiagnostic = event.type === "request" ? { ...base, step: event.step, api: event.api, phase: "requesting", status: "waiting", requests: previous.requests + 1, viewStage: "not_observed" }
    : event.type === "view" ? { ...base, viewStage: event.stage }
    : event.type === "reply" ? { ...base, phase: "returned", status: expired ? "expired" : event.status, replies: previous.replies + 1 }
    : { ...base, phase: "finished", status: expired && (event.status === "positive_reply" || event.status === "non_positive_reply" || event.status === "invalid_reply") ? "expired" : event.status };
  return { ...state, diagnostic: Object.freeze(diagnostic) };
}
/** A later owner check can reject a UI reply; never reinterpret it as an execution grant. */
export function rejectApprovalUiOwner(diagnostic: ApprovalUiDiagnostic, status: "session_changed" | "cancelled"): ApprovalUiDiagnostic {
  return Object.freeze({ ...diagnostic, phase: "finished", status, executionAuthorized: false });
}
const steps = { preflight: "support check", menu: "review menu", sources: "all sources", task: "task source", profile: "role source", snapshot: "permissions/limits", packet: "full source", final: "final confirmation" } as const;
const statuses = { waiting: "awaiting reply", positive_reply: "positive UI reply (not execution authority)", non_positive_reply: "no positive UI reply (not proof of explicit refusal)", invalid_reply: "invalid reply format", expired: "expired (not user refusal)",
  cancelled: "lifecycle/call cancelled", api_error: "UI API error / private details withheld", session_changed: "session changed/unconfirmed", unsupported: "UI support unconfirmed", busy: "review busy/owner closed", invalid_review: "invalid review format/flow" } as const;
/** View callbacks are observations, not proof of physical visibility or user comprehension. */
export function approvalUiViewText(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, "viewStage");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || !viewStages.includes(descriptor.value as ApprovalUiViewStage)) return undefined;
    const labels: Record<ApprovalUiViewStage, string> = { not_observed: "factory not observed", factory_called: "factory called",
      constructed: "editor constructed", rendered: "render called", input_received: "input delivered",
      submitted: "submission callback", completion_requested: "SDK completion requested" };
    return `TUI stage · ${labels[descriptor.value as ApprovalUiViewStage]} · physical visibility unproven`;
  } catch { return undefined; }
}
/** Safe projection also accepts serialized/untrusted rows: own data fields only. */
export function approvalUiText(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  try {
    type DiagnosticField = string | number | boolean | null | undefined;
    const own = (key: string): DiagnosticField => {
      const value: unknown = Object.getOwnPropertyDescriptor(input, key)?.value;
      return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
    };
    const step = own("step"), status = own("status"), api = own("api"), phase = own("phase"), mode = own("mode");
    if (typeof step !== "string" || !Object.hasOwn(steps, step) || typeof status !== "string" || !Object.hasOwn(statuses, status)
      || typeof api !== "string" || !["none", "select", "confirm", "custom"].includes(api) || typeof phase !== "string" || !["ready", "requesting", "returned", "finished"].includes(phase)
      || typeof mode !== "string" || !["tui", "print", "rpc", "unknown"].includes(mode) || own("executionAuthorized") !== false) return undefined;
    const count = (key: string, maximum = 1_000_000) => { const value = own(key); return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined; };
    const elapsed = count("elapsedMs", Number.MAX_SAFE_INTEGER), remaining = own("remainingMs") === null ? null : count("remainingMs"), requests = count("requests"), replies = count("replies");
    if (elapsed === undefined || remaining === undefined || requests === undefined || replies === undefined || replies > requests) return undefined;
    const viewDescriptor = Object.getOwnPropertyDescriptor(input, "viewStage"), view = approvalUiViewText(input);
    if (viewDescriptor && !view) return undefined;
    return `Approval UI · ${steps[step as ApprovalUiStep]} · ${api} · ${statuses[status as ApprovalUiStatus]} · ${elapsed}ms/${remaining === null ? "no response deadline" : `${remaining}ms remaining`} · requests ${requests}/replies ${replies} · mode ${mode}${api === "custom" ? ` · ${view ?? "TUI stage not measured (legacy diagnostic)"}` : ""}`;
  } catch { return undefined; }
}

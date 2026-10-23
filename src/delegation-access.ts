export type AccessBinding = { readonly sessionId: string; readonly cwd: string };
type Bound = { readonly id: string; readonly binding: AccessBinding };
export type DelegationAccessState = { readonly phase: "reviewed" }
  | (Bound & { readonly phase: "awaiting_ack" | "full" })
  | { readonly phase: "revoking"; readonly close: boolean }
  | { readonly phase: "closed" };
export type DelegationAccessEvent = { readonly type: "request"; readonly id: string; readonly binding: AccessBinding }
  | { readonly type: "reply"; readonly id: string; readonly binding: AccessBinding; readonly accepted: unknown }
  | { readonly type: "authorize"; readonly id: string; readonly binding: AccessBinding }
  | { readonly type: "revoke" | "close" | "drained" };
export type DelegationAccessEffect = { readonly type: "acknowledge"; readonly id: string; readonly binding: AccessBinding }
  | { readonly type: "cancel" } | { readonly type: "authorized"; readonly source: "full_access" };
const same = (a: AccessBinding, b: AccessBinding) => a.sessionId === b.sessionId && a.cwd === b.cwd;
const valid = (value: string, maximum: number) => typeof value === "string" && value.length > 0 && value.length <= maximum;

/** Session authority is distinct from a task's native review receipt; no persisted state is replayed here. */
export function reduceDelegationAccess(state: DelegationAccessState, event: DelegationAccessEvent): {
  state: DelegationAccessState; effects: readonly DelegationAccessEffect[];
} {
  const stay = () => ({ state, effects: [] });
  if (state.phase === "closed") return stay();
  if (event.type === "close" || event.type === "revoke") {
    if (state.phase === "reviewed") return event.type === "close" ? { state: { phase: "closed" }, effects: [] } : stay();
    if (state.phase === "revoking") return { state: { ...state, close: state.close || event.type === "close" }, effects: [] };
    return { state: { phase: "revoking", close: event.type === "close" }, effects: [{ type: "cancel" }] };
  }
  if (state.phase === "revoking") return event.type === "drained"
    ? { state: { phase: state.close ? "closed" : "reviewed" }, effects: [] } : stay();
  if (event.type === "request" && state.phase === "reviewed") {
    if (!valid(event.id, 128) || !valid(event.binding.sessionId, 128) || !valid(event.binding.cwd, 4096)) return stay();
    const binding = { ...event.binding };
    return { state: { phase: "awaiting_ack", id: event.id, binding }, effects: [{ type: "acknowledge", id: event.id, binding: { ...binding } }] };
  }
  if ((state.phase !== "awaiting_ack" && state.phase !== "full") || !("id" in event) || event.id !== state.id) return stay();
  if (!same(state.binding, event.binding)) return { state: { phase: "revoking", close: false }, effects: [{ type: "cancel" }] };
  if (state.phase === "awaiting_ack" && event.type === "reply") return {
    state: event.accepted === true ? { ...state, phase: "full" } : { phase: "reviewed" }, effects: [],
  };
  if (state.phase === "full" && event.type === "authorize") return { state, effects: [{ type: "authorized", source: "full_access" }] };
  return stay();
}

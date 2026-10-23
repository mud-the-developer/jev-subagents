import { reduceTaskReview, nativeTaskReviewText, type TaskReview } from "./task-review-machine.ts";

type OpenReview = { readonly review: TaskReview; readonly reviewed: readonly string[] };
export type NativeReviewState = { readonly phase: "idle" }
  | { readonly phase: "reviewing_execution"; readonly review: TaskReview }
  | ({ readonly phase: "menu" } & OpenReview)
  | ({ readonly phase: "confirming" } & OpenReview)
  | ({ readonly phase: "reading"; readonly section: string } & OpenReview)
  | { readonly phase: "approved" } | { readonly phase: "cancelled" };
export type NativeReviewEvent = { readonly type: "start" | "start_execution"; readonly review: TaskReview; readonly now: number }
  | { readonly type: "execution_reply"; readonly id: string; readonly packet: string; readonly accepted: boolean; readonly now: number }
  | { readonly type: "choice"; readonly id: string; readonly value: string | undefined; readonly now: number }
  | { readonly type: "read"; readonly id: string; readonly section: string; readonly accepted: boolean; readonly now: number }
  | { readonly type: "confirm"; readonly id: string; readonly accepted: boolean; readonly now: number }
  | { readonly type: "cancel" };
export type NativeReviewEffect = { readonly type: "menu" }
  | { readonly type: "review_execution"; readonly review: TaskReview }
  | { readonly type: "read"; readonly section: string }
  | { readonly type: "confirm" } | { readonly type: "resolve"; readonly approved: boolean };
const labels: Readonly<Record<string, string>> = { task: "Task source", profile: "Role source", snapshot: "Permissions / limits / verification" };
export const NATIVE_SOURCES = "Review all sources (does not execute)";
export const NATIVE_APPROVE = "Approve this exact execution";
export function nativeSourcesText(review: TaskReview): string {
  return `${nativeTaskReviewText(review)}\n\nSource review only; a separate final dialog approves execution.`;
}
export const NATIVE_PACKET = "Full JSON (optional)";
export const NATIVE_CANCEL = "Cancel / do not execute";

export function nativeReviewChoices(state: Extract<NativeReviewState, { phase: "menu" | "confirming" }>): readonly { label: string; section?: string }[] {
  const sections = state.review.sections.map(s => ({ label: `${state.reviewed.includes(s.id) ? "✓ " : ""}Review ${labels[s.id]}`, section: s.id }));
  const unread = sections.filter(s => !state.reviewed.includes(s.section));
  const read = sections.filter(s => state.reviewed.includes(s.section));
  return [...(state.reviewed.length === 3 ? [{ label: NATIVE_APPROVE }] : [{ label: NATIVE_SOURCES, section: "sources" }]), ...unread, ...read,
    { label: NATIVE_PACKET, section: "packet" }, { label: NATIVE_CANCEL }];
}

/** Pure approval workflow. Exact execution receipts and legacy source acknowledgements are distinct events. */
export function reduceNativeReview(state: NativeReviewState, event: NativeReviewEvent): { state: NativeReviewState; effects: readonly NativeReviewEffect[] } {
  const stay = () => ({ state, effects: [] });
  const finish = (approved: boolean) => ({ state: { phase: approved ? "approved" : "cancelled" } as NativeReviewState,
    effects: [{ type: "resolve", approved }] as const });
  if (state.phase === "approved" || state.phase === "cancelled") return stay();
  if (event.type === "cancel") return finish(false);
  if (event.type === "start" || event.type === "start_execution") {
    if (state.phase !== "idle") return stay();
    const checked = reduceTaskReview({ phase: "idle" }, { type: "request", review: event.review }).state;
    if (checked.phase !== "review" || !Number.isSafeInteger(event.now) || (checked.review.deadline !== null && event.now >= checked.review.deadline)) return finish(false);
    if (event.type === "start_execution") return { state: { phase: "reviewing_execution", review: checked.review },
      effects: [{ type: "review_execution", review: checked.review }] };
    return { state: { phase: "menu", review: checked.review, reviewed: [] }, effects: [{ type: "menu" }] };
  }
  if (state.phase === "idle" || !("id" in event) || event.id !== state.review.id) return stay();
  if (!Number.isSafeInteger(event.now) || (state.review.deadline !== null && event.now >= state.review.deadline)) return finish(false);
  if (event.type === "execution_reply" && state.phase === "reviewing_execution")
    return finish(event.accepted === true && event.packet === state.review.packet);
  if (event.type === "choice" && state.phase === "menu") {
    if (event.value === NATIVE_APPROVE) {
      if (state.reviewed.length !== 3) return finish(false);
      return { state: { ...state, phase: "confirming" }, effects: [{ type: "confirm" }] };
    }
    const selected = nativeReviewChoices(state).find(item => item.label === event.value);
    if (!selected?.section) return finish(false);
    return { state: { ...state, phase: "reading", section: selected.section }, effects: [{ type: "read", section: selected.section }] };
  }
  if (event.type === "read" && state.phase === "reading") {
    if (event.section !== state.section) return stay();
    if (event.accepted !== true) return finish(false);
    const reviewed = state.section === "sources" ? state.review.sections.map(section => section.id)
      : state.section === "packet" || state.reviewed.includes(state.section) ? [...state.reviewed] : [...state.reviewed, state.section];
    return { state: { phase: "menu", review: state.review, reviewed }, effects: [{ type: "menu" }] };
  }
  if (event.type === "confirm" && state.phase === "confirming") {
    const gate = reduceTaskReview({ phase: "review", review: state.review }, { type: "decide", id: state.review.id,
      packet: state.review.packet, reviewed: state.reviewed, accepted: event.accepted, now: event.now });
    return finish(gate.state.phase === "approved");
  }
  return stay();
}

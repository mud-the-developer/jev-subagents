import type { SetupReport } from "../scripts/setup.ts";

export const STUDIO_SERVICE = Object.freeze({ id: "jev.setup-studio.v1", local: false });
export type StudioProfile = { readonly file: string; readonly content: string };
export type StudioReview = { readonly id: string; readonly packet: string; readonly profiles: readonly StudioProfile[]; readonly deadline: number };
export type StudioState =
  | { readonly phase: "idle" }
  | { readonly phase: "checking"; readonly operation: "setup" | "status" }
  | { readonly phase: "review"; readonly review: StudioReview }
  | { readonly phase: "creating" }
  | { readonly phase: "complete"; readonly report?: SetupReport }
  | { readonly phase: "cancelled"; readonly reason: string }
  | { readonly phase: "error"; readonly reason: string };
export type StudioEvent =
  | { readonly type: "start"; readonly operation: "setup" | "status" }
  | { readonly type: "review"; readonly review: StudioReview }
  | { readonly type: "decision"; readonly id: string; readonly packet: string; readonly accepted: boolean; readonly reviewed: readonly string[]; readonly now: number }
  | { readonly type: "finish"; readonly report?: SetupReport }
  | { readonly type: "cancel"; readonly reason: string }
  | { readonly type: "fail"; readonly reason: string };
export type StudioEffect = { readonly type: "resolve-review"; readonly accepted: boolean }
  | { readonly type: "run"; readonly operation: "setup" | "status" };

/** GUI decisions are pure data. A displayed summary is never an execution approval. */
export function reduceStudio(state: StudioState, event: StudioEvent): { state: StudioState; effects: readonly StudioEffect[] } {
  const stay = () => ({ state, effects: [] });
  if (event.type === "start") {
    if (["checking", "review", "creating"].includes(state.phase)) return stay();
    return { state: { phase: "checking", operation: event.operation }, effects: [{ type: "run", operation: event.operation }] };
  }
  if (event.type === "cancel" || event.type === "fail") return {
    state: { phase: event.type === "cancel" ? "cancelled" : "error", reason: event.reason },
    effects: state.phase === "review" ? [{ type: "resolve-review", accepted: false }] : [],
  };
  if (event.type === "review") {
    if (state.phase !== "checking" || !Number.isSafeInteger(event.review.deadline) || !event.review.profiles.length || event.review.profiles.length > 4 ||
      new Set(event.review.profiles.map(profile => profile.file)).size !== event.review.profiles.length) return stay();
    return { state: { phase: "review", review: { ...event.review, profiles: event.review.profiles.map(profile => ({ ...profile })) } }, effects: [] };
  }
  if (event.type === "decision") {
    if (state.phase !== "review" || event.id !== state.review.id) return stay();
    const review = state.review;
    const valid = event.accepted === true && Number.isSafeInteger(event.now) && event.now < review.deadline &&
      event.packet === review.packet && event.reviewed.length === review.profiles.length &&
      new Set(event.reviewed).size === review.profiles.length && review.profiles.every(profile => event.reviewed.includes(profile.file));
    return { state: valid ? { phase: "creating" } : { phase: "cancelled", reason: "Review cancelled, or exact source/deadline mismatch." },
      effects: [{ type: "resolve-review", accepted: valid }] };
  }
  if (event.type === "finish") {
    if (state.phase !== "checking" && state.phase !== "creating") return stay();
    return { state: { phase: "complete", ...(event.report ? { report: event.report } : {}) }, effects: [] };
  }
  return stay();
}

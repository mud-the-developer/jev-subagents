import { Value } from "typebox/value";
import { RunSchema, executionSeconds, RUN_TIMEOUT_MS, type Run, type Effect as DelegateEffect } from "./delegate-machine.ts";
import { workerPrompt } from "./assessment.ts";
import type { ApprovalUiObserver } from "./approval-ui-diagnostics.ts";

export const TASK_REVIEW_SERVICE = Object.freeze({ id: "jev.task-review.v1", local: false });
export type TaskReviewContent = {
  readonly summary: { readonly task: string; readonly role: string; readonly model: string; readonly thinking: string; readonly cwd: string;
    readonly tools: readonly string[]; readonly maxModelCalls: number | null; readonly seconds?: number; readonly verification: string };
  readonly risks: readonly string[];
  readonly sections: readonly { readonly id: string; readonly title: string; readonly text: string }[];
  readonly packet: string;
};
export type TaskReview = TaskReviewContent & { readonly id: string; readonly deadline: number | null };
export type TaskReviewState = { readonly phase: "idle" } | { readonly phase: "review"; readonly review: TaskReview }
  | { readonly phase: "approved" | "cancelled"; readonly reason: string };
export type TaskReviewEvent = { readonly type: "request"; readonly review: TaskReview }
  | { readonly type: "decide"; readonly id: string; readonly packet: string; readonly accepted: boolean; readonly reviewed: readonly string[]; readonly now: number }
  | { readonly type: "cancel"; readonly reason: string };
export type TaskReviewEffect = { readonly type: "resolve"; readonly approved: boolean };
export type RunApproval = (content: TaskReviewContent, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
  signal?: AbortSignal, observer?: ApprovalUiObserver) => Promise<boolean | undefined>;

/** Preserve ordinary source text; quote rare terminal/control or bidi sequences without executing them. */
export function humanLiteral(value: string): string {
  return /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)
    ? JSON.stringify(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : value;
}
export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}h (${seconds}s)`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return `${minutes}m${rest ? ` ${rest}s` : ""} (${seconds}s)`;
}
export function callLimitText(limit: number | null): string {
  return limit === null ? "SDK natural completion · no model-round cap" : `SDK model-round cap ${limit}`;
}

/** Plain display data; the full exact run/selection remains available, without escaped task text in the main summary. */
export function taskReviewContent(run: Run, selection?: Extract<DelegateEffect, { type: "confirm_run" }>["selection"]): TaskReviewContent {
  if (!Value.Check(RunSchema, run) || run.solPi) throw new Error("Only an ordinary validated worker can use this review.");
  const packet = JSON.stringify({ run, ...(selection ? { selection } : {}) }, null, 2);
  const seconds = executionSeconds(run);
  const verification = run.verification ? ["Exact verification command (no implicit shell)",
    `Literal argv · ${humanLiteral(JSON.stringify([run.verification.command, ...run.verification.args]))}`,
    `Executable · ${humanLiteral(run.verification.command)}`,
    ...run.verification.args.map((arg, index) => `Argument ${index + 1} · ${humanLiteral(arg)}`),
    ...(run.verification.description ? [`Verification scope · ${humanLiteral(run.verification.description)}`] : [])].join("\n") : "None — execution results are unverified.";
  const metadata = [`Workspace · ${humanLiteral(run.cwd)}`, `Model · ${humanLiteral(`${run.model.provider}/${run.model.id}`)}`,
    `Thinking · ${run.agent.thinking ?? "off / model default"}`, `Tools · ${run.agent.tools.join(", ")}`,
    "File boundary · ordinary profile permissions (not file-ID restricted)",
    `Runtime · after approval ${durationText(seconds)} · no existing-grant extension`, callLimitText(run.maxModelCalls),
    `Selection · ${selection?.source ?? "fixed profile"}`, "Verification", verification].join("\n");
  return {
    summary: { task: run.task.replace(/\s+/g, " ").slice(0, 200) + (run.task.replace(/\s+/g, " ").length > 200 ? "…" : ""), role: run.agent.name, model: `${run.model.provider}/${run.model.id}`, thinking: run.agent.thinking ?? "off requested (model defaults may apply)",
      cwd: run.cwd, tools: [...run.agent.tools], maxModelCalls: run.maxModelCalls, seconds, verification },
    risks: [
      "Runs with your filesystem/shell permissions. Not a sandbox or automatic rollback.",
      `Model/subscription usage may be charged. Runtime after approval: ${durationText(seconds)}. SDK rounds may be uncapped; time/round limits are NOT token or money quotas.`,
      "Only the approved model, thinking and tools are used. No inherited parent conversation or other extensions; project AGENTS.md applies.",
      "Failure or limit exhaustion never triggers automatic retry, model substitution or redelegation. Applied changes may remain.",
      "Verification runs in a separate process with a 30-second deadline and no implicit shell. The command can modify files. Only the exit code is retained, not output.",
      "Supplied criteria also reach the worker. Assessment requires passed verification and separate evidence-transmission approval; it is advice, not proof.",
      ...(selection ? ["JEV/soft routing is advisory. Support is not a success probability; sampled selection can differ from the top candidate."] : []),
    ],
    sections: [
      { id: "task", title: "Task source · exact worker input", text: humanLiteral(workerPrompt(run)) },
      { id: "profile", title: "Profile source · role instructions", text: `File · ${humanLiteral(run.agent.file)}\nDescription · ${humanLiteral(run.agent.description)}\n\n${humanLiteral(run.agent.systemPrompt)}` },
      { id: "snapshot", title: "Permissions / limits / verification / selection", text: metadata },
    ], packet,
  };
}

export function nativeTaskReviewText(content: TaskReviewContent): string {
  const s = content.summary;
  return [`JEV · Review ${humanLiteral(s.role)}`, `Model · ${humanLiteral(s.model)}\nThinking · ${humanLiteral(s.thinking)}\nWorkspace · ${humanLiteral(s.cwd)}`,
    `Runtime · after approval ${durationText(s.seconds ?? RUN_TIMEOUT_MS / 1000)}\n${callLimitText(s.maxModelCalls)}\nTools · ${s.tools.join(", ")}`,
    "Review these boundaries\n" + content.risks.map(risk => `• ${risk}`).join("\n"),
    ...content.sections.map(section => `── ${section.title} ──\n${section.text}`),
    "These complete sections describe only this exact invocation. Approval does not authorize future tasks or a session-wide permission mode.",
  ].join("\n\n");
}

/** Single-use exact scope approval. All time/nonce/lease sources remain in effects. */
export function reduceTaskReview(state: TaskReviewState, event: TaskReviewEvent): { state: TaskReviewState; effects: readonly TaskReviewEffect[] } {
  const stay = () => ({ state, effects: [] });
  if (event.type === "request") {
    if (state.phase === "review" || !event.review.id || (event.review.deadline !== null && !Number.isSafeInteger(event.review.deadline)) || !event.review.packet ||
      event.review.packet.length > 65_536 || event.review.sections.length !== 3 ||
      event.review.sections.map(s => s.id).join(",") !== "task,profile,snapshot") return stay();
    return { state: { phase: "review", review: structuredClone(event.review) }, effects: [] };
  }
  if (state.phase !== "review") return stay();
  if (event.type === "cancel") return { state: { phase: "cancelled", reason: event.reason }, effects: [{ type: "resolve", approved: false }] };
  if (event.type === "decide") {
    if (event.id !== state.review.id) return stay();
    const approved = event.accepted === true && event.packet === state.review.packet && Number.isSafeInteger(event.now) &&
      (state.review.deadline === null || event.now < state.review.deadline) &&
      event.reviewed.length === 3 && new Set(event.reviewed).size === 3 && state.review.sections.every(s => event.reviewed.includes(s.id));
    return { state: { phase: approved ? "approved" : "cancelled", reason: approved ? "Approved only this exact execution." : "Source, reviewed sections or deadline did not match, or the review was cancelled." },
      effects: [{ type: "resolve", approved }] };
  }
  return stay();
}

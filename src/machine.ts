import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { JevReportSchema, readChoice, reportData, validDraw, sampleChoice, type JevReport, type Probabilities } from "./choice.ts";
import { englishProse, INTERNAL_LANGUAGE_ERROR } from "./internal-language.ts";
import { validSkills, validSkillSuggestion, type SkillCandidate, type SkillSuggestion } from "./skill-suggestion.ts";

export const JEV_MODEL = "jev-1.13.0";
export const LIMITS = { task: 4_000, agents: 16, name: 64, description: 256 } as const;
export const AGENT_NAME_PATTERN = "^[a-z][a-z0-9_-]*$";
// ponytail: configured consultation rate; learn/calibrate need only with approved usefulness data.
export const SoftRoutingSchema = Type.Object({
  baseline: Type.String({ pattern: AGENT_NAME_PATTERN, minLength: 1, maxLength: LIMITS.name }),
  consultProbability: Type.Optional(Type.Number({ minimum: 0, maximum: 1, default: 1,
    description: "Explicit JEV consultation rate; default 1. A policy rate, not a learned probability of need. Do not invent a calibrated score." })),
}, { additionalProperties: false });
export type SoftRouting = Static<typeof SoftRoutingSchema>;
export type RoutingTrace = {
  readonly baseline: string; readonly consultProbability: number;
  readonly gateDraw: number | null; readonly selectionDraw: number | null; readonly recommendedAgent: string | null;
};
export type RouteRequest = {
  readonly task: string;
  readonly agents: readonly { readonly name: string; readonly description: string }[];
  readonly softRouting?: SoftRouting;
  readonly skillCandidates?: readonly SkillCandidate[];
};
export type Decision = JevReport & {
  readonly agent: string; readonly confidence: number; readonly source?: "jev";
  readonly probabilities?: Probabilities; readonly softRouting?: RoutingTrace;
  readonly skillSuggestion?: SkillSuggestion;
};
export type BaselineDecision = { readonly source: "baseline"; readonly agent: string; readonly softRouting: RoutingTrace };
type Pending = { readonly request: RouteRequest };
export type State =
  | { readonly status: "idle" }
  | ({ readonly status: "gating"; readonly trace: RoutingTrace } & Pending)
  | ({ readonly status: "routing"; readonly trace?: RoutingTrace } & Pending)
  | ({ readonly status: "sampling"; readonly trace: RoutingTrace; readonly decision: Decision & { readonly probabilities: Probabilities } } & Pending)
  | { readonly status: "succeeded"; readonly decision: Decision | BaselineDecision }
  | { readonly status: "failed"; readonly error: string; readonly jev?: JevReport }
  | { readonly status: "cancelled"; readonly jev?: JevReport };
export type Event =
  | { readonly type: "route" | "route_plans"; readonly request: RouteRequest }
  | { readonly type: "resolved"; readonly decision: Decision }
  | { readonly type: "route_draw"; readonly purpose: "gate" | "selection"; readonly value: number }
  | { readonly type: "failed"; readonly error: string; readonly jev?: JevReport }
  | { readonly type: "cancel"; readonly jev?: JevReport };
export type Effect = { readonly type: "call_jev"; readonly request: RouteRequest }
  | { readonly type: "sample_route"; readonly purpose: "gate" | "selection" };
export type Transition = { readonly state: State; readonly effects: readonly Effect[] };

function validateRequest(request: RouteRequest, plans: boolean): string | undefined {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      typeof request.task !== "string" || !Array.isArray(request.agents)) return "Invalid routing request.";
  const taskLimit = plans ? 8_000 : LIMITS.task;
  const agentLimit = plans ? 128 : LIMITS.agents;
  if (!request.task.trim() || request.task.length > taskLimit) return `Task must contain 1–${taskLimit} characters of non-blank text.`;
  if (!englishProse(request.task)) return INTERNAL_LANGUAGE_ERROR;
  if (request.skillCandidates !== undefined && !validSkills(request.skillCandidates)) return "Supply up to eight unique, explicit English skill descriptions; none is reserved.";
  if (request.agents.length < 2 || request.agents.length > agentLimit) return `Supply 2–${agentLimit} agents. One candidate does not need a paid router.`;
  for (const agent of request.agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent) ||
        typeof agent.name !== "string" || typeof agent.description !== "string" ||
        !new RegExp(AGENT_NAME_PATTERN).test(agent.name) || agent.name.length > LIMITS.name ||
        !agent.description.trim() || agent.description.length > (plans ? 4_096 : LIMITS.description)) return "Invalid agent name or description.";
    if (!englishProse(agent.description)) return INTERNAL_LANGUAGE_ERROR;
  }
  if (new Set(request.agents.map((agent) => agent.name)).size !== request.agents.length) return "Agent names must be unique.";
  const softRouting = request.softRouting;
  if (softRouting !== undefined && (!Value.Check(SoftRoutingSchema, softRouting) ||
      !request.agents.some((agent) => agent.name === softRouting.baseline))) return "Soft routing requires an explicit permitted baseline and a valid consultation rate.";
  return undefined;
}
function baseline(trace: RoutingTrace): Transition {
  return { state: { status: "succeeded", decision: { source: "baseline", agent: trace.baseline, softRouting: trace } }, effects: [] };
}
function call(request: RouteRequest, trace?: RoutingTrace): Transition {
  return { state: { status: "routing", request, ...(trace ? { trace } : {}) }, effects: [{ type: "call_jev", request }] };
}
export function reduce(state: State, event: Event): Transition {
  if (state.status === "succeeded" || state.status === "failed" || state.status === "cancelled") return { state, effects: [] };
  const report = event.type === "resolved" ? reportData(event.decision)
    : "jev" in event ? event.jev : undefined;
  const observed = state.status === "sampling" ? reportData(state.decision)
    : Value.Check(JevReportSchema, report) ? report : undefined;
  const jev = observed ? { jev: structuredClone(observed) } : {};
  if (event.type === "cancel") return { state: { status: "cancelled", ...jev }, effects: [] };
  if (event.type === "failed" && state.status !== "idle") return { state: { status: "failed", error: event.error, ...jev }, effects: [] };
  const fail = (error: string): Transition => ({ state: { status: "failed", error, ...jev }, effects: [] });
  switch (state.status) {
    case "idle": {
      if (event.type !== "route" && event.type !== "route_plans") break;
      const error = validateRequest(event.request, event.type === "route_plans");
      if (error) return fail(error);
      const request: RouteRequest = { task: event.request.task,
        agents: event.request.agents.map(({ name, description }) => ({ name, description })),
        ...(event.request.softRouting ? { softRouting: { ...event.request.softRouting } } : {}),
        ...(event.request.skillCandidates ? { skillCandidates: event.request.skillCandidates.map(skill => ({ ...skill })) } : {}) };
      if (!request.softRouting) return call(request);
      const trace: RoutingTrace = { baseline: request.softRouting.baseline, consultProbability: request.softRouting.consultProbability ?? 1,
        gateDraw: null, selectionDraw: null, recommendedAgent: null };
      if (trace.consultProbability === 0) return baseline(trace);
      if (trace.consultProbability === 1) return call(request, trace);
      return { state: { status: "gating", request, trace }, effects: [{ type: "sample_route", purpose: "gate" }] };
    }
    case "gating": {
      if (event.type !== "route_draw" || event.purpose !== "gate") break;
      if (!validDraw(event.value)) return fail("Invalid routing draw.");
      const trace = { ...state.trace, gateDraw: event.value };
      return event.value < trace.consultProbability ? call(state.request, trace) : baseline(trace);
    }
    case "routing": {
      if (event.type !== "resolved") break;
      if (!state.request.agents.some((agent) => agent.name === event.decision?.agent)) return fail("JEV selected an agent outside the supplied candidates.");
      if (state.request.skillCandidates ? !validSkillSuggestion(event.decision.skillSuggestion, state.request.skillCandidates)
        : event.decision.skillSuggestion !== undefined) return fail("Invalid or unsolicited skill suggestion; no skill was loaded.");
      try {
        const report = reportData(event.decision);
        if (!Value.Check(JevReportSchema, report)) return fail("Invalid JEV accounting.");
        const choice = readChoice({ type: "choice", choice: event.decision.agent, confidence: event.decision.confidence,
          ...(event.decision.probabilities === undefined ? {} : { probabilities: event.decision.probabilities }) },
          state.request.agents.map((agent) => agent.name), Boolean(state.trace), report.provider, report.model);
        const decision: Decision = { agent: choice.choice, confidence: choice.confidence, ...structuredClone(report),
          ...(choice.probabilities ? { probabilities: choice.probabilities } : {}),
          ...(event.decision.skillSuggestion ? { skillSuggestion: { ...event.decision.skillSuggestion } } : {}) };
        if (!state.trace) return { state: { status: "succeeded", decision }, effects: [] };
        if (!choice.probabilities) return fail("Missing JEV routing probabilities.");
        return { state: { ...state, status: "sampling", trace: state.trace, decision: { ...decision, probabilities: choice.probabilities } },
          effects: [{ type: "sample_route", purpose: "selection" }] };
      } catch { return fail("Invalid JEV routing probabilities or decision."); }
    }
    case "sampling": {
      if (event.type !== "route_draw" || event.purpose !== "selection") break;
      if (!validDraw(event.value)) return fail("Invalid routing draw.");
      const agent = sampleChoice(state.decision.probabilities, event.value);
      return { state: { status: "succeeded", decision: { ...state.decision, agent, softRouting: {
        ...state.trace, selectionDraw: event.value, recommendedAgent: state.decision.agent,
      } } }, effects: [] };
    }
    default:
      state satisfies never;
      throw new Error("Unhandled routing state.");
  }
  return { state, effects: [] };
}

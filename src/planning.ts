import { Type, type Static } from "typebox";
import type { Agent, AgentDefinition } from "./delegate-machine.ts";

const closed = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ pattern: "\\S", minLength: 1, maxLength });
export const ModelSchema = Type.Object({ provider: text(128), id: text(256) }, closed);
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingSchema = Type.Union([
  Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
export type Thinking = Static<typeof ThinkingSchema>;
export const MAX_PLANS = 128;
export const PoolSchema = Type.Object({
  models: Type.Array(Type.Object({ provider: Type.Literal("openai-codex"), id: text(256) }, closed), {
    minItems: 1, maxItems: 8, uniqueItems: true,
  }),
  thinking: Type.Array(ThinkingSchema, { minItems: 1, maxItems: 5, uniqueItems: true }),
}, closed);
export const CapabilitySchema = Type.Object({
  model: ModelSchema,
  thinking: Type.Array(ThinkingSchema, { maxItems: 5, uniqueItems: true }),
  contextWindow: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
export type Capability = Static<typeof CapabilitySchema>;
export type Plan = { readonly id: string; readonly agent: Agent; readonly description: string };

// Deliberately narrower than the SDK UI levels: no ambiguous off/default or minimal→low aliases.
export function codexThinkingLevels(model: {
  provider: string; api?: string; reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<Thinking, unknown>>;
}): Thinking[] {
  if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !model.reasoning) return [];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return (mapped === undefined || mapped === level) &&
      (level !== "xhigh" && level !== "max" || mapped === level);
  });
}

export function planDescription(agent: Agent, capability?: Capability): string {
  return JSON.stringify({ role: agent.name, suitability: agent.description, model: agent.model, thinking: agent.thinking ?? "off",
    contextWindow: capability?.contextWindow, performance: "Not benchmarked; model names are not quality or quota guarantees." });
}

export function buildPlans(agents: readonly AgentDefinition[], capabilities: readonly Capability[]): readonly Plan[] {
  const expanded = agents.some((agent) => agent.pool);
  const plans: Plan[] = [];
  for (const definition of agents) {
    const { pool, ...base } = definition;
    for (const model of pool?.models ?? [base.model]) {
      const capability = capabilities.find((item) => item.model.provider === model.provider && item.model.id === model.id);
      for (const thinking of pool?.thinking ?? [base.thinking]) {
        if (thinking && !capability?.thinking.includes(thinking)) continue;
        const agent = { ...base, model, ...(thinking ? { thinking } : {}) };
        const description = pool || thinking ? planDescription(agent, capability) : agent.description;
        plans.push({ id: expanded ? `plan_${plans.length}` : agent.name, agent, description });
        if (plans.length > MAX_PLANS) return []; // Fail closed; never silently truncate the permitted pool.
      }
    }
  }
  return plans;
}

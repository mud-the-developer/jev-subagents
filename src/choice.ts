import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const JevReportSchema = Type.Object({
  model: Type.String({ pattern: "\\S", minLength: 1, maxLength: 128 }),
  provider: Type.Optional(Type.Union([Type.Literal("openjev"), Type.Literal("clef")])),
  requestedModel: Type.Optional(Type.String({ pattern: "\\S", minLength: 1, maxLength: 128 })),
  usage: Type.Object({ inputTokens: count, outputTokens: count }, { additionalProperties: false }),
}, { additionalProperties: false });
export type JevReport = Static<typeof JevReportSchema>;
// Pinned JEV list-price estimate, not an invoice; output tokens are currently uncharged.
export function estimateJevUsd(usage: JevReport["usage"]): number;
export function estimateJevUsd(usage: JevReport["usage"], provider: JevReport["provider"]): number | null;
export function estimateJevUsd(usage: JevReport["usage"], provider?: JevReport["provider"]): number | null {
  return provider === "openjev" || provider === "clef" ? null : usage.inputTokens * 0.042 / 1_000_000;
}
export type Probabilities = Readonly<Record<string, number>>;
export type Choice = { readonly choice: string; readonly confidence: number; readonly probabilities?: Probabilities };

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
export function validDraw(value: unknown): value is number {
  return probability(value) && value < 1;
}
export function reportData(value: unknown): JevReport | undefined {
  if (!record(value)) return undefined;
  const report = { model: value.model, usage: value.usage,
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.requestedModel === undefined ? {} : { requestedModel: value.requestedModel }) };
  return Value.Check(JevReportSchema, report) ? report : undefined;
}
export function readJevReport(body: unknown): JevReport | undefined {
  if (!record(body) || !record(body.usage)) return undefined;
  const report = reportData({ ...body, usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens } });
  return Value.Check(JevReportSchema, report) ? report : undefined;
}

// Return an owned map in candidate order, not response order. Never invent missing mass.
export function readProbabilities(value: unknown, ids: readonly string[], provider?: JevReport["provider"], model?: string): Probabilities {
  if (!record(value) || ids.length < 2 || ids.length > 128 || new Set(ids).size !== ids.length ||
      Object.keys(value).length !== ids.length || !ids.every((id) => Object.hasOwn(value, id) && probability(value[id]))) {
    throw new Error("Invalid JEV probability distribution.");
  }
  const probabilities = Object.fromEntries(ids.map((id) => [id, value[id] as number]));
  const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
  // Published Clef and OpenJEV/Laya serializers round EACH option to 4 decimals. Preserve the map;
  // allow only their mathematically bounded rounding error, never fill/renormalize missing mass.
  const roundedBackend = provider === "clef" || provider === "openjev" && model === "laya-1.0";
  const fourDecimals = roundedBackend && Object.values(probabilities).every(p => Math.abs(p * 10000 - Math.round(p * 10000)) < 1e-7);
  const tolerance = fourDecimals ? Math.max(1e-6, ids.length * 0.00005 + 1e-12) : 1e-6;
  if (Math.abs(total - 1) > tolerance) throw Object.assign(new Error("Invalid JEV probability total."), {
    probabilityTotal: total, probabilityTolerance: tolerance, candidateCount: ids.length,
  });
  return probabilities;
}
export function readChoice(answer: unknown, ids: readonly string[], requireProbabilities = false, provider?: JevReport["provider"], model?: string): Choice {
  if (!record(answer) || answer.type !== "choice" || typeof answer.choice !== "string" ||
      !ids.includes(answer.choice) || !probability(answer.confidence)) throw new Error("Invalid JEV choice.");
  if (answer.probabilities === undefined && !requireProbabilities) return { choice: answer.choice, confidence: answer.confidence };
  const probabilities = readProbabilities(answer.probabilities, ids, provider, model);
  if (probabilities[answer.choice] !== Math.max(...Object.values(probabilities))) throw new Error("JEV choice is not a maximum.");
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}
export function sampleChoice(probabilities: Probabilities, draw: number): string {
  if (!validDraw(draw)) throw new Error("Invalid routing draw.");
  const entries = Object.entries(probabilities);
  const target = draw * entries.reduce((sum, [, p]) => sum + p, 0);
  let cumulative = 0, lastPositive = "";
  for (const [id, p] of entries) {
    if (p > 0) lastPositive = id;
    cumulative += p;
    if (p > 0 && target < cumulative) return id;
  }
  // Floating-point rounding at the upper endpoint must never select a zero-mass option.
  if (!lastPositive) throw new Error("Empty routing distribution.");
  return lastPositive;
}

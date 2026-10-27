import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
export const MAX_AVAILABLE_MODELS = 128;
export const EXECUTION_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const MAX_AVAILABLE_CHOICES = MAX_AVAILABLE_MODELS * EXECUTION_THINKING.length;
export type AvailableChoice = {
  readonly id: string;
  readonly model: { readonly provider: string; readonly id: string };
  readonly thinking: ModelThinkingLevel;
  readonly api: string;
  readonly endpoint: string;
  readonly contextWindow: number;
  readonly cost?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number } | null;
};
export type AvailableCatalog = { readonly ok: true; readonly choices: readonly AvailableChoice[] }
  | { readonly ok: false; readonly reason: "invalid_catalog" | "ambiguous_catalog" | "catalog_overflow" | "no_available_models" };

/** Canonical SDK levels only; an alias is not permission to execute a different effort. */
export function availableThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  return getSupportedThinkingLevels(model).filter(level => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped === undefined || mapped === level;
  });
}

/** The effect supplies an availability snapshot, not an unfiltered registry or a live probe. */
export function buildAvailableCatalog(models: readonly Model<Api>[], thinkingLevels: (model: Model<Api>) => readonly ModelThinkingLevel[] = availableThinkingLevels): AvailableCatalog {
  const choices: AvailableChoice[] = [], seen = new Set<string>();
  const ordered = [...models].sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const model of ordered) {
    if (!model.provider || model.provider.length > 128 || !model.id || model.id.length > 256 || !model.api || model.api.length > 128 || !model.baseUrl || model.baseUrl.length > 2048 ||
      /[\u0000-\u001f\u007f]/.test(model.provider + model.id + model.api + model.baseUrl) || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) return { ok: false, reason: "invalid_catalog" };
    try {
      const endpoint = new URL(model.baseUrl);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash ||
        [...endpoint.searchParams.keys()].some(name => /key|token|secret|password|authorization/i.test(name))) return { ok: false, reason: "invalid_catalog" };
    } catch { return { ok: false, reason: "invalid_catalog" }; }
    const key = JSON.stringify([model.provider, model.id]);
    if (seen.has(key)) return { ok: false, reason: "ambiguous_catalog" };
    seen.add(key);
    if (seen.size > MAX_AVAILABLE_MODELS) return { ok: false, reason: "catalog_overflow" };
    if (!model.input.includes("text")) continue;
    const levels = thinkingLevels(model);
    if (levels.length > EXECUTION_THINKING.length || new Set(levels).size !== levels.length ||
      levels.some(level => !EXECUTION_THINKING.includes(level))) return { ok: false, reason: "invalid_catalog" };
    for (const thinking of levels) {
      choices.push({ id: `model_${choices.length}`, model: { provider: model.provider, id: model.id }, thinking,
        api: model.api, endpoint: model.baseUrl, contextWindow: model.contextWindow,
        cost: [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(value => Number.isFinite(value) && value >= 0)
          ? { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite } : null });
      if (choices.length > MAX_AVAILABLE_CHOICES) return { ok: false, reason: "catalog_overflow" };
    }
  }
  return choices.length ? { ok: true, choices } : { ok: false, reason: "no_available_models" };
}

/** Public routing metadata deliberately excludes transport endpoints and credentials. */
export function availableChoiceDetails(choice: AvailableChoice) {
  return { model: choice.model, thinking: choice.thinking, contextWindow: choice.contextWindow,
    listedUsdPerMillionTokens: choice.cost ?? null, pricing: "SDK base rates; not a task cost, tier quote or invoice.",
    availability: "Configured availability snapshot; not a quota, correctness or inference guarantee." };
}
export function availableChoiceDescription(choice: AvailableChoice): string { return JSON.stringify(availableChoiceDetails(choice)); }

/** Human-only lossless projection; every original candidate ID still maps to its exact model and effort. */
export function availableChoiceReviewGroups(choices: readonly AvailableChoice[]) {
  const groups = new Map<string, { metadata: Omit<ReturnType<typeof availableChoiceDetails>, "thinking">;
    choices: { id: string; thinking: ModelThinkingLevel }[] }>();
  for (const choice of choices) {
    const { thinking, ...metadata } = availableChoiceDetails(choice), key = JSON.stringify(metadata);
    const group = groups.get(key) ?? { metadata, choices: [] };
    group.choices.push({ id: choice.id, thinking }); groups.set(key, group);
  }
  return [...groups.values()];
}

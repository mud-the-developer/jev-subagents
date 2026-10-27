import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildAvailableCatalog, availableThinkingLevels, availableChoiceDescription, availableChoiceReviewGroups } from "../src/available-models.ts";

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
  return { provider, id, name: id, api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
    input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096, ...extra };
}

test("available choices use actual models from multiple providers rather than fixed role names", () => {
  const input = [model("vendor-b", "reasoner", { reasoning: true, thinkingLevelMap: { minimal: "low", medium: null, xhigh: "xhigh", max: "max" } }),
    model("vendor-a", "plain")];
  const before = structuredClone(input), catalog = buildAvailableCatalog(input);
  assert.equal(catalog.ok, true); if (!catalog.ok) return;
  assert.deepEqual(catalog.choices.map(choice => [choice.model.provider, choice.model.id, choice.thinking]), [
    ["vendor-a", "plain", "off"], ["vendor-b", "reasoner", "off"], ["vendor-b", "reasoner", "low"],
    ["vendor-b", "reasoner", "high"], ["vendor-b", "reasoner", "xhigh"], ["vendor-b", "reasoner", "max"],
  ]);
  assert.deepEqual(input, before); assert.equal(catalog.choices[0]!.id, "model_0");
});

test("canonical SDK thinking includes off/minimal and excludes aliases or unsupported levels", () => {
  assert.deepEqual(availableThinkingLevels(model("vendor", "plain")), ["off"]);
  assert.deepEqual(availableThinkingLevels(model("vendor", "reasoner", { reasoning: true })), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(availableThinkingLevels(model("vendor", "reasoner", { reasoning: true, thinkingLevelMap: { minimal: "low", high: null, xhigh: "high", max: null } })), ["off", "low", "medium"]);
});

test("the automatic catalog retains every supported pair across a real-sized available model list", () => {
  const models = Array.from({ length: 98 }, (_, i) => model("available-provider", `available-${i}`, { reasoning: true }));
  const catalog = buildAvailableCatalog(models);
  assert.equal(catalog.ok, true); if (!catalog.ok) return;
  assert.equal(catalog.choices.length, 490); assert.equal(new Set(catalog.choices.map(choice => choice.model.id)).size, 98);
  const maximum = buildAvailableCatalog(Array.from({ length: 128 }, (_, i) => model("available-provider", `maximum-${i}`, {
    reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  })));
  assert.equal(maximum.ok, true); if (maximum.ok) assert.equal(maximum.choices.length, 896);
  assert.deepEqual(buildAvailableCatalog([model("a", "invalid")], () => ["off", "off"]), { ok: false, reason: "invalid_catalog" });
});

test("catalog ordering is deterministic and public routing descriptions omit endpoints", () => {
  const input = [model("b", "z"), model("a", "b"), model("a", "a")];
  const first = buildAvailableCatalog(input), second = buildAvailableCatalog([...input].reverse());
  assert.deepEqual(first, second); assert.equal(first.ok, true); if (!first.ok) return;
  const text = first.choices.map(availableChoiceDescription).join("\n");
  assert.match(text, /Configured availability snapshot/); assert.doesNotMatch(text, /127\.0\.0\.1|baseUrl|endpoint/);
});

test("human review grouping is complete and lossless without transport endpoints or candidate truncation", () => {
  const catalog = buildAvailableCatalog(Array.from({ length: 98 }, (_, i) => model("vendor", `model-${i}`, { reasoning: true })));
  assert.equal(catalog.ok, true); if (!catalog.ok) return;
  const groups = availableChoiceReviewGroups(catalog.choices), restored: Record<string, unknown> = {};
  for (const group of groups) for (const choice of group.choices) restored[choice.id] = { ...group.metadata, thinking: choice.thinking };
  assert.equal(groups.length, 98); assert.equal(Object.keys(restored).length, catalog.choices.length);
  assert.deepEqual(restored, Object.fromEntries(catalog.choices.map(choice => [choice.id, JSON.parse(availableChoiceDescription(choice))])));
  assert.doesNotMatch(JSON.stringify(groups), /127\.0\.0\.1|endpoint|baseUrl/);
  assert.ok(Buffer.byteLength(JSON.stringify(groups)) < Buffer.byteLength(JSON.stringify(catalog.choices.map(availableChoiceDescription))));
});

test("ambiguous, unsupported, empty and overflowing catalogs stop without silently dropping choices", () => {
  assert.deepEqual(buildAvailableCatalog([]), { ok: false, reason: "no_available_models" });
  assert.deepEqual(buildAvailableCatalog([model("a", "a"), model("a", "a", { baseUrl: "http://127.0.0.1:2" })]), { ok: false, reason: "ambiguous_catalog" });
  assert.deepEqual(buildAvailableCatalog([model("a", "image-only", { input: ["image"] })]), { ok: false, reason: "no_available_models" });
  assert.deepEqual(buildAvailableCatalog(Array.from({ length: 129 }, (_, i) => model("a", `model-${i}`))), { ok: false, reason: "catalog_overflow" });
  assert.deepEqual(buildAvailableCatalog([model("a", "bad", { contextWindow: NaN })]), { ok: false, reason: "invalid_catalog" });
  for (const baseUrl of ["https://user:PRIVATE_SECRET@example.invalid/v1", "https://example.invalid/v1?api_key=PRIVATE_SECRET", "file:///private/model"]) {
    assert.deepEqual(buildAvailableCatalog([model("a", "unsafe", { baseUrl })]), { ok: false, reason: "invalid_catalog" });
  }
});

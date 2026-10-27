import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { reduceAutomaticSelection, validRoutingContext, MAX_JEV_CHOICE_CRITERIA, type RoutingContext } from "../src/automatic-selection.ts";
import type { AvailableChoice } from "../src/available-models.ts";

const context: RoutingContext = { goal: "Repair the current parser without changing its interface.", constraints: ["Preserve Unicode source literals."],
  sources: [{ path: "src/parser.ts", content: 'export const value = "한글";' }], observations: ["The current test reports an empty-token mismatch."] };
const choices: AvailableChoice[] = ["off", "high"].map((thinking, i) => ({ id: `model_${i}`, model: { provider: "available-vendor", id: `actual-${i}` },
  thinking: thinking as "off" | "high", api: "openai-responses", endpoint: "http://127.0.0.1:1/v1", contextWindow: 32768 }));
const start = (options = choices) => reduceAutomaticSelection({ phase: "idle" }, { type: "start", context, choices: options, target: "Explicit local routing backend" });

test("model routing requires genuine context review and retains actual source/state/model metadata", () => {
  const before = structuredClone({ context, choices }), prepared = start();
  assert.equal(prepared.state.phase, "reviewing"); assert.equal(prepared.effects[0]?.type, "review_context");
  const reviewed = reduceAutomaticSelection(prepared.state, { type: "reviewed", approved: true });
  assert.equal(reviewed.state.phase, "selecting_model"); const effect = reviewed.effects[0]; assert.equal(effect?.type, "route_models");
  if (effect?.type !== "route_models") return;
  assert.deepEqual(effect.context, context); assert.ok(effect.context.sources[0]!.content.includes("한글"));
  assert.ok(effect.candidates[1]!.description.includes("supportedThinking")); assert.ok(effect.candidates[1]!.description.includes("actual-1"));
  assert.equal(JSON.stringify(effect).includes("127.0.0.1"), false); assert.deepEqual({ context, choices }, before);
  const selected = reduceAutomaticSelection(reviewed.state, { type: "model_chosen", id: "available_model_1", support: 0.5 });
  assert.equal(selected.state.phase, "selected"); if (selected.state.phase === "selected") assert.deepEqual(selected.state.choice, choices[1]);
});

test("large catalogs respect the public 255-option contract through dependent model then supported-thinking requests", () => {
  const contract = JSON.parse(readFileSync(new URL("./fixtures/typesafe-choice-contract.json", import.meta.url), "utf8"));
  assert.equal(MAX_JEV_CHOICE_CRITERIA, contract.criteriaMaxProperties); assert.equal(contract.questionType, "choice");
  const large = Array.from({ length: 98 }, (_, model) => ["off", "low", "medium", "high"].map((thinking, level) => ({ ...choices[0]!,
    id: `model_${model * 4 + level}`, model: { provider: "available-provider", id: `actual-${model}` }, thinking: thinking as "off" | "low" | "medium" | "high" }))).flat();
  const prepared = start(large), routing = reduceAutomaticSelection(prepared.state, { type: "reviewed", approved: true });
  const first = routing.effects[0]; assert.equal(first?.type, "route_models");
  if (first?.type !== "route_models") return;
  assert.equal(first.candidates.length, 98); assert.ok(first.candidates.length <= MAX_JEV_CHOICE_CRITERIA);
  const thinking = reduceAutomaticSelection(routing.state, { type: "model_chosen", id: "available_model_97", support: 0.5 });
  const second = thinking.effects[0]; assert.equal(second?.type, "route_thinking");
  if (second?.type !== "route_thinking") return;
  assert.equal(second.candidates.length, 4); assert.deepEqual(second.selectedModel, { provider: "available-provider", id: "actual-97" });
  assert.deepEqual(second.candidates.map(choice => choice.name), ["model_388", "model_389", "model_390", "model_391"]);
  assert.ok(second.candidates.every(choice => choice.description.includes("actual-97")));
  const selected = reduceAutomaticSelection(thinking.state, { type: "thinking_chosen", id: "model_391", support: 0.5 });
  assert.equal(selected.state.phase, "selected"); if (selected.state.phase === "selected") assert.deepEqual(selected.state.choice, large[391]);
  assert.deepEqual(reduceAutomaticSelection(thinking.state, { type: "thinking_chosen", id: "model_0", support: 1 }).state, { phase: "stopped", reason: "invalid" });
});

test("decline, cancellation or invalid model selection never fall back or dispatch thinking", () => {
  const prepared = start(), routing = reduceAutomaticSelection(prepared.state, { type: "reviewed", approved: true });
  for (const [id, support, reason] of [["invented", 1, "invalid"], ["available_model_1", NaN, "invalid"]] as const) {
    const stopped = reduceAutomaticSelection(routing.state, { type: "model_chosen", id, support });
    assert.equal(stopped.state.phase, "stopped");
    if (stopped.state.phase === "stopped") {
      assert.equal(stopped.state.reason, reason);
      assert.equal(stopped.state.advice, undefined);
    }
    assert.deepEqual(stopped.effects, []);
  }
  assert.deepEqual(reduceAutomaticSelection(prepared.state, { type: "reviewed", approved: false }).state, { phase: "stopped", reason: "declined" });
  const stopped = reduceAutomaticSelection(routing.state, { type: "cancel" });
  assert.deepEqual(reduceAutomaticSelection(stopped.state, { type: "model_chosen", id: "available_model_1", support: 1 }), { state: stopped.state, effects: [] });
  assert.deepEqual(reduceAutomaticSelection(prepared.state, { type: "model_chosen", id: "available_model_1", support: 1 }).state, { phase: "stopped", reason: "invalid" });
});

test("a single model bypasses its model request, not supported-thinking routing or worker approval", () => {
  const options = choices.map(choice => ({ ...choice, model: choices[0]!.model }));
  const prepared = start(options), thinking = reduceAutomaticSelection(prepared.state, { type: "reviewed", approved: true });
  assert.equal(thinking.state.phase, "selecting_thinking"); assert.equal(thinking.effects[0]?.type, "route_thinking");
  const weak = reduceAutomaticSelection(thinking.state, { type: "thinking_chosen", id: "model_1", support: 0.49 });
  assert.equal(weak.state.phase, "selected");
  if (weak.state.phase === "selected") {
    assert.equal(weak.state.requiresHumanReview, true);
    assert.deepEqual(weak.state.recommendations, [{ stage: "thinking", model: choices[0]!.model, thinking: "high", support: 0.49, executionAuthorized: false }]);
  }
  const selected = reduceAutomaticSelection({ phase: "idle" }, { type: "start", context, choices: [choices[0]!], target: "Explicit local backend" });
  assert.equal(selected.state.phase, "selected"); assert.deepEqual(selected.effects, []);
  if (selected.state.phase === "selected") assert.equal(selected.state.source, "only_choice");
});

test("weak model advice survives dependent thinking and both weak stages require explicit human worker review", () => {
  const options = [...choices, { ...choices[1]!, id: "model_2", thinking: "medium" as const }];
  const reviewing = start(options), first = reduceAutomaticSelection(reviewing.state, { type: "reviewed", approved: true });
  const second = reduceAutomaticSelection(first.state, { type: "model_chosen", id: "available_model_1", support: 0.31 });
  assert.equal(second.state.phase, "selecting_thinking");
  const selected = reduceAutomaticSelection(second.state, { type: "thinking_chosen", id: "model_1", support: 0.42 });
  assert.equal(selected.state.phase, "selected");
  if (selected.state.phase === "selected") {
    assert.equal(selected.state.requiresHumanReview, true); assert.deepEqual(selected.state.choice, choices[1]);
    assert.deepEqual(selected.state.recommendations.map(item => [item.stage, item.support, item.executionAuthorized]), [["model", 0.31, false], ["thinking", 0.42, false]]);
  }
  const singletonModel = reduceAutomaticSelection(start().state, { type: "reviewed", approved: true });
  const weak = reduceAutomaticSelection(singletonModel.state, { type: "model_chosen", id: "available_model_1", support: 0.31 });
  assert.equal(weak.state.phase, "selected"); if (weak.state.phase === "selected") assert.equal(weak.state.requiresHumanReview, true);
});

test("routing context is closed current-task data, not ambient history/auth or unbounded source", () => {
  assert.equal(validRoutingContext(context), true); assert.equal(validRoutingContext({ ...context, history: ["PRIVATE_PARENT_HISTORY"] }), false);
  for (const file of ["../auth.json", ".env", ".pi/auth.json", "/absolute/private"]) assert.equal(validRoutingContext({ ...context, sources: [{ path: file, content: "PRIVATE" }] }), false);
  assert.equal(validRoutingContext({ ...context, sources: [context.sources[0], context.sources[0]] }), false);
  assert.equal(validRoutingContext({ ...context, sources: [{ path: "empty.txt", content: "" }] }), true);
  assert.equal(validRoutingContext({ ...context, sources: Array.from({ length: 16 }, (_, i) => ({ path: `${i}.ts`, content: "x".repeat(32768) })) }), false);
});

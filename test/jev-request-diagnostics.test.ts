import assert from "node:assert/strict";
import { test } from "node:test";
import { jevChoiceFailure, jevRequestFailure, jevRequestFailureLabel } from "../src/jev-request-diagnostics.ts";
import { readChoice } from "../src/choice.ts";
import { basicRunProgress, basicRunSummary } from "../src/basic-execution.ts";
import type { OrdinaryPublicResult } from "../src/ordinary-effects.ts";

test("JEV failure display whitelists categories/status and never evaluates getters or private data", () => {
  assert.deepEqual(jevRequestFailure({ category: "http", httpStatus: 413, body: "PRIVATE_RESPONSE" }), { category: "http", httpStatus: 413 });
  assert.equal(jevRequestFailureLabel({ category: "http", httpStatus: 413 }), "JEV HTTP 413");
  for (const status of [-1, 600, NaN, "401"]) assert.equal(jevRequestFailure({ category: "http", httpStatus: status }), undefined);
  assert.equal(jevRequestFailure({ category: "PRIVATE_EXCEPTION" }), undefined);
  let reads = 0; const input = { get category() { reads++; throw Error("PRIVATE_EXCEPTION"); } };
  assert.equal(jevRequestFailure(input), undefined); assert.equal(reads, 0);
  assert.equal(jevRequestFailureLabel({ category: "transport", exception: "PRIVATE_EXCEPTION" }), "JEV transport failure");
});

test("choice validation failures retain only finite codes without private exceptions or getters", () => {
  const cases = [
    [{ type: "choice", choice: "outside", confidence: 0.8 }, "choice_fields"],
    [{ type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 1 } }, "distribution_fields"],
    [{ type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.8, b: 0.1 } }, "distribution_total"],
    [{ type: "choice", choice: "a", confidence: 0.2, probabilities: { a: 0.2, b: 0.8 } }, "choice_not_maximum"],
  ] as const;
  for (const [answer, choiceFailure] of cases) {
    let failure;
    try { readChoice(answer, ["a", "b"]); assert.fail("Invalid fixture must not select a worker."); }
    catch (error) { failure = jevChoiceFailure(error); }
    assert.deepEqual(failure, { category: "invalid_response", choiceFailure,
      ...(choiceFailure === "distribution_total" ? { probabilityTotal: 0.9, probabilityTolerance: 1e-6, candidateCount: 2 } : {}) });
    assert.deepEqual(jevRequestFailure({ ...failure, body: "PRIVATE_RESPONSE" }), failure);
    assert.match(jevRequestFailureLabel(failure)!, new RegExp(choiceFailure));
  }
  let reads = 0;
  assert.deepEqual(jevChoiceFailure({ get message() { reads++; throw Error("PRIVATE_EXCEPTION"); } }), { category: "invalid_response" });
  assert.equal(reads, 0);
  assert.deepEqual(jevChoiceFailure(Error("PRIVATE_EXCEPTION")), { category: "invalid_response" });
  assert.deepEqual(jevRequestFailure({ category: "invalid_response", choiceFailure: "PRIVATE_RESPONSE" }), { category: "invalid_response" });
  assert.deepEqual(jevRequestFailure({ category: "invalid_response", get choiceFailure() { reads++; return "choice_fields"; } }), { category: "invalid_response" });
  assert.equal(reads, 0);
});

test("distribution totals retain bounded numeric evidence without getters or relaxed validation", () => {
  const ids = Array.from({ length: 94 }, (_, i) => `candidate_${i}`);
  const probabilities = Object.fromEntries(ids.map(id => [id, 0.0106]));
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  let failure;
  try { readChoice({ type: "choice", choice: ids[0], confidence: 0.04, probabilities }, ids); assert.fail("Synthetic rounded distribution must remain rejected."); }
  catch (error) { failure = jevChoiceFailure(error); }
  const expected = { category: "invalid_response", choiceFailure: "distribution_total", probabilityTotal: total, probabilityTolerance: 1e-6, candidateCount: 94 };
  assert.deepEqual(failure, expected);
  assert.match(jevRequestFailureLabel(failure)!, new RegExp(`probability total ${total}`));
  assert.match(jevRequestFailureLabel(failure)!, /tolerance 0.000001 · candidates 94/);
  for (const data of [{ probabilityTotal: NaN }, { probabilityTotal: Infinity }, { probabilityTotal: 95 }, { candidateCount: 0 }, { candidateCount: 129 }, { probabilityTolerance: 0 }, { probabilityTolerance: "PRIVATE_RESPONSE" }]) {
    assert.deepEqual(jevRequestFailure({ ...expected, ...data }), { category: "invalid_response", choiceFailure: "distribution_total" });
  }
  let reads = 0;
  assert.deepEqual(jevRequestFailure({ ...expected, get probabilityTotal() { reads++; throw Error("PRIVATE_RESPONSE"); } }), { category: "invalid_response", choiceFailure: "distribution_total" });
  assert.equal(reads, 0);
  assert.deepEqual(jevRequestFailure({ ...expected, choiceFailure: "choice_fields" }), { category: "invalid_response", choiceFailure: "choice_fields" });
});

test("automatic routing failures show actual fetch/pending accounting instead of worker ownership", () => {
  const result: OrdinaryPublicResult = { kind: "ordinary_scope", status: "stopped", taskAcceptance: "needs_human_review", workersStarted: 0, modelCalls: 0,
    reservedModelCalls: 0, jevRequests: 1, reservedJevRequests: 1, jevReports: [], skillSuggestions: [], cleanupConfirmed: false, lockRetained: false,
    reason: "failed", reports: [], costEstimate: { observedUsd: 0, delegationTotalUsd: null }, diagnostic: { phase: "routing_models", routingFailure: { category: "http", httpStatus: 413 } } };
  const text = basicRunSummary(result);
  assert.match(text, /JEV fetch attempts 1 · pending 1/); assert.match(text, /reported usage receipts 0/); assert.match(text, /total cost unknown/);
  assert.match(text, /JEV model\/thinking selection/); assert.match(text, /HTTP 413/); assert.doesNotMatch(text, /during Execution ownership/);
  assert.match(basicRunProgress("routing_models")!, /Selecting an available model via JEV/);
  assert.match(basicRunProgress("routing_thinking")!, /supported thinking for the chosen model/);
  const advice = basicRunSummary({ ...result, reason: "undecided", automaticAdvice: { stage: "model", model: { provider: "fixture", id: "suggested" }, support: 0.49, executionAuthorized: false } });
  assert.match(advice, /recommendation only \/ not executed/); assert.match(advice, /"support":0.49/); assert.doesNotMatch(advice, /Selected model\/thinking/);
});

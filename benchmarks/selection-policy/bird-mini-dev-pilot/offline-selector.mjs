// Uses an explicit dummy credential and mock fetch; never sends a real selector request.
import assert from "node:assert/strict";
import path from "node:path";
import { selectProfile } from "./run-policy.mjs";
assert.equal(process.env.TYPESAFE_API_KEY, "synthetic-offline-token"); assert.equal(process.env.JEV_BACKEND, "typesafe");
const runtimeRoot = path.resolve(process.argv[2]); let mockedFetches = 0;
globalThis.fetch = async (url, options) => {
  mockedFetches++;
  assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(options.headers.Authorization, "Bearer synthetic-offline-token"); assert.equal(options.redirect, "error");
  const body = JSON.parse(options.body); assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(Object.keys(body.questions.agent.criteria).sort(), ["worker", "worker_strong"]);
  for (const value of Object.values(body.questions.agent.criteria)) assert.ok(value.length <= 256);
  assert.ok(!body.state.includes("gold SQL:") && !body.state.includes("difficulty: challenging"));
  return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 1 },
    answers: { agent: { type: "choice", choice: "worker", confidence: 0.8 } } }), { headers: { "Content-Type": "application/json" } });
};
for (const [arm, profile] of [["fixed_luna", "worker"], ["fixed_astra", "worker_strong"]]) {
  const row = await selectProfile({ runtimeRoot, arm, question: "Synthetic SQL question", evidence: "Synthetic literal data" });
  assert.equal(row.profile, profile); assert.equal(row.requests, 0);
}
assert.equal(mockedFetches, 0);
const selected = await selectProfile({ runtimeRoot, arm: "jev_select", question: "Synthetic SQL question", evidence: "Synthetic literal data" });
assert.equal(selected.profile, "worker"); assert.equal(selected.requests, 1); assert.equal(mockedFetches, 1); assert.ok(selected.observedUsdEstimate > 0);
console.log(JSON.stringify({ fixedArmsMakeNoSelectorCalls: true, nativeRouteRequestAndChoiceValidation: true, candidateDescriptionsBounded: true,
  mockFetches: mockedFetches, realSelectorRequests: 0, realWorkerRequests: 0, mockAccountingIsBenchmarkEvidence: false }));

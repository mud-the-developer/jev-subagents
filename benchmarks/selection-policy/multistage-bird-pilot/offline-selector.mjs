// Explicit dummy credential/mock fetch only; assert stage-specific eligible role catalogs.
import assert from "node:assert/strict";
import { choose, reviewData } from "./run-workflow.mjs";
assert.equal(reviewData('{"needsFix":true,"issues":[]}'), null);
assert.equal(process.env.TYPESAFE_API_KEY, "synthetic-offline-token"); assert.equal(process.env.JEV_BACKEND, "typesafe");
const runtimeRoot = process.argv[2]; let stage = "investigate", calls = 0;
globalThis.fetch = async (_url, options) => {
  calls++; assert.equal(options.headers.Authorization, "Bearer synthetic-offline-token"); let request;
  try { request = JSON.parse(options.body); } catch { assert.fail("Mock selector received malformed request JSON."); }
  const names = Object.keys(request.questions.agent.criteria).sort();
  const read = ["investigate", "review"].includes(stage);
  assert.deepEqual(names, read ? ["scout", "worker", "worker_strong"] : ["worker", "worker_strong"]);
  for (const value of Object.values(request.questions.agent.criteria)) assert.ok(value.length <= 256);
  return new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 10, output_tokens: 1 },
    answers: { agent: { type: "choice", choice: read ? "scout" : "worker_strong", confidence: 0.8 } } }), { headers: { "Content-Type": "application/json" } });
};
for (const arm of ["fixed_cheap", "fixed_strong"]) for (stage of ["investigate", "implement", "review", "correct"]) {
  const row = await choose({ runtimeRoot, arm, phase: stage, question: "Synthetic question", evidence: "Literal data" });
  assert.equal(row.requests, 0); if (["investigate", "review"].includes(stage)) assert.equal(row.profile, "scout");
  else assert.equal(row.profile, arm === "fixed_cheap" ? "worker" : "worker_strong");
}
assert.equal(calls, 0);
for (stage of ["investigate", "implement", "review", "correct"]) {
  const row = await choose({ runtimeRoot, arm: "routed", phase: stage, question: "Synthetic question", evidence: "Literal data" });
  assert.equal(row.requests, 1); assert.equal(row.profile, ["investigate", "review"].includes(stage) ? "scout" : "worker_strong");
}
assert.equal(calls, 4);
console.log(JSON.stringify({ stageRoleCatalogsCorrect: true, readOnlyStagesOfferThreeRoles: true, mutationNeverOffersScout: true,
  fixedArmsMakeNoSelectorRequest: true, mockedRequests: 4, realSelectorOrWorkerCalls: 0, mockAccountingIsLiveEvidence: false }));

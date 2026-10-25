// Zero-provider public metadata/hash consistency check. Historical SQL is not redistributed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url));
let p, r, manifest;
try {
  p = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8"));
  r = JSON.parse(await fs.readFile(path.join(here, "results.json"), "utf8"));
  manifest = JSON.parse(await fs.readFile(path.join(here, "MANIFEST.json"), "utf8"));
} catch { assert.fail("Policy metadata missing or malformed."); }
for (const [name, expected] of Object.entries(manifest.files)) {
  assert.equal(path.basename(name), name); assert.equal(createHash("sha256").update(await fs.readFile(path.join(here, name))).digest("hex"), expected);
}
assert.equal(r.completed, 18); assert.equal(r.rows.length, 18); assert.equal(r.selectorRequests, 6);
assert.deepEqual(r.rows.map(x => x.id), p.order.map(x => x.id));
for (const [index, row] of r.rows.entries()) {
  const scheduled = p.order[index], item = p.sample.find(x => x.questionId === scheduled.questionId), database = p.dataset.databases.find(x => x.db_id === item.dbId);
  assert.equal(row.arm, scheduled.arm); assert.equal(row.questionId, item.questionId); assert.equal(row.difficulty, item.difficulty);
  assert.equal(row.status, "completed"); assert.equal(row.validation.questionId, row.questionId); assert.equal(row.validation.databaseSha256, database.sha256);
  assert.equal(row.validation.goldSetSha256, item.goldSetSha256); assert.ok(row.validation.databaseUnchanged && row.validation.readOnlyAuthorizer);
  assert.ok(row.cleanupConfirmed && row.accountingComplete && row.worker.cleanupConfirmed && row.worker.childExitConfirmed && row.worker.disposed && row.worker.files.ioFinished);
  assert.equal(row.worker.accounting.status, "reported_complete"); assert.equal(row.worker.injectedOfflineSdk, false); assert.equal(row.worker.sdkCallCap, null);
  assert.ok(Math.abs(row.totalWallMs - row.selectionMs - row.preparationMs - row.workerAndCleanupMs - row.verificationMs) < 1);
  assert.equal(row.humanApprovalOrReviewWaitMs, 0); assert.equal(row.protectedInputsUnchanged, true);
  assert.equal(row.selection.requests, row.arm === "jev_select" ? 1 : 0);
  assert.ok(Object.hasOwn(p.profiles, row.selectedProfile));
}
for (const arm of ["fixed_luna", "fixed_astra", "jev_select"]) {
  const a = r.rows.filter(x => x.arm === arm), stored = r.arms[arm];
  assert.equal(a.length, 6); assert.equal(stored.correct, a.filter(x => x.validation.executionMatch).length);
  assert.ok(Math.abs(stored.totalWallMs - a.reduce((n,x) => n + x.totalWallMs, 0)) < 1e-8);
  assert.ok(Math.abs(stored.observedUsdEstimate - a.reduce((n,x) => n + x.combinedObservedUsdEstimate, 0)) < 1e-8);
}
console.log(JSON.stringify({ frozenSourceHashesVerified: Object.keys(manifest.files).length, completed: 18, planned: 18,
  selectorRequestsRecorded: 6, allContinuousClockPhaseSumsConsistent: true, datasetVersionDigestsConsistent: true,
  historicalSqlExecutionReplayed: false, rawQueryDatasetRedistributed: false, providerCalls: 0, executionAuthority: false }, null, 2));

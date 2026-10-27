// Zero-provider replay of public provenance, counts, permissions and aggregates; no raw SQL execution.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url)), pilot = fileURLToPath(new URL("../multistage-bird-pilot/", import.meta.url));
let p, r, m, old;
try {
  p = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8")); r = JSON.parse(await fs.readFile(path.join(here, "results.json"), "utf8"));
  m = JSON.parse(await fs.readFile(path.join(here, "MANIFEST.json"), "utf8"));
  const text = await fs.readFile(path.join(pilot, "results.json"), "utf8"); assert.equal(createHash("sha256").update(text).digest("hex"), p.extension.previousResultsSha256); old = JSON.parse(text);
} catch { assert.fail("Extension provenance missing or malformed."); }
for (const [name, expected] of Object.entries(m.files)) { assert.equal(path.basename(name), name); assert.equal(createHash("sha256").update(await fs.readFile(path.join(here, name))).digest("hex"), expected); }
assert.equal(r.completed, 30); assert.equal(r.distinctQuestions, 10); assert.equal(r.rows.length, 30); assert.equal(new Set(r.rows.map(row => row.questionId)).size, 10);
assert.equal(r.phaseWorkers, 91); assert.equal(r.selectorRequests, 31); assert.equal(r.sdkCalls, 223);
const oldRows = r.rows.filter(row => row.cohort === "pilot3").map(({ cohort, pooledIndex, ...row }) => row); assert.deepEqual(oldRows, old.rows);
const newRows = r.rows.filter(row => row.cohort === "extension7"); assert.equal(newRows.length, 21); assert.deepEqual(newRows.map(row => row.id), p.order.map(row => row.id));
for (const row of r.rows) {
  assert.equal(row.status, "completed"); assert.ok(row.allCleanupAndAccountingKnown && !row.hiddenGradeFeedbackShared && row.reviewFormatValid);
  const corrected = row.reviewNeedsFix === true;
  assert.equal(row.correctionStageUsed, corrected); assert.deepEqual(row.phases.map(phase => phase.phase), corrected ? ["investigate", "implement", "review", "correct"] : ["investigate", "implement", "review"]);
  for (const phase of row.phases) {
    const read = ["investigate", "review"].includes(phase.phase), role = phase.selection.profile, result = phase.result;
    assert.ok(read ? ["scout", "worker", "worker_strong"].includes(role) : ["worker", "worker_strong"].includes(role));
    assert.equal(phase.selection.requests, row.arm === "routed" ? 1 : 0); assert.equal(result.stageMode, read ? "read" : "mutation");
    assert.deepEqual(result.effectiveToolNames.sort(), read ? ["scope_read"] : ["scope_edit", "scope_read", "scope_write"]);
    if (read) assert.equal(result.files.changed, false);
    assert.equal(result.sdkCallCap, null); assert.ok(result.elapsedMs < 300000 && result.accounting.complete && result.cleanupConfirmed && result.childExitConfirmed && result.disposed && result.files.ioFinished && phase.protectedInputsUnchanged);
    assert.equal(phase.configuredProviderModel, p.profiles[role].model); assert.equal(phase.profileSystemSha256, p.profiles[role].systemSha256); assert.equal(Object.hasOwn(phase, "output"), false);
  }
  assert.ok(row.finalValidation.databaseUnchanged && row.finalValidation.readOnlyAuthorizer); assert.equal(row.humanReviewWaitMs, 0);
  assert.ok(row.totalWallMs >= row.phases.reduce((sum, phase) => sum + phase.phaseWallMs, 0) + row.initialVerificationMs + row.finalVerificationMs);
}
for (const cohort of ["pilot3", "extension7", "pooled10"]) for (const arm of ["fixed_cheap", "fixed_strong", "routed"]) {
  const rows = r.rows.filter(row => row.arm === arm && (cohort === "pooled10" || row.cohort === cohort)), a = r.cohorts[cohort][arm];
  assert.equal(rows.length, cohort === "pilot3" ? 3 : cohort === "extension7" ? 7 : 10); assert.equal(a.completed, rows.length); assert.equal(a.finalCorrect, rows.filter(row => row.finalValidation.executionMatch).length);
  assert.ok(Math.abs(a.totalWallMs - rows.reduce((sum,row) => sum + row.totalWallMs, 0)) < 1e-7);
  assert.ok(Math.abs(a.observedUsdEstimate - rows.reduce((sum,row) => sum + row.observedUsdEstimate, 0)) < 1e-9);
}
console.log(JSON.stringify({ distinctQuestions: 10, workflows: 30, workerStages: 91, selectorRequests: 31, originalPilotUnchangedAndNotRerun: true,
  frozenExtensionSourceHashesVerified: 4, eligibilityScopesCleanupAndAggregatesConsistent: true, correctionStages: 1,
  rawHistoricalSqlReplayRequiresPrivateArtifacts: true, providerCalls: 0, executionAuthority: false }, null, 2));

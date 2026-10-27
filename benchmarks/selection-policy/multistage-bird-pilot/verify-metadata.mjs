// Public metadata/source consistency only; raw licensed reports/queries stay local.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url));
let p, r, m;
try {
  p = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8"));
  r = JSON.parse(await fs.readFile(path.join(here, "results.json"), "utf8"));
  m = JSON.parse(await fs.readFile(path.join(here, "MANIFEST.json"), "utf8"));
} catch { assert.fail("Multistage metadata missing or malformed."); }
for (const [name, expected] of Object.entries(m.files)) { assert.equal(path.basename(name), name); assert.equal(createHash("sha256").update(await fs.readFile(path.join(here, name))).digest("hex"), expected); }
assert.equal(r.completed, 9); assert.equal(r.rows.length, 9); assert.equal(r.phaseWorkers, 27); assert.equal(r.selectorRequests, 9);
assert.deepEqual(r.rows.map(row => row.id), p.order.map(row => row.id));
for (const [index, row] of r.rows.entries()) {
  assert.equal(row.questionId, p.order[index].questionId); assert.equal(row.arm, p.order[index].arm); assert.equal(row.status, "completed");
  assert.ok(row.allCleanupAndAccountingKnown && !row.hiddenGradeFeedbackShared); assert.equal(row.phases.length, 3);
  assert.deepEqual(row.phases.map(phase => phase.phase), ["investigate", "implement", "review"]);
  for (const phase of row.phases) {
    const role = phase.selection.profile, read = ["investigate", "review"].includes(phase.phase), result = phase.result;
    assert.ok(read ? ["scout", "worker", "worker_strong"].includes(role) : ["worker", "worker_strong"].includes(role));
    assert.equal(phase.selection.requests, row.arm === "routed" ? 1 : 0);
    assert.equal(phase.profileSystemSha256, p.profiles[role].systemSha256); assert.equal(phase.configuredProviderModel, p.profiles[role].model); assert.equal(phase.thinking, p.profiles[role].thinking);
    assert.equal(result.sdkCallCap, null); assert.ok(result.elapsedMs < 300000 && result.cleanupConfirmed && result.childExitConfirmed && result.disposed && result.files.ioFinished && result.accounting.complete);
    assert.equal(phase.protectedInputsUnchanged, true); assert.equal(Object.hasOwn(phase, "output"), false);
    assert.deepEqual(result.effectiveToolNames.sort(), read ? ["scope_read"] : ["scope_edit", "scope_read", "scope_write"]);
    if (read) assert.equal(result.files.changed, false);
  }
  const item = p.cases.find(item => item.questionId === row.questionId); assert.ok(!p.excludedPreviousQuestionIds.includes(row.questionId));
  assert.equal(row.finalValidation.goldSetSha256, item.goldSetSha256); assert.ok(row.finalValidation.databaseUnchanged);
  assert.equal(row.reviewFormatValid, true); assert.equal(row.reviewNeedsFix, false); assert.equal(row.correctionStageUsed, false);
  assert.equal(row.reviewCorrectness, row.initialValidation.executionMatch);
  assert.ok(row.totalWallMs >= row.phases.reduce((n,phase) => n + phase.phaseWallMs, 0) + row.initialVerificationMs + row.finalVerificationMs);
}
for (const arm of ["fixed_cheap", "fixed_strong", "routed"]) {
  const rows = r.rows.filter(row => row.arm === arm), stored = r.arms[arm]; assert.equal(rows.length, 3);
  assert.equal(stored.finalCorrect, rows.filter(row => row.finalValidation.executionMatch).length);
  assert.ok(Math.abs(stored.totalWallMs - rows.reduce((n,row) => n + row.totalWallMs, 0)) < 1e-7);
  assert.ok(Math.abs(stored.observedUsdEstimate - rows.reduce((n,row) => n + row.observedUsdEstimate, 0)) < 1e-10);
}
console.log(JSON.stringify({ workflowsVerified: 9, phaseWorkersVerified: 27, actualSelectorRequestsRecorded: 9, stageBoundaryChoices: true,
  readOnlyScopesAndToolsVerified: true, scoutNeverMutates: true, liveCorrectionBranchActivated: false,
  historicalSqlNotReplayedWithoutPrivateArtifacts: true, providerCalls: 0, executionAuthority: false }, null, 2));

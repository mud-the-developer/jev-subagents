// Offline re-evaluation of recorded, reviewed outputs. Never invokes a model/provider.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
assert.equal(process.versions.bun, "1.4.3", "Use the existing pinned Bun; no runtime is installed.");
const here = fileURLToPath(new URL("./", import.meta.url));
const config = fileURLToPath(new URL("../../../src/worker-bunfig.toml", import.meta.url));
let protocol, report;
try {
  protocol = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8"));
  report = JSON.parse(await fs.readFile(path.join(here, "live-results.json"), "utf8"));
} catch { assert.fail("Recorded metadata missing or malformed."); }
assert.equal(report.status, "completed_parent_checked"); assert.equal(report.sdkCallCap, null);
assert.equal(report.completed, 12); assert.equal(report.planned, 12); assert.equal(report.rows.length, 12);
assert.deepEqual(report.rows.map(row => row.id), protocol.ordering.order.map(row => row.id));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-recorded-suite-"));
let exitsConfirmed = true;
const envFor = work => {
  const env = { HOME: work, USERPROFILE: work, PI_CODING_AGENT_DIR: path.join(work, "isolated-agent"), DO_NOT_TRACK: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  return env;
};
function run(script, work) {
  const child = spawnSync(process.execPath, ["--no-env-file", "--no-install", `--config=${config}`, script], { cwd: work, env: envFor(work), encoding: "utf8", timeout: 30000 });
  if (child.error || child.signal || child.status === null) exitsConfirmed = false;
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0);
  try { return JSON.parse(child.stdout.trim()); } catch { assert.fail("Recorded checks did not produce a complete JSON outcome."); }
}
try {
  const controls = run(path.join(here, "verify-controls.mjs"), root);
  assert.equal(controls.providerCalls, 0); assert.equal(controls.controls.length, 3);
  const observations = [];
  for (const [index, row] of report.rows.entries()) {
    const scheduled = protocol.ordering.order[index], task = protocol.tasks.find(value => value.id === scheduled.task), condition = protocol.conditions[scheduled.condition];
    assert.equal(row.condition, scheduled.condition); assert.equal(row.repeat, scheduled.repeat); assert.equal(row.task, scheduled.task);
    assert.equal(row.profile, condition.profile); assert.equal(row.model, condition.configuredProviderModel); assert.equal(row.thinking, condition.thinking);
    assert.equal(row.sdkCallCap, null); assert.equal(row.seconds, 300); assert.ok(row.elapsedMs < 300000);
    assert.ok(row.cleanupConfirmed && !row.lockRetained && row.protectedInputsUnchanged && row.onlyDeclaredFilesWithinFixture && row.parentReviewedBeforeTests);
    assert.equal(row.workerTestClaim, "not_run"); assert.equal(row.jevRequests, 0);
    const work = path.join(root, row.id); await fs.mkdir(work);
    assert.deepEqual(Object.keys(row.outputSha256).sort(), [...task.mutableFiles].sort());
    for (const name of task.mutableFiles) {
      const file = path.join(here, "outputs", row.id, name), stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      const bytes = await fs.readFile(file); assert.equal(createHash("sha256").update(bytes).digest("hex"), row.outputSha256[name]);
      await fs.writeFile(path.join(work, name), bytes, { flag: "wx" });
    }
    await fs.writeFile(path.join(work, "checks.mjs"), await fs.readFile(path.join(here, "tasks", task.id, "checks.mjs")), { flag: "wx" });
    const checked = run(path.join(work, "checks.mjs"), work);
    assert.deepEqual(checked, row.checks, "Recorded checks changed or cannot be reproduced.");
    observations.push({ id: row.id, passed: checked.passed, total: checked.total });
  }
  const systemHashes = new Set(report.rows.map(row => row.profileSystemSha256)); assert.equal(systemHashes.size, 1);
  for (const condition of ["A", "B"]) {
    const rows = report.rows.filter(row => row.condition === condition), ms = rows.map(row => row.elapsedMs).sort((a, b) => a - b), stored = report.conditions[condition];
    assert.equal(rows.length, 6); assert.equal(rows.filter(row => row.checks.failed === 0).length, stored.allGroupsPass);
    assert.equal(rows.reduce((n, row) => n + row.sdkCalls, 0), stored.sdkCalls);
    assert.equal(rows.reduce((n, row) => n + row.checks.passed, 0), stored.groupsPassed);
    assert.equal((ms[2] + ms[3]) / 2, stored.medianElapsedMs);
    assert.ok(Math.abs(rows.reduce((n, row) => n + row.observedUsdEstimate, 0) - stored.observedUsdEstimate) < 1e-10);
  }
  console.log(JSON.stringify({ kind: "offline_recorded_suite_reproduction", frozenControlInputsVerified: controls.frozenInputsVerified,
    completed: observations.length, planned: 12, observations, providerCalls: 0, historicalLatencyOrBillingReexecuted: false, storedMetadataGrantsAuthority: false }, null, 2));
} finally {
  if (exitsConfirmed) await fs.rm(root, { recursive: true, force: true });
  else console.error("Recorded check child exit unconfirmed; owned temporary evidence retained.");
}

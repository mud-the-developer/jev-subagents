// Offline code/data reproduction only; no runtime/auth root and no provider call.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
assert.equal(process.versions.bun, "1.4.3");
const here = fileURLToPath(new URL("./", import.meta.url)), v2 = fileURLToPath(new URL("../suite-v2/", import.meta.url));
const config = fileURLToPath(new URL("../../../src/worker-bunfig.toml", import.meta.url));
let report, protocol, manifest, jev;
try {
  report = JSON.parse(await fs.readFile(path.join(here, "results.json"), "utf8"));
  protocol = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8"));
  manifest = JSON.parse(await fs.readFile(path.join(here, "MANIFEST.json"), "utf8"));
  jev = JSON.parse(await fs.readFile(path.join(v2, "live-results.json"), "utf8"));
} catch { assert.fail("Recorded control metadata missing or malformed."); }
for (const [name, sha] of Object.entries(manifest.files)) {
  assert.equal(path.basename(name), name);
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(here, name))).digest("hex"), sha);
}
assert.equal(report.completed, 12); assert.equal(report.rows.length, 12);
assert.equal(report.jevOrchestrationInvoked, false); assert.equal(report.allJevDerivedCodeAbsent, false);
assert.deepEqual(report.rows.map(row => row.id), protocol.order.map(row => row.id));
assert.deepEqual(report.referenceJevOnConditions, jev.conditions);
let original;
try { original = JSON.parse(await fs.readFile(path.join(v2, "protocol.json"), "utf8")); }
catch { assert.fail("Frozen reference protocol missing or malformed."); }
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jev-direct-reproduce-"));
let exitsConfirmed = true;
function check(script, work) {
  const env = { HOME: work, USERPROFILE: work, PI_CODING_AGENT_DIR: path.join(work, "isolated-agent"), DO_NOT_TRACK: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
  for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  const r = spawnSync(process.execPath, ["--no-env-file", "--no-install", `--config=${config}`, script], { cwd: work, env, encoding: "utf8", timeout: 30000 });
  if (r.error || r.signal || r.status === null) exitsConfirmed = false;
  assert.equal(r.error, undefined); assert.equal(r.signal, null); assert.equal(r.status, 0);
  try { return JSON.parse(r.stdout.trim()); } catch { assert.fail("Offline result did not produce complete JSON."); }
}
try {
  const prior = check(path.join(v2, "verify-recorded.mjs"), temp); assert.equal(prior.completed, 12); assert.equal(prior.providerCalls, 0);
  const observations = [];
  for (const [index, row] of report.rows.entries()) {
    const scheduled = original.ordering.order[index], task = original.tasks.find(value => value.id === scheduled.task);
    assert.equal(row.id, scheduled.id); assert.equal(row.condition, scheduled.condition); assert.equal(row.repeat, scheduled.repeat);
    assert.equal(row.sdkCallCap, null); assert.equal(row.seconds, 300); assert.ok(row.elapsedMs < 300000);
    assert.ok(row.sdkDirect && !row.injectedOfflineSdk && row.sdkCalls > 0 && row.accounting.complete && row.accounting.status === "reported_complete");
    assert.ok(row.cleanupConfirmed && row.childExitConfirmed && row.disposed && row.files.ioFinished && row.protectedInputsUnchanged && row.onlyDeclaredFilesWithinFixture);
    assert.equal(row.jevExtensionLoaded, false); assert.equal(row.jevExecutionCalls, 0); assert.equal(row.workerTestClaim, "not_run");
    const oldRow = jev.rows.find(value => value.id === row.id); assert.equal(oldRow.profileSystemSha256, row.profileSystemSha256);
    const work = path.join(temp, row.id); await fs.mkdir(work);
    assert.deepEqual(Object.keys(row.outputSha256).sort(), [...task.mutableFiles].sort());
    for (const name of task.mutableFiles) {
      const file = path.join(here, "outputs", row.id, name), stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
      const bytes = await fs.readFile(file); assert.equal(createHash("sha256").update(bytes).digest("hex"), row.outputSha256[name]);
      await fs.writeFile(path.join(work, name), bytes, { flag: "wx" });
    }
    await fs.writeFile(path.join(work, "checks.mjs"), await fs.readFile(path.join(v2, "tasks", task.id, "checks.mjs")), { flag: "wx" });
    const checked = check(path.join(work, "checks.mjs"), work); assert.deepEqual(checked, row.checks);
    observations.push({ id: row.id, passed: checked.passed, total: checked.total });
  }
  for (const condition of ["A", "B"]) {
    const rows = report.rows.filter(row => row.condition === condition), stored = report.conditions[condition], times = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
    assert.equal(rows.length, 6); assert.equal(stored.allGroupsPass, rows.filter(row => row.checks.failed === 0).length);
    assert.equal(stored.sdkCalls, rows.reduce((n, row) => n + row.sdkCalls, 0)); assert.equal(stored.workerMedianMs, (times[2] + times[3]) / 2);
    assert.ok(Math.abs(stored.observedUsdEstimate - rows.reduce((n, row) => n + row.accounting.observedUsdEstimate, 0)) < 1e-10);
  }
  console.log(JSON.stringify({ kind: "direct_sdk_control_offline_reproduction", jevOnTrialsRechecked: 12, directTrialsRechecked: observations.length,
    observations, providerCalls: 0, historicalModelIdentityTimingBillingReexecuted: false, fullJevCodeAbsenceClaimed: false, storedMetadataGrantsAuthority: false }, null, 2));
} finally {
  if (exitsConfirmed) await fs.rm(temp, { recursive: true, force: true });
  else console.error("Offline child exit unconfirmed; owned evidence retained.");
}

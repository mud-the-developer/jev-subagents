// Offline task/checker qualification only. This script cannot launch live-model jobs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
assert.equal(process.versions.bun, "1.4.3", "Use the existing pinned Bun; do not install a runtime.");
const here = fileURLToPath(new URL("./", import.meta.url));
const config = fileURLToPath(new URL("../../../src/worker-bunfig.toml", import.meta.url));
let manifest, protocol;
try {
  manifest = JSON.parse(await fs.readFile(path.join(here, "MANIFEST.json"), "utf8"));
  protocol = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8"));
} catch { assert.fail("Frozen suite metadata is missing or malformed; no controls were executed."); }
assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.liveExecutionAuthority, false);
for (const [relative, expected] of Object.entries(manifest.files)) {
  assert.ok(!relative.includes("..") && !path.isAbsolute(relative) && (relative.startsWith("tasks/") || ["TASK.md", "protocol.json", "verify-controls.mjs"].includes(relative)));
  const file = path.join(here, relative), stat = await fs.lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), expected, "Frozen suite input changed: " + relative);
}
assert.equal(protocol.ordering.order.length, 12); assert.equal(new Set(protocol.ordering.order.map(row => row.id)).size, 12);
for (const task of protocol.tasks) for (const repeat of [1, 2]) {
  assert.deepEqual(protocol.ordering.order.filter(row => row.task === task.id && row.repeat === repeat).map(row => row.condition).sort(), ["A", "B"]);
}
const tasks = [
  { id: "async-cache", files: ["cache.mjs", "client.mjs"], target: "invalidate_cached_key", mutation: {
    file: "cache.mjs", from: "invalidate(key) { validateKey(key); entries.delete(key); }", to: "invalidate(key) { validateKey(key); }", name: "invalidation_disabled" } },
  { id: "record-gateway", files: ["policy.mjs", "gateway.mjs"], target: "unarchived_admin_delete_no_mutation", mutation: {
    file: "policy.mjs", from: 'if (action === "delete") return user.role === "admin" && record.archived;', to: 'if (action === "delete") return user.role === "admin";', name: "unarchived_admin_delete" } },
  { id: "dependency-plan", files: ["planner.mjs", "summary.mjs"], target: "cycle_rejects_range_error", mutation: {
    file: "planner.mjs", from: 'if (!layer.length) throw new RangeError("Dependency cycle");', to: 'if (!layer.length) return { order, layers };', name: "partial_cycle_plan" } },
];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "jev-suite-controls-"));
let exitsConfirmed = true;
const results = [];
try {
  for (const task of tasks) {
    const outcomes = {};
    for (const mode of ["initial", "reference", "mutant"]) {
      const work = path.join(root, `${task.id}-${mode}`); await fs.mkdir(work);
      for (const name of task.files) {
        let source = await fs.readFile(path.join(here, "tasks", task.id, mode === "mutant" ? "reference" : mode, name), "utf8");
        if (mode === "mutant" && name === task.mutation.file) {
          assert.equal(source.split(task.mutation.from).length, 2, "A mutation must have one exact reference target.");
          source = source.replace(task.mutation.from, task.mutation.to);
        }
        await fs.writeFile(path.join(work, name), source, { flag: "wx" });
      }
      await fs.writeFile(path.join(work, "checks.mjs"), await fs.readFile(path.join(here, "tasks", task.id, "checks.mjs")), { flag: "wx" });
      const env = { HOME: work, USERPROFILE: work, PI_CODING_AGENT_DIR: path.join(work, "isolated-agent"), DO_NOT_TRACK: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
      for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
      const child = spawnSync(process.execPath, ["--no-env-file", "--no-install", `--config=${config}`, path.join(work, "checks.mjs")], { cwd: work, env, encoding: "utf8", timeout: 30_000 });
      if (child.error || child.signal || child.status === null) exitsConfirmed = false;
      assert.equal(child.error, undefined); assert.equal(child.signal, null);
      let outcome;
      try { outcome = JSON.parse(child.stdout.trim()); }
      catch { assert.fail(`No valid control-test result for ${task.id}/${mode}.`); }
      assert.equal(outcome.task, task.id); assert.ok(outcome.total > 0); assert.equal(outcome.results.length, outcome.total);
      assert.equal(outcome.passed + outcome.failed, outcome.total);
      assert.equal(new Set(outcome.results.map(row => row.name)).size, outcome.total);
      if (mode === "reference") { assert.equal(child.status, 0); assert.equal(outcome.failed, 0); }
      else { assert.equal(child.status, 1); assert.ok(outcome.failed > 0); }
      if (mode === "mutant") assert.equal(outcome.results.find(row => row.name === task.target)?.passed, false, "The targeted mutation must be detected.");
      outcomes[mode] = { passed: outcome.passed, failed: outcome.failed, total: outcome.total,
        failedCases: outcome.results.filter(row => !row.passed).map(row => row.name), ...(mode === "mutant" ? { mutation: task.mutation.name } : {}) };
    }
    assert.equal(outcomes.initial.total, outcomes.reference.total); assert.equal(outcomes.mutant.total, outcomes.reference.total);
    results.push({ task: task.id, ...outcomes });
  }
  console.log(JSON.stringify({ kind: "prepared_quality_suite_control_checks", liveJobsExecuted: 0, providerCalls: 0,
    productionCodeChanged: false, frozenInputsVerified: Object.keys(manifest.files).length, controls: results, executionAuthority: false }, null, 2));
} finally {
  if (exitsConfirmed) await fs.rm(root, { recursive: true, force: true });
  else console.error("Control child exit unconfirmed; owned temporary evidence retained.");
}

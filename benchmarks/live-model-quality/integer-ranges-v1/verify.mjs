// Offline verification of reviewed, checked-in synthetic code; never invokes a provider.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.equal(process.versions.bun, "1.4.3", "Use the existing pinned Bun; no runtime is installed by this verifier.");
const here = fileURLToPath(new URL("./", import.meta.url));
const config = fileURLToPath(new URL("../../../src/worker-bunfig.toml", import.meta.url));
let recorded;
try { recorded = JSON.parse(await fs.readFile(path.join(here, "results.json"), "utf8")); }
catch { assert.fail("Benchmark metadata is missing or malformed; no verification was performed."); }
const sources = ["buggy.mjs", "luna-low.mjs", "astra-max.mjs"];
assert.deepEqual(Object.keys(recorded.fileSha256).sort(), [...sources, "SPEC.md", "held-out.test.mjs"].sort());
for (const [name, expected] of Object.entries(recorded.fileSha256)) {
  const file = path.join(here, name), stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(createHash("sha256").update(await fs.readFile(file)).digest("hex"), expected, name);
}
assert.equal(recorded.liveRuns.length, 2);
for (const row of recorded.liveRuns) {
  assert.ok(sources.includes(row.source)); assert.ok(row.sdkCalls <= recorded.inputs.maxSdkCallsPerJob);
  assert.ok(row.elapsedMsReported <= recorded.inputs.secondsPerJob * 1000);
}

function oracleCheck(merge) {
  let seed = 0x51a7c0de, passed = 0;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let k = 0; k < 1000; k++) {
    const input = Array.from({ length: rand() % 14 }, () => {
      const a = rand() % 41 - 20, b = rand() % 41 - 20;
      return Object.freeze([Math.min(a, b), Math.max(a, b)]);
    });
    const points = new Set();
    for (const [a, b] of input) for (let x = a; x <= b; x++) points.add(x);
    const expected = [];
    for (const x of [...points].sort((a, b) => a - b)) {
      const last = expected.at(-1);
      if (last && x === last[1] + 1) last[1] = x;
      else expected.push([x, x]);
    }
    const before = JSON.stringify(input);
    try {
      const actual = merge(Object.freeze(input));
      assert.deepEqual(actual, expected); assert.equal(JSON.stringify(input), before);
      for (const pair of actual) assert.ok(!input.includes(pair));
      passed++;
    } catch { /* Count the negative control without exposing exception/source text. */ }
  }
  return { passed, total: 1000 };
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jev-quality-offline-"));
let confirmedExit = true;
const checks = [];
globalThis.fetch = async () => { throw new Error("No network is allowed in this offline verifier."); };
try {
  for (const source of sources) {
    const work = path.join(temp, source); await fs.mkdir(work);
    await fs.writeFile(path.join(work, "ranges.mjs"), await fs.readFile(path.join(here, source)), { flag: "wx" });
    await fs.writeFile(path.join(work, "held-out.test.mjs"), await fs.readFile(path.join(here, "held-out.test.mjs")), { flag: "wx" });
    const env = { HOME: work, USERPROFILE: work, PI_CODING_AGENT_DIR: path.join(work, "isolated-agent"), DO_NOT_TRACK: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
    for (const key of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawnSync(process.execPath, ["--no-env-file", "--no-install", `--config=${config}`, path.join(work, "held-out.test.mjs")],
      { cwd: work, env, encoding: "utf8", timeout: 30_000 });
    if (child.error || child.signal || child.status === null) confirmedExit = false;
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.kind, "synthetic_quality_assertions"); assert.equal(result.total, 12);
    const row = recorded.liveRuns.find(value => value.source === source);
    const expected = row?.parentContractGroupsPassed ?? recorded.controls.negativeBaseline.contractGroupsPassed;
    assert.equal(child.status, source === "buggy.mjs" ? 1 : 0); assert.equal(result.passed, expected);
    const module = await import(pathToFileURL(path.join(here, source)).href);
    assert.deepEqual(Object.keys(module), ["mergeClosedIntegerRanges"]);
    const oracle = oracleCheck(module.mergeClosedIntegerRanges);
    if (row) assert.equal(oracle.passed, row.parentOraclePassed);
    else {
      assert.equal(oracle.passed, recorded.controls.negativeBaseline.offlineOraclePassedAtReportTime);
      assert.ok(oracle.passed < oracle.total, "Negative control must expose oracle failures.");
    }
    checks.push({ source, contractPassed: result.passed, contractTotal: result.total, oracle });
  }
  console.log(JSON.stringify({ kind: "offline_live_quality_reproduction", hashesVerified: true, checks, providerCalls: 0,
    recordedTimingAndCostReexecuted: false, storedMetadataGrantsAuthority: false }, null, 2));
} finally {
  if (confirmedExit) await fs.rm(temp, { recursive: true, force: true });
  else console.error("Offline child exit unconfirmed; owned temporary evidence retained.");
}

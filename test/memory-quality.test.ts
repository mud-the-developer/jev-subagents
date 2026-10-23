import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { memoryQualityCases, memoryQualityFixture, evaluateMemoryQuality, parseMemoryQualityReplay, MEMORY_QUALITY_GATE,
  type MemoryQualityPrediction } from "../eval/memory-quality.ts";
import { delegationMemoryRequest } from "../src/delegation-memory.ts";

function predictions(): MemoryQualityPrediction[] {
  return memoryQualityCases.map(item => {
    const { catalog } = memoryQualityFixture(item.id), index = catalog.records.findIndex(record => record.id === `fact_${item.expected}`);
    return { id: item.id, status: "resolved", attempts: 1, agent: item.expected === null ? "no_match" : `record_${index}`, confidence: 0.9,
      report: { model: "jev-1.13.0", usage: { inputTokens: 100, outputTokens: 1 } }, requestMs: 50 };
  });
}
test("fixed authored memory cases separate development/heldout and rotate all positive positions without leaking labels", () => {
  assert.equal(memoryQualityCases.length, 48); assert.equal(new Set(memoryQualityCases.map(item => item.id)).size, 48);
  const baseline = memoryQualityCases.filter(item => item.split === "development" || item.split === "heldout").map(item => ({ id: item.id, request: memoryQualityFixture(item.id).request }));
  assert.equal(createHash("sha256").update(JSON.stringify(baseline)).digest("hex"), "cdff38233afb4b1218468f9a9a34e35cfac21e60c2eaf8ac5a9a393fb8f93da3");
  const rejected = memoryQualityCases.filter(item => item.split === "qualification").map(item => ({ id: item.id, request: memoryQualityFixture(item.id).request }));
  assert.equal(createHash("sha256").update(JSON.stringify(rejected)).digest("hex"), "3f00d24c3b92deafee13f7f43c2344ac9f6ba7ca56fe7f21379f0927d22c67e1");
  for (const split of ["development", "heldout", "qualification", "confirmation"] as const) {
    const cases = memoryQualityCases.filter(item => item.split === split); assert.equal(cases.length, 12); assert.equal(cases.filter(item => item.expected === null).length, 4);
    const positions = new Set<number>();
    for (const item of cases) {
      const fixture = memoryQualityFixture(item.id);
      if (split === "confirmation") assert.deepEqual(fixture.request, delegationMemoryRequest(fixture.source, fixture.catalog));
      assert.equal(fixture.request.agents.length, 9); assert.doesNotMatch(JSON.stringify(fixture.request), /Synthetic reference only|provenance|directoryRef|expected|split|heldout|dev_parser/);
      if (item.expected !== null) positions.add(fixture.catalog.records.findIndex(record => record.id === `fact_${item.expected}`));
    }
    assert.equal(positions.size, 8);
  }
  assert.equal(MEMORY_QUALITY_GATE.maximumAcceptedWrong, 0);
});
test("quality scoring counts all cases and requires the new confirmation gate, not consumed labels", () => {
  const input = predictions(), before = structuredClone(input), good = evaluateMemoryQuality(input, "confirmation");
  assert.equal(good.autonomousCorrect, 12); assert.equal(good.gatePassed, true); assert.equal(good.noMatchCorrect, 4); assert.equal(good.attempts, 12);
  assert.equal(evaluateMemoryQuality(input, "development").gatePassed, false, "Development results do not substitute for heldout gating");
  const row = input.find(row => row.id === "confirm_parser")!; row.confidence = 0.49;
  const abstain = evaluateMemoryQuality(input, "confirmation"); assert.equal(abstain.autonomousCorrect, 11); assert.equal(abstain.rawTopCorrect, 12); assert.equal(abstain.parentHandoffs, 1);
  const wrong = input.find(row => row.id === "confirm_credentials")!; wrong.agent = wrong.agent === "record_0" ? "record_1" : "record_0";
  assert.equal(evaluateMemoryQuality(input, "confirmation").acceptedWrong, 1); assert.equal(evaluateMemoryQuality(input, "confirmation").gatePassed, false);
  assert.equal(evaluateMemoryQuality([], "heldout").missing, 12); assert.equal(evaluateMemoryQuality(before.slice(0, 12), "heldout").autonomousAccuracy, 0);
});
test("missing/failed usage, unknown price and unmeasured latency never become a zero invoice or fabricated timing", () => {
  const input = predictions();
  input[12] = { id: "held_parser", status: "failed", attempts: 1, agent: null, confidence: null };
  const failed = evaluateMemoryQuality(input, "heldout"); assert.equal(failed.failed, 1); assert.equal(failed.pending, 1); assert.equal(failed.costEstimate.totalUsd, null);
  const local = predictions().map(row => ({ ...row, report: { ...row.report!, provider: "openjev" as const } }));
  assert.equal(evaluateMemoryQuality(local, "heldout").costEstimate.totalUsd, null);
  const untimed = predictions().map(({ requestMs: _time, ...row }) => row), score = evaluateMemoryQuality(untimed, "heldout");
  assert.deepEqual(score.latency, { measured: 0, medianMs: null, p95Ms: null });
});
test("replays reject duplicate, foreign, forged receipt and oversized records without echoing private input", () => {
  const good = predictions(); assert.deepEqual(parseMemoryQualityReplay(good.map(row => JSON.stringify(row)).join("\n")), good);
  for (const input of [[good[0], good[0]], [{ ...good[0], id: "foreign" }], [{ ...good[0], agent: "foreign" }], [{ ...good[0], report: undefined }],
    [{ ...good[0], status: "failed" }], [{ ...good[0], confidence: 2 }], [{ ...good[0], PRIVATE: "PRIVATE_EXCERPT" }]])
    assert.throws(() => evaluateMemoryQuality(input, "heldout"), error => error instanceof Error && !error.message.includes("PRIVATE_EXCERPT"));
  assert.throws(() => parseMemoryQualityReplay("PRIVATE_EXCERPT")); assert.throws(() => parseMemoryQualityReplay("a".repeat(65537)));
});
test("offline memory evaluator has no live mode and replays the production-format requests", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-memory-eval-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const exec = promisify(execFile), cli = fileURLToPath(new URL("../eval/memory-run.ts", import.meta.url));
  const run = (args: string[]) => exec(process.execPath, [cli, ...args], { timeout: 10000, env: { PATH: process.env.PATH, HOME: dir } });
  assert.equal(JSON.parse((await run(["--cases"])).stdout).cases.length, 48);
  assert.deepEqual(JSON.parse((await run(["--request", "dev_parser"])).stdout), memoryQualityFixture("dev_parser").request);
  const replay = path.join(dir, "replay.jsonl"); await writeFile(replay, predictions().map(row => JSON.stringify(row)).join("\n"));
  assert.equal(JSON.parse((await run(["--replay", replay])).stdout).confirmation.gatePassed, true);
  await assert.rejects(run(["--live"])); await writeFile(replay, "PRIVATE_EXCERPT".repeat(6000));
  await assert.rejects(run(["--replay", replay]), error => error instanceof Error && !error.message.includes("PRIVATE_EXCERPT"));
});

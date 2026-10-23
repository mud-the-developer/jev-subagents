import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cases, evaluate, parseReplay, ruleBaseline } from "../eval/evaluate.ts";
import { LIMITS } from "../src/machine.ts";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../eval/run.ts", import.meta.url));

test("seed evaluation has 20 bounded cases and scores predictions without hiding failures", () => {
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map(({ id }) => id)).size, 20);
  for (const item of cases) assert.ok(item.task.length <= LIMITS.task && item.expected.length > 0);
  const correct = cases.map(({ id, expected }) => ({ id, agent: expected[0] }));
  assert.equal(evaluate(Object.freeze(correct)).accuracy, 1);
  assert.equal(evaluate(correct.slice(1)).accuracy, 19 / 20);
  assert.equal(evaluate(correct.slice(1)).missing, 1);
  const failed = evaluate([{ id: cases[0]!.id, agent: null }]);
  assert.equal(failed.accuracy, 0);
  assert.equal(failed.failed, 1);
  assert.equal(failed.missing, 19);
  assert.equal(evaluate([]).accuracy, 0);
  const baseline = cases.map(({ id, task }) => ({ id, agent: ruleBaseline(task) }));
  assert.deepEqual(evaluate(baseline), evaluate(baseline));
  assert.equal(ruleBaseline("Find the entry point without changes"), "scout");
  assert.equal(ruleBaseline("Fix a concurrency race"), "worker_strong");
  assert.equal(ruleBaseline("Fix a typo"), "worker");
});

test("replay validation rejects unknown, duplicate, or malformed records without echoing payloads", () => {
  const valid = { id: cases[0]!.id, agent: "scout" };
  assert.deepEqual(parseReplay(`\n${JSON.stringify(valid)}\r\n`), [valid]);
  for (const text of ["offline-secret", JSON.stringify({ ...valid, secret: "offline-secret" }), JSON.stringify({ ...valid, agent: "outsider" })]) {
    assert.throws(() => parseReplay(text), (error: Error) => !error.message.includes("offline-secret"));
  }
  for (const bad of [null, {}, [valid, valid], [{ ...valid, agent: "outsider" }], [{ ...valid, id: "unknown" }],
    [{ ...valid, secret: "offline-secret" }], [{ id: valid.id }], Array(21).fill(valid)]) {
    assert.throws(() => evaluate(bad), (error: Error) => !error.message.includes("offline-secret"));
  }
});

test("offline CLI supports rule/fixed baselines and bounded JSONL replay, never live mode", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-eval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { env: { PATH: process.env.PATH, HOME: dir }, timeout: 10_000 };
  const run = (args: string[]) => exec(process.execPath, [cli, ...args], options);
  const rules = JSON.parse((await run([])).stdout);
  assert.equal(rules.mode, "rules");
  assert.equal(rules.cases, 20);
  const fixed = JSON.parse((await run(["--fixed", "worker"])).stdout);
  assert.equal(fixed.mode, "fixed:worker");
  assert.equal(JSON.parse((await run(["--cases"])).stdout).cases.length, 20);
  const replay = path.join(dir, "results.jsonl");
  await writeFile(replay, cases.map(({ id, expected }) => JSON.stringify({ id, agent: expected[0] })).join("\n") + "\n");
  assert.equal(JSON.parse((await run(["--replay", replay])).stdout).accuracy, 1);
  await writeFile(replay, "offline-secret".repeat(6_000));
  await assert.rejects(run(["--replay", replay]), (error: Error) => !error.message.includes("offline-secret"));
  await assert.rejects(run(["--live"]));
});

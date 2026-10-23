import assert from "node:assert/strict";
import { test } from "node:test";
import { goalLeaseControlBatches } from "../src/goal-run-effects.ts";
import { MAX_GOAL_FILE_BYTES, MAX_GOAL_FILES_BYTES } from "../src/goal-files.ts";
import type { GoalContextFile } from "../src/goal-run.ts";
const owner = "C:\\work\\.jev-goal.lock", journal = "C:\\private\\goal.jsonl";
function entry(path: string, bytes: number | null = 0): GoalContextFile {
  return { path, active: false, text: null, version: bytes === null ? null : { identity: { dev: 1, ino: "ntfs:0000000000000001" },
    stamp: "a".repeat(64), digest: "b".repeat(64), bytes } };
}

test("control batch plan preserves exact path order, missing/duplicate entries and input snapshots without authority or I/O", () => {
  const context = [entry("C:\\work\\AGENTS.md", 1024), entry("C:\\work\\missing.md", null), entry("C:\\work\\AGENTS.md", 1024)];
  const before = structuredClone(context); for (const file of context) { if (file.version) { Object.freeze(file.version.identity); Object.freeze(file.version); } Object.freeze(file); } Object.freeze(context);
  const expected = [[owner, journal, ...context.map(file => file.path)]];
  assert.deepEqual(goalLeaseControlBatches(context, owner, journal, 512), expected);
  assert.deepEqual(context, before); assert.deepEqual(goalLeaseControlBatches(context, owner, journal, 512), expected);
});

test("control batch plan reserves a full possible journal instead of relying on stale or cached journal length", () => {
  const context = [entry("C:\\work\\one.md", MAX_GOAL_FILE_BYTES), entry("C:\\work\\two.md", MAX_GOAL_FILE_BYTES)];
  assert.equal(goalLeaseControlBatches(context, owner, journal, 512).length, 1);
  context.push(entry("C:\\work\\three.md", MAX_GOAL_FILE_BYTES));
  assert.ok(context.reduce((sum, file) => sum + (file.version?.bytes ?? 0), 0) < MAX_GOAL_FILES_BYTES);
  assert.deepEqual(goalLeaseControlBatches(context, owner, journal, 512), [[owner, journal], context.map(file => file.path)]);
});

test("control batch plan keeps 128-entry scopes rather than silently dropping or retrying excess paths", () => {
  const context = Array.from({ length: 128 }, (_, i) => entry(`C:\\work\\${i}.md`, null));
  assert.deepEqual(goalLeaseControlBatches(context, owner, journal, 256), [[owner, journal], context.map(file => file.path)]);
});

test("control batch plan bounds escaped-path/frame overhead independently of the raw byte allowance", () => {
  const context = Array.from({ length: 48 }, (_, i) => entry(`C:\\work\\${"é".repeat(900)}-${i}.md`, null));
  assert.deepEqual(goalLeaseControlBatches(context, owner, journal, 256), [[owner, journal], context.map(file => file.path)]);
});

test("empty context still reads both fresh lease controls; planner returns no reused content or worker approval", () => {
  assert.deepEqual(goalLeaseControlBatches([], owner, journal, 256), [[owner, journal]]);
});

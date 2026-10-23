import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { registerJevTools } from "../src/index.ts";
import { parallelReadIO } from "../src/parallel-read-effects.ts";
import { ParallelReadInputSchema, parallelReadText } from "../src/parallel-read.ts";
import { DelegateToolInputSchema } from "../src/ordinary-effects.ts";
import { parallelFixture } from "./helpers/parallel-read-fixture.ts";

test("model guidance decides the split before catalog construction, not with a new pool width request", () => {
  const tools: ToolDefinition[] = [];
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!, guidance = tool.promptGuidelines!.join("\n");
  assert.match(guidance, /Before parallelRead tasks, decide split\/count via ordinary JEV advice\/planning/);
  assert.match(guidance, /Approved1\.\.3 read-only tasks=1\.\.3 lanes/);
  assert.match(guidance, /safety ceiling/); assert.match(guidance, /No pool JEV decision\/extra width\/planner call/);
  assert.ok("description" in ParallelReadInputSchema && typeof ParallelReadInputSchema.description === "string");
  assert.match(ParallelReadInputSchema.description, /No extra width\/planner request once the catalog is fixed; the pool makes no JEV decision/);
  assert.match(ParallelReadInputSchema.description, /strict \(ALL per-task reviews before any child\); decline launches none/);
});
test("registered read-only batch remains one control-plane call but runs three children concurrently after one review", async t => {
  const f = parallelFixture(), tools: ToolDefinition[] = [], hooks = new Map<string, (() => void | Promise<void>)[]>();
  let count = 0, ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }), releases: (() => void)[] = [];
  f.io.run = async () => await new Promise(resolve => { count++; releases.push(() => resolve({ started: true, cleanupConfirmed: true, result: f.reply() })); if (count === 3) ready(); });
  for (const key of Object.keys(f.io) as (keyof typeof parallelReadIO)[]) t.mock.method(parallelReadIO, key, f.io[key]);
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, fn: () => void | Promise<void>) { hooks.set(event, [...hooks.get(event) ?? [], fn]); } } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!;
  assert.equal(tool.executionMode, "sequential"); assert.equal(Value.Check(DelegateToolInputSchema, { parallelRead: f.input }), true);
  assert.equal(Value.Check(DelegateToolInputSchema, { parallelRead: { ...f.input, approval: true } }), false);
  const work = tool.execute("batch", { parallelRead: f.input }, t.signal, undefined, f.ctx); await started;
  assert.equal(count, 3); assert.equal(f.counts().confirmations, 1);
  await assert.rejects(tool.execute("second", { parallelRead: f.input }, t.signal, undefined, f.ctx), /closed, busy or uncertain/);
  releases.forEach(release => release()); const result = await work;
  assert.equal((result.details as { status: string }).status, "completed_unverified"); assert.equal((result.details as { peakActiveTasks: number }).peakActiveTasks, 3);
  for (const fn of hooks.get("session_shutdown") ?? []) await fn();
  await assert.rejects(tool.execute("after_shutdown", { parallelRead: f.input }, t.signal, undefined, f.ctx), /closed, busy or uncertain/);
});
test("lifecycle cancellation drains every active child before releasing the shared batch owner", async t => {
  const f = parallelFixture(), tools: ToolDefinition[] = [], hooks = new Map<string, (() => void | Promise<void>)[]>();
  let ready!: () => void, count = 0, closed = 0; const started = new Promise<void>(resolve => { ready = resolve; });
  f.io.run = async (_input, signal) => await new Promise(resolve => {
    count++; signal.addEventListener("abort", () => setImmediate(() => { closed++; resolve({ started: true, cleanupConfirmed: true,
      result: { type: "cancel", report: { startupMs: 1, executionMs: null, modelCalls: 0, accounting: { status: "not_started" } } } }); }), { once: true }); if (count === 3) ready();
  });
  for (const key of Object.keys(f.io) as (keyof typeof parallelReadIO)[]) t.mock.method(parallelReadIO, key, f.io[key]);
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, fn: () => void | Promise<void>) { hooks.set(event, [...hooks.get(event) ?? [], fn]); } } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!, work = tool.execute("batch", { parallelRead: f.input }, t.signal, undefined, f.ctx);
  const failure = assert.rejects(work, /Read-only batch stopped/); await started;
  for (const fn of hooks.get("session_before_tree") ?? []) await fn();
  assert.equal(closed, 3); await failure; assert.equal(f.counts().confirmations, 1);
});
test("parallel default tool rows never evaluate getters or expose profile/task/worker text", () => {
  const value = { kind: "parallel_read", status: "completed_unverified", attemptedTasks: 3, peakActiveTasks: 3, approvals: 1, modelCalls: 3,
    rows: [{ text: "PRIVATE_WORKER_REPORT" }], profile: "PRIVATE_PROFILE" };
  assert.match(parallelReadText(value), /peak 3/); assert.doesNotMatch(parallelReadText(value), /PRIVATE/);
  let getters = 0; assert.doesNotMatch(parallelReadText({ get kind() { getters++; return "parallel_read"; } }), /PRIVATE/); assert.equal(getters, 0);
  assert.doesNotMatch(parallelReadText({ ...value, status: "PRIVATE_STATUS" }), /PRIVATE/);
  assert.match(parallelReadText({ ...value, modelCalls: null }), /SDK unknown/);
});

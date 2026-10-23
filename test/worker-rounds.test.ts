import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DelegateInputSchema, DEFAULT_DELEGATE_MODEL_CALLS, DEFAULT_MAX_MODEL_CALLS, initialState, reduce, type Event } from "../src/delegate-machine.ts";
import { basicRunScope } from "../src/basic-execution.ts";
import { validOrdinaryScopeInput } from "../src/ordinary-authorization.ts";
import { summarizeWorkerRound, workerRoundCoverage, WorkerRoundCoverageSchema, WorkerRoundsSchema, workerRoundsText } from "../src/worker-rounds.ts";

test("ordinary defaults follow SDK completion without changing restricted Goal or an explicit finite scope", () => {
  assert.equal(DEFAULT_DELEGATE_MODEL_CALLS, null); assert.equal(DEFAULT_MAX_MODEL_CALLS, 6);
  const input = { agent: "scout", task: "Inspect the five declared files and report a short plan.", files: [{ path: "sample.txt", access: "read" }] };
  const broad = basicRunScope(input); assert.ok(broad); assert.equal(broad.limits.modelCalls, null); assert.equal(broad.limits.perWorkerCalls, null);
  assert.ok(validOrdinaryScopeInput(broad)); assert.equal(broad.limits.seconds, 86_400);
  const narrow = basicRunScope({ ...input, maxModelCalls: 4 }); assert.ok(narrow); assert.equal(narrow.limits.modelCalls, 4); assert.equal(narrow.limits.perWorkerCalls, 4);
  assert.equal(basicRunScope({ ...input, maxModelCalls: 100 })?.limits.modelCalls, 100);
  assert.equal(basicRunScope({ ...input, maxModelCalls: 0 }), undefined);
  assert.equal(basicRunScope({ ...input, seconds: 3600 })?.limits.seconds, 3600);
  assert.equal(basicRunScope({ ...input, seconds: 1800 })?.limits.seconds, 1800);
  assert.equal(basicRunScope({ ...input, seconds: 86_400 })?.limits.seconds, 86_400);
  assert.equal(basicRunScope({ ...input, seconds: 120 })?.limits.seconds, 120);
  for (const seconds of [0, 86_401, 1.5, Infinity]) assert.equal(basicRunScope({ ...input, seconds }), undefined);
  assert.ok(Value.Check(DelegateInputSchema, { task: input.task, agents: ["scout"], maxModelCalls: 12 }));
});
test("report rounds contain only whitelisted tools/stops, no raw private tool name, arguments or result", () => {
  const round = summarizeWorkerRound(4, "toolUse", ["read", "grep", "read", "PRIVATE_TOKEN_SOURCE"]); assert.ok(round);
  assert.deepEqual(round, { call: 4, stopReason: "toolUse", toolCount: 4, tools: ["read", "grep", "other"] });
  assert.ok(Value.Check(WorkerRoundsSchema, [round])); assert.doesNotMatch(JSON.stringify(round) + workerRoundsText([round]), /PRIVATE/);
  assert.equal(summarizeWorkerRound(13, "stop", [])?.call, 13);
  assert.equal(workerRoundCoverage(150, 150, 128), "partial"); assert.equal(summarizeWorkerRound(0, "stop", []), undefined);
  const unknown = summarizeWorkerRound(1, "PRIVATE_STOP", []); assert.equal(unknown?.stopReason, "other");
  assert.ok(!Value.Check(WorkerRoundsSchema, [{ ...round, tools: ["PRIVATE_AUTH"] }]));
});
test("a completed tool round and a final report are separate model round trips", () => {
  const rows = [summarizeWorkerRound(1, "toolUse", ["find", "read"])!, summarizeWorkerRound(2, "stop", [])!];
  assert.equal(rows.length, 2); assert.equal(rows[0]!.toolCount, 2); assert.equal(rows[1]!.toolCount, 0);
  const text = workerRoundsText(rows); assert.match(text, /1.*toolUse.*find, read/); assert.match(text, /2.*stop.*tool requests 0/);
});
test("trace coverage distinguishes observed response metadata from missing and unknown turns", () => {
  assert.equal(workerRoundCoverage(2, 2, 2), "complete"); assert.equal(workerRoundCoverage(0, 0, 0), "complete");
  for (const [calls, observed, recorded] of [[2, 1, 1], [1, 0, 0], [12, 13, 12]] as const) assert.equal(workerRoundCoverage(calls, observed, recorded), "partial");
  for (const [calls, observed, recorded] of [[null, 1, 1], [1, null, 0], [1, 1, 2], [-1, 0, 0], [NaN, 0, 0]] as const) assert.equal(workerRoundCoverage(calls, observed, recorded), "unknown");
  for (const coverage of ["complete", "partial", "unknown"] as const) assert.ok(Value.Check(WorkerRoundCoverageSchema, coverage));
  assert.match(workerRoundsText([], "partial"), /partial.*omissions/); assert.match(workerRoundsText([], "complete"), /response metadata only.*not task completion\/accounting\/cleanup/);
});
test("large tool batches report their exact count without expanding the bounded tool-name projection", () => {
  const round = summarizeWorkerRound(1, "toolUse", Array(129).fill("read")); assert.ok(round);
  assert.equal(round.toolCount, 129); assert.deepEqual(round.tools, ["read"]); assert.ok(Value.Check(WorkerRoundsSchema, [round]));
  assert.match(workerRoundsText([round], "complete"), /tool requests 129/);
});
test("terminal delegation state cannot be revived by a later proposal with a larger budget", () => {
  const start: Event = { type: "start", job: { input: { task: "New task", agents: ["scout"], maxModelCalls: 12 }, cwd: "/fixture" }, canConfirm: true };
  const active = reduce(initialState(), start).state;
  const stopped = reduce(active, { type: "failed", error: "fixed" }).state;
  assert.equal(stopped.status, "failed");
  assert.strictEqual(reduce(stopped, start).state, stopped);
});

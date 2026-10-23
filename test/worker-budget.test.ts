import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { DecisionInputSchema, reduceDecision, type DecisionReply } from "../src/decision.ts";
import { WorkerBudgetInputSchema, workerBudgetDecision, workerBudgetDiagnostic, workerBudgetOutcome, type WorkerBudgetInput } from "../src/worker-budget.ts";
import { registerJevTools } from "../src/index.ts";
const input: WorkerBudgetInput = { kind: "worker_budget", taskSummary: "Inspect five declared source files and report a build/test plan without edits.",
  fileCount: 5, readOnly: true, tools: ["read", "grep", "find", "ls"], callCeiling: 12, requiresHuman: false };
function judged(probabilities = { calls_2: 0.05, calls_4: 0.1, calls_8: 0.7, calls_12: 0.15 }): DecisionReply {
  return { model: "jev-test", usage: { inputTokens: 50, outputTokens: 20 }, choice: "calls_8", confidence: probabilities.calls_8, probabilities };
}
test("manual budget input failures identify fixed causes before session, network, UI or worker work", async t => {
  const tools: ToolDefinition[] = [];
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find(value => value.name === "jev_decide")!;
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("No network"));
  const ctx = { get sessionManager(): never { throw Error("No session access for invalid input"); },
    get ui(): never { throw Error("No approval for invalid input"); } } as unknown as ExtensionContext;
  for (const [bad, reason] of [
    ...["bash", "edit", "write", "scope_edit", "scope_write"].map(name => [{ ...input, tools: ["read", name], fileCount: 15 }, "read_only_tool_conflict"] as const),
    [{ ...input, taskSummary: "비공개 작업" }, "non_english_summary"],
    [{ ...input, callCeiling: 100 }, "invalid_input"],
    [{ ...input, PRIVATE_RAW_SOURCE: "PRIVATE_AUTH_PATH" }, "invalid_input"],
    [{ ...input, taskSummary: "Review " + "\"".repeat(2900) }, "invalid_decision_packet"],
  ] as const) {
    assert.equal(workerBudgetDecision(bad), undefined);
    await assert.rejects(tool.execute("invalid-manual-budget", bad, undefined, undefined, ctx), error => {
      assert.ok(error instanceof Error); assert.match(error.message, new RegExp(reason));
      assert.doesNotMatch(error.message, /PRIVATE|비공개/); return true;
    });
    const outcome = workerBudgetOutcome(bad as WorkerBudgetInput, { status: "idle" });
    assert.equal(outcome.status, "failed"); assert.equal("diagnostic" in outcome && outcome.diagnostic, reason);
    assert.equal(outcome.executionAuthorized, false); assert.equal("maxModelCalls" in outcome, false);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("manual budget diagnostics reject accessor/inherited metadata without invoking private getters", () => {
  let reads = 0;
  const hostile = { ...input, get taskSummary() { reads++; return "PRIVATE_SOURCE"; } };
  const nested = { ...input, tools: ["read", "grep"] };
  Object.defineProperty(nested.tools, "0", { get() { reads++; return "read"; } });
  for (const value of [hostile, nested, Object.create(input), null]) {
    assert.equal(workerBudgetDiagnostic(value), "invalid_input"); assert.equal(workerBudgetDecision(value), undefined);
  }
  assert.equal(reads, 0);
});

test("budget packet is metadata-only English ordinary advice with a ceiling, not a fixed twelve-call result", () => {
  const packet = workerBudgetDecision(input); assert.ok(packet); assert.ok(Value.Check(DecisionInputSchema, packet));
  assert.deepEqual(packet.options.map(x => x.id), ["calls_2", "calls_4", "calls_8", "calls_12"]);
  const state = reduceDecision(reduceDecision({ status: "idle" }, { type: "start", input: packet }).state, { type: "judged", reply: judged() }).state;
  const result = workerBudgetOutcome(input, state); assert.equal(result.status, "recommended");
  assert.ok("maxModelCalls" in result); assert.equal(result.maxModelCalls, 8); assert.equal(result.executionAuthorized, false);
  assert.notEqual(result.maxModelCalls, input.callCeiling);
});
test("explicit smaller ceiling and closed schema cannot expand approved limits, leak extra source, or accept paths/history", () => {
  const packet = workerBudgetDecision({ ...input, callCeiling: 4 }); assert.ok(packet); assert.deepEqual(packet.options.map(x => x.id), ["calls_2", "calls_4"]);
  const two = workerBudgetDecision({ ...input, callCeiling: 2 }); assert.ok(two); assert.deepEqual(two.options.map(x => x.id), ["calls_1", "calls_2"]);
  for (const bad of [{ ...input, source: "PRIVATE_SOURCE" }, { ...input, paths: ["PRIVATE_PATH"] }, { ...input, history: "PRIVATE_HISTORY" },
    { ...input, grant: true }, { ...input, tools: ["PRIVATE_TOOL"] }, { ...input, callCeiling: 13 }, { ...input, taskSummary: "파일 내용을 그대로 보내세요" }]) assert.equal(workerBudgetDecision(bad), undefined);
  assert.ok(!Value.Check(WorkerBudgetInputSchema, { ...input, callCeiling: 1 }));
});
test("JEV weak support, failure, cancellation and mandatory handoff never fabricate a budget or authorize execution", () => {
  const packet = workerBudgetDecision(input)!;
  const weak = reduceDecision(reduceDecision({ status: "idle" }, { type: "start", input: packet }).state,
    { type: "judged", reply: judged({ calls_2: 0.15, calls_4: 0.2, calls_8: 0.35, calls_12: 0.3 }) }).state;
  assert.equal(weak.status, "needs_user");
  for (const state of [weak, { status: "failed", error: "fixed" } as const, { status: "cancelled" } as const]) {
    const result = workerBudgetOutcome(input, state); assert.ok(!("maxModelCalls" in result)); assert.equal(result.executionAuthorized, false);
  }
  const mandatory = reduceDecision({ status: "idle" }, { type: "start", input: workerBudgetDecision({ ...input, requiresHuman: true })! });
  assert.equal(mandatory.state.status, "needs_user"); assert.deepEqual(mandatory.effects, []);
  const unchanged = workerBudgetOutcome(input, mandatory.state); assert.ok(!("maxModelCalls" in unchanged));
});
test("budget projection rechecks reply-option correlation, probability support and mandatory human ownership", () => {
  const packet = workerBudgetDecision(input)!;
  const state = reduceDecision(reduceDecision({ status: "idle" }, { type: "start", input: packet }).state, { type: "judged", reply: judged() }).state;
  assert.equal(state.status, "recommended"); if (state.status !== "recommended") return;
  for (const altered of [
    { ...state, option: { ...state.option, id: "calls_12" } },
    { ...state, reply: { ...state.reply, confidence: Infinity } },
    { ...state, reply: judged({ calls_2: 0.15, calls_4: 0.2, calls_8: 0.35, calls_12: 0.3 }) },
    { ...state, reply: { ...state.reply, probabilities: { calls_2: 0, calls_4: 0, calls_8: 0.1, calls_12: 0.9 } } },
  ]) {
    const result = workerBudgetOutcome(input, altered); assert.equal(result.status, "failed"); assert.ok(!("maxModelCalls" in result)); assert.equal(result.executionAuthorized, false);
  }
  assert.equal(workerBudgetOutcome({ ...input, requiresHuman: true }, state).status, "failed");
  const untrusted = { ...state, PRIVATE: "PRIVATE_RAW_REPLY", option: { ...state.option, title: "PRIVATE_MUTATED_TITLE" } };
  const owned = workerBudgetOutcome(input, untrusted);
  assert.equal(owned.status, "recommended"); assert.doesNotMatch(JSON.stringify(owned), /PRIVATE/);
});
test("contradictory read-only metadata and JSON serialization overflow stop before a JEV request", async t => {
  const registry: ToolDefinition[] = []; registerJevTools({ registerTool(tool: ToolDefinition) { registry.push(tool); }, on() {} } as unknown as ExtensionAPI);
  const tool = registry.find(x => x.name === "jev_decide")!;
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No request is allowed"); });
  const ctx = {} as ExtensionContext;
  for (const bad of [
    ...["bash", "write", "edit", "scope_write", "scope_edit"].map(name => ({ ...input, tools: ["read", name] })),
    { ...input, taskSummary: "Review " + "\"".repeat(2900) },
  ]) { assert.equal(workerBudgetDecision(bad), undefined); await assert.rejects(tool.execute("invalid-budget", bad, undefined, undefined, ctx)); }
  assert.equal(fetch.mock.callCount(), 0);
  assert.ok(workerBudgetDecision({ ...input, readOnly: false, tools: ["read", "edit"] }));
});
test("registered jev_decide budget adapter calls JEV once, returns eight, never executes SDK/approval or private extras", async t => {
  const tools: ToolDefinition[] = [];
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find(x => x.name === "jev_decide")!; let calls = 0;
  const mutable = structuredClone(input);
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = "offline-budget-key";
  t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.state.workerOutput, undefined);
    assert.match(JSON.stringify(body), /calls_8/); assert.ok(!JSON.stringify(body).includes("offline-budget-key"));
    mutable.callCeiling = 4; mutable.taskSummary = "PRIVATE_MUTATED";
    return new Response(JSON.stringify({ model: "jev-test", usage: { input_tokens: 50, output_tokens: 20 }, answers: { option: {
      type: "choice", choice: "calls_8", confidence: 0.7, probabilities: { calls_2: 0.05, calls_4: 0.1, calls_8: 0.7, calls_12: 0.15 } } } }), { status: 200 });
  });
  const ctx = { sessionManager: { getSessionId: () => "offline-budget-session" }, ui: { confirm: () => assert.fail("No execution approval"), custom: () => assert.fail("No worker UI") } } as unknown as ExtensionContext;
  const result = await tool.execute("budget-call", mutable, undefined, undefined, ctx); const data = result.details as { maxModelCalls: number; callCeiling: number; executionAuthorized: boolean };
  assert.equal(calls, 1); assert.equal(data.maxModelCalls, 8); assert.equal(data.callCeiling, 12); assert.equal(data.executionAuthorized, false);
  assert.ok(!JSON.stringify(result).includes("offline-budget-key")); assert.ok(!JSON.stringify(result).includes("PRIVATE_MUTATED"));
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { test } from "node:test";
import { truncateToVisualLines, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerJevTools } from "../src/index.ts";
import { delegateResultView, type DelegateViewOptions } from "../src/delegate-presentation.ts";

const normal: DelegateViewOptions = { expanded: false, isPartial: false, isError: false };
const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const profile = { agent: "worker", model: { provider: "offline", id: "offline-worker" }, thinking: "high" };
const final = { content: [{ type: "text" as const, text: 'MODEL_JSON_HEADER\n\nPRIVATE_WORKER_CLAIM\u001b[2J' }], details: {
  status: "succeeded", taskAcceptance: "needs_human_review", agent: profile.agent, model: profile.model,
  verification: { status: "not_requested" }, assessment: { status: "not_requested" },
  result: { text: "PRIVATE_WORKER_CLAIM", truncated: true }, metrics: { profile },
  costEstimate: { observedUsd: 0.01, delegationTotalUsd: null }, PRIVATE_FIELD: "PRIVATE_PROVIDER_TOKEN",
} };

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) frozen(child); }
  return value;
}
function tool() {
  const tools: ToolDefinition[] = [];
  registerJevTools({ registerTool: (value: ToolDefinition) => { tools.push(value); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  return tools.find(value => value.name === "jev_delegate")!;
}
function context(isError: boolean) {
  return { isError } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
}

test("approved runtime timeouts show validated duration metadata, not a generic cancellation or raw error", () => {
  for (const seconds of [120, 600, 3600, 86_400]) {
    const details = { status: "failed", error: `Subagent exceeded its ${seconds}-second time limit. Changes may be incomplete.`,
      metrics: { profile: { ...profile, seconds }, worker: { modelCalls: 3, accounting: { status: "unknown" }, diagnostic: { category: "cancelled" } } } };
    const text = delegateResultView({ details }, { ...normal, isError: true }).text;
    assert.match(text, /Approved execution deadline reached/); assert.ok(text.includes(String(seconds))); assert.doesNotMatch(text, /Subagent exceeded/);
  }
  const hostile = { status: "failed", error: "PRIVATE_RAW_TIMEOUT", metrics: { profile: { seconds: "PRIVATE\n600" } } };
  assert.doesNotMatch(delegateResultView({ details: hostile }, { ...normal, isError: true }).text, /PRIVATE/);
});

test("native ordinary delegate rendering is a pure human projection, preserving model content and details", t => {
  const http = t.mock.method(globalThis, "fetch", async () => { throw new Error("Rendering must not infer or transmit."); });
  const fork = t.mock.method(childProcess, "fork", () => { throw new Error("Rendering must not launch."); });
  const row = tool(), input = frozen(structuredClone(final)), before = structuredClone(input);
  assert.ok(row.renderCall); assert.ok(row.renderResult);
  const call = row.renderCall({ task: "PRIVATE_TASK", agents: ["worker"], PRIVATE_ARGV: "PRIVATE_PROVIDER_TOKEN" }, theme, context(false));
  assert.equal(call.render(80).join("\n").trimEnd(), "JEV · Delegation");
  for (const expanded of [false, true]) {
    const result = row.renderResult(input, { expanded, isPartial: false }, theme, context(false));
    for (const width of [17, 80]) {
      const lines = result.render(width), text = lines.join("\n");
      assert.deepEqual(lines, truncateToVisualLines(delegateResultView(input, { ...normal, expanded }).text, 2000, width, 0).visualLines);
      for (const secret of ["PRIVATE_TASK", "PRIVATE_ARGV", "PRIVATE_WORKER_CLAIM", "PRIVATE_FIELD", "PRIVATE_PROVIDER_TOKEN", "MODEL_JSON_HEADER", "\u001b"])
        assert.equal(text.includes(secret), false);
    }
    assert.match(result.render(100).join("\n"), /final acceptance needs human review/);
  }
  assert.deepEqual(input, before); assert.equal(http.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0);
});

test("streamed phases are finite fixed labels, never raw input or a completed verdict", async t => {
  for (const phase of ["loading", "routing", "preparing_harness", "awaiting_approval", "running", "verifying", "awaiting_assessment_approval", "judging"])
    await t.test(phase, () => {
      const view = delegateResultView({ details: { phase }, content: [{ type: "text", text: "PRIVATE_PARTIAL" }] }, { ...normal, isPartial: true });
      assert.equal(view.tone, "muted"); assert.ok(view.text.startsWith("JEV · ")); assert.doesNotMatch(view.text, /PRIVATE|Execution ended|Verification.*passed/);
    });
  for (const phase of ["PRIVATE_PHASE", "__proto__", "constructor", "toString", undefined]) {
    const view = delegateResultView({ details: { phase }, content: [{ type: "text", text: "PRIVATE_PARTIAL" }] }, { ...normal, isPartial: true });
    assert.equal(view.text, "JEV · Checking progress");
  }
});

test("successful execution is explicitly unverified without a verifier; passed checks cover only their declaration", () => {
  const unknown = delegateResultView(final, normal);
  assert.match(unknown.text, /not requested.*unverified/); assert.match(unknown.text, /delegation total unknown/);
  const passed = structuredClone(final);
  Object.assign(passed.details.verification, { status: "passed", exitCode: 0 });
  assert.match(delegateResultView(passed, normal).text, /declared checks passed.*not proof of all requirements/);
  Object.assign(passed.details.verification, { status: "passed", exitCode: 1 });
  assert.match(delegateResultView(passed, normal).text, /result unknown/);
  assert.equal(delegateResultView(final, { ...normal, isError: true }).text.includes("Execution ended"), false);
});

test("expanded response trace shows partial coverage without claiming tool execution or leaking raw data", () => {
  const input = { details: { status: "failed", metrics: { worker: { modelCalls: 2, roundsCoverage: "partial",
    rounds: [{ call: 1, stopReason: "toolUse", toolCount: 129, tools: ["read"] }], PRIVATE: "PRIVATE_SOURCE" } } } };
  const view = delegateResultView(input, { ...normal, expanded: true, isError: true });
  assert.match(view.text, /Round coverage.*partial/); assert.match(view.text, /tool requests 129/); assert.doesNotMatch(view.text, /PRIVATE|work complete|cleanup confirmed/);
  input.details.metrics.worker.rounds = [];
  assert.match(delegateResultView(input, { ...normal, expanded: true, isError: true }).text, /Round coverage.*partial/);
});
test("unknown, partial, tiny and malformed costs never become a completed zero invoice", () => {
  for (const [observedUsd, delegationTotalUsd] of [[0, null], [null, null], [0.01, null], [NaN, 0], [Infinity, 0], [-1, 0], [1, 0], ["0", "0"]]) {
    const value = { ...final, details: { ...final.details, costEstimate: { observedUsd, delegationTotalUsd } } };
    const view = delegateResultView(value, normal);
    assert.match(view.text, /delegation total unknown/); assert.match(view.text, /parent excluded \/ not an invoice/);
  }
  for (const value of [0, 1e-12, 0.04]) {
    const view = delegateResultView({ ...final, details: { ...final.details, costEstimate: { observedUsd: value, delegationTotalUsd: value } } }, normal);
    assert.ok(view.text.includes(`delegation total $${value}`));
  }
});

test("failure, decline and cancellation render from bounded adapter records, without claims, error text, rollback or cleanup certification", () => {
  for (const status of ["failed", "cancelled", "incomplete", "needs_review"]) {
    const record = { status, reason: status === "cancelled" ? "aborted" : undefined, error: "PRIVATE_RAW_ERROR", result: { text: "PRIVATE_WORKER_CLAIM" },
      metrics: { profile, worker: { diagnostic: { category: "authentication", httpStatus: 401 } } }, costEstimate: { observedUsd: 0.01, delegationTotalUsd: null } };
    const input = { content: [{ type: "text", text: `PRIVATE_ERROR_PREFIX\n${JSON.stringify(record)}` }] };
    const view = delegateResultView(input, { ...normal, expanded: true, isError: true });
    assert.doesNotMatch(view.text, /PRIVATE|Execution ended|cleanup confirmed|rollback complete/); assert.match(view.text, /Check authentication/);
    assert.match(view.text, /neither rollback nor proof of cleanup/); assert.match(view.text, /delegation total unknown/);
  }
  const declined = delegateResultView({ content: [{ type: "text", text: 'PRIVATE_PREFIX\n{"status":"cancelled","reason":"declined"}' }] }, { ...normal, isError: true });
  assert.match(declined.text, /Positive execution approval unconfirmed.*no automatic retry/); assert.doesNotMatch(declined.text, /Execution ended|PRIVATE|approval refused/);
});

test("ordinary failure stages use only fixed human labels in collapsed and expanded views, never raw preparation input", () => {
  const details = { kind: "ordinary_scope", status: "stopped", taskAcceptance: "needs_human_review", workersStarted: 0,
    modelCalls: 0, reservedModelCalls: 0, jevRequests: 0, cleanupConfirmed: true, lockRetained: false,
    costEstimate: { observedUsd: 0, delegationTotalUsd: 0 }, reports: [{ text: "PRIVATE_WORKER_CLAIM" }],
    diagnostic: { phase: "preparing", preparationStage: "file_scope", raw: "PRIVATE_ERROR_PATH_KEY" } };
  for (const expanded of [false, true]) {
    const view = delegateResultView({ details }, { ...normal, expanded, isError: true });
    assert.match(view.text, /stopped during.*file\/type\/protected-path/); assert.doesNotMatch(view.text, /PRIVATE|cleanup confirmed|Plan execution ended/);
    assert.match(view.text, /^JEV · Plan stopped \/ no automatic retry/);
  }
  for (const stage of ["__proto__", "constructor", "PRIVATE_PATH", "file_scope\nPRIVATE_KEY"]) {
    const view = delegateResultView({ details: { ...details, diagnostic: { phase: "preparing", preparationStage: stage } } }, normal);
    assert.match(view.text, /stopped during Preparation/); assert.doesNotMatch(view.text, /PRIVATE|function|\[object Object\]/);
  }
  const unknown = delegateResultView({ details: { ...details, diagnostic: { phase: "__proto__", preparationStage: "PRIVATE" } } }, normal);
  assert.doesNotMatch(unknown.text, /Diagnostic:|PRIVATE/);
  const hostile = { phase: "preparing", get preparationStage(): never { throw new Error("Rendering must not invoke a diagnostic getter"); } };
  const safe = delegateResultView({ details: { ...details, diagnostic: hostile } }, normal);
  assert.match(safe.text, /stopped during Preparation/); assert.doesNotMatch(safe.text, /Inspect display state|PRIVATE/);
});

test("native error flag cannot be hidden by partial rendering or forged success details", () => {
  for (const isPartial of [false, true]) {
    const value = delegateResultView(final, { ...normal, isError: true, isPartial });
    assert.equal(value.tone, "error"); assert.match(value.text, /Execution stopped/); assert.doesNotMatch(value.text, /Execution ended|declared checks passed|PRIVATE/);
  }
});

test("malformed, oversized, missing or throwing data fails to a fixed non-echoing view", () => {
  const hostile = { get details(): never { throw new Error("PRIVATE_GETTER"); } };
  for (const input of [null, undefined, hostile, { details: "PRIVATE_DATA" },
    { content: [{ type: "text", text: "PRIVATE_ERROR" }] },
    { content: [{ type: "text", text: 'PRIVATE_ERROR\n{"status":' }] },
    { content: [{ type: "text", text: 'PRIVATE_ERROR\n{"status":"succeeded"}' }] },
    { content: [{ type: "text", text: "PRIVATE_ERROR\n" + "x".repeat(524_289) }] }]) {
    const view = delegateResultView(input, { ...normal, expanded: true, isError: true });
    assert.doesNotMatch(view.text, /PRIVATE|Execution ended|Observed estimate \$0|delegation total \$0/); assert.ok(view.text.length < 1000);
  }
});

test("expanded diagnostics and public identifiers reject terminal-control and prototype keys instead of rewriting source data", () => {
  const input = structuredClone(final);
  input.details.agent = "worker\u001b[2J"; input.details.model.id = "PRIVATE_ID\nHIDDEN_LINE";
  input.details.metrics.profile.agent = input.details.agent; input.details.metrics.profile.model.id = input.details.model.id;
  for (const category of ["PRIVATE_DIAGNOSTIC", "__proto__", "constructor", "toString"]) {
    const details = { ...input.details, metrics: { ...input.details.metrics, worker: { diagnostic: { category } } } };
    const before = structuredClone(details), view = delegateResultView({ ...input, details }, { ...normal, expanded: true });
    assert.doesNotMatch(view.text, /\u001b|HIDDEN_LINE|PRIVATE_ID|PRIVATE_DIAGNOSTIC|function|\[object Object\]/);
    assert.deepEqual(details, before);
  }
});

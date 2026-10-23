import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseDoctorRun, doctorEnvironmentText, doctorRunText } from "../src/doctor.ts";
import { MODEL_CALL_LIMIT_ERROR } from "../src/delegate-machine.ts";
import { delegateResultView } from "../src/delegate-presentation.ts";
import { registerOnboarding } from "../src/onboarding.ts";
import type { NativeExecutionHarness } from "../src/basic-execution.ts";
import type { OrdinaryPublicResult } from "../src/ordinary-effects.ts";
const scope = parseDoctorRun('{"agent":"scout","file":"sample.txt"}');
const view = { expanded: false, isPartial: false, isError: true } as const;

test("Doctor run is one fixed read-only worker with no caller task/model/grant/verification or arbitrary path", () => {
  assert.ok(scope); assert.equal(scope.selection, "parent_only"); assert.deepEqual(scope.agents, ["scout"]);
  assert.deepEqual(scope.files, [{ path: "sample.txt", access: "read" }]); assert.deepEqual(scope.limits, { workerRuns: 1, modelCalls: 2, perWorkerCalls: 2, seconds: 60 });
  for (const input of ['', 'PRIVATE_INPUT', '{"agent":"scout","file":"../auth.json"}', '{"agent":"scout","file":".env"}',
    '{"agent":"scout","file":"sample.txt","approved":true}', '{"agent":"scout","file":"sample.txt","model":"PRIVATE_OVERRIDE"}']) assert.equal(parseDoctorRun(input), undefined);
  for (const agent of ["", "invalid name", "../scout", "scout\nmodel: injected", "x".repeat(1000)]) {
    assert.equal(parseDoctorRun(JSON.stringify({ agent, file: "sample.txt" })), undefined);
  }
});
test("Doctor distinguishes metadata readiness from actual worker execution and keeps private fields out", () => {
  const text = doctorEnvironmentText({ runtime: { feature: "ordinary-scoped/v1", catalog: "scoped_visible", active: "yes", mode: "tui", approvalApi: "supported" },
    workspace: "refused_or_unconfirmed", blocked: "uncertain", cancelled: false, lastFailure: "FIXED_FAILURE" });
  assert.match(text, /FIXED_FAILURE/); assert.match(text, /Workspace permissions.*refused/); assert.match(text, /Standalone Bun worker SDK import.*not reported/);
  assert.doesNotMatch(text, /Standalone Bun worker SDK import.*failed/);
  assert.match(text, /Real worker.*not requested/); assert.match(text, /new execution blocked/); assert.doesNotMatch(text, /overall success|preparation complete|approval complete/i);
});
test("Doctor distinguishes an absent environment report from an attempted SDK import", () => {
  for (const [workerVersion, expected] of [[null, "failed/unconfirmed"], ["0.0.0", "pinned version mismatch"], ["0.85.1", "passed"]] as const) {
    const text = doctorEnvironmentText({ runtime: { feature: "ordinary-scoped/v1", catalog: "scoped_visible", active: "yes", mode: "tui", approvalApi: "supported" },
      workspace: "passed", blocked: undefined, cancelled: false, setup: { root: "/fixture", agentDir: "/agent", bun: "1.4.3", piVersion: "1.3.0",
        testedVersion: "0.85.1", workerVersion, profiles: [], jevKeyPresent: false } });
    assert.ok(text.includes(`Standalone Bun worker SDK import · ${expected}`));
    assert.doesNotMatch(text, /not reported/);
  }
});
test("collapsed legacy failure now shows exact call-limit cause, counts and partial accounting without private source", () => {
  const result = { status: "failed", error: MODEL_CALL_LIMIT_ERROR, PRIVATE: "PRIVATE_AUTH_SOURCE", metrics: { profile: { agent: "scout", model: { provider: "offline", id: "fixture" }, maxModelCalls: 6 },
    worker: { modelCalls: 6, accounting: { status: "unknown" }, diagnostic: { category: "unknown", httpStatus: 200, stage: "model_response" } } },
    costEstimate: { observedUsd: 0.0034518000000000005, delegationTotalUsd: null } };
  const text = delegateResultView({ details: result }, view).text;
  assert.match(text, /SDK model-round cap reached/); assert.match(text, /Worker SDK 6\/6/); assert.match(text, /accounting partial\/unknown/);
  assert.match(text, /\$0\.0034518/); assert.doesNotMatch(text, /0000000000005|PRIVATE|overall success|automatic retry will/i);
});
test("collapsed worker report stages and categories are fixed metadata, never raw error or prototype labels", () => {
  for (const stage of ["model_loading", "model_request", "internal_report", "accounting", "cleanup"]) {
    const text = delegateResultView({ details: { status: "failed", error: "PRIVATE_RAW_ERROR", metrics: { worker: { modelCalls: 1,
      diagnostic: { category: "authentication", httpStatus: 401, stage }, accounting: { status: "reported", complete: false } } } } }, view).text;
    assert.match(text, /Check authentication/); assert.match(text, /HTTP 401/); assert.match(text, /Worker SDK 1/); assert.doesNotMatch(text, /PRIVATE/);
  }
  assert.doesNotMatch(delegateResultView({ details: { status: "failed", metrics: { worker: { diagnostic: { category: "PRIVATE", stage: "constructor", httpStatus: 999 } } } } }, view).text, /PRIVATE|constructor|999/);
});
test("Doctor last reads only the fixed cached receipt and no transcript, model, process or execution", async () => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1]; const notices: string[] = [];
  const harness: NativeExecutionHarness = { isBusy: () => false, blockedReason: () => undefined, cancel: async () => assert.fail("No cancellation"),
    run: async () => assert.fail("No run"), lastFailure: () => "FIXED_CACHED_FAILURE" };
  registerOnboarding({ on() {}, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI, harness);
  const ctx = { get sessionManager(): never { throw Error("No transcript"); }, ui: { notify: (text: string) => { notices.push(text); } } } as unknown as ExtensionCommandContext;
  await command.handler("doctor last", ctx); assert.match(notices.at(-1)!, /FIXED_CACHED_FAILURE/);
});
test("basic and Doctor commands do not let the preparation watchdog cancel a human approval wait", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  for (const action of ['run {"agent":"scout","task":"Read the approved sample.","files":[{"path":"sample.txt","access":"read"}]}',
    'doctor run {"agent":"scout","file":"sample.txt"}']) {
    let command!: Parameters<ExtensionAPI["registerCommand"]>[1], signal: AbortSignal | undefined;
    let ready!: () => void, reply!: () => void, settled = false;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const result = { kind: "ordinary_scope", status: "stopped", taskAcceptance: "needs_human_review", workersStarted: 0, modelCalls: 0,
      reservedModelCalls: 0, cleanupConfirmed: true, lockRetained: false, reports: [], reason: "declined", diagnostic: { phase: "awaiting_approval" } } as unknown as OrdinaryPublicResult;
    const harness: NativeExecutionHarness = { isBusy: () => false, blockedReason: () => undefined, lastFailure: () => undefined,
      cancel: async () => {}, run: async (input, _ctx, current, progress) => {
        assert.equal(input.limits.seconds, action.startsWith("doctor") ? 60 : 86_400);
        signal = current; progress?.("preparing"); progress?.("awaiting_approval"); ready();
        return await new Promise<OrdinaryPublicResult>(resolve => { reply = () => resolve(result); });
      } };
    registerOnboarding({ on() {}, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI, harness);
    const ctx = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "fixture-session" }, ui: { notify() {} } } as unknown as ExtensionCommandContext;
    const work = command.handler(action, ctx).then(() => { settled = true; });
    await waiting; t.mock.timers.tick(86_400_000); await Promise.resolve();
    assert.equal(signal?.aborted, false); assert.equal(settled, false);
    reply(); await work;
  }
});

test("Doctor run shares native harness, reports incomplete execution, and invalid private args do not start it", async () => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1], started = 0; const notices: string[] = [];
  const result = { kind: "ordinary_scope", status: "stopped", taskAcceptance: "needs_human_review", workersStarted: 0, modelCalls: 0,
    reservedModelCalls: 0, cleanupConfirmed: true, lockRetained: false, reports: [], reason: "declined", diagnostic: { phase: "awaiting_approval" } } as unknown as OrdinaryPublicResult;
  const harness: NativeExecutionHarness = { isBusy: () => false, blockedReason: () => undefined, lastFailure: () => undefined, cancel: async () => {}, run: async input => {
    started++; assert.deepEqual(input, scope); return result;
  } };
  registerOnboarding({ on() {}, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI, harness);
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "fixture-session" }, ui: { notify: (text: string) => { notices.push(text); } } } as unknown as ExtensionCommandContext;
  await command.handler("doctor run PRIVATE_INPUT", ctx); assert.equal(started, 0); assert.ok(!notices.at(-1)!.includes("PRIVATE_INPUT"));
  await command.handler('doctor run {"agent":"scout","file":"sample.txt"}', ctx); assert.equal(started, 1); assert.match(notices.at(-1)!, /Execution path incomplete/);
  assert.match(doctorRunText(result), /Positive exact-source approval unconfirmed/);
});

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import cp from "node:child_process";
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { startApprovalUi, reduceApprovalUi, approvalUiText, approvalUiViewText, type ApprovalUiDiagnostic } from "../src/approval-ui-diagnostics.ts";
import { approvalUiDiagnostics } from "../src/approval-ui-diagnostics-effects.ts";
import { confirmContextPacket } from "../src/context-approval.ts";
import { runUiProbe, registerUiProbe, UI_PROBE_CUSTOM_MESSAGE } from "../src/ui-probe-effects.ts";
import { UI_PROBE_TIMEOUT_MS, uiProbeText } from "../src/ui-probe.ts";
import { registerOnboarding } from "../src/onboarding.ts";

type View = { render(width: number): string[]; handleInput(data: string): void; dispose(): void;
  children: { getExpandedText?(): string }[] };
function context(t: TestContext) {
  initTheme("dark", false);
  let view: View | undefined, session = "PRIVATE_SESSION", closed = 0;
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => session },
    get model(): never { throw new Error("No model access"); }, get modelRegistry(): never { throw new Error("No auth or catalog access"); },
    ui: { confirm: async () => assert.fail("No confirm fallback"), select: async () => assert.fail("No select fallback"), notify() {},
      custom: async (factory: (...args: unknown[]) => unknown) => await new Promise(resolve => {
        view = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, {}, { matches: () => false }, (value: boolean) => {
          closed++; resolve(value); view?.dispose();
        }) as View;
      }) } } as unknown as ExtensionContext;
  const http = t.mock.method(globalThis, "fetch", async () => assert.fail("No HTTP"));
  const fork = t.mock.method(cp, "fork", () => assert.fail("No worker"));
  return { ctx, http, fork, get view() { assert.ok(view); return view; }, get closes() { return closed; }, changeSession() { session = "PRIVATE_CHANGED"; } };
}
test("pure view stages are monotonic, idempotent, bounded, custom-only and never approval or rendering proof", () => {
  const original = startApprovalUi(100, 15100, "tui");
  assert.strictEqual(reduceApprovalUi(original, { type: "view", stage: "factory_called", now: 101 }), original);
  let state = reduceApprovalUi(original, { type: "request", now: 101, step: "packet", api: "custom" });
  const before = structuredClone(state);
  for (const stage of ["factory_called", "constructed", "rendered", "input_received", "submitted", "completion_requested"] as const) {
    state = reduceApprovalUi(state, { type: "view", stage, now: 102 });
    assert.equal(state.diagnostic.viewStage, stage); assert.equal(state.diagnostic.status, "waiting"); assert.equal(state.diagnostic.executionAuthorized, false);
    assert.strictEqual(reduceApprovalUi(state, { type: "view", stage, now: 103 }), state);
  }
  assert.equal(before.diagnostic.viewStage, "not_observed");
  assert.strictEqual(reduceApprovalUi(state, { type: "view", stage: "constructed", now: 104 }), state);
  assert.strictEqual(reduceApprovalUi(state, { type: "view", stage: "rendered", now: 15100 }), state);
  const done = reduceApprovalUi(state, { type: "finish", status: "expired", now: 15100 });
  assert.strictEqual(reduceApprovalUi(done, { type: "view", stage: "completion_requested", now: 15101 }), done);
  assert.match(approvalUiViewText(done.diagnostic)!, /physical visibility unproven/);
});
test("view projection accepts old serialized diagnostics but rejects private getters/coercion/unknown stages", () => {
  const valid = startApprovalUi(100, 15100, "tui").diagnostic;
  const { viewStage: _stage, ...old } = valid; assert.ok(approvalUiText(old)); assert.equal(approvalUiViewText(old), undefined);
  for (const value of ["PRIVATE_VIEW", {}, true, 1, { toString(): never { throw new Error("Never coerce"); } }]) {
    assert.equal(approvalUiViewText({ ...valid, viewStage: value }), undefined); assert.equal(approvalUiText({ ...valid, viewStage: value }), undefined);
  }
  const input = { ...valid }; Object.defineProperty(input, "viewStage", { get(): never { throw new Error("PRIVATE_GETTER"); } });
  assert.equal(approvalUiViewText(input), undefined); assert.equal(approvalUiText(input), undefined);
});
test("repeated render/input observations cannot cause an observer-driven render loop or authorize", () => {
  const records: ApprovalUiDiagnostic[] = [], d = approvalUiDiagnostics(Date.now() + 15000, "tui", value => { records.push(value); });
  d.request("packet", "custom"); d.view("factory_called"); d.view("constructed"); d.view("rendered");
  const count = records.length; for (let i = 0; i < 100; i++) d.view("rendered"); assert.equal(records.length, count);
  d.view("input_received"); d.view("rendered"); d.view("submitted"); d.view("completion_requested"); d.finish("expired");
  const ended = records.length; d.view("completion_requested"); assert.equal(records.length, ended);
  assert.ok(records.every(value => value.executionAuthorized === false));
});
test("exact TUI shows distinct factory/construction/render/input/submission/completion observations without content", async t => {
  const f = context(t), records: ApprovalUiDiagnostic[] = [];
  const work = confirmContextPacket(f.ctx, "Synthetic", "PRIVATE_PACKET_AND_ROLE", Date.now() + 15000, t.signal, "diagnostic", value => { records.push(value); });
  assert.equal(records.at(-1)?.viewStage, "constructed"); f.view.render(80); f.view.render(17); f.view.handleInput("\r");
  assert.equal(await work, true); const stages = records.map(value => value.viewStage);
  for (const stage of ["factory_called", "constructed", "rendered", "input_received", "submitted", "completion_requested"]) assert.ok(stages.includes(stage as ApprovalUiDiagnostic["viewStage"]));
  assert.equal(records.filter(value => value.viewStage === "rendered").length, 1); assert.equal(records.at(-1)?.replies, 1);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE/); assert.equal(f.closes, 1); assert.equal(f.http.mock.callCount(), 0); assert.equal(f.fork.mock.callCount(), 0);
});
test("no-factory, constructed-but-unrendered and rendered-but-no-input timeouts remain distinct without a task retry", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-12T00:00:00Z") });
  for (const expected of ["not_observed", "constructed", "rendered"] as const) {
    const f = context(t); let calls = 0;
    if (expected === "not_observed") f.ctx.ui.custom = (async () => { calls++; return await new Promise(() => {}); }) as ExtensionContext["ui"]["custom"];
    const work = runUiProbe("custom", f.ctx, t.signal);
    if (expected === "rendered") f.view.render(80);
    t.mock.timers.tick(UI_PROBE_TIMEOUT_MS); const result = await work;
    assert.equal(result.status, "no_reply_timeout"); assert.equal(result.approvalUi?.viewStage, expected);
    assert.equal(result.executionAuthorized, false); assert.equal(result.modelWorkerJevCalls, 0); assert.ok(calls <= 1 && f.closes <= 1);
    assert.doesNotMatch(JSON.stringify(result) + uiProbeText(result), /PRIVATE|PRIVATE_PACKET/);
  }
});
test("custom probe displays only the fixed synthetic packet and never gives task or transmission authority", async t => {
  const f = context(t), work = runUiProbe("custom", f.ctx, t.signal);
  const editor = f.view.children.find(child => child.getExpandedText); assert.equal(editor?.getExpandedText!(), UI_PROBE_CUSTOM_MESSAGE);
  f.view.render(80); f.view.handleInput("\r"); const result = await work;
  assert.equal(result.kind, "custom"); assert.equal(result.status, "positive_reply"); assert.equal(result.approvalUi?.viewStage, "completion_requested");
  assert.equal(result.executionAuthorized, false); assert.equal(result.modelWorkerJevCalls, 0); assert.equal(f.closes, 1);
  assert.match(uiProbeText(result), /do not prove physical terminal visibility or execution approval/); assert.equal(f.http.mock.callCount(), 0); assert.equal(f.fork.mock.callCount(), 0);
});
test("custom diagnostic never tries a non-TUI host or treats a bare custom true as a positive receipt", async t => {
  const f = context(t); const custom = t.mock.method(f.ctx.ui, "custom", (async () => true) as ExtensionContext["ui"]["custom"]);
  const result = await runUiProbe("custom", f.ctx, t.signal); assert.equal(result.status, "invalid_reply"); assert.equal(result.executionAuthorized, false);
  for (const mode of ["print", "rpc"] as const) {
    Object.assign(f.ctx, { mode });
    assert.equal((await runUiProbe("custom", f.ctx, t.signal)).status, "unsupported");
  }
  assert.equal(custom.mock.callCount(), 1);
});
test("custom diagnostic API errors and session changes are fixed metadata, not fallback or raw errors", async t => {
  const f = context(t); f.ctx.ui.custom = (async () => { throw new Error("PRIVATE_UI_CAUSE"); }) as ExtensionContext["ui"]["custom"];
  const error = await runUiProbe("custom", f.ctx, t.signal); assert.equal(error.status, "api_error"); assert.doesNotMatch(JSON.stringify(error) + uiProbeText(error), /PRIVATE/);
  const changed = context(t), work = runUiProbe("custom", changed.ctx, t.signal); changed.changeSession(); changed.view.handleInput("\r");
  assert.equal((await work).status, "session_changed");
});
test("custom diagnostic owns one interaction and every lifecycle cancellation without touching an existing setup/task", async t => {
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "before_agent_start", "session_shutdown"]) {
    const hooks = new Map<string, () => void>(), probe = registerUiProbe({ on(name: string, fn: () => void) { hooks.set(name, fn); } } as unknown as ExtensionAPI), f = context(t);
    assert.equal((await probe("custom", f.ctx, true)).requestStarted, false);
    const work = probe("custom", f.ctx); assert.equal((await probe("custom", f.ctx)).status, "busy");
    hooks.get(event)!(); assert.equal((await work).status, "cancelled"); assert.equal(f.closes, 1);
  }
});
test("explicit custom command shares the native exact editor; malformed private arguments never echo or open UI", async t => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1]; const messages: string[] = [];
  registerOnboarding({ on() {}, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI);
  const f = context(t); f.ctx.ui.notify = text => { messages.push(text); };
  await command.handler("ui-test custom PRIVATE_ARG", f.ctx as ExtensionCommandContext);
  assert.ok(messages.every(value => !value.includes("PRIVATE_ARG")));
  const work = command.handler("ui-test custom", f.ctx as ExtensionCommandContext); f.view.render(80); f.view.handleInput("\r"); await work;
  assert.match(messages.at(-1)!, /SDK completion requested/); assert.doesNotMatch(messages.at(-1)!, /PRIVATE/);
  assert.ok((await command.getArgumentCompletions?.("ui-test c"))?.some(value => value.value === "ui-test custom"));
});

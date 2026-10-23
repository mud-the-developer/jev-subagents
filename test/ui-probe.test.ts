import assert from "node:assert/strict";
import cp from "node:child_process";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { reduceUiProbe, UI_PROBE_TIMEOUT_MS, uiProbeText } from "../src/ui-probe.ts";
import { registerUiProbe, runUiProbe, UI_PROBE_MESSAGE, UI_PROBE_SELECTION, UI_PROBE_TITLE } from "../src/ui-probe-effects.ts";
import { registerOnboarding } from "../src/onboarding.ts";
function fixture() {
  let id = "synthetic-session-a", idle = true;
  const ctx = { mode: "print", hasUI: true, isIdle: () => idle, sessionManager: { getSessionId: () => id },
    get model(): never { throw new Error("No model access"); }, get modelRegistry(): never { throw new Error("No registry or auth access"); },
    ui: { confirm: async () => true, select: async () => UI_PROBE_SELECTION, notify() {} } } as unknown as ExtensionContext;
  return { ctx, changeSession: () => { id = "synthetic-session-b"; }, makeBusy: () => { idle = false; } };
}
test("pure UI diagnostic states are immutable, bounded, and cannot grant or revive after completion", () => {
  const idle = { phase: "idle" } as const, start = { type: "start", kind: "confirm", now: 100, supported: true, busy: false, cancelled: false } as const;
  const state = reduceUiProbe(idle, start); assert.equal(state.phase, "waiting"); assert.deepEqual(idle, { phase: "idle" });
  const requested = reduceUiProbe(state, { type: "request", now: 101 });
  const ended = reduceUiProbe(requested, { type: "finish", now: 100 + UI_PROBE_TIMEOUT_MS, status: "positive_reply" });
  assert.equal(ended.phase, "done"); if (ended.phase !== "done") return;
  assert.equal(ended.result.status, "no_reply_timeout"); assert.equal(ended.result.executionAuthorized, false);
  assert.equal(ended.result.requestStarted, true); assert.equal(ended.result.modelWorkerJevCalls, 0);
  assert.strictEqual(reduceUiProbe(ended, { type: "finish", now: 16000, status: "positive_reply" }), ended);
  assert.strictEqual(reduceUiProbe(idle, { ...start, now: NaN }), idle);
});
test("confirm requests one public synthetic packet and real signal, without model/HTTP/worker/UI fallback or authority", async t => {
  const f = fixture(); const confirm = t.mock.method(f.ctx.ui, "confirm", async () => true);
  const select = t.mock.method(f.ctx.ui, "select", async () => assert.fail("No alternate UI"));
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("No HTTP"));
  const fork = t.mock.method(cp, "fork", () => assert.fail("No process"));
  const result = await runUiProbe("confirm", f.ctx, t.signal);
  assert.equal(result.status, "positive_reply"); assert.equal(result.executionAuthorized, false);
  assert.equal(confirm.mock.callCount(), 1); assert.equal(select.mock.callCount(), 0);
  const [title, message, options] = confirm.mock.calls[0]!.arguments;
  assert.equal(title, UI_PROBE_TITLE); assert.equal(message, UI_PROBE_MESSAGE);
  assert.ok(options!.signal instanceof AbortSignal); assert.ok(options!.signal!.aborted);
  assert.ok(options!.timeout! > 0 && options!.timeout! <= UI_PROBE_TIMEOUT_MS);
  assert.equal(fetch.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(result) + uiProbeText(result), /synthetic-session|PRIVATE|approval complete|task complete/i);
});
test("select accepts only the exact diagnostic literal; negatives and malformed replies never echo input or authorize", async t => {
  for (const value of [UI_PROBE_SELECTION, undefined, "Cancel / no execution", "PRIVATE_PATH_KEY_REPLY"]) {
    const f = fixture(), select = t.mock.method(f.ctx.ui, "select", async () => value);
    const result = await runUiProbe("select", f.ctx, t.signal);
    assert.equal(result.status, value === UI_PROBE_SELECTION ? "positive_reply" : value === "PRIVATE_PATH_KEY_REPLY" ? "invalid_reply" : "non_positive_reply");
    assert.equal(result.executionAuthorized, false); assert.equal(select.mock.callCount(), 1);
    assert.doesNotMatch(JSON.stringify(result) + uiProbeText(result), /PRIVATE_PATH_KEY_REPLY/);
  }
});
test("negative confirm is not alleged to be an explicit human decline or a successful GUI display", async t => {
  const f = fixture(); t.mock.method(f.ctx.ui, "confirm", async () => false);
  const result = await runUiProbe("confirm", f.ctx, t.signal);
  assert.equal(result.status, "non_positive_reply"); assert.match(uiProbeText(result), /not distinguished/);
  assert.equal(result.executionAuthorized, false);
});
test("own deadline bounds an unresponsive host; timed-out or late positives never become execution approval", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-12T00:00:00Z") });
  const f = fixture(); let respond!: (value: boolean) => void;
  const confirm = t.mock.method(f.ctx.ui, "confirm", () => new Promise<boolean>(resolve => { respond = resolve; }));
  const work = runUiProbe("confirm", f.ctx, t.signal); t.mock.timers.tick(UI_PROBE_TIMEOUT_MS);
  const result = await work; assert.equal(result.status, "no_reply_timeout"); assert.equal(result.elapsedMs, UI_PROBE_TIMEOUT_MS);
  assert.equal(result.requestStarted, true); respond(true); await Promise.resolve();
  assert.equal(result.status, "no_reply_timeout"); assert.equal(confirm.mock.callCount(), 1); assert.equal(result.executionAuthorized, false);
});
test("pre-cancel, busy and unsupported do not start a native request or gather session/model metadata", async t => {
  const f = fixture(), cancelled = new AbortController(); cancelled.abort();
  const confirm = t.mock.method(f.ctx.ui, "confirm", async () => assert.fail("No request"));
  const getId = t.mock.method(f.ctx.sessionManager, "getSessionId", () => assert.fail("No session metadata"));
  const pre = await runUiProbe("confirm", f.ctx, cancelled.signal); assert.equal(pre.status, "cancelled"); assert.equal(pre.requestStarted, false);
  const busy = await runUiProbe("confirm", f.ctx, t.signal, true); assert.equal(busy.status, "busy"); assert.equal(busy.requestStarted, false);
  const unsupported = Object.create(f.ctx) as ExtensionContext; Object.defineProperty(unsupported, "hasUI", { value: false });
  const noUi = await runUiProbe("confirm", unsupported, t.signal);
  assert.equal(noUi.status, "unsupported"); assert.equal(noUi.requestStarted, false);
  assert.equal(getId.mock.callCount(), 0); assert.equal(confirm.mock.callCount(), 0);
});
test("throwing or rejected UI APIs produce only a fixed error status and no alternate dialog", async t => {
  for (const synchronous of [true, false]) {
    const f = fixture(); const confirm = t.mock.method(f.ctx.ui, "confirm", () => {
      if (synchronous) throw new Error("PRIVATE_UI_ERROR"); return Promise.reject(new Error("PRIVATE_UI_ERROR"));
    });
    const select = t.mock.method(f.ctx.ui, "select", async () => assert.fail("No fallback"));
    const result = await runUiProbe("confirm", f.ctx, t.signal);
    assert.equal(result.status, "api_error"); assert.equal(confirm.mock.callCount(), 1); assert.equal(select.mock.callCount(), 0);
    assert.doesNotMatch(JSON.stringify(result) + uiProbeText(result), /PRIVATE_UI_ERROR/);
  }
});
test("session change rejects a late positive reply without restoring authority", async t => {
  const f = fixture(); let respond!: (value: boolean) => void;
  t.mock.method(f.ctx.ui, "confirm", () => new Promise<boolean>(resolve => { respond = resolve; }));
  const work = runUiProbe("confirm", f.ctx, t.signal); f.changeSession(); respond(true);
  const result = await work; assert.equal(result.status, "session_changed"); assert.equal(result.executionAuthorized, false);
});
test("diagnostic owner denies overlap and cancels on every lifecycle boundary without retry", async t => {
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "before_agent_start", "session_shutdown"]) {
    const hooks = new Map<string, () => void>(), probe = registerUiProbe({ on(name: string, fn: () => void) { hooks.set(name, fn); } } as unknown as ExtensionAPI);
    const f = fixture(); const confirm = t.mock.method(f.ctx.ui, "confirm", () => new Promise<boolean>(() => {}));
    const setupBusy = await probe("confirm", f.ctx, true); assert.equal(setupBusy.status, "busy");
    assert.equal(setupBusy.requestStarted, false); assert.equal(confirm.mock.callCount(), 0);
    const work = probe("confirm", f.ctx); assert.equal((await probe("select", f.ctx)).status, "busy");
    hooks.get(event)!(); const result = await work;
    assert.equal(result.status, "cancelled"); assert.equal(confirm.mock.callCount(), 1); assert.equal(result.executionAuthorized, false);
  }
});
test("command help and invalid arguments remain informational; explicit confirm is the only dialog request", async t => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1]; const notices: string[] = [];
  registerOnboarding({ on() {}, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI);
  const f = fixture(); t.mock.method(f.ctx.ui, "notify", (text: string) => { notices.push(text); });
  const confirm = t.mock.method(f.ctx.ui, "confirm", async () => true), select = t.mock.method(f.ctx.ui, "select", async () => assert.fail("No picker or discovery"));
  for (const input of ["ui-test", "ui-test unknown PRIVATE_ARG", "ui-test confirm extra"]) await command.handler(input, f.ctx as ExtensionCommandContext);
  assert.equal(confirm.mock.callCount(), 0); assert.equal(select.mock.callCount(), 0); assert.ok(notices.every(text => !text.includes("PRIVATE_ARG")));
  await command.handler("ui-test confirm", f.ctx as ExtensionCommandContext);
  assert.equal(confirm.mock.callCount(), 1); assert.equal(select.mock.callCount(), 0); assert.match(notices.at(-1)!, /standalone UI diagnostic/);
  const empty = await command.getArgumentCompletions?.(""); assert.equal(empty?.length, 4);
  const ui = await command.getArgumentCompletions?.("ui"); assert.ok(ui?.some(item => item.value === "ui-test confirm"));
});

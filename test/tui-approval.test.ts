import assert from "node:assert/strict";
import cp from "node:child_process";
import { test, type TestContext } from "node:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmContextPacket } from "../src/context-approval.ts";
import type { ApprovalUiDiagnostic, ApprovalUiObserver } from "../src/approval-ui-diagnostics.ts";

const packet = "  EXACT SYNTHETIC READ-ONLY SCOPE\nNo tools or execution from this fixture.\n ";
type View = { children: { getExpandedText?(): string; setText?(value: string): void }[];
  render(width: number): string[]; handleInput(data: string): void; dispose(): void };
function fixture(t: TestContext) {
  initTheme("dark", false);
  const diagnostics: ApprovalUiDiagnostic[] = [];
  const observer: ApprovalUiObserver = value => { diagnostics.push(value); };
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, t.signal]);
  t.after(() => controller.abort());
  let session = "synthetic-session", closes = 0;
  let view: View | undefined, requestedValue: boolean | undefined;
  let sdkResolve: (value: boolean) => void = () => {}, sdkReject: (reason: Error) => void = () => {};
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => session }, ui: {
    confirm: async () => assert.fail("No native confirm fallback"),
    custom: async (factory: (...args: unknown[]) => unknown) => await new Promise<boolean>((resolve, reject) => {
      sdkResolve = resolve; sdkReject = reject;
      const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
      const keys = { matches: (data: string, action: string) => action === "app.editor.external" && data === String.fromCharCode(7) };
      view = factory(tui, {}, keys, (value: boolean) => { closes++; requestedValue = value; }) as View;
    }),
  } } as unknown as ExtensionContext;
  const http = t.mock.method(globalThis, "fetch", async () => assert.fail("No HTTP"));
  const fork = t.mock.method(cp, "fork", () => assert.fail("No worker"));
  return { ctx, controller, diagnostics, observer, http, fork, setSession(value: string) { session = value; },
    get view() { assert.ok(view); return view; }, get closes() { return closes; }, get requestedValue() { return requestedValue; },
    resolve(value: boolean) { sdkResolve(value); }, reject() { sdkReject(new Error("PRIVATE_UI_CAUSE")); },
    run(deadline: number | null = Date.now() + 60000, reviewText?: string) { return confirmContextPacket(ctx, "Synthetic exact approval", packet, deadline, signal, "approval", observer, reviewText); } };
}
function assertSafe(diagnostics: readonly ApprovalUiDiagnostic[]) {
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE|SYNTHETIC|synthetic-session|packet"\s*:/);
  for (const row of diagnostics) { assert.equal(row.executionAuthorized, false); assert.ok(Object.isFrozen(row)); }
}

test("TUI readable review requires its exact unchanged buffer and the SDK literal receipt", async t => {
  const text = 'JEV · 읽기 작업 승인서\n모델 · fixture\n실행 시간 · 승인 후 10분 (600초)\n\n── 실제 원문 ──\nRead "two words" exactly.\n';
  const f = fixture(t), work = f.run(null, text);
  const editor = f.view.children.find(child => child.getExpandedText); assert.ok(editor);
  assert.equal(editor.getExpandedText!(), text); assert.notEqual(editor.getExpandedText!(), packet);
  assert.ok(f.view.render(80).length > 0); f.view.handleInput("\r");
  assert.equal(f.requestedValue, true); f.resolve(true); assert.equal(await work, true);
  assertSafe(f.diagnostics); assert.equal(f.http.mock.callCount(), 0); assert.equal(f.fork.mock.callCount(), 0);
});
test("TUI altered readable review or replacement with raw JSON cannot approve", async t => {
  for (const replacement of ["Readable review ", packet]) {
    const f = fixture(t), work = f.run(null, "Readable review"), editor = f.view.children.find(child => child.getExpandedText && child.setText);
    assert.ok(editor); editor.setText!(replacement); assert.equal(editor.getExpandedText!(), replacement); f.view.handleInput("\r");
    assert.equal(f.requestedValue, false); f.resolve(true); assert.equal(await work, false); assertSafe(f.diagnostics);
  }
});

test("TUI custom positive without constructing the exact editor cannot approve", async t => {
  const f = fixture(t); f.ctx.ui.custom = (async () => true) as ExtensionContext["ui"]["custom"];
  assert.equal(await f.run(), false); assert.equal(f.diagnostics.at(-1)?.status, "invalid_reply"); assertSafe(f.diagnostics);
});
test("TUI constructed view without unchanged submission cannot approve from a positive SDK value", async t => {
  const f = fixture(t), work = f.run();
  assert.ok(f.view.render(80).length > 0); f.resolve(true);
  assert.equal(await work, false); assert.equal(f.diagnostics.at(-1)?.status, "invalid_reply"); assertSafe(f.diagnostics);
});
test("TUI exact submission waits for the SDK literal receipt, records one return and tolerates normal disposal", async t => {
  const f = fixture(t); let settled = false;
  const work = f.run().then(value => { settled = true; return value; });
  const editor = f.view.children.find(child => child.getExpandedText); assert.ok(editor);
  assert.equal(editor.getExpandedText!(), packet); f.view.handleInput(String.fromCharCode(7)); assert.equal(editor.getExpandedText!(), packet);
  f.view.handleInput("\r"); assert.equal(f.requestedValue, true); assert.equal(f.closes, 1);
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  assert.equal(settled, false, "User submission alone is not the SDK result");
  f.view.dispose(); f.resolve(true); assert.equal(await work, true); assert.equal(f.closes, 1);
  const final = f.diagnostics.at(-1)!; assert.equal(final.status, "positive_reply"); assert.equal(final.requests, 1); assert.equal(final.replies, 1);
  assert.equal(f.http.mock.callCount(), 0); assert.equal(f.fork.mock.callCount(), 0); assertSafe(f.diagnostics);
});
test("TUI changed expanded buffer refuses even trim-equivalent submission and a forged positive receipt", async t => {
  for (const suffix of [" ", "UNAPPROVED"]) {
    const f = fixture(t), work = f.run(), editor = f.view.children.find(child => child.getExpandedText && child.setText);
    assert.ok(editor); editor.setText!(packet + suffix); f.view.handleInput("\r"); assert.equal(f.requestedValue, false);
    f.resolve(true); assert.equal(await work, false); assert.equal(f.diagnostics.at(-1)?.status, "invalid_reply"); assertSafe(f.diagnostics);
  }
});
test("TUI exact submission followed by SDK refusal or rejection denies without another close or fallback", async t => {
  for (const rejected of [false, true]) {
    const f = fixture(t), work = f.run(); f.view.handleInput("\r"); assert.equal(f.requestedValue, true);
    if (rejected) f.reject(); else f.resolve(false);
    assert.equal(await work, false); assert.equal(f.closes, 1);
    assert.equal(f.diagnostics.at(-1)?.status, rejected ? "api_error" : "non_positive_reply"); assertSafe(f.diagnostics);
  }
});
test("TUI exact submission followed by lifecycle abort never publishes an earlier positive result", async t => {
  const f = fixture(t), work = f.run(); f.view.handleInput("\r"); f.controller.abort();
  assert.equal(await work, false); assert.equal(f.diagnostics.at(-1)?.status, "cancelled");
  const count = f.diagnostics.length; f.resolve(true); await Promise.resolve(); assert.equal(f.diagnostics.length, count); assert.equal(f.closes, 1);
});
test("TUI exact submission followed by session change or session-read uncertainty denies", async t => {
  for (const throws of [false, true]) {
    const f = fixture(t), work = f.run(); f.view.handleInput("\r");
    if (throws) Object.assign(f.ctx.sessionManager, { getSessionId: () => { throw new Error("PRIVATE_SESSION_CAUSE"); } });
    else f.setSession("changed-session");
    f.resolve(true); assert.equal(await work, false); assert.equal(f.diagnostics.at(-1)?.status, "session_changed"); assertSafe(f.diagnostics);
  }
});
test("TUI Esc and abandoned view disposal consume one negative close and never a later true", async t => {
  for (const disposed of [false, true]) {
    const f = fixture(t), work = f.run(); if (disposed) f.view.dispose(); else f.view.handleInput("\u001b");
    assert.equal(await work, false); assert.equal(f.requestedValue, false); assert.equal(f.closes, 1);
    const count = f.diagnostics.length; f.resolve(true); await Promise.resolve(); assert.equal(f.diagnostics.length, count); assertSafe(f.diagnostics);
  }
});
test("unbounded TUI approval waits for both unchanged submission and the SDK receipt, without elapsed-time cancellation", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture(t); let settled = false;
  const work = f.run(null).then(value => { settled = true; return value; });
  assert.ok(f.view.render(80).length > 0);
  t.mock.timers.tick(86_400_000); await Promise.resolve(); assert.equal(settled, false); assert.equal(f.closes, 0);
  f.view.handleInput("\r"); assert.equal(f.requestedValue, true);
  t.mock.timers.tick(86_400_000); await Promise.resolve(); assert.equal(settled, false);
  f.view.dispose(); f.resolve(true); assert.equal(await work, true);
  assert.equal(f.diagnostics.at(-1)?.remainingMs, null); assert.equal(f.diagnostics.at(-1)?.status, "positive_reply");
  assertSafe(f.diagnostics);
});

test("TUI explicit diagnostic deadline covers the constructed view and post-submission SDK wait without revival", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-12T00:00:00Z") });
  for (const submitted of [false, true]) {
    const f = fixture(t), work = f.run(); if (submitted) f.view.handleInput("\r");
    t.mock.timers.tick(60000); assert.equal(await work, false); assert.equal(f.diagnostics.at(-1)?.status, "expired");
    assert.equal(f.closes, 1); const count = f.diagnostics.length; f.resolve(true); await Promise.resolve(); assert.equal(f.diagnostics.length, count);
  }
});
test("TUI close callback failure is fixed api_error with no duplicate closing or private echo", async t => {
  const f = fixture(t);
  f.ctx.ui.custom = (async (factory: (...args: unknown[]) => unknown) => {
    const view = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, {}, { matches: () => false }, () => { throw new Error("PRIVATE_CLOSE_CAUSE"); }) as View;
    view.handleInput("\r"); return true;
  }) as ExtensionContext["ui"]["custom"];
  assert.equal(await f.run(), false); assert.equal(f.diagnostics.at(-1)?.status, "api_error"); assertSafe(f.diagnostics);
});
test("TUI requires a current non-empty session identity before constructing the native view", async t => {
  for (const id of ["", undefined]) {
    const f = fixture(t); Object.assign(f.ctx.sessionManager, { getSessionId: () => id });
    assert.equal(await f.run(), false); assert.equal(f.diagnostics.at(-1)?.requests, 0);
  }
});

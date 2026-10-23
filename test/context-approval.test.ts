import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canConfirmContextPacket, confirmContextPacket } from "../src/context-approval.ts";

const packet = "  EXACT\n작업·모델·도구·파일·예산\n{\"scope\":\"synthetic-only\"}\n ";
function context(mode: "rpc" | "print" | "tui" = "print") {
  return { mode, hasUI: true, sessionManager: { getSessionId: () => "same-session" }, ui: {
    confirm: async () => true,
    custom: async () => { throw new Error("unsupported custom UI must not run in GUI/RPC"); },
  } } as unknown as ExtensionContext;
}

test("readable native projection is human-only and empty or oversized projections fail before UI", async () => {
  const ctx = context("rpc"), text = '모델 · fixture\n실행 시간 · 승인 후 10분\n\nRead "two words".\n'; let calls = 0;
  ctx.ui.confirm = async (_title, message) => { calls++; assert.equal(message, text); assert.notEqual(message, packet); return true; };
  assert.equal(await confirmContextPacket(ctx, "Scope", packet, null, new AbortController().signal, "approval", undefined, text), true);
  for (const invalid of ["", " ", "x".repeat(262145)])
    assert.equal(await confirmContextPacket(ctx, "Scope", packet, null, new AbortController().signal, "approval", undefined, invalid), false);
  assert.equal(calls, 1);
});

test("GUI/print and RPC display the immutable whole packet before a literal true approval, never TUI/custom", async () => {
  for (const mode of ["print", "rpc"] as const) {
    const ctx = context(mode); let calls = 0;
    ctx.ui.confirm = async (title, text, options) => {
      calls++; assert.equal(text, packet); assert.match(title, /Review exact source/);
      assert.ok(options?.signal); assert.ok(options.timeout! > 0 && options.timeout! <= 60000);
      return true;
    };
    assert.equal(await confirmContextPacket(ctx, "Exact scope", packet, Date.now() + 60000, new AbortController().signal), true);
    assert.equal(calls, 1);
  }
});

test("unbounded GUI/RPC approval waits beyond a day, remains cancellable and never revives a consumed reply", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  for (const cancel of [false, true]) {
    const ctx = context("rpc"), controller = new AbortController();
    let reply!: (value: boolean) => void, requestSignal: AbortSignal | undefined, settled = false;
    ctx.ui.confirm = async (_title, text, options) => {
      assert.equal(text, packet); assert.equal(options?.timeout, undefined); requestSignal = options?.signal;
      return await new Promise<boolean>(resolve => { reply = resolve; });
    };
    const work = confirmContextPacket(ctx, "Scope", packet, null, controller.signal).then(value => { settled = true; return value; });
    t.mock.timers.tick(86_400_000); await Promise.resolve();
    assert.equal(settled, false); assert.equal(requestSignal?.aborted, false);
    if (cancel) controller.abort(); else reply(true);
    assert.equal(await work, !cancel); assert.equal(requestSignal?.aborted, true);
    reply(true); await Promise.resolve();
  }
});

test("Source-review purpose remains explicitly non-executing; false/nonliteral receipts cannot approve", async () => {
  const ctx = context(); let title = "";
  ctx.ui.confirm = async value => { title = value; return true; };
  assert.equal(await confirmContextPacket(ctx, "Source", packet, Date.now() + 60000, new AbortController().signal, "review"), true);
  assert.match(title, /Source review only \/ does not execute/);
  for (const value of [false, "true", 1, null, undefined]) {
    ctx.ui.confirm = async () => value as boolean;
    assert.equal(await confirmContextPacket(ctx, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  }
});

test("Native GUI throws or lacks confirm: denial without custom fallback; TUI failure never switches to confirm", async () => {
  const ctx = context(); ctx.ui.confirm = async () => { throw new Error("private-ui-error-must-not-surface"); };
  assert.equal(await confirmContextPacket(ctx, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  const missing = { ...ctx, ui: {} } as ExtensionContext;
  assert.equal(await confirmContextPacket(missing, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  const tui = context("tui"); let confirms = 0; tui.ui.confirm = async () => { confirms++; return true; };
  assert.equal(await confirmContextPacket(tui, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  assert.equal(confirms, 0);
});

test("GUI external abort and absolute timeout settle denial and close the same native request; late true cannot revive", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const timedOut of [false, true]) {
    const ctx = context(), external = new AbortController(); let requestSignal: AbortSignal | undefined, late: (value: boolean) => void = () => {};
    ctx.ui.confirm = async (_title, _text, opts) => { requestSignal = opts?.signal; return await new Promise(resolve => { late = resolve; }); };
    const pending = confirmContextPacket(ctx, "Scope", packet, Date.now() + 60000, external.signal);
    if (timedOut) t.mock.timers.tick(60001); else external.abort();
    assert.equal(await pending, false); assert.equal(requestSignal?.aborted, true); late(true);
  }
});

test("Session change/uncertainty while reviewing refuses even a literal true; no session reads are silently ignored", async () => {
  for (const throws of [false, true]) {
    const ctx = context(); let count = 0;
    Object.assign(ctx.sessionManager, { getSessionId: () => {
      if (++count === 1) return "original";
      if (throws) throw new Error("uncertain-session");
      return "changed";
    } });
    assert.equal(await confirmContextPacket(ctx, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  }
});

test("Managed availability uses the native capability, not presence of an unsupported TUI method", () => {
  const nativeOnly = { ...context(), ui: { confirm: async () => true } } as unknown as ExtensionContext;
  assert.equal(canConfirmContextPacket(nativeOnly), true);
  assert.equal(canConfirmContextPacket({ ...nativeOnly, mode: "tui" }), false);
  assert.equal(canConfirmContextPacket({ ...nativeOnly, hasUI: false }), false);
});

test("No UI, bad/expired deadline, already aborted, and unknown host mode open no approval", async () => {
  const ctx = context(); let calls = 0; ctx.ui.confirm = async () => { calls++; return true; };
  const abort = new AbortController(); abort.abort();
  for (const deadline of [NaN, Infinity, Date.now() - 1])
    assert.equal(await confirmContextPacket(ctx, "Scope", packet, deadline, new AbortController().signal), false);
  assert.equal(await confirmContextPacket(ctx, "Scope", packet, Date.now() + 60000, abort.signal), false);
  assert.equal(await confirmContextPacket({ ...ctx, hasUI: false }, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  assert.equal(await confirmContextPacket({ ...ctx, mode: "unknown" } as unknown as ExtensionContext, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  for (const sessionManager of [undefined, {}, { getSessionId: () => undefined }, { getSessionId: () => "" }])
    assert.equal(await confirmContextPacket({ ...ctx, sessionManager } as unknown as ExtensionContext, "Scope", packet, Date.now() + 60000, new AbortController().signal), false);
  assert.equal(calls, 0);
});

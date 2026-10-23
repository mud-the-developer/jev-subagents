import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPlanWidgets } from "../src/plan-widget.ts";
import type { PlanTheme, PlanView } from "../src/plan-presentation.ts";

const view: PlanView = { version: 3, phase: "running", elapsedMs: 1000, seconds: 60, modelCalls: 1,
  display: { maxDepth: 3, animations: true }, nodes: [
    { id: "a", title: "PRIVATE_TASK", kind: "task", after: [], state: "running", model: "offline/model", thinking: "high", modelCalls: 1 },
  ], edges: [] };
type Component = { render(width: number): string[]; invalidate(): void; dispose?(): void };
function fixture(t: TestContext, env: { NO_COLOR?: string; TERM?: string } = {}) {
  const previous = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM };
  for (const key of ["NO_COLOR", "TERM"] as const) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  t.after(() => { for (const key of ["NO_COLOR", "TERM"] as const) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  const timers = new Map<unknown, () => void>(), callbacks: (() => void)[] = [], intervals: number[] = [];
  const hooks = new Map<string, () => void>(), frames: string[][] = [], components: Component[] = [];
  let now = 100, mounts = 0, clears = 0, requests = 0, unrefs = 0, palette = 36;
  let component: Component | undefined, session = "session", failure = "";
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
    if (failure === "timer") throw new Error("Timer unavailable");
    const handle = { unref() { unrefs++; if (failure === "unref") throw new Error("Timer disposal race"); } } as unknown as ReturnType<typeof setInterval>;
    timers.set(handle, callback); callbacks.push(callback); intervals.push(ms); return handle;
  });
  t.mock.method(globalThis, "clearInterval", (handle: unknown) => { timers.delete(handle); });
  const theme: PlanTheme = {
    fg: (_tone, text) => { if (failure === "render") throw new Error("PRIVATE_UI_ERROR"); return `\u001b[${palette}m${text}\u001b[39m`; },
    bg: (_tone, text) => `\u001b[44m${text}\u001b[49m`, bold: text => `\u001b[1m${text}\u001b[22m`,
  };
  const render = () => { if (component) frames.push(component.render(80)); };
  const requestRender = () => { requests++; if (failure === "request") throw new Error("PRIVATE_UI_ERROR"); render(); };
  const context = { mode: "tui", hasUI: true, sessionManager: { getSessionId() {
    if (failure === "session") throw new Error("Stale session"); return session;
  } }, ui: {
    setWidget(_key: string, factory: ((tui: unknown, theme: PlanTheme) => Component) | undefined, options?: { placement: string }) {
      component?.dispose?.(); component = undefined;
      if (!factory) { clears++; if (failure === "clear") throw new Error("Closed UI"); return; }
      mounts++; assert.equal(options?.placement, "aboveEditor");
      if (failure === "mount") throw new Error("UI unavailable");
      if (failure === "ignored_factory") return;
      component = factory(failure === "missing_port" ? {} : { requestRender }, theme); components.push(component); render();
    },
  } };
  const open = registerPlanWidgets({ on(event: string, handler: () => void) { hooks.set(event, handler); } } as unknown as ExtensionAPI);
  const ctx = context as unknown as ExtensionContext;
  const advance = (count = 1) => { for (let i = 0; i < count; i++) { now += 120; [...timers.values()].forEach(callback => callback()); } };
  return { open, ctx, context, advance, timers, callbacks, intervals, hooks, frames, components, render,
    session: (value: string) => { session = value; }, failure: (value: string) => { failure = value; }, palette: (value: number) => { palette = value; },
    counts: () => ({ mounts, clears, requests, unrefs }),
  };
}

test("one native component per lease requests renders at ~8fps without streaming or changing observed statistics", t => {
  const f = fixture(t), panel = f.open(f.ctx);
  panel.update(view);
  assert.equal(f.counts().mounts, 1); assert.equal(f.timers.size, 1); assert.equal(f.counts().unrefs, 1);
  assert.ok(f.intervals.every(ms => ms >= 100 && ms <= 125));
  const initial = f.frames.at(-1)!;
  f.advance(10); assert.equal(f.counts().requests, 10); assert.equal(f.counts().mounts, 1); assert.equal(f.components.length, 1);
  assert.notDeepEqual(initial, f.frames[1]);
  panel.update({ ...view, modelCalls: 2 });
  assert.equal(f.counts().mounts, 1); assert.equal(f.timers.size, 1); assert.equal(f.counts().requests, 11);
  assert.match(f.frames.at(-1)!.map(stripVTControlCharacters).join("\n"), /OBSERVED SDK 2/);
  for (const frame of f.frames) assert.doesNotMatch(frame.join("\n"), /PRIVATE|%|\$|cleanup|systemPrompt|arguments/);
  panel.close(); assert.equal(f.timers.size, 0); assert.equal(f.counts().clears, 1);
  const before = f.counts(); f.callbacks.forEach(callback => callback()); panel.update(view); panel.close(); assert.deepEqual(f.counts(), before);
});

test("theme invalidation rebuilds fg/bg/bold colors on the mounted component, including reduced-motion widgets", t => {
  const f = fixture(t), panel = f.open(f.ctx);
  panel.update({ ...view, display: { animations: false } });
  const component = f.components[0]!, first = component.render(80);
  assert.ok(first.some(line => line.includes("\u001b[44m") && line.includes("\u001b[1m")));
  f.palette(35); component.invalidate(); f.render();
  const next = f.frames.at(-1)!;
  assert.notDeepEqual(next, first); assert.deepEqual(next.map(stripVTControlCharacters), first.map(stripVTControlCharacters));
  assert.ok(next.some(line => line.includes("\u001b[35m"))); assert.equal(f.counts().mounts, 1); assert.equal(f.timers.size, 0);
  panel.close();
});

for (const stop of ["finished", "stopped", "abort", "close", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown", "replacement", "native_dispose", "stale", "session_error", "mode_change", "ui_loss"]) {
  test(`animation timer and stale callbacks stop on ${stop}`, t => {
    const f = fixture(t), controller = new AbortController(), panel = f.open(f.ctx, controller.signal);
    panel.update(view); f.advance(); assert.equal(f.timers.size, 1);
    if (stop === "finished" || stop === "stopped") panel.update({ ...view, phase: stop });
    else if (stop === "abort") controller.abort();
    else if (stop === "close") panel.close();
    else if (stop === "replacement") f.open(f.ctx).update(view);
    else if (stop === "native_dispose") f.components[0]!.dispose!();
    else if (stop === "stale") { f.session("different"); f.advance(); }
    else if (stop === "session_error") { f.failure("session"); f.advance(); }
    else if (stop === "mode_change") { f.context.mode = "rpc"; f.advance(); }
    else if (stop === "ui_loss") { f.context.hasUI = false; f.advance(); }
    else f.hooks.get(stop)!();
    assert.equal(f.timers.size, stop === "replacement" ? 1 : 0);
    const before = f.counts(); f.callbacks[0]!(); panel.update(view);
    assert.deepEqual(f.counts(), before, "Late frames/updates cannot resurrect the old lease or clear its successor");
    if (stop === "replacement") { panel.close(); assert.equal(f.timers.size, 1); assert.equal(f.counts().clears, 1); }
    f.hooks.get("session_shutdown")!(); panel.close(); assert.equal(f.timers.size, 0);
  });
}

for (const failure of ["mount", "request", "render", "clear", "missing_port", "ignored_factory", "timer", "unref"]) test(`UI ${failure} failure clears the timer without retries or escaping`, t => {
  const f = fixture(t), panel = f.open(f.ctx);
  if (!["request", "render", "clear"].includes(failure)) f.failure(failure);
  assert.doesNotThrow(() => panel.update(view));
  f.failure(failure);
  assert.doesNotThrow(() => { if (failure === "clear") panel.close(); else f.advance(); });
  assert.equal(f.timers.size, 0); assert.equal(f.counts().clears, 1);
  const before = f.counts(); f.callbacks.forEach(callback => callback()); panel.update(view); panel.close(); assert.deepEqual(f.counts(), before);
  assert.ok(f.frames.every(lines => !lines.join("\n").includes("PRIVATE_UI_ERROR")));
});

for (const setting of ["reduced-motion", "NO_COLOR", "TERM=dumb", "rpc", "json", "print", "no_ui", "pre_aborted", "missing_session"]) test(`${setting} never starts an animation timer`, t => {
  const f = fixture(t, setting === "NO_COLOR" ? { NO_COLOR: "" } : setting === "TERM=dumb" ? { TERM: "dumb" } : {});
  if (["rpc", "json", "print"].includes(setting)) f.context.mode = setting;
  if (setting === "no_ui") f.context.hasUI = false;
  if (setting === "missing_session") f.session("");
  const controller = new AbortController(); if (setting === "pre_aborted") controller.abort();
  const panel = f.open(f.ctx, controller.signal);
  panel.update(setting === "reduced-motion" ? { ...view, display: { animations: false } } : view);
  f.advance(10); assert.equal(f.timers.size, 0); assert.equal(f.intervals.length, 0);
  if (["reduced-motion", "NO_COLOR", "TERM=dumb"].includes(setting)) {
    assert.equal(f.counts().mounts, 1); const frame = f.frames.at(-1)!; assert.match(frame.map(stripVTControlCharacters).join("\n"), /▶ a/);
    if (setting !== "reduced-motion") assert.deepEqual(frame.map(stripVTControlCharacters), frame);
  } else assert.equal(f.counts().mounts, 0);
  panel.close();
});

test("approval and disabled animations pause the sole timer; real state updates still request renders without remounts", t => {
  const f = fixture(t), panel = f.open(f.ctx);
  panel.update({ ...view, phase: "approval" }); assert.equal(f.timers.size, 0);
  panel.update(view); assert.equal(f.timers.size, 1);
  panel.update({ ...view, display: { animations: false } }); assert.equal(f.timers.size, 0);
  const before = f.counts().requests; f.advance(5); assert.equal(f.counts().requests, before);
  panel.update({ ...view, display: { animations: false }, modelCalls: 3 }); assert.equal(f.counts().requests, before + 1);
  panel.update(view); assert.equal(f.timers.size, 1); assert.equal(f.counts().mounts, 1);
  panel.close();
});

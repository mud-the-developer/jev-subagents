import assert from "node:assert/strict";
import { createServer } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerOnboarding } from "../src/onboarding.ts";
import { SESSION_SETUP_ENTRY, branchBackend, sessionSetupHandled, type SessionSetupRecord } from "../src/jev-backend.ts";
import { reduceSessionSetup, type SessionSetupState } from "../src/session-setup.ts";
import { runSessionSetup, sessionDiscoveryOrigins } from "../src/session-setup-effects.ts";
import { withJevSession, readJevConnection } from "../src/jev-config.ts";
import { route } from "../src/effects.ts";
import { gpuInstallIO } from "../src/gpu-laya-effects.ts";
const nativeFetch = globalThis.fetch;
const envKeys = ["JEV_BACKEND", "TYPESAFE_API_KEY", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY", "CLEF_BASE_URL", "CLEF_MODEL", "CLEF_API_KEY"] as const;
beforeEach(t => {
  assert.ok("mock" in t);
  t.mock.method(gpuInstallIO, "platform", () => ({ os: "win32", arch: "x64" }));
  t.mock.method(gpuInstallIO, "inspect", async () => ({ version: 1, mode: "install", root: "C:\\fixture\\laya", sourceDigest: "a".repeat(64), runtimeExecutable: "C:\\bun\\bun.exe", workerScript: "C:\\source\\gpu-laya-worker.ts" }));
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]])); for (const k of envKeys) delete process.env[k];
  process.env.TYPESAFE_API_KEY = "fixture-private-typesafe-key";
  t.after(() => { for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.ok(["http://127.0.0.1:8080/v1/models", "http://127.0.0.1:30000/v1/models"].includes(String(url)));
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return Response.json({ data: String(url).includes(":8080/") ? [{ id: "laya-1.0" }, { id: "private-unknown-model-marker" }] : [{ id: "Cloudflare/clef-flash" }] });
  });
});
function fixture(t: TestContext) {
  type Entry = { type: "custom"; customType: string; data: unknown };
  const entries: Entry[] = [], notices: string[] = [], statuses: (string | undefined)[] = [];
  const hooks = new Map<string, ((event: unknown, ctx: ExtensionContext) => Promise<unknown>)[]>();
  let id = "session-a", leaf: string | null = "root", idle = true, branchStart = 0;
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const bus = { on: t.mock.fn(() => () => {}), emit: t.mock.fn() };
  const append = t.mock.fn((customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); leaf = `entry-${entries.length}`; });
  const api = { events: bus, appendEntry: append, registerCommand: (_name: string, def: typeof command) => { command = def; },
    on: (event: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => { hooks.set(event, [...(hooks.get(event) ?? []), fn]); } } as unknown as ExtensionAPI;
  const select = t.mock.fn(async (_title: string, choices: string[], _options?: unknown) => choices.find(c => c.startsWith("Laya ·")) ?? choices.at(-1));
  const ctx = { mode: "print", hasUI: true, isIdle: () => idle, cwd: "/offline",
    sessionManager: { getSessionId: () => id, getLeafId: () => leaf, getBranch: () => entries.slice(branchStart), getEntries: () => entries },
    ui: { select, notify: (text: string) => notices.push(text), setStatus: (_key: string, value?: string) => statuses.push(value),
      custom: () => assert.fail("No HTML or custom dashboard/TUI"), confirm: () => assert.fail("Picker is selection only; no second setup confirmation") },
  } as unknown as ExtensionCommandContext;
  registerOnboarding(api);
  const emit = async (event: string) => { for (const fn of hooks.get(event) ?? []) await fn({ type: event }, ctx); };
  return { api, ctx, entries, notices, statuses, hooks, bus, append, select, command: () => command, emit,
    invoke: (text: string) => command.handler(text, ctx), move: () => { leaf = "different-leaf"; }, switchId: () => { id = "session-b"; }, branchAway: () => { branchStart = entries.length; leaf = "historical-root"; }, busy: () => { idle = false; } };
}
function delayedPicker(t: TestContext, f: ReturnType<typeof fixture>) {
  let ready!: () => void, respond!: (value: string | undefined) => void;
  const shown = new Promise<void>(resolve => { ready = resolve; });
  f.select.mock.mockImplementation((_title, _choices, options) => {
    const dialog = options as { signal?: AbortSignal; timeout?: number };
    const answer = new Promise<string | undefined>(resolve => { respond = resolve; });
    // Model the public SDK timeout contract, never OS/session facts or execution approval.
    if (dialog.timeout !== undefined) setTimeout(() => respond(undefined), dialog.timeout);
    ready(); return answer;
  });
  const work = f.emit("session_start");
  t.after(async () => { await f.emit("session_shutdown"); respond?.(undefined); await work; });
  return { shown, work, pick: (value?: string) => respond(value),
    options: () => f.select.mock.calls[0]!.arguments[2] as { signal: AbortSignal; timeout?: number } };
}
const origins = ["http://127.0.0.1:8080", "http://127.0.0.1:30000"];
const inventory = { results: origins.map((origin, i) => ({ origin, presets: i ? ["clef-flash" as const] : ["laya" as const], status: "found" as const })), typesafeReady: true };
function menu(): SessionSetupState {
  let state = reduceSessionSetup({ status: "idle" }, { type: "start", sessionId: "fixture", origins, eligible: true, handled: false }).state;
  state = reduceSessionSetup(state, { type: "prepared" }).state;
  return reduceSessionSetup(state, { type: "available", availability: inventory }).state;
}

test("pure session reducer disables while pending, accepts only offered IDs, owns records and treats Escape as disabled not approval", () => {
  const start = { type: "start" as const, sessionId: "fixture", origins, eligible: true, handled: false };
  const preparing = reduceSessionSetup({ status: "idle" }, start);
  assert.equal(preparing.state.status, "preparing"); assert.equal(preparing.effects[0]?.type, "prepare");
  if (preparing.effects[0]?.type === "prepare") assert.deepEqual(preparing.effects[0].record.selection, { mode: "off" });
  for (const mode of ["handled", "missing-ui"] as const) assert.deepEqual(reduceSessionSetup({ status: "idle" }, { ...start, handled: mode === "handled", eligible: mode !== "missing-ui" }).effects, []);
  const ready = menu(); assert.equal(ready.status, "choosing");
  const original = structuredClone(ready); const selected = reduceSessionSetup(ready, { type: "choose", id: "laya@http://127.0.0.1:8080" });
  assert.equal(selected.state.status, "saving"); assert.deepEqual(ready, original);
  assert.equal(reduceSessionSetup(ready, { type: "choose", id: "clef@https://remote.invalid" }).state.status, "failed");
  const escaped = reduceSessionSetup(ready, { type: "choose" }); assert.equal(escaped.effects[0]?.type, "save");
  if (escaped.effects[0]?.type === "save") { assert.equal(escaped.effects[0].record.outcome, "dismissed"); assert.deepEqual(escaped.effects[0].record.selection, { mode: "off" }); }
  const cancelled = reduceSessionSetup(ready, { type: "cancel" }).state;
  assert.equal(reduceSessionSetup(cancelled, { type: "choose", id: "typesafe" }).state, cancelled);
});

test("pure startup rejects remote scope/invalid inventory and never invents undiscovered methods", () => {
  assert.equal(reduceSessionSetup({ status: "idle" }, { type: "start", sessionId: "fixture", origins: ["https://evil.invalid"], eligible: true, handled: false }).state.status, "failed");
  const ready = menu(); assert.ok(ready.status === "choosing");
  assert.deepEqual(ready.choices.map(c => c.id), ["laya@http://127.0.0.1:8080", "clef-flash@http://127.0.0.1:30000", "typesafe", "off"]);
  const scanning = reduceSessionSetup({ status: "preparing", sessionId: "fixture", origins }, { type: "prepared" }).state;
  assert.equal(reduceSessionSetup(scanning, { type: "available", availability: { ...inventory, results: [{ origin: "https://evil.invalid", presets: ["laya"], status: "found" }] } }).state.status, "failed");
});

test("discovery derives only two normalized known/explicit loopback origins, ignores remote/credential paths and deduplicates", () => {
  assert.deepEqual(sessionDiscoveryOrigins({}), origins);
  assert.deepEqual(sessionDiscoveryOrigins({ OPENJEV_BASE_URL: "https://api.codiv.ai", CLEF_BASE_URL: "http://private-user:private-pass@127.0.0.1:30000" }), origins);
  assert.deepEqual(sessionDiscoveryOrigins({ OPENJEV_BASE_URL: "http://[::1]:8081", CLEF_BASE_URL: "http://[::1]:8081/" }), ["http://[::1]:8081"]);
});

test("session start automatically shows one exact native list with found methods, saves session setting and registers no dashboard", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"), envBefore = { ...process.env };
  assert.equal(http.mock.callCount(), 0); assert.equal(f.bus.on.mock.callCount(), 0); assert.equal(f.bus.emit.mock.callCount(), 0);
  await f.emit("session_start"); assert.equal(http.mock.callCount(), 2); assert.equal(f.select.mock.callCount(), 1);
  const [title, choices] = f.select.mock.calls[0]!.arguments; assert.match(title, /this session/); assert.match(title, /inference\/quality verified/);
  assert.equal(choices.length, 4); assert.ok(choices[0]?.includes("laya-1.0") && choices[0].includes("http://127.0.0.1:8080")); assert.ok(choices[1]?.includes("Cloudflare/clef-flash"));
  assert.ok(!JSON.stringify(choices).includes("private-unknown-model-marker")); assert.equal(f.entries.length, 2);
  assert.equal((f.entries[0]!.data as SessionSetupRecord).outcome, "pending"); assert.equal((f.entries[1]!.data as SessionSetupRecord).outcome, "selected");
  const cfg = withJevSession(f.ctx, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.model, "laya-1.0");
  assert.ok(!JSON.stringify(f.entries).includes("fixture-private-typesafe-key"));
  assert.ok(Object.keys(process.env).length === Object.keys(envBefore).length && Object.keys(envBefore).every(key => process.env[key] === envBefore[key]), "Process env changed; values withheld");
  assert.equal(f.statuses.at(-1), undefined);
});

test("same session re-open/reload does not scan or ask again, a new fork/session asks once, and /jev-subagents explicitly changes choice", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch");
  await f.emit("session_start"); await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1); assert.equal(http.mock.callCount(), 2);
  registerOnboarding(f.api); await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1); assert.equal(http.mock.callCount(), 2);
  f.switchId(); await f.emit("session_start"); await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 2); assert.equal(http.mock.callCount(), 4);
  await f.invoke(""); assert.equal(f.select.mock.callCount(), 3); assert.equal(http.mock.callCount(), 6);
  assert.ok(sessionSetupHandled(f.entries, "session-b"));
});

test("tree movement/reload preserves this session preference without a second dialog or paid default; old command aliases update it too", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"); await f.emit("session_start"); f.branchAway();
  assert.equal(f.ctx.sessionManager.getBranch().length, 0);
  const cfg = withJevSession(f.ctx, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.model, "laya-1.0");
  registerOnboarding(f.api); await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1); assert.equal(http.mock.callCount(), 2);
  f.ctx.ui.confirm = async () => true; await f.invoke("off"); assert.equal(withJevSession(f.ctx, readJevConnection).ok, false);
  await f.invoke("reset"); const reset = withJevSession(f.ctx, readJevConnection); assert.ok(reset.ok); assert.equal(reset.connection.backend, "typesafe");
});

test("latest malformed own-session preference cannot restore paid environment or leak raw history, even on another branch", async t => {
  const f = fixture(t); await f.emit("session_start");
  f.entries.push({ type: "custom", customType: SESSION_SETUP_ENTRY, data: { version: 1, sessionId: "session-a", outcome: "selected", selection: { mode: "local", preset: "laya", origin: "https://private-user:secret@evil.invalid" } } });
  f.branchAway(); const cfg = withJevSession(f.ctx, readJevConnection); assert.equal(cfg.ok, false); assert.ok(!JSON.stringify(cfg).includes("secret"));
});

test("/jev-subagents setup and old studio alias use only the picker, status/doctor separation preserves no-probe status and lean completions", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch");
  await f.invoke("setup"); assert.equal(f.select.mock.callCount(), 1); assert.equal(f.entries.length, 2);
  await f.invoke("status"); assert.equal(http.mock.callCount(), 2); assert.ok(f.notices.at(-1)?.includes("laya-1.0"));
  await f.invoke("studio"); assert.equal(f.select.mock.callCount(), 2); assert.equal(f.bus.on.mock.callCount(), 0);
  assert.deepEqual((await f.command().getArgumentCompletions?.(""))?.map(c => c.value), ["run", "doctor", "result", "help"]);
});

test("RPC startup returns before requesting native input so the host can attach its RPC reader", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"); f.ctx.mode = "rpc";
  await f.emit("session_start");
  assert.equal(f.select.mock.callCount(), 0); assert.equal(http.mock.callCount(), 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.select.mock.callCount(), 1); assert.equal(http.mock.callCount(), 2);
});

test("queued RPC setup is consumed by lifecycle cancellation before metadata or UI", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"); f.ctx.mode = "rpc";
  await f.emit("session_start"); await f.emit("session_shutdown");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(http.mock.callCount(), 0); assert.equal(f.select.mock.callCount(), 0); assert.equal(f.entries.length, 0);
});

test("native TUI/RPC/desktop selectors require no custom component, second confirmation or HTML", async t => {
  for (const mode of ["tui", "rpc", "print"] as const) {
    const f = fixture(t); f.ctx.mode = mode; await f.emit("session_start");
    if (mode === "rpc") await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.select.mock.callCount(), 1);
  }
});

test("no local servers offers a separate GPU installation invitation and off, never unprepared Clef or implicit installation", async t => {
  delete process.env.TYPESAFE_API_KEY;
  const f = fixture(t); t.mock.method(globalThis, "fetch", async () => { throw new Error("private-error-body-marker"); });
  const start = t.mock.method(gpuInstallIO, "start", async () => assert.fail("Startup invitation is not permission"));
  await f.emit("session_start"); assert.deepEqual(f.select.mock.calls[0]!.arguments[1], ["Install/start Laya · GPU / uv venv (download requires separate approval)", "Do not use JEV in this session"]);
  assert.equal(start.mock.callCount(), 0);
  assert.match(f.select.mock.calls[0]!.arguments[0], /No local model found/); assert.deepEqual(branchBackend(f.entries), { mode: "off" });
  assert.ok(!JSON.stringify(f.notices).includes("private-error-body-marker"));
});

test("TypeSafe is only offered with configured valid key; selecting it sends no remote metadata or inference request", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"); f.select.mock.mockImplementation(async (_title, choices) => choices.find(c => c.startsWith("TypeSafe ·")));
  await f.emit("session_start"); const cfg = withJevSession(f.ctx, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.backend, "typesafe");
  assert.equal(http.mock.callCount(), 2); assert.deepEqual(branchBackend(f.entries), { mode: "typesafe" });
});

test("explicit configured Codiv environment is offered but never automatically contacted or selected", async t => {
  process.env.JEV_BACKEND = "openjev"; process.env.OPENJEV_BASE_URL = "https://api.codiv.ai"; process.env.OPENJEV_API_KEY = "fixture-private-codiv-key";
  const f = fixture(t), http = t.mock.method(globalThis, "fetch");
  f.select.mock.mockImplementation(async (_title, choices) => choices.find(c => c.startsWith("OpenJEV ·") && c.includes("api.codiv.ai")));
  await f.emit("session_start"); assert.equal(http.mock.callCount(), 2); assert.deepEqual(branchBackend(f.entries), { mode: "environment" });
  assert.ok(!JSON.stringify(f.entries).includes("fixture-private-codiv-key"));
});

test("Esc/host-cancel completion disables JEV for this session, persists once and never restores paid launch environment", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"); f.select.mock.mockImplementation(async () => undefined);
  await f.emit("session_start"); assert.equal((f.entries.at(-1)?.data as SessionSetupRecord).outcome, "dismissed");
  assert.deepEqual(branchBackend(f.entries), { mode: "off" }); assert.equal(withJevSession(f.ctx, readJevConnection).ok, false);
  await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1); assert.equal(http.mock.callCount(), 2);
});

test("configuration waits past a minute and a day without polling, auto-selection, execution or the old install envelope", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const timeout = t.mock.method(AbortSignal, "timeout"), f = fixture(t), http = t.mock.method(globalThis, "fetch");
  const start = t.mock.method(gpuInstallIO, "start", async () => assert.fail("Configuration waiting is not installation"));
  const picker = delayedPicker(t, f); await picker.shown;
  assert.equal(picker.options().timeout, undefined); assert.equal(picker.options().signal.aborted, false);
  assert.ok(timeout.mock.calls.every(call => call.arguments[0] <= 1500), "No execution/install envelope before an explicit install choice");
  for (const elapsed of [60001, 24 * 60 * 60 * 1000]) {
    t.mock.timers.tick(elapsed); await Promise.resolve(); await Promise.resolve();
    assert.equal(picker.options().signal.aborted, false); assert.equal(f.entries.length, 1);
    assert.deepEqual(branchBackend(f.entries), { mode: "off" }); assert.equal(f.select.mock.callCount(), 1);
    assert.equal(http.mock.callCount(), 2); assert.equal(start.mock.callCount(), 0);
  }
  picker.pick(f.select.mock.calls[0]!.arguments[1].find(value => value.startsWith("TypeSafe ·"))); await picker.work;
  assert.deepEqual(branchBackend(f.entries), { mode: "typesafe" }); assert.equal(f.entries.length, 2);
  assert.equal(http.mock.callCount(), 2); assert.equal(start.mock.callCount(), 0);
});

test("long-lived configuration choice still closes at every lifecycle boundary and rejects late UI answers", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const event of ["before_agent_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) {
    const f = fixture(t), picker = delayedPicker(t, f); await picker.shown;
    t.mock.timers.tick(24 * 60 * 60 * 1000); await f.emit(event); await picker.work;
    assert.equal(picker.options().signal.aborted, true); assert.equal(f.entries.length, 1);
    picker.pick(f.select.mock.calls[0]!.arguments[1][0]); await Promise.resolve();
    assert.deepEqual(branchBackend(f.entries), { mode: "off" }); assert.equal(f.entries.length, 1); assert.equal(f.statuses.at(-1), undefined);
  }
});

test("late configuration answers recheck credentials, session and branch identity without restoring authority or leaking private input", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const changed of ["credentials", "session", "branch"]) {
    const f = fixture(t), picker = delayedPicker(t, f); await picker.shown;
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    if (changed === "credentials") process.env.TYPESAFE_API_KEY = "changed-synthetic-private-key";
    if (changed === "session") f.switchId(); if (changed === "branch") f.move();
    picker.pick(f.select.mock.calls[0]!.arguments[1].find(value => value.startsWith("TypeSafe ·"))); await picker.work;
    assert.deepEqual(branchBackend(f.entries), { mode: "off" }); assert.equal(f.entries.length, 1);
    assert.ok(!JSON.stringify([f.entries, f.notices]).includes("changed-synthetic-private-key"));
  }
});

test("a late explicit install choice retains the 60-second original review and finite activation envelope; late approve cannot start work", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Synthetic unavailable metadata"); });
  const timeout = t.mock.method(AbortSignal, "timeout"), f = fixture(t), picker = delayedPicker(t, f);
  let ready!: () => void, approve!: (value: boolean) => void;
  const reviewShown = new Promise<void>(resolve => { ready = resolve; });
  const review = t.mock.method(f.ctx.ui, "confirm", async (...[_title, _packet, options]: Parameters<ExtensionContext["ui"]["confirm"]>) => {
    assert.equal(options?.timeout, 60000); ready(); return new Promise<boolean>(resolve => { approve = resolve; });
  });
  const start = t.mock.method(gpuInstallIO, "start", async () => assert.fail("Expired review is never installation consent"));
  await picker.shown; t.mock.timers.tick(24 * 60 * 60 * 1000);
  picker.pick(f.select.mock.calls[0]!.arguments[1].find(value => value.startsWith("Install/start Laya"))); await reviewShown;
  assert.equal(review.mock.callCount(), 1); assert.equal(timeout.mock.calls.filter(call => call.arguments[0] > 1500).length, 1);
  assert.equal(timeout.mock.calls.find(call => call.arguments[0] > 1500)!.arguments[0], 20 * 60 * 1000 + 125000);
  t.mock.timers.tick(60001); await picker.work; approve(true); await Promise.resolve();
  assert.equal(start.mock.callCount(), 0); assert.deepEqual(branchBackend(f.entries), { mode: "off" });
});

test("during picker JEV is already disabled, duplicate startup cannot open another picker, and moving branches ignores late selection", { timeout: 5000 }, async t => {
  const f = fixture(t); let pick!: (value: string) => void;
  f.select.mock.mockImplementation(() => new Promise<string>(resolve => { pick = resolve; }));
  let ready!: () => void; const shown = new Promise<void>(r => { ready = r; });
  f.select.mock.mockImplementation(() => { ready(); return new Promise<string>(resolve => { pick = resolve; }); });
  const active = f.emit("session_start"); await shown;
  const disabled = await withJevSession(f.ctx, () => route({ task: "Safe fixture", agents: [{ name: "a", description: "First" }, { name: "b", description: "Second" }] }, t.signal));
  assert.equal(disabled.status, "failed"); await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1);
  f.move(); pick(f.select.mock.calls[0]!.arguments[1][0]!); await active;
  assert.equal(f.entries.length, 1); assert.equal((f.entries[0]?.data as SessionSetupRecord).outcome, "pending");
});

test("every navigation/shutdown boundary aborts pending native selector and cannot revive approval", { timeout: 5000 }, async t => {
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) {
    const f = fixture(t); let pick!: (value: string) => void, ready!: () => void;
    const shown = new Promise<void>(r => { ready = r; });
    f.select.mock.mockImplementation(() => { ready(); return new Promise<string>(r => { pick = r; }); });
    const work = f.emit("session_start"); await shown; await f.emit(event); pick(f.select.mock.calls[0]!.arguments[1][0]!); await work;
    assert.equal(f.entries.length, 1); assert.deepEqual(branchBackend(f.entries), { mode: "off" }); assert.equal(f.statuses.at(-1), undefined);
  }
});

test("headless/missing native UI/busy startup performs no metadata, profile writes or session changes", async t => {
  for (const mode of ["no-ui", "busy", "no-selector"] as const) {
    const f = fixture(t), http = t.mock.method(globalThis, "fetch");
    if (mode === "no-ui") f.ctx.hasUI = false; if (mode === "busy") f.busy();
    if (mode === "no-selector") f.ctx.ui.select = undefined as unknown as ExtensionContext["ui"]["select"];
    await f.emit("session_start"); assert.equal(http.mock.callCount(), 0); assert.equal(f.entries.length, 0);
  }
});

test("forged native choice or credential change during picker fails without activation or key disclosure", async t => {
  for (const mode of ["forged", "key-change"] as const) {
    const f = fixture(t); f.select.mock.mockImplementation(async (_title, choices) => {
      if (mode === "forged") return "on clef https://private-url.invalid";
      process.env.TYPESAFE_API_KEY = "changed-private-key"; return choices.find(c => c.startsWith("TypeSafe ·"));
    });
    await f.emit("session_start"); assert.equal(f.entries.length, 1); assert.deepEqual(branchBackend(f.entries), { mode: "off" });
    assert.ok(!f.notices.join("\n").includes("changed-private-key")); assert.ok(!f.notices.join("\n").includes("private-url"));
  }
});

test("invalid/stopped pending record is fail closed, a completed record is scoped to its session ID not inherited by a fork", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: SESSION_SETUP_ENTRY, data });
  const record = { version: 1, sessionId: "a", outcome: "selected", selection: { mode: "typesafe" } };
  assert.ok(sessionSetupHandled([entry(record)], "a")); assert.equal(sessionSetupHandled([entry(record)], "b"), false);
  const pending = entry({ ...record, outcome: "pending", selection: { mode: "off" } });
  assert.equal(sessionSetupHandled([pending], "a"), false); assert.deepEqual(branchBackend([pending]), { mode: "off" });
  assert.deepEqual(branchBackend([entry({ ...record, privateKey: "marker" })]), { mode: "invalid" });
});

test("SDK append failure cannot claim successful setup or silently reactivate an old preference", async t => {
  const f = fixture(t), http = t.mock.method(globalThis, "fetch"); f.append.mock.mockImplementation(() => {});
  const state = await runSessionSetup(f.api, f.ctx, t.signal); assert.equal(state.status, "failed"); assert.equal(http.mock.callCount(), 0); assert.equal(f.select.mock.callCount(), 0);
  assert.equal(withJevSession(f.ctx, readJevConnection).ok, false, "No paid default after unreadable/unpersisted native setup");
});

test("a pending session after interrupted setup remains disabled, then resumes the selector once without inheriting a paid default", async t => {
  const f = fixture(t); f.append(SESSION_SETUP_ENTRY, { version: 1, sessionId: "session-a", outcome: "pending", selection: { mode: "off" } });
  assert.equal(withJevSession(f.ctx, readJevConnection).ok, false);
  await f.emit("session_start"); await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1);
  const cfg = withJevSession(f.ctx, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.model, "laya-1.0");
});

test("unsupported cosmetic status UI cannot prevent selection or retain lifecycle ownership", async t => {
  const f = fixture(t); f.ctx.ui.setStatus = () => { throw new Error("unsupported cosmetic UI"); };
  await f.emit("session_start"); assert.equal(f.select.mock.callCount(), 1);
  await f.emit("session_shutdown"); await f.invoke(""); assert.equal(f.select.mock.callCount(), 2);
  assert.equal((f.entries.at(-1)?.data as SessionSetupRecord).outcome, "selected");
});

test("native GPU selection requires its own literal approval; owned selection survives tree but closes at session switch", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  t.mock.method(gpuInstallIO, "sourceDigest", async () => "a".repeat(64));
  for (const accepted of [false, true]) {
    const f = fixture(t); let live = true;
    f.select.mock.mockImplementation(async (_title, choices) => choices.find(c => c.startsWith("Install/start Laya")));
    const confirm = t.mock.method(f.ctx.ui, "confirm", async (_title: string, packet: string) => { assert.match(packet, /uv venv/); assert.match(packet, /GPU/); assert.match(packet, /--no-registry/); return accepted; });
    const close = t.mock.fn(async () => { live = false; return true; });
    const start = t.mock.method(gpuInstallIO, "start", async (...[_plan, _signal, stage]: Parameters<typeof gpuInstallIO.start>) => {
      assert.equal(confirm.mock.callCount(), 1); stage("server"); return { origin: "http://127.0.0.1:59997", alive: () => live, close };
    });
    await f.emit("session_start"); assert.equal(confirm.mock.callCount(), 1); assert.equal(start.mock.callCount(), Number(accepted));
    const cfg = withJevSession(f.ctx, readJevConnection); assert.equal(cfg.ok, accepted);
    if (accepted) {
      assert.ok(cfg.ok); assert.equal(cfg.connection.apiKey, null); assert.equal((f.entries.at(-1)!.data as SessionSetupRecord).selection.mode, "local");
      await f.emit("session_before_tree"); assert.equal(close.mock.callCount(), 0);
      await f.emit("session_before_switch"); assert.equal(close.mock.callCount(), 1); assert.equal(withJevSession(f.ctx, readJevConnection).ok, false);
    }
    assert.ok(!JSON.stringify(f.entries).includes("fixture-private-typesafe-key"));
    start.mock.restore(); confirm.mock.restore();
  }
});

test("real ephemeral local HTTP discovery uses only explicit configured loopback and records selected Clef without inference", { timeout: 5000 }, async t => {
  let calls = 0;
  const server = createServer((req, res) => { calls++; assert.equal(req.url, "/v1/models"); assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, undefined); res.end(JSON.stringify({ data: [{ id: "Cloudflare/clef" }] })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r, reject) => { server.close(e => e ? reject(e) : r()); server.closeAllConnections(); }));
  const addr = server.address(); assert.ok(addr && typeof addr !== "string"); const origin = `http://127.0.0.1:${addr.port}`;
  process.env.OPENJEV_BASE_URL = origin; process.env.CLEF_BASE_URL = origin;
  const http = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => { assert.equal(url, `${origin}/v1/models`); return nativeFetch(url, init); });
  const f = fixture(t); f.select.mock.mockImplementation(async (_title, choices) => choices.find(c => c.startsWith("Clef ·")));
  await f.emit("session_start"); assert.equal(calls, 1); assert.equal(http.mock.callCount(), 1);
  const cfg = withJevSession(f.ctx, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.model, "Cloudflare/clef"); assert.equal(cfg.connection.endpoint, `${origin}/v1/systemone`);
});

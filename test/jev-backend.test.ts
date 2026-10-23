import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { beforeEach, test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import router from "../src/index.ts";
import { registerOnboarding } from "../src/onboarding.ts";
import { BACKEND_ENTRY, LOCAL_PRESETS, branchBackend, parseBackendAction, reduceBackend, type BackendSelection } from "../src/jev-backend.ts";
import { discoverLocalModels, runBackendCommand } from "../src/jev-backend-effects.ts";
import { withJevSession, readJevConnection, resolveJevConnection, stripJevEnvironment, validateJevEndpoint } from "../src/jev-config.ts";
import { requestJev, route } from "../src/effects.ts";
import { readProbabilities, estimateJevUsd } from "../src/choice.ts";
import { decide } from "../src/decision.ts";
import { parseAssessment } from "../src/assessment.ts";
import type { NativeExecutionHarness } from "../src/basic-execution.ts";

const nativeFetch = globalThis.fetch;
const keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY", "CLEF_BASE_URL", "CLEF_MODEL", "CLEF_API_KEY", "TYPESAFE_API_KEY"] as const;
beforeEach(t => {
  assert.ok("mock" in t); const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k]; process.env.TYPESAFE_API_KEY = "offline-typesafe-secret";
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Non-fixture network forbidden"); });
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
});
function fixture(t: TestContext, full = false) {
  type Entry = { type: "custom"; customType: string; data: unknown };
  const entries: Entry[] = [], notices: string[] = [], hooks = new Map<string, (() => Promise<void>)[]>();
  let id = "fixture-session", leaf: string | null = "root";
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const api = { registerCommand: (name: string, def: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, def),
    registerTool: (def: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(def.name, def),
    on: (name: string, fn: () => Promise<void>) => { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    events: { on: () => () => {}, emit: () => {} },
    appendEntry: t.mock.fn((customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); leaf = `entry-${entries.length}`; }),
  } as unknown as ExtensionAPI;
  const confirm = t.mock.fn(async (_title: string, _text: string) => true), select = t.mock.fn(async (_title: string, _options: string[]) => "laya");
  const ctx = { hasUI: true, mode: "rpc", cwd: "/offline", isIdle: () => true,
    sessionManager: { getSessionId: () => id, getLeafId: () => leaf, getBranch: () => entries },
    ui: { confirm, select, notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  if (full) router(api); else registerOnboarding(api);
  const invoke = (text: string) => commands.get("jev-subagents")!.handler(text, ctx);
  const set = (selection: BackendSelection) => entries.push({ type: "custom", customType: BACKEND_ENTRY, data: { version: 1, selection } });
  return { api, ctx, entries, notices, hooks, confirm, select, commands, tools, invoke, set,
    move: () => { leaf = "different-leaf"; }, replace: () => { id = "replacement-session"; } };
}
async function serverFixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const http = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.ok(String(url) === `${origin}/v1/models` || String(url) === `${origin}/v1/systemone`); assert.equal(init?.redirect, "error");
    return nativeFetch(url, init);
  });
  return { origin, http };
}
const agents = [{ name: "a", description: "First role" }, { name: "b", description: "Second role" }, { name: "c", description: "Third role" }];
const rounded = { a: 0.3333, b: 0.3333, c: 0.3333 };
const answer = { type: "choice", choice: "a", confidence: 0.3333, probabilities: rounded };

test("parser fills pinned local presets, allows explicit literal origin only, never accepts keys or remote destinations", () => {
  for (const preset of Object.keys(LOCAL_PRESETS)) {
    const parsed = parseBackendAction(`on ${preset}`); assert.equal(parsed?.type, "set");
    if (parsed?.type === "set") assert.deepEqual(parsed.selection, { mode: "local", preset, origin: LOCAL_PRESETS[preset as keyof typeof LOCAL_PRESETS].origin });
  }
  for (const text of ["on missing", "on laya http://localhost:8080", "on clef https://api.cloudflare.com", "on clef http://192.168.1.2",
    "on laya http://private-user:private-pass@127.0.0.1:8080", "on clef http://127.0.0.1:30000/v1", "on laya http://127.0.0.1?private-key=1",
    "on laya http://127.0.0.1 secret", "backend detect https://evil.invalid", "off extra", "reset extra"]) assert.equal(parseBackendAction(text), undefined);
  assert.deepEqual(parseBackendAction("backend detect"), { type: "detect", origins: ["http://127.0.0.1:8080", "http://127.0.0.1:30000"] });
  assert.deepEqual(parseBackendAction("on clef http://[::1]:30001/"), { type: "set", selection: { mode: "local", preset: "clef", origin: "http://[::1]:30001" } });
});

test("pure approval reducer owns admission, preserves immutable inputs, and ignores late approval after cancel", () => {
  const action = parseBackendAction("on laya")!; const original = structuredClone(action);
  const denied = reduceBackend({ status: "idle" }, { type: "start", action, canConfirm: false }); assert.equal(denied.state.status, "cancelled"); assert.deepEqual(denied.effects, []);
  const pending = reduceBackend({ status: "idle" }, { type: "start", action, canConfirm: true }); assert.equal(pending.state.status, "reviewing"); assert.equal(pending.effects[0]?.type, "confirm");
  for (const wrong of ["yes", 1, {}]) assert.equal(reduceBackend(pending.state, { type: "approval", approved: wrong as boolean }).state.status, "cancelled");
  assert.deepEqual(action, original); const cancelled = reduceBackend(pending.state, { type: "cancel" });
  assert.equal(reduceBackend(cancelled.state, { type: "approval", approved: true }).state, cancelled.state);
  assert.equal(reduceBackend(pending.state, { type: "approval", approved: true }).effects[0]?.type, "apply");
});

test("branch preference decoding is strict and latest invalid record fails closed rather than restoring paid environment", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: BACKEND_ENTRY, data });
  assert.deepEqual(branchBackend([]), { mode: "environment" });
  const good = entry({ version: 1, selection: { mode: "off" } }); assert.deepEqual(branchBackend([good]), { mode: "off" });
  for (const data of [{ version: 2, selection: { mode: "off" } }, { version: 1, selection: { mode: "local", preset: "laya", origin: "https://evil.invalid" } },
    { version: 1, selection: { mode: "off" }, privateKey: "marker" }]) assert.deepEqual(branchBackend([good, entry(data)]), { mode: "invalid" });
});

test("native on confirms exact public config once, writes branch metadata only, and never probes/changes environment", async t => {
  const f = fixture(t); const before = { ...process.env }, http = t.mock.method(globalThis, "fetch");
  await f.invoke("on laya"); assert.equal(f.confirm.mock.callCount(), 1); assert.equal(f.entries.length, 1); assert.equal(http.mock.callCount(), 0);
  assert.ok(Object.keys(process.env).length === Object.keys(before).length && Object.keys(before).every(key => process.env[key] === before[key]), "Process environment changed; values withheld"); assert.match(f.confirm.mock.calls[0]!.arguments[1], /laya/); assert.ok(!JSON.stringify(f.entries).includes("offline-typesafe-secret"));
  const cfg = withJevSession(f.ctx, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.model, "laya-1.0"); assert.equal(cfg.connection.apiKey, null);
  await f.invoke("backend"); assert.equal(http.mock.callCount(), 0); assert.ok(f.notices.at(-1)?.includes("laya-1.0"));
  assert.ok((await f.commands.get("jev-subagents")!.getArgumentCompletions?.("on c"))?.some(item => item.value === "on clef"));
});

test("picker, off, explicit typesafe, reset and reload derive preferences from the current branch", async t => {
  const f = fixture(t); await f.invoke("on"); assert.equal(f.select.mock.callCount(), 1);
  await f.invoke("off"); assert.equal(withJevSession(f.ctx, readJevConnection).ok, false);
  await f.invoke("on typesafe"); const legacy = withJevSession(f.ctx, readJevConnection); assert.ok(legacy.ok); assert.equal(legacy.connection.backend, "typesafe");
  await f.invoke("on clef-flash"); const clef = withJevSession(f.ctx, readJevConnection); assert.ok(clef.ok); assert.equal(clef.connection.model, "Cloudflare/clef-flash");
  registerOnboarding(f.api); assert.deepEqual(withJevSession(f.ctx, readJevConnection), clef);
  await f.invoke("reset"); assert.equal(withJevSession(f.ctx, readJevConnection).ok, true); assert.deepEqual(branchBackend(f.entries), { mode: "environment" });
});

test("decline/missing UI/busy/invalid command do not write prefs or fetch", async t => {
  for (const reason of ["decline", "missing-ui", "busy", "invalid"] as const) {
    const f = fixture(t); f.confirm.mock.mockImplementation(async () => false);
    if (reason === "missing-ui") f.ctx.hasUI = false;
    if (reason === "busy") f.ctx.isIdle = () => false;
    await f.invoke(reason === "invalid" ? "on clef https://private-url.invalid" : "on clef"); assert.equal(f.entries.length, 0);
    assert.ok(!f.notices.join("\n").includes("private-url"));
  }
});

test("lifecycle stop and stale leaf/session ignore late native acceptance with no preference writes", { timeout: 5000 }, async t => {
  for (const mode of ["lifecycle", "leaf", "session"] as const) {
    const f = fixture(t); let accept!: (v: boolean) => void;
    f.confirm.mock.mockImplementation(() => new Promise<boolean>(r => { accept = r; }));
    const pending = f.invoke("on clef"); assert.ok(accept);
    if (mode === "lifecycle") { for (const stop of f.hooks.get("session_before_tree") ?? []) await stop(); }
    else if (mode === "leaf") f.move(); else f.replace();
    accept(true); await pending; assert.equal(f.entries.length, 0);
  }
});

test("navigation cancels setup/backend work while Full Access revocation is still draining", async t => {
  for (const action of ["on clef", "setup"]) {
    const f = fixture(t); let release!: () => void;
    const harness: NativeExecutionHarness = { isBusy: () => false, blockedReason: () => undefined, lastFailure: () => undefined,
      run: async () => assert.fail("No worker"), cancel: async () => {}, access: {
        handle: async () => assert.fail("No access activation"), revoke: () => new Promise<void>(resolve => { release = resolve; }),
      } };
    registerOnboarding(f.api, harness);
    const work = f.invoke(action); assert.ok(release);
    const stopping = Promise.all((f.hooks.get("session_before_tree") ?? []).map(stop => stop()));
    release(); await stopping; await work;
    assert.equal(f.confirm.mock.callCount(), 0); assert.equal(f.select.mock.callCount(), 0); assert.equal(f.entries.length, 0);
  }
});

test("async-local scopes isolate simultaneous sessions, resume branches, and reject replaced sessions before HTTP", async t => {
  const a = fixture(t), b = fixture(t); a.set({ mode: "local", preset: "laya", origin: "http://127.0.0.1:8080" }); b.set({ mode: "local", preset: "clef", origin: "http://127.0.0.1:30000" });
  const values = await Promise.all([a, b].map(f => withJevSession(f.ctx, async () => { await Promise.resolve(); return readJevConnection(); })));
  assert.ok(values[0]?.ok && values[1]?.ok); assert.equal(values[0].connection.model, "laya-1.0"); assert.equal(values[1].connection.model, "Cloudflare/clef");
  const parent = readJevConnection(); assert.ok(parent.ok); assert.equal(parent.connection.backend, "typesafe");
  const changed = await withJevSession(a.ctx, async () => { a.replace(); return requestJev("fixture", {}); }); assert.equal(changed.type, "failed");
});

test("off and corrupt branch records prevent registered route/decision/delegate JEV requests without falling back", async t => {
  const f = fixture(t, true), http = t.mock.method(globalThis, "fetch"); f.set({ mode: "off" });
  await assert.rejects(f.tools.get("jev_route")!.execute("fixture", { task: "Safe fixture", agents }, t.signal, undefined, f.ctx), /disabled/);
  await assert.rejects(f.tools.get("jev_decide")!.execute("fixture", { question: "Choose", context: "Fixture", options: agents.map(x => ({ id: x.name, title: x.name, description: x.description })), requiresHuman: false }, t.signal, undefined, f.ctx), /disabled/);
  f.entries.push({ type: "custom", customType: BACKEND_ENTRY, data: { privateKey: "private-record" } });
  const cfg = withJevSession(f.ctx, readJevConnection); assert.equal(cfg.ok, false); assert.ok(!JSON.stringify(cfg).includes("private-record")); assert.equal(http.mock.callCount(), 0);
});

test("Clef uses its own optional key, only literal loopback and exact HF model ids, with unknown price and child stripping", () => {
  const cfg = resolveJevConnection({ JEV_BACKEND: "clef", CLEF_BASE_URL: "http://127.0.0.1:30000", TYPESAFE_API_KEY: "wrong-typesafe", OPENJEV_API_KEY: "wrong-openjev" });
  assert.ok(cfg.ok); assert.equal(cfg.connection.apiKey, null); assert.equal(cfg.connection.model, "Cloudflare/clef");
  for (const base of ["https://api.cloudflare.com", "https://api.codiv.ai", "http://localhost:30000", "http://169.254.169.254"]) assert.equal(resolveJevConnection({ JEV_BACKEND: "clef", CLEF_BASE_URL: base }).ok, false);
  assert.throws(() => validateJevEndpoint({ backend: "clef", endpoint: "https://api.codiv.ai/v1/systemone", model: "Cloudflare/clef" }));
  const env = { CLEF_API_KEY: "secret", CLEF_MODEL: "Cloudflare/clef", CLEF_BASE_URL: "http://127.0.0.1:30000", KEEP: "public" }; stripJevEnvironment(env); assert.deepEqual(env, { KEEP: "public" });
  assert.equal(estimateJevUsd({ inputTokens: 123, outputTokens: 0 }, "clef"), null);
});

test("published Clef 4-decimal probabilities preserve original map and bounded rounding, not global tolerance or missing mass", () => {
  assert.deepEqual(readProbabilities(rounded, ["a", "b", "c"], "clef"), rounded);
  assert.deepEqual(readProbabilities(rounded, ["a", "b", "c"], "openjev", "laya-1.0"), rounded);
  assert.throws(() => readProbabilities(rounded, ["a", "b", "c"], "openjev", "openjev-0.1"));
  for (const provider of [undefined, "openjev"] as const) assert.throws(() => readProbabilities(rounded, ["a", "b", "c"], provider));
  for (const value of [{ a: 0.3333, b: 0.3333, c: 0.334 }, { a: 0.33331, b: 0.33331, c: 0.33331 }, { a: 0.5, b: 0.5 }, { ...rounded, extra: 0 }, { a: -0.01, b: 0.5, c: 0.51 }]) assert.throws(() => readProbabilities(value, ["a", "b", "c"], "clef"));
  const reply = parseAssessment({ provider: "clef", requestedModel: "Cloudflare/clef", model: "Cloudflare/clef", usage: { input_tokens: 3, output_tokens: 0 },
    answers: { criterion_0: { type: "choice", choice: "unknown", confidence: 0.3333, probabilities: { met: 0.3333, unmet: 0.3333, unknown: 0.3333 } } } }, 1);
  assert.equal(reply.provider, "clef"); assert.equal(reply.judgments[0]?.probabilities?.unknown, 0.3333);
});

test("real local Clef inference packet integrates registered tools and mandatory human bypass without credential crossover", { timeout: 5000 }, async t => {
  let packet: { model: string } | undefined, auth: string | undefined;
  const { origin, http } = await serverFixture(t, (req, res) => {
    auth = req.headers.authorization; const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); packet = input;
      res.end(JSON.stringify({ model: input.model, provider: "forged-marker", requestedModel: "forged-marker", usage: { input_tokens: 24, output_tokens: 0 },
        answers: Object.fromEntries(Object.keys(input.questions).map(key => [key, answer])) }));
    });
  });
  const f = fixture(t, true); await f.invoke(`on clef ${origin}`); assert.equal(http.mock.callCount(), 0);
  const tool = f.tools.get("jev_route")!;
  const result = await tool.execute("fixture", { task: "Only explicit fixture data", agents }, t.signal, undefined, f.ctx);
  const text = JSON.stringify(result); assert.ok(text.includes("clef")); assert.ok(!text.includes("forged-marker")); assert.ok(!text.includes("offline-typesafe-secret"));
  assert.equal(auth, undefined); assert.equal(packet?.model, "Cloudflare/clef"); assert.equal(http.mock.callCount(), 1);
  const input = { question: "Choose", context: "Fixture", options: agents.map(x => ({ id: x.name, title: x.name, description: x.description })), requiresHuman: false };
  const state = await withJevSession(f.ctx, () => decide(input, t.signal)); assert.equal(state.status, "needs_user");
  if (state.status === "needs_user") assert.deepEqual(state.reply?.probabilities, rounded);
  await withJevSession(f.ctx, () => decide({ ...input, requiresHuman: true }, t.signal)); assert.equal(http.mock.callCount(), 2);
});

test("session preference changes after a completion target snapshot stop transmission before fetch", async t => {
  const f = fixture(t); f.set({ mode: "local", preset: "laya", origin: "http://127.0.0.1:8080" }); const http = t.mock.method(globalThis, "fetch");
  await withJevSession(f.ctx, async () => {
    const cfg = readJevConnection(); assert.ok(cfg.ok); f.set({ mode: "local", preset: "clef", origin: "http://127.0.0.1:30000" });
    assert.equal((await requestJev("fixture", {}, t.signal, undefined, cfg.connection)).type, "failed");
  }); assert.equal(http.mock.callCount(), 0);
});

test("explicit discovery uses anonymous real HTTP metadata, only recognized presets and no preference activation", { timeout: 5000 }, async t => {
  const { origin, http } = await serverFixture(t, (req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.url, "/v1/models"); assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ data: [{ id: "laya-1.0" }, { id: "Cloudflare/clef" }, { id: "private-remote-marker" }] }));
  });
  const f = fixture(t); await f.invoke(`backend detect ${origin}`); assert.equal(http.mock.callCount(), 1); assert.equal(f.entries.length, 0);
  assert.ok(f.notices.at(-1)?.includes(`/jev-subagents on laya ${origin}`)); assert.ok(!f.notices.join("\n").includes("private-remote-marker"));
  f.confirm.mock.mockImplementation(async () => false); await f.invoke(`backend detect ${origin}`); assert.equal(http.mock.callCount(), 1);
});

test("metadata discovery rejects redirects, oversize, HTTP auth failures and malformed models without retry/body leakage", { timeout: 5000 }, async t => {
  for (const mode of ["redirect", "oversize", "auth", "invalid"] as const) {
    const { origin, http } = await serverFixture(t, (_req, res) => {
      if (mode === "redirect") { res.writeHead(307, { Location: "https://api.typesafe.ai/v1/systemone" }); res.end(); }
      else if (mode === "auth") { res.writeHead(401); res.end("private-error-marker"); }
      else if (mode === "oversize") res.end(" ".repeat(65537)); else res.end(JSON.stringify({ data: "private-error-marker" }));
    });
    const result = await discoverLocalModels([origin], t.signal); assert.equal(result[0]?.status, "unavailable"); assert.equal(http.mock.callCount(), 1);
    assert.ok(!JSON.stringify(result).includes("private-error-marker")); http.mock.restore();
  }
});

test("discovery fixed two-origin scope is bounded, cancellation aborts stalled body and remote origin never fetches", { timeout: 5000 }, async t => {
  let headers!: () => void; const seen = new Promise<void>(r => { headers = r; });
  const { origin, http } = await serverFixture(t, (_req, res) => { res.writeHead(200); res.write('{"data":['); headers(); });
  const abort = new AbortController(); const pending = discoverLocalModels([origin], abort.signal); await seen; abort.abort(); await assert.rejects(pending);
  assert.equal(http.mock.callCount(), 1);
  await assert.rejects(discoverLocalModels(["https://evil.invalid"], t.signal)); assert.equal(http.mock.callCount(), 1);
  await assert.rejects(discoverLocalModels([origin, origin, origin], t.signal)); assert.equal(http.mock.callCount(), 1);
});

test("local Laya routing/ordinary advice/assessment all accept its published four-decimal wire precision without normalization", { timeout: 5000 }, async t => {
  const { origin, http } = await serverFixture(t, (req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")); assert.equal(input.model, "laya-1.0");
      res.end(JSON.stringify({ model: input.model, usage: { input_tokens: 40, output_tokens: 0 }, answers: Object.fromEntries(Object.keys(input.questions).map(key => [key, answer])) }));
    });
  });
  const f = fixture(t); await f.invoke(`on laya ${origin}`);
  const state = await withJevSession(f.ctx, () => route({ task: "Explicit fixture", agents, softRouting: { baseline: "a" } }, t.signal));
  assert.equal(state.status, "succeeded"); if (state.status === "succeeded" && state.decision.source !== "baseline") assert.deepEqual(state.decision.probabilities, rounded);
  const option = await withJevSession(f.ctx, () => decide({ question: "Choose", context: "Fixture", options: agents.map(x => ({ id: x.name, title: x.name, description: x.description })), requiresHuman: false }, t.signal));
  assert.equal(option.status, "needs_user"); assert.equal(http.mock.callCount(), 2);
  const reply = parseAssessment({ provider: "openjev", requestedModel: "laya-1.0", model: "laya-1.0", usage: { input_tokens: 5, output_tokens: 0 },
    answers: { criterion_0: { type: "choice", choice: "unknown", confidence: 0.3333, probabilities: { met: 0.3333, unmet: 0.3333, unknown: 0.3333 } } } }, 1);
  assert.equal(reply.judgments[0]?.probabilities?.unknown, 0.3333);
});

test("default metadata discovery is exactly two anonymous model-list requests and never auto-selects a returned model", async t => {
  const f = fixture(t); const http = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.ok(["http://127.0.0.1:8080/v1/models", "http://127.0.0.1:30000/v1/models"].includes(String(url)));
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return Response.json({ data: [{ id: "Cloudflare/clef-flash" }] });
  });
  await f.invoke("backend detect"); assert.equal(http.mock.callCount(), 2); assert.equal(f.entries.length, 0);
  assert.ok(f.notices.at(-1)?.includes("/jev-subagents on clef-flash"));
});

test("local model-list deadline aborts a stalled native body and reports only bounded unavailable status", { timeout: 5000 }, async t => {
  let gotHeaders!: () => void; const headers = new Promise<void>(resolve => { gotHeaders = resolve; });
  const { origin, http } = await serverFixture(t, (_req, res) => { res.writeHead(200); res.write('{"data":["private-response-marker'); gotHeaders(); });
  const deadline = new AbortController(); t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 1500); return deadline.signal; });
  const result = discoverLocalModels([origin], t.signal); await headers; deadline.abort(); const observed = await result;
  assert.equal(observed[0]?.status, "unavailable"); assert.equal(http.mock.callCount(), 1); assert.ok(!JSON.stringify(observed).includes("private-response-marker"));
});

test("Clef pinned model mismatch accounts usage and fails without an automatic smaller-model or provider fallback", { timeout: 5000 }, async t => {
  const { origin, http } = await serverFixture(t, (_req, res) => res.end(JSON.stringify({ model: "Cloudflare/clef-flash", usage: { input_tokens: 40, output_tokens: 0 }, answers: { agent: answer } })));
  const f = fixture(t); await f.invoke(`on clef ${origin}`);
  const state = await withJevSession(f.ctx, () => route({ task: "Explicit fixture", agents }, t.signal));
  assert.equal(state.status, "failed"); if (state.status === "failed") { assert.equal(state.jev?.provider, "clef"); assert.equal(state.jev?.usage.inputTokens, 40); }
  assert.equal(http.mock.callCount(), 1);
});

test("low-level backend command missing session cannot create global/environment state", async t => {
  const f = fixture(t); const ctx = { ...f.ctx, sessionManager: undefined } as unknown as ExtensionContext;
  const state = await runBackendCommand(parseBackendAction("on laya")!, f.api, ctx, t.signal, async () => true);
  assert.equal(state.status, "failed"); assert.equal(f.entries.length, 0);
});

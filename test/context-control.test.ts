import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import fs, { mkdir, mkdtemp, realpath, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import { test, type TestContext } from "node:test";
import { AgentSession, SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_COMMAND_HELP, contextResultNotice, createManagedSession } from "../src/context-managed.ts";
import { CONTEXT_ERROR, CONTEXT_APPLICATION_FILE, reduceContext, reduceNativeApplication, managedParentAllowed, applicationDigest, validContextInput, type ContextInput, type ContextResult, type ContextState, type ContextEvent, type ContextEffect } from "../src/context-control.ts";
import { prepareContext } from "../src/context-control-effects.ts";
import { memoryHash } from "../src/context-memory.ts";
import { goalLockText, type GoalObservation } from "../src/goal-run.ts";
import { goalFileDigest } from "../src/goal-files.ts";
import { decodeGoalJournal } from "../src/goal-journal.ts";
import { manageMemory } from "../src/context-memory-effects.ts";
import { syntheticPacketCustom } from "./helpers/native-packet.ts";
import { prepareGoalRun } from "../src/goal-run-effects.ts";
import { prepareSequence } from "../src/goal-sequence-effects.ts";
import { sequenceSession, type SequenceOperation } from "../src/goal-sequence.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

async function fixture(t: TestContext, mode = "ok") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-context-"))), cwd = path.join(root, "work"), agentDir = path.join(root, "config"), journal = path.join(root, "journal");
  const before = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; await rm(root, { recursive: true, force: true }); });
  for (const dir of [cwd, agentDir, journal, path.join(agentDir, "agents")]) await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(cwd, "AGENTS.md"), "APPROVED_PROJECT_RULE: no task acceptance claims.");
  await writeFile(path.join(cwd, "value.txt"), "DO_NOT_AUTOMATICALLY_SEND_SOURCE");
  await writeFile(path.join(agentDir, "SYSTEM.md"), "DO_NOT_LOAD_GLOBAL_SYSTEM");
  await mkdir(path.join(cwd, ".pi/extensions"), { recursive: true });
  await writeFile(path.join(cwd, ".pi/extensions/no.ts"), "throw new Error('PROJECT_EXTENSION_MUST_NOT_LOAD')");
  for (const name of ["parent", "summary"]) await writeFile(path.join(agentDir, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: Offline ${name}\nmodel: offline/${name}\ntools: read,bash\n---\nUse the specified response format.\n`);
  const requests: { model: string; messages: unknown[]; tools?: unknown[] }[] = [];
  let received = () => {}; const firstRequest = new Promise<void>(resolve => { received = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const packet = JSON.parse(raw); requests.push(packet); received();
    if (mode === "hold") return;
    if (mode === "error") { res.writeHead(400); res.end('{"error":{"message":"PRIVATE_PROVIDER_FAILURE"}}'); return; }
    const content = mode === "malformed" ? "```json\n{}\n```" : JSON.stringify({ summary: "Generated claim. Human review required." });
    const delta = mode === "tool" ? { role: "assistant", tool_calls: [{ index: 0, id: "one", type: "function", function: { name: "bash", arguments: '{"command":"echo forbidden"}' } }] } : { role: "assistant", content };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 0, model: packet.model,
      choices: [{ index: 0, delta, finish_reason: mode === "tool" ? "tool_calls" : "stop" }],
      ...(mode === "missing_usage" ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { offline: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "offline-fixture-only",
    models: ["parent", "summary"].map(id => ({ id, reasoning: false, contextWindow: 131072, maxTokens: 1024, cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 } })) } } }));
  const fork = childProcess.fork;
  const launches = t.mock.method(childProcess, "fork", (file: string | URL, args: readonly string[], options: childProcess.ForkOptions) => fork(file, args,
    { ...options, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) } }));
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("External HTTP forbidden"); });
  const sm = SessionManager.inMemory(cwd);
  for (let i = 0; i < 8; i++) {
    sm.appendMessage({ role: "user", content: `UNAPPROVED_PARENT_HISTORY_${i} `.repeat(1400), timestamp: i });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Historical answer." }], api: "openai-completions", provider: "offline", model: "parent", timestamp: i,
      stopReason: "stop", usage: { input: 40000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40010, cost: { input: 0.04, output: 0.00003, cacheRead: 0, cacheWrite: 0, total: 0.04003 } } });
  }
  const managed = await createManagedSession({ cwd, agentDirectory: agentDir, parent: "parent", sessionManager: sm });
  t.after(() => managed.dispose());
  const initial = structuredClone(sm.getBranch()), notifications: string[] = [];
  let approvals = 0;
  // This is an SDK print-mode session; provide its public native confirmation API.
  const approve = async () => {
    approvals++;
    if (mode === "expired" && approvals === 1) { const late = Date.now() + 61_000; t.mock.method(Date, "now", () => late); }
    if (mode === "branch_change" && approvals === 2) sm.appendMessage({ role: "user", content: "EXTERNAL_BRANCH_CHANGE", timestamp: Date.now() });
    if (mode === "profile_change" && approvals === 1) await writeFile(path.join(agentDir, "agents/summary.md"), "CHANGED_PROFILE");
    if (mode === "invalid_ui_receipt" && approvals === 1 || mode === "invalid_apply_receipt" && approvals === 2) return "yes";
    return !(mode === "decline" && approvals === 1 || mode === "decline_apply" && approvals === 2);
  };
  const ui = { confirm: approve, custom: async () => { throw new Error("Print-mode native review must never use TUI/custom"); },
    notify: (text: string) => { notifications.push(text); } } as unknown as ExtensionUIContext;
  await managed.session.bindExtensions({ uiContext: ui });
  const input: ContextInput = { agent: "summary", journalDirectory: journal, notes: "Only these explicitly chosen notes may be summarized.",
    preserve: { goal: "Finish the bounded work", scope: "Only the approved file", constraints: ["Keep original restrictions"], nonGoals: ["No extra worker"],
      remaining: ["One unresolved item"], failedChecks: ["DECLARED_CHECK_FAILED_42"], uncertainties: ["Claims are not verified"], currentTurn: "Continue review, not execution" } };
  const invoke = async () => {
    const start = notifications.length;
    await managed.session.prompt(`/jev_compact ${JSON.stringify(input)}`);
    const text = notifications.slice(start).findLast(value => value.startsWith("{")) ?? notifications.at(-1)!;
    assert.ok(!text.includes("PRIVATE_PROVIDER_FAILURE"));
    return text.startsWith("{") ? JSON.parse(text) as ContextResult : text;
  };
  const waitForFirstRequest = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([firstRequest, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Expected loopback summary request did not arrive within 15 seconds.")), 15000);
      })]);
    } finally { clearTimeout(timer); }
  };
  return { cwd, root, agentDir, journal, input, managed, sm, initial, requests, fetch, launches, waitForFirstRequest, invoke, approvals: () => approvals, notifications };
}

test("managed help, syntax and schema hints never echo private input or start native/model work", async t => {
  const native = AgentSession.prototype.compact;
  const calls = t.mock.method(AgentSession.prototype, "compact", function (this: AgentSession, ...args: Parameters<typeof native>) { return Reflect.apply(native, this, args); });
  const f = await fixture(t);
  const extension = f.managed.resourceLoader.getExtensions().extensions[0]!;
  assert.equal(extension.handlers.has("session_start"), false); assert.equal(extension.handlers.has("before_agent_start"), false);
  assert.equal(extension.commands.has("jev-subagents"), false);
  for (const suffix of ["", " --help", " help"]) {
    await f.managed.session.prompt(`/jev_compact${suffix}`); assert.equal(f.notifications.at(-1), CONTEXT_COMMAND_HELP);
  }
  const example = CONTEXT_COMMAND_HELP.split("\n").find(line => line.startsWith("/jev_compact {")); assert.ok(example);
  assert.equal(validContextInput(JSON.parse(example.slice("/jev_compact ".length))), true);
  for (const [raw, hint] of [
    ['{"PRIVATE_INPUT":', "JSON syntax"],
    [JSON.stringify({ ...f.input, agent: "PRIVATE_INPUT" }), "/agent"],
    [JSON.stringify({ ...f.input, preserve: { ...f.input.preserve, remaining: "PRIVATE_INPUT" } }), "/preserve/remaining"],
    [JSON.stringify({ ...f.input, PRIVATE_INPUT: "PRIVATE_VALUE" }), "additional fields forbidden"],
    [JSON.stringify({ ...f.input, notes: "비공개 입력을 그대로 보내세요" }), "English summaries"],
    [JSON.stringify({ ...f.input, notes: "PRIVATE_INPUT\u0000" }), "UTF-8"],
    [JSON.stringify({ ...f.input, journalDirectory: "/PRIVATE_INPUT" + String.fromCharCode(0) }), "UTF-8"],
    [JSON.stringify({ ...f.input, journalDirectory: "/PRIVATE_INPUT" + String.fromCharCode(0xd800) }), "UTF-8"],
  ]) {
    await f.managed.session.prompt(`/jev_compact ${raw}`);
    const notice = f.notifications.at(-1)!; assert.ok(notice.includes(hint!)); assert.match(notice, /Nothing executed|without translation, model calls or execution/);
    assert.equal(notice.includes("PRIVATE_INPUT"), false); assert.equal(notice.includes("PRIVATE_VALUE"), false);
  }
  assert.equal(calls.mock.callCount(), 0); assert.equal(f.requests.length, 0); assert.equal(f.approvals(), 0); assert.equal(f.launches.mock.callCount(), 0);
  assert.deepEqual(f.sm.getBranch(), f.initial); await assert.rejects(lstat(path.join(f.cwd, ".jev-goal.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.journal, "goal.jsonl")), { code: "ENOENT" });
});

test("managed input hints identify each missing required field and safe error categories", async t => {
  const f = await fixture(t);
  for (const field of ["agent", "journalDirectory", "notes", "preserve"]) {
    const input: Record<string, unknown> = structuredClone(f.input); delete input[field];
    await f.managed.session.prompt(`/jev_compact ${JSON.stringify(input)}`);
    assert.ok(f.notifications.at(-1)?.includes(`/${field}: missing required field`), field);
  }
  for (const field of Object.keys(f.input.preserve)) {
    const preserve: Record<string, unknown> = structuredClone(f.input.preserve); delete preserve[field];
    await f.managed.session.prompt(`/jev_compact ${JSON.stringify({ ...f.input, preserve })}`);
    assert.ok(f.notifications.at(-1)?.includes(`/preserve/${field}: missing required field`), field);
  }
  for (const [input, expected] of [
    [{ ...f.input, notes: "PRIVATE_INPUT".repeat(1000) }, "/notes: length limit exceeded"],
    [{ ...f.input, preserve: { ...f.input.preserve, remaining: Array(9).fill("PRIVATE_INPUT") } }, "/preserve/remaining: item limit exceeded"],
    [{ ...f.input, preserve: { ...f.input.preserve, remaining: "PRIVATE_INPUT" } }, "/preserve/remaining: type mismatch"],
    [{ ...f.input, preserve: { ...f.input.preserve, PRIVATE_INPUT: "PRIVATE_VALUE" } }, "/preserve: additional fields forbidden"],
  ] as const) {
    await f.managed.session.prompt(`/jev_compact ${JSON.stringify(input)}`);
    const notice = f.notifications.at(-1)!; assert.ok(notice.includes(expected)); assert.equal(notice.includes("PRIVATE_INPUT"), false);
    assert.equal(notice.includes("PRIVATE_VALUE"), false);
  }
  assert.equal(f.requests.length, 0); assert.equal(f.approvals(), 0); assert.equal(f.launches.mock.callCount(), 0); assert.deepEqual(f.sm.getBranch(), f.initial);
});

test("managed launcher help is usable without a TTY, but execution still requires one", async t => {
  const f = await fixture(t), script = fileURLToPath(new URL("../scripts/managed.ts", import.meta.url));
  const options = { cwd: f.cwd, env: { PATH: process.env.PATH, HOME: f.root, PI_CODING_AGENT_DIR: f.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    encoding: "utf8" as const, timeout: 10_000, maxBuffer: 16_384 };
  const help = childProcess.spawnSync(process.execPath, [script, "--help"], options);
  assert.ifError(help.error); assert.equal(help.status, 0); assert.ok(help.stdout.includes(CONTEXT_COMMAND_HELP)); assert.match(help.stdout, /--parent/);
  const refused = childProcess.spawnSync(process.execPath, [script, "--parent", "parent"], options);
  assert.ifError(refused.error); assert.equal(refused.status, 1); assert.match(refused.stderr, /real TTY/);
  assert.equal(f.requests.length, 0); assert.equal(f.approvals(), 0);
  await assert.rejects(lstat(path.join(f.agentDir, "sessions")), { code: "ENOENT" });
});

test("owned-project refusal explains preservation without reading or disclosing the marker", async t => {
  const f = await fixture(t), marker = path.join(f.cwd, ".jev-goal.lock");
  await writeFile(marker, "PRIVATE_OWNER_CONTENT", { mode: 0o600 });
  const result = await f.invoke(); assert.equal(typeof result, "string"); assert.match(String(result), /never bypass by deleting the lock or changing paths/);
  assert.equal(f.notifications.join("\n").includes("PRIVATE_OWNER_CONTENT"), false); assert.equal(await readFile(marker, "utf8"), "PRIVATE_OWNER_CONTENT");
  assert.equal(f.approvals(), 0); assert.equal(f.requests.length, 0); assert.equal(f.launches.mock.callCount(), 0);
});

test("context notices distinguish cancellation, application, unknown cost and incomplete cleanup", () => {
  const base: ContextResult = { status: "cancelled", application: "not_applied", sessionDurability: "not_asserted", ledger: null, cleanupConfirmed: true, lockRetained: false };
  const cancelled = contextResultNotice(base); assert.match(cancelled, /cancelled/); assert.match(cancelled, /unknown\(null\)/); assert.doesNotMatch(cancelled, /USD 0/);
  const anchor = String.fromCodePoint(0xbb38, 0xc81c, 0x2d, 0xc0c1, 0xd669, 0xbcc4, 0x2d, 0xd655, 0xc778);
  assert.ok(cancelled.includes(`docs/context-management.md#${anchor}`), "Keep the existing documentation anchor, not a translated identifier");
  const applied = contextResultNotice({ ...base, application: "applied_in_session" });
  assert.match(applied, /cancelled/); assert.match(applied, /applied in this session/); assert.match(applied, /does not roll back/); assert.match(applied, /fsync unconfirmed/);
  const unknown = contextResultNotice({ ...base, status: "needs_review", application: "unknown", lockRetained: true });
  assert.match(unknown, /application unknown/); assert.match(unknown, /Remain stopped/); assert.match(unknown, /owner.lock/); assert.doesNotMatch(unknown, /This cleanup is confirmed/);
  const incomplete = contextResultNotice({ ...base, status: "needs_review", application: "applied_in_session", cleanupConfirmed: false });
  assert.match(incomplete, /applied in this session/); assert.match(incomplete, /Remain stopped/); assert.doesNotMatch(incomplete, /This cleanup is confirmed/);
});

test("managed native SDK compaction uses one isolated summary, two approvals and no parent/default summary call", async t => {
  const f = await fixture(t);
  const result = await f.invoke(); assert.notEqual(typeof result, "string", String(result)); if (typeof result === "string") return;
  assert.equal(result.status, "applied"); assert.equal(result.application, "applied_in_session"); assert.equal(result.sessionDurability, "not_asserted");
  assert.equal(f.approvals(), 2); assert.equal(f.requests.length, 1); assert.equal(f.requests[0]?.model, "summary"); assert.equal(f.fetch.mock.callCount(), 0);
  assert.deepEqual(f.requests[0]?.tools ?? [], []);
  for (const forbidden of ["UNAPPROVED_PARENT_HISTORY", "DO_NOT_AUTOMATICALLY_SEND_SOURCE", "DO_NOT_LOAD_GLOBAL_SYSTEM", "auth.json", "offline-fixture-only"])
    assert.equal(JSON.stringify(f.requests[0]).includes(forbidden), false);
  assert.match(JSON.stringify(f.requests[0]), /APPROVED_PROJECT_RULE/);
  assert.equal(result.ledger?.spent.summaryCalls, 1); assert.equal(result.ledger?.spent.workerCalls, 0); assert.ok(Math.abs((result.ledger?.totalUsd ?? Infinity) - 0.00005) < 1e-12);
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.lockRetained, false);
  assert.match(f.notifications.at(-1)!, /JEV context: applied/); assert.match(f.notifications.at(-1)!, /USD 0.00005/); assert.match(f.notifications.at(-1)!, /parent cost excluded/);
  assert.ok(result.ledger); assert.match(contextResultNotice({ ...result, ledger: { ...result.ledger, totalUsd: 1e-12, observedUsd: 1e-12 } }), /USD 1e-12/);
  const after = f.sm.getBranch(); assert.deepEqual(after.slice(0, -1), f.initial);
  const entry = after.at(-1); assert.equal(entry?.type, "compaction"); if (entry?.type !== "compaction") return;
  assert.ok(f.managed.session.messages.some(message => message.role === "compactionSummary"));
  assert.equal(JSON.stringify(f.managed.session.messages).includes("UNAPPROVED_PARENT_HISTORY_0"), false);
  assert.equal(f.managed.session.getContextUsage()?.tokens, null);
  assert.match(entry.summary, /DECLARED_CHECK_FAILED_42/); assert.match(entry.summary, /none is restored/); assert.match(entry.summary, /One unresolved item/);
  const journal = decodeGoalJournal(await readFile(path.join(f.journal, "goal.jsonl"))); assert.deepEqual(journal.ledger, result.ledger);
  const applied = (await readFile(path.join(f.journal, CONTEXT_APPLICATION_FILE), "utf8")).trim().split("\n").map(x => JSON.parse(x));
  assert.deepEqual(applied.map(x => x.kind), ["intent", "applied"]); assert.equal(applied[1].entryId, entry.id);
  assert.equal((await readFile(path.join(f.journal, CONTEXT_APPLICATION_FILE), "utf8")).includes("Generated claim"), false);
  await assert.rejects(lstat(path.join(f.cwd, ".jev-goal.lock")), { code: "ENOENT" });
  await assert.rejects(f.managed.session.compact()); assert.equal(f.requests.length, 1);
});

test("managed summary refusals, changed scope and invalid/partial model replies never apply or retry", async t => {
  for (const mode of ["decline", "expired", "decline_apply", "invalid_ui_receipt", "invalid_apply_receipt", "profile_change", "branch_change", "malformed", "tool", "error", "missing_usage"]) await t.test(mode, async t => {
    const f = await fixture(t, mode), result = await f.invoke(); assert.notEqual(typeof result, "string", String(result)); if (typeof result === "string") return;
    assert.notEqual(result.status, "applied"); assert.equal(result.application, "not_applied");
    assert.equal(f.requests.length, ["decline", "expired", "invalid_ui_receipt", "profile_change"].includes(mode) ? 0 : 1);
    assert.equal(f.sm.getBranch().some(x => x.type === "compaction"), false);
    if (["tool", "error", "missing_usage"].includes(mode)) assert.equal(result.ledger?.totalUsd, null);
    if (["decline_apply", "invalid_apply_receipt"].includes(mode)) assert.equal(result.ledger?.spent.summaryCalls, 1);
    if (mode.startsWith("invalid_")) { assert.equal(result.status, "cancelled"); await assert.rejects(lstat(path.join(f.cwd, ".jev-goal.lock")), { code: "ENOENT" }); }
  });
});

test("Goal workers receive only an explicitly approved bounded memory bundle, never the planner or direct store access", async t => {
  const f = await fixture(t), directory = path.join(f.root, "memory"); await mkdir(directory, { mode: 0o700 });
  const memory = await manageMemory({ action: "append", directory, note: { topic: "fixture", text: "REFERENCE_ONLY_MEMORY", origin: "model_claim", reference: "Not independently verified" } },
    { cwd: f.cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "legacy-worker-memory-fixture" }, ui: { custom: syntheticPacketCustom() } } as unknown as ExtensionContext);
  assert.ok(memory.bundle);
  const input = { task: "Read the approved file", agent: "summary", files: [{ path: "value.txt", access: "read" as const }], journalDirectory: f.journal, memory: memory.bundle };
  const grant = await prepareGoalRun({ cwd: f.cwd, input }); assert.deepEqual(JSON.parse(grant.body.prompt).memory, memory.bundle);
  const sequence = await prepareSequence({ cwd: f.cwd, input: { ...input, planner: "parent", acceptanceCriteria: ["Review done"], nonGoals: [], maxModelCalls: 1,
    budget: { workerRuns: 1, plannerCalls: 1, workerCalls: 1, totalCalls: 2, durationSeconds: 60 } } });
  const operation: SequenceOperation = { id: `${sequence.intentId}-planner-1`, kind: "planner", scope: sequence.body.files, history: [], proposal: null, deadline: sequence.body.deadline };
  assert.equal(sequenceSession(sequence, operation).prompt.includes("REFERENCE_ONLY_MEMORY"), false);
  assert.equal(sequenceSession(sequence, operation).systemPrompt.includes("REFERENCE_ONLY_MEMORY"), false);
  const worker = sequenceSession(sequence, { ...operation, kind: "worker", proposal: { action: "work", criteriaIds: ["criterion-1"], task: "Read the file" } });
  assert.deepEqual(JSON.parse(worker.prompt).memory, memory.bundle); assert.match(worker.systemPrompt, /not a fresh verification/);
  await assert.rejects(prepareGoalRun({ cwd: f.cwd, input: { ...input, memory: { ...memory.bundle, project: { ...memory.bundle.project, path: "/foreign" } } } }));
  assert.equal(f.requests.length, 0);
});

test("pure managed gates are one-shot, deterministic and deny stale, foreign, automatic or unknown accounting paths", () => {
  const source = { sessionId: "session", leafId: "leaf", branchDigest: "a".repeat(64), systemPromptDigest: "b".repeat(64), firstKeptEntryId: "keep", tokensBefore: 2000, entries: 2, splitTurn: true };
  const state = Object.freeze({ status: "armed" as const, source: Object.freeze(source), deadline: 100 });
  const event = Object.freeze({ type: "before" as const, source, now: 99, current: true, aborted: false, reason: "manual", willRetry: false });
  const next = reduceNativeApplication(state, event); assert.deepEqual(next.effects, [{ type: "supply_summary" }]); assert.deepEqual(next, reduceNativeApplication(state, event));
  assert.deepEqual(reduceNativeApplication(next.state, event).effects, []);
  for (const change of [{ now: 100 }, { now: NaN }, { aborted: true }, { current: false }, { willRetry: true }, { reason: "overflow" }, { source: { ...source, branchDigest: "c".repeat(64) } }])
    assert.deepEqual(reduceNativeApplication(state, { ...event, ...change }).effects, []);
  const observation = { owned: true, busy: false, aborted: false, autoCompaction: false, autoRetry: false, tokens: null, estimatedTokens: 100, contextWindow: 1000 };
  assert.equal(managedParentAllowed(observation), true);
  for (const change of [{ owned: false }, { busy: true }, { aborted: true }, { autoCompaction: true }, { autoRetry: true }, { estimatedTokens: 850 }, { estimatedTokens: NaN }, { tokens: NaN }])
    assert.equal(managedParentAllowed({ ...observation, ...change }), false);
  const denied = reduceContext({ status: "idle" }, { type: "start", input: {} as ContextInput, available: false });
  assert.equal(denied.state.status, "closing"); assert.deepEqual(denied.effects, [{ type: "close_context", keep: false }]);
  const done = reduceContext(denied.state, { type: "closed", ok: true, retained: false });
  assert.deepEqual(reduceContext(done.state, { type: "cancel" }), { state: done.state, effects: [] });
  assert.equal(CONTEXT_ERROR.includes("No retry"), true);
});

function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; }

test("context reducer replays immutable correlated transitions, including cancellation, lost acknowledgement and unknown application", async t => {
  const f = await fixture(t), source = { sessionId: f.sm.getSessionId(), leafId: f.sm.getLeafId()!, branchDigest: memoryHash(f.sm.getBranch()),
    systemPromptDigest: memoryHash(f.managed.session.systemPrompt), firstKeptEntryId: f.initial[0]!.id, tokensBefore: 40000, entries: f.initial.length, splitTurn: false };
  const grant = await prepareContext(f.input, f.cwd, source), lockText = goalLockText(grant);
  for (const mode of ["ok", "cancel_worker", "cancel_apply", "storage_lost", "unknown_apply", "unknown_cleanup", "bad_clock"]) {
    let state: ContextState = { status: "idle" }, queue: ContextEffect[] = [], now = grant.body.preparedAt + 1;
    const send = (event: ContextEvent) => {
      const before = structuredClone(state), next = reduceContext(freeze(state), freeze(event));
      assert.deepEqual(state, before); assert.deepEqual(next, reduceContext(state, event)); state = next.state; queue.push(...next.effects);
    };
    send({ type: "start", input: f.input, available: true });
    let steps = 0;
    while (queue.length && ++steps < 30) {
      const effect = queue.shift()!;
      switch (effect.type) {
        case "prepare_context": send({ type: "prepared", grant }); break;
        case "confirm_context": {
          const before: ContextState = state; send({ type: "approval", digest: "foreign", approved: true, now: now++ }); assert.equal(state, before);
          send({ type: "approval", digest: grant.ref.scopeDigest, approved: true, now: now++ }); break;
        }
        case "open_context": send({ type: "opened", lockVersion: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: goalFileDigest(lockText), bytes: Buffer.byteLength(lockText) }, now: now++ }); break;
        case "context_control": {
          const action = effect.effect;
          if (action.type === "append_goal") {
            send({ type: "control", event: mode === "storage_lost" && action.record.type === "settled" ?
              { type: "storage_failed", expected: action.expected, record: action.record } :
              { type: "persisted", expected: action.expected, record: action.record, head: { sequence: action.expected.sequence + 1, hash: memoryHash(action.record) }, now: now++ } });
          } else if (action.type === "check_goal_admission") send({ type: "control", event: { type: "admission", ref: action.ref, activationId: action.activationId,
            intentId: action.intent.id, head: action.head, current: true, now: now++ } });
          else if (action.type === "dispatch_goal_operation") {
            if (mode === "cancel_worker") send({ type: "cancel" });
            const stats = { turns: 1, usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 };
            const observation: GoalObservation = { started: true, cleanupConfirmed: mode !== "unknown_cleanup", result: { type: "goal_result",
              files: { operations: 0, readBytes: 0, writtenBytes: 0, changed: false, uncertain: false, finished: true }, reply: { type: "completed",
                report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "reported", complete: mode !== "cancel_worker", stats } },
                result: { ...stats, text: '{"summary":"Bounded claim"}', truncated: false } } } };
            send({ type: "observed", observation, now: mode === "bad_clock" ? NaN : now++ });
          }
          break;
        }
        case "confirm_application": send({ type: "apply_approval", digest: applicationDigest(effect.view), approved: true, now: now++ }); break;
        case "record_intent": send({ type: "recorded", kind: "intent", digest: applicationDigest(effect.view) }); break;
        case "apply_context":
          if (mode === "cancel_apply") send({ type: "cancel" });
          send({ type: "applied", application: mode === "unknown_apply" ? "unknown" : "applied_in_session", entryId: "new-entry" }); break;
        case "record_application": send({ type: "recorded", kind: "applied", digest: applicationDigest(effect.view) }); break;
        case "close_context": send({ type: "closed", ok: true, retained: effect.keep }); break;
        case "abort_context": break;
      }
    }
    assert.ok(steps < 30); const final = state as ContextState; assert.equal(final.status, "done", mode); if (final.status !== "done") continue;
    assert.equal(final.result.application, ["ok", "cancel_apply"].includes(mode) ? "applied_in_session" : mode === "unknown_apply" ? "unknown" : "not_applied", mode);
    assert.equal(final.result.status, mode.startsWith("cancel") ? "cancelled" : mode === "ok" ? "applied" : "needs_review", mode);
    if (["cancel_worker", "storage_lost", "unknown_cleanup", "bad_clock"].includes(mode)) assert.equal(final.result.ledger?.totalUsd, null, mode);
    if (mode === "storage_lost") assert.equal(final.result.unconfirmedRecord?.type, "settled");
    for (const event of [{ type: "cancel" }, { type: "applied", application: "applied_in_session", entryId: "late" }] as const)
      assert.deepEqual(reduceContext(final, event), { state: final, effects: [] });
  }
  assert.equal(f.requests.length, 0);
});

test("lost summary settlement or native-application sync acknowledgement never grants a retry or hides an observed application", async t => {
  for (const mode of ["settlement", "intent", "applied"]) await t.test(mode, async t => {
    const f = await fixture(t), nativeOpen = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args), filename = String(args[0]);
      if (filename === path.join(f.journal, mode === "settlement" ? "goal.jsonl" : CONTEXT_APPLICATION_FILE)) {
        const sync = handle.sync.bind(handle);
        Object.defineProperty(handle, "sync", { configurable: true, value: async () => {
          await sync(); const text = await readFile(filename, "utf8");
          if (text.includes(mode === "settlement" ? '"type":"settled"' : `"kind":"${mode}"`)) throw new Error("PRIVATE_SYNC_ACK_LOST");
        } });
      }
      return handle;
    });
    syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const result = await f.invoke(); assert.notEqual(typeof result, "string"); if (typeof result === "string") return;
    assert.equal(result.status, "needs_review"); assert.equal(result.lockRetained, true); assert.equal(f.requests.length, 1);
    assert.equal(result.application, mode === "applied" ? "applied_in_session" : "not_applied");
    assert.equal(f.sm.getBranch().some(x => x.type === "compaction"), mode === "applied");
    assert.equal(JSON.stringify(result).includes("PRIVATE_SYNC_ACK_LOST"), false);
    if (mode === "settlement") { assert.equal(result.ledger?.totalUsd, null); assert.equal(result.ledger?.held.summaryCalls, 1); assert.equal(result.unconfirmedRecord?.type, "settled"); }
    await lstat(path.join(f.cwd, ".jev-goal.lock"));
  });
});

test("public compaction cannot enter native auth/preparation or borrow an active managed hook", async t => {
  const compact = AgentSession.prototype.compact;
  const calls = t.mock.method(AgentSession.prototype, "compact", function (this: AgentSession, ...args: Parameters<typeof compact>) { return Reflect.apply(compact, this, args); });
  const f = await fixture(t, "hold");
  await assert.rejects(f.managed.session.compact(), { message: CONTEXT_ERROR }); assert.equal(calls.mock.callCount(), 0);
  const attempts: Promise<void>[] = [];
  t.after(f.managed.session.subscribe(event => {
    if (event.type === "compaction_start") attempts.push(assert.rejects(f.managed.session.compact(), { message: CONTEXT_ERROR }));
  }));
  const running = f.invoke(); await f.waitForFirstRequest(); await Promise.all(attempts); assert.equal(attempts.length, 1);
  assert.equal(calls.mock.callCount(), 1); // Native prepare probe only; the summary child is held.
  await assert.rejects(f.managed.session.compact(), { message: CONTEXT_ERROR }); assert.equal(calls.mock.callCount(), 1);
  await f.managed.dispose(); await running;
  assert.equal(f.requests.length, 1); assert.equal(f.sm.getBranch().some(x => x.type === "compaction"), false);
});

test("a native log entry alone is not proof that the active parent context was replaced", async t => {
  for (const mode of ["append_ack", "build_context"]) await t.test(mode, async t => {
    const f = await fixture(t);
    const errors: string[] = [];
    t.after(f.managed.session.subscribe(event => { if (event.type === "compaction_end" && event.errorMessage) errors.push(event.errorMessage); }));
    if (mode === "append_ack") {
      const append = f.sm.appendCompaction;
      t.mock.method(f.sm, "appendCompaction", (...args: Parameters<typeof append>) => { Reflect.apply(append, f.sm, args); throw new Error("PRIVATE_NATIVE_FAILURE"); });
    } else t.mock.method(f.sm, "buildSessionContext", () => { throw new Error("PRIVATE_NATIVE_FAILURE"); });
    const result = await f.invoke(); assert.notEqual(typeof result, "string"); if (typeof result === "string") return;
    assert.equal(result.status, "needs_review"); assert.equal(result.application, "unknown"); assert.equal(result.lockRetained, true);
    assert.equal(f.requests.length, 1); assert.equal(f.sm.getLeafEntry()?.type, "compaction");
    assert.equal(f.managed.session.messages.some(message => message.role === "compactionSummary"), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE_NATIVE_FAILURE"), false);
    assert.deepEqual(errors, [CONTEXT_ERROR]);
  });
});

test("managed session shutdown cancels the actual bounded summary worker and retains unknown accounting", async t => {
  const f = await fixture(t, "hold"), running = f.invoke(); await f.waitForFirstRequest(); await f.managed.dispose();
  const result = await running; assert.notEqual(typeof result, "string"); if (typeof result === "string") return;
  assert.equal(result.status, "cancelled"); assert.equal(result.application, "not_applied"); assert.equal(result.ledger?.totalUsd, null);
  assert.equal(result.lockRetained, true); assert.equal(f.requests.length, 1); assert.equal(f.launches.mock.callCount(), 1);
  assert.equal(f.sm.getBranch().some(x => x.type === "compaction"), false);
});

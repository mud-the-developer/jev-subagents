import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, lstat, open, rm, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { goalRun, prepareGoalRun, openGoalProjectLock, checkGoalLease, checkGoalContext, goalControlFileIO } from "../src/goal-run-effects.ts";
import { GOAL_RUN_ERROR, GOAL_PROJECT_LOCK, reduceGoalRun, settlementFor, validGoalGrant, reduceGoalExecution,
  GoalRunInputSchema, EMPTY_FILE_REPORT, type GoalRunInput, type GoalRunState, type GoalObservation } from "../src/goal-run.ts";
import { reduceGoalFiles } from "../src/goal-files.ts";
import { decodeGoalJournal } from "../src/goal-journal.ts";

async function fixture(t: TestContext, mode = "edit") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "jev-goal-run-"))), cwd = path.join(root, "work"), agentDir = path.join(root, "config"), journal = path.join(root, "journal");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(root, { recursive: true, force: true }); });
  for (const dir of [cwd, agentDir, journal, path.join(agentDir, "agents"), path.join(cwd, "src")]) await mkdir(dir, { mode: 0o700 });
  const file = path.join(cwd, "src/fixture.txt"), rules = path.join(cwd, "AGENTS.md");
  await writeFile(file, "BEFORE\n"); await writeFile(rules, "Only change the approved fixture. Keep uncertainty explicit.");
  await writeFile(path.join(agentDir, "agents/worker.md"), "---\nname: worker\ndescription: Offline Goal worker\nmodel: offline/offline-worker\ntools: read,edit,write,bash\n---\nFollow the exact task and applicable instructions.\n");
  await writeFile(path.join(agentDir, "SYSTEM.md"), "UNAPPROVED_GLOBAL_PROMPT");
  await mkdir(path.join(cwd, ".pi/extensions"), { recursive: true });
  await writeFile(path.join(cwd, ".pi/extensions/forbidden.ts"), 'throw new Error("PROJECT_EXTENSION_MUST_NOT_LOAD");');
  const requests: { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }[] = [];
  let received = () => {};
  const firstRequest = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body)); received();
    if (mode === "hold") return;
    if (mode === "error") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "offline-private-provider-error" } })); return; }
    const first = requests.length === 1, toolCall = first || mode === "loop";
    if (mode === "lease") {
      // The Windows held marker correctly denies another writer. Mutate owned fixture
      // metadata instead; a changed native version must revoke the exact lease just as bytes do.
      if (process.platform === "win32") await chmod(path.join(cwd, GOAL_PROJECT_LOCK), 0o400);
      else await writeFile(path.join(cwd, GOAL_PROJECT_LOCK), "changed owner");
    }
    if (mode === "last_change" && !first) await writeFile(file, "EXTERNAL\n");
    const name = mode === "bash" ? "bash" : "goal_edit";
    const args = mode === "bash" ? { command: "touch should-never-exist" } : mode === "path" ? { path: file, fileId: "file-1", oldText: "BEFORE", newText: "AFTER" }
      : { fileId: mode === "foreign" ? "file-999" : "file-1", oldText: first ? "BEFORE" : "AFTER", newText: "AFTER" };
    const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "Changed the approved file. No checks were run." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "offline-worker",
      choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }],
      ...(mode === "missing_usage" ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { offline: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "offline-goal-model-key", models: [{ id: "offline-worker", reasoning: false,
      contextWindow: 65536, maxTokens: 1024, cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 } }],
  } } }));
  const nativeFork = childProcess.fork;
  const launches = t.mock.method(childProcess, "fork", (modulePath: string | URL, args: readonly string[], options: childProcess.ForkOptions) => nativeFork(modulePath, args, {
    ...options, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) },

  }));
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No external HTTP in Goal tests"); });
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const ctx = { cwd, hasUI: true, ui: { confirm } } as unknown as ExtensionContext;
  const input: GoalRunInput = { task: "Replace BEFORE with AFTER in the approved file, then stop.", agent: "worker", journalDirectory: journal,
    files: [{ path: "src/fixture.txt", access: "read_write" }], maxModelCalls: 2, acceptanceCriteria: ["Only the requested fixture changes."] };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("./helpers/legacy-goal-extension.ts", import.meta.url))] });
  await loader.reload();
  const loaded = loader.getExtensions(); t.after(() => loaded.runtime.invalidate());
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0]!, tools = [...extension.tools.values()].map((entry) => entry.definition);
  const handlers = { has: (name: string) => extension.handlers.has(name), get: (name: string) => extension.handlers.has(name) ? async () => {
    for (const handler of extension.handlers.get(name)!) await Reflect.apply(handler, undefined, [{ type: name }, ctx]);
  } : undefined };
  const tool = tools.find((entry) => entry.name === "jev_goal")!;
  const invoke = (signal?: AbortSignal) => tool.execute("offline-goal", input, signal, undefined, ctx);
  const inspect = async () => decodeGoalJournal(await readFile(path.join(journal, "goal.jsonl")));
  const prepare = () => prepareGoalRun({ cwd, input }, t.signal);
  return { root, cwd, file, rules, agentDir, journal, input, ctx, confirm, tools, tool, handlers, invoke, inspect, prepare, requests, firstRequest, launches, fetch };
}
function result(state: GoalRunState) { assert.equal(state.status, "done"); if (state.status !== "done") throw new Error("Not terminal"); return state.result; }
function toolFailure(value: unknown) {
  assert.ok(value instanceof Error); assert.ok(!value.message.includes("offline-private"));
  return JSON.parse(value.message.slice(value.message.indexOf("\n") + 1));
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const part of Object.values(value)) freeze(part); } return value; }

test("fresh Windows controls batch paired metadata but re-read hashes and refuse changed context before workers", { skip: process.platform !== "win32", timeout: 30000 }, async t => {
  const f = await fixture(t), groups: string[][] = [], native = goalControlFileIO.snapshot;
  t.mock.method(goalControlFileIO, "snapshot", async (paths: readonly string[], signal?: AbortSignal) => { groups.push([...paths]); return native(paths, signal); });
  const grant = await f.prepare(), pair = [path.join(f.agentDir, "agents/worker.md"), path.join(f.agentDir, "models.json")];
  const contextPaths = grant.body.context.map(entry => entry.path);
  assert.deepEqual(groups, [pair, pair, contextPaths, contextPaths]);
  await checkGoalContext(grant, t.signal); assert.equal(groups.length, 5); assert.deepEqual(groups.at(-1), contextPaths);
  await writeFile(f.rules, "Changed after the exact snapshot.");
  await assert.rejects(checkGoalContext(grant, t.signal), { message: GOAL_RUN_ERROR }); assert.equal(groups.length, 6);
  assert.equal(f.requests.length, 0); assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.confirm.mock.callCount(), 0);
});

test("fresh Windows controls preserve before/after profile race checks without caching model metadata", { skip: process.platform !== "win32", timeout: 30000 }, async t => {
  const f = await fixture(t), native = goalControlFileIO.snapshot; let calls = 0;
  t.mock.method(goalControlFileIO, "snapshot", async (paths: readonly string[], signal?: AbortSignal) => {
    const result = await native(paths, signal);
    if (++calls === 1) await writeFile(path.join(f.agentDir, "agents/worker.md"), (await readFile(path.join(f.agentDir, "agents/worker.md"), "utf8")).replace("Offline Goal worker", "Changed Goal worker"));
    return result;
  });
  await assert.rejects(f.prepare(), { message: GOAL_RUN_ERROR }); assert.equal(calls, 2);
  assert.equal(f.requests.length, 0); assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.confirm.mock.callCount(), 0);
});

test("fresh Windows controls failed batch never retries or falls back to unverified singleton reads", { skip: process.platform !== "win32", timeout: 30000 }, async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(goalControlFileIO, "snapshot", async () => { calls++; throw new Error("Synthetic batch failure"); });
  await assert.rejects(f.prepare(), { message: GOAL_RUN_ERROR }); assert.equal(calls, 1);
  assert.equal(f.requests.length, 0); assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.confirm.mock.callCount(), 0);
});

test("B2 pure grant approval is owned, correlated, bounded, and never accepts model approval parameters", async (t) => {
  const f = await fixture(t), original = structuredClone(f.input), preparing = f.prepare();
  f.input.agent = "missing"; f.input.journalDirectory = "/unapproved-directory";
  const grant = await preparing;
  Object.assign(f.input, original);
  assert.deepEqual(grant.body.request.input, original);
  assert.ok(validGoalGrant(grant));
  assert.ok(!JSON.stringify(grant).includes("offline-goal-model-key"));
  assert.equal(grant.body.context.find((entry) => entry.path.endsWith("worker.md"))?.text, null);
  const started = reduceGoalRun({ status: "idle" }, { type: "start", job: { cwd: f.cwd, input: f.input }, hasUI: true });
  const event = freeze({ type: "prepared" as const, grant });
  const prepared = reduceGoalRun(freeze(started.state), event);
  assert.deepEqual(prepared, reduceGoalRun(started.state, event));
  assert.equal(prepared.state.status, "awaiting_approval");
  const wrong = reduceGoalRun(prepared.state, { type: "approval", digest: "foreign", approved: true, now: grant.body.preparedAt });
  assert.deepEqual(wrong.effects, []);
  assert.deepEqual(wrong.state, prepared.state);
  for (const approval of [{ approved: false, now: grant.body.preparedAt }, { approved: true, now: grant.body.approvalDeadline }]) {
    const denied = reduceGoalRun(prepared.state, { type: "approval", digest: grant.ref.scopeDigest, ...approval });
    assert.equal(denied.state.status, "closing"); assert.equal(denied.effects[0]?.type, "close_goal_run");
  }
  const copy = structuredClone(grant); copy.body.run.task = "different";
  assert.equal(validGoalGrant(copy), false);
  assert.deepEqual(f.tool.parameters, GoalRunInputSchema);
  assert.deepEqual(Object.keys(GoalRunInputSchema.properties), ["task", "agent", "files", "journalDirectory", "acceptanceCriteria", "memory", "maxModelCalls"]);
  assert.equal(f.tool.executionMode, "sequential");
  assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.fetch.mock.callCount(), 0);
});

test("missing UI, decline and approval-time edits produce zero workers and no project/journal writes", async (t) => {
  for (const mode of ["no_ui", "decline", "file_change", "rule_change", "model_change"]) await t.test(mode, async (t) => {
    const f = await fixture(t);
    if (mode === "no_ui") Object.assign(f.ctx, { hasUI: false });
    t.mock.method(f.ctx.ui, "confirm", async () => {
      if (mode === "file_change") await writeFile(f.file, "EXTERNAL\n");
      if (mode === "rule_change") await writeFile(f.rules, "New instructions");
      if (mode === "model_change") await writeFile(path.join(f.agentDir, "models.json"), "{}");
      return mode !== "decline";
    });
    const done = result(await goalRun(f.input, f.ctx, t.signal));
    assert.notEqual(done.status, "completed_unverified"); assert.equal(f.launches.mock.callCount(), 0);
    await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK)), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(f.journal, "goal.jsonl")), { code: "ENOENT" });
    assert.equal(f.requests.length, 0);
  });
});

test("B2 real SDK worker → approved file-ID edit → cleanup → synced settlement, always unverified", { timeout: process.platform === "win32" ? 45_000 : 15_000 }, async (t) => {
  const f = await fixture(t);
  const response = await f.invoke(t.signal), done = response.details as ReturnType<typeof result>;
  assert.equal(done.status, "completed_unverified"); assert.equal(done.verification, "not_run"); assert.equal(done.taskAcceptance, "needs_review");
  assert.equal(done.worker?.report.modelCalls, 2); assert.equal(done.files?.operations, 1); assert.equal(done.files?.changed, true);
  assert.equal(done.cleanupConfirmed, true); assert.equal(done.lockRetained, false);
  assert.equal(await readFile(f.file, "utf8"), "AFTER\n");
  const snapshot = await f.inspect();
  assert.deepEqual(snapshot.records.map((record) => record.type), ["created", "approved", "reserved", "settled", "closed"]);
  assert.equal(snapshot.ledger?.spent.workerRuns, 1); assert.equal(snapshot.ledger?.spent.workerCalls, 2);
  assert.equal(snapshot.ledger?.held.workerCalls, 0); assert.equal(snapshot.ledger?.pending, null);
  assert.ok(snapshot.ledger?.totalUsd !== null && snapshot.ledger?.totalUsd! > 0);
  assert.deepEqual(done.ledger, snapshot.ledger);
  assert.equal(f.launches.mock.callCount(), 1); assert.equal(f.requests.length, 2); assert.equal(f.fetch.mock.callCount(), 0);
  for (const request of f.requests) {
    assert.deepEqual(request.tools.map((tool) => tool.function.name).sort(), ["goal_edit", "goal_read", "goal_write"]);
    assert.ok(!JSON.stringify(request).includes("UNAPPROVED_GLOBAL_PROMPT"));
    assert.ok(!JSON.stringify(request).includes("PROJECT_EXTENSION_MUST_NOT_LOAD"));
    assert.ok(!JSON.stringify(request).includes("activationId"));
  }
  assert.equal(f.confirm.mock.callCount(), 1);
  const approval = f.confirm.mock.calls[0]!.arguments[1];
  assert.match(approval, /effective thinking: "off"/); assert.match(approval, /Effective tools: \["goal_read","goal_edit","goal_write"\]/);
  assert.match(approval, /UNVERIFIED/); assert.ok(approval.includes(JSON.stringify(f.cwd)));
  assert.match(approval, /Only change the approved fixture/); assert.match(approval, /120 seconds; 64 file requests/);
  assert.match(approval, /\.jev-goal\.lock/); assert.match(approval, /Exact effective system prompt/);
  await assert.rejects(lstat(path.join(f.cwd, GOAL_PROJECT_LOCK)), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.journal, "owner.lock")), { code: "ENOENT" });
});

test("B2 never reuses an existing journal or steals a project owner, even after another exact approval", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), grant = await f.prepare(), owner = await openGoalProjectLock(grant, t.signal);
  const bytes = await readFile(path.join(f.cwd, GOAL_PROJECT_LOCK));
  await assert.rejects(openGoalProjectLock(grant, t.signal), { message: GOAL_RUN_ERROR });
  assert.deepEqual(await readFile(path.join(f.cwd, GOAL_PROJECT_LOCK)), bytes);
  const blocked = result(await goalRun(f.input, f.ctx, t.signal));
  assert.equal(blocked.status, "needs_review"); assert.equal(f.launches.mock.callCount(), 0);
  assert.equal(blocked.lockRetained, true); assert.equal(blocked.cleanupConfirmed, false);
  await owner.close(false);
  await f.invoke(t.signal);
  const ledger = await readFile(path.join(f.journal, "goal.jsonl"));
  const again = result(await goalRun(f.input, f.ctx, t.signal));
  assert.equal(again.status, "needs_review"); assert.equal(f.launches.mock.callCount(), 1);
  assert.deepEqual(await readFile(path.join(f.journal, "goal.jsonl")), ledger);
});

test("Goal SDK cap, invalid tool/args/file ID, owner change and provider failure never cause retry or verification", { timeout: 45_000 }, async (t) => {
  for (const mode of ["loop", "bash", "path", "foreign", "lease", "error", "missing_usage", "last_change"]) await t.test(mode, { timeout: 12_000 }, async (t) => {
    const f = await fixture(t, mode); if (mode === "loop") f.input.maxModelCalls = 1;
    const error = await f.invoke(t.signal).catch((error: unknown) => error), done = toolFailure(error);
    assert.equal(done.status, "needs_review"); assert.equal(done.verification, "not_run");
    assert.equal(f.requests.length, ["missing_usage", "last_change"].includes(mode) ? 2 : 1);
    assert.equal(f.launches.mock.callCount(), 1); assert.equal(f.fetch.mock.callCount(), 0);
    assert.equal(await readFile(f.file, "utf8"), mode === "last_change" ? "EXTERNAL\n" : ["loop", "missing_usage"].includes(mode) ? "AFTER\n" : "BEFORE\n");
    await assert.rejects(lstat(path.join(f.cwd, "should-never-exist")), { code: "ENOENT" });
    const ledger = (await f.inspect()).ledger!;
    assert.equal(ledger.blocked, true); assert.equal(ledger.totalUsd, null); assert.equal(ledger.pending, null);
    assert.equal(done.lockRetained, true);
  });
});

test("session navigation revokes the live Goal, waits for child cleanup, and durably preserves unknown accounting", { timeout: process.platform === "win32" ? 45_000 : 15_000 }, async (t) => {
  const f = await fixture(t, "hold"), pending = f.invoke(t.signal).catch((error: unknown) => error);
  try {
    await Promise.race([f.firstRequest, pending.then(() => assert.fail("No model request"))]);
    for (const name of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) assert.ok(f.handlers.has(name));
    await f.handlers.get("session_before_tree")!();
    const done = toolFailure(await pending);
    assert.equal(done.status, "cancelled"); assert.equal(done.cleanupConfirmed, true);
    assert.equal(done.lockRetained, true); assert.equal(f.requests.length, 1);
    const ledger = (await f.inspect()).ledger!;
    assert.equal(ledger.pending, null); assert.equal(ledger.totalUsd, null); assert.equal(ledger.blocked, true);
    assert.equal(ledger.spent.workerCalls, 1); assert.equal(ledger.held.workerCalls, 1);
    assert.equal(await readFile(f.file, "utf8"), "BEFORE\n");
  } finally { await f.handlers.get("session_shutdown")?.(); await pending; }
});

test("settlement never launders missing usage, cleanup or file uncertainty into known cost", async (t) => {
  const f = await fixture(t), grant = await f.prepare();
  assert.equal(settlementFor(grant, { started: false, cleanupConfirmed: true, result: null }).outcome, "not_started");
  for (const observation of [{ started: true, cleanupConfirmed: true, result: null }, { started: true, cleanupConfirmed: false, result: null }]) {
    const settlement = settlementFor(grant, observation);
    assert.equal(settlement.outcome, "unknown"); assert.equal(settlement.accountingComplete, false); assert.equal(settlement.used.workerRuns, 1);
  }
  const initialized = reduceGoalFiles({ status: "idle" }, { type: "start", scope: grant.body.files });
  const files = reduceGoalFiles(initialized.state, { type: "approval", scopeId: grant.body.files.id, approved: true }).state;
  const stopped = reduceGoalExecution({ status: "running", files }, { type: "admission", current: false, now: grant.body.preparedAt, deadline: grant.body.deadline });
  assert.equal(stopped.state.status, "failed");
  assert.deepEqual(reduceGoalExecution(stopped.state, { type: "cancel" }), { state: stopped.state, effects: [] });
  assert.ok(!reduceGoalExecution(stopped.state, { type: "admission", current: true, now: grant.body.preparedAt, deadline: grant.body.deadline }).effects.some((effect) => effect.type === "allow_model"));
  const reading = reduceGoalExecution({ status: "running", files }, { type: "file", event: { type: "request", scopeId: grant.body.files.id, request: { id: "read-1", action: "read", fileId: "file-1" } } });
  const draining = reduceGoalExecution(reading.state, { type: "turn", valid: false });
  assert.equal(draining.state.status, "draining");
  const cancelled = reduceGoalExecution(draining.state, { type: "cancel" });
  const late = reduceGoalExecution(cancelled.state, { type: "file", event: { type: "file_failed", scopeId: grant.body.files.id, requestId: "read-1", cancelled: false, mayHaveWritten: true } });
  assert.equal(late.state.status, "cancelled"); assert.deepEqual(late.effects, []);
  const observation: GoalObservation = { started: true, cleanupConfirmed: true, result: { type: "goal_result", files: { ...EMPTY_FILE_REPORT }, reply: {
    type: "failed", error: "Subagent failed. Check its model, authentication, and task; no automatic retry was attempted.", report: { startupMs: 1, executionMs: 1, modelCalls: null,
      accounting: { status: "reported", complete: false, stats: { turns: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 } } },
  } } };
  const partial = settlementFor(grant, observation);
  assert.equal(partial.outcome, "unknown"); assert.equal(partial.observedUsd, 0.01); assert.equal(partial.accountingComplete, false);
});

test("unknown native cleanup retains the project owner and reservation; no worker result is synthesized", async (t) => {
  const f = await fixture(t);
  const done = result(await goalRun(f.input, f.ctx, t.signal, () => Promise.reject(new Error("private-progress-error")), async (grant, lease) => {
    await checkGoalLease(grant, lease);
    return { started: true, cleanupConfirmed: false, result: null } satisfies GoalObservation;
  }));
  assert.equal(done.status, "needs_review"); assert.equal(done.cleanupConfirmed, false); assert.equal(done.lockRetained, true);
  assert.equal(done.ledger?.held.workerCalls, 2); assert.equal(done.ledger?.held.workerRuns, 0); assert.equal(done.ledger?.totalUsd, null);
  assert.ok((await lstat(path.join(f.cwd, GOAL_PROJECT_LOCK))).isFile());
  assert.equal(f.requests.length, 0);
});

test("IPC parent disconnect stops the worker and keeps the whole unreported call reservation", { timeout: process.platform === "win32" ? 45_000 : 15_000 }, async (t) => {
  const f = await fixture(t, "hold"), pending = f.invoke(t.signal).catch((error: unknown) => error);
  try {
    await Promise.race([f.firstRequest, pending.then(() => assert.fail("No model request"))]);
    const child = f.launches.mock.calls[0]!.result;
    assert.ok(child); child.disconnect();
    const done = toolFailure(await pending);
    assert.equal(done.status, "needs_review"); assert.equal(done.cleanupConfirmed, true); assert.equal(done.lockRetained, true);
    assert.equal(done.ledger.held.workerCalls, 2); assert.equal(done.ledger.totalUsd, null); assert.equal(f.requests.length, 1);
  } finally { await f.handlers.get("session_shutdown")?.(); await pending; }
});

test("the bounded worker timer cancels the native connection without a retry or an invented complete total", { timeout: process.platform === "win32" ? 45_000 : 15_000 }, async (t) => {
  const f = await fixture(t, "hold"), nativeTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    // Runtime discovery consumes part of the original120s; capture the shortened native timer after fork.
    if (!expire && f.launches.mock.callCount() > 0 && ms !== undefined && ms > 2_000 && ms <= 120_000) expire = () => callback(...args);
    return nativeTimeout(callback, ms, ...args);
  });
  const pending = f.invoke(t.signal).catch((error: unknown) => error);
  try {
    await Promise.race([f.firstRequest, pending.then(() => assert.fail("No model request"))]);
    assert.ok(expire); expire();
    const done = toolFailure(await pending);
    assert.equal(done.status, "needs_review"); assert.equal(done.cleanupConfirmed, true); assert.equal(done.lockRetained, true);
    assert.equal(done.ledger.totalUsd, null); assert.equal(f.requests.length, 1); assert.equal(f.launches.mock.callCount(), 1);
  } finally { await f.handlers.get("session_shutdown")?.(); await pending; }
});

test("lost settlement sync preserves the unacknowledged observation without releasing reservations or project ownership", async (t) => {
  const f = await fixture(t), handle = await open(f.file, "r"), prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const done = result(await goalRun(f.input, f.ctx, t.signal, undefined, async () => {
    t.mock.method(prototype, "sync", async () => { throw new Error("private-sync-error"); });
    return { started: false, cleanupConfirmed: true, result: null };
  }));
  assert.equal(done.status, "needs_review"); assert.equal(done.lockRetained, true);
  assert.equal(done.ledger?.pending !== null, true); assert.equal(done.ledger?.held.workerCalls, 2); assert.equal(done.ledger?.totalUsd, null);
  assert.equal(done.unconfirmedRecord?.type, "settled");
  assert.ok(!JSON.stringify(done).includes("private-sync-error")); assert.equal(f.launches.mock.callCount(), 0);
});

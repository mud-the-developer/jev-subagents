import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { ordinaryDelegate, ordinaryIO, DelegateToolInputSchema, ordinaryApprovalPacket, ordinaryApprovalText } from "../src/ordinary-effects.ts";
import { ordinaryContextDigest, ordinaryControlBatches, ordinaryPrompts, reduceOrdinaryRoutingAccounting, validOrdinaryWorkerInput, type OrdinaryWorkerReply, type OrdinaryWorkerInput } from "../src/ordinary-protocol.ts";
import { type OrdinaryPreparedScope, type OrdinaryScopeInput, type OrdinaryGraphInput, ordinarySelectionPlan, ordinaryScopeDigest } from "../src/ordinary-authorization.ts";
import { delegateResultView } from "../src/delegate-presentation.ts";
import { basicRunSummary } from "../src/basic-execution.ts";
import { describeJevTarget, readJevConnection } from "../src/jev-config.ts";
import { registerJevTools } from "../src/index.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { memoryDigest, memoryProjectKey, memorySnapshot } from "../src/project-memory.ts";
import { type DelegationMemoryInput, type DelegationMemorySource } from "../src/delegation-memory.ts";
import type { DelegationMemoryPause } from "../src/delegation-memory-owner.ts";
import { accessFixture } from "./helpers/delegation-access-fixture.ts";
import { DirectoryValidationError } from "../src/directory-diagnostics.ts";

const input: OrdinaryScopeInput = { task: "Fix and review only the approved existing file.", agents: ["worker"],
  files: [{ path: "fixture.txt", access: "read_write" }], tasks: [{ id: "fix", summary: "Change BEFORE to AFTER in fixture.txt." },
    { id: "review", summary: "Review only the approved file." }], selection: "parent_only",
  limits: { workerRuns: 2, modelCalls: 4, perWorkerCalls: 2, seconds: 120 } };
async function fixture(t: TestContext) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "jev-scope-")), cwd = await realpath(temp), agentDirectory = path.join(cwd, "private-agent");
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let session = "scope-session", confirmations = 0, starts = 0, closes = 0;
  const ctx = { cwd, hasUI: true, mode: "rpc", ui: { confirm: async (_title: string, text: string) => {
    confirmations++; assert.match(text, /Exact plan execution approval/); assert.ok(text.includes("1. fix"));
    assert.ok(text.includes("2. review")); assert.equal(text.trimStart().startsWith("{"), false); return true;
  } }, sessionManager: { getSessionId: () => session } } as unknown as ExtensionContext;
  const scope: OrdinaryPreparedScope = { workerTargets: [{ agent: "worker", api: "openai-completions", endpoint: "http://127.0.0.1:8000/v1" }], id: "scope-job", sessionId: session, input: structuredClone(input), fileProtocol: "scoped_existing_files", routingTarget: null,
    approvalDeadline: null, contextDigest: ordinaryContextDigest([], agentDirectory), agents: [{ name: "worker", description: "Bounded file work.",
      systemPrompt: "Use only supplied file-ID tools.", tools: ["read", "edit"], model: { provider: "offline", id: "fixture" }, file: path.join(agentDirectory, "agents", "worker.md") }],
    files: { id: "files-job", root: cwd, rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "fixture.txt", access: "read_write",
      version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 7 } }] } };
  const reply = (dto: OrdinaryWorkerInput): OrdinaryWorkerReply => ({ type: "goal_result", scope: dto.files,
    files: { operations: 0, readBytes: 0, writtenBytes: 0, changed: false, uncertain: false, finished: true },
    reply: { type: "completed", result: { text: "PRIVATE_WORKER_CLAIM: all tests passed.", truncated: false, turns: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 },
      report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "reported", complete: true,
        stats: { turns: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 } } } } });
  const io: typeof ordinaryIO = { ...ordinaryIO, prepare: async () => ({ scope: structuredClone(scope), context: [], agentDirectory }),
    canonicalDirectory: async directory => { assert.equal(directory, cwd); return cwd; },
    confirm: async (...args: Parameters<typeof ordinaryIO.confirm>) => {
      const original = JSON.parse(args[2]).scope as OrdinaryPreparedScope;
      assert.deepEqual(original.input, scope.input); assert.equal(original.approvalDeadline, null);
      assert.equal(args[7], ordinaryApprovalText({ scope: original, context: [], agentDirectory }));
      return ordinaryIO.confirm(...args);
    },
    own: async () => ({ version: structuredClone(scope.files.files[0]!.version), close: async (keep: boolean) => { closes++; return keep; } }),
    checkContext: async () => {}, checkFiles: async () => {},
    run: async (dto: OrdinaryWorkerInput, _signal: AbortSignal) => { starts++; assert.equal(confirmations, 1); assert.equal(validOrdinaryWorkerInput(dto), true);
      assert.ok(dto.run.maxModelCalls !== null && dto.run.maxModelCalls <= 2); return { started: true, cleanupConfirmed: true, result: reply(dto) }; } };
  return { ctx, scope, io, reply, counts: () => ({ confirmations, starts, closes }), switchSession: () => { session = "fork-session"; } };
}

test("fresh scope read checks overlap but partial results admit neither ownership nor a worker", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let contextStarted = false, filesStarted = false, owners = 0, releaseContext!: () => void, releaseFiles!: () => void;
  const context = new Promise<void>(resolve => { releaseContext = resolve; }), files = new Promise<void>(resolve => { releaseFiles = resolve; });
  f.io.checkContext = async () => { if (!contextStarted) { contextStarted = true; await context; } };
  f.io.checkFiles = async () => { if (!filesStarted) { filesStarted = true; await files; } };
  const own = f.io.own; f.io.own = async (...args) => { owners++; return own(...args); };
  const work = ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
  try {
    while (!contextStarted) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(filesStarted, true, "Independent fresh reads must start before either is released.");
    assert.equal(owners, 0); assert.equal(f.counts().starts, 0);
    releaseContext(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(owners, 0); assert.equal(f.counts().starts, 0);
    releaseFiles(); assert.equal((await work).status, "completed_unverified");
  } finally { releaseContext(); releaseFiles(); await work; }
});
test("late unknown read cleanup drains both checks and retains the already acquired scope owner", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let owned = false, contextStarted = false, filesStarted = false, kept: boolean | undefined, releaseContext!: () => void, releaseFiles!: () => void;
  const context = new Promise<void>(resolve => { releaseContext = resolve; }), files = new Promise<void>(resolve => { releaseFiles = resolve; });
  const own = f.io.own;
  f.io.own = async (...args) => {
    const owner = await own(...args); owned = true;
    return { ...owner, close: async keep => { kept = keep; return owner.close(keep); } };
  };
  f.io.checkContext = async () => { if (owned && !contextStarted) { contextStarted = true; await context; throw new Error("Synthetic early refusal"); } };
  f.io.checkFiles = async () => { if (owned && !filesStarted) { filesStarted = true; await files; throw new DirectoryValidationError("Fixed", "helper_timeout", false); } };
  const work = ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io);
  try {
    while (!contextStarted) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(filesStarted, true); assert.equal(f.counts().starts, 0);
    releaseContext(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(kept, undefined, "The owner cannot close while sibling cleanup is pending.");
    releaseFiles(); const result = await work;
    assert.equal(result.status, "stopped"); assert.equal(result.cleanupConfirmed, false); assert.equal(result.lockRetained, true);
    assert.equal(kept, true); assert.equal(f.counts().starts, 0);
    assert.deepEqual(result.diagnostic?.directoryIssues, [{ target: "workspace", reason: "unknown", cleanupConfirmed: false }]);
  } finally { releaseContext(); releaseFiles(); await work; }
});
test("Full Access authorizes scope and graph jobs without native task receipts while preserving file and call limits", async t => {
  for (const graph of [false, true]) {
    const f = await fixture(t), access = accessFixture(f.ctx), lease = await access.enable();
    if (graph) f.scope.input = { ...f.scope.input, plan: { version: 2, entry: "fix", nodes: [{ id: "fix", kind: "task" }, { id: "review", kind: "task" }],
      edges: [{ from: "fix", to: "review" }] } } as OrdinaryGraphInput;
    f.io.confirm = async () => assert.fail("No per-job native popup in Full Access");
    let starts = 0;
    f.io.run = async dto => { starts++; assert.equal(validOrdinaryWorkerInput(dto), true); assert.equal(dto.run.maxModelCalls, 2);
      assert.deepEqual(dto.files.files.map(file => file.path), ["fixture.txt"]); assert.equal("access" in dto, false);
      return { started: true, cleanupConfirmed: true, result: f.reply(dto) }; };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io, undefined, undefined, undefined, lease);
    assert.equal(result.status, "completed_unverified"); assert.equal(result.authorization, "full_access"); assert.equal(starts, 2);
    assert.equal(result.modelCalls, 2); assert.equal(result.reservedModelCalls, 0); assert.equal(result.taskAcceptance, "needs_human_review");
    assert.equal(access.confirmations(), 1); assert.equal(f.counts().confirmations, 0);
  }
});

async function memoryFixture(t: TestContext) {
  const f = await fixture(t), keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"], saved = keys.map(key => process.env[key]);
  Object.assign(process.env, { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8000", OPENJEV_MODEL: "openjev-0.1" }); delete process.env.OPENJEV_API_KEY;
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
  const memory: DelegationMemoryInput = { directory: f.scope.files.root + "-memory-not-created", query: "Find parser compatibility notes." };
  const data: DelegationMemorySource = { version: 1, projectKey: memoryProjectKey(f.scope.files.root), directoryRef: memoryDigest(memory.directory), revision: 1,
    query: memory.query, records: [
      { id: "fact_parser", kind: "decision", title: "Preserve parser API", content: "APPROVED_PARSER_BODY", provenance: "Synthetic parent review.", createdRevision: 1 },
      { id: "fact_logs", kind: "decision", title: "Redact credentials", content: "UNSELECTED_LOGGING_BODY", provenance: "Synthetic parent review.", createdRevision: 1 }], additions: [] };
  const catalog = memorySnapshot({ version: 1, projectKey: data.projectKey, revision: 1, facts: data.records, edges: [] }, data.records.map(record => record.id));
  let applied = 0, lookups = 0;
  f.io.prepareMemory = async () => ({ directory: memory.directory, input: structuredClone(memory), token: "synthetic-token", data: structuredClone(data) });
  f.io.applyMemory = async () => { assert.equal(f.counts().confirmations, 1); applied++; return structuredClone(catalog); };
  const nativeConfirm = ordinaryIO.confirm;
  f.io.confirm = async (...args) => { assert.match(args[2], /APPROVED_PARSER_BODY/); assert.match(args[7]!, /No additional write\/search\/snapshot dialogs/); return nativeConfirm(...args); };
  f.io.select = async (effect, _signal, attempt) => { assert.equal(f.counts().confirmations, 1); lookups++; attempt?.();
    assert.equal(effect.type, "call_jev"); assert.doesNotMatch(JSON.stringify(effect), /APPROVED_PARSER_BODY|UNSELECTED_LOGGING_BODY|memory-not-created/);
    return { type: "resolved", decision: { agent: "record_0", confidence: 0.9, model: "openjev-0.1", provider: "openjev", requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } }; };
  return { ...f, memory, data, memoryCounts: () => ({ applied, lookups }) };
}

test("Full Access covers declared combined-job memory with unchanged bounded child disclosure and metadata-only routing", async t => {
  const f = await memoryFixture(t), access = accessFixture(f.ctx), lease = await access.enable();
  const catalog = memorySnapshot({ version: 1, projectKey: f.data.projectKey, revision: 1, facts: f.data.records, edges: [] }, f.data.records.map(record => record.id));
  let applied = 0, routed = 0, workers = 0;
  f.io.confirm = async () => assert.fail("No repeated job/memory approval in Full Access");
  f.io.applyMemory = async () => { assert.equal(lease.authorize(f.ctx), true); applied++; return catalog; };
  f.io.select = async (effect, _signal, attempt) => {
    attempt?.(); routed++; assert.doesNotMatch(JSON.stringify(effect), /APPROVED_PARSER_BODY|UNSELECTED_LOGGING_BODY|memory-not-created/);
    return { type: "resolved", decision: { agent: "record_0", confidence: 0.9, model: "openjev-0.1", provider: "openjev", requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } };
  };
  f.io.run = async dto => { workers++; assert.equal(validOrdinaryWorkerInput(dto), true);
    assert.equal(dto.memory?.records[0]?.content, "APPROVED_PARSER_BODY"); assert.doesNotMatch(JSON.stringify(dto.memory), /UNSELECTED_LOGGING_BODY/);
    return { started: true, cleanupConfirmed: true, result: f.reply(dto) }; };
  const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io, undefined, undefined, { memory: f.memory }, lease);
  assert.equal(result.status, "completed_unverified"); assert.equal(result.authorization, "full_access");
  assert.equal(applied, 1); assert.equal(routed, 1); assert.equal(workers, 2); assert.equal(access.confirmations(), 1); assert.equal(f.counts().confirmations, 0);
});

test("one native job approval covers memory apply/lookup/readonly child data without repeated dialogs", async t => {
  const f = await memoryFixture(t), run = f.io.run;
  f.io.run = async (dto, signal, progress) => {
    assert.equal(dto.memory?.records[0]?.id, "fact_parser"); assert.equal(validOrdinaryWorkerInput(dto), true);
    assert.doesNotMatch(JSON.stringify(dto), /memory-not-created/);
    const prompt = ordinaryPrompts(dto.scope, dto.run.agent, dto.run.task, dto.context, dto.memory);
    assert.match(prompt.systemPrompt, /APPROVED_PARSER_BODY/); assert.doesNotMatch(prompt.systemPrompt, /UNSELECTED_LOGGING_BODY/);
    const tampered = structuredClone(dto); tampered.memory!.records[0]!.content = "UNAPPROVED_BODY";
    assert.equal(validOrdinaryWorkerInput(tampered), false); return run(dto, signal, progress);
  };
  const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io, undefined, undefined, { memory: f.memory });
  assert.equal(result.status, "completed_unverified"); assert.equal(f.counts().confirmations, 1); assert.equal(f.counts().starts, 2);
  assert.deepEqual(f.memoryCounts(), { applied: 1, lookups: 1 }); assert.equal(result.jevRequests, 1); assert.deepEqual(result.memory?.selected, ["fact_parser"]);
  assert.equal(Value.Check(DelegateToolInputSchema, { scope: f.scope.input, memory: f.memory }), true);
  assert.equal(Value.Check(DelegateToolInputSchema, { scope: f.scope.input, memory: { ...f.memory, approved: true } }), false);
});

test("weak job memory asks the current parent once, not another approval/model/provider", async t => {
  const f = await memoryFixture(t), select = f.io.select; let parentCalls = 0;
  f.io.select = async (...args) => { const response = await select(...args); assert.equal(response.type, "resolved"); if (response.type !== "resolved") assert.fail(); return { ...response, decision: { ...response.decision, confidence: 0.49 } }; };
  const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io, undefined, undefined, { memory: f.memory, onMemoryLookup: async (question, signal) => {
    assert.equal(signal.aborted, false); assert.equal(f.counts().starts, 0); parentCalls++;
    assert.equal(question.catalog.records[0]?.content, "APPROVED_PARSER_BODY"); return ["fact_parser"];
  } });
  assert.equal(result.status, "completed_unverified"); assert.equal(parentCalls, 1); assert.equal(f.counts().confirmations, 1); assert.equal(result.memory?.parentLookup, true); assert.equal(result.jevRequests, 1);
});

test("job memory denial or unknown routing receipt cannot write, disclose a continuation or dispatch a worker", async t => {
  for (const mode of ["denied", "unknown"] as const) {
    const f = await memoryFixture(t); let parentCalls = 0;
    if (mode === "denied") { const confirm = f.ctx.ui.confirm; f.ctx.ui.confirm = async (...args) => { await confirm(...args); return false; }; }
    else f.io.select = async (_effect, _signal, attempt) => { attempt?.(); return { type: "failed", error: "Synthetic uncertain receipt." }; };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io, undefined, undefined, { memory: f.memory, onMemoryLookup: async () => { parentCalls++; return []; } });
    assert.equal(result.status, "stopped"); assert.equal(f.counts().starts, 0); assert.equal(parentCalls, 0);
    if (mode === "denied") assert.deepEqual(f.memoryCounts(), { applied: 0, lookups: 0 });
    else { assert.equal(result.reservedJevRequests, 1); assert.equal(result.lockRetained, true); }
  }
});

test("registered memory choice continues only the same live approved delegate without another popup", async t => {
  const f = await memoryFixture(t), select = f.io.select;
  f.io.select = async (...args) => { const response = await select(...args); if (response.type !== "resolved") assert.fail(); return { ...response, decision: { ...response.decision, confidence: 0.49 } }; };
  for (const key of Object.keys(f.io) as (keyof typeof ordinaryIO)[]) t.mock.method(ordinaryIO, key, f.io[key]);
  const tools: ToolDefinition[] = []; registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!;
  const first = await tool.execute("start", { scope: f.scope.input, memory: f.memory }, t.signal, undefined, f.ctx);
  const pause = first.details as DelegationMemoryPause; assert.equal(pause.kind, "delegation_memory_choice"); assert.equal(f.counts().starts, 0);
  const completed = await tool.execute("choose", { memoryChoice: { jobId: pause.jobId, ids: ["fact_parser"] } }, t.signal, undefined, f.ctx);
  assert.equal((completed.details as { status: string }).status, "completed_unverified"); assert.equal(f.counts().confirmations, 1); assert.equal(f.counts().starts, 2);
  await assert.rejects(tool.execute("replay", { memoryChoice: { jobId: pause.jobId, ids: ["fact_parser"] } }, t.signal, undefined, f.ctx), /No matching live/);
});

test("lifecycle or original deadline cancels a pending parent memory choice without restoring its approval", async t => {
  for (const mode of ["tree", "deadline"] as const) {
    if (mode === "deadline") t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
    const f = await memoryFixture(t), select = f.io.select;
    f.io.select = async (...args) => { const response = await select(...args); if (response.type !== "resolved") assert.fail(); return { ...response, decision: { ...response.decision, confidence: 0.49 } }; };
    for (const key of Object.keys(f.io) as (keyof typeof ordinaryIO)[]) t.mock.method(ordinaryIO, key, f.io[key]);
    const tools: ToolDefinition[] = [], handlers = new Map<string, (() => void | Promise<void>)[]>();
    registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, fn: () => void | Promise<void>) { handlers.set(event, [...handlers.get(event) ?? [], fn]); } } as unknown as ExtensionAPI);
    const tool = tools.find(tool => tool.name === "jev_delegate")!;
    const started = await tool.execute("start", { scope: f.scope.input, memory: f.memory }, t.signal, undefined, f.ctx), pause = started.details as DelegationMemoryPause;
    assert.equal(pause.kind, "delegation_memory_choice"); assert.equal(f.counts().confirmations, 1);
    if (mode === "tree") for (const fn of handlers.get("session_before_tree") ?? []) await fn();
    else { t.mock.timers.tick(120001); await new Promise<void>(resolve => setImmediate(resolve)); }
    await assert.rejects(tool.execute("late", { memoryChoice: { jobId: pause.jobId, ids: ["fact_parser"] } }, t.signal, undefined, f.ctx), /No matching live/);
    assert.equal(f.counts().starts, 0); assert.equal(f.counts().closes, 1);
    t.mock.restoreAll(); if (mode === "deadline") t.mock.timers.reset();
  }
});

test("new memory bytes or provider selection cannot change while the single native job review is awaiting", async t => {
  for (const mode of ["bytes", "provider"] as const) {
    const f = await memoryFixture(t); let prepared: Awaited<ReturnType<typeof ordinaryIO.prepareMemory>> | undefined;
    const prepare = f.io.prepareMemory; f.io.prepareMemory = async (...args) => { prepared = await prepare(...args); return prepared; };
    const confirm = f.ctx.ui.confirm; f.ctx.ui.confirm = async (...args) => {
      await confirm(...args); if (mode === "bytes") prepared!.data.records[0]!.content = "UNREVIEWED_MEMORY_CHANGE"; else process.env.OPENJEV_MODEL = "changed-model"; return true;
    };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, t.signal, undefined, f.io, undefined, undefined, { memory: f.memory });
    assert.equal(result.status, "stopped"); assert.equal(f.counts().starts, 0); assert.deepEqual(f.memoryCounts(), { applied: 0, lookups: 0 });
  }
});

test("approved plan selects B once, streams advisory progress, and never retries A on execution failure", async t => {
  const keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"], saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
  Object.assign(process.env, { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8000", OPENJEV_MODEL: "openjev-0.1" });
  delete process.env.OPENJEV_API_KEY;
  for (const mode of ["success", "failure", "weak"] as const) {
    const fails = mode === "failure", weak = mode === "weak";
    const f = await fixture(t), target = readJevConnection(); assert.ok(target.ok);
    f.scope.input.selection = "parent_or_jev"; f.scope.routingTarget = describeJevTarget(target.connection);
    f.scope.input.tasks[0]!.alternatives = [{ id: "a", summary: "PRIVATE_A_SOURCE", description: "Keep the current implementation." },
      { id: "b", summary: "PRIVATE_B_SOURCE", description: "Use a smaller implementation." }];
    f.scope.input.tasks[1]!.after = ["fix"];
    f.io.canonicalDirectory = async () => f.scope.files.root;
    let selections = 0; const executed: string[] = [], views: import("../src/plan-presentation.ts").PlanView[] = [];
    f.io.select = async (effect, _signal, attempted) => {
      assert.equal(f.counts().confirmations, 1); selections++; attempted?.();
      assert.equal(effect.type, "call_jev"); if (effect.type !== "call_jev") assert.fail();
      assert.equal(JSON.stringify(effect).includes("PRIVATE_A_SOURCE"), false);
      assert.equal(JSON.stringify(effect).includes("PRIVATE_B_SOURCE"), false);
      assert.deepEqual(effect.request.agents.map(candidate => candidate.name), ["choice_0_0", "choice_1_0"]);
      return { type: "resolved", decision: { agent: "choice_1_0", confidence: weak ? 0.3 : 1, model: "openjev-0.1", provider: "openjev",
        requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } };
    };
    f.io.run = async (dto, _signal, progress) => {
      assert.equal(validOrdinaryWorkerInput(dto), true); executed.push(dto.run.task);
      progress?.({ type: "jev_worker_progress", version: 1, sequence: 1, elapsedMs: 1, modelCalls: 1, toolCalls: 1, phase: "tool_start", currentTool: "scope_read" });
      const result = f.reply(dto); if (fails) result.files.finished = false;
      return { started: true, cleanupConfirmed: true, result };
    };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, undefined, undefined, f.io, undefined, view => { views.push(view); });
    assert.equal(selections, 1); assert.equal(result.jevRequests, 1);
    if (weak) { assert.equal(result.status, "stopped"); assert.equal(result.reason, "undecided"); assert.deepEqual(executed, []); continue; }
    assert.equal(result.status, fails ? "stopped" : "completed_unverified");
    assert.equal(executed[0], "PRIVATE_B_SOURCE"); assert.equal(executed.includes("PRIVATE_A_SOURCE"), false);
    assert.equal(executed.length, fails ? 1 : 2);
    assert.ok(views.some(view => view.phase === "running" && view.currentTool === "scope_read"));
    assert.equal(result.plan?.nodes[0]?.alternatives?.find(choice => choice.id === "b")?.selected, true);
    assert.equal(result.plan?.nodes[0]?.alternatives?.find(choice => choice.id === "a")?.selected, false);
    assert.equal(result.plan?.nodes[1]?.state, fails ? "blocked" : "completed");
    assert.equal(JSON.stringify(result.plan).includes("PRIVATE_A_SOURCE"), false);
    assert.equal(JSON.stringify(result.plan).includes("PRIVATE_B_SOURCE"), false);
  }
});

test("worker DTO cannot inject SDK-native calls under any finite approved cap", async t => {
  const f = await fixture(t), scope = structuredClone(f.scope), agent = scope.agents[0]!;
  const value: OrdinaryWorkerInput = { scope, digest: ordinaryScopeDigest(scope), taskId: "fix",
    run: { task: scope.input.tasks[0]!.summary, cwd: scope.files.root, agent, model: agent.model, maxModelCalls: null },
    files: scope.files, context: [], agentDirectory: path.dirname(path.dirname(agent.file)), lockVersion: scope.files.files[0]!.version,
    approvedAt: 1000, deadline: 121000 };
  assert.equal(validOrdinaryWorkerInput(value), false);
  scope.input.limits.perWorkerCalls = null; value.digest = ordinaryScopeDigest(scope);
  assert.equal(validOrdinaryWorkerInput(value), false);
  scope.input.limits.perWorkerCalls = 2; scope.input.limits.modelCalls = null; value.digest = ordinaryScopeDigest(scope);
  assert.equal(validOrdinaryWorkerInput(value), false);
  scope.input.limits.perWorkerCalls = null; value.digest = ordinaryScopeDigest(scope);
  assert.equal(validOrdinaryWorkerInput(value), true);
  assert.equal(validOrdinaryWorkerInput({ ...value, run: { ...value.run, seconds: 600 } }), false);
  assert.equal(validOrdinaryWorkerInput({ ...value, run: { ...value.run, seconds: 120 } }), true);
  const packet = ordinaryApprovalPacket({ scope, context: [], agentDirectory: value.agentDirectory });
  assert.match(packet, /SDK natural completion with no model-round count limit/);
  assert.equal(JSON.parse(packet).modelRounds.jobLimit, null);
});

test("readable scope approval contains complete literal worker sources, permissions, routes and exact duration", async t => {
  const f = await fixture(t), scope = structuredClone(f.scope), agentDirectory = path.dirname(path.dirname(scope.agents[0]!.file));
  scope.input.task = 'Inspect "two words".\nDo not use other files.';
  scope.agents[0]!.systemPrompt = 'Read only the provided file IDs.\nPreserve "literal quotes".';
  scope.input.limits.seconds = 600; scope.input.limits.modelCalls = null; scope.input.limits.perWorkerCalls = null;
  const doc = ordinaryApprovalText({ scope, context: [], agentDirectory }), raw = ordinaryApprovalPacket({ scope, context: [], agentDirectory });
  assert.equal(doc.trimStart().startsWith("{"), false); assert.ok(doc.includes(scope.input.task));
  assert.ok(doc.includes("after approval 10m (600s)")); assert.ok(doc.includes("no model-round cap"));
  assert.ok(doc.includes("file-1 · fixture.txt")); assert.ok(doc.includes("read / edit / write"));
  for (const task of scope.input.tasks) assert.ok(doc.includes(task.summary));
  for (const agent of scope.agents) assert.ok(doc.includes(ordinaryPrompts(scope, agent, "unused", []).systemPrompt));
  assert.equal(doc.includes(JSON.stringify(scope.input.task)), false); assert.equal(doc.includes(raw), false);
  assert.deepEqual(JSON.parse(raw).scope, scope); assert.ok(doc.includes(scope.contextDigest));
});

test("native exact first scope approval precedes two sequential workers; no Goal/user criterion JSON or second approval", async t => {
  const f = await fixture(t), result = await ordinaryDelegate(input, f.ctx, undefined, undefined, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(result.taskAcceptance, "needs_human_review"); assert.equal(result.modelCalls, 2);
  assert.equal(result.reservedModelCalls, 0); assert.equal(result.costEstimate.delegationTotalUsd, 0.002);
  assert.equal(result.lockRetained, false); assert.deepEqual(f.counts(), { confirmations: 1, starts: 2, closes: 1 });
  assert.equal(JSON.stringify(result).includes("Use only supplied"), false);
  const view = delegateResultView({ details: result }, { isPartial: false, expanded: true, isError: false });
  assert.match(view.text, /unverified/); assert.equal(view.text.includes("PRIVATE_WORKER_CLAIM"), false);
});

test("approval waiting spends no worker budget and starts one bounded execution clock after the reply", async t => {
  const f = await fixture(t); let submittedAt = 0;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  let reply!: (value: boolean) => void, requested!: () => void;
  const ready = new Promise<void>(resolve => { requested = resolve; });
  const confirm = f.ctx.ui.confirm;
  f.ctx.ui.confirm = async (title, packet, options) => {
    assert.match(packet, /Approval waits without a response deadline/); assert.equal(options?.timeout, undefined);
    await confirm(title, packet, options);
    return await new Promise<boolean>(resolve => { reply = resolve; requested(); });
  };
  const run = f.io.run;
  f.io.run = async (dto, signal) => {
    assert.ok(dto.approvedAt >= submittedAt && dto.approvedAt <= Date.now());
    assert.equal(dto.deadline, dto.approvedAt + input.limits.seconds * 1000);
    assert.equal(validOrdinaryWorkerInput({ ...dto, deadline: dto.deadline + 1 }), false);
    assert.equal(validOrdinaryWorkerInput({ ...dto, approvedAt: dto.approvedAt - 1 }), false);
    return run(dto, signal);
  };
  let settled = false;
  const work = ordinaryDelegate(input, f.ctx, t.signal, undefined, f.io).then(value => { settled = true; return value; });
  await ready; t.mock.timers.tick(86_400_000);
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.counts().starts, 0); assert.equal(f.counts().closes, 0);
  submittedAt = Date.now(); reply(true); const result = await work;
  assert.equal(result.status, "completed_unverified"); assert.equal(result.modelCalls, 2); assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(f.counts(), { confirmations: 1, starts: 2, closes: 1 });
});

test("schema rejects caller grants, scope expansion, legacy verifier mixing and stored state", () => {
  assert.equal(Value.Check(DelegateToolInputSchema, { scope: input }), true);
  for (const value of [{ scope: input, grant: true }, { scope: input, verification: { command: "node", args: [] } },
    { scope: { ...input, restore: true } }, { scope: { ...input, files: [{ path: "../outside", access: "read_write" }] }, state: { phase: "running" } }])
    assert.equal(Value.Check(DelegateToolInputSchema, value), false);
});

test("no UI, denial and throwing/modified native approval never start an owner, worker or JEV", async t => {
  for (const mode of ["no_ui", "deny", "throw", "nonliteral"] as const) {
    const f = await fixture(t); if (mode === "no_ui") f.ctx.hasUI = false;
    else f.ctx.ui.confirm = async () => { if (mode === "throw") throw new Error("PRIVATE_NATIVE_ERROR"); return (mode === "nonliteral" ? "true" : false) as boolean; };
    const result = await ordinaryDelegate(input, f.ctx, undefined, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(f.counts().starts, 0); assert.equal(f.counts().closes, 0); assert.equal(result.jevRequests, 0);
    assert.equal(JSON.stringify(result).includes("PRIVATE_NATIVE_ERROR"), false);
  }
});

test("session change/profile freshness failure after approval blocks admission without alternate approval/protocol", async t => {
  for (const mode of ["session", "context"] as const) {
    const f = await fixture(t);
    if (mode === "session") f.ctx.ui.confirm = async () => { f.switchSession(); return true; };
    else f.io.checkContext = async () => { throw new Error("PRIVATE_SOURCE_CHANGED"); };
    const result = await ordinaryDelegate(input, f.ctx, undefined, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(f.counts().starts, 0); assert.equal(JSON.stringify(result).includes("PRIVATE_SOURCE_CHANGED"), false);
  }
});

test("unknown accounting or owned cleanup retains scope owner/reservations and stops second worker", async t => {
  for (const mode of ["accounting", "cleanup", "uncertain", "exception"] as const) {
    const f = await fixture(t), run = f.io.run;
    f.io.run = async (dto, signal) => {
      if (mode === "exception") throw new Error("PRIVATE_PROCESS_FAILURE");
      const result = await run(dto, signal); assert.ok(result.result);
      if (mode === "accounting") result.result.reply.report.accounting = { status: "unknown" };
      if (mode === "cleanup") result.cleanupConfirmed = false;
      if (mode === "uncertain") result.result.files.uncertain = true;
      return result;
    };
    const result = await ordinaryDelegate(input, f.ctx, undefined, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.ok(f.counts().starts <= 1); assert.equal(result.lockRetained, true);
    assert.equal(result.cleanupConfirmed, false); assert.equal(result.costEstimate.delegationTotalUsd, null);
  }
});

test("cancellation while native worker is pending preserves late measured calls once; no next worker", async t => {
  const f = await fixture(t), controller = new AbortController();
  let received!: () => void; const started = new Promise<void>(resolve => { received = resolve; });
  f.io.run = async dto => { received(); await new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { started: true, cleanupConfirmed: true, result: f.reply(dto) }; };
  const pending = ordinaryDelegate(input, f.ctx, controller.signal, undefined, f.io); await started; controller.abort();
  const result = await pending; assert.equal(result.status, "stopped"); assert.equal(result.modelCalls, 1); assert.equal(result.reports.length, 1);
  assert.equal(result.workersStarted, 1); assert.equal(result.jevRequests, 0);
});

test("ordinary owned expiry timer versus user abort preserves late usage and cleanup without workers or real waits", async t => {
  for (const seconds of [600, 86_400]) for (const cause of ["timer", "user_before", "user_at"] as const) for (const native of [false, true]) for (const cleanup of [false, true]) {
    await t.test(`${seconds}s, ${cause}, ${native ? "SDK-native" : "finite"}, cleanup=${cleanup}`, async t => {
      const f = await fixture(t), controller = new AbortController(), approvedAt = 1_000_000, durationMs = seconds * 1000;
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: approvedAt });
      const http = t.mock.method(globalThis, "fetch", async () => assert.fail("No model or translation HTTP."));
      const fork = t.mock.method(childProcess, "fork", () => assert.fail("No real worker."));
      const spawn = t.mock.method(childProcess, "spawn", () => assert.fail("No process."));
      f.io.select = async () => assert.fail("No JEV selection.");
      f.io.canonicalDirectory = async (requested, privacy, signal) => {
        assert.equal(requested, f.ctx.cwd); assert.equal(privacy, false); assert.equal(signal?.aborted, false);
        return f.scope.files.root;
      };
      f.scope.input.limits = { workerRuns: 2, seconds, modelCalls: native ? null : 4, perWorkerCalls: native ? null : 2 };
      const snapshot = structuredClone(f.scope.input), measuredCalls = native ? 13 : 1;
      let entered!: () => void, release!: () => void, workerSignal: AbortSignal | undefined, starts = 0, aborts = 0;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const receipt = new Promise<void>(resolve => { release = resolve; });
      f.io.run = async (dto, signal) => {
        starts++; workerSignal = signal;
        assert.equal(f.counts().confirmations, 1); assert.equal(validOrdinaryWorkerInput(dto), true);
        assert.equal(dto.approvedAt, approvedAt); assert.equal(dto.deadline, approvedAt + durationMs);
        assert.equal(dto.run.maxModelCalls, native ? null : 2); assert.deepEqual(dto.scope.input, snapshot);
        const aborted = new Promise<void>(resolve => signal.addEventListener("abort", () => { aborts++; resolve(); }, { once: true }));
        entered(); await aborted; await receipt;
        const result = f.reply(dto); result.reply.report.modelCalls = measuredCalls;
        return { started: true, cleanupConfirmed: cleanup, result };
      };
      const pending = ordinaryDelegate(f.scope.input, f.ctx, controller.signal, undefined, f.io);
      await Promise.race([started, pending.then(() => assert.fail("Fixture stopped before mock worker admission"))]);
      assert.ok(workerSignal); assert.equal(workerSignal.aborted, false);
      if (cause === "user_at") {
        // Move the clock without firing the owned timer: a user abort at the boundary is still expiry.
        t.mock.timers.setTime(approvedAt + durationMs); controller.abort();
      } else {
        t.mock.timers.tick(durationMs - 1); assert.equal(workerSignal.aborted, false);
        if (cause === "timer") t.mock.timers.tick(1); else controller.abort();
      }
      assert.equal(workerSignal.aborted, true); assert.equal(aborts, 1);
      assert.equal(controller.signal.aborted, cause !== "timer");
      // A predeadline user stop stays cancelled even when its receipt arrives after expiry.
      t.mock.timers.tick(1_000); release();
      const result = await pending, expired = cause !== "user_before";
      assert.equal(result.status, "stopped"); assert.equal(result.reason, expired ? "expired" : "cancelled");
      assert.match(basicRunSummary(result), expired ? /Deadline expired/ : /Cancelled/);
      assert.equal(result.workersStarted, 1); assert.equal(starts, 1); assert.equal(result.modelCalls, measuredCalls);
      assert.equal(result.reservedModelCalls, cleanup ? 0 : native ? null : 1);
      assert.equal(result.lockRetained, !cleanup); assert.equal(result.cleanupConfirmed, cleanup);
      assert.equal(result.costEstimate.delegationTotalUsd, cleanup ? 0.001 : null);
      assert.equal(result.jevRequests, 0); assert.equal(f.counts().confirmations, 1); assert.equal(f.counts().closes, 1);
      assert.deepEqual(f.scope.input, snapshot);
      assert.equal(http.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0); assert.equal(spawn.mock.callCount(), 0);
    });
  }
});

test("JEV selection plans send only approved summary/candidate/optional skill metadata; single/parent-pinned never consult", async t => {
  const f = await fixture(t), scope = f.scope;
  assert.deepEqual(ordinarySelectionPlan(scope, "fix"), { source: "parent", agent: "worker" });
  scope.agents.push({ ...scope.agents[0]!, name: "strong" }); scope.input.agents.push("strong");
  scope.workerTargets.push({ ...scope.workerTargets[0]!, agent: "strong" }); scope.input.selection = "parent_or_jev";
  scope.routingTarget = "Anonymous loopback target";
  scope.input.skillCandidates = [{ name: "syntax", description: "Focused syntax inspection." }];
  const plan = ordinarySelectionPlan(scope, "review"); assert.equal(plan?.source, "jev");
  assert.equal(JSON.stringify(plan).includes("systemPrompt"), false); assert.equal(JSON.stringify(plan).includes(scope.files.root), false);
  assert.equal(JSON.stringify(plan).includes("PRIVATE"), false);
  const packet = ordinaryApprovalPacket({ scope, context: [], agentDirectory: path.dirname(path.dirname(scope.agents[0]!.file)) });
  assert.match(packet, /maximumRequests/); assert.match(packet, /skillCandidates/);
});

test("JEV stays in the approved prose/skill catalog; reported or unknown receipts settle/retain ownership without fallback", async t => {
  const keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"];
  const saved = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
  process.env.JEV_BACKEND = "openjev"; process.env.OPENJEV_BASE_URL = "http://127.0.0.1:8000"; process.env.OPENJEV_MODEL = "openjev-0.1"; delete process.env.OPENJEV_API_KEY;
  for (const unknown of [false, true]) {
    const f = await fixture(t);
    f.scope.input.agents.push("strong"); f.scope.input.tasks[0]!.agent = "worker"; f.scope.input.selection = "parent_or_jev";
    f.scope.input.skillCandidates = [{ name: "syntax", description: "Focused syntax inspection." }];
    f.scope.agents.push({ ...f.scope.agents[0]!, name: "strong", file: path.join(path.dirname(f.scope.agents[0]!.file), "strong.md") });
    f.scope.workerTargets.push({ ...f.scope.workerTargets[0]!, agent: "strong" });
    const target = readJevConnection(); assert.ok(target.ok); f.scope.routingTarget = describeJevTarget(target.connection);
    let selections = 0;
    f.io.select = async (effect, _signal, attempted, expected) => {
      selections++; assert.equal(f.counts().confirmations, 1); assert.equal(expected?.apiKey, null);
      assert.equal(effect.type, "call_jev"); if (effect.type !== "call_jev") assert.fail("Unexpected routing");
      assert.equal(effect.request.task, f.scope.input.tasks[1]!.summary);
      assert.equal(effect.request.skillCandidates?.[0]?.name, "syntax"); assert.equal(JSON.stringify(effect).includes(f.scope.files.root), false);
      attempted?.();
      return unknown ? { type: "failed", error: "PRIVATE_JEV_FAILURE" } : { type: "resolved", decision: { agent: "strong", confidence: 1,
        model: "openjev-0.1", provider: "openjev", requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } };
    };
    const result = await ordinaryDelegate(f.scope.input, f.ctx, undefined, undefined, f.io);
    assert.equal(selections, 1); assert.equal(result.jevRequests, 1); assert.equal(f.counts().confirmations, 1);
    assert.equal(result.reservedJevRequests, unknown ? 1 : 0); assert.equal(result.lockRetained, unknown);
    assert.equal(result.status, unknown ? "stopped" : "completed_unverified"); assert.equal(result.costEstimate.delegationTotalUsd, null);
    assert.equal(JSON.stringify(result).includes("PRIVATE_JEV_FAILURE"), false);
  }
});

test("routing accounting and Windows control batching are pure and bounded before IO, never retry larger frames", () => {
  const initial = { tasks: [], pending: [], reports: [], blocked: false };
  const first = reduceOrdinaryRoutingAccounting(initial, { type: "attempt", taskId: "first", maximum: 1 });
  assert.equal(first.pending.length, 1); assert.equal(reduceOrdinaryRoutingAccounting(first, { type: "attempt", taskId: "first", maximum: 1 }).blocked, true);
  assert.equal(reduceOrdinaryRoutingAccounting(first, { type: "receipt", taskId: "foreign", report: {} }), first);
  assert.equal(ordinaryControlBatches([], "/owner", 200).length, 1);
  assert.equal(ordinaryControlBatches(Array.from({ length: 128 }, (_, i) => ({ path: `/control-${i}`, active: false, text: null, version: null })), "/owner", 200).length, 2);
});

test("registered scoped adapter remains sequential, registers ordinary and parent memory tools and fails closed after shutdown", async () => {
  const tools: ToolDefinition[] = [], handlers = new Map<string, (() => Promise<void>)[]>();
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, handler: () => Promise<void>) {
    handlers.set(event, [...handlers.get(event) ?? [], handler]);
  } } as unknown as ExtensionAPI);
  assert.deepEqual(tools.map(tool => tool.name), ["jev_route", "jev_decide", "jev_delegate", "jev_memory"]); const tool = tools.find(tool => tool.name === "jev_delegate")!;
  assert.equal(tool.executionMode, "sequential"); assert.equal(Value.Check(tool.parameters, { scope: input }), true);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "headless", getBranch: () => [] } } as unknown as ExtensionContext;
  await assert.rejects(tool.execute("scope", { scope: input }, undefined, undefined, ctx), /Scoped delegation stopped/);
  assert.ok(handlers.has("session_before_tree")); assert.ok(handlers.has("session_before_fork"));
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  await assert.rejects(tool.execute("scope", { scope: input }, undefined, undefined, ctx), /owner is closed/);
});

async function realOwnedSdk(t: TestContext, graphMode: boolean, jobMemoryMode = false) {
  const began = performance.now(), timing: { phase: string; ms: number }[] = [];
  const boundaries: { check: string; startedMs: number; elapsedMs: number | null }[] = [];
  const measure = async <T>(check: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now(), entry = { check, startedMs: Math.round(started - began), elapsedMs: null as number | null };
    boundaries.push(entry);
    try { return await run(); } finally { entry.elapsedMs = Math.round(performance.now() - started); }
  };
  const tick = (phase: string) => { if (timing.at(-1)?.phase !== phase) timing.push({ phase, ms: Math.round(performance.now() - began) }); };
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-scope-sdk-"))), cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
  await mkdir(cwd); await mkdir(path.join(agentDir, "agents"), { recursive: true });
  await writeFile(path.join(cwd, "fixture.txt"), "BEFORE\n"); await writeFile(path.join(cwd, "AGENTS.md"), "Only change the approved fixture.\n");
  await writeFile(path.join(agentDir, "agents", "worker.md"), "---\nname: worker\ndescription: Fix the approved file.\ntools: read, edit\nmodel: offline/offline-worker\n---\nUse only the provided restricted tools.\n");
  const saved = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const routeKeys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"], routeValues = routeKeys.map(key => process.env[key]);
  let requests = 0, approvals = 0, launches = 0, choices = 0, memoryChoices = 0; const toolNames: string[][] = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests++; toolNames.push(body.tools.map((tool: { function: { name: string } }) => tool.function.name));
    if (graphMode) { assert.ok(JSON.stringify(body.messages).includes("B_SELECTED_INPUT")); assert.ok(JSON.stringify(body.messages).includes("READONLY_MEMORY_REFERENCE")); assert.doesNotMatch(JSON.stringify(body.messages), /UNSELECTED_A/); }
    if (jobMemoryMode) { assert.match(JSON.stringify(body.messages), /READONLY_JOB_MEMORY_REFERENCE/); assert.doesNotMatch(JSON.stringify(body.messages), /UNSELECTED_JOB_MEMORY_SOURCE|memory-backend-not-created/); }
    const delta = requests === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "scoped-edit", type: "function",
      function: { name: "scope_edit", arguments: JSON.stringify({ fileId: "file-1", oldText: "BEFORE", newText: "AFTER" }) } }] }
      : { role: "assistant", content: "Edited the approved file. Completion is unverified." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", created: 0, model: "offline-worker",
      choices: [{ index: 0, delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { offline: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "anonymous-offline-fixture", models: [{ id: "offline-worker", reasoning: false, contextWindow: 65536, maxTokens: 1024,
      cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 } }] } } }));
  let settled = false;
  t.after(async () => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    routeKeys.forEach((key, index) => { if (routeValues[index] === undefined) delete process.env[key]; else process.env[key] = routeValues[index]; });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    // Unknown ownership retains fixture markers for inspection, never a cleanup claim.
    if (settled) await rm(root, { recursive: true, force: true });
    else console.log(JSON.stringify({ kind: "synthetic_sdk_timing", graphMode, jobMemoryMode, approvals, launches, requests, timing, boundaries }));
  });
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...[modulePath, args, options]: Parameters<typeof fork>) => {
    assert.match(path.basename(options!.execPath!).toLowerCase(), /^bun(?:\.exe)?$/);
    assert.equal(options!.serialization, "json"); assert.ok(options!.execArgv?.some(arg => arg.startsWith("--config=")));
    launches++; return fork(modulePath, args, { ...options, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}) } });
  });
  const ctx = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "sdk-session" }, ui: { confirm: async (_title: string, packet: string) => {
    approvals++; assert.equal(requests, 0); assert.equal(launches, 0);
    assert.match(packet, /Existing file-ID read\/edit\/write only/); assert.match(packet, /tools read, edit/);
    assert.ok(packet.includes(`http://127.0.0.1:${address.port}/v1`));
    assert.ok(packet.includes("file-1 · fixture.txt")); assert.ok(packet.includes("Use only the provided restricted tools."));
    assert.equal(packet.includes("anonymous-offline-fixture"), false);
    if (jobMemoryMode) assert.match(packet, /READONLY_JOB_MEMORY_REFERENCE/);
    if (graphMode) for (const source of ["UNSELECTED_A_ONE", "UNSELECTED_A_TWO", "B_SELECTED_INPUT", "READONLY_MEMORY_REFERENCE"]) assert.ok(packet.includes(source));
    return true;
  } } } as unknown as ExtensionContext;
  const scope: OrdinaryScopeInput | OrdinaryGraphInput = graphMode ? { ...input, selection: "parent_or_jev",
    tasks: [{ id: "a2", summary: "UNSELECTED_A_TWO: review the longer route.", agent: "worker" },
      { id: "b1", summary: "B_SELECTED_INPUT: Change BEFORE to AFTER in the approved file.", agent: "worker" },
      { id: "a1", summary: "UNSELECTED_A_ONE: inspect the longer route.", agent: "worker" }],
    plan: { version: 2, entry: "choose", nodes: [{ id: "merge", kind: "join" }, { id: "a2", kind: "task" }, { id: "b1", kind: "task" },
      { id: "choose", kind: "choice", summary: "Choose the approved route.", choices: [{ id: "a", description: "Use the longer route." }, { id: "b", description: "Use the shorter route." }] }, { id: "a1", kind: "task" }],
      edges: [{ from: "a2", to: "merge" }, { from: "choose", to: "b1", when: "b" }, { from: "b1", to: "merge" }, { from: "a1", to: "a2" }, { from: "choose", to: "a1", when: "a" }] },
  } : { ...input, tasks: [input.tasks[0]!], limits: { ...input.limits, workerRuns: 1 } };
  if (graphMode) {
    scope.memorySnapshot = memorySnapshot({ version: 1, projectKey: memoryProjectKey(cwd), revision: 1,
      facts: [{ id: "fact_a", kind: "decision", title: "Public fixture memory", content: "READONLY_MEMORY_REFERENCE", provenance: "Synthetic parent review.", createdRevision: 1 }], edges: [] }, ["fact_a"]);
  }
  if (graphMode || jobMemoryMode) {
    Object.assign(process.env, { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: `http://127.0.0.1:${address.port}`, OPENJEV_MODEL: "openjev-0.1" });
    delete process.env.OPENJEV_API_KEY;
  }
  // The legacy SDK case covers native directory admission; this case isolates branch/child binding.
  const io: typeof ordinaryIO = graphMode ? { ...ordinaryIO, canonicalDirectory: async (directory: string) => { assert.equal(directory, cwd); return await realpath(directory); },
    select: async (_effect: Parameters<typeof ordinaryIO.select>[0], _signal: AbortSignal | undefined, attempted?: () => void) => {
    assert.equal(approvals, 1); assert.equal(launches, 0); choices++; attempted?.();
    return { type: "resolved" as const, decision: { agent: "b", confidence: 1, model: "openjev-0.1", provider: "openjev" as const,
      requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } };
  } } : { ...ordinaryIO };
  const jobMemory: DelegationMemoryInput = { directory: path.join(root, "memory-backend-not-created"), query: "Find the approved readonly reference." };
  if (jobMemoryMode) {
    const records = [
      { id: "fact_reference", kind: "decision", title: "Approved readonly reference", content: "READONLY_JOB_MEMORY_REFERENCE", provenance: "Synthetic exact parent review.", createdRevision: 1 },
      { id: "fact_other", kind: "decision", title: "Other approved candidate", content: "UNSELECTED_JOB_MEMORY_SOURCE", provenance: "Synthetic exact parent review.", createdRevision: 1 }];
    const data: DelegationMemorySource = { version: 1, projectKey: memoryProjectKey(cwd), directoryRef: memoryDigest(jobMemory.directory), revision: 1, query: jobMemory.query, records, additions: [] };
    // Store preparation is synthetic; approval, file leases and the owned SDK child remain real.
    io.prepareMemory = async () => ({ directory: jobMemory.directory, input: jobMemory, token: "synthetic-store-version", data });
    io.applyMemory = async () => { assert.equal(approvals, 1); return memorySnapshot({ version: 1, projectKey: data.projectKey, revision: 1, facts: records, edges: [] }, records.map(record => record.id)); };
    io.select = async (_effect, _signal, attempted) => {
      assert.equal(approvals, 1); assert.equal(launches, 0); memoryChoices++; attempted?.();
      assert.doesNotMatch(JSON.stringify(_effect), /READONLY_JOB_MEMORY_REFERENCE|UNSELECTED_JOB_MEMORY_SOURCE|memory-backend-not-created/);
      return { type: "resolved", decision: { agent: "record_0", confidence: 1, model: "openjev-0.1", provider: "openjev", requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } };
    };
  }
  const canonical = io.canonicalDirectory, context = io.checkContext, files = io.checkFiles, run = io.run;
  io.canonicalDirectory = (...args) => measure("directory", () => canonical(...args));
  io.checkContext = (...args) => measure("context", () => context(...args));
  io.checkFiles = (...args) => measure("files", () => files(...args));
  io.run = (...args) => measure("owned_worker", () => run(...args));
  const live: import("../src/plan-presentation.ts").PlanView[] = [];
  const result = await ordinaryDelegate(scope, ctx, t.signal, tick, io, undefined, view => { live.push(view); }, jobMemoryMode ? { memory: jobMemory } : undefined);
  assert.ok(live.some(view => view.phase === "running" && view.modelCalls > 0), `Real owned SDK progress must arrive before the final result: ${JSON.stringify({
    status: result.status, reason: result.reason, diagnostic: result.diagnostic, workerFailure: result.workerFailure,
    workers: result.workersStarted, modelCalls: result.modelCalls, cleanupConfirmed: result.cleanupConfirmed, lockRetained: result.lockRetained,
  })}`);
  settled = result.cleanupConfirmed && !result.lockRetained;
  assert.equal(result.status, "completed_unverified", JSON.stringify(result)); assert.equal(settled, true);
  assert.equal(await readFile(path.join(cwd, "fixture.txt"), "utf8"), "AFTER\n");
  assert.equal(approvals, 1); assert.equal(launches, 1); assert.equal(requests, 2); assert.equal(result.modelCalls, 2); assert.equal(result.jevRequests, graphMode || jobMemoryMode ? 1 : 0);
  assert.equal(choices, graphMode ? 1 : 0); assert.equal(memoryChoices, jobMemoryMode ? 1 : 0);
  if (graphMode) {
    assert.deepEqual(result.reports.map(report => report.taskId), ["b1"]);
    assert.equal(result.plan?.nodes.find(node => node.id === "a1")?.state, "skipped");
    assert.equal(result.plan?.nodes.find(node => node.id === "a2")?.state, "skipped");
    assert.equal(result.plan?.nodes.find(node => node.id === "merge")?.state, "joined");
  }
  assert.ok(toolNames.every(names => names.every(name => ["scope_read", "scope_edit"].includes(name))));
  await assert.rejects(access(path.join(cwd, ".jev-goal.lock")));
}

test("real owned scoped SDK process edits approved file with one RPC fixture approval, no standard tools or extra routing", { timeout: 30000 }, async t => {
  await realOwnedSdk(t, false);
});

test("real owned graph SDK process receives only selected B input, skips A tasks and joins with one exact approval", { timeout: 30000 }, async t => {
  await realOwnedSdk(t, true);
});

test("real owned SDK child receives only its selected job memory after one combined approval", { timeout: 30000 }, async t => {
  await realOwnedSdk(t, false, true);
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, realpath, writeFile, rm, readFile, lstat, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createAgentSession, ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import { initialSolState, reduceSol, reduceSolJob, SOL_ERROR, SOL_RECORD, type SolState, type SolJobState, type SolPiInput } from "../src/sol-pi.ts";
import { prepareSolPi, checkSolPi } from "../src/sol-pi-effects.ts";
import { executeSolPiWorker } from "../src/sol-pi-worker.ts";
import { executeWorker } from "../src/subagent-worker.ts";
import { runSolPi } from "../src/sol-pi-run.ts";
import { runSubagent, executeEffect } from "../src/delegate-effects.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialState, reduce, WorkerReplySchema, type Run } from "../src/delegate-machine.ts";
import { Value } from "typebox/value";
import { bunWorkerOptions, workerEnvironment } from "../src/worker-runtime.ts";
import { fixtureWorkDeadline, teardownOwnedFixture } from "./helpers/owned-fixture-teardown.ts";
const { execPath, execArgv } = bunWorkerOptions();
const shellRuntime = [execPath, ...execArgv].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");

// Resolve the SDK's installed peer, not a global pi installation or user package.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const ai = await import(import.meta.resolve("@earendil-works/pi-ai/providers/faux", sdkEntry));
type Packet = Parameters<ModelRuntime["streamSimple"]>[1];
const sourceDirectory = await realpath(fileURLToPath(new URL("./fixtures/sol-pi", import.meta.url)));
const units = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.001 };
const frozen = <T>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) frozen(item); } return value; };

test("Sol budget aggregates all three call paths and preserves reservations, clocks and terminal fences", () => {
  let state = initialSolState({ maxCalls: 3, maxReducerCalls: 1, maxSummaryCalls: 1, maxCompactions: 1, deadline: 1000, tools: ["read"] }, 1);
  for (const kind of ["worker", "reducer", "summary"] as const) {
    const before = frozen(structuredClone(state)), next = reduceSol(before, { type: "call", kind, now: 2 });
    assert.equal(next.effects[0]?.type, "admit"); state = next.state;
    assert.deepEqual(reduceSol(before, { type: "call", kind, now: 2 }), next);
  }
  assert.deepEqual(state.calls, { worker: 1, reducer: 1, summary: 1 });
  for (const id of [1, 2, 3]) state = reduceSol(state, { type: "settled", id, usage: units, ok: true, now: 3 }).state;
  assert.equal(state.usage.cost, 0.003); assert.deepEqual(reduceSol(state, { type: "settled", id: 1, usage: units, ok: true, now: 4 }).state, state);
  state = reduceSol(state, { type: "call", kind: "worker", now: 5 }).state;
  assert.equal(state.status, "draining"); assert.deepEqual(state.calls, { worker: 1, reducer: 1, summary: 1 });
  state = reduceSol(state, { type: "finish", completed: true, cleanupConfirmed: true, now: 6 }).state;
  assert.equal(state.status, "done"); assert.equal(state.status === "done" && state.result, "limit");
  assert.deepEqual(reduceSol(state, { type: "call", kind: "worker", now: 7 }), { state, effects: [] });
});

test("Sol cancellation drains late usage without another admission or a zero-cost success", () => {
  let state: SolState = initialSolState({ maxCalls: 3, maxReducerCalls: 1, maxSummaryCalls: 1, maxCompactions: 1, deadline: 1000, tools: [] }, 1);
  state = reduceSol(state, { type: "call", kind: "worker", now: 2 }).state;
  state = reduceSol(state, { type: "cancel" }).state;
  state = reduceSol(state, { type: "settled", id: 1, usage: units, ok: false, now: 3 }).state;
  assert.equal(state.usage.cost, 0.001); assert.equal(state.known, false);
  assert.deepEqual(reduceSol(state, { type: "call", kind: "worker", now: 4 }), { state, effects: [] });
  state = reduceSol(state, { type: "finish", completed: false, cleanupConfirmed: true, now: 5 }).state;
  assert.equal(state.status === "done" && state.result, "cancelled");
});

async function fixture(t: TestContext, features: Partial<SolPiInput> = {}, limits = { maxCalls: 6, contextWindow: 272000 }, signal = t.signal) {
  signal.throwIfAborted();
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-sol-"))), cwd = path.join(root, "work"), agentDir = path.join(root, "agent"), storageDirectory = path.join(root, "storage");
  const prior = { ...process.env }, umask = process.umask(0o077);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, workerEnvironment({ PATH: prior.PATH ?? "", HOME: root, TMPDIR: path.join(storageDirectory, "tmp"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1" }));
  const owner = new AbortController(), invocations: Promise<unknown>[] = []; let uncertain = false, constructed = false;
  const cleanup = { stop() {}, async release() {}, done: false };
  t.after(() => teardownOwnedFixture({ async stop() { owner.abort(); cleanup.stop(); }, invocations: () => invocations, release: () => cleanup.release(),
    async hasMarker() {
      if (uncertain || !constructed) return true;
      for (const marker of [path.join(cwd, ".jev-goal.lock"), path.join(storageDirectory, ".jev-goal.lock")]) {
        try { await lstat(marker); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
      }
      return false;
    }, remove: () => rm(root, { recursive: true, force: true }), reset() {
      if (process.env.PI_CODING_AGENT_DIR !== agentDir) return;
      process.umask(umask); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, prior);
    } }).finally(() => { cleanup.done = true; }));
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External HTTP forbidden"); });
  const fork = childProcess.fork, wire: { event: string; valid?: boolean; modelCalls?: number | null; cleanupConfirmed?: boolean; code?: number | null; signal?: string | null }[] = [];
  t.mock.method(childProcess, "fork", (modulePath: string | URL, args: readonly string[], options: childProcess.ForkOptions) => {
    const child = fork(typeof modulePath === "string" && path.basename(modulePath) === "sol-pi-worker.ts" ? path.join(path.dirname(modulePath), "sol-pi-worker.probe-bytecode.js") : modulePath, args, options);
    child.on("message", message => {
      const valid = Value.Check(WorkerReplySchema, message);
      wire.push({ event: "reply", valid, ...(valid ? { modelCalls: message.report.modelCalls, cleanupConfirmed: message.report.solPi?.cleanupConfirmed ?? false } : {}) });
    });
    child.once("close", (code, signal) => wire.push({ event: "close", code, signal }));
    return child;
  });
  for (const dir of [cwd, agentDir, storageDirectory, path.join(agentDir, "agents")]) await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(cwd, "AGENTS.md"), "Fixture instructions: never claim human acceptance.\n", { mode: 0o600 });
  const file = path.join(agentDir, "agents/sol.md"), systemPrompt = "Follow the explicit task. Do not delegate further.";
  await writeFile(file, `---\nname: sol\ndescription: Fixture Sol\nmodel: openai-codex/gpt-5.6-sol\nthinking: low\ntools: read,bash,edit,write\n---\n${systemPrompt}\n`, { mode: 0o600 });
  const options: SolPiInput = { sourceDirectory, storageDirectory, actionFusion: false, observationPack: false, evidencePreservingReducer: false,
    onlineContextCompact: false, maxReducerCalls: 0, maxSummaryCalls: 0, maxCompactions: 0, cacheWriteReadRatio: 12.5, ...features };
  const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const base: Run = { task: "Perform only the explicit synthetic fixture task.", cwd, model, maxModelCalls: limits.maxCalls,
    agent: { name: "sol", description: "Fixture Sol", model, thinking: "low", file, systemPrompt, tools: ["read", "bash", "edit", "write"] } };
  const preparation = prepareSolPi(base, options, AbortSignal.any([signal, owner.signal])); invocations.push(preparation);
  const run: Run = { ...base, solPi: await preparation };
  const faux = ai.fauxProvider({ provider: model.provider, api: "openai-codex-responses", models: [model.id].map(id =>
    ({ id, reasoning: true, input: ["text"], contextWindow: limits.contextWindow, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } })) });
  const packets: Packet[] = [], sessions: AgentSession[] = [], runtimes: ModelRuntime[] = [];
  const answer = (text: string | unknown[], stopReason = "stop") => (packet: Packet) => {
    packets.push(JSON.parse(JSON.stringify(packet)) as Packet); const reply = ai.fauxAssistantMessage(text, { stopReason });
    reply.usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 0.00002, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00004 } };
    return reply;
  };
  const io = {
    createModelRuntime: async (config: Parameters<typeof ModelRuntime.create>[0]) => {
      const runtime = await ModelRuntime.create({ ...config, refreshOnCreate: false });
      runtime.registerNativeProvider(faux.provider); await runtime.getAvailable(model.provider); runtimes.push(runtime); return runtime;
    },
    createAgentSession: async (config: Parameters<typeof createAgentSession>[0]) => {
      const created = await createAgentSession(config); sessions.push(created.session); return created;
    },
  };
  const invoke = (cancel?: AbortSignal, execute: Parameters<typeof runSolPi>[1] = (input, stopped) => executeSolPiWorker(input, stopped, io), selected = run) => {
    const work = runSolPi(selected, execute, AbortSignal.any([signal, owner.signal, ...(cancel ? [cancel] : [])])).then(result => {
      uncertain ||= result.report?.solPi?.cleanupConfirmed !== true || result.report?.solPi?.lockRetained !== false; return result;
    });
    invocations.push(work); return work;
  };
  constructed = true;
  return { root, cwd, agentDir, storageDirectory, run, options, faux, packets, sessions, runtimes, answer, io, invoke, cleanup, wire };
}

test("a cancelled Sol fixture cannot replace environment, umask or register cleanup", async t => {
  const before = process.env, mask = process.umask(), reason = new Error("Synthetic Sol fixture cancellation"); let hooks = 0;
  const cancelled = { signal: AbortSignal.abort(reason), mock: t.mock, after(hook: () => Promise<void>) { hooks++; t.after(hook); } } as unknown as TestContext;
  await assert.rejects(fixture(cancelled), { message: reason.message });
  assert.equal(hooks, 0); assert.equal(process.env, before); assert.equal(process.umask(), mask);
});

test("late Sol teardown preserves a successor environment and umask", { skip: process.platform === "win32" }, async t => {
  const prior = { ...process.env }, mask = process.umask(); let successor: string | undefined, done = () => false;
  t.after(() => {
    if (process.env.PI_CODING_AGENT_DIR !== successor) return;
    process.umask(mask); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, prior);
  });
  await t.test("close the earlier owner", async child => {
    const f = await fixture(child); done = () => f.cleanup.done; successor = `${f.agentDir}-successor`;
    process.env.PI_CODING_AGENT_DIR = successor; process.umask(0o027);
  });
  assert.equal(done(), true); assert.equal(process.env.PI_CODING_AGENT_DIR, successor); assert.equal(process.umask(), 0o027);
});

test("Sol pinned standalone runtime uses real SDK, no inherited extensions and aggregate accounting", async t => {
  const f = await fixture(t); f.faux.setResponses([f.answer("Synthetic task complete; human review required.")]);
  const result = await f.invoke(); assert.equal(result.type, "completed", JSON.stringify({ result, fauxCalls: f.faux.state.callCount, packets: f.packets.length }));
  assert.equal(f.faux.state.callCount, 1); assert.equal(result.report?.modelCalls, 1);
  assert.deepEqual(result.report?.solPi?.calls, { worker: 1, reducer: 0, summary: 0 });
  assert.equal(result.report?.solPi?.cleanupConfirmed, true); assert.equal(result.report?.solPi?.lockRetained, false);
  assert.match(f.packets[0]!.systemPrompt!, /Fixture instructions/);
  const records = (await readFile(path.join(f.storageDirectory, SOL_RECORD), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.kind), ["admitted", "observed"]);
  await assert.rejects(lstat(path.join(f.cwd, ".jev-goal.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.storageDirectory, ".jev-goal.lock")), { code: "ENOENT" });
  const runtime = f.runtimes[0]!, model = runtime.getModel(f.run.model.provider, f.run.model.id)!;
  await assert.rejects(runtime.complete(model, { messages: [] }));
  assert.throws(() => runtime.streamSimple(model, { messages: [] }));
  assert.throws(() => runtime.stream(model, { messages: [] }));
  assert.equal(f.faux.state.callCount, 1, "late callbacks cannot reopen unmetered transports");
});

test("all four upstream features load together and Action Fusion executes only the approved tool path", async t => {
  const f = await fixture(t, { actionFusion: true, observationPack: true, evidencePreservingReducer: true, onlineContextCompact: true,
    maxReducerCalls: 1, maxSummaryCalls: 2, maxCompactions: 1 });
  f.faux.setResponses([
    f.answer([ai.fauxToolCall("write", { path: "value.txt", content: "OK\n", then_run: { command: `${shellRuntime} -e "process.stdout.write('CHECK_OK')"` } })], "toolUse"),
    f.answer([ai.fauxToolCall("update_plan", { steps: [{ id: "review", goal: "human review", status: "in_progress" }] })], "toolUse"),
    f.answer("Synthetic fused check passed; acceptance still requires review."),
  ]);
  const result = await f.invoke(); assert.equal(result.type, "completed", JSON.stringify({ result, fauxCalls: f.faux.state.callCount, packets: f.packets.length }));
  assert.equal(f.faux.state.callCount, 3); assert.equal(await readFile(path.join(f.cwd, "value.txt"), "utf8"), "OK\n");
  assert.match(JSON.stringify(f.packets), /then_run:succeeded/); assert.match(JSON.stringify(f.packets), /CHECK_OK/);
  assert.ok(f.sessions[0]!.getAllTools().some(tool => tool.name === "obs_recall"));
  assert.ok(f.sessions[0]!.getAllTools().some(tool => tool.name === "update_plan"));
});

for (const singleToolReply of [false, true]) test(singleToolReply
  ? "single-tool SoL-Pi path compacts before fused verification"
  : "combined SoL-Pi path preserves actions, observations, evidence, and native continuation", async t => {
  const f = await fixture(t, { actionFusion: true, observationPack: true, evidencePreservingReducer: true,
    onlineContextCompact: true, maxReducerCalls: 1, maxSummaryCalls: 2, maxCompactions: 1, cacheWriteReadRatio: 0 },
    { maxCalls: 12, contextWindow: 272000 });
  // Each 48 kB observation fits native read limits. Ratio zero exercises the
  // economic boundary, not window exhaustion or a claim of live cost savings.
  const first = ("FIRST_SYNTHETIC_LINE".padEnd(79, ".") + "\n").repeat(600);
  const second = ("SECOND_SYNTHETIC_LINE".padEnd(79, ".") + "\n").repeat(600);
  const third = ("THIRD_SYNTHETIC_LINE".padEnd(79, ".") + "\n").repeat(600);
  await writeFile(path.join(f.cwd, "first.txt"), first); await writeFile(path.join(f.cwd, "second.txt"), second);
  await writeFile(path.join(f.cwd, "third.txt"), third);
  await writeFile(path.join(f.cwd, "Makefile"), `test:\n\t${shellRuntime.replaceAll("$", () => "$$")} check.cjs\n`);
  await writeFile(path.join(f.cwd, "check.cjs"), 'console.log("bounded diagnostic\\n".repeat(300)); console.log("TEST_OK");');
  const observeGoal = singleToolReply ? "read fixtures" : "read and check fixtures";
  const program: unknown[][] = [
    [ai.fauxToolCall("update_plan", { steps: [{ id: "observe", goal: observeGoal, status: "in_progress" }] })],
    [ai.fauxToolCall("read", { path: "first.txt" })],
    [ai.fauxToolCall("read", { path: "second.txt" })],
    [ai.fauxToolCall("read", { path: "third.txt" })],
    [ai.fauxToolCall("write", { path: "combined.txt", content: "COMBINED\n", then_run: { command: "make test" } }),
      ai.fauxToolCall("update_plan", { steps: [{ id: "observe", goal: observeGoal, status: "completed" }],
        progress: { files_changed: singleToolReply ? [] : ["combined.txt"], verification: [], decisions: ["review remains required"] } })],
    [ai.fauxToolCall("update_plan", { steps: [{ id: "review", goal: "recall evidence for human review", status: "in_progress" }] })],
  ];
  // A live model may split write and plan completion. Pack can then shrink the
  // context below the 20k keep threshold. Complete the read boundary first;
  // move the fused write after recall without changing usage, window or limits.
  if (singleToolReply) program[7] = [program[4]!.shift()!];
  let worker = 0, recallId: string | undefined;
  f.faux.setResponses(Array.from({ length: 12 }, () => (packet: Packet) => {
    if (!packet.tools?.length) {
      if (packet.systemPrompt?.startsWith("You are a lossless test/build output reducer.")) {
        const hash = JSON.stringify(packet).match(/source_sha256=([a-f0-9]{64})/)?.[1]; assert.ok(hash);
        return f.answer(JSON.stringify({ schema: "sol-pi-evidence-receipt/1", source_sha256: hash, status: "success", uncertain: false,
          evidence: [{ kind: "summary", quote: "TEST_OK" }] }))(packet);
      }
      return f.answer("SYNTHETIC_NATIVE_SUMMARY: fixtures observed; human review remains required.")(packet);
    }
    const step = worker++;
    if (step === 4) {
      const placeholder = packet.messages.flatMap(message => message.role === "toolResult" && message.toolName === "read"
        ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : [])
        .find(text => text.includes("FIRST_SYNTHETIC_LINE") && /obs_[a-f0-9]{24}/.test(text));
      recallId = placeholder?.match(/obs_[a-f0-9]{24}/)?.[0]; assert.ok(recallId);
      // Keep the received ID in normal history so continuation can recall it
      // after compaction; do not inject private archive metadata into a request.
      return f.answer([{ type: "text", text: `Archived first observation: ${recallId}` }, ...program[step]!], "toolUse")(packet);
    }
    if (step === 6) {
      const id = JSON.stringify(packet).match(/Archived first observation: (obs_[a-f0-9]{24})/)?.[1];
      assert.ok(id); assert.equal(id, recallId);
      return f.answer([ai.fauxToolCall("obs_recall", { id, offset: 0 })], "toolUse")(packet);
    }
    const tools = program[step];
    return f.answer(tools ?? "Fixture work stopped; separate verification and human review remain required.", tools ? "toolUse" : "stop")(packet);
  }));
  const result = await f.invoke(); assert.equal(result.type, "completed", JSON.stringify(result));
  const report = result.report!.solPi!; assert.ok(report.calls);
  assert.equal(report.calls.worker, singleToolReply ? 9 : 8); assert.equal(report.calls.reducer, 1);
  assert.ok(report.calls.summary >= 1 && report.calls.summary <= 2);
  const total = report.calls.worker + report.calls.reducer + report.calls.summary;
  assert.ok(total <= 12); assert.equal(result.report!.modelCalls, total); assert.equal(f.faux.state.callCount, total);
  assert.ok(result.report!.accounting.status === "reported"); assert.equal(result.report!.accounting.complete, true);
  assert.equal(report.compactions, 1); assert.equal(report.continuations, 1);
  assert.equal(report.cleanupConfirmed, true); assert.equal(report.lockRetained, false);
  assert.equal(await readFile(path.join(f.cwd, "combined.txt"), "utf8"), "COMBINED\n");
  const packets = f.packets.filter(packet => packet.tools?.length), texts = packets.map(packet => JSON.stringify(packet));
  assert.match(texts.join("\n"), /then_run:succeeded/); assert.match(texts.join("\n"), /sol_pi_evidence_receipt_v1/);
  assert.ok(texts[2]!.includes(JSON.stringify(first).slice(1, -1))); assert.ok(texts[3]!.includes(JSON.stringify(first).slice(1, -1)));
  assert.ok(!texts[4]!.includes(JSON.stringify(first).slice(1, -1))); assert.ok(recallId && texts[4]!.includes(recallId));
  const recall = packets[7]!.messages.at(-1)!; assert.ok(recall.role === "toolResult"); assert.equal(recall.toolName, "obs_recall");
  const recalled = recall.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  assert.match(recalled, /FIRST_SYNTHETIC_LINE/); assert.ok(Buffer.byteLength(recalled) <= 16 * 1024);
  assert.ok(recalled.trimEnd().split("\n").length <= 400);
  const session = f.sessions[0]!, manager = session.sessionManager, entries = manager.getEntries();
  assert.equal(entries.filter(entry => entry.type === "compaction").length, 1);
  const compactedAt = entries.findIndex(entry => entry.type === "compaction");
  const recalledAt = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "obs_recall");
  assert.ok(recalledAt > compactedAt, "archive recall must follow native compaction");
  if (singleToolReply) {
    for (const entry of entries) if (entry.type === "message" && entry.message.role === "assistant")
      assert.ok(entry.message.content.filter(block => block.type === "toolCall").length <= 1);
    const writtenAt = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "write");
    assert.ok(writtenAt > recalledAt, "fused verification follows compaction and bounded recall");
  }
  assert.match(JSON.stringify(session.messages), /SYNTHETIC_NATIVE_SUMMARY/);
  assert.ok(!JSON.stringify(session.messages).includes(JSON.stringify(first).slice(1, -1)), "old full observation is no longer in active history");
  const archive = path.join(manager.getSessionDir(), "sol-pi", manager.getSessionId(), "observation-pack");
  assert.equal(await readFile(path.join(archive, "objects", `${recallId}.txt`), "utf8"), first);
  const events = (await readFile(path.join(archive, "ledger.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    .filter(event => event.id === recallId);
  assert.deepEqual(events.slice(0, 3).map(event => event.event), ["full", "full", "placeholder"]);
  assert.ok(events.some(event => event.event === "recall" && event.offset === 0));
  const records = (await readFile(path.join(f.storageDirectory, SOL_RECORD), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.kind), ["admitted", "observed"]); assert.equal(records[1].outcome, "completed");
  assert.deepEqual(records[1].report.solPi.calls, report.calls); assert.equal(records[1].report.accounting.complete, true);
  await assert.rejects(lstat(path.join(f.cwd, ".jev-goal.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.storageDirectory, ".jev-goal.lock")), { code: "ENOENT" });
  t.diagnostic(JSON.stringify({ calls: report.calls, total, compactions: report.compactions, continuations: report.continuations }));
});

test("Sol refuses changed instructions, plain-worker bypass and ambiguous routing before execution", async t => {
  const f = await fixture(t);
  assert.equal((await executeWorker(f.run)).type, "failed");
  await writeFile(path.join(f.cwd, "AGENTS.md"), "CHANGED", { mode: 0o600 });
  await assert.rejects(checkSolPi(f.run), { message: SOL_ERROR });
  const rejected = reduce(initialState(), { type: "start", canConfirm: true, job: { cwd: f.cwd,
    input: { task: "x", agents: ["sol", "other"], solPi: f.options } } });
  assert.equal(rejected.state.status, "failed"); assert.deepEqual(rejected.effects, []); assert.equal(f.faux.state.callCount, 0);
});

test("ObservationPack sends twice, packs later and recalls a bounded archived page", async t => {
  const f = await fixture(t, { observationPack: true });
  const big = "large synthetic observation line\n".repeat(600);
  await writeFile(path.join(f.cwd, "large.txt"), big); await writeFile(path.join(f.cwd, "small.txt"), "small");
  f.faux.setResponses([
    f.answer([ai.fauxToolCall("read", { path: "large.txt" })], "toolUse"),
    f.answer([ai.fauxToolCall("read", { path: "small.txt" })], "toolUse"),
    f.answer([ai.fauxToolCall("read", { path: "small.txt" })], "toolUse"),
    (packet: Packet) => {
      const id = JSON.stringify(packet).match(/obs_[a-f0-9]{24}/)?.[0]; assert.ok(id);
      return f.answer([ai.fauxToolCall("obs_recall", { id, offset: 0 })], "toolUse")(packet);
    },
    f.answer("Reviewed archived fixture page; not human acceptance."),
  ]);
  const result = await f.invoke(); assert.equal(result.type, "completed", JSON.stringify(result));
  const texts = f.packets.map(packet => JSON.stringify(packet));
  assert.ok(texts[1]!.includes(JSON.stringify(big).slice(1, -1))); assert.ok(texts[2]!.includes(JSON.stringify(big).slice(1, -1)));
  assert.ok(!texts[3]!.includes(JSON.stringify(big).slice(1, -1))); assert.match(texts[3]!, /obs_[a-f0-9]{24}/);
  const recall = f.packets[4]!.messages.at(-1)!;
  assert.equal(recall.role, "toolResult"); assert.ok(Buffer.byteLength(JSON.stringify(recall)) < 20_000);
  assert.equal(result.report?.modelCalls, 5);
});

test("real upstream evidence reducer is metered, and invalid evidence cannot silently fall back", async t => {
  for (const valid of [true, false]) await t.test(valid ? "verified quotes" : "invalid receipt stops", async t => {
    const f = await fixture(t, { actionFusion: true, observationPack: true, evidencePreservingReducer: true, maxReducerCalls: 1,
      onlineContextCompact: true, maxSummaryCalls: 2, maxCompactions: 1 });
    await writeFile(path.join(f.cwd, "Makefile"), `test:\n\t${shellRuntime.replaceAll("$", () => "$$")} check.cjs\n`);
    await writeFile(path.join(f.cwd, "check.cjs"), 'console.log("synthetic test output\\n".repeat(600)); console.log("TEST_OK");');
    f.faux.setResponses([
      f.answer([ai.fauxToolCall("write", { path: "value.txt", content: "OK", then_run: { command: "make test" } })], "toolUse"),
      (packet: Packet) => {
        const hash = JSON.stringify(packet).match(/source_sha256=([a-f0-9]{64})/)?.[1]; assert.ok(hash);
        return f.answer(valid ? JSON.stringify({ schema: "sol-pi-evidence-receipt/1", source_sha256: hash,
          status: "success", uncertain: false, evidence: [{ kind: "summary", quote: "TEST_OK" }] }) : "PRIVATE_INVALID_RECEIPT")(packet);
      },
      f.answer("Observed quoted TEST_OK; separate verification and human acceptance still required."),
    ]);
    const result = await f.invoke(); assert.equal(result.type, valid ? "completed" : "failed", JSON.stringify(result));
    assert.equal(result.report?.solPi?.calls?.reducer, 1); assert.equal(result.report?.modelCalls, valid ? 3 : 2);
    assert.equal(result.report?.solPi?.lockRetained, !valid);
    if (valid) assert.match(JSON.stringify(f.packets.at(-1)), /sol_pi_evidence_receipt_v1/);
    else assert.ok(!JSON.stringify(result).includes("PRIVATE_INVALID_RECEIPT"));
  });
});

test("uncertain evidence and pre-candidate fallback without a tool ID stop instead of exposing raw logs", async t => {
  for (const secret of [true, false]) await t.test(secret ? "synthetic secret heuristic" : "uncertain receipt", async t => {
    const f = await fixture(t, { evidencePreservingReducer: true, maxReducerCalls: 1 });
    await writeFile(path.join(f.cwd, "Makefile"), `test:\n\t${shellRuntime.replaceAll("$", () => "$$")} check.cjs\n`);
    const marker = secret ? "authorization: SYNTHETIC_REDACTION_TEST_NOT_A_KEY" : "TEST_OK";
    await writeFile(path.join(f.cwd, "check.cjs"), `console.log("fixture diagnostic output\\n".repeat(300)); console.log(${JSON.stringify(marker)});`);
    f.faux.setResponses([
      f.answer([ai.fauxToolCall("bash", { command: "make test" })], "toolUse"),
      (packet: Packet) => {
        const hash = JSON.stringify(packet).match(/source_sha256=([a-f0-9]{64})/)?.[1]; assert.ok(hash);
        return f.answer(JSON.stringify({ schema: "sol-pi-evidence-receipt/1", source_sha256: hash,
          status: "success", uncertain: true, evidence: [{ kind: "summary", quote: "TEST_OK" }] }))(packet);
      }, f.answer("must not run"),
    ]);
    const result = await f.invoke(); assert.equal(result.type, "failed");
    assert.equal(result.report?.modelCalls, secret ? 1 : 2); assert.equal(result.report?.solPi?.calls?.reducer, secret ? 0 : 1);
    assert.equal(result.report?.solPi?.lockRetained, true);
    assert.ok(!JSON.stringify(f.packets).includes("SYNTHETIC_REDACTION_TEST_NOT_A_KEY"));
    assert.ok(!JSON.stringify(f.sessions[0]!.messages).includes("SYNTHETIC_REDACTION_TEST_NOT_A_KEY"));
  });
});

test("Online Context Compact makes a native summary and continues within the SAME SDK budget", async t => {
  const f = await fixture(t, { onlineContextCompact: true, maxSummaryCalls: 2, maxCompactions: 1, cacheWriteReadRatio: 0 },
    { maxCalls: 8, contextWindow: 16000 });
  await writeFile(path.join(f.cwd, "large.txt"), "synthetic bounded history ".repeat(1750));
  f.faux.setResponses([
    f.answer([ai.fauxToolCall("read", { path: "large.txt" })], "toolUse"),
    f.answer([ai.fauxToolCall("read", { path: "large.txt" })], "toolUse"),
    f.answer([ai.fauxToolCall("update_plan", { steps: [{ id: "read", goal: "read fixture", status: "in_progress" }] })], "toolUse"),
    f.answer([ai.fauxToolCall("update_plan", { steps: [{ id: "read", goal: "read fixture", status: "completed" }],
      progress: { files_changed: [], verification: [], decisions: ["fixture read only"] } })], "toolUse"),
    f.answer("Summary: fixture read; no independent verification or human acceptance."),
    f.answer("Fixture completion after native compaction; review remains required."),
    f.answer("Fixture completion after native compaction; review remains required."),
  ]);
  const result = await f.invoke(); assert.equal(result.type, "completed", JSON.stringify(result));
  const report = result.report!.solPi!; assert.ok(report.calls);
  assert.equal(report.compactions, 1); assert.equal(report.continuations, 1); assert.equal(report.calls.worker, 5);
  assert.ok(report.calls.summary >= 1 && report.calls.summary <= 2);
  assert.equal(f.faux.state.callCount, report.calls.worker + report.calls.summary);
  assert.equal(result.report!.modelCalls, f.faux.state.callCount);
  const entries = f.sessions[0]!.sessionManager.getEntries();
  assert.equal(entries.filter(entry => entry.type === "compaction").length, 1);
  assert.ok(entries.filter(entry => entry.type === "message").length > f.sessions[0]!.messages.length - 2);
});

test("Sol lifecycle expiry/cancellation never dispatches execution and terminal events are inert", async t => {
  const f = await fixture(t), grant = f.run.solPi!;
  const initial: SolJobState = { status: "idle", run: f.run, outcome: null, attempted: false, cancelled: false, keep: false, lastAt: grant.preparedAt };
  for (const now of [NaN, grant.preparedAt - 1, grant.approvalDeadline]) {
    const step = reduceSolJob(frozen(structuredClone(initial)), { type: "start", now });
    assert.equal(step.state.status, "closing"); assert.deepEqual(step.effects, [{ type: "close", keep: false }]);
  }
  let state = reduceSolJob(initial, { type: "start", now: grant.preparedAt }).state;
  assert.equal(state.status, "opening"); state = reduceSolJob(state, { type: "cancel" }).state;
  const step = reduceSolJob(state, { type: "opened", now: grant.preparedAt + 1 });
  assert.deepEqual(step.effects, [{ type: "close", keep: true }]);
  state = reduceSolJob(step.state, { type: "closed", ok: true, retained: true }).state;
  assert.equal(state.status === "done" && state.result.type, "cancel");
  assert.deepEqual(reduceSolJob(state, { type: "opened", now: grant.preparedAt + 2 }), { state, effects: [] });
  const controller = new AbortController(); controller.abort();
  const execute = t.mock.fn(async () => ({ type: "cancel" as const }));
  const result = await f.invoke(controller.signal, execute);
  assert.equal(result.type, "cancel"); assert.equal(result.report?.accounting.status, "not_started");
  assert.equal(result.report?.solPi?.lockRetained, false); assert.equal(execute.mock.callCount(), 0);
  assert.deepEqual(await readdir(f.storageDirectory), []);
});

test("Sol shared cap stops before another SDK call; missing replies and storage tampering retain ownership", async t => {
  await t.test("one-call cap", async t => {
    const f = await fixture(t, {}, { maxCalls: 1, contextWindow: 272000 });
    f.faux.setResponses([f.answer([ai.fauxToolCall("write", { path: "changed.txt", content: "APPLIED" })], "toolUse"), f.answer("must not run")]);
    const result = await f.invoke(); assert.equal(result.type, "failed"); assert.equal(f.faux.state.callCount, 1);
    assert.equal(result.report?.modelCalls, 1); assert.equal(result.report?.solPi?.lockRetained, true);
    assert.equal(await readFile(path.join(f.cwd, "changed.txt"), "utf8"), "APPLIED");
  });
  await t.test("missing worker receipt is not zero", async t => {
    const f = await fixture(t), result = await f.invoke(undefined, async () => ({ type: "failed", error: "worker lost" }));
    assert.equal(result.type, "failed"); assert.equal(result.report?.modelCalls, null); assert.equal(result.report?.solPi?.calls, null);
    assert.equal(result.report?.accounting.status, "unknown"); assert.equal(result.report?.solPi?.lockRetained, true);
    assert.ok((await lstat(path.join(f.cwd, ".jev-goal.lock"))).isFile());
  });
  await t.test("lost journal integrity cannot be overwritten", async t => {
    const f = await fixture(t); f.faux.setResponses([f.answer("Complete")]);
    const result = await f.invoke(undefined, async (run, signal) => {
      const reply = await executeSolPiWorker(run, signal, f.io);
      await writeFile(path.join(f.storageDirectory, SOL_RECORD), "PRIVATE_TAMPERED_RECORD\n"); return reply;
    });
    assert.equal(result.type, "failed"); assert.equal(result.report?.modelCalls, 1); assert.equal(result.report?.solPi?.lockRetained, true);
    assert.equal(await readFile(path.join(f.storageDirectory, SOL_RECORD), "utf8"), "PRIVATE_TAMPERED_RECORD\n");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_TAMPERED_RECORD"));
  });
});

test("Sol cancellation drains observations; provider output overruns fail without automatic rework", async t => {
  for (const cancelled of [true, false]) await t.test(cancelled ? "cancel" : "overrun", async t => {
    const f = await fixture(t), controller = new AbortController();
    f.faux.setResponses([(packet: Packet) => {
      const answer = f.answer(cancelled ? "Interrupted work" : "synthetic output ".repeat(1500))(packet);
      if (cancelled) controller.abort(); return answer;
    }, f.answer("must not run")]);
    const result = await f.invoke(controller.signal); assert.equal(result.type, cancelled ? "cancel" : "failed");
    assert.equal(f.faux.state.callCount, 1); assert.equal(result.report?.modelCalls, 1);
    assert.equal(result.report?.accounting.status, "reported"); assert.equal(result.report?.solPi?.lockRetained, true);
    assert.ok(result.report?.accounting.status === "reported" && !result.report.accounting.complete);
  });
});

test("Sol approval fails closed without native UI; strict options and exact prepared packets are required", async t => {
  const f = await fixture(t);
  const result = await executeEffect({ type: "confirm_run", run: f.run }, { hasUI: true, ui: {} } as ExtensionContext);
  assert.deepEqual(result.type, "approval"); assert.ok(result.type === "approval" && !result.approved);
  assert.deepEqual(await readdir(f.storageDirectory), []);
  const input = { task: f.run.task, agents: ["sol"], solPi: f.options };
  let state = reduce(initialState(), { type: "start", canConfirm: true, job: { input, cwd: f.cwd } }).state;
  state = reduce(state, { type: "agents_loaded", agents: [f.run.agent], capabilities: [{ model: f.run.model, thinking: ["low"], contextWindow: 272000 }] }).state;
  assert.ok(state.status === "preparing_harness");
  const grant = await prepareSolPi(state.run, state.options);
  const prepared = reduce(state, { type: "sol_prepared", prepared: grant, now: grant.preparedAt });
  assert.equal(prepared.state.status, "awaiting_approval");
  assert.equal(reduce(prepared.state, { type: "approval", approved: true, now: grant.approvalDeadline }).state.status, "cancelled");
  assert.equal(reduce(prepared.state, { type: "approval", approved: true, now: grant.preparedAt }).state.status, "running");
  const tampered = { ...grant, runDigest: "0".repeat(64) };
  assert.equal(reduce(state, { type: "sol_prepared", prepared: tampered, now: grant.preparedAt }).state.status, "failed");
  assert.equal(reduce(initialState(), { type: "start", canConfirm: true, job: { cwd: f.cwd,
    input: { ...input, solPi: { ...f.options, maxReducerCalls: 1 } } } }).state.status, "failed");
});

test("independent Sol child uses isolated loopback Codex: success, HTTP failure and cancellation", { timeout: 20000 }, async t => {
  const began = performance.now(), work = fixtureWorkDeadline(t.signal, 15_000); t.after(work.close);
  try {
  for (const mode of ["success", "error", "cancel"] as const) {
    work.signal.throwIfAborted();
    await t.test(mode, async t => {
  const signal = AbortSignal.any([work.signal, t.signal]); signal.throwIfAborted();
  const f = await fixture(t, {}, undefined, signal), requests: Record<string, unknown>[] = [], controller = new AbortController();
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST"); assert.match(req.url!, /\/responses$/);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); requests.push(JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(body) : body).toString("utf8")));
    if (mode === "cancel") { controller.abort(); return; }
    if (mode === "error") { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "PRIVATE_HTTP_BODY" } })); return; }
    const text = "Independent synthetic task completed; unverified.";
    const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_fixture" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
        usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } } },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  f.cleanup.stop = () => server.closeAllConnections();
  f.cleanup.release = () => new Promise<void>((resolve, reject) => server.close(error => {
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve();
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const fakeToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-fixture" } })).toString("base64url")}.fixture`;
  await writeFile(path.join(f.agentDir, "models.json"), JSON.stringify({ providers: { "openai-codex": {
    baseUrl: `http://127.0.0.1:${address.port}/codex`, api: "openai-codex-responses", apiKey: fakeToken,
    models: [{ id: "gpt-5.6-sol", reasoning: true, contextWindow: 272000, maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }],
  } } }));
  const { solPi: _old, ...base } = f.run;
  const run = { ...base, solPi: await prepareSolPi(base, f.options) };
  signal.throwIfAborted();
  const result = await f.invoke(controller.signal, runSubagent, run);
  console.log(JSON.stringify({ kind: "sol_native_case_timing", workerArtifact: "probe-bytecode", mode, parentElapsedMs: Math.round(performance.now() - began),
    workAborted: work.signal.aborted, requests: requests.length, modelCalls: result.report?.modelCalls ?? null, failureStage: result.report?.diagnostic?.stage ?? null, cleanupConfirmed: result.report?.solPi?.cleanupConfirmed ?? false, wire: f.wire, synthetic: true }));
  signal.throwIfAborted();
  assert.equal(result.type, mode === "success" ? "completed" : mode === "cancel" ? "cancel" : "failed", JSON.stringify(result));
  assert.equal(requests.length, 1); assert.ok(!JSON.stringify(result).includes("PRIVATE_HTTP_BODY"));
  assert.equal(requests[0]!.model, "gpt-5.6-sol"); assert.deepEqual(requests[0]!.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(result.report?.solPi?.calls, { worker: 1, reducer: 0, summary: 0 });
  assert.equal(result.report?.solPi?.lockRetained, mode !== "success");
  const files = (await readdir(path.join(f.storageDirectory, "sessions"))).filter(file => file.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  assert.ok(!(await readFile(path.join(f.storageDirectory, "sessions", files[0]!), "utf8")).includes("PRIVATE_HTTP_BODY"));
    });
  }
  } finally { work.close(); }
});

test("native summary and automatic continuation cannot bypass the unified call ceiling", async t => {
  for (const maxCalls of [4, 5, 6, 7]) await t.test(maxCalls >= 6 ? `invalid summary ${maxCalls}` : `cap ${maxCalls}`, { timeout: 10000 }, async t => {
    const f = await fixture(t, { onlineContextCompact: true, maxSummaryCalls: 2, maxCompactions: 1, cacheWriteReadRatio: 0 },
      { maxCalls, contextWindow: 16000 });
    await writeFile(path.join(f.cwd, "large.txt"), "synthetic bounded history ".repeat(1750));
    f.faux.setResponses([
      ...[1, 2].map(() => f.answer([ai.fauxToolCall("read", { path: "large.txt" })], "toolUse")),
      f.answer([ai.fauxToolCall("update_plan", { steps: [{ id: "read", goal: "read fixture", status: "in_progress" }] })], "toolUse"),
      f.answer([ai.fauxToolCall("update_plan", { steps: [{ id: "read", goal: "read fixture", status: "completed" }],
        progress: { files_changed: [], verification: [], decisions: [] } })], "toolUse"),
      maxCalls === 6 ? f.answer([ai.fauxToolCall("bash", { command: "touch SHOULD_NOT_EXIST" })], "toolUse")
        : f.answer(maxCalls === 7 ? "" : "Bounded summary; not verification."), f.answer("must not run"),
    ]);
    const result = await f.invoke(); assert.equal(result.type, "failed", JSON.stringify(result));
    const admitted = Math.min(maxCalls, 5);
    assert.equal(f.faux.state.callCount, admitted); assert.equal(result.report?.modelCalls, admitted);
    assert.deepEqual(result.report?.solPi?.calls, { worker: 4, reducer: 0, summary: admitted - 4 });
    assert.equal(result.report?.solPi?.lockRetained, true);
    if (maxCalls >= 6) {
      await assert.rejects(lstat(path.join(f.cwd, "SHOULD_NOT_EXIST")), { code: "ENOENT" });
      assert.equal(f.sessions[0]!.sessionManager.getEntries().filter(entry => entry.type === "compaction").length, 0);
    }
  });
});

test("copied source changes are rejected before auth/models; a completed grant cannot replay", async t => {
  await t.test("copied source", async t => {
    const f = await fixture(t); f.faux.setResponses([f.answer("must not run")]);
    const result = await f.invoke(undefined, async (run, signal) => {
      await writeFile(path.join(f.storageDirectory, "source/src/sol-pi/index.ts"), "PRIVATE_CHANGED_SOURCE");
      return executeSolPiWorker(run, signal, f.io);
    });
    assert.equal(result.type, "failed"); assert.equal(f.runtimes.length, 0); assert.equal(f.faux.state.callCount, 0);
    assert.equal(result.report?.solPi?.lockRetained, true); assert.ok(!JSON.stringify(result).includes("PRIVATE_CHANGED_SOURCE"));
  });
  await t.test("one-shot storage", async t => {
    const f = await fixture(t); f.faux.setResponses([f.answer("done")]); assert.equal((await f.invoke()).type, "completed");
    const before = await readFile(path.join(f.storageDirectory, SOL_RECORD), "utf8"), result = await f.invoke();
    assert.equal(result.type, "failed"); assert.equal(f.faux.state.callCount, 1); assert.equal(result.report?.accounting.status, "not_started");
    assert.equal(result.report?.solPi?.lockRetained, false); assert.equal(await readFile(path.join(f.storageDirectory, SOL_RECORD), "utf8"), before);
  });
});

test("two native compactions account for split-history summaries and both continuations", { timeout: 10000 }, async t => {
  const f = await fixture(t, { onlineContextCompact: true, maxSummaryCalls: 4, maxCompactions: 2, cacheWriteReadRatio: 0 },
    { maxCalls: 12, contextWindow: 16000 });
  await writeFile(path.join(f.cwd, "large.txt"), "synthetic bounded history ".repeat(1750));
  const program: unknown[][] = [];
  for (const id of ["first", "second"]) {
    program.push([ai.fauxToolCall("read", { path: "large.txt" })], [ai.fauxToolCall("read", { path: "large.txt" })],
      [ai.fauxToolCall("update_plan", { steps: [{ id, goal: "read fixture", status: "in_progress" }] })],
      [ai.fauxToolCall("update_plan", { steps: [{ id, goal: "read fixture", status: "completed" }],
        progress: { files_changed: [], verification: [], decisions: [] } })]);
  }
  let worker = 0;
  f.faux.setResponses(Array.from({ length: 12 }, () => (packet: Packet) => {
    if (!packet.tools?.length) return f.answer("Bounded fixture summary. No independent verification.")(packet);
    const tools = program[worker++]; return f.answer(tools ?? "Fixture work stopped; review required.", tools ? "toolUse" : "stop")(packet);
  }));
  const result = await f.invoke(); assert.equal(result.type, "completed", JSON.stringify(result));
  const report = result.report!.solPi!; assert.ok(report.calls);
  assert.equal(report.compactions, 2); assert.equal(report.continuations, 2); assert.equal(report.calls.worker, 9);
  assert.equal(report.calls.summary, 3); assert.equal(result.report!.modelCalls, 12); assert.equal(f.faux.state.callCount, 12);
});

test("pure Sol fences reject excess helper/tool/storage admissions and invalid clocks", () => {
  const fresh = () => initialSolState({ maxCalls: 12, maxReducerCalls: 1, maxSummaryCalls: 1, maxCompactions: 1, deadline: 1000, tools: ["read"] }, 1);
  for (const kind of ["reducer", "summary"] as const) {
    const state = reduceSol(fresh(), { type: "call", kind, now: 2 }).state;
    const next = reduceSol(frozen(state), { type: "call", kind, now: 3 });
    assert.equal(next.state.status, "draining"); assert.equal(next.state.calls[kind], 1);
  }
  let state = fresh(); for (let i = 0; i < 64; i++) state = reduceSol(state, { type: "tool", name: "read", now: 2 }).state;
  assert.equal(reduceSol(state, { type: "tool", name: "read", now: 3 }).state.status, "draining");
  assert.equal(reduceSol(fresh(), { type: "tool", name: "bash", now: 2 }).state.status, "draining");
  assert.equal(reduceSol(fresh(), { type: "continue", now: 2 }).state.status, "draining");
  assert.equal(reduceSol(fresh(), { type: "call", kind: "worker", now: 0 }).state.status, "draining");
  assert.equal(reduceSol(fresh(), { type: "storage", bytes: 0, files: 257, valid: true, now: 2 }).state.status, "draining");
  assert.equal(reduceSol(fresh(), { type: "storage", bytes: 8 * 1024 * 1024 + 1, files: 1, valid: true, now: 2 }).state.status, "draining");
});

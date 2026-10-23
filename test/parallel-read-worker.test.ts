import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { executeParallelReadWorker } from "../src/parallel-read-worker.ts";
import { readApprovalPolicy, PARALLEL_READ_ERROR } from "../src/parallel-read-effects.ts";
import type { ParallelReadWorkerInput } from "../src/parallel-read.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-parallel-admission-"))), agent = path.join(root, "agent"); await mkdir(agent);
  t.after(() => rm(root, { recursive: true, force: true }));
  const model = { provider: "offline", id: "synthetic", api: "openai-completions", baseUrl: "http://127.0.0.1:9999/v1" };
  const input: ParallelReadWorkerInput = { version: 1, approvedAt: Date.now(), deadline: Date.now() + 10000, context: [], policyVersion: (await readApprovalPolicy(root)).version,
    target: { api: model.api, endpoint: model.baseUrl }, run: { cwd: root, task: "Inspect only the synthetic requested source.", model: { provider: model.provider, id: model.id }, maxModelCalls: 2, seconds: 60,
      agent: { name: "scout", description: "Synthetic readonly inspection.", systemPrompt: "Read only the approved task. Never edit or delegate.", tools: ["read"],
        model: { provider: model.provider, id: model.id }, file: path.join(agent, "agents", "scout.md") } } };
  const stream = t.mock.fn(async (_model: unknown, _context: unknown) => {});
  const session = { model, thinkingLevel: "off", agent: { streamFunction: stream },
    prompt: async () => { await session.agent.streamFunction(model, {}); },
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic readonly findings, not independent verification." }],
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }],
    getSessionStats: () => ({ assistantMessages: 1, tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 }),
    abort: async () => {}, dispose() {} };
  const sdk = { createModelRuntime: t.mock.fn(async () => ({ getModel: () => model })), createAgentSession: t.mock.fn(async () => ({ session })) };
  t.mock.method(globalThis, "fetch", async () => assert.fail("No network in an admission unit fixture"));
  return { input, model, stream, sdk, io: sdk as unknown as NonNullable<Parameters<typeof executeParallelReadWorker>[2]> };
}
test("private readonly worker refuses write capabilities, malformed target or expired budget before SDK startup", async t => {
  const f = await fixture(t);
  for (const input of [{ ...f.input, run: { ...f.input.run, agent: { ...f.input.run.agent, tools: ["write"] } } },
    { ...f.input, target: { ...f.input.target, endpoint: "https://example.invalid?PRIVATE_QUERY=not_approved" } }, { ...f.input, deadline: Date.now() - 1 }])
    await assert.rejects(executeParallelReadWorker(input, t.signal, f.io), { message: PARALLEL_READ_ERROR });
  assert.equal(f.sdk.createModelRuntime.mock.callCount(), 0); assert.equal(f.stream.mock.callCount(), 0);
});
test("private readonly worker checks its actual SDK model/API endpoint before a counted model request", async t => {
  const f = await fixture(t); f.model.baseUrl = "http://127.0.0.1:9998/unapproved";
  const reply = await executeParallelReadWorker(f.input, t.signal, f.io);
  assert.equal(reply.type, "failed"); assert.equal(reply.report.modelCalls, 0); assert.equal(f.stream.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(reply), /unapproved/);
});
test("changed operator policy blocks the child at model admission without a retry or reported call", async t => {
  const f = await fixture(t); f.input.policyVersion = "f".repeat(64);
  const reply = await executeParallelReadWorker(f.input, t.signal, f.io);
  assert.equal(reply.type, "failed"); assert.equal(reply.report.modelCalls, 0); assert.equal(f.stream.mock.callCount(), 0);
});
test("unchanged reviewed readonly source admits one SDK stream through the same existing worker guards", async t => {
  const f = await fixture(t), reply = await executeParallelReadWorker(f.input, t.signal, f.io);
  assert.equal(reply.type, "completed"); assert.equal(reply.report.modelCalls, 1); assert.equal(f.stream.mock.callCount(), 1);
  assert.equal(reply.report.accounting.status, "reported"); if (reply.report.accounting.status === "reported") assert.equal(reply.report.accounting.complete, true);
});

import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { taskTree } from "../src/task-tree-effects.ts";
import { treePrompts, validTreeWorker } from "../src/task-tree-protocol.ts";
import { executeTreeWorker } from "../src/task-tree-worker.ts";
import { readApprovalPolicy } from "../src/parallel-read-effects.ts";
import { treeFixture } from "./helpers/task-tree-fixture.ts";

async function fixture(t: TestContext) {
  const f = treeFixture(); await taskTree(f.input, f.ctx, t.signal, f.io);
  const input = structuredClone(f.packets[0]!);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-tree-admission-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  input.run.cwd = root; input.run.agent.file = path.join(root, "agent", "agents", "scout.md"); input.policyVersion = (await readApprovalPolicy(root)).version;
  const model = { ...input.run.model, api: input.target.api, baseUrl: input.target.endpoint };
  const stream = t.mock.fn(async (_model: unknown, _context: unknown) => {});
  const session = { model, thinkingLevel: "off", systemPrompt: `${treePrompts(input).systemPrompt}\nCurrent working directory: ${root.replace(/\\/g, "/")}\n`, agent: { streamFunction: stream },
    prompt: async () => { await session.agent.streamFunction(model, {}); },
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic findings remain unverified." }], usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }],
    getSessionStats: () => ({ assistantMessages: 1, tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 }), abort: async () => {}, dispose() {} };
  const sdk = { createModelRuntime: t.mock.fn(async () => ({ getModel: () => model })), createAgentSession: t.mock.fn(async () => ({ session })) };
  t.mock.method(globalThis, "fetch", async () => assert.fail("No network in admission fixtures."));
  return { input, model, session, stream, sdk, io: sdk as unknown as NonNullable<Parameters<typeof executeTreeWorker>[2]> };
}
test("private tree worker rejects excess tools, mismatched model, malformed disclosure and extended deadlines before SDK", async t => {
  const f = await fixture(t);
  const malformed = [
    { ...f.input, run: { ...f.input.run, agent: { ...f.input.run.agent, tools: ["bash"] } } },
    { ...f.input, run: { ...f.input.run, model: { provider: "different", id: "different" } } },
    { ...f.input, deadline: f.input.deadline + 1 }, { ...f.input, snapshot: { records: [], digest: "forged" } },
    { ...f.input, events: [{ type: "approval", approved: true }] },
  ];
  for (const input of malformed) { assert.equal(validTreeWorker(input), false); await assert.rejects(executeTreeWorker(input, t.signal, f.io), /Task tree worker stopped/); }
  assert.equal(f.sdk.createModelRuntime.mock.callCount(), 0);
});
test("private tree worker checks exact SDK endpoint and thinking, with no counted stream or fallback on mismatch", async t => {
  for (const changed of ["endpoint", "thinking"]) {
    const f = await fixture(t);
    if (changed === "endpoint") f.model.baseUrl = "http://127.0.0.1:9998/PRIVATE_ENDPOINT";
    else f.session.thinkingLevel = "low";
    const reply = await executeTreeWorker(f.input, t.signal, f.io); assert.notEqual(reply.type, "goal_result"); if (reply.type === "goal_result") assert.fail();
    assert.equal(reply.type, "failed"); assert.equal(reply.report.modelCalls, 0); assert.equal(f.stream.mock.callCount(), 0); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_ENDPOINT/);
  }
});
test("changed private child policy blocks admission; matching source admits one natural-completion stream", async t => {
  for (const changed of [false, true]) {
    const f = await fixture(t); if (changed) f.input.policyVersion = "f".repeat(64);
    const reply = await executeTreeWorker(f.input, t.signal, f.io); if (reply.type === "goal_result") assert.fail();
    assert.equal(reply.type, changed ? "failed" : "completed"); assert.equal(reply.report.modelCalls, changed ? 0 : 1); assert.equal(f.stream.mock.callCount(), changed ? 0 : 1);
  }
});

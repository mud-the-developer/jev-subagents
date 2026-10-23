import assert from "node:assert/strict";
import cp from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parallelRead, parallelReadIO, readApprovalPolicy } from "../src/parallel-read-effects.ts";
import { parallelReadTask, type ParallelReadInput, type ParallelReadPrepared } from "../src/parallel-read.ts";

for (const width of [1, 2, 3]) test(`actual ${width} Bun SDK children start before any response, use readonly tools and share one synthetic native approval`, { timeout: 30000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-parallel-sdk-"))), cwd = path.join(root, "workspace"), agentDirectory = path.join(root, "agent");
  await mkdir(cwd); await mkdir(path.join(agentDirectory, "agents"), { recursive: true });
  await mkdir(path.join(cwd, ".pi")); await writeFile(path.join(cwd, ".pi", "jev-orchestration.json"), JSON.stringify({ version: 1, approval: { level: "balanced" } }));
  const ids = ["a", "b", "c"].slice(0, width), markers = ids.map(id => `SYNTHETIC_READ_RESULT_${id}`), initial = ids.map((id, index) => `${markers[index]}\nReadonly synthetic fixture ${id}.\n`);
  for (const [index, id] of ids.entries()) await writeFile(path.join(cwd, `fixture-${id}.txt`), initial[index]!);
  const turns = new Map<string, number>(), firstReplies: (() => void)[] = [];
  let requests = 0, approvals = 0, active = 0, peak = 0, launches = 0, settled = false;
  const server = createServer(async (request, response) => {
    try {
      let raw = ""; for await (const data of request) raw += data;
      const body = JSON.parse(raw), all = JSON.stringify(body.messages), own = ids.find(id => all.includes(`READ_CASE_${id}`));
      assert.ok(own); const index = ids.indexOf(own); requests++; assert.equal(body.model, "synthetic-readonly");
      assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ["read"]);
      for (const other of ids.filter(id => id !== own)) assert.equal(all.includes(`READ_CASE_${other}`), false, "No sibling task/prompt forwarding");
      const turn = (turns.get(own) ?? 0) + 1; turns.set(own, turn); assert.ok(turn <= 2, "No retries or extra model turns");
      if (turn === 2) assert.ok(body.messages.some((message: { role: string; content: unknown }) => message.role === "tool" && JSON.stringify(message.content).includes(markers[index]!)));
      const reply = () => {
        const delta = turn === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${own}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `fixture-${own}.txt` }) } }] }
          : { role: "assistant", content: `Observed ${markers[index]}. Read-only findings, not independent verification.` };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: `reply-${own}-${turn}`, object: "chat.completion.chunk", created: 0, model: body.model,
          choices: [{ index: 0, delta, finish_reason: turn === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
      };
      if (turn === 1) { firstReplies.push(reply); if (firstReplies.length === width) { assert.equal(active, width); firstReplies.forEach(send => send()); } }
      else reply();
    } catch { response.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); if (settled) await rm(root, { recursive: true, force: true }); });
  const model = { provider: "offline", id: "synthetic-readonly" }, endpoint = `http://127.0.0.1:${address.port}/v1`;
  await writeFile(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { offline: { api: "openai-completions", baseUrl: endpoint, apiKey: "synthetic-loopback-only-key",
    models: [{ id: model.id, reasoning: false, contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const profile = "Use only the approved read tool. Never modify files, run commands or delegate. Report concise English findings.";
  const file = path.join(agentDirectory, "agents", "scout.md"); await writeFile(file, `---\nname: scout\nmodel: offline/synthetic-readonly\ntools: read\n---\n${profile}\n`);
  const input: ParallelReadInput = { task: "Read only your independently assigned synthetic fixture; report its marker without changes.",
    tasks: ids.map(id => ({ id, agent: "scout", summary: `READ_CASE_${id}: Use read to inspect fixture-${id}.txt and report its observed marker. Do not edit, run commands or infer unread content.` })),
    limits: { seconds: 120, modelCalls: 6, perWorkerCalls: 2 } };
  const policy = await readApprovalPolicy(cwd);
  const prepared: ParallelReadPrepared = { id: "parallel-sdk", sessionId: "synthetic-session", cwd, agentDirectory, input, policy: policy.policy, policyVersion: policy.version,
    context: [], tasks: input.tasks.map(task => ({ id: task.id, run: { cwd, task: parallelReadTask(input.task, task.summary), agent: { name: "scout", description: "Synthetic readonly fixture.",
      systemPrompt: profile, tools: ["read"], model, file }, model, maxModelCalls: 2, seconds: 120 }, target: { api: "openai-completions", endpoint } })) };
  const ctx = { cwd, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "synthetic-session" }, ui: { confirm: async (_title: string, text: string) => {
    approvals++; assert.equal(launches, 0); assert.equal(requests, 0); for (const task of input.tasks) assert.ok(text.includes(task.summary)); return true;
  } } } as unknown as ExtensionContext;
  const fork = cp.fork; t.mock.method(cp, "fork", (...args: Parameters<typeof fork>) => {
    assert.match(path.basename(args[2]!.execPath!).toLowerCase(), /^bun(?:\.exe)?$/); assert.equal(args[2]!.serialization, "json");
    const child = fork(...args); launches++; active++; peak = Math.max(peak, active); child.once("close", () => active--); return child;
  });
  // Synthetic preparation/context seam; native IPC ownership, Bun, SDK and readonly file tools remain real.
  const io = { ...parallelReadIO, prepare: async () => structuredClone(prepared), canonical: async () => cwd };
  const result = await parallelRead(input, ctx, t.signal, io); settled = result.cleanupConfirmed;
  assert.equal(result.status, "completed_unverified", JSON.stringify({ reason: result.reason, rows: result.rows.map(row => row.status) }));
  assert.equal(approvals, 1); assert.equal(launches, width); assert.equal(peak, width); assert.equal(active, 0); assert.equal(firstReplies.length, width);
  assert.equal(requests, width * 2); assert.equal(result.modelCalls, width * 2); assert.equal(result.peakActiveTasks, width); assert.equal(result.cleanupConfirmed, true);
  for (const [index, id] of ids.entries()) { assert.ok(result.rows[index]!.text?.includes(markers[index]!)); assert.equal(await readFile(path.join(cwd, `fixture-${id}.txt`), "utf8"), initial[index]); }
});

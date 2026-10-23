import assert from "node:assert/strict";
import cp from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { taskTree, taskTreeIO } from "../src/task-tree-effects.ts";
import { readApprovalPolicy } from "../src/parallel-read-effects.ts";
import { prepareGoalFileScope } from "../src/goal-file-effects.ts";
import { contextSnapshot } from "../src/goal-run-effects.ts";
import type { TaskTreeInput, TreePrepared } from "../src/task-tree.ts";
import type { PlanView } from "../src/plan-presentation.ts";
import { treeRouting } from "./helpers/task-tree-fixture.ts";

for (const mutation of [false, true]) test(`owned Bun tree: actual read branch overlap, ${mutation ? "exclusive file-ID mutation and fresh generated disclosure" : "clean predecessor unlocks child while sibling is running"}`, { timeout: 30000 }, async t => {
  const began = performance.now(), boundaries: { check: string; startedMs: number; elapsedMs: number | null }[] = [];
  const measure = async <T>(check: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now(), entry = { check, startedMs: Math.round(started - began), elapsedMs: null as number | null };
    boundaries.push(entry);
    try { return await run(); } finally { entry.elapsedMs = Math.round(performance.now() - started); }
  };
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-tree-sdk-"))), cwd = path.join(root, "workspace"), agentDirectory = path.join(root, "agent");
  await mkdir(cwd); await mkdir(path.join(agentDirectory, "agents"), { recursive: true });
  await writeFile(path.join(cwd, "sample.txt"), "BEFORE\n");
  for (const id of ["a", "b", "c"]) await writeFile(path.join(cwd, `${id}.txt`), `SOURCE_${id}\n`);
  const firstReplies = new Map<string, () => void>(), turns = new Map<string, number>(), sourceOrder: string[] = [], plans: PlanView[] = [];
  let requests = 0, launches = 0, active = 0, peak = 0, approvals = 0, clean = false, parentUpdates = 0, routed = 0;
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let text = ""; for await (const data of request) text += data;
      const body = JSON.parse(text), messages = JSON.stringify(body.messages), id = ["a", "b", "c"].find(id => messages.includes(`TREE_CASE_${id}`));
      assert.ok(id); requests++; assert.equal(body.model, "synthetic-tree");
      const turn = (turns.get(id) ?? 0) + 1; turns.set(id, turn);
      for (const other of ["a", "b", "c"].filter(other => other !== id)) assert.equal(messages.includes(`TREE_CASE_${other}`), false, "No sibling prompts");
      const writer = mutation && id === "c";
      assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), writer ? ["scope_edit", "scope_read"] : ["read"]);
      assert.ok(turn <= (writer ? 3 : 2), "No retry or extra model call");
      if (writer) { assert.equal(active, 1, "Mutation cannot overlap any lane"); assert.equal(approvals, 2); assert.match(messages, /FRESH_REVIEWED_GRAPH_BODY/); assert.doesNotMatch(messages, /PRIVATE_REPORT_a/); }
      else assert.doesNotMatch(messages, /FRESH_REVIEWED_GRAPH_BODY/);
      if (turn === 1) {
        sourceOrder.push(id);
        if (id === "c") { assert.equal(turns.get("a"), 2); if (mutation) assert.equal(turns.get("b"), 2); else assert.equal(turns.get("b"), 1); }
      }
      const toolName = writer ? turn === 1 ? "scope_read" : "scope_edit" : "read";
      const arguments_ = writer ? turn === 1 ? { fileId: "file-1" } : { fileId: "file-1", oldText: "BEFORE", newText: "AFTER" } : { path: `${id}.txt` };
      const finished = turn === (writer ? 3 : 2);
      const reply = () => {
        const delta = finished ? { role: "assistant", content: `PRIVATE_REPORT_${id}: Synthetic findings remain unverified.` }
          : { role: "assistant", tool_calls: [{ index: 0, id: `tool-${id}-${turn}`, type: "function", function: { name: toolName, arguments: JSON.stringify(arguments_) } }] };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: `reply-${id}-${turn}`, object: "chat.completion.chunk", created: 0, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finished ? "stop" : "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
      };
      if (turn === 1 && id !== "c") {
        firstReplies.set(id, reply);
        if (firstReplies.size === 2) { assert.equal(active, 2); firstReplies.get("a")!(); if (mutation) firstReplies.get("b")!(); }
      } else { if (!mutation && id === "c" && turn === 1) firstReplies.get("b")!(); reply(); }
    } catch (error) { failures.push(error); response.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (clean) await rm(root, { recursive: true, force: true });
    else console.log(JSON.stringify({ kind: "synthetic_tree_timing", mutation, approvals, launches, requests, boundaries }));
  });
  const endpoint = `http://127.0.0.1:${address.port}/v1`, model = { provider: "offline", id: "synthetic-tree" };
  await writeFile(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { offline: { api: "openai-completions", baseUrl: endpoint, apiKey: "synthetic-loopback-only-key",
    models: [{ id: model.id, reasoning: false, contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const agents = ["scout", ...(mutation ? ["writer"] : [])].map(name => ({ name, description: "Synthetic fixed profile.", systemPrompt: "Use only the exact reviewed tools and task. Do not delegate or claim acceptance.",
    file: path.join(agentDirectory, "agents", `${name}.md`), model, tools: name === "writer" ? ["read", "edit"] : ["read"] }));
  for (const agent of agents) await writeFile(agent.file, `---\nname: ${agent.name}\nmodel: offline/synthetic-tree\ntools: ${agent.tools.join(", ")}\n---\n${agent.systemPrompt}\n`);
  const input: TaskTreeInput = { task: "Execute the exact synthetic task tree; do not infer task acceptance.",
    nodes: ["a", "b", "c"].map(id => ({ kind: "task", id, summary: `TREE_CASE_${id}: ${mutation && id === "c" ? "Read file-1 and replace BEFORE with AFTER using the approved file-ID tools and reference." : `Read ${id}.txt and report the observed marker.`}`,
      query: `Select reference information for public task ${id}.`, agents: [mutation && id === "c" ? "writer" : "scout"], mode: mutation && id === "c" ? "mutation" : "read" })),
    edges: [{ from: "a", to: "c", kind: "dependency" }], limits: { workerRuns: 3, seconds: 120, modelCalls: 9, perWorkerCalls: 3 } };
  if (mutation) {
    input.files = [{ path: "sample.txt", access: "read_write" }];
    input.nodes.push({ kind: "info", id: "finding", title: "Public generated constraint", infoKind: "constraint" });
    input.edges.push({ from: "b", to: "c", kind: "dependency" }, { from: "a", to: "finding", kind: "produced" }, { from: "finding", to: "c", kind: "reference" });
  }
  const policy = await readApprovalPolicy(cwd), context = new Map();
  for (const agent of agents) for (const row of await contextSnapshot(cwd, agentDirectory, agent.file, input.files ?? [], t.signal)) context.set(row.path, row);
  const tree: TreePrepared = { id: "tree-sdk", sessionId: "synthetic-session", cwd, agentDirectory, input, agents, targets: agents.map(agent => ({ agent: agent.name, api: "openai-completions", endpoint })),
    context: [...context.values()], policy: policy.policy, policyVersion: policy.version, routingTarget: null,
    ...(input.files ? { files: await prepareGoalFileScope({ cwd, files: input.files }, { agentDirectory, journalDirectory: agentDirectory }, t.signal) } : {}) };
  if (mutation) treeRouting(t, tree);
  const ctx = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "synthetic-session" }, ui: { confirm: async (_title: string, packet: string) => {
    approvals++; if (approvals === 1) { assert.equal(launches, 0); assert.equal(requests, 0); } else assert.match(packet, /FRESH_REVIEWED_GRAPH_BODY/); return true;
  } } } as unknown as ExtensionContext;
  const fork = cp.fork; t.mock.method(cp, "fork", (...args: Parameters<typeof fork>) => {
    assert.match(path.basename(args[2]!.execPath!).toLowerCase(), /^bun(?:\.exe)?$/); assert.equal(args[2]!.serialization, "json");
    const env = Object.fromEntries(Object.entries(args[2]!.env!).filter(([key]) => ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR", "PI_SKIP_VERSION_CHECK", "PI_OFFLINE", "PI_DISABLE_ANALYTICS", "PI_DISABLE_INSTALL_TELEMETRY", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "DO_NOT_TRACK"].includes(key)));
    args[2] = { ...args[2], env: { ...env, HOME: root, USERPROFILE: root } };
    const child = fork(...args); launches++; active++; peak = Math.max(peak, active); child.once("close", () => active--); return child;
  });
  const io = { ...taskTreeIO, prepare: async () => structuredClone(tree), select: async (_effect: Parameters<typeof taskTreeIO.select>[0], _signal: AbortSignal | undefined, started?: () => void) => {
    routed++; assert.doesNotMatch(JSON.stringify(_effect), /FRESH_REVIEWED_GRAPH_BODY|PRIVATE_REPORT/); started?.();
    return { type: "resolved" as const, decision: { model: "openjev-0.1", provider: "openjev" as const, usage: { inputTokens: 1, outputTokens: 1 }, agent: "option_0_1", confidence: 0.5 } };
  } };
  const canonical = io.canonical, policyRead = io.policy, contextRead = io.context, fileRead = io.files, run = io.run;
  io.canonical = (...args) => measure("directory", () => canonical(...args));
  io.policy = (...args) => measure("policy", () => policyRead(...args));
  io.context = (...args) => measure("context", () => contextRead(...args));
  io.files = (...args) => measure("files", () => fileRead(...args));
  io.run = (...args) => measure("owned_worker", () => run(...args));
  // Synthetic native preparation/approval and metadata selection; real Bun/SDK/file ownership and fresh-source checks.
  const result = await taskTree(input, ctx, t.signal, io, plan => plans.push(plan), async question => {
    parentUpdates++; assert.equal(question.purpose, "generated_information"); assert.equal(approvals, 1);
    return { records: [{ id: "finding", content: "FRESH_REVIEWED_GRAPH_BODY", provenance: "Explicit current-parent synthetic source, not automatic collection." }] };
  });
  clean = result.cleanupConfirmed;
  assert.deepEqual(failures, []); assert.equal(result.status, "completed_unverified", JSON.stringify({ reason: result.reason, metrics: result.metrics }));
  assert.equal(launches, 3); assert.equal(peak, 2); assert.equal(active, 0); assert.deepEqual(sourceOrder.slice(0, 2).sort(), ["a", "b"]); assert.equal(sourceOrder[2], "c");
  assert.equal(requests, mutation ? 7 : 6); assert.equal(result.metrics.modelCalls, requests); assert.equal(approvals, mutation ? 2 : 1);
  assert.equal(parentUpdates, mutation ? 1 : 0); assert.equal(routed, mutation ? 1 : 0);
  assert.equal(await readFile(path.join(cwd, "sample.txt"), "utf8"), mutation ? "AFTER\n" : "BEFORE\n");
  assert.ok(plans.some(plan => plan.nodes.filter(node => node.state === "running").length === 2));
  assert.ok(plans.some(plan => (plan.modelCalls ?? 0) > 0)); assert.doesNotMatch(JSON.stringify(plans), /PRIVATE_REPORT|SOURCE_|FRESH_REVIEWED_GRAPH_BODY/);
});

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DefaultResourceLoader, SettingsManager, type ExtensionCommandContext, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { estimateCost, MODEL_CALL_LIMIT_ERROR, type DelegateInput, type State } from "../src/delegate-machine.ts";
import { validPlanReceipt } from "../src/plan-state.ts";
import { approvalUiText, type ApprovalUiDiagnostic } from "../src/approval-ui-diagnostics.ts";
import { bunWorkerOptions } from "../src/worker-runtime.ts";

// Only the HTTP model is fake: pi's loader, SDK, subprocess, and edit tool are real.
async function fixture(t: TestContext, mode: "edit" | "loop" | "sdk_native" | "error" | "bad_request" | "hold" | "bash" | "missing_usage" | "partial_usage" = "edit") {
  const { execPath, execArgv } = bunWorkerOptions();
  const shellRuntime = [execPath, ...execArgv].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-integration-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "config");
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TYPESAFE_API_KEY = "offline-jev-key";
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(cwd);
  await mkdir(path.join(agentDir, "agents"), { recursive: true });
  await writeFile(path.join(cwd, "fixture.txt"), "BEFORE\n");
  await writeFile(path.join(cwd, "AGENTS.md"), "Only change the explicitly requested fixture.\n");
  for (const name of ["scout", "worker"]) {
    const tool = name === "scout" ? "read" : mode === "bash" ? "bash" : "edit";
    await writeFile(path.join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name === "worker" ? "Fix files" : "Explore files"}\ntools: ${tool}\nmodel: offline/offline-worker\n---\nFollow the explicit task and AGENTS.md.\n`);
  }

  const requests: { model?: string; messages?: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
  let onReceived!: () => void;
  let onDisconnected!: () => void;
  const received = new Promise<void>((resolve) => { onReceived = resolve; });
  const disconnected = new Promise<void>((resolve) => { onDisconnected = resolve; });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    onReceived();
    if (mode === "hold") {
      res.once("close", onDisconnected);
      return;
    }
    if (mode === "error" || mode === "bad_request") {
      res.writeHead(mode === "error" ? 500 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: mode === "error" ? "offline-secret-must-not-escape"
        : "The 'offline-secret-must-not-escape' model is not supported.", type: "invalid_request_error" } }));
      return;
    }
    const first = requests.length === 1;
    const call = mode === "bash"
      ? { name: "bash", arguments: JSON.stringify({ command: `${shellRuntime} -e 'require("node:fs").writeFileSync("waiting.pid", String(process.pid)); setInterval(() => {}, 1000)'` }) }
      : { name: "edit", arguments: JSON.stringify({ path: "fixture.txt",
        oldText: first ? "BEFORE" : `AFTER${requests.length - 1}`,
        newText: mode === "loop" || mode === "sdk_native" ? `AFTER${requests.length}` : "AFTER" }) };
    const toolCall = first || mode === "loop" || mode === "sdk_native" && requests.length < 14;
    const delta = toolCall
      ? { role: "assistant", tool_calls: [{ index: 0, id: "offline_tool", type: "function", function: call }] }
      : { role: "assistant", content: "Edited fixture.txt." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({
      id: "offline-response", object: "chat.completion.chunk", created: 0, model: "offline-worker",
      choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }],
      ...(mode !== "missing_usage" && (mode !== "partial_usage" || first)
        ? { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } } : {}),
    })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    offline: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "offline-model-key", models: [{
      id: "offline-worker", reasoning: false, contextWindow: 65536, maxTokens: 1024,
      cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
    }] },
  } }));

  // The real worker inherits no personal credentials, provider configuration, or shell hooks.
  const fork = childProcess.fork;
  const launches = t.mock.fn<(modulePath: string | URL) => void>(() => {});
  const checks = t.mock.fn<(command: string, args: readonly string[]) => void>(() => {});
  const guardians = t.mock.fn<() => void>(() => {});
  t.mock.method(childProcess, "fork", (modulePath: string | URL, args: readonly string[], options: childProcess.ForkOptions) => {
    const isVerification = String(modulePath).endsWith("windows-verification-worker.ts");
    if (!isVerification) launches(modulePath);
    const child = fork(modulePath, args, {
      ...options,
      env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
    });
    if (isVerification) {
      const send = child.send;
      t.mock.method(child, "send", (...parameters: unknown[]) => {
        const message = parameters[0];
        if (typeof message === "object" && message !== null && "command" in message && "args" in message) {
          assert.equal(typeof message.command, "string"); assert.ok(Array.isArray(message.args));
          checks(message.command as string, message.args);
        }
        return Reflect.apply(send, child, parameters);
      });
    }
    return child;
  });
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...[command, args, options]: Parameters<typeof spawn>) => {
    if (process.platform === "win32" && args?.includes("-EncodedCommand")) {
      guardians();
      assert.equal(options?.env?.TYPESAFE_API_KEY, undefined);
      assert.equal(options?.env?.NODE_OPTIONS, undefined);
      return spawn(command, args, { ...options, env: { ...options?.env, HOME: root } });
    }
    checks(command, args ?? []);
    return spawn(command, args, { ...options, env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1" } });
  });
  const jev = t.mock.method(globalThis, "fetch", async (...[url]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone", "No non-fixture network requests are allowed.");
    return Response.json({ model: "jev-offline", answers: { agent: { type: "choice", choice: "worker", confidence: 1 } }, usage: { input_tokens: 40, output_tokens: 10 } });
  });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  t.after(() => loaded.runtime.invalidate());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual([...loaded.extensions[0]!.commands.keys()], ["jev-subagents"]);
  const tools = loaded.extensions[0]!.tools;
  assert.deepEqual([...tools.keys()].sort(), ["jev_decide", "jev_delegate", "jev_memory", "jev_route"]);
  const tool = tools.get("jev_delegate")!.definition;
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async () => true);
  const updates = t.mock.fn<NonNullable<Parameters<typeof tool.execute>[3]>>(() => {});
  const approvalUpdates = t.mock.fn<NonNullable<Parameters<typeof tool.execute>[3]>>(update => {
    const details = update.details as { kind: string; phase?: string; approvalUi: ApprovalUiDiagnostic };
    assert.equal(details.kind, "approval_ui_diagnostic"); assert.equal(details.phase, undefined, "UI observations are not workflow transitions");
    const text = approvalUiText(details.approvalUi); assert.ok(text, "Every observation must pass the fixed safe projection");
    assert.deepEqual(update.content, [{ type: "text", text: `JEV · ${text}` }]);
    assert.equal(details.approvalUi.executionAuthorized, false);
    assert.doesNotMatch(JSON.stringify(update), /offline-model-key|offline-jev-key|systemPrompt|fixture\.txt|offline-native-session/);
  });
  const receiveUpdate: NonNullable<Parameters<typeof tool.execute>[3]> = update => {
    const details = update.details as { kind?: string; plan?: unknown };
    if (details.kind === "approval_ui_diagnostic") approvalUpdates(update);
    else if (details.kind === "execution_plan") {
      assert.equal(validPlanReceipt(details.plan), true);
      assert.doesNotMatch(JSON.stringify(update), /offline-model-key|offline-jev-key|systemPrompt|fixture\.txt|offline-native-session/);
    } else updates(update);
  };
  const phases = () => updates.mock.calls.filter(call => (call.arguments[0].details as { kind?: string }).kind !== "execution_plan")
    .map((call) => (call.arguments[0].details as { phase: string }).phase);
  const ctx = { mode: "rpc", cwd, hasUI: true, isIdle: () => true, model: { provider: "offline", id: "offline-worker" },
    sessionManager: { getSessionId: () => "offline-native-session" },
    ui: { confirm, setStatus() {}, notify() {}, select: async () => assert.fail("No ordinary review menu") } } as unknown as ExtensionContext;
  const invoke = (signal = t.signal, overrides: Partial<DelegateInput> = {}) => tool.execute("offline-integration", {
    task: mode === "bash" ? "Start a waiting subprocess that writes its PID to waiting.pid, until cancelled."
      : "Replace BEFORE with AFTER in fixture.txt. Do not change other files.", agents: ["scout", "worker"], ...overrides,
  }, signal, receiveUpdate, ctx);
  assert.ok(tool.renderResult);
  const render = (result: Parameters<NonNullable<typeof tool.renderResult>>[0], isPartial = false, isError = false) => {
    const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
    const context = { isError } as Parameters<NonNullable<typeof tool.renderResult>>[3];
    return tool.renderResult!(result, { expanded: true, isPartial }, theme, context).render(120).join("\n");
  };
  return { cwd, invoke, render, ctx, confirm, updates, approvalUpdates, phases, launches, checks, guardians, jev, requests, received, disconnected,
    budgetTool: tools.get("jev_decide")!.definition, command: loaded.extensions[0]!.commands.get("jev-subagents")! };
}

test("native Full Access → real SDK edit and verification without per-task popups; revocation restores Reviewed", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  await f.command.handler("access full", f.ctx as ExtensionCommandContext);
  assert.equal(f.confirm.mock.callCount(), 1);
  assert.match(f.confirm.mock.calls[0]!.arguments[1], /NO cumulative session/);
  const verification = { command: process.execPath, args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('fixture.txt','utf8'), 'AFTER\\n')"],
    description: "Compare exact fixture bytes with AFTER and one newline." };
  f.jev.mock.mockImplementation(async (...[, init]: Parameters<typeof fetch>) => {
    const packet = JSON.parse(String(init?.body));
    assert.deepEqual(packet.state.verification, { status: "passed", description: verification.description });
    assert.equal(packet.state.workerClaim, "Edited fixture.txt."); assert.equal(f.confirm.mock.callCount(), 1);
    assert.doesNotMatch(JSON.stringify(packet), /offline-model-key|offline-jev-key|systemPrompt/);
    return Response.json({ model: "jev-offline", answers: { criterion_0: { type: "choice", choice: "met", confidence: 0.9 } }, usage: { input_tokens: 70, output_tokens: 10 } });
  });
  const result = await f.invoke(t.signal, { agents: ["worker"], maxModelCalls: 2, verification, acceptanceCriteria: ["fixture.txt contains AFTER and one newline."] });
  assert.equal((result.details as State).status, "succeeded");
  assert.equal((result.details as { authorization: string }).authorization, "full_access");
  assert.deepEqual((result.details as { verification: unknown }).verification, { status: "passed", exitCode: 0 });
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
  assert.equal(f.confirm.mock.callCount(), 1); assert.equal(f.approvalUpdates.mock.callCount(), 0, "session authority never fabricates a native task receipt");
  assert.equal((result.details as State & { assessment: { status: string } }).assessment.status, "complete"); assert.equal(f.jev.mock.callCount(), 1);
  await f.command.handler("access reviewed", f.ctx as ExtensionCommandContext);
  f.confirm.mock.mockImplementation(async () => false);
  await assert.rejects(f.invoke(t.signal, { agents: ["worker"] }), /approval not received/i);
  assert.equal(f.confirm.mock.callCount(), 2); assert.equal(f.launches.mock.callCount(), 1);
});

test("revoking Full Access cancels and drains a real owned worker's pending model request", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "hold");
  await f.command.handler("access full", f.ctx as ExtensionCommandContext);
  const work = assert.rejects(f.invoke(t.signal, { agents: ["worker"] }), error => {
    assert.ok(error instanceof Error); const state = JSON.parse(error.message.split("\n").at(-1)!);
    assert.equal(state.status, "cancelled"); assert.equal(state.authorization, "full_access"); return true;
  });
  await f.received;
  await f.command.handler("access reviewed", f.ctx as ExtensionCommandContext);
  await work; await f.disconnected;
  assert.equal(f.confirm.mock.callCount(), 1); assert.equal(f.launches.mock.callCount(), 1); assert.equal(f.requests.length, 1);
});

test("Full Access cannot send completion evidence after failed verification", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.command.handler("access full", f.ctx as ExtensionCommandContext);
  await assert.rejects(f.invoke(t.signal, { agents: ["worker"], acceptanceCriteria: ["The declared content check passed."],
    verification: { command: process.execPath, args: ["-e", "process.exit(42)"], description: "Synthetic failed content check." } }), error => {
    assert.ok(error instanceof Error); const state = JSON.parse(error.message.split("\n").at(-1)!);
    assert.equal(state.status, "failed"); assert.deepEqual(state.verification, { status: "failed", exitCode: 42 }); return true;
  });
  assert.equal(f.confirm.mock.callCount(), 1); assert.equal(f.jev.mock.callCount(), 0); assert.equal(f.launches.mock.callCount(), 1);
});

test("pi loader → approval → real SDK worker edits only the fixture with the approved tool", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const verification = { command: process.execPath, args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('fixture.txt','utf8'), 'AFTER\\n')"] };
  const result = await f.invoke(t.signal, { verification, maxModelCalls: 2 });
  const details = result.details as State;
  assert.ok(details.status === "succeeded"); // Normal completion on the last allowed call still verifies.
  assert.equal(details.metrics.worker.modelCalls, 2);
  assert.equal(details.metrics.profile?.maxModelCalls, 2);
  assert.match(f.confirm.mock.calls[0]!.arguments[1], /SDK model-round cap 2/);
  assert.deepEqual(details.verification, { status: "passed", exitCode: 0 });
  assert.ok(details.metrics.worker.accounting.status === "reported" && details.metrics.worker.accounting.complete);
  assert.ok(details.metrics.phasesMs.verifying! >= 0);
  assert.ok(f.confirm.mock.calls[0]!.arguments[1].includes(JSON.stringify([verification.command, ...verification.args])));
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
  assert.deepEqual((await readdir(f.cwd)).sort(), ["AGENTS.md", "fixture.txt"]);
  assert.equal(await readFile(path.join(f.cwd, "AGENTS.md"), "utf8"), "Only change the explicitly requested fixture.\n");
  assert.equal(f.jev.mock.callCount(), 1);
  assert.equal(f.confirm.mock.callCount(), 1);
  const ui = f.approvalUpdates.mock.calls.map(call => (call.arguments[0].details as { approvalUi: ApprovalUiDiagnostic }).approvalUi);
  assert.deepEqual(ui.filter(value => value.phase === "requesting").map(value => value.step), ["packet"]);
  assert.equal(ui.at(-1)?.phase, "finished"); assert.equal(ui.at(-1)?.status, "positive_reply");
  assert.equal(ui.at(-1)?.requests, 1); assert.equal(ui.at(-1)?.replies, 1);
  assert.equal(f.launches.mock.callCount(), 1);
  assert.equal(f.requests.length, 2);
  if (process.platform === "win32") assert.equal(f.guardians.mock.callCount(), 2);
  for (const request of f.requests) {
    assert.equal(request.model, "offline-worker");
    assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["edit"]);
  }
  assert.ok(f.requests[1]?.messages?.some((message) => message.role === "tool"));
  const content = result.content[0]!;
  assert.equal(content.type, "text");
  if (content.type !== "text") return;
  assert.equal(content.text.slice(content.text.indexOf("\n\n") + 2), details.result.text);
  const summary = JSON.parse(content.text.split("\n\n")[0]!);
  assert.deepEqual(summary, {
    status: "succeeded", taskAcceptance: "needs_human_review", agent: details.agent, model: details.model, decision: { source: "jev" },
    verification: details.verification, assessment: { status: "not_requested" }, truncated: details.result.truncated,
    costEstimate: { observedUsd: estimateCost(details.metrics).observedUsd, delegationTotalUsd: estimateCost(details.metrics).delegationTotalUsd },
  });
  assert.deepEqual(details.decision, { source: "jev", agent: "worker", model: "jev-offline", confidence: 1,
    usage: { inputTokens: 40, outputTokens: 10 } });
  const { result: workerResult, metrics, ...previousSummary } = details;
  const previousText = `${JSON.stringify({ ...previousSummary, thinking: metrics.profile?.thinking,
    costEstimate: summary.costEstimate, truncated: workerResult.truncated })}\n\n${workerResult.text}`;
  assert.ok(Buffer.byteLength(content.text) < Buffer.byteLength(previousText) * 0.8);
  const oldText = `${JSON.stringify({ ...previousSummary, metrics, costEstimate: estimateCost(metrics), ...workerResult, text: undefined })}\n\n${workerResult.text}`;
  assert.ok(Buffer.byteLength(content.text) < Buffer.byteLength(oldText) * 0.6);
  assert.ok(!JSON.stringify(result).includes("offline-model-key"));
  const preservedResult = structuredClone(result), displayed = f.render(result);
  assert.match(displayed, /Execution ended.*human review/); assert.match(displayed, /declared checks passed/);
  for (const hidden of ["offline-model-key", "Edited fixture.txt.", "taskAcceptance", "\"metrics\""]) assert.equal(displayed.includes(hidden), false);
  for (const call of f.updates.mock.calls) assert.ok(f.render(call.arguments[0], true).startsWith("JEV · "));
  assert.deepEqual(result, preservedResult); assert.equal(f.requests.length, 2); // Rendering cannot start a third model call.
  assert.deepEqual(f.updates.mock.calls.map((call) => call.arguments[0]), [
    ["loading", "Loading profiles"], ["routing", "Selecting candidates"], ["awaiting_approval", "Awaiting execution approval"],
    ["running", "Worker running"], ["verifying", "Running declared verification"],
  ].map(([phase, label]) => ({ content: [{ type: "text", text: `JEV · ${label}` }], details: { phase } })));
});

test("JEV budget advice eight reaches the exact approval and real SDK worker unchanged; no twelve-call default fallback", { timeout: 15000 }, async t => {
  const f = await fixture(t); let budgetCalls = 0;
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); budgetCalls++;
    const packet = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(packet.questions.option.criteria), ["calls_2", "calls_4", "calls_8", "calls_12"]);
    assert.doesNotMatch(JSON.stringify(packet), /fixture\.txt|offline-model-key|systemPrompt|workspace/);
    return Response.json({ model: "jev-offline", usage: { input_tokens: 40, output_tokens: 10 }, answers: { option: {
      type: "choice", choice: "calls_8", confidence: 0.7,
      probabilities: { calls_2: 0.05, calls_4: 0.1, calls_8: 0.7, calls_12: 0.15 },
    } } });
  });
  const advised = await f.budgetTool.execute("offline-budget", { kind: "worker_budget",
    taskSummary: "Edit one declared fixture file and report a brief unverified result.", fileCount: 1,
    readOnly: false, tools: ["edit"], callCeiling: 12, requiresHuman: false }, t.signal, undefined, f.ctx);
  const advice = advised.details as { status: string; maxModelCalls: number; executionAuthorized: boolean };
  assert.equal(advice.status, "recommended"); assert.equal(advice.maxModelCalls, 8); assert.equal(advice.executionAuthorized, false);
  assert.equal(f.confirm.mock.callCount(), 0); assert.equal(f.launches.mock.callCount(), 0); assert.equal(f.requests.length, 0);
  const result = await f.invoke(t.signal, { agents: ["worker"], maxModelCalls: advice.maxModelCalls });
  const details = result.details as State; assert.equal(details.status, "succeeded");
  assert.match(f.confirm.mock.calls[0]!.arguments[1], /SDK model-round cap 8/);
  assert.equal(details.metrics.profile?.maxModelCalls, 8); assert.equal(details.metrics.worker.modelCalls, 2);
  assert.equal(details.metrics.worker.roundsCoverage, "complete"); assert.equal(f.requests.length, 2);
  assert.equal(f.launches.mock.callCount(), 1); assert.equal(budgetCalls, 1);
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
  assert.deepEqual((await readdir(f.cwd)).sort(), ["AGENTS.md", "fixture.txt"]);
});
test("soft routing proposes one baseline or sampled plan and still approves one isolated real SDK worker", { timeout: 20_000 }, async (t) => {
  for (const consultProbability of [0, 1]) await t.test(`consultation rate ${consultProbability}`, async (t) => {
    const f = await fixture(t);
    const random = t.mock.method(crypto, "randomInt", (() => 0xf0000000) as typeof crypto.randomInt);
    const http = t.mock.method(globalThis, "fetch", async () => Response.json({ model: "jev-offline",
      answers: { agent: { type: "choice", choice: "scout", confidence: 0.6, probabilities: { scout: 0.8, worker: 0.2 } } },
      usage: { input_tokens: 40, output_tokens: 10 } }));
    const result = await f.invoke(t.signal, { maxModelCalls: 2, softRouting: { baseline: "worker", consultProbability } });
    const details = result.details as State;
    assert.equal(details.status, "succeeded");
    if (details.status !== "succeeded") return;
    assert.equal(details.agent, "worker");
    assert.equal(details.decision.source, consultProbability ? "jev" : "baseline");
    assert.equal(http.mock.callCount(), consultProbability);
    assert.equal(random.mock.callCount(), consultProbability);
    assert.equal(f.launches.mock.callCount(), 1);
    assert.equal(f.confirm.mock.callCount(), 1);
    assert.match(f.confirm.mock.calls[0]!.arguments[1], /JEV\/soft routing is advisory/);
    assert.equal(f.checks.mock.callCount(), 0);
    assert.equal(f.requests.length, 2);
    assert.equal(details.metrics.worker.modelCalls, 2);
    assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
    assert.ok(f.requests.every((request) => request.tools?.every((tool) => tool.function.name === "edit")));
    if ("softRouting" in details.decision) assert.equal(details.decision.softRouting?.recommendedAgent, consultProbability ? "scout" : null);
    assert.ok(!JSON.stringify(result).includes("offline-jev-key"));
  });
});

test("default SDK-native execution reaches fourteen actual loopback model calls without budget advice", { timeout: 30_000 }, async t => {
  const f = await fixture(t, "sdk_native"), response = await f.invoke(t.signal, { agents: ["worker"] });
  const state = response.details as State;
  assert.equal(state.status, "succeeded"); assert.equal(state.metrics.profile?.maxModelCalls, null);
  assert.equal(state.metrics.worker.modelCalls, 14); assert.equal(f.requests.length, 14);
  assert.equal(state.metrics.worker.rounds?.length, 14); assert.equal(state.metrics.worker.roundsCoverage, "complete");
  assert.equal(state.metrics.worker.accounting.status, "reported");
  if (state.metrics.worker.accounting.status === "reported") assert.equal(state.metrics.worker.accounting.complete, true);
  assert.equal(f.jev.mock.callCount(), 0); assert.equal(f.launches.mock.callCount(), 1);
  assert.match(f.confirm.mock.calls[0]!.arguments[1], /SDK natural completion/);
  assert.ok(f.confirm.mock.calls.some(call => call.arguments[1].includes("no model-round cap")));
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER13\n");
  assert.equal(estimateCost(state.metrics).delegationTotalUsd !== null, true);
});

test("real SDK model-call limits stop before another call, keeping edits but skipping verification and assessment", { timeout: 30_000 }, async (t) => {
  for (const maxModelCalls of [1, 12]) await t.test(`explicit limit ${maxModelCalls}`, async (t) => {
    const f = await fixture(t, "loop");
    const limit = maxModelCalls ?? 12;
    await assert.rejects(f.invoke(t.signal, {
      ...(maxModelCalls === undefined ? {} : { maxModelCalls }),
      acceptanceCriteria: ["Only the fixture changes."],
      verification: { command: process.execPath, args: ["-e", "throw Error('must not run')"], description: "Offline sentinel check." },
    }), (error: Error) => {
      assert.ok(error.message.startsWith(MODEL_CALL_LIMIT_ERROR));
      const record = JSON.parse(error.message.split("\n").at(-1)!);
      assert.equal(record.status, "failed");
      assert.equal(record.metrics.profile.maxModelCalls, limit);
      assert.equal(record.metrics.worker.modelCalls, limit);
      assert.equal(record.metrics.worker.accounting.stats.turns, limit);
      assert.equal(record.metrics.worker.accounting.complete, false);
      assert.ok(record.costEstimate.observedUsd > 0);
      assert.equal(record.costEstimate.delegationTotalUsd, null);
      assert.equal(record.metrics.phasesMs.verifying, undefined);
      assert.equal(record.metrics.phasesMs.judging, undefined);
      assert.equal(record.metrics.assessmentJev.status, "not_requested");
      return true;
    });
    assert.equal(f.requests.length, limit);
    assert.equal(f.launches.mock.callCount(), 1);
    assert.equal(f.checks.mock.callCount(), 0);
    assert.equal(f.confirm.mock.callCount(), 1);
    assert.ok(f.confirm.mock.calls[0]!.arguments[1].includes(`SDK model-round cap ${limit}`));
    assert.equal(f.jev.mock.callCount(), 1); // Routing only; no post-limit assessment/retry.
    assert.deepEqual(f.phases(), ["loading", "routing", "awaiting_approval", "running"]);
    assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), `AFTER${limit}\n`);
    assert.deepEqual((await readdir(f.cwd)).sort(), ["AGENTS.md", "fixture.txt"]);
  });
});

test("real SDK edit → independent check → second approval → JEV verdict, with no automatic rework", { timeout: 30_000 }, async (t) => {
  for (const verdict of ["met", "unmet", "unknown", "decline", "error"] as const) await t.test(verdict, async (t) => {
    const f = await fixture(t);
    const acceptanceCriteria = ["fixture.txt contains exactly AFTER followed by one newline."];
    const verification = { command: process.execPath,
      args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('fixture.txt','utf8'), 'AFTER\\n')"],
      description: "Compare the complete fixture.txt bytes against AFTER and one newline." };
    let approvals = 0;
    f.confirm.mock.mockImplementation(async (_title, message) => {
      if (++approvals === 1) {
        if (approvals === 1) assert.ok(message.includes(acceptanceCriteria[0]!));
      } else {
        assert.ok(message.includes('"workerClaim": "Edited fixture.txt."'));
        assert.ok(message.includes(verification.description));
        assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
      }
      return verdict !== "decline" || approvals === 1;
    });
    f.jev.mock.mockImplementation(async (...[url, init]: Parameters<typeof fetch>) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      const payload = JSON.parse(String(init!.body));
      if (payload.questions.agent) return Response.json({ model: "jev-offline",
        answers: { agent: { type: "choice", choice: "worker", confidence: 1 } }, usage: { input_tokens: 40, output_tokens: 10 } });
      assert.equal(f.confirm.mock.callCount(), 2);
      assert.deepEqual(payload.state.criteria, acceptanceCriteria);
      assert.deepEqual(payload.state.verification, { status: "passed", description: verification.description });
      assert.equal(payload.state.workerClaim, "Edited fixture.txt.");
      assert.ok(!JSON.stringify(payload).includes("offline-model-key"));
      assert.ok(!JSON.stringify(payload).includes("node:assert"));
      return verdict === "error" ? new Response("offline-secret-must-not-escape", { status: 500 }) : Response.json({ model: "jev-offline",
        answers: { criterion_0: { type: "choice", choice: verdict, confidence: 0.9 } }, usage: { input_tokens: 70, output_tokens: 10 } });
    });
    if (verdict === "met") {
      const response = await f.invoke(t.signal, { acceptanceCriteria, verification });
      const state = response.details as State;
      assert.ok(state.status === "succeeded");
      assert.equal(state.assessment.status, "complete");
      assert.deepEqual(state.acceptanceCriteria, acceptanceCriteria);
      const content = response.content[0]!;
      assert.ok(content.type === "text");
      const summary = JSON.parse(content.text.split("\n\n")[0]!);
      assert.equal(summary.acceptanceCriteria, undefined);
      assert.deepEqual(summary.assessment, { status: "complete" });
      assert.deepEqual(summary.decision, { source: "jev" });
      assert.deepEqual(state.assessment, { status: "complete", judgments: [{ verdict: "met", confidence: 0.9 }] });
      assert.equal(content.text.slice(content.text.indexOf("\n\n") + 2), state.result.text);
      const { result, metrics, ...previousSummary } = state;
      const previousText = `${JSON.stringify({ ...previousSummary, thinking: metrics.profile?.thinking,
        costEstimate: summary.costEstimate, truncated: result.truncated })}\n\n${result.text}`;
      assert.ok(Buffer.byteLength(content.text) < Buffer.byteLength(previousText) * 0.8);
      assert.ok(state.metrics.phasesMs.judging! >= 0);
    } else await assert.rejects(f.invoke(t.signal, { acceptanceCriteria, verification }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("offline-secret"));
      const record = JSON.parse(error.message.split("\n").at(-1)!);
      assert.equal(record.status, verdict === "unmet" ? "incomplete" : "needs_review");
      assert.equal(record.assessment.status, record.status);
      assert.equal(record.verification.status, "passed");
      assert.equal(record.costEstimate.assessmentJevUsd === null, verdict === "error");
      assert.deepEqual(record.acceptanceCriteria, acceptanceCriteria);
      assert.equal(record.decision.confidence, 1);
      assert.equal(record.metrics.worker.accounting.complete, true);
      assert.equal(record.result.text, "Edited fixture.txt.");
      if (verdict === "unmet" || verdict === "unknown") assert.deepEqual(record.assessment.judgments, [{ verdict, confidence: 0.9 }]);
      return true;
    });
    assert.equal(f.confirm.mock.callCount(), 2);
    assert.equal(f.jev.mock.callCount(), verdict === "decline" ? 1 : 2);
    assert.deepEqual(f.phases(), ["loading", "routing", "awaiting_approval", "running", "verifying",
      "awaiting_assessment_approval", ...(verdict === "decline" ? [] : ["judging"])]);
    assert.deepEqual(f.updates.mock.calls[5]!.arguments[0], {
      content: [{ type: "text", text: "JEV · Awaiting assessment-transmission approval" }], details: { phase: "awaiting_assessment_approval" },
    });
    if (verdict !== "decline") assert.deepEqual(f.updates.mock.calls[6]!.arguments[0], {
      content: [{ type: "text", text: "JEV · Assessing approved evidence" }], details: { phase: "judging" },
    });
    assert.equal(f.launches.mock.callCount(), 1);
    assert.equal(f.requests.length, 2);
    assert.ok(JSON.stringify(f.requests[0]!.messages).includes(acceptanceCriteria[0]!));
    assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
  });
});

test("caller mutations cannot change approved worker, verification, or assessment inputs", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const acceptanceCriteria = ["Only fixture.txt changes."];
  const verification = { command: process.execPath, args: ["-e", "process.exit(0)"],
    description: "Exit-code sentinel only, not a content check." };
  const original = structuredClone({ acceptanceCriteria, verification });
  let approvals = 0;
  f.confirm.mock.mockImplementation(async (_title, message) => {
    if (++approvals === 1) {
      assert.ok(message.includes(original.acceptanceCriteria[0]!));
      assert.ok(message.includes("process.exit(0)"));
      acceptanceCriteria[0] = "UNAPPROVED changed criterion";
      verification.args[1] = "process.exit(9)";
      verification.description = "UNAPPROVED changed coverage";
    } else {
      assert.ok(!message.includes("UNAPPROVED"));
      acceptanceCriteria.push("UNAPPROVED late criterion");
    }
    return true;
  });
  f.jev.mock.mockImplementation(async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const payload = JSON.parse(String(init?.body));
    if (payload.questions.agent) return Response.json({ model: "jev-offline",
      answers: { agent: { type: "choice", choice: "worker", confidence: 1 } }, usage: { input_tokens: 40, output_tokens: 10 } });
    assert.deepEqual(payload.state.criteria, original.acceptanceCriteria);
    assert.deepEqual(payload.state.verification, { status: "passed", description: original.verification.description });
    assert.ok(f.confirm.mock.calls[1]!.arguments[1].endsWith(JSON.stringify(payload.state, null, 2)));
    return Response.json({ model: "jev-offline", answers: { criterion_0: { type: "choice", choice: "unknown", confidence: 0.9 } },
      usage: { input_tokens: 70, output_tokens: 10 } }); // The sentinel does not prove the criterion.
  });
  await assert.rejects(f.invoke(t.signal, { acceptanceCriteria, verification }), (error: Error) => {
    const record = JSON.parse(error.message.split("\n").at(-1)!);
    assert.equal(record.status, "needs_review");
    assert.deepEqual(record.acceptanceCriteria, original.acceptanceCriteria);
    assert.deepEqual(record.assessment.judgments, [{ verdict: "unknown", confidence: 0.9 }]);
    assert.ok(!error.message.includes("UNAPPROVED"));
    return true;
  });
  assert.deepEqual(f.checks.mock.calls[0]!.arguments.slice(0, 2), [original.verification.command, original.verification.args]);
  assert.ok(JSON.stringify(f.requests[0]!.messages).includes(original.acceptanceCriteria[0]!));
  assert.ok(!JSON.stringify(f.requests).includes("UNAPPROVED"));
  assert.equal(f.requests.length, 2);
  assert.equal(f.confirm.mock.callCount(), 2);
  assert.equal(f.jev.mock.callCount(), 2);
  assert.equal(f.launches.mock.callCount(), 1);
});

test("declined pi approval makes no worker/model call and leaves files intact", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  f.ctx.ui.confirm = async () => false;
  await assert.rejects(f.invoke(t.signal, { verification: {
    command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('unauthorized','bad')"],
  } }), /declined/);
  assert.deepEqual((await readdir(f.cwd)).sort(), ["AGENTS.md", "fixture.txt"]);
  assert.equal(f.launches.mock.callCount(), 0);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.phases(), ["loading", "routing", "awaiting_approval"]);
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "BEFORE\n");
});

test("real SDK provider failures are sanitized and are not retried", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "error");
  await assert.rejects(f.invoke(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("offline-secret"));
    const record = JSON.parse(error.message.split("\n").at(-1)!);
    assert.equal(record.costEstimate.delegationTotalUsd, null);
    assert.equal(record.metrics.worker.accounting.complete, false);
    assert.deepEqual(record.metrics.worker.diagnostic, { category: "provider_error", httpStatus: 500, stage: "model_response" });
    assert.equal(record.metrics.worker.modelCalls, 1);
    return /Subagent failed/.test(error.message);
  });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.phases(), ["loading", "routing", "awaiting_approval", "running"]);
});

test("real SDK HTTP 400 retains only a safe diagnostic, without retry or verification", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "bad_request");
  await assert.rejects(f.invoke(t.signal, { agents: ["worker"], verification: {
    command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('unauthorized','bad')"],
  } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes("offline-secret"));
    const record = JSON.parse(error.message.split("\n").at(-1)!);
    assert.equal(record.status, "failed");
    assert.deepEqual(record.metrics.worker.diagnostic, { category: "model_unavailable", httpStatus: 400, stage: "model_response" });
    assert.equal(record.metrics.worker.modelCalls, 1);
    assert.equal(record.costEstimate.delegationTotalUsd, null);
    assert.equal(record.verification, undefined);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.launches.mock.callCount(), 1);
  assert.equal(f.jev.mock.callCount(), 0);
  assert.deepEqual(f.phases(), ["loading", "awaiting_approval", "running"]);
  assert.deepEqual((await readdir(f.cwd)).sort(), ["AGENTS.md", "fixture.txt"]);
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "BEFORE\n");
});

test("real SDK missing/partial usage stays incomplete while completed work is preserved", { timeout: 30_000 }, async (t) => {
  for (const mode of ["missing_usage", "partial_usage"] as const) await t.test(mode, async (t) => {
    const f = await fixture(t, mode);
    const result = await f.invoke(t.signal, { agents: ["worker"] });
    const state = result.details as State;
    assert.equal(state.status, "succeeded");
    const accounting = state.metrics.worker.accounting;
    assert.ok(accounting.status === "reported");
    assert.equal(accounting.complete, false);
    assert.equal(accounting.stats.turns, 2);
    assert.equal(state.metrics.worker.modelCalls, 2);
    assert.equal(accounting.stats.usage.input, mode === "missing_usage" ? 0 : 20);
    assert.equal(accounting.stats.usage.output, mode === "missing_usage" ? 0 : 10);
    const cost = estimateCost(state.metrics);
    assert.equal(cost.workerUsd, null);
    assert.equal(cost.delegationTotalUsd, null);
    assert.equal(cost.observedUsd, accounting.stats.cost);
    assert.ok(Math.abs(cost.observedUsd - (mode === "missing_usage" ? 0 : 0.00005)) < 1e-12);
    const content = result.content[0]!;
    assert.ok(content.type === "text");
    assert.equal(JSON.parse(content.text.split("\n\n")[0]!).costEstimate.delegationTotalUsd, null);
    assert.equal(f.requests.length, 2);
    assert.equal(f.launches.mock.callCount(), 1);
    assert.equal(f.jev.mock.callCount(), 0);
    assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
  });
});

test("cancellation of real worker closes its pending model connection", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "hold");
  const controller = new AbortController();
  const pending = f.invoke(AbortSignal.any([controller.signal, t.signal]));
  const rejected = assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /cancelled/);
    const displayed = f.render({ content: [{ type: "text", text: error.message }], details: undefined }, false, true);
    assert.match(displayed, /Execution cancelled/); assert.match(displayed, /delegation total unknown/);
    assert.doesNotMatch(displayed, /Execution ended|offline-model-key|cleanup confirmed/);
    return true;
  });
  await f.received;
  const before = ["loading", "routing", "awaiting_approval", "running"];
  assert.deepEqual(f.phases(), before); // Live phase, not a replay after the worker finishes.
  controller.abort();
  await rejected;
  await f.disconnected;
  assert.deepEqual(f.phases(), before); // No post-cancellation progress or follow-on work.
  assert.equal(f.requests.length, 1);
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "BEFORE\n");
});

test("cancelling the real SDK bash tool terminates its detached child", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, "bash");
  const controller = new AbortController();
  const rejected = assert.rejects(f.invoke(AbortSignal.any([controller.signal, t.signal])), /cancelled/);
  let pid: number;
  for (;;) {
    try {
      pid = Number(await readFile(path.join(f.cwd, "waiting.pid"), "utf8"));
      break;
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      await delay(10, undefined, { signal: t.signal });
    }
  }
  assert.ok(Number.isInteger(pid) && pid > 1);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* Already reaped. */ } });
  controller.abort();
  await rejected;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(f.requests.length, 1);
});

test("a successful real worker cannot overrule failed independent verification", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke(t.signal, { agents: ["worker"], verification: {
    command: process.execPath, args: ["-e", "process.exit(1)"],
  } }), (error: Error) => {
    assert.match(error.message, /Verification failed/);
    const record = JSON.parse(error.message.split("\n").at(-1)!);
    assert.deepEqual(record.verification, { status: "failed", exitCode: 1 });
    assert.equal(record.metrics.worker.accounting.complete, true);
    assert.equal(record.metrics.worker.accounting.stats.turns, 2);
    assert.equal(record.metrics.jev.status, "not_requested");
    return true;
  });
  assert.equal(f.jev.mock.callCount(), 0);
  assert.equal(f.launches.mock.callCount(), 1);
  assert.equal(f.requests.length, 2);
  assert.equal(await readFile(path.join(f.cwd, "fixture.txt"), "utf8"), "AFTER\n");
});

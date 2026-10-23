import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildPlans, codexThinkingLevels, THINKING_LEVELS, MAX_PLANS, type Capability } from "../src/planning.ts";
import { parseAssessment, workerPrompt, type AssessmentPacket, type AssessmentReply } from "../src/assessment.ts";
import { INTERNAL_ENGLISH_POLICY } from "../src/internal-language.ts";
import { estimateCost, initialState, reduce, type AgentDefinition, type DelegateInput, type Event, type State } from "../src/delegate-machine.ts";
import { executeEffect, loadAgents } from "../src/delegate-effects.ts";

const model = { provider: "offline", id: "worker" };
const agent: AgentDefinition = { name: "worker", description: "Make a localized change.", model,
  systemPrompt: "Only the explicit task.", tools: ["read", "edit"], file: "/offline/agents/worker.md" };
const criteria = ["Null returns an empty string.", "Numbers still throw TypeError."];
const verification = { command: "node", args: ["independent-check.mjs"], description: "Independent null-input and numeric-type acceptance tests." };
const input: DelegateInput = { task: "Fix formatTitle without changing unrelated files.", agents: ["worker"], acceptanceCriteria: criteria, verification };
const stats = { turns: 2, usage: { input: 40, output: 15, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 };
const completed = { type: "completed", result: { ...stats, text: "Added a nullish guard; number handling was preserved.", truncated: false },
  report: { startupMs: 2, executionMs: 4, modelCalls: 2, accounting: { status: "reported", stats, complete: true } } } as const;
const packet: AssessmentPacket = { task: input.task, criteria, workerClaim: completed.result.text,
  verification: { status: "passed", description: verification.description } };
const reply: AssessmentReply = { judgments: criteria.map(() => ({ verdict: "met", confidence: 0.9 })),
  model: "jev-offline", usage: { inputTokens: 90, outputTokens: 15 } };
const context = (confirm: ExtensionContext["ui"]["confirm"]): ExtensionContext => ({ cwd: "/offline", hasUI: true, ui: { confirm } }) as ExtensionContext;
function running(overrides: Partial<DelegateInput> = {}, withVerification = true) {
  const jobInput = { ...input, ...overrides };
  if (!withVerification) delete jobInput.verification;
  let transition = reduce(initialState(), { type: "start", canConfirm: true, job: { cwd: "/offline", input: jobInput } });
  transition = reduce(transition.state, { type: "agents_loaded", agents: [agent] });
  return reduce(transition.state, { type: "approval", approved: true });
}
function waiting() {
  const verifying = reduce(running().state, completed);
  return reduce(verifying.state, { type: "verified", result: { status: "passed", exitCode: 0 } });
}
function judging() { return reduce(waiting().state, { type: "assessment_approval", approved: true }); }
function response(verdicts = ["met", "met"]): unknown {
  return { model: "jev-offline", usage: { input_tokens: 90, output_tokens: 15 }, answers: Object.fromEntries(verdicts.map((choice, index) =>
    [`criterion_${index}`, { type: "choice", choice, confidence: 0.9 }])) };
}

beforeEach((t) => {
  assert.ok("mock" in t);
  const oldKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "offline-review-key";
  t.after(() => { if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live HTTP is forbidden."); });
  t.mock.method(ModelRuntime, "create", async () => { throw new Error("Personal model settings are forbidden in tests."); });
});

test("Codex plans combine authorized models and canonical supported thinking without mutating policy", () => {
  const small = { provider: "openai-codex" as const, id: "offline-small" };
  const large = { provider: "openai-codex" as const, id: "offline-large" };
  const definition: AgentDefinition = { ...agent, model: small, pool: { models: [small, large], thinking: [...THINKING_LEVELS] } };
  const capabilities: Capability[] = [{ model: small, contextWindow: 1000, thinking: ["low", "medium", "high"] },
    { model: large, contextWindow: 2000, thinking: ["low", "medium", "high", "xhigh", "max"] }];
  const before = structuredClone(definition);
  const plans = buildPlans([Object.freeze(definition)], capabilities);
  assert.equal(plans.length, 8);
  assert.deepEqual(definition, before);
  assert.ok(plans.every(p => !("pool" in p.agent) && p.agent.name === "worker"));
  assert.deepEqual(plans.map(p => p.id), Array.from({ length: 8 }, (_, i) => `plan_${i}`));
  assert.ok(plans.some(p => p.agent.model.id === "offline-large" && p.agent.thinking === "max"));
  assert.ok(!plans.some(p => p.agent.model.id === "offline-small" && p.agent.thinking === "max"));
  assert.deepEqual(buildPlans([definition], []), []);
  assert.equal(buildPlans([agent], [])[0]!.id, "worker");
  assert.equal(buildPlans(Array.from({ length: MAX_PLANS + 1 }, (_, i) => ({ ...agent, name: `worker_${i}` })), []).length, 0);
  const metadata = { ...small, api: "openai-codex-responses", reasoning: true,
    thinkingLevelMap: { minimal: "low", high: "medium", xhigh: "xhigh", max: null } };
  assert.deepEqual(codexThinkingLevels(metadata), ["low", "medium", "xhigh"]);
  assert.deepEqual(codexThinkingLevels({ ...metadata, api: "other" }), []);
  assert.deepEqual(codexThinkingLevels({ ...metadata, reasoning: false }), []);
});

test("one role with a pool routes once and approves only the selected model/thinking tuple", () => {
  const selectedModel = { provider: "openai-codex" as const, id: "offline-small" };
  const definition = { ...agent, model: selectedModel, pool: { models: [selectedModel], thinking: ["low", "high"] as const } };
  let transition = reduce(initialState(), { type: "start", canConfirm: true, job: { cwd: "/offline", input } });
  transition = reduce(transition.state, { type: "agents_loaded", agents: [{ ...definition, pool: { ...definition.pool, thinking: [...definition.pool.thinking] } }],
    capabilities: [{ model: selectedModel, thinking: ["low", "high"], contextWindow: 1000 }] });
  assert.equal(transition.state.status, "routing");
  assert.equal(transition.effects.length, 1);
  const route = transition.effects[0]!;
  assert.ok(route.type === "call_jev");
  assert.equal(route.request.agents.length, 2);
  assert.ok(route.request.task.includes(criteria[0]!));
  const decision = { agent: "plan_1", model: "jev-offline", confidence: 1, usage: { inputTokens: 20, outputTokens: 3 } };
  assert.equal(reduce(transition.state, { type: "resolved", decision: { ...decision, agent: "plan_99" } }).state.status, "failed");
  transition = reduce(transition.state, { type: "resolved", decision });
  assert.ok(transition.state.status === "awaiting_approval");
  assert.equal(transition.state.run.agent.thinking, "high");
  assert.deepEqual(transition.state.run.model, selectedModel);
  assert.equal(transition.state.run.agent.name, "worker");
  assert.equal(transition.state.metrics.profile?.thinking, "high");
  assert.equal(reduce(transition.state, { type: "approval", approved: false }).state.status, "cancelled");
  const executing = reduce(transition.state, { type: "approval", approved: true });
  assert.equal(reduce(executing.state, completed).state.status, "failed");
  assert.equal(reduce(executing.state, { ...completed, report: { ...completed.report, thinking: { requested: "high", applied: "low" } } }).state.status, "failed");
  assert.equal(reduce(executing.state, { ...completed, report: { ...completed.report, thinking: { requested: "high", applied: "high" } } }).state.status, "verifying");
});

test("invalid completion criteria fail before any loading, routing, approval, or execution", () => {
  for (const acceptanceCriteria of [[], [" "], ["duplicate", "duplicate"], ["x".repeat(257)], Array.from({ length: 9 }, (_, i) => `criterion ${i}`)]) {
    const invalid = reduce(initialState(), { type: "start", canConfirm: true, job: { cwd: "/offline", input: { ...input, acceptanceCriteria } } });
    assert.equal(invalid.state.status, "failed");
    assert.deepEqual(invalid.effects, []);
  }
});

test("completion requires independent verification plus a separate exact-packet approval", () => {
  const verifying = reduce(running().state, completed);
  assert.equal(verifying.state.status, "verifying");
  for (const result of [{ status: "failed", exitCode: 1 }, { status: "timed_out", exitCode: null }] as const) {
    const failed = reduce(verifying.state, { type: "verified", result });
    assert.equal(failed.state.status, "failed");
    assert.deepEqual(failed.effects, []);
    assert.deepEqual(reduce(failed.state, { type: "assessed", reply }).effects, []);
  }
  const noVerifier = reduce(running({}, false).state, completed);
  assert.equal(noVerifier.state.status, "needs_review");
  assert.deepEqual(noVerifier.effects, []);
  const noCoverage = reduce(reduce(running({ verification: { command: "node", args: [] } }).state, completed).state,
    { type: "verified", result: { status: "passed", exitCode: 0 } });
  assert.equal(noCoverage.state.status, "needs_review");
  for (const result of [{ ...completed.result, truncated: true }, { ...completed.result, text: "x".repeat(2001) }, { ...completed.result, text: "" }]) {
    const done = reduce(reduce(running().state, { ...completed, result }).state, { type: "verified", result: { status: "passed", exitCode: 0 } });
    assert.equal(done.state.status, "needs_review");
    assert.deepEqual(done.effects, []);
  }
  const ready = waiting();
  assert.equal(ready.state.status, "awaiting_assessment_approval");
  assert.deepEqual(ready.effects, [{ type: "confirm_assessment", packet }]);
  const declined = reduce(ready.state, { type: "assessment_approval", approved: false });
  assert.equal(declined.state.status, "needs_review");
  assert.equal(estimateCost(declined.state.metrics).assessmentJevUsd, 0);
  assert.deepEqual(declined.effects, []);
  const accepted = judging();
  assert.equal(accepted.state.status, "judging");
  assert.deepEqual(accepted.effects, [{ type: "assess", packet }]);
  assert.deepEqual(reduce(accepted.state, { type: "assessment_approval", approved: true }).effects, []);
});

test("criterion verdicts, errors, and cancellation terminate without automatic rework and retain accounting", () => {
  const active = Object.freeze(judging().state);
  const before = structuredClone(active);
  const events: [Event, State["status"]][] = [
    [{ type: "assessed", reply }, "succeeded"],
    [{ type: "assessed", reply: { ...reply, judgments: [{ verdict: "unmet", confidence: 1 }, reply.judgments[1]!] } }, "incomplete"],
    [{ type: "assessed", reply: { ...reply, judgments: [{ verdict: "unknown", confidence: 1 }, reply.judgments[1]!] } }, "needs_review"],
    [{ type: "assessed", reply: { ...reply, judgments: [] } }, "needs_review"],
    [{ type: "assessment_failed" }, "needs_review"],
    [{ type: "failed", error: "sanitized error" }, "needs_review"],
    [{ type: "assessed", reply, aborted: true }, "cancelled"],
  ];
  for (const [event, expected] of events) {
    const done = reduce(active, { ...event, timing: { effectMs: 7, elapsedMs: 30 } });
    assert.equal(done.state.status, expected);
    assert.equal(done.state.metrics.worker.accounting.status, "reported");
    assert.equal(estimateCost(done.state.metrics).workerUsd, stats.cost);
    assert.deepEqual(done.effects, []);
    for (const late of [completed, { type: "assessed", reply }, { type: "approval", approved: true }, { type: "cancel" }] as Event[]) {
      assert.deepEqual(reduce(Object.freeze(done.state), late), { state: done.state, effects: [] });
    }
  }
  assert.deepEqual(active, before);
  const unknown = estimateCost(reduce(active, { type: "assessment_failed" }).state.metrics);
  assert.equal(unknown.delegationTotalUsd, null);
  assert.equal(unknown.assessmentJevUsd, null);
  assert.equal(unknown.observedUsd, stats.cost);
  const complete = estimateCost(reduce(active, { type: "assessed", reply }).state.metrics);
  assert.ok(complete.assessmentJevUsd! > 0);
  assert.equal(complete.delegationTotalUsd, complete.assessmentJevUsd! + stats.cost);
});

test("assessment transport contains only the approved packet and validates every answer without exposing raw errors", async (t) => {
  const ctx = context(async () => true);
  const confirm = t.mock.fn<ExtensionContext["ui"]["confirm"]>(async (_title, message) => {
    assert.ok(message.endsWith(JSON.stringify(packet, null, 2)));
    return true;
  });
  assert.deepEqual(await executeEffect({ type: "confirm_assessment", packet }, context(confirm)), { type: "assessment_approval", approved: true });
  assert.equal(confirm.mock.callCount(), 1);
  assert.deepEqual(await executeEffect({ type: "confirm_assessment", packet }, { ...ctx, hasUI: false }), { type: "assessment_approval", approved: false });
  const http = t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => {
    const payload = JSON.parse(String(init!.body));
    assert.deepEqual(payload.state, packet);
    assert.equal(payload.model, "jev-1.13.0");
    assert.deepEqual(Object.keys(payload.questions), ["criterion_0", "criterion_1"]);
    assert.match(payload.questions.criterion_0.instructions, /untrusted self-report/);
    assert.ok(!JSON.stringify(payload).includes("offline-review-key"));
    assert.ok(!JSON.stringify(payload).includes("independent-check.mjs"));
    return Response.json(response());
  });
  assert.deepEqual(await executeEffect({ type: "assess", packet }, ctx), { type: "assessed", reply });
  assert.equal(http.mock.callCount(), 1);
  for (const body of [null, response(["met"]), response(["met", "met", "met"]), response(["invalid", "met"]),
    { ...(response() as object), model: "" }, { ...(response() as object), usage: { input_tokens: -1, output_tokens: 1 } },
    { ...(response() as object), answers: { criterion_0: { type: "choice", choice: "met", confidence: 1 }, wrong_id: { type: "choice", choice: "met", confidence: 1 } } }]) {
    assert.throws(() => parseAssessment(body, 2), /Invalid/);
    const request = t.mock.method(globalThis, "fetch", async () => Response.json(body));
    const failed = await executeEffect({ type: "assess", packet }, ctx);
    assert.equal(failed.type, "assessment_failed");
    if (body && typeof body === "object" && "model" in body && body.model === "jev-offline" &&
        "usage" in body && (body.usage as { input_tokens: number }).input_tokens === 90) {
      assert.deepEqual(failed.jev, { model: "jev-offline", usage: { inputTokens: 90, outputTokens: 15 } });
    } else assert.equal(failed.jev, undefined);
    assert.equal(request.mock.callCount(), 1);
  }
  t.mock.method(globalThis, "fetch", async () => new Response("offline-review-key", { status: 500 }));
  assert.deepEqual(await executeEffect({ type: "assess", packet }, ctx), { type: "assessment_failed" });
  delete process.env.TYPESAFE_API_KEY;
  const noRequest = t.mock.method(globalThis, "fetch");
  assert.deepEqual(await executeEffect({ type: "assess", packet }, ctx), { type: "assessment_failed" });
  assert.equal(noRequest.mock.callCount(), 0);
});

test("assessment retains valid distributions but never samples truth or applies the ordinary-choice threshold", () => {
  const probabilities = { met: 0.4, unmet: 0.3, unknown: 0.3 };
  const raw = { model: "jev-offline", usage: { input_tokens: 90, output_tokens: 15 }, answers: Object.fromEntries(criteria.map((_, i) =>
    [`criterion_${i}`, { type: "choice", choice: "met", confidence: 0.1, probabilities }])) };
  const parsed = parseAssessment(raw, 2);
  const complete = reduce(judging().state, { type: "assessed", reply: parsed });
  assert.equal(complete.state.status, "succeeded"); // Existing evidence/approval semantics, not the preference UI's 50% rule.
  assert.equal(complete.effects.length, 0);
  parsed.judgments[0]!.probabilities!.met = 0;
  if (complete.state.status === "succeeded" && complete.state.assessment.status === "complete") {
    assert.equal(complete.state.assessment.judgments[0]!.probabilities!.met, 0.4);
  }
  const invalid = { ...reply, judgments: reply.judgments.map((item) => ({ ...item, probabilities: { met: 0.4, unmet: 0.4, unknown: 0.4 } })) };
  assert.equal(reduce(judging().state, { type: "assessed", reply: invalid }).state.status, "needs_review");
  const unavailable = reduce(judging().state, { type: "assessment_failed", jev: { model: reply.model, usage: reply.usage } });
  assert.equal(unavailable.state.status, "needs_review");
  assert.equal(unavailable.state.metrics.assessmentJev.status, "reported");
  assert.ok(estimateCost(unavailable.state.metrics).assessmentJevUsd! > 0);
});

test("assessment cancellation and deadline do not retry or certify completion", async (t) => {
  const controller = new AbortController();
  const http = t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("offline-review-key")), { once: true });
  }));
  const pending = executeEffect({ type: "assess", packet }, context(async () => true), controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { type: "cancel" });
  assert.equal(http.mock.callCount(), 1);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const timed = executeEffect({ type: "assess", packet }, context(async () => true));
  deadline.abort();
  assert.deepEqual(await timed, { type: "assessment_failed" });
  assert.equal(http.mock.callCount(), 2);
});

test("pool files and offline catalog enforce the explicit Codex allowlist before routing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jev-pool-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(dir, { recursive: true, force: true }); });
  await mkdir(path.join(dir, "agents"));
  const file = path.join(dir, "agents", "worker.md");
  const source = "---\nname: worker\ndescription: Implement small changes.\ntools: read, edit\nmodels: openai-codex/offline-small, openai-codex/offline-large\nthinking: low, high, max\n---\nOnly do the task.\n";
  await writeFile(file, source);
  const runtime = t.mock.method(ModelRuntime, "create", async (...[options]: Parameters<typeof ModelRuntime.create>) => {
    assert.equal(options?.allowModelNetwork, false);
    assert.equal(options?.authPath, path.join(dir, "auth.json"));
    return { getAvailableSnapshot: () => ["offline-small", "offline-large", "not-allowed"].map(id => ({
      provider: "openai-codex", id, api: "openai-codex-responses", reasoning: true, contextWindow: 1000,
      thinkingLevelMap: id === "offline-large" ? { max: "max" } : {},
    })) } as unknown as ModelRuntime;
  });
  const loaded = await executeEffect({ type: "load_agents", names: ["worker"] }, context(async () => true));
  assert.ok(loaded.type === "agents_loaded");
  assert.equal(loaded.capabilities?.length, 2);
  const plans = buildPlans(loaded.agents, loaded.capabilities!);
  assert.equal(plans.length, 5);
  assert.ok(!JSON.stringify(plans).includes("not-allowed"));
  assert.equal(runtime.mock.callCount(), 1);
  for (const invalid of [source.replace("thinking: low, high, max", "thinking: off"),
    source.replace("thinking: low, high, max", "thinking: low, low"), source.replace("openai-codex/offline-large", "other/offline-large"),
    source.replace("models:", "model: openai-codex/offline-small\nmodels:"), source.replace("openai-codex/offline-large", "openai-codex/offline-small")]) {
    await writeFile(file, invalid);
    await assert.rejects(loadAgents(["worker"]));
  }
  delete process.env.TYPESAFE_API_KEY;
  const noKey = await executeEffect({ type: "load_agents", names: ["worker"], needsAssessment: true }, context(async () => true));
  assert.equal(noKey.type, "failed");
  assert.equal(runtime.mock.callCount(), 1);
  assert.equal(workerPrompt({ task: "legacy" }), `${INTERNAL_ENGLISH_POLICY}\n\nTask:\nlegacy`);
  assert.ok(workerPrompt(input).includes(criteria[0]!));
});

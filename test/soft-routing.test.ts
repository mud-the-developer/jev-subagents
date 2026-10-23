import assert from "node:assert/strict";
import crypto from "node:crypto";
import { beforeEach, test } from "node:test";
import { readChoice, readProbabilities, sampleChoice } from "../src/choice.ts";
import { reduce, type Decision, type RouteRequest } from "../src/machine.ts";
import { route } from "../src/effects.ts";
import { initialState, reduce as reduceDelegate, reduceWorker, estimateCost, type AgentDefinition, type DelegateInput, type Event } from "../src/delegate-machine.ts";
import type { Capability } from "../src/planning.ts";
import { reduceSetup } from "../scripts/setup.ts";

const request: RouteRequest = { task: "A bounded fixture task", agents: [
  { name: "worker", description: "Small fixture edits" }, { name: "strong", description: "Complex fixture edits" },
], softRouting: { baseline: "worker", consultProbability: 0.4 } };
const opinion: Decision = { agent: "worker", confidence: 0.6, model: "jev-offline",
  usage: { inputTokens: 100, outputTokens: 10 }, probabilities: { worker: 0.75, strong: 0.25 } };
const body = () => ({ model: opinion.model, usage: { input_tokens: 100, output_tokens: 10 },
  answers: { agent: { type: "choice", choice: opinion.agent, confidence: opinion.confidence, probabilities: opinion.probabilities } } });
beforeEach((t) => {
  assert.ok("mock" in t);
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "offline-soft-key";
  t.after(() => { if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live HTTP forbidden."); });
});

test("routing, delegation, worker and setup reducers do not read clocks or randomness", (t) => {
  const forbidden = () => { throw new Error("Reducer attempted clock/random I/O."); };
  const clock = t.mock.method(Date, "now", forbidden);
  const random = t.mock.method(Math, "random", forbidden);
  const secure = t.mock.method(crypto, "randomInt", forbidden);
  try {
    assert.equal(reduce({ status: "idle" }, { type: "route", request }).state.status, "gating");
    assert.equal(reduceDelegate(initialState(), { type: "start", canConfirm: true,
      job: { cwd: "/isolated", input: { task: "fixture", agents: ["worker"] } } }).state.status, "loading");
    assert.equal(reduceWorker({ status: "running", modelCalls: 0, maxModelCalls: 2 }, { type: "model_call" }).state.modelCalls, 1);
    assert.equal(reduceSetup({ status: "idle" }, { type: "start", root: "/isolated" }).state.status, "checking");
  } finally { clock.mock.restore(); random.mock.restore(); secure.mock.restore(); }
});

test("choice distributions are complete, normalized, owned and ordered; zero mass is never sampled", () => {
  const ids = ["zero", "a", "b", "last_zero"];
  const p = readProbabilities({ b: 0.75, a: 0.25, zero: 0, last_zero: 0 }, ids);
  assert.deepEqual(Object.keys(p), ids);
  for (const [draw, expected] of [[0, "a"], [0.24999, "a"], [0.25, "b"], [1 - Number.EPSILON, "b"]] as const) assert.equal(sampleChoice(p, draw), expected);
  for (const invalid of [null, [], {}, { a: 1 }, { a: 0.4, b: 0.4 }, { a: NaN, b: 1 }, { a: -0.1, b: 1.1 },
    { a: "0.5", b: 0.5 }, { a: Infinity, b: 0 }, { a: 0, b: 0 }, { a: 0.5, outside: 0.5 }]) {
    assert.throws(() => readProbabilities(invalid, ["a", "b"]), /Invalid/);
  }
  assert.throws(() => readProbabilities({ a: 1 }, ["a", "a"]));
  assert.throws(() => readChoice({ type: "choice", choice: "b", confidence: 1, probabilities: { a: 0.9, b: 0.1 } }, ["a", "b"]));
  assert.throws(() => readChoice({ type: "choice", choice: "a", confidence: 1 }, ["a", "b"], true));
  for (const draw of [-1, 1, NaN, Infinity]) assert.throws(() => sampleChoice(p, draw));
});

test("soft router uses separate replayable gate and selection draws with immutable snapshots", () => {
  const mutable = structuredClone(request);
  const started = reduce({ status: "idle" }, { type: "route", request: mutable });
  assert.deepEqual(started, reduce({ status: "idle" }, { type: "route", request }));
  assert.equal(started.state.status, "gating");
  mutable.softRouting!.consultProbability = 0;
  mutable.softRouting!.baseline = "outside";
  assert.deepEqual(reduce(started.state, { type: "route", request }).effects, []);
  assert.equal(reduce(started.state, { type: "resolved", decision: opinion }).state, started.state);
  const called = reduce(started.state, { type: "route_draw", purpose: "gate", value: 0.39 });
  assert.equal(called.state.status, "routing");
  assert.equal(called.effects[0]?.type, "call_jev");
  const reply = structuredClone(opinion);
  const judged = reduce(called.state, { type: "resolved", decision: reply });
  assert.equal(judged.state.status, "sampling");
  (reply.probabilities as Record<string, number>).strong = 0;
  assert.equal(reduce(judged.state, { type: "route_draw", purpose: "gate", value: 0 }).state, judged.state);
  const selected = reduce(judged.state, { type: "route_draw", purpose: "selection", value: 0.9 });
  assert.equal(selected.state.status, "succeeded");
  if (selected.state.status !== "succeeded") return;
  assert.equal(selected.state.decision.agent, "strong");
  assert.deepEqual(selected.state.decision.softRouting, { baseline: "worker", consultProbability: 0.4,
    gateDraw: 0.39, selectionDraw: 0.9, recommendedAgent: "worker" });
  for (const event of [{ type: "cancel" }, { type: "resolved", decision: opinion }, { type: "route", request }] as const) {
    assert.equal(reduce(selected.state, event).state, selected.state);
  }
  const skipped = reduce(started.state, { type: "route_draw", purpose: "gate", value: 0.4 });
  assert.equal(skipped.state.status, "succeeded");
  if (skipped.state.status === "succeeded") assert.equal(skipped.state.decision.source, "baseline");
  assert.deepEqual(skipped.effects, []);
});

test("malformed routing events fail closed and rejected judgments retain valid accounting", () => {
  const requestNow = { ...request, softRouting: { baseline: "worker" } };
  const active = reduce({ status: "idle" }, { type: "route", request: requestNow }).state;
  for (const decision of [undefined, null, {}, { ...opinion, agent: "outside" },
    { ...opinion, confidence: NaN }, { ...opinion, probabilities: { worker: 0.1, strong: 0.1 } }]) {
    const failed = reduce(active, { type: "resolved", decision: decision as Decision });
    assert.equal(failed.state.status, "failed");
    assert.deepEqual(failed.effects, []);
    if (failed.state.status === "failed") {
      assert.deepEqual(failed.state.jev, decision && "usage" in decision ? { model: opinion.model, usage: opinion.usage } : undefined);
    }
  }
});

test("gate endpoints need no gate randomness; invalid policy, draws and decisions fail closed", () => {
  for (const p of [0, 1]) {
    const next = reduce({ status: "idle" }, { type: "route", request: { ...request, softRouting: { baseline: "worker", consultProbability: p } } });
    assert.equal(next.state.status, p ? "routing" : "succeeded");
    assert.ok(!next.effects.some((effect) => effect.type === "sample_route"));
  }
  for (const policy of [{ baseline: "outside" }, { baseline: "worker", consultProbability: NaN }, { baseline: "worker", consultProbability: -0.1 },
    { baseline: "worker", consultProbability: 1.1 }, { baseline: "worker", approve: true }]) {
    assert.equal(reduce({ status: "idle" }, { type: "route", request: { ...request, softRouting: policy } }).state.status, "failed");
  }
  const gated = reduce({ status: "idle" }, { type: "route", request });
  assert.equal(reduce(gated.state, { type: "route_draw", purpose: "gate", value: 1 }).state.status, "failed");
  const called = reduce(gated.state, { type: "route_draw", purpose: "gate", value: 0 });
  const { probabilities: _p, ...withoutP } = opinion;
  assert.equal(reduce(called.state, { type: "resolved", decision: withoutP }).state.status, "failed");
  const sampled = reduce(called.state, { type: "resolved", decision: opinion });
  const cancelled = reduce(sampled.state, { type: "cancel" });
  assert.equal(cancelled.state.status, "cancelled");
  if (cancelled.state.status === "cancelled") assert.deepEqual(cancelled.state.jev?.usage, opinion.usage);
  assert.equal(reduce(sampled.state, { type: "route_draw", purpose: "selection", value: NaN }).state.status, "failed");
});

test("soft route effects send only the allowed task/rubrics, no policy or draws, and make at most one JEV call", async (t) => {
  const random = t.mock.method(crypto, "randomInt", (() => 0.9 * 2 ** 32) as typeof crypto.randomInt);
  const http = t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => {
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.state, request.task);
    assert.deepEqual(Object.keys(sent.questions.agent.criteria), ["worker", "strong"]);
    assert.ok(!JSON.stringify(sent).includes("consultProbability"));
    assert.ok(!JSON.stringify(sent).includes("offline-soft-key"));
    return Response.json(body());
  });
  const skipped = await route({ ...request, softRouting: { baseline: "worker", consultProbability: 0 } });
  assert.equal(skipped.status, "succeeded");
  assert.equal(http.mock.callCount(), 0);
  assert.equal(random.mock.callCount(), 0);
  const selected = await route({ ...request, softRouting: { baseline: "worker" } });
  assert.equal(selected.status, "succeeded");
  if (selected.status === "succeeded") assert.equal(selected.decision.agent, "strong");
  assert.equal(random.mock.callCount(), 1);
  assert.equal(http.mock.callCount(), 1);
  const failedHttp = t.mock.method(globalThis, "fetch", async () => new Response("offline-soft-key", { status: 503 }));
  assert.equal((await route({ ...request, softRouting: { baseline: "worker" } })).status, "failed");
  assert.equal(failedHttp.mock.callCount(), 1);
  assert.equal(random.mock.callCount(), 1); // No baseline/selection draw after an HTTP failure.
});

test("cancellation between JEV and sampling preserves usage without another draw or fallback", async (t) => {
  const controller = new AbortController();
  const random = t.mock.method(crypto, "randomInt", (() => { throw new Error("must not draw"); }) as typeof crypto.randomInt);
  const http = t.mock.method(globalThis, "fetch", async () => Response.json(body()));
  const result = await route({ ...request, softRouting: { baseline: "worker" } }, controller.signal,
    (status) => { if (status === "sampling") controller.abort(); });
  assert.equal(result.status, "cancelled");
  if (result.status === "cancelled") assert.deepEqual(result.jev?.usage, opinion.usage);
  assert.equal(random.mock.callCount(), 0);
  assert.equal(http.mock.callCount(), 1);
});

const agents: AgentDefinition[] = ["worker", "strong"].map((name) => ({ name, description: name, systemPrompt: "Only the fixture.",
  tools: ["read"], model: { provider: "offline", id: name }, file: `/isolated/${name}.md` }));
function loading(input: DelegateInput) {
  return reduceDelegate(initialState(), { type: "start", job: { input, cwd: "/isolated" }, canConfirm: true }).state;
}

test("delegation composes the same router, accumulates phase timing, and never skips execution approval", () => {
  const input = { task: request.task, agents: ["worker", "strong"], softRouting: { baseline: "worker", consultProbability: 0.4 } };
  let state = reduceDelegate(loading(input), { type: "agents_loaded", agents }).state;
  for (const event of [
    { type: "route_draw", purpose: "gate", value: 0.2, timing: { effectMs: 2, elapsedMs: 2 } },
    { type: "resolved", decision: opinion, timing: { effectMs: 3, elapsedMs: 5 } },
    { type: "route_draw", purpose: "selection", value: 0.9, timing: { effectMs: 5, elapsedMs: 10 } },
  ] satisfies Event[]) state = reduceDelegate(state, event).state;
  assert.equal(state.status, "awaiting_approval");
  assert.equal(state.metrics.phasesMs.routing, 10);
  assert.equal(state.metrics.jev.status, "reported");
  assert.equal(state.metrics.profile?.agent, "strong");
  assert.equal(state.metrics.worker.accounting.status, "not_started");
  assert.equal(reduceDelegate(state, { type: "approval", approved: false }).state.status, "cancelled");
  assert.equal(reduceDelegate(state, { type: "approval", approved: true }).effects[0]?.type, "run_agent");
  const skipped = reduceDelegate(loading({ ...input, softRouting: { baseline: "worker", consultProbability: 0 } }), { type: "agents_loaded", agents });
  assert.equal(skipped.state.status, "awaiting_approval");
  assert.equal(skipped.state.metrics.profile?.source, "baseline");
  assert.equal(skipped.state.metrics.jev.status, "not_requested");
  assert.equal(estimateCost(skipped.state.metrics).jevUsd, 0);
  assert.equal(skipped.effects[0]?.type, "confirm_run");
});

test("pool baseline must identify exactly one supported tuple; selection cannot change model/thinking policy", () => {
  const pool: AgentDefinition = { ...agents[0]!, model: { provider: "openai-codex", id: "offline-a" },
    pool: { models: [{ provider: "openai-codex", id: "offline-a" }], thinking: ["low", "high"] } };
  const capabilities: Capability[] = [{ model: pool.model, thinking: ["low", "high"], contextWindow: 1000 }];
  const input: DelegateInput = { task: "fixture", agents: ["worker"], softRouting: { baseline: "worker", consultProbability: 0 } };
  const ambiguous = reduceDelegate(loading(input), { type: "agents_loaded", agents: [pool], capabilities });
  assert.equal(ambiguous.state.status, "failed");
  assert.deepEqual(ambiguous.effects, []);
  const explicit = { ...input, softRouting: { baseline: { agent: "worker", model: pool.model, thinking: "low" as const }, consultProbability: 0 } };
  const selected = reduceDelegate(loading(explicit), { type: "agents_loaded", agents: [pool], capabilities });
  assert.equal(selected.state.status, "awaiting_approval");
  if (selected.state.status === "awaiting_approval") {
    assert.equal(selected.state.run.agent.thinking, "low");
    assert.equal(selected.state.decision.source, "baseline");
  }
  assert.equal(reduceDelegate(loading({ ...explicit, softRouting: { ...explicit.softRouting, baseline: { ...explicit.softRouting.baseline, thinking: "max" } } }),
    { type: "agents_loaded", agents: [pool], capabilities }).state.status, "failed");
});

test("bounded transport rejects oversized responses and preserves available usage on invalid distributions", async (t) => {
  const bounded = t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(65_537)));
  assert.equal((await route({ ...request, softRouting: { baseline: "worker" } })).status, "failed");
  assert.equal(bounded.mock.callCount(), 1);
  bounded.mock.restore();
  t.mock.method(crypto, "randomInt", (() => 0) as typeof crypto.randomInt);
  const bad = body();
  bad.answers.agent.probabilities = { worker: 0.4, strong: 0.4 };
  const http = t.mock.method(globalThis, "fetch", async () => Response.json(bad));
  const failed = await route({ ...request, softRouting: { baseline: "worker" } });
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.deepEqual(failed.jev?.usage, opinion.usage);
  assert.equal(http.mock.callCount(), 1);
  assert.ok(!JSON.stringify(failed).includes("offline-soft-key"));
});

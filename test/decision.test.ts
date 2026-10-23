import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import jevRouter from "../src/index.ts";
import { decide, reduceDecision, type DecisionInput, type DecisionReply } from "../src/decision.ts";
import { route } from "../src/effects.ts";
import { executeEffect } from "../src/delegate-effects.ts";

const input: DecisionInput = { question: "Choose a fixture formatting convention.", context: "Only a reversible style preference, not permission to edit.",
  options: ["a", "b", "c"].map((id) => ({ id, title: `Option ${id}`, description: `Fixture convention ${id}` })), requiresHuman: false };
const reply: DecisionReply = { choice: "a", confidence: 0.1, probabilities: { a: 0.73, b: 0.24, c: 0.03 },
  model: "jev-offline", usage: { inputTokens: 123, outputTokens: 45 } };
function body(value = reply) {
  return { model: value.model, usage: { input_tokens: value.usage.inputTokens, output_tokens: value.usage.outputTokens },
    answers: { option: { type: "choice", choice: value.choice, confidence: value.confidence, probabilities: value.probabilities } } };
}
beforeEach((t) => {
  assert.ok("mock" in t);
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "offline-decision-key";
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Live HTTP forbidden."); });
});

test("decision reducer uses raw maximum probability, not confidence or rounded percentages, including exactly 50%", () => {
  const start = reduceDecision({ status: "idle" }, { type: "start", input });
  assert.deepEqual(start, reduceDecision({ status: "idle" }, { type: "start", input }));
  for (const [probabilities, choice, expected] of [
    [{ a: 0.73, b: 0.24, c: 0.03 }, "a", "recommended"],
    [{ a: 0.49999, b: 0.3, c: 0.20001 }, "a", "needs_user"],
    [{ a: 0.5, b: 0.3, c: 0.2 }, "a", "recommended"],
    [{ a: 0.5, b: 0.5, c: 0 }, "b", "recommended"],
  ] as const) {
    const result = reduceDecision(start.state, { type: "judged", reply: { ...reply, probabilities, choice,
      confidence: expected === "needs_user" ? 0.99 : 0.01 } });
    assert.equal(result.state.status, expected);
    assert.deepEqual(result.effects, []);
    if (result.state.status === "needs_user") {
      assert.deepEqual(result.state.askUser.options.map((option) => option.title), input.options.map((option) => option.title));
      assert.ok(result.state.askUser.options[0]!.description.includes("JEV support"));
      assert.match(result.state.askUser.context, /rounded/);
      assert.ok(result.state.advisoryOnly);
    }
    if (result.state.status === "recommended") {
      assert.equal(result.state.option.id, choice);
      assert.equal(result.state.advisoryOnly, true);
      assert.ok(!("approved" in result.state));
    }
    assert.equal(reduceDecision(result.state, { type: "start", input }).state, result.state);
    assert.equal(reduceDecision(result.state, { type: "cancel" }).state, result.state);
  }
  const binary = reduceDecision({ status: "idle" }, { type: "start", input: { ...input, options: input.options.slice(0, 2) } });
  assert.equal(reduceDecision(binary.state, { type: "judged", reply: { ...reply, probabilities: { a: 0.5, b: 0.5 } } }).state.status, "recommended");
  assert.equal(reduceDecision(binary.state, { type: "judged", reply: { ...reply, probabilities: { a: 0.4999999, b: 0.4999999 } } }).state.status, "needs_user");
});

test("mandatory human decisions bypass JEV without fabricated percentages, even without an API key", async (t) => {
  delete process.env.TYPESAFE_API_KEY;
  const http = t.mock.method(globalThis, "fetch");
  const state = await decide({ ...input, requiresHuman: true });
  assert.equal(state.status, "needs_user");
  if (state.status !== "needs_user") return;
  assert.equal(state.reply, undefined);
  assert.ok(state.askUser.options.every((option) => option.description.includes("not evaluated") && !option.description.includes("%")));
  assert.equal(reduceDecision(state, { type: "judged", reply }).state, state);
  assert.equal(http.mock.callCount(), 0);
});

test("invalid questions/options stop before I/O; unavailable/malformed judgments do not become automatic choices", async (t) => {
  const http = t.mock.method(globalThis, "fetch");
  for (const invalid of [null, {}, { ...input, requiresHuman: undefined }, { ...input, options: [] },
    { ...input, question: " " }, { ...input, context: "x".repeat(4_001) },
    { ...input, options: [input.options[0], input.options[0]] },
    { ...input, options: Object.assign(Array(2), { 0: input.options[0] }) },
    { ...input, options: [{ ...input.options[0], id: "../../a" }, input.options[1]] },
    { ...input, options: [{ ...input.options[0] }, { ...input.options[1], title: input.options[0]!.title }] }]) {
    assert.equal((await decide(invalid as DecisionInput)).status, "failed");
  }
  assert.equal(http.mock.callCount(), 0);
  const start = reduceDecision({ status: "idle" }, { type: "start", input });
  for (const invalid of [{ ...reply, probabilities: { a: 1 } }, { ...reply, probabilities: { a: 0.4, b: 0.4, c: 0.4 } },
    { ...reply, choice: "b" }, { ...reply, choice: "outside" }, { ...reply, confidence: NaN }]) {
    const state = reduceDecision(start.state, { type: "judged", reply: invalid }).state;
    assert.equal(state.status, "failed");
    if (state.status === "failed") assert.deepEqual(state.jev?.usage, reply.usage);
  }
});

test("malformed judgment events fail closed without throwing or inventing usage", () => {
  const pending = reduceDecision({ status: "idle" }, { type: "start", input }).state;
  for (const value of [undefined, null, {}, []]) {
    const failed = reduceDecision(pending, { type: "judged", reply: value as DecisionReply });
    assert.deepEqual(failed.effects, []);
    assert.equal(failed.state.status, "failed");
    if (failed.state.status === "failed") assert.equal(failed.state.jev, undefined);
  }
});

test("one bounded option request owns its packet; user arguments cannot mutate choices across awaits", async (t) => {
  const mutable = structuredClone(input);
  const http = t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => {
    const sent = JSON.parse(String(init?.body));
    assert.deepEqual(sent.state, { question: input.question, context: input.context });
    assert.deepEqual(Object.keys(sent.questions.option.criteria), ["a", "b", "c"]);
    assert.equal(sent.model, "jev-1.13.0");
    assert.ok(!JSON.stringify(sent).includes("offline-decision-key"));
    mutable.options[0]!.id = "outside";
    mutable.options[0]!.title = "mutated title";
    mutable.context = "mutated context";
    return Response.json(body());
  });
  const state = await decide(mutable, undefined, () => Promise.reject(new Error("private-progress-error")));
  assert.equal(state.status, "recommended");
  if (state.status === "recommended") assert.equal(state.option.title, "Option a");
  assert.equal(http.mock.callCount(), 1);
  assert.ok(!JSON.stringify(state).includes("private-progress-error"));
  assert.ok(!JSON.stringify(state).includes("offline-decision-key"));
});

test("option HTTP errors, missing probabilities, cancellation and deadlines stop without retries or fake support", async (t) => {
  const http = t.mock.method(globalThis, "fetch", async () => new Response("offline-decision-key", { status: 500 }));
  const failed = await decide(input);
  assert.equal(failed.status, "failed");
  assert.equal(http.mock.callCount(), 1);
  assert.ok(!JSON.stringify(failed).includes("offline-decision-key"));
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...body(), answers: { option: { type: "choice", choice: "a", confidence: 1 } } }));
  const malformed = await decide(input);
  assert.equal(malformed.status, "failed");
  if (malformed.status === "failed") assert.deepEqual(malformed.jev?.usage, reply.usage);
  const wait = t.mock.method(globalThis, "fetch", async (...[, init]: Parameters<typeof fetch>) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("offline-decision-key")), { once: true });
  }));
  const controller = new AbortController();
  const pending = decide(input, controller.signal);
  controller.abort();
  assert.equal((await pending).status, "cancelled");
  assert.equal((await decide(input, AbortSignal.abort())).status, "cancelled");
  assert.equal(wait.mock.callCount(), 1);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const timed = decide(input);
  deadline.abort();
  assert.equal((await timed).status, "failed");
  assert.equal(wait.mock.callCount(), 2);
});

test("all JEV consumers preserve validated accounting when cancellation races with body delivery", async (t) => {
  for (const kind of ["route", "decide", "assessment"] as const) {
    const controller = new AbortController();
    const http = t.mock.method(globalThis, "fetch", async () => {
      const response = Response.json(body());
      controller.abort();
      return response;
    });
    const result = kind === "route"
      ? await route({ task: "Fixture", agents: [{ name: "a", description: "A" }, { name: "b", description: "B" }] }, controller.signal)
      : kind === "decide" ? await decide(input, controller.signal)
        : await executeEffect({ type: "assess", packet: {
          task: "Fixture", criteria: ["Fixture accepted"], workerClaim: "Fixture updated",
          verification: { status: "passed", description: "Fixture check" },
        } }, {} as ExtensionContext, controller.signal);
    assert.equal("status" in result ? result.status : result.type, kind === "assessment" ? "cancel" : "cancelled");
    assert.ok("jev" in result);
    assert.deepEqual(result.jev, { model: reply.model, usage: reply.usage });
    assert.equal(http.mock.callCount(), 1);
    assert.ok(!JSON.stringify(result).includes("offline-decision-key"));
  }
});

test("pi decision adapter returns a bounded ask_user handoff only below 50%, with no hooks or UI bypass", async (t) => {
  const tools: ToolDefinition[] = [];
  jevRouter({ registerTool: (tool: ToolDefinition) => { tools.push(tool); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const tool = tools.find((tool) => tool.name === "jev_decide")!;
  assert.match(tool.promptGuidelines!.join("\n"), /pass askUser unchanged to ask_user/);
  assert.match(tool.promptGuidelines!.join("\n"), /cannot be delegated/);
  const http = t.mock.method(globalThis, "fetch", async () => Response.json(body({ ...reply, probabilities: { a: 0.4, b: 0.35, c: 0.25 } })));
  const updates = t.mock.fn<NonNullable<Parameters<ToolDefinition["execute"]>[3]>>(() => {});
  const result = await tool.execute("offline", input, undefined, updates, {} as ExtensionContext);
  const content = result.content[0]!;
  assert.equal(content.type, "text");
  if (content.type === "text") {
    const parsed = JSON.parse(content.text);
    assert.equal(parsed.status, "needs_user");
    assert.match(parsed.askUser.options[0].description, /40\.0%/);
    assert.equal(parsed.advisoryOnly, true);
  }
  assert.equal(http.mock.callCount(), 1);
  assert.equal(updates.mock.callCount(), 1);
  assert.deepEqual(updates.mock.calls[0]!.arguments[0].details, { phase: "deciding" });
});

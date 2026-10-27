import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { requestJev } from "../src/effects.ts";
import { JEV_MODEL } from "../src/machine.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { automaticDelegate, automaticIO, prepareAutomatic } from "../src/automatic-effects.ts";
import { validOrdinaryPreparedScope } from "../src/ordinary-authorization.ts";
import { resolveJevConnection } from "../src/jev-config.ts";
import type { AutomaticDelegateInput } from "../src/automatic-input.ts";
import type { FullAccessLease } from "../src/delegation-access-effects.ts";
import type { OrdinaryPublicResult } from "../src/ordinary-effects.ts";

function executionResult(approved: boolean): OrdinaryPublicResult {
  return { kind: "ordinary_scope", status: approved ? "completed_unverified" : "stopped", taskAcceptance: "needs_human_review", workersStarted: approved ? 1 : 0,
    modelCalls: approved ? 1 : 0, reservedModelCalls: 0, jevRequests: 0, reservedJevRequests: 0, jevReports: [], skillSuggestions: [], cleanupConfirmed: true, lockRetained: false,
    reason: approved ? "completed" : "declined", diagnostic: null, costEstimate: { observedUsd: 0, delegationTotalUsd: 0 }, reports: [] };
}

const input: AutomaticDelegateInput = { task: "Repair the approved current parser.", files: [{ path: "parser.ts", access: "read_write" }], constraints: ["Preserve the interface."], observations: ["The current empty-token test fails."], seconds: 60, maxModelCalls: 3 };
function fixture() {
  let reviews = 0, requests = 0, workers = 0, sourcePacket = "", workerPacket = "";
  const connection = resolveJevConnection({ JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:1", OPENJEV_MODEL: "openjev-0.1" });
  assert.equal(connection.ok, true); if (!connection.ok) throw Error("Invalid fixture");
  const prepared: Awaited<ReturnType<typeof prepareAutomatic>> = {
    role: { name: "worker", description: "Repair the approved existing source.", systemPrompt: "Use the approved file IDs only.", tools: ["read", "edit"], file: "/synthetic/agent/agents/worker.md" },
    files: { id: "scope", root: "/synthetic/project", rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "parser.ts", access: "read_write", version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 3 } }] },
    context: [], agentDirectory: "/synthetic/agent", target: "Explicit local fixture", connection: connection.connection,
    routing: { goal: input.task, constraints: input.constraints!, sources: [{ path: "parser.ts", content: 'const literal = "한글";' }], observations: input.observations! },
    choices: ["off", "high"].map((thinking, i) => ({ id: `model_${i}`, model: { provider: `vendor-${i}`, id: `actual-available-${i}` }, thinking: thinking as "off" | "high", api: "openai-responses", endpoint: "http://127.0.0.1:2/v1", contextWindow: 32768 })),
  };
  const ctx = { cwd: prepared.files.root, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "automatic-session" }, ui: { confirm: async () => true } } as unknown as ExtensionContext;
  const io: typeof automaticIO = { ...automaticIO, prepare: async () => structuredClone(prepared), fresh: async () => {},
    confirm: async (_ctx, _title, packet, _deadline, _signal, _purpose, _observer, reviewText) => {
      reviews++; sourcePacket = packet;
      const original = JSON.parse(packet), projection = JSON.parse(reviewText!);
      const plan = original.exactRoutingPlan;
      assert.equal(plan.maxJevRequests, 2); assert.equal(plan.maxCriteriaPerQuestion, 255);
      assert.match(plan.weakRecommendationPolicy, /explicit human review/); assert.match(plan.weakRecommendationPolicy, /even in Full Access/);
      assert.equal(projection.weakRecommendationPolicy, plan.weakRecommendationPolicy);
      assert.deepEqual(projection.routingState, plan.modelRequest.state);
      assert.deepEqual(projection.role, original.role); assert.equal(projection.target, original.target);
      assert.equal(projection.modelQuestion.type, plan.modelRequest.questions.model.type);
      assert.equal(projection.modelQuestion.instructions, plan.modelRequest.questions.model.instructions);
      assert.equal(projection.thinkingQuestion.instructions, plan.thinkingRequestTemplate.instructions);
      const restored = Object.fromEntries(projection.candidateModels.flatMap((group: { metadata: object; choices: { id: string; thinking: string }[] }) =>
        group.choices.map(choice => [choice.id, { ...group.metadata, thinking: choice.thinking }])));
      const restoredModels = Object.fromEntries(projection.candidateModels.map((group: { id: string; metadata: object; choices: { thinking: string }[] }) =>
        [group.id, { ...group.metadata, supportedThinking: group.choices.map(choice => choice.thinking) }]));
      assert.deepEqual(restoredModels, Object.fromEntries(Object.entries(plan.modelRequest.questions.model.criteria).map(([id, text]) => [id, JSON.parse(text as string)])));
      assert.ok(Object.keys(restoredModels).length <= 255);
      for (const model of plan.thinkingByModel) assert.ok(Object.keys(model.criteria).length <= 7);
      const originalChoices = Object.assign({}, ...plan.thinkingByModel.map((model: { criteria: object }) => model.criteria));
      assert.deepEqual(restored, Object.fromEntries(Object.entries(originalChoices).map(([id, text]) => [id, JSON.parse(text as string)])));
      return true;
    },
    request: async (state, questions, _signal, attempted) => {
      requests++; attempted?.(); assert.equal(reviews, 1); assert.equal(workers, 0);
      const plan = JSON.parse(sourcePacket).exactRoutingPlan;
      if (questions.model) assert.deepEqual(plan.modelRequest, { state, questions });
      else {
        const branch = plan.thinkingByModel.find((model: { selectedModel: unknown }) => JSON.stringify(model.selectedModel) === JSON.stringify((state as { selectedModel: unknown }).selectedModel));
        assert.deepEqual(state, { ...plan.modelRequest.state, selectedModel: branch.selectedModel });
        assert.deepEqual(questions, { thinking: { type: "choice", instructions: plan.thinkingRequestTemplate.instructions, criteria: branch.criteria } });
      }
      const question = (questions.model ?? questions.thinking) as { type: string; instructions: string; criteria: object };
      assert.equal(question.type, "choice"); assert.equal(typeof question.instructions, "string"); assert.ok(Object.keys(question.criteria).length <= 255);
      assert.ok(JSON.stringify(state).includes("한글")); assert.ok(JSON.stringify(state).includes(input.observations![0]!));
      return { type: "response", body: { model: "openjev-0.1", provider: "openjev", usage: { input_tokens: 10, output_tokens: 1 }, answers: questions.model ? { model: { type: "choice", choice: "available_model_1", confidence: 1 } } : { thinking: { type: "choice", choice: "model_1", confidence: 1 } } } };
    },
    execute: async (_input, _ctx, _signal, _progress, executionIO, _observe, _plan, _memory, access) => {
      const selected = await executionIO!.prepare(_input, _ctx, _signal!);
      assert.equal(validOrdinaryPreparedScope(selected.scope), true); workerPacket = JSON.stringify(selected.scope);
      assert.deepEqual(selected.scope.agents[0]!.model, prepared.choices[1]!.model); assert.equal(selected.scope.agents[0]!.thinking, "high");
      const approved = access ? true : await executionIO!.confirm(_ctx, "Synthetic selected worker review", workerPacket, null, _signal!, "approval", undefined, "ORIGINAL COMPLETE WORKER REVIEW");
      if (approved) workers++;
      return executionResult(approved);
    },
  };
  return { ctx, io, prepared, counts: () => ({ reviews, requests, workers, sourcePacket, workerPacket }) };
}

test("automatic task context and all available combinations are reviewed before routing the actual scoped worker model", async () => {
  const f = fixture(), result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(result.jevRequests, 1);
  assert.deepEqual(result.automaticSelection, { model: f.prepared.choices[1]!.model, thinking: "high", source: "jev" });
  assert.ok(f.counts().sourcePacket.includes("current-task code/state")); assert.ok(f.counts().sourcePacket.includes("한글"));
  assert.ok(f.counts().workerPacket.includes("actual-available-1")); assert.equal(f.counts().workers, 1);
});

test("automatic route uses the real SystemOne HTTP choice envelope through an isolated loopback fixture", async t => {
  const f = fixture(), nativeFetch = globalThis.fetch;
  f.prepared.choices = [...f.prepared.choices, { ...f.prepared.choices[1]!, id: "model_2", thinking: "medium" }];
  const saved = { JEV_BACKEND: process.env.JEV_BACKEND, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
  process.env.JEV_BACKEND = "typesafe"; process.env.TYPESAFE_API_KEY = "offline-choice-protocol-key";
  t.after(() => { for (const key of ["JEV_BACKEND", "TYPESAFE_API_KEY"] as const) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const cfg = resolveJevConnection(process.env); assert.equal(cfg.ok, true); if (!cfg.ok) return;
  f.prepared.connection = cfg.connection;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      const packet = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const name = packet.questions.model ? "model" : "thinking", question = packet.questions[name];
      assert.equal(question.type, "choice"); assert.equal(typeof question.instructions, "string"); assert.ok(Object.keys(question.criteria).length <= 255);
      assert.equal(packet.state.context.sources[0].content, f.prepared.routing.sources[0]!.content);
      if (name === "thinking") { assert.deepEqual(packet.state.selectedModel, f.prepared.choices[1]!.model); assert.deepEqual(Object.keys(question.criteria), ["model_1", "model_2"]); }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ model: JEV_MODEL, usage: { input_tokens: 10, output_tokens: 1 },
        answers: { [name]: { type: "choice", choice: name === "model" ? "available_model_1" : "model_1", confidence: 1 } } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const http = t.mock.method(globalThis, "fetch", async (...[url, options]: Parameters<typeof fetch>) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone"); return nativeFetch(`http://127.0.0.1:${address.port}/choice`, options);
  });
  f.io.request = requestJev;
  const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(http.mock.callCount(), 2); assert.equal(f.counts().workers, 1);
  assert.equal(result.jevRequests, 2); assert.equal(result.jevReports.length, 2); assert.equal(result.reservedJevRequests, 0);
});

test("declining source or selected-worker review starts no worker; weak advice cannot execute without the latter", async () => {
  const denied = fixture(); denied.io.confirm = async () => false;
  assert.equal((await automaticDelegate(input, denied.ctx, undefined, undefined, undefined, undefined, undefined, denied.io)).status, "stopped");
  assert.equal(denied.counts().requests, 0); assert.equal(denied.counts().workers, 0);
  const weak = fixture(); weak.ctx.ui.confirm = async () => false; weak.io.request = async (_state, _questions, _signal, attempted) => { attempted?.(); return { type: "response", body: { model: "openjev-0.1", provider: "openjev", usage: { input_tokens: 10, output_tokens: 1 }, answers: { model: { type: "choice", choice: "available_model_1", confidence: 0.49 } } } }; };
  const recommendation = await automaticDelegate(input, weak.ctx, undefined, undefined, undefined, undefined, undefined, weak.io);
  assert.equal(recommendation.status, "stopped");
  assert.equal(recommendation.reason, "declined");
  assert.deepEqual(recommendation.automaticRecommendations, [{ stage: "model", model: weak.prepared.choices[1]!.model, support: 0.49, executionAuthorized: false }]);
  assert.equal(weak.counts().workers, 0);
});

test("source/session freshness changes after review or routing never dispatch a replacement worker", async () => {
  for (const afterRouting of [false, true]) {
    const f = fixture(); let checks = 0;
    f.io.fresh = async () => { checks++; if (afterRouting ? checks >= 4 : checks >= 2) throw Error("Fixed source change"); };
    const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(f.counts().workers, 0);
    assert.equal(f.counts().requests, afterRouting ? 1 : 0);
  }
  const f = fixture(); f.io.confirm = async () => { f.ctx.sessionManager.getSessionId = () => "changed-session"; return true; };
  assert.equal((await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io)).status, "stopped");
  assert.equal(f.counts().requests, 0); assert.equal(f.counts().workers, 0);
});

test("caller input mutation during review cannot replace the reviewed task or extend its worker duration", async () => {
  const f = fixture(), request = structuredClone(input), confirm = f.io.confirm, execute = f.io.execute;
  f.io.confirm = async (...args) => { request.task = "UNREVIEWED_REPLACEMENT_TASK"; request.seconds = 86400; return confirm(...args); };
  f.io.execute = async (...args) => { assert.equal(args[0].task, input.task); assert.equal(args[0].limits.seconds, 60); return execute(...args); };
  assert.equal((await automaticDelegate(request, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io)).status, "completed_unverified");
});

test("declined weak-thinking review or cancellation after model choice never starts a worker or repeats selection", async () => {
  for (const mode of ["weak", "cancel"] as const) {
    const f = fixture(), original = f.io.request, controller = new AbortController();
    f.prepared.choices = [...f.prepared.choices, { ...f.prepared.choices[1]!, id: "model_2", thinking: "medium" }];
    if (mode === "weak") f.ctx.ui.confirm = async () => false;
    let calls = 0;
    f.io.request = async (...args) => {
      calls++; const response = await original(...args);
      if (mode === "cancel" && args[1].model) controller.abort();
      if (mode === "weak" && args[1].thinking && response.type === "response") {
        const body = response.body as { answers: { thinking: { confidence: number } } }; body.answers.thinking.confidence = 0.49;
      }
      return response;
    };
    const result = await automaticDelegate(input, f.ctx, controller.signal, undefined, undefined, undefined, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(result.reason, mode === "weak" ? "declined" : "cancelled");
    assert.equal(calls, mode === "weak" ? 2 : 1); assert.equal(result.jevRequests, calls); assert.equal(result.jevReports.length, calls);
    assert.equal(result.reservedJevRequests, 0); assert.equal(f.counts().workers, 0);
  }
});

test("weak model/thinking advice forces a genuine complete worker review even when a Full Access lease is supplied", async () => {
  for (const weak of ["model", "thinking", "both"] as const) for (const approve of [false, true]) {
    const f = fixture(), request = f.io.request, execute = f.io.execute;
    f.prepared.choices = [...f.prepared.choices, { ...f.prepared.choices[1]!, id: "model_2", thinking: "medium" }];
    let humanReviews = 0, fullAuthorizations = 0;
    const lease = { authorize() { fullAuthorizations++; throw Error("A weak recommendation must not use Full Access authorization."); } } as unknown as FullAccessLease;
    f.ctx.ui.confirm = async (title, view) => {
      humanReviews++; assert.match(title, /operator review required/); assert.match(view, /explicit human worker approval required/);
      assert.match(view, /ORIGINAL COMPLETE WORKER REVIEW/); assert.match(view, /executionAuthorized/);
      if (weak !== "thinking") assert.match(view, /0.31/); if (weak !== "model") assert.match(view, /0.42/);
      return approve;
    };
    f.io.request = async (...args) => {
      const response = await request(...args);
      if (response.type === "response") {
        const body = response.body as { answers: { model?: { confidence: number }; thinking?: { confidence: number } } };
        if (body.answers.model && weak !== "thinking") body.answers.model.confidence = 0.31;
        if (body.answers.thinking && weak !== "model") body.answers.thinking.confidence = 0.42;
      }
      return response;
    };
    f.io.execute = async (...args) => {
      assert.equal(args[8], undefined); const selected = await args[4]!.prepare(args[0], args[1], args[2]!);
      const originalPacket = JSON.stringify(selected.scope), confirm = args[4]!.confirm;
      args[4] = { ...args[4]!, confirm: async (...review) => { assert.equal(review[2], originalPacket); return confirm(...review); } };
      return execute(...args);
    };
    const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, lease, f.io);
    assert.equal(humanReviews, 1); assert.equal(fullAuthorizations, 0); assert.equal(f.counts().workers, approve ? 1 : 0);
    assert.equal(result.status, approve ? "completed_unverified" : "stopped");
    assert.equal(result.automaticRecommendations?.length, weak === "both" ? 2 : 1);
    assert.ok(result.automaticRecommendations?.every(advice => advice.executionAuthorized === false && advice.support < 0.5));
  }
});

test("worker review cancellation defeats a late positive reply for weak advice even with Full Access", async () => {
  const f = fixture(), request = f.io.request, controller = new AbortController();
  const lease = { authorize() { assert.fail("Weak advice cannot use Full Access authorization."); } } as unknown as FullAccessLease;
  f.io.request = async (...args) => {
    const result = await request(...args);
    if (result.type === "response") (result.body as { answers: { model: { confidence: number } } }).answers.model.confidence = 0.31;
    return result;
  };
  f.ctx.ui.confirm = async () => { controller.abort(); return true; };
  const result = await automaticDelegate(input, f.ctx, controller.signal, undefined, undefined, undefined, lease, f.io);
  assert.equal(result.status, "stopped"); assert.equal(f.counts().workers, 0);
  assert.equal(result.automaticRecommendations?.[0]?.support, 0.31);
});

test("strong recommendations preserve the existing Full Access authorization path", async () => {
  const f = fixture(), execute = f.io.execute, lease = {} as FullAccessLease;
  f.ctx.ui.confirm = async () => assert.fail("The automatic adapter must not add an extra strong-worker review.");
  f.io.execute = async (...args) => { assert.equal(args[8], lease); return execute(...args); };
  assert.equal((await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, lease, f.io)).status, "completed_unverified");
});

test("failed dependent thinking keeps the first usage receipt and blocks workers without reselecting a model", async () => {
  const f = fixture(), original = f.io.request;
  f.prepared.choices = [...f.prepared.choices, { ...f.prepared.choices[1]!, id: "model_2", thinking: "medium" }];
  let attempts = 0;
  f.io.request = async (...args) => {
    attempts++;
    if (args[1].thinking) { args[3]?.(); args[5]?.({ category: "http", httpStatus: 422 }); return { type: "failed", error: "Fixed fixture rejection." }; }
    return original(...args);
  };
  const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
  assert.equal(attempts, 2); assert.equal(result.status, "stopped"); assert.equal(f.counts().workers, 0);
  assert.equal(result.jevRequests, 2); assert.equal(result.jevReports.length, 1); assert.equal(result.reservedJevRequests, 1);
  assert.equal(result.cleanupConfirmed, false); assert.equal(result.costEstimate.delegationTotalUsd, null);
});

test("automatic routing retains sanitized transport failure and unknown billing without a replacement model", async () => {
  const f = fixture(); f.io.request = async (_state, _questions, _signal, attempted, _connection, observeFailure) => {
    attempted?.(); observeFailure?.({ category: "http", httpStatus: 413 });
    return { type: "failed", error: "Safe fixture failure; raw provider body withheld." };
  };
  const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
  assert.equal(result.status, "stopped"); assert.equal(f.counts().workers, 0); assert.equal(result.jevRequests, 1); assert.equal(result.reservedJevRequests, 1);
  assert.equal(result.costEstimate.delegationTotalUsd, null); assert.equal(result.cleanupConfirmed, false);
  assert.deepEqual(result.diagnostic, { phase: "routing_models", routingFailure: { category: "http", httpStatus: 413 } });
});

test("invalid automatic choices preserve their validation category and usage without another request or worker", async () => {
  const cases = [
    [{ type: "choice", choice: "outside", confidence: 0.8 }, "choice_fields"],
    [{ type: "choice", choice: "available_model_1", confidence: 0.8, probabilities: { available_model_1: 1 } }, "distribution_fields"],
    [{ type: "choice", choice: "available_model_1", confidence: 0.8, probabilities: { available_model_0: 0.1, available_model_1: 0.8 } }, "distribution_total"],
    [{ type: "choice", choice: "available_model_1", confidence: 0.2, probabilities: { available_model_0: 0.8, available_model_1: 0.2 } }, "choice_not_maximum"],
  ] as const;
  for (const [answer, choiceFailure] of cases) {
    const f = fixture(); let attempts = 0;
    f.io.request = async (_state, _questions, _signal, attempted) => {
      attempts++; attempted?.();
      return { type: "response", body: { model: JEV_MODEL, usage: { input_tokens: 10, output_tokens: 1 }, answers: { model: answer }, privateData: "PRIVATE_RESPONSE" } };
    };
    const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
    assert.equal(result.status, "stopped"); assert.equal(attempts, 1); assert.equal(f.counts().workers, 0);
    assert.equal(result.jevRequests, 1); assert.equal(result.jevReports.length, 1); assert.equal(result.reservedJevRequests, 0);
    assert.equal(result.cleanupConfirmed, true); assert.equal(result.costEstimate.delegationTotalUsd, 10 * 0.042 / 1_000_000);
    assert.deepEqual(result.diagnostic, { phase: "routing_models", routingFailure: { category: "invalid_response", choiceFailure,
      ...(choiceFailure === "distribution_total" ? { probabilityTotal: 0.9, probabilityTolerance: 1e-6, candidateCount: 2 } : {}) } });
    assert.equal(JSON.stringify(result).includes("PRIVATE_RESPONSE"), false);
  }
});

test("invalid thinking probabilities retain both usage receipts without reselecting a model", async () => {
  const f = fixture(), request = f.io.request; let attempts = 0;
  f.prepared.choices = [...f.prepared.choices, { ...f.prepared.choices[1]!, id: "model_2", thinking: "medium" }];
  f.io.request = async (...args) => {
    attempts++;
    if (args[1].model) return request(...args);
    args[3]?.();
    return { type: "response", body: { model: JEV_MODEL, usage: { input_tokens: 10, output_tokens: 1 }, answers: { thinking: {
      type: "choice", choice: "model_1", confidence: 0.8, probabilities: { model_1: 0.8, model_2: 0.1 },
    } } } };
  };
  const result = await automaticDelegate(input, f.ctx, undefined, undefined, undefined, undefined, undefined, f.io);
  assert.equal(attempts, 2); assert.equal(result.status, "stopped"); assert.equal(f.counts().workers, 0);
  assert.equal(result.jevReports.length, 2); assert.equal(result.reservedJevRequests, 0); assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.diagnostic, { phase: "routing_thinking", routingFailure: { category: "invalid_response", choiceFailure: "distribution_total",
    probabilityTotal: 0.9, probabilityTolerance: 1e-6, candidateCount: 2 } });
});

test("unsettled router usage blocks completion and unexpected worker settlement is never reported as zero started work", async () => {
  const unknown = fixture(); unknown.io.request = async (_state, _questions, _signal, attempted) => { attempted?.(); return { type: "failed", error: "Fixed fixture failure" }; };
  const failed = await automaticDelegate(input, unknown.ctx, undefined, undefined, undefined, undefined, undefined, unknown.io);
  assert.equal(failed.status, "stopped"); assert.equal(failed.cleanupConfirmed, false); assert.equal(failed.reservedJevRequests, 1); assert.equal(unknown.counts().workers, 0);
  const worker = fixture(); worker.io.execute = async () => { throw Error("PRIVATE_WORKER_EXCEPTION"); };
  await assert.rejects(automaticDelegate(input, worker.ctx, undefined, undefined, undefined, undefined, undefined, worker.io), /settlement is unknown/);
});

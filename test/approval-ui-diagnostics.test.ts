import assert from "node:assert/strict";
import cp from "node:child_process";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { startApprovalUi, reduceApprovalUi, approvalUiText, type ApprovalUiDiagnostic, type ApprovalUiObserver } from "../src/approval-ui-diagnostics.ts";
import { approvalUiDiagnostics } from "../src/approval-ui-diagnostics-effects.ts";
import { confirmNativeTaskReview, registerNativeTaskReview } from "../src/native-task-review.ts";
import { confirmContextPacket } from "../src/context-approval.ts";
import { taskReviewContent } from "../src/task-review-machine.ts";
import { delegateResultView } from "../src/delegate-presentation.ts";
import { ordinaryDelegate, ordinaryIO } from "../src/ordinary-effects.ts";
import { validOrdinaryPreparedScope, type OrdinaryScopeInput, type OrdinaryPreparedScope } from "../src/ordinary-authorization.ts";
import { registerJevTools } from "../src/index.ts";
const privateText = "PRIVATE_SYNTHETIC_TASK_PROFILE_PATH_PACKET_ERROR";
const content = taskReviewContent({ task: "Read only the synthetic approved file.", cwd: "/synthetic", maxModelCalls: 1,
  model: { provider: "fixture", id: "fixture" }, agent: { name: "scout", description: "Read only.", tools: ["read"],
    systemPrompt: `Never execute tools. ${privateText}`, file: "/synthetic/scout.md", model: { provider: "fixture", id: "fixture" } } });
function context(): ExtensionContext {
  return { mode: "print", cwd: "/synthetic", hasUI: true, sessionManager: { getSessionId: () => "PRIVATE_SESSION_ID" },
    get modelRegistry(): never { throw new Error("No model or auth access"); }, get model(): never { throw new Error("No model access"); },
    ui: { select: async (_title: string, options: string[]) => options[0], confirm: async () => true,
      custom: async () => { throw new Error("No custom fallback"); } } } as unknown as ExtensionContext;
}
function collected() { const values: ApprovalUiDiagnostic[] = []; const observer: ApprovalUiObserver = value => { values.push(value); }; return { values, observer }; }
function assertPrivateFree(values: readonly ApprovalUiDiagnostic[]) {
  assert.doesNotMatch(JSON.stringify(values), /PRIVATE|synthetic|scout|fixture|systemPrompt|packet"\s*:/);
  for (const value of values) { assert.equal(value.executionAuthorized, false); assert.ok(Object.isFrozen(value)); }
}
test("approval diagnostic reducer is deterministic, immutable, single-use and never a grant", () => {
  const start = startApprovalUi(100, 60100, "print"), before = structuredClone(start);
  assert.strictEqual(reduceApprovalUi(start, { type: "reply", now: 101, status: "positive_reply" }), start);
  const requested = reduceApprovalUi(start, { type: "request", now: 101, step: "menu", api: "select" });
  const reply = reduceApprovalUi(requested, { type: "reply", now: 102, status: "positive_reply" });
  assert.strictEqual(reduceApprovalUi(reply, { type: "reply", now: 103, status: "positive_reply" }), reply);
  const done = reduceApprovalUi(reply, { type: "finish", now: 60100, status: "positive_reply" });
  assert.equal(done.diagnostic.status, "expired"); assert.equal(done.diagnostic.elapsedMs, 60000); assert.equal(done.diagnostic.remainingMs, 0);
  assert.equal(done.diagnostic.executionAuthorized, false); assert.strictEqual(reduceApprovalUi(done, { type: "finish", now: 60101, status: "positive_reply" }), done);
  assert.deepEqual(start, before); assert.equal(startApprovalUi(100, NaN, privateText).diagnostic.mode, "unknown");
  assert.strictEqual(reduceApprovalUi(start, { type: "request", now: NaN, step: "menu", api: "select" }), start);
});
test("diagnostic projection ignores private getters, prototypes, object coercion, bad counts and surplus raw fields", () => {
  const valid = startApprovalUi(100, 60100, "print").diagnostic;
  const text = approvalUiText({ ...valid, raw: privateText }); assert.ok(text); assert.ok(!text.includes(privateText));
  assert.equal(approvalUiText(Object.create(valid)), undefined);
  for (const key of ["step", "status", "mode", "api", "phase", "requests", "executionAuthorized"]) {
    const value = { ...valid }; Object.defineProperty(value, key, { get(): never { throw new Error("Never invoke private getter"); } });
    assert.equal(approvalUiText(value), undefined);
  }
  assert.equal(approvalUiText({ ...valid, api: { toString(): never { throw new Error("Never coerce a private object"); } } }), undefined);
  for (const [key, value] of [["status", privateText], ["step", "constructor"], ["mode", privateText], ["remainingMs", Infinity], ["replies", 1], ["executionAuthorized", true]])
    assert.equal(approvalUiText({ ...valid, [key as string]: value }), undefined);
});
test("effect observations are finite; synchronous and rejected observers cannot change an approval decision or retry", async () => {
  for (const observer of [(() => { throw new Error(privateText); }), (() => Promise.reject(new Error(privateText)))]) {
    assert.equal(await confirmNativeTaskReview(content, context(), undefined, observer), true);
    assert.equal(await confirmContextPacket(context(), "Synthetic", privateText, Date.now() + 60000, new AbortController().signal, "approval", observer), true);
  }
  const capture = collected(), diagnostic = approvalUiDiagnostics(Date.now() + 60000, "print", capture.observer);
  diagnostic.request("menu", "select"); diagnostic.finish("cancelled"); const count = capture.values.length;
  diagnostic.reply("positive_reply"); diagnostic.finish("positive_reply"); assert.equal(capture.values.length, count); assertPrivateFree(capture.values);
});
test("single native execution review reports one packet request without raw packets, HTTP, workers or changed source", async t => {
  const ctx = context(), capture = collected(), exact = content.sections.map(section => section.text);
  const confirm = t.mock.method(ctx.ui, "confirm", async (_title: string, message: string) => {
    if (message.includes(privateText)) for (const source of exact) assert.ok(message.includes(source)); return true;
  });
  const select = t.mock.method(ctx.ui, "select", async (_title: string, options: string[]) => options[0]);
  const http = t.mock.method(globalThis, "fetch", async () => assert.fail("No HTTP")), fork = t.mock.method(cp, "fork", () => assert.fail("No worker"));
  const before = structuredClone(content); assert.equal(await confirmNativeTaskReview(content, ctx, t.signal, capture.observer), true);
  const requests = capture.values.filter(value => value.phase === "requesting");
  assert.deepEqual(requests.map(value => [value.step, value.api]), [["packet", "confirm"]]);
  assert.equal(capture.values.at(-1)?.requests, 1); assert.equal(capture.values.at(-1)?.replies, 1); assert.equal(capture.values.at(-1)?.status, "positive_reply");
  assert.equal(confirm.mock.callCount(), 1); assert.equal(select.mock.callCount(), 0); assert.equal(http.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0);
  assertPrivateFree(capture.values); assert.deepEqual(content, before);
});
test("complete native execution approval waits indefinitely for its actual reply", async t => {
  for (const mode of ["print", "rpc"] as const) await t.test(mode, async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-12T00:00:00Z") });
    const ctx = context(), capture = collected(); ctx.mode = mode;
    let late: () => void = () => {}, confirms = 0;
    ctx.ui.select = async () => assert.fail("No menu");
    ctx.ui.confirm = async (_title, _text, options) => {
      confirms++; assert.equal(options?.timeout, undefined);
      return await new Promise<boolean>(resolve => { late = () => resolve(true); });
    };
    let settled = false;
    const work = confirmNativeTaskReview(content, ctx, t.signal, capture.observer).then(value => { settled = true; return value; });
    assert.equal(capture.values.at(-1)?.step, "packet"); assert.equal(capture.values.at(-1)?.remainingMs, null);
    t.mock.timers.tick(86_400_000); await Promise.resolve(); assert.equal(settled, false);
    late(); assert.equal(await work, true);
    const value = capture.values.at(-1)!; assert.equal(value.status, "positive_reply"); assert.equal(value.elapsedMs, 86_400_000); assert.equal(value.remainingMs, null);
    assert.match(approvalUiText(value)!, /no response deadline/);
    assert.equal(confirms, 1); assertPrivateFree(capture.values);
  });
});
test("negative and malformed native responses are not claimed to be explicit human declines", async t => {
  for (const malformed of [false, true]) {
    const ctx = context(), capture = collected();
    ctx.ui.confirm = async () => (malformed ? privateText : false) as boolean;
    assert.equal(await confirmNativeTaskReview(content, ctx, t.signal, capture.observer), false);
    assert.equal(capture.values.at(-1)?.status, malformed ? "invalid_reply" : "non_positive_reply");
    assertPrivateFree(capture.values);
  }
});
test("native API throws/rejects report only fixed errors, never an alternate UI or raw cause", async t => {
  for (const synchronous of [false, true]) {
    const ctx = context(), capture = collected(); t.mock.method(ctx.ui, "confirm", () => {
      if (synchronous) throw new Error(privateText); return Promise.reject(new Error(privateText));
    });
    const custom = t.mock.method(ctx.ui, "custom", async () => assert.fail("No fallback"));
    assert.equal(await confirmNativeTaskReview(content, ctx, t.signal, capture.observer), false);
    assert.equal(capture.values.at(-1)?.status, "api_error"); assert.equal(custom.mock.callCount(), 0); assertPrivateFree(capture.values);
  }
});
test("owner rejects missing session identities, overlap and every lifecycle boundary without another native request", async t => {
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) {
    const hooks = new Map<string, () => void>(), owner = registerNativeTaskReview({ on(name: string, fn: () => void) { hooks.set(name, fn); } } as unknown as ExtensionAPI);
    const ctx = context(), capture = collected(); let calls = 0;
    ctx.ui.confirm = async () => { calls++; return await new Promise(() => {}); };
    const work = owner.confirm(content, ctx, t.signal, capture.observer);
    const busy = collected(); assert.equal(await owner.confirm(content, ctx, t.signal, busy.observer), false); assert.equal(busy.values.at(-1)?.status, "busy");
    hooks.get(event)!(); assert.equal(await work, false); assert.equal(capture.values.at(-1)?.status, "cancelled"); assert.equal(calls, 1);
  }
  const owner = registerNativeTaskReview({ on() {} } as unknown as ExtensionAPI), ctx = context(), capture = collected();
  Object.assign(ctx.sessionManager, { getSessionId: () => "" }); assert.equal(await owner.confirm(content, ctx, t.signal, capture.observer), false);
  assert.equal(capture.values.at(-1)?.requests, 0); assert.equal(capture.values.at(-1)?.status, "unsupported");
});
test("owner session switch or uncertainty rejects an otherwise positive synthetic review", async t => {
  for (const throws of [false, true]) {
    const owner = registerNativeTaskReview({ on() {} } as unknown as ExtensionAPI), ctx = context(), capture = collected(); let reads = 0;
    Object.assign(ctx.sessionManager, { getSessionId: () => { if (++reads === 1) return "PRIVATE_SESSION_ID"; if (throws) throw new Error(privateText); return "PRIVATE_CHANGED_SESSION"; } });
    assert.equal(await owner.confirm(content, ctx, t.signal, capture.observer), false);
    assert.equal(capture.values.at(-1)?.status, "session_changed"); assertPrivateFree(capture.values);
  }
});
test("scope packet observer distinguishes failure, malformed reply and session change without changing the exact packet", async t => {
  for (const kind of ["false", "malformed", "error", "session"] as const) {
    const ctx = context(), capture = collected();
    ctx.ui.confirm = async (_title, packet) => {
      assert.equal(packet, privateText); if (kind === "session") Object.assign(ctx.sessionManager, { getSessionId: () => "PRIVATE_CHANGED_SESSION" });
      if (kind === "error") throw new Error(privateText); return (kind === "false" ? false : kind === "malformed" ? "true" : true) as boolean;
    };
    assert.equal(await confirmContextPacket(ctx, "Synthetic", privateText, Date.now() + 60000, t.signal, "approval", capture.observer), false);
    assert.equal(capture.values.at(-1)?.status, kind === "false" ? "non_positive_reply" : kind === "malformed" ? "invalid_reply" : kind === "error" ? "api_error" : "session_changed");
    assertPrivateFree(capture.values);
  }
});
test("scope packet own deadline and lifecycle cancellation are distinct, bounded and consumed once", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-10-12T00:00:00Z") });
  for (const timedOut of [false, true]) {
    const ctx = context(), capture = collected(), controller = new AbortController(); let late: (value: boolean) => void = () => {};
    ctx.ui.confirm = async () => await new Promise(resolve => { late = resolve; });
    const work = confirmContextPacket(ctx, "Synthetic", privateText, Date.now() + 60000, controller.signal, "approval", capture.observer);
    if (timedOut) t.mock.timers.tick(60000); else controller.abort();
    assert.equal(await work, false); assert.equal(capture.values.at(-1)?.status, timedOut ? "expired" : "cancelled");
    const count = capture.values.length; late(true); await Promise.resolve(); assert.equal(capture.values.length, count); assertPrivateFree(capture.values);
  }
});
const input: OrdinaryScopeInput = { task: "Read the exact existing synthetic file.", agents: ["scout"], files: [{ path: "fixture.txt", access: "read" }],
  tasks: [{ id: "read", summary: "Read only file-1 and report one observation.", agent: "scout" }], selection: "parent_only",
  limits: { workerRuns: 1, modelCalls: 1, perWorkerCalls: 1, seconds: 30 } };
function prepared(): Awaited<ReturnType<typeof ordinaryIO.prepare>> {
  const scope: OrdinaryPreparedScope = { id: "private_scope", sessionId: "PRIVATE_SESSION_ID", input, approvalDeadline: null,
    contextDigest: "a".repeat(64), routingTarget: null, fileProtocol: "scoped_existing_files",
    workerTargets: [{ agent: "scout", api: "openai-completions", endpoint: "http://127.0.0.1:1/v1" }], agents: [{ name: "scout", tools: ["read"], description: "Read only.",
      file: "/synthetic/scout.md", systemPrompt: `Read only approved file IDs. ${privateText}`, model: { provider: "fixture", id: "fixture" } }],
    files: { id: "private_files", root: "/synthetic", rootIdentity: { dev: 1, ino: 2 }, files: [{ id: "file-1", path: "fixture.txt", access: "read",
      version: { identity: { dev: 1, ino: 3 }, stamp: "b".repeat(64), digest: "c".repeat(64), bytes: 1 } }] } };
  assert.equal(validOrdinaryPreparedScope(scope), true, "Fixture must pass the original production schema, not weaken it");
  return { scope, context: [], agentDirectory: "/synthetic/config" };
}
test("ordinary scope propagates native packet diagnostics; denial starts zero owners, workers or routing requests", async t => {
  const ctx = context(), capture = collected(); ctx.ui.confirm = async () => false;
  const io = { ...ordinaryIO, prepare: async () => prepared(), own: async () => assert.fail("No owner"), run: async () => assert.fail("No worker"), select: async () => assert.fail("No JEV") };
  const result = await ordinaryDelegate(input, ctx, t.signal, undefined, io, capture.observer);
  assert.equal(result.status, "stopped"); assert.equal(result.workersStarted, 0); assert.equal(result.modelCalls, 0); assert.equal(result.jevRequests, 0);
  assert.equal(capture.values.at(-1)?.step, "packet"); assert.equal(capture.values.at(-1)?.status, "non_positive_reply"); assertPrivateFree(capture.values);
});
test("ordinary scope missing UI reports preflight without preparation, request or worker", async t => {
  const ctx = context(), capture = collected(); ctx.hasUI = false;
  const io = { ...ordinaryIO, prepare: async () => assert.fail("No preparation"), run: async () => assert.fail("No worker") };
  const result = await ordinaryDelegate(input, ctx, t.signal, undefined, io, capture.observer);
  assert.equal(result.workersStarted, 0); assert.equal(capture.values.at(-1)?.status, "unsupported"); assert.equal(capture.values.at(-1)?.requests, 0);
  assertPrivateFree(capture.values);
});
test("registered production tool publishes safe partial and final packet diagnostics without executing a worker", async t => {
  const tools: ToolDefinition[] = [];
  registerJevTools({ on() {}, registerTool(value: ToolDefinition) { tools.push(value); } } as unknown as ExtensionAPI);
  t.mock.method(ordinaryIO, "prepare", async () => prepared()); const ctx = context(); ctx.ui.confirm = async () => false;
  const worker = t.mock.method(ordinaryIO, "run", async () => assert.fail("No worker"));
  const updates: Parameters<NonNullable<Parameters<ToolDefinition["execute"]>[3]>>[0][] = [];
  const row = tools.find(value => value.name === "jev_delegate")!;
  await assert.rejects(row.execute("synthetic-tool-call", { scope: input }, t.signal, update => { updates.push(update); }, ctx), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes(privateText));
    const result = JSON.parse(error.message.slice(error.message.lastIndexOf("\n") + 1));
    assert.equal(result.approvalUi.status, "non_positive_reply"); assert.equal(result.approvalUi.executionAuthorized, false); return true;
  });
  assert.equal(worker.mock.callCount(), 0);
  const observations = updates.filter(value => (value.details as { kind?: string })?.kind === "approval_ui_diagnostic");
  assert.ok(observations.length > 0); assert.ok(observations.every(value => (value.details as { phase?: string }).phase === undefined));
  assert.ok(updates.some(value => (value.details as { approvalUi?: ApprovalUiDiagnostic })?.approvalUi?.phase === "requesting"));
  assert.ok(updates.some(value => (value.details as { approvalUi?: ApprovalUiDiagnostic })?.approvalUi?.phase === "finished"));
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE|systemPrompt|synthetic|scout/);
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE|systemPrompt/);
});
test("collapsed, expanded, streamed and thrown native rows expose only fixed UI diagnostics and no completion or grant", () => {
  let state = startApprovalUi(100, 60100, "print"); state = reduceApprovalUi(state, { type: "request", now: 101, step: "menu", api: "select" });
  const diag = reduceApprovalUi(state, { type: "finish", now: 60100, status: "expired" }).diagnostic;
  for (const expanded of [false, true]) for (const isPartial of [false, true]) {
    const view = delegateResultView({ details: { phase: "awaiting_approval", status: "cancelled", reason: "declined", approvalUi: { ...diag, raw: privateText } } }, { expanded, isPartial, isError: !isPartial });
    assert.match(view.text, /expired/); assert.doesNotMatch(view.text, /PRIVATE|Execution ended|approval refused|approval complete/);
  }
  const text = `PRIVATE_PREFIX\n${JSON.stringify({ status: "cancelled", reason: "declined", approvalUi: diag })}`;
  assert.match(delegateResultView({ content: [{ type: "text", text }] }, { expanded: true, isPartial: false, isError: true }).text, /expired/);
});

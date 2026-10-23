import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nativeTaskReviewText, taskReviewContent, type TaskReview } from "../src/task-review-machine.ts";
import { nativeReviewChoices, nativeSourcesText, NATIVE_SOURCES, NATIVE_APPROVE, NATIVE_PACKET, reduceNativeReview, type NativeReviewState } from "../src/native-task-review-machine.ts";
import { confirmNativeTaskReview, registerNativeTaskReview } from "../src/native-task-review.ts";
import type { Run } from "../src/delegate-machine.ts";

const run: Run = { task: "Reply exactly SYNTHETIC_OK. Do not use tools.", cwd: "/synthetic",
  agent: { name: "scout", description: "Read only", tools: ["read"], file: "/synthetic/scout.md", systemPrompt: "Read only. No delegation.",
    model: { provider: "fixture", id: "fixture" }, thinking: "low" }, model: { provider: "fixture", id: "fixture" }, maxModelCalls: 1 };
const content = taskReviewContent(run);
const review: TaskReview = { ...content, id: "test-only", deadline: 2000 };
const start = () => reduceNativeReview({ phase: "idle" }, { type: "start", review, now: 1000 }).state;
function readAll(): NativeReviewState {
  let state = start();
  for (const section of content.sections) {
    if (state.phase !== "menu") assert.fail();
    state = reduceNativeReview(state, { type: "choice", id: review.id, value: nativeReviewChoices(state).find(x => x.section === section.id)!.label, now: 1000 }).state;
    state = reduceNativeReview(state, { type: "read", id: review.id, section: section.id, accepted: true, now: 1000 }).state;
  }
  return state;
}
function context(mode = "print"): ExtensionContext {
  return { mode, hasUI: true, sessionManager: { getSessionId: () => "fixture-session" },
    ui: { select: async (_title: string, choices: string[]) => choices[0], confirm: async () => true } } as unknown as ExtensionContext;
}

test("Native workflow requires every exact source acknowledgement and a separate single-use final literal approval", () => {
  const menu = start(); if (menu.phase !== "menu") assert.fail();
  assert.ok(!nativeReviewChoices(menu).some(c => c.label === NATIVE_APPROVE));
  assert.equal(reduceNativeReview(menu, { type: "choice", id: review.id, value: NATIVE_APPROVE, now: 1000 }).state.phase, "cancelled");
  const read = readAll();
  const confirming = reduceNativeReview(read, { type: "choice", id: review.id, value: NATIVE_APPROVE, now: 1000 }).state;
  assert.equal(confirming.phase, "confirming");
  for (const accepted of [false, "true", 1, undefined]) assert.equal(reduceNativeReview(confirming,
    { type: "confirm", id: review.id, accepted, now: 1000 } as Parameters<typeof reduceNativeReview>[1]).state.phase, "cancelled");
  const done = reduceNativeReview(confirming, { type: "confirm", id: review.id, accepted: true, now: 1000 });
  assert.equal(done.state.phase, "approved"); assert.deepEqual(done.effects, [{ type: "resolve", approved: true }]);
  assert.deepEqual(reduceNativeReview(done.state, { type: "confirm", id: review.id, accepted: true, now: 1000 }).effects, []);
});

test("One native source view includes all three exact sections and acknowledges them without executing", () => {
  const state = start(); if (state.phase !== "menu") assert.fail();
  assert.equal(nativeReviewChoices(state)[0]!.label, NATIVE_SOURCES);
  const text = nativeSourcesText(state.review);
  for (const section of content.sections) assert.ok(text.includes(section.text));
  const reading = reduceNativeReview(state, { type: "choice", id: review.id, value: NATIVE_SOURCES, now: 1000 }).state;
  const acknowledged = reduceNativeReview(reading, { type: "read", id: review.id, section: "sources", accepted: true, now: 1000 });
  assert.equal(acknowledged.state.phase, "menu"); if (acknowledged.state.phase !== "menu") assert.fail();
  assert.deepEqual(acknowledged.state.reviewed, ["task", "profile", "snapshot"]);
  assert.deepEqual(acknowledged.effects, [{ type: "menu" }]);
  assert.equal(reduceNativeReview(reading, { type: "read", id: review.id, section: "sources", accepted: false, now: 1000 }).state.phase, "cancelled");
});

test("Native reducer owns the exact source/packet snapshot independently of caller mutations", () => {
  const source = structuredClone(review);
  const started = reduceNativeReview({ phase: "idle" }, { type: "start", review: source, now: 1000 }).state;
  if (started.phase !== "menu") assert.fail();
  (source.sections[0]! as { text: string }).text = "UNAPPROVED";
  (source.summary.tools as string[]).push("bash"); (source as { packet: string }).packet = "UNAPPROVED";
  assert.equal(started.review.packet, review.packet); assert.equal(started.review.sections[0]!.text, content.sections[0]!.text);
  assert.deepEqual(started.review.summary.tools, ["read"]);
});

test("Optional full JSON and repeated source review do not bypass mandatory checks; stale IDs/expiry cannot grant", () => {
  let state = start();
  state = reduceNativeReview(state, { type: "choice", id: review.id, value: NATIVE_PACKET, now: 1000 }).state;
  state = reduceNativeReview(state, { type: "read", id: review.id, section: "packet", accepted: true, now: 1000 }).state;
  assert.equal(state.phase, "menu"); if (state.phase !== "menu") assert.fail(); assert.deepEqual(state.reviewed, []);
  assert.equal(reduceNativeReview(state, { type: "choice", id: "stale", value: NATIVE_APPROVE, now: 1000 }).state, state);
  assert.equal(reduceNativeReview(state, { type: "choice", id: review.id, value: undefined, now: 1000 }).state.phase, "cancelled");
  assert.equal(reduceNativeReview(state, { type: "choice", id: review.id, value: "unknown", now: 1000 }).state.phase, "cancelled");
  assert.equal(reduceNativeReview(state, { type: "choice", id: review.id, value: NATIVE_PACKET, now: 2000 }).state.phase, "cancelled");
  assert.equal(reduceNativeReview(state, { type: "choice", id: review.id, value: NATIVE_PACKET, now: NaN }).state.phase, "cancelled");
});

test("Legacy menu/source/final waits remain unbounded and no source or optional JSON receipt is execution approval", () => {
  let state = reduceNativeReview({ phase: "idle" }, { type: "start", review: { ...review, deadline: null }, now: 1000 }).state;
  for (const section of ["packet", "task", "task", "profile", "snapshot"]) {
    if (state.phase !== "menu") assert.fail();
    const label = nativeReviewChoices(state).find(choice => choice.section === section)!.label;
    state = reduceNativeReview(state, { type: "choice", id: review.id, value: label, now: 86_400_000 }).state;
    for (const accepted of [false, "true", 1]) assert.equal(reduceNativeReview(state,
      { type: "read", id: review.id, section, accepted, now: 172_800_000 } as Parameters<typeof reduceNativeReview>[1]).state.phase, "cancelled");
    const read = reduceNativeReview(state, { type: "read", id: review.id, section, accepted: true, now: 172_800_000 });
    assert.deepEqual(read.effects, [{ type: "menu" }]); state = read.state;
  }
  if (state.phase !== "menu") assert.fail(); assert.deepEqual(state.reviewed, ["task", "profile", "snapshot"]);
  const final = reduceNativeReview(state, { type: "choice", id: review.id, value: NATIVE_APPROVE, now: 259_200_000 });
  assert.equal(final.state.phase, "confirming"); assert.deepEqual(final.effects, [{ type: "confirm" }]);
  const cancelled = reduceNativeReview(final.state, { type: "cancel" });
  assert.deepEqual(reduceNativeReview(cancelled.state, { type: "confirm", id: review.id, accepted: true, now: 345_600_000 }).effects, []);
});

test("Exact execution receipts are packet-bound, single-use and cannot be replaced by legacy source/final events", () => {
  const source = structuredClone(review);
  const started = reduceNativeReview({ phase: "idle" }, { type: "start_execution", review: source, now: 1000 });
  assert.equal(started.state.phase, "reviewing_execution");
  assert.deepEqual(started.effects, [{ type: "review_execution", review }]);
  (source as { packet: string }).packet = "UNAPPROVED";
  (source.sections[0]! as { text: string }).text = "UNAPPROVED";
  assert.deepEqual(started.effects, [{ type: "review_execution", review }]);
  const reply = { type: "execution_reply", id: review.id, packet: review.packet, accepted: true, now: 1000 } as const;
  for (const event of [
    { type: "read", id: review.id, section: "sources", accepted: true, now: 1000 },
    { type: "confirm", id: review.id, accepted: true, now: 1000 },
    { ...reply, id: "stale" },
  ] as Parameters<typeof reduceNativeReview>[1][]) assert.deepEqual(reduceNativeReview(started.state, event), { state: started.state, effects: [] });
  for (const change of [{ packet: "UNAPPROVED" }, { accepted: "true" }, { accepted: false }, { now: NaN }, { now: 2000 }]) {
    const denied = reduceNativeReview(started.state, { ...reply, ...change } as Parameters<typeof reduceNativeReview>[1]);
    assert.deepEqual(denied.effects, [{ type: "resolve", approved: false }]);
    assert.deepEqual(reduceNativeReview(denied.state, reply).effects, []);
  }
  const cancelled = reduceNativeReview(started.state, { type: "cancel" });
  assert.deepEqual(reduceNativeReview(cancelled.state, reply).effects, []);
  const done = reduceNativeReview(started.state, reply);
  assert.deepEqual(done.effects, [{ type: "resolve", approved: true }]);
  assert.deepEqual(reduceNativeReview(done.state, reply).effects, []);
  assert.deepEqual(reduceNativeReview(start(), reply).effects, [], "An execution receipt cannot approve a legacy source menu");
});

test("GUI/RPC opens one complete execution review with every original, not a menu or source-only view", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in UI checks"); });
  const exact = taskReviewContent({ ...run, task: 'Read "two words".\n' + "Exact long task. ".repeat(200),
    seconds: 86_400, maxModelCalls: null, acceptanceCriteria: ["Preserve every literal."],
    verification: { command: "node", args: ["", "two words", "--test", "line\nbreak"], description: "Synthetic fixture coverage." } });
  for (const mode of ["print", "rpc"]) {
    const ctx = context(mode), dialogs: string[] = [];
    ctx.ui.select = async () => assert.fail("No menu");
    ctx.ui.custom = async () => assert.fail("No GUI custom/HTML");
    ctx.ui.confirm = async (title, message, opts) => {
      assert.match(title, /Approve this exact execution/); assert.doesNotMatch(title, /Source review only/);
      dialogs.push(message); assert.equal(message, nativeTaskReviewText(exact));
      assert.ok(opts?.signal); assert.equal(opts.timeout, undefined); return true;
    };
    assert.equal(await confirmNativeTaskReview(exact, ctx, t.signal), true); assert.equal(dialogs.length, 1);
    for (const section of exact.sections) assert.ok(dialogs[0]!.includes(section.text));
    for (const risk of exact.risks) assert.ok(dialogs[0]!.includes(risk));
    assert.match(dialogs[0]!, /24h \(86400s\)/); assert.match(dialogs[0]!, /no model-round cap/);
    assert.ok(dialogs[0]!.includes('Literal argv · ["node","","two words","--test","line\\nbreak"]'));
    const original = JSON.parse(exact.packet).run as Run;
    for (const literal of [original.task, original.agent.systemPrompt, original.agent.file, original.agent.description,
      original.cwd, `${original.model.provider}/${original.model.id}`, original.agent.thinking!, ...original.acceptanceCriteria!,
      original.verification!.description!]) assert.ok(dialogs[0]!.includes(literal));
    for (const tool of original.agent.tools) assert.ok(dialogs[0]!.includes(tool));
    assert.deepEqual(original.acceptanceCriteria, ["Preserve every literal."]);
  }
});

test("Native execution review rejects false/nonliteral receipts and unsupported UI without another request", async () => {
  for (const accepted of [false, "true", 1, null, undefined, { approved: true }]) {
    const ctx = context(); let calls = 0;
    ctx.ui.confirm = async () => { calls++; return accepted as boolean; };
    assert.equal(await confirmNativeTaskReview(content, ctx), false); assert.equal(calls, 1);
    assert.equal(await confirmNativeTaskReview(content, { ...ctx, hasUI: false }), false); assert.equal(calls, 1);
  }
  assert.equal(await confirmNativeTaskReview(content, { ...context(), ui: {} } as ExtensionContext), false);
  assert.equal(await confirmNativeTaskReview(content, { ...context(), mode: "unknown" } as unknown as ExtensionContext), false);
});

test("Dialog errors and external abort deny; waiting has no deadline or automatic retry", async t => {
  const bad = context(); let calls = 0;
  bad.ui.select = async () => assert.fail("No menu fallback");
  bad.ui.confirm = async () => { calls++; throw new Error("synthetic UI error"); };
  assert.equal(await confirmNativeTaskReview(content, bad), false);
  assert.equal(calls, 1);
  const ctx = context(), abort = new AbortController(); let late: (value: boolean) => void = () => {};
  ctx.ui.confirm = async () => await new Promise(resolve => { late = resolve; });
  const pending = confirmNativeTaskReview(content, ctx, abort.signal); abort.abort(); assert.equal(await pending, false); late(true);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let settled = false;
  const waiting = confirmNativeTaskReview(content, ctx, t.signal).then(value => { settled = true; return value; });
  t.mock.timers.tick(86_400_000); await Promise.resolve(); assert.equal(settled, false);
  late(true); assert.equal(await waiting, true, "Only the actual execution-review receipt approves after waiting");
});

test("TUI real SDK editor presents the complete execution review and approves once without a separate confirm", async () => {
  initTheme("dark", false);
  const ctx = context("tui"), texts: string[] = []; let confirms = 0, buildError: unknown;
  ctx.ui.custom = (async (factory: (...args: unknown[]) => unknown) => await new Promise(resolve => {
    try {
      const tui = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
      const keys = { matches: (data: string, action: string) => action === "app.editor.external" && data === String.fromCharCode(7) };
      const component = factory(tui, {}, keys, resolve) as { children: { getExpandedText?(): string }[]; handleInput(data: string): void; render(width: number): string[] };
      const source = component.children.find(child => child.getExpandedText); assert.ok(source); texts.push(source.getExpandedText!());
      assert.ok(component.render(80).length > 0);
      component.handleInput(String.fromCharCode(7)); assert.equal(source.getExpandedText!(), texts.at(-1));
      component.handleInput(String.fromCharCode(13));
    } catch (error) { buildError = error; throw error; }
  })) as ExtensionContext["ui"]["custom"];
  ctx.ui.confirm = async () => { confirms++; return true; };
  const approved = await confirmNativeTaskReview(content, ctx);
  assert.ifError(buildError); assert.equal(approved, true);
  assert.deepEqual(texts, [nativeTaskReviewText(content)]); assert.equal(confirms, 0);
});

test("TUI edited/bare-custom/nonliteral/forged receipts cannot approve or trigger a UI fallback", async () => {
  initTheme("dark", false);
  for (const mode of ["bare", "unsubmitted", "edited", "trim-equivalent", "nonliteral", "false", "rejected"]) {
    const ctx = context("tui"); let requests = 0, confirms = 0;
    ctx.ui.confirm = async () => { confirms++; return true; };
    ctx.ui.custom = (async (factory: (...args: unknown[]) => unknown) => {
      requests++;
      if (mode === "bare") return true;
      const view = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, {}, { matches: () => false }, () => {}) as {
        children: { getExpandedText?(): string; setText?(value: string): void }[]; handleInput(data: string): void;
      };
      const editor = view.children.find(child => child.getExpandedText && child.setText)!;
      assert.equal(editor.getExpandedText!(), nativeTaskReviewText(content));
      if (mode === "edited" || mode === "trim-equivalent") editor.setText!(editor.getExpandedText!() + (mode === "edited" ? "UNAPPROVED" : " "));
      if (mode !== "unsubmitted") view.handleInput("\r");
      if (mode === "rejected") throw new Error("PRIVATE_SDK_ERROR");
      return mode === "nonliteral" ? "true" : mode !== "false";
    }) as ExtensionContext["ui"]["custom"];
    assert.equal(await confirmNativeTaskReview(content, ctx), false, mode);
    assert.equal(requests, 1); assert.equal(confirms, 0);
  }
});

test("TUI execution review uses the scrollable native editor and never falls back after a construction failure", async () => {
  const ctx = context("tui"); let editorSources = 0, confirms = 0;
  // A missing custom editor is not silently replaced after a failed TUI editor attempt.
  ctx.ui.custom = async () => { editorSources++; throw new Error("Synthetic editor construction refusal"); };
  ctx.ui.confirm = async () => { confirms++; return true; };
  assert.equal(await confirmNativeTaskReview(content, ctx), false); assert.equal(editorSources, 1); assert.equal(confirms, 0);
});

test("Every registered lifecycle event dismisses pending native UI; a changed session cannot receive the approved result", async t => {
  const handlers = new Map<string, () => void>();
  const registered = registerNativeTaskReview({ on: (name: string, handler: () => void) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  const ctx = context(); ctx.ui.confirm = async () => await new Promise(() => {});
  for (const name of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact"]) {
    const pending = registered.confirm(content, ctx, t.signal); handlers.get(name)!(); assert.equal(await pending, false);
  }
  const changed = context(); let session = "first";
  changed.sessionManager.getSessionId = () => session;
  changed.ui.confirm = async () => { session = "different"; return true; };
  assert.equal(await registered.confirm(content, changed, t.signal), false);
  handlers.get("session_shutdown")!();
});

test("Registered native presenter publishes no desktop view, and lifecycle/overlap/session changes cancel pending UI", async t => {
  const handlers = new Map<string, () => void>(); let desktopCalls = 0;
  const pi = { on: (name: string, handler: () => void) => handlers.set(name, handler),
    events: { emit: () => desktopCalls++ } } as unknown as ExtensionAPI;
  const registered = registerNativeTaskReview(pi), ctx = context();
  let late: (value: boolean) => void = () => {};
  ctx.ui.confirm = async () => await new Promise(resolve => { late = resolve; });
  const pending = registered.confirm(content, ctx, t.signal);
  assert.equal(await registered.confirm(content, ctx, t.signal), false);
  handlers.get("session_before_switch")!(); assert.equal(await pending, false); late(true);
  assert.equal(desktopCalls, 0);
  handlers.get("session_shutdown")!(); assert.equal(await registered.confirm(content, ctx, t.signal), false);
});

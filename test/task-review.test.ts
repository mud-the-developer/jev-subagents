import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { taskReviewContent, nativeTaskReviewText, reduceTaskReview, humanLiteral, durationText, type TaskReview, type TaskReviewState } from "../src/task-review-machine.ts";
import { TaskReviewOwner, registerTaskReview } from "../src/task-review.ts";
import { executeEffect } from "../src/delegate-effects.ts";
import type { Run } from "../src/delegate-machine.ts";
import { workerPrompt } from "../src/assessment.ts";

const run: Run = { task: 'Read the synthetic file.\nDo not edit. Quotes: "exact". <script>not HTML</script>', cwd: "/synthetic/workspace",
  agent: { name: "scout", model: { provider: "test-provider", id: "test-model" }, tools: ["read"], description: "Read only",
    systemPrompt: "You are a read-only worker.\nDo not delegate.", file: "/synthetic/agents/scout.md" },
  model: { provider: "test-provider", id: "test-model" }, maxModelCalls: 2,
  verification: { command: "node", args: ["fixture-check.mjs", "two words"], description: "Synthetic fixture only" },
  acceptanceCriteria: ["No synthetic file changed"],
};
const content = taskReviewContent(run);
const review: TaskReview = { ...content, id: "synthetic-id", deadline: 2000 };
const response = { id: review.id, packet: review.packet, reviewed: ["task", "profile", "snapshot"], accepted: true, now: 1000 } as const;
const waiting = (): TaskReviewState => reduceTaskReview({ phase: "idle" }, { type: "request", review }).state;
function ctx(session = "fixture-session"): ExtensionContext {
  return { mode: "print", hasUI: true, cwd: run.cwd, isIdle: () => false, sessionManager: { getSessionId: () => session },
    ui: { notify() {}, confirm: async () => { throw new Error("Native approval must not run in the card flow"); } } } as unknown as ExtensionContext;
}
function fixture(t: TestContext) {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in approval tests"); });
  const owner = new TaskReviewOwner(), context = ctx(); owner.context(context); t.after(() => owner.dispose());
  const { lease } = owner.attach({}); return { owner, context, lease };
}
function receipt(owner: TaskReviewOwner, lease: string) {
  const state = owner.state; assert.equal(state.phase, "review"); if (state.phase !== "review") assert.fail();
  return { lease, id: state.review.id, packet: state.review.packet, reviewed: state.review.sections.map(s => s.id), accepted: true };
}

test("human approval duration and literals are readable while control sequences cannot spoof the terminal", () => {
  assert.equal(durationText(30), "30s"); assert.equal(durationText(120), "2m (120s)");
  assert.equal(durationText(600), "10m (600s)"); assert.equal(durationText(1800), "30m (1800s)"); assert.equal(durationText(3600), "1h (3600s)"); assert.equal(durationText(86_400), "24h (86400s)");
  const literal = 'Read "two words".\nC:\\demo\\sample.txt'; assert.equal(humanLiteral(literal), literal);
  for (const value of ["text\u001b[2J", "text\u202ehidden", "text\u0000hidden"]) {
    const displayed = humanLiteral(value); assert.equal(JSON.parse(displayed), value);
    assert.doesNotMatch(displayed, /[\u0000\u001b\u202e]/);
  }
  const longer = taskReviewContent({ ...run, seconds: 600 });
  assert.equal(longer.summary.seconds, 600); assert.match(nativeTaskReviewText(longer), /after approval 10m \(600s\)/);
  assert.equal(taskReviewContent(run).summary.seconds, 120, "Old packets without an approved duration stay at their old limit");
  const day = taskReviewContent({ ...run, seconds: 86_400 });
  assert.equal(JSON.parse(day.packet).run.seconds, 86_400);
  assert.match(nativeTaskReviewText(day), /after approval 24h \(86400s\)/);
});

test("Review content exposes readable exact input, selected scope and full packet without HTML or escaped summary", () => {
  const data = taskReviewContent(run);
  assert.equal(data.sections[0]!.text, workerPrompt(run));
  assert.match(data.sections[0]!.text, /file\.\nDo not edit/);
  assert.equal(data.summary.role, "scout"); assert.equal(data.summary.maxModelCalls, 2);
  assert.deepEqual(JSON.parse(data.packet).run, run);
  assert.ok(nativeTaskReviewText(data).includes(workerPrompt(run)));
  assert.ok(!nativeTaskReviewText(data).includes(JSON.stringify(workerPrompt(run))));
  assert.match(data.summary.verification, /two words/);
  assert.throws(() => taskReviewContent({ ...run, maxModelCalls: 0 }));
  const sdk = taskReviewContent({ ...run, maxModelCalls: null });
  assert.equal(JSON.parse(sdk.packet).run.maxModelCalls, null);
  assert.match(nativeTaskReviewText(sdk), /SDK natural completion.*no model-round cap/);
  assert.equal(taskReviewContent({ ...run, maxModelCalls: 100 }).summary.maxModelCalls, 100);
});

test("Compact metadata removes only already displayed originals and preserves the exact execution scope", () => {
  const data = taskReviewContent(run), compact = data.sections[2]!.text;
  assert.ok(!compact.includes(run.task)); assert.ok(!compact.includes(run.agent.systemPrompt));
  assert.ok(compact.includes(run.cwd)); assert.ok(compact.includes(`${run.model.provider}/${run.model.id}`));
  assert.match(compact, /Tools · read/); assert.match(compact, /2m \(120s\)/);
  assert.ok(compact.includes(run.verification!.command));
  for (const arg of run.verification!.args) assert.ok(compact.includes(arg));
  assert.deepEqual(JSON.parse(data.packet).run, run);
  assert.ok(data.sections[0]!.text.includes(run.task)); assert.ok(data.sections[0]!.text.includes(run.acceptanceCriteria![0]!));
  assert.ok(data.sections[1]!.text.includes(run.agent.systemPrompt));
  assert.ok(data.sections[2]!.text.length < data.packet.length);
  assert.ok(!nativeTaskReviewText(data).includes(data.packet), "The complete readable projection does not duplicate the backend JSON packet");
  assert.deepEqual(JSON.parse(data.packet).run, run);
});

test("Pure review is single-use, owns copied data and requires literal approval/full exact review", () => {
  const source = structuredClone(review), state = reduceTaskReview({ phase: "idle" }, { type: "request", review: source }).state;
  (source.summary.tools as string[]).push("edit"); assert.deepEqual((state as { review: TaskReview }).review.summary.tools, ["read"]);
  const accepted = reduceTaskReview(state, { type: "decide", ...response });
  assert.equal(accepted.state.phase, "approved"); assert.deepEqual(accepted.effects, [{ type: "resolve", approved: true }]);
  assert.deepEqual(reduceTaskReview(accepted.state, { type: "decide", ...response }).effects, []);
  for (const changes of [{ accepted: false }, { accepted: "yes" }, { packet: "changed" }, { reviewed: [] },
    { reviewed: ["task", "task", "snapshot"] }, { now: 2000 }, { now: NaN }]) {
    const denied = reduceTaskReview(waiting(), { type: "decide", ...response, ...changes } as Parameters<typeof reduceTaskReview>[1]);
    assert.equal(denied.state.phase, "cancelled"); assert.deepEqual(denied.effects, [{ type: "resolve", approved: false }]);
  }
  assert.equal(reduceTaskReview(state, { type: "decide", ...response, id: "other-session" }).state, state);
  assert.equal(reduceTaskReview(state, { type: "request", review }).state, state);
});

test("Owner approval effect waits for card review, uses no native modal and rejects replay", async t => {
  const { owner, context, lease } = fixture(t);
  const notify = t.mock.method(context.ui, "notify", () => {});
  let resolved = false;
  const event = executeEffect({ type: "confirm_run", run }, context, t.signal, (data, context, signal) => owner.confirm(data, context, signal)).then(value => { resolved = true; return value; });
  await Promise.resolve(); assert.equal(resolved, false); assert.equal(notify.mock.callCount(), 1);
  assert.match(notify.mock.calls[0]!.arguments[0]!, /Ctrl\+K/);
  const input = receipt(owner, lease);
  assert.throws(() => owner.decide({ ...input, accepted: "yes" }));
  assert.equal(owner.state.phase, "review");
  assert.equal(owner.decide(input).approved, true); assert.deepEqual(await event, { type: "approval", approved: true });
  assert.throws(() => owner.decide(input)); assert.equal("review" in owner.state, false);
});

test("Changed packet consumes authority without approving or opening another native confirmation", async t => {
  const { owner, context, lease } = fixture(t);
  const pending = owner.confirm(content, context, t.signal), input = receipt(owner, lease);
  assert.equal(owner.decide({ ...input, packet: "changed" }).approved, false);
  assert.equal(await pending, false); assert.throws(() => owner.decide(input));
});

test("Closing/replacing a viewer cancels approval and old lease cannot operate", async t => {
  const { owner, context, lease } = fixture(t);
  const pending = owner.confirm(content, context, t.signal), input = receipt(owner, lease);
  const next = owner.attach({}); assert.equal(await pending, false); assert.throws(() => owner.decide(input));
  assert.throws(() => owner.cancel({ lease })); owner.cancel({ lease: next.lease });
});

test("View heartbeat expiry cancels pending review without model or worker activity", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { owner, context } = fixture(t); const pending = owner.confirm(content, context, t.signal);
  t.mock.timers.tick(5001); assert.equal(await pending, false); assert.equal(owner.state.phase, "cancelled");
});

test("External abort and session cancellation consume approval; later packets cannot revive it", async t => {
  const { owner, context, lease } = fixture(t); const controller = new AbortController();
  const pending = owner.confirm(content, context, controller.signal), input = receipt(owner, lease);
  controller.abort(); assert.equal(await pending, false); assert.throws(() => owner.decide(input));
  const again = owner.confirm(content, context, t.signal), next = receipt(owner, lease);
  owner.cancelLocal(); assert.equal(await again, false); assert.throws(() => owner.decide(next));
});

test("Review waits without a response deadline; wrong session, absent UI, overlap and disposal still deny", async t => {
  const { owner, context, lease } = fixture(t);
  assert.equal(await owner.confirm(content, ctx("different-session"), t.signal), false);
  assert.equal(await owner.confirm(content, { ...context, hasUI: false }, t.signal), false);
  const pending = owner.confirm(content, context, t.signal), input = receipt(owner, lease);
  assert.equal(await owner.confirm(content, context, t.signal), false);
  const state = owner.state; if (state.phase !== "review") assert.fail();
  assert.equal(state.review.deadline, null);
  const later = Date.now() + 86_400_000; t.mock.method(Date, "now", () => later);
  assert.equal(owner.decide(input).approved, true); assert.equal(await pending, true);
  owner.dispose(); assert.equal(await owner.confirm(content, context, t.signal), false);
});

test("Approval display/notification failures resolve denial rather than losing the pending resolver", async t => {
  const { owner, context } = fixture(t);
  owner.subscribe(() => { throw new Error("synthetic display failure"); });
  t.mock.method(context.ui, "notify", () => { throw new Error("synthetic notification failure"); });
  assert.equal(await owner.confirm(content, context, t.signal), false);
  assert.equal(owner.state.phase, "cancelled");
});

test("Native fallback is selected only before a desktop review begins, literal true remains required", async t => {
  const context = ctx(); const confirm = t.mock.method(context.ui, "confirm", async () => true);
  Object.assign(context.ui, { select: async (_title: string, choices: string[]) => choices[0] });
  assert.deepEqual(await executeEffect({ type: "confirm_run", run }, context, t.signal, async () => undefined), { type: "approval", approved: true });
  assert.equal(confirm.mock.callCount(), 1); assert.ok(confirm.mock.calls[0]!.arguments[1]!.includes(workerPrompt(run)));
  for (const section of content.sections) assert.ok(confirm.mock.calls[0]!.arguments[1]!.includes(section.text));
  assert.match(confirm.mock.calls[0]!.arguments[0]!, /Approve this exact execution/);
  confirm.mock.resetCalls();
  assert.deepEqual(await executeEffect({ type: "confirm_run", run }, context, t.signal, async () => false), { type: "approval", approved: false });
  assert.equal(confirm.mock.callCount(), 0);
});

test("Desktop registration reuses exact declaration and binds session lifecycle; opening does not request work", async t => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>(); let declaration: unknown, registrations = 0;
  const pi = { events: { emit: (name: string, input: { declaration: unknown; accept(): void }) => {
    if (name.endsWith(":register")) { registrations++; if (declaration) assert.equal(declaration, input.declaration); declaration = input.declaration; input.accept(); }
  }, on: (name: string, callback: (...args: unknown[]) => unknown) => { handlers.set(name, callback); return () => handlers.delete(name); } },
  on: (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback) } as unknown as ExtensionAPI;
  const registered = registerTaskReview(pi)!; t.after(() => registered.owner.dispose());
  assert.equal(registered.available, true); handlers.get("pi-gui:desktop-view:discover")!(); assert.equal(registrations, 2);
  const context = ctx(); handlers.get("session_start")!({}, context);
  const { lease } = registered.owner.attach({}); assert.equal(registered.owner.state.phase, "idle");
  const pending = registered.confirm(content, context, t.signal), input = receipt(registered.owner, lease);
  handlers.get("session_before_switch")!(); assert.equal(await pending, false); assert.throws(() => registered.owner.decide(input));
  assert.equal(await registered.confirm(content, { ...context, mode: "tui" }, t.signal), undefined);
  handlers.get("session_shutdown")!(); assert.equal(registered.available, false);
});

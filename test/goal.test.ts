import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGoalRecord, replayGoal, reduceGoal, ZERO_GOAL_UNITS, EMPTY_GOAL_HEAD, MAX_GOAL_RECORDS,
  type GoalDefinition, type GoalEvent, type GoalIntent, type GoalRecord, type GoalSettlement, type GoalState,
  type GoalTransition, type GoalUnits } from "../src/goal-machine.ts";

const ref = { goalId: "goal-fixture", revision: 1, scopeDigest: "a".repeat(64) };
const definition: GoalDefinition = { ref, limits: { ...ZERO_GOAL_UNITS, workerRuns: 3, workerCalls: 8,
  plannerCalls: 2, summaryCalls: 1, jevCalls: 2, verificationRuns: 3, repairs: 1 }, maxTotalCalls: 10, deadlineMs: 10_000 };
const activationId = "activation-one";
const intent = (id = "work-one", reserve: Partial<GoalUnits> = { workerRuns: 1, workerCalls: 4 }): GoalIntent =>
  ({ id, planDigest: "b".repeat(64), reserve: { ...ZERO_GOAL_UNITS, ...reserve } });
const result = (overrides: Partial<GoalSettlement> = {}): GoalSettlement => ({ outcome: "succeeded",
  used: { ...ZERO_GOAL_UNITS, workerRuns: 1, workerCalls: 2 }, observedUsd: 0.01,
  accountingComplete: true, cleanupConfirmed: true, ...overrides });
function ack(t: GoalTransition, now?: number): GoalTransition {
  const effect = t.effects[0];
  assert.equal(effect?.type, "append_goal");
  if (effect?.type !== "append_goal") throw new Error("Missing fixture append");
  const sequence = effect.expected.sequence + 1;
  return reduceGoal(t.state, { type: "persisted", expected: effect.expected, record: effect.record,
    head: { sequence, hash: sequence.toString(16).padStart(64, "0") }, now: now ?? effect.record.at + 1 });
}
function approved(): GoalTransition {
  const created = ack(reduceGoal({ status: "idle" }, { type: "create", definition, activationId, now: 100 }));
  assert.equal(created.state.status, "awaiting_approval");
  return ack(reduceGoal(created.state, { type: "approval", ref, activationId, approved: true, now: 110 }));
}
function reserved(state = approved().state, request = intent(), now = 120): GoalTransition {
  return reduceGoal(state, { type: "reserve", ref, activationId, intent: request, now });
}
function admitted(request = intent()): GoalTransition {
  const checked = ack(reserved(undefined, request));
  assert.equal(checked.state.status, "checking");
  if (checked.state.status !== "checking") throw new Error("Missing fixture admission");
  return reduceGoal(checked.state, { type: "admission", ref, activationId, intentId: request.id, head: checked.state.head, current: true, now: 130 });
}
function settle(state: GoalState, value = result()): GoalTransition {
  return reduceGoal(state, { type: "settlement", ref, activationId, intentId: "work-one", result: value, now: 140 });
}
const created: GoalRecord = { type: "created", definition, at: 100 };
const approvedRecord: GoalRecord = { type: "approved", ref, activationId, at: 110 };
const reservedRecord: GoalRecord = { type: "reserved", ref, activationId, intent: intent(), at: 120 };
const settledRecord: GoalRecord = { type: "settled", ref, activationId, intentId: "work-one", result: result(), at: 140 };

function freeze<T>(input: T): T {
  if (input && typeof input === "object") { for (const value of Object.values(input)) freeze(value); Object.freeze(input); }
  return input;
}

test("goal core requires current approval, durable reservation and fresh admission before one dispatch", () => {
  const start = reduceGoal({ status: "idle" }, { type: "create", definition, activationId, now: 100 });
  assert.equal(start.state.status, "persisting");
  assert.equal("ledger" in start.state && start.state.ledger, null);
  const waiting = ack(start);
  assert.deepEqual(reserved(waiting.state), { state: waiting.state, effects: [] });
  assert.equal(reduceGoal(waiting.state, { type: "approval", ref, activationId, approved: false, now: 110 }).state.status, "cancelled");
  const reservation = reserved();
  assert.equal(reservation.state.status, "persisting");
  assert.equal("ledger" in reservation.state && reservation.state.ledger?.pending, null);
  const checked = ack(reservation);
  assert.equal(checked.effects[0]?.type, "check_goal_admission");
  const active = admitted();
  assert.equal(active.state.status, "active");
  assert.deepEqual(active.effects.map((e) => e.type), ["dispatch_goal_operation"]);
  assert.equal(reserved(active.state).effects.length, 0);
  if (active.state.status !== "active") return assert.fail();
  assert.deepEqual(reduceGoal(active.state, { type: "admission", ref, activationId, intentId: "work-one", head: active.state.head, current: true, now: 135 }), { state: active.state, effects: [] });
});

test("goal fold owns records, counts once, releases only confirmed unused reservations, and preserves unknown cost", () => {
  const input = structuredClone([created, approvedRecord, reservedRecord]);
  const pending = replayGoal(input)!;
  assert.deepEqual(pending.held, intent().reserve);
  assert.deepEqual(pending.spent, ZERO_GOAL_UNITS);
  assert.equal(pending.totalUsd, null, "an outstanding intent is not proof of a zero complete cost");
  input[0] = { ...created, definition: { ...definition, maxTotalCalls: 999 } };
  assert.equal(pending.definition.maxTotalCalls, 10);
  const settled = applyGoalRecord(freeze(pending), settledRecord);
  assert.equal(settled.spent.workerCalls, 2);
  assert.deepEqual(settled.held, ZERO_GOAL_UNITS);
  assert.equal(settled.totalUsd, 0.01);
  assert.equal(settled.observedUsd, 0.01);
  assert.equal(settled.blocked, false);
  assert.throws(() => applyGoalRecord(settled, settledRecord), /Invalid goal/);
  const unknown = applyGoalRecord(pending, { ...settledRecord, result: result({ accountingComplete: false }) });
  assert.equal(unknown.spent.workerCalls, 2);
  assert.equal(unknown.held.workerCalls, 2);
  assert.equal(unknown.totalUsd, null);
  assert.equal(unknown.observedUsd, 0.01);
  assert.equal(unknown.blocked, true);
  assert.throws(() => applyGoalRecord(unknown, { ...approvedRecord, activationId: "activation-two", at: 150 }));
  assert.throws(() => applyGoalRecord(unknown, { ...reservedRecord, intent: intent("new-name"), at: 150 }));
});

test("restoration is disarmed, never redispatches an intent, and cannot reset counters via a reused activation", () => {
  const records = [created, approvedRecord, reservedRecord, settledRecord];
  const head = { sequence: 4, hash: "c".repeat(64) };
  const restored = reduceGoal({ status: "idle" }, { type: "restore", records, head, activationId: "activation-two", now: 200 });
  assert.equal(restored.state.status, "awaiting_approval");
  assert.deepEqual(restored.effects, []);
  assert.equal("ledger" in restored.state && restored.state.ledger?.spent.workerCalls, 2);
  assert.equal(reduceGoal({ status: "idle" }, { type: "restore", records, head, activationId, now: 200 }).state.status, "needs_review");
  const pending = reduceGoal({ status: "idle" }, { type: "restore", records: records.slice(0, 3),
    head: { sequence: 3, hash: "d".repeat(64) }, activationId: "activation-two", now: 200 });
  assert.equal(pending.state.status, "needs_review");
  assert.equal("ledger" in pending.state && pending.state.ledger?.held.workerCalls, 4);
  assert.deepEqual(pending.effects, []);
  records.length = 0;
  assert.equal("ledger" in restored.state && restored.state.ledger?.spent.workerCalls, 2);
});

test("goal rejects per-category and total overbooking, invalid accounting, stale refs, IDs and replay sequences", () => {
  for (const reservation of [intent("over", { workerCalls: 9 }), intent("over", { workerCalls: 8, plannerCalls: 2, summaryCalls: 1 }),
    intent("over", { repairs: 2 }), intent("zero", {})]) assert.equal(reserved(undefined, reservation).state.status, "needs_review");
  const pending = replayGoal([created, approvedRecord, reservedRecord])!;
  for (const value of [result({ used: { ...ZERO_GOAL_UNITS, workerCalls: 5 } }),
    result({ outcome: "not_started" }), result({ observedUsd: Infinity }), result({ observedUsd: NaN }),
    result({ used: { ...ZERO_GOAL_UNITS, workerCalls: -1 } })]) {
    assert.throws(() => applyGoalRecord(pending, { ...settledRecord, result: value }), /Invalid goal/);
  }
  for (const records of [[approvedRecord], [created, created], [created, reservedRecord], [created, approvedRecord, approvedRecord],
    [created, approvedRecord, { ...reservedRecord, ref: { ...ref, revision: 2 } }],
    [created, approvedRecord, { ...reservedRecord, at: 109 }],
    [created, approvedRecord, reservedRecord, { ...settledRecord, intentId: "wrong" }],
    [created, approvedRecord, reservedRecord, settledRecord, { ...reservedRecord, at: 150 }]]) assert.throws(() => replayGoal(records));
  assert.throws(() => replayGoal(new Array(MAX_GOAL_RECORDS + 1).fill(created)));
  assert.throws(() => replayGoal(new Array(1)));
});

test("goal admission fences deadline, revocation, changed heads and old activation results", () => {
  const checked = ack(reserved());
  if (checked.state.status !== "checking") return assert.fail();
  const event: Extract<GoalEvent, { type: "admission" }> = { type: "admission", ref, activationId, intentId: "work-one", head: checked.state.head, current: true, now: 130 };
  for (const change of [{ current: false }, { now: definition.deadlineMs }, { now: 0 }, { head: EMPTY_GOAL_HEAD }]) {
    const denied = reduceGoal(checked.state, { ...event, ...change });
    assert.equal(denied.state.status, "needs_review");
    assert.equal(denied.effects.length, 0);
  }
  for (const change of [{ activationId: "old" }, { ref: { ...ref, revision: 2 } }, { intentId: "old-work" }]) {
    assert.deepEqual(reduceGoal(checked.state, { ...event, ...change }), { state: checked.state, effects: [] });
  }
  assert.equal(ack(reserved(), definition.deadlineMs).state.status, "needs_review");
});

test("cancellation during write prevents admission; active cancellation drains and retains final usage", () => {
  const pending = reserved();
  const stopped = reduceGoal(pending.state, { type: "cancel" });
  assert.equal(stopped.state.status, "cancelled");
  const effect = pending.effects[0];
  if (effect?.type !== "append_goal") return assert.fail();
  assert.deepEqual(reduceGoal(stopped.state, { type: "persisted", expected: effect.expected, record: effect.record,
    head: { sequence: 3, hash: "c".repeat(64) }, now: 140 }), { state: stopped.state, effects: [] });
  const draining = reduceGoal(admitted().state, { type: "cancel" });
  assert.equal(draining.state.status, "draining");
  assert.equal(draining.effects[0]?.type, "stop_goal_operation");
  assert.deepEqual(reduceGoal(draining.state, { type: "cancel" }), { state: draining.state, effects: [] });
  const final = ack(settle(draining.state));
  assert.equal(final.state.status, "cancelled");
  assert.equal("ledger" in final.state && final.state.ledger?.observedUsd, 0.01);
  assert.equal("ledger" in final.state && final.state.ledger?.spent.workerCalls, 2);
  assert.deepEqual(settle(final.state), { state: final.state, effects: [] });
});

test("malformed active settlement stops the admitted operation rather than abandoning its cleanup", () => {
  const active = admitted();
  const bad = reduceGoal(active.state, { type: "settlement", ref, activationId, intentId: "work-one", result: null as unknown as GoalSettlement, now: 140 });
  assert.equal(bad.state.status, "draining");
  assert.equal(bad.effects[0]?.type, "stop_goal_operation");
  const final = ack(settle(bad.state));
  assert.equal(final.state.status, "needs_review");
  assert.equal("ledger" in final.state && final.state.ledger?.observedUsd, 0.01);
});

test("goal snapshots and effects are detached, reducers are deterministic and do not read clocks or randomness", (t) => {
  const state = freeze(approved().state);
  const request = intent();
  const event: GoalEvent = { type: "reserve", ref: { ...ref }, activationId, intent: request, now: 120 };
  const first = reduceGoal(state, event);
  assert.deepEqual(first, reduceGoal(state, freeze(structuredClone(event))));
  request.reserve.workerCalls = 999;
  request.planDigest = "c".repeat(64);
  assert.equal(first.state.status === "persisting" && first.state.record.type === "reserved" && first.state.record.intent.reserve.workerCalls, 4);
  const effect = first.effects[0];
  if (effect?.type !== "append_goal" || effect.record.type !== "reserved") return assert.fail();
  effect.record.intent.reserve.workerCalls = 999;
  assert.equal(first.state.status === "persisting" && first.state.record.type === "reserved" && first.state.record.intent.reserve.workerCalls, 4);
  const forbidden = () => { throw new Error("Ambient clock/randomness read"); };
  t.mock.method(Date, "now", forbidden);
  t.mock.method(Math, "random", forbidden);
  t.mock.method(performance, "now", forbidden);
  const safe = reduceGoal(state, { type: "reserve", ref, activationId, intent: intent(), now: 120 });
  assert.equal(safe.state.status, "persisting");
  assert.equal(replayGoal([created, approvedRecord, reservedRecord, settledRecord])?.spent.workerCalls, 2);
});

test("storage results are correlated; malformed acknowledgements stop and old failures cannot change other phases", () => {
  const pending = reserved(), write = pending.effects[0];
  if (write?.type !== "append_goal") return assert.fail();
  const failure: GoalEvent = { type: "storage_failed", expected: write.expected, record: write.record };
  assert.equal(reduceGoal(pending.state, failure).state.status, "needs_review");
  assert.deepEqual(reduceGoal(pending.state, { ...failure, expected: EMPTY_GOAL_HEAD }), { state: pending.state, effects: [] });
  const active = admitted().state;
  assert.deepEqual(reduceGoal(active, failure), { state: active, effects: [] });
  const bad = reduceGoal(pending.state, { type: "persisted", expected: write.expected, record: write.record,
    head: { sequence: 999, hash: "e".repeat(64) }, now: 140 });
  assert.equal(bad.state.status, "needs_review");
  for (const definition of [null, {}, { ref }, { ...created.definition, deadlineMs: 50 }]) {
    const invalid = reduceGoal({ status: "idle" }, { type: "create", definition: definition as GoalDefinition, activationId, now: 100 });
    assert.equal(invalid.effects.length, 0);
  }
});

test("pause remains disarmed after replay, unknown cleanup retains its unused reservation, and cancellation wins while draining", () => {
  const paused = ack(reduceGoal(approved().state, { type: "pause" }));
  assert.equal(paused.state.status, "paused");
  assert.equal("ledger" in paused.state && paused.state.ledger?.activationId, null);
  assert.deepEqual(reduceGoal(paused.state, { type: "approval", ref, activationId, approved: true, now: 120 }), { state: paused.state, effects: [] });
  const pending = replayGoal([created, approvedRecord, reservedRecord])!;
  const uncertain = applyGoalRecord(pending, { ...settledRecord, result: result({ cleanupConfirmed: false }) });
  assert.equal(uncertain.totalUsd, null);
  assert.equal(uncertain.held.workerCalls, 2);
  const notStarted = applyGoalRecord(pending, { ...settledRecord, result: result({ outcome: "not_started", used: { ...ZERO_GOAL_UNITS }, observedUsd: 0 }) });
  assert.deepEqual(notStarted.held, ZERO_GOAL_UNITS);
  assert.equal(notStarted.blocked, false);
  const draining = reduceGoal(admitted().state, { type: "pause" });
  const cancelled = reduceGoal(draining.state, { type: "cancel" });
  assert.equal(cancelled.state.status === "draining" && cancelled.state.reason, "cancelled");
  assert.equal(ack(settle(cancelled.state)).state.status, "cancelled");
});

test("validated observations survive settlement-write failure or cancellation without claiming a durable checkpoint", () => {
  const pending = settle(admitted().state), write = pending.effects[0];
  if (write?.type !== "append_goal") return assert.fail();
  for (const event of [{ type: "storage_failed", expected: write.expected, record: write.record }, { type: "cancel" }] as GoalEvent[]) {
    const stopped = reduceGoal(pending.state, event).state;
    assert.ok(stopped.status === "needs_review" || stopped.status === "cancelled");
    assert.equal(stopped.ledger?.spent.workerCalls, 0, "durable projection remains at its confirmed head");
    assert.equal(stopped.ledger?.totalUsd, null);
    const observation = "unconfirmedRecord" in stopped ? stopped.unconfirmedRecord as GoalRecord : undefined;
    assert.equal(observation?.type === "settled" && observation.result.observedUsd, 0.01);
  }
  const cancelling = settle(reduceGoal(admitted().state, { type: "cancel" }).state);
  const cancellationWrite = cancelling.effects[0];
  assert.equal(reduceGoal(cancelling.state, { type: "pause" }).state.status, "cancelled");
  if (cancellationWrite?.type !== "append_goal") return assert.fail();
  const failed = reduceGoal(cancelling.state, { type: "storage_failed", expected: cancellationWrite.expected, record: cancellationWrite.record });
  assert.equal(failed.state.status, "cancelled", "storage failure must not overturn an existing cancellation");
});

test("reservation leaves room for settlement and an activation cannot close while its operation is unresolved", () => {
  const ready = replayGoal([created, approvedRecord])!;
  assert.throws(() => applyGoalRecord({ ...ready, sequence: MAX_GOAL_RECORDS - 1 }, reservedRecord));
  const pending = replayGoal([created, approvedRecord, reservedRecord])!;
  assert.throws(() => applyGoalRecord(pending, { type: "closed", ref, activationId, at: 130, reason: "paused" }));
});

test("stopping cannot turn unknown application into a known total or refund the unobserved reservation", () => {
  for (const type of ["cancel", "pause"] as const) {
    const draining = reduceGoal(admitted().state, { type });
    const stored = settle(draining.state, result({ outcome: "unknown" }));
    assert.equal(stored.state.status, "persisting");
    const final = ack(stored).state;
    assert.equal(final.status, type === "cancel" ? "cancelled" : "paused");
    if (!("ledger" in final) || !final.ledger) return assert.fail();
    assert.equal(final.ledger.totalUsd, null);
    assert.equal(final.ledger.observedUsd, 0.01);
    assert.equal(final.ledger.spent.workerCalls, 2);
    assert.equal(final.ledger.held.workerCalls, 2);
    assert.equal(final.ledger.blocked, true);
  }
});

test("stopping cannot launder invalid not-started accounting by rewriting its outcome", () => {
  const draining = reduceGoal(admitted().state, { type: "cancel" }).state;
  const notStarted = result({ outcome: "not_started", used: { ...ZERO_GOAL_UNITS }, observedUsd: 0 });
  for (const invalid of [
    { ...notStarted, used: { ...ZERO_GOAL_UNITS, workerCalls: 1 } },
    { ...notStarted, observedUsd: 0.01 },
    { ...notStarted, accountingComplete: false },
    { ...notStarted, cleanupConfirmed: false },
  ]) assert.deepEqual(settle(draining, invalid), { state: draining, effects: [] });
  assert.equal(ack(settle(draining, notStarted)).state.status, "cancelled");
});

test("goal identifiers and digests reject trailing line terminators", () => {
  for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
    const rejected = reduceGoal({ status: "idle" }, { type: "create", definition: created.definition, activationId: activationId + suffix, now: 100 });
    assert.deepEqual(rejected.effects, []);
    for (const badRef of [{ ...ref, goalId: ref.goalId + suffix }, { ...ref, scopeDigest: ref.scopeDigest + suffix }]) {
      assert.throws(() => applyGoalRecord(null, { ...created, definition: { ...created.definition, ref: badRef } }));
    }
    for (const badIntent of [{ ...intent(), id: "work-one" + suffix }, { ...intent(), planDigest: "b".repeat(64) + suffix }]) {
      assert.deepEqual(reduceGoal(approved().state, { type: "reserve", ref, activationId, intent: badIntent, now: 120 }).effects, []);
    }
  }
});

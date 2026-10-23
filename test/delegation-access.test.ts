import assert from "node:assert/strict";
import { test } from "node:test";
import { reduceDelegationAccess, type DelegationAccessEvent, type DelegationAccessState } from "../src/delegation-access.ts";
import { accessFixture } from "./helpers/delegation-access-fixture.ts";
import { parallelFixture } from "./helpers/parallel-read-fixture.ts";
import { parallelRead } from "../src/parallel-read-effects.ts";
import { DelegateToolInputSchema } from "../src/ordinary-effects.ts";
import { Value } from "typebox/value";
import { syntheticPacketCustom } from "./helpers/native-packet.ts";

const binding = { sessionId: "session", cwd: "/synthetic" };
const request = { type: "request", id: "native-request", binding } as const;
const reply = { type: "reply", id: request.id, binding, accepted: true } as const;
const authorize = { type: "authorize", id: request.id, binding } as const;
test("access reducer requires native acknowledgement, owns inputs, and keeps authority distinct from task receipts", () => {
  const idle: DelegationAccessState = { phase: "reviewed" };
  for (const event of [reply, authorize]) assert.deepEqual(reduceDelegationAccess(idle, event), { state: idle, effects: [] });
  const mutable = structuredClone(request), pending = reduceDelegationAccess(idle, mutable);
  mutable.binding.cwd = "/changed";
  assert.deepEqual(pending, reduceDelegationAccess(idle, request));
  assert.equal(pending.effects[0]?.type, "acknowledge");
  assert.equal(reduceDelegationAccess(pending.state, authorize).effects.length, 0);
  for (const accepted of [false, undefined, "true", 1]) assert.equal(reduceDelegationAccess(pending.state, { ...reply, accepted }).state.phase, "reviewed");
  const full = reduceDelegationAccess(Object.freeze(pending.state), reply);
  assert.equal(full.state.phase, "full");
  assert.deepEqual(reduceDelegationAccess(full.state, authorize).effects, [{ type: "authorized", source: "full_access" }]);
  assert.equal(reduceDelegationAccess(full.state, { ...authorize, id: "replayed-old-epoch" }).effects.length, 0);
  const mismatch = reduceDelegationAccess(full.state, { ...authorize, binding: { ...binding, sessionId: "other" } });
  assert.equal(mismatch.state.phase, "revoking"); assert.deepEqual(mismatch.effects, [{ type: "cancel" }]);
  assert.equal(reduceDelegationAccess(mismatch.state, request).state.phase, "revoking");
  const drained = reduceDelegationAccess(mismatch.state, { type: "drained" });
  assert.deepEqual(drained.state, idle); assert.equal(reduceDelegationAccess(drained.state, reply).effects.length, 0);
});

test("Full Access covers balanced/strict read-only batches without fabricating native review counts", async t => {
  for (const level of ["balanced", "strict"] as const) {
    const f = parallelFixture(), access = accessFixture(f.ctx), lease = await access.enable();
    f.prepared.policy.approval.level = level;
    f.io.confirm = async () => assert.fail("No per-batch popup in Full Access");
    let starts = 0; f.io.run = async input => { starts++; assert.deepEqual(input.run.agent.tools, ["read", "grep", "find", "ls"]);
      return { started: true, cleanupConfirmed: true, result: f.reply() }; };
    const result = await parallelRead(f.input, f.ctx, t.signal, f.io, undefined, undefined, lease);
    assert.equal(result.status, "completed_unverified"); assert.equal(result.authorization, "full_access"); assert.equal(result.approvals, 0);
    assert.equal(starts, 3); assert.equal(access.confirmations(), 1); assert.equal(result.taskAcceptance, "needs_human_review");
    await access.access.revoke();
    const stopped = await parallelRead(f.input, f.ctx, t.signal, f.io, undefined, undefined, lease);
    assert.equal(stopped.status, "stopped"); assert.equal(starts, 3); assert.equal(access.confirmations(), 1);
  }
});

test("tool input flags cannot activate Full Access, and a bare TUI response is not a native acknowledgement", async () => {
  for (const flags of [{ fullAccess: true }, { authorization: "full_access" }, { access: { phase: "full" } }]) {
    assert.equal(Value.Check(DelegateToolInputSchema, { task: "Inspect the explicit source.", agents: ["scout"], ...flags }), false);
  }
  const f = accessFixture(); Object.assign(f.ctx, { mode: "tui" });
  f.ctx.ui.custom = (async () => true) as typeof f.ctx.ui.custom;
  await f.access.handle("full", f.ctx); assert.equal(f.access.lease(f.ctx), undefined); assert.equal(f.confirmations(), 0);
  const g = accessFixture(), lease = await g.enable(); g.move();
  await g.access.handle("", g.ctx); assert.equal(lease.signal.aborted, true); assert.match(g.notices.at(-1)!, /Reviewed/);
});

test("native TUI Full Access submits the complete risk acknowledgement once before issuing a lease", async () => {
  const f = accessFixture(); Object.assign(f.ctx, { mode: "tui" });
  let reviews = 0;
  f.ctx.ui.custom = syntheticPacketCustom(text => {
    reviews++; assert.match(text, /Enable Full Access/); assert.match(text, /NO cumulative session/);
    assert.match(text, /NOT a sandbox/); assert.match(text, /scope|Scoped/); assert.match(text, /standalone memory administration/);
    assert.match(text, /Session · session/); assert.match(text, /Workspace · \/synthetic/);
    assert.throws(() => f.access.lease(f.ctx), /pending/);
  });
  const lease = await f.enable();
  assert.equal(reviews, 1); assert.equal(f.confirmations(), 0); assert.equal(lease.authorize(f.ctx), true);
  await f.access.handle("full", f.ctx); assert.equal(reviews, 1);
  await f.access.revoke(); assert.equal(lease.signal.aborted, true); assert.equal(f.statuses.at(-1), undefined);
});

test("closed access ignores late replies, attempts to enable and all authorization events", () => {
  const state: DelegationAccessState = { phase: "closed" };
  for (const event of [request, reply, authorize, { type: "revoke" }, { type: "close" }, { type: "drained" }] as DelegationAccessEvent[]) {
    assert.deepEqual(reduceDelegationAccess(Object.freeze(state), event), { state, effects: [] });
  }
});

test("native Full Access asks once, admits repeated jobs, displays mode and never restores a lease", async () => {
  const f = accessFixture(); assert.equal(f.access.lease(f.ctx), undefined);
  const lease = await f.enable(); assert.equal(f.confirmations(), 1);
  for (let i = 0; i < 3; i++) assert.equal(lease.authorize(f.ctx), true);
  await f.access.handle("full", f.ctx); assert.equal(f.confirmations(), 1);
  assert.equal(f.statuses.at(-1), "JEV · Full Access");
  await f.access.handle("reviewed", f.ctx);
  assert.equal(lease.signal.aborted, true); assert.equal(lease.authorize(f.ctx), false); assert.equal(f.statuses.at(-1), undefined);
  const next = await f.enable(); assert.equal(f.confirmations(), 2); assert.equal(next.authorize(f.ctx), true); assert.equal(lease.authorize(f.ctx), false);
  assert.equal(accessFixture(f.ctx).access.lease(f.ctx), undefined, "a reloaded owner never reads history/config authority");
});

test("declined, invalid, unavailable and failed native risk acknowledgements never enable access", async () => {
  for (const answer of [false, "true", undefined, "throw"] as const) {
    const f = accessFixture();
    f.ctx.ui.confirm = async () => { if (answer === "throw") throw new Error("PRIVATE_FAILURE"); return answer as boolean; };
    await f.access.handle("full", f.ctx); assert.equal(f.access.lease(f.ctx), undefined);
    assert.doesNotMatch(f.notices.join("\n"), /PRIVATE_FAILURE/);
  }
  const f = accessFixture(); Object.assign(f.ctx, { hasUI: false });
  await f.access.handle("full", f.ctx); assert.equal(f.confirmations(), 0); assert.equal(f.access.lease(f.ctx), undefined);
});

test("all navigation/shutdown hooks revoke immediately and await owned cleanup before another enable", async () => {
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) {
    let drain!: () => void;
    const f = accessFixture(undefined, () => new Promise<void>(resolve => { drain = resolve; })), lease = await f.enable();
    const revoking = f.hooks.get(event)![0]!();
    assert.equal(lease.signal.aborted, true); assert.equal(lease.authorize(f.ctx), false); assert.throws(() => f.access.lease(f.ctx), /no admission/);
    await f.access.handle("full", f.ctx); assert.equal(f.confirmations(), 1, "no admission while draining");
    drain(); await revoking;
    await f.access.handle("full", f.ctx); assert.equal(f.confirmations(), event === "session_shutdown" ? 1 : 2);
  }
});

test("lifecycle cancellation dismisses an unbounded acknowledgement and rejects its late positive reply", async () => {
  const f = accessFixture(); let reply!: (value: boolean) => void;
  f.ctx.ui.confirm = () => new Promise(resolve => { reply = resolve; });
  const enabling = f.access.handle("full", f.ctx);
  assert.throws(() => f.access.lease(f.ctx), /pending/);
  await f.hooks.get("session_before_tree")![0]!(); await enabling;
  reply(true); await Promise.resolve(); assert.equal(f.access.lease(f.ctx), undefined);
});

test("changed session/workspace, cancelled calls and unknown cleanup cannot reuse authority", async () => {
  const f = accessFixture(), lease = await f.enable();
  assert.equal(lease.authorize(f.ctx, AbortSignal.abort()), false);
  f.move(); assert.equal(lease.authorize(f.ctx), false); assert.equal(lease.signal.aborted, true);
  const g = accessFixture(), second = await g.enable(); Object.assign(g.ctx, { cwd: "/changed" });
  assert.throws(() => g.access.lease(g.ctx), /ownership changed/); assert.equal(second.signal.aborted, true);
  const h = accessFixture(undefined, async () => { throw new Error("Uncertain cleanup"); }), third = await h.enable();
  await assert.rejects(h.access.revoke(), /Uncertain cleanup/); assert.equal(third.signal.aborted, true);
  await h.access.handle("full", h.ctx); assert.equal(h.confirmations(), 1);
});

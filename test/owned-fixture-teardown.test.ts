import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { fixtureWorkDeadline, teardownOwnedFixture } from "./helpers/owned-fixture-teardown.ts";

test("owned fixture expiry cancels and drains work even if the framework signal stays live", async t => {
  const framework = new AbortController(), owner = fixtureWorkDeadline(framework.signal, 20), events: string[] = [];
  t.after(owner.close);
  const work = new Promise<void>(resolve => owner.signal.addEventListener("abort", () => queueMicrotask(() => { events.push("settled"); resolve(); }), { once: true }));
  await once(owner.signal, "abort");
  assert.equal(framework.signal.aborted, false); assert.match(owner.signal.reason.message, /deadline exceeded/);
  await teardownOwnedFixture({ async stop() { owner.close(); events.push("stop"); }, invocations: () => [work],
    async release() { events.push("release"); }, async hasMarker() { return false; }, async remove() { events.push("remove"); }, reset() { events.push("reset"); } });
  assert.ok(events.indexOf("settled") < events.indexOf("release"));
  assert.ok(events.indexOf("release") < events.indexOf("remove")); assert.equal(events.at(-1), "reset");
});

test("closing or upstream cancellation clears the owned deadline without aborting the framework", t => {
  const clear = t.mock.method(globalThis, "clearTimeout");
  for (const upstream of [false, true]) {
    const framework = new AbortController(), owner = fixtureWorkDeadline(framework.signal, 60_000);
    t.after(owner.close); const before = clear.mock.callCount();
    if (upstream) framework.abort(); else owner.close();
    assert.equal(owner.signal.aborted, true); assert.equal(framework.signal.aborted, upstream);
    assert.ok(clear.mock.callCount() > before); owner.close();
  }
});

test("owned fixture teardown stops, drains and releases before touching markers or removing a root", async () => {
  const events: string[] = [];
  let settle!: () => void;
  const work = new Promise<void>(resolve => { settle = () => { events.push("settled"); resolve(); }; });
  const done = await teardownOwnedFixture({
    async stop() { events.push("stop"); queueMicrotask(settle); }, invocations: () => [work],
    async release() { events.push("release"); }, async hasMarker() { events.push("markers"); return false; },
    async remove() { events.push("remove"); }, reset() { events.push("reset"); },
  });
  assert.deepEqual(events, ["stop", "settled", "release", "markers", "remove", "reset"]);
  assert.deepEqual(done, { removed: true });
});

test("fixture cleanup never sweeps an owned root with a retained marker or unknown invocation", async () => {
  for (const unknown of [false, true]) {
    let released = 0, reset = 0;
    const work = unknown ? Promise.reject(new Error("synthetic unknown invocation")) : Promise.resolve();
    const result = await teardownOwnedFixture({ async stop() {}, invocations: () => [work], async release() { released++; },
      async hasMarker() { return !unknown; }, async remove() { assert.fail("Unknown/retained ownership is not cleanup permission"); }, reset() { reset++; } });
    assert.deepEqual(result, { removed: false }); assert.equal(released, 1); assert.equal(reset, 1);
  }
});

test("a failed stop or native resource release cannot trigger filesystem cleanup or suppress the failure", async () => {
  for (const phase of ["stop", "release"] as const) {
    let reset = 0;
    await assert.rejects(teardownOwnedFixture({ async stop() { if (phase === "stop") throw new Error("synthetic stop failure"); },
      invocations: () => [], async release() { if (phase === "release") throw new Error("synthetic release failure"); },
      async hasMarker() { assert.fail("No ownership check after failed shutdown"); },
      async remove() { assert.fail("No deletion after failed shutdown"); }, reset() { reset++; } }));
    assert.equal(reset, 1);
  }
});

test("marker I/O uncertainty preserves the root while completing fixture environment reset", async () => {
  let reset = 0;
  await assert.rejects(teardownOwnedFixture({ async stop() {}, invocations: () => [], async release() {},
    async hasMarker() { throw new Error("synthetic marker uncertainty"); }, async remove() { assert.fail("Unknown marker state"); }, reset() { reset++; } }));
  assert.equal(reset, 1);
});

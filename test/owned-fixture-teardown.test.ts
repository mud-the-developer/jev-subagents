import assert from "node:assert/strict";
import { test } from "node:test";
import { teardownOwnedFixture } from "./helpers/owned-fixture-teardown.ts";

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

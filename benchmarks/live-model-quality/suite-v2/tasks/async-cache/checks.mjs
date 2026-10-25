import assert from "node:assert/strict";
import { createAsyncCache } from "./cache.mjs";
import { createUserClient } from "./client.mjs";
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => Promise.resolve();
const cases = [
  ["constructor_validation", () => {
    for (const options of [{ load: 1, now: () => 0, ttlMs: 1 }, { load: () => 1, now: 1, ttlMs: 1 }, ...[-1, NaN, Infinity, "1"].map(ttlMs => ({ load: () => 1, now: () => 0, ttlMs }))]) assert.throws(() => createAsyncCache(options), TypeError);
  }],
  ["invalid_key_never_loads", () => {
    let calls = 0; const c = createAsyncCache({ load: () => { calls++; }, now: () => 0, ttlMs: 1 });
    for (const key of [null, 1, "", undefined]) { assert.throws(() => c.get(key), TypeError); assert.throws(() => c.invalidate(key), TypeError); }
    assert.equal(calls, 0);
  }],
  ["pending_single_flight", async () => {
    let calls = 0, now = 0; const d = defer(), c = createAsyncCache({ load: () => { calls++; return d.promise; }, now: () => now, ttlMs: 10 });
    const a = c.get("a"); now = 100; const b = c.get("a"); await turn();
    assert.equal(calls, 1); d.resolve("value"); assert.deepEqual(await Promise.all([a, b]), ["value", "value"]);
  }],
  ["keys_are_independent", async () => {
    const seen = []; const c = createAsyncCache({ load: key => { seen.push(key); return key; }, now: () => 0, ttlMs: 10 });
    assert.deepEqual(await Promise.all([c.get("a"), c.get("b")]), ["a", "b"]); assert.deepEqual(seen.sort(), ["a", "b"]);
  }],
  ["ttl_begins_at_resolution", async () => {
    let now = 0, calls = 0; const d = defer(), c = createAsyncCache({ load: () => ++calls === 1 ? d.promise : "new", now: () => now, ttlMs: 10 });
    const first = c.get("a"); await turn(); now = 100; d.resolve("old"); await first;
    now = 109; assert.equal(await c.get("a"), "old"); assert.equal(calls, 1);
    now = 110; assert.equal(await c.get("a"), "new"); assert.equal(calls, 2);
  }],
  ["zero_ttl_only_shares_pending", async () => {
    let calls = 0; const d = defer(), c = createAsyncCache({ load: () => ++calls === 1 ? d.promise : "next", now: () => 0, ttlMs: 0 });
    const a = c.get("a"), b = c.get("a"); await turn(); assert.equal(calls, 1); d.resolve("first"); await Promise.all([a, b]);
    assert.equal(await c.get("a"), "next"); assert.equal(calls, 2);
  }],
  ["undefined_is_cached", async () => {
    let calls = 0; const c = createAsyncCache({ load: () => { calls++; }, now: () => 0, ttlMs: 10 });
    assert.equal(await c.get("a"), undefined); assert.equal(await c.get("a"), undefined); assert.equal(calls, 1);
  }],
  ["sync_throw_becomes_rejection", async () => {
    const c = createAsyncCache({ load: () => { throw new Error("synthetic"); }, now: () => 0, ttlMs: 1 });
    let result; assert.doesNotThrow(() => { result = c.get("a"); }); assert.ok(result instanceof Promise); await assert.rejects(result);
  }],
  ["rejections_are_not_cached", async () => {
    let calls = 0; const c = createAsyncCache({ load: async () => { if (++calls === 1) throw new Error("synthetic"); return "ok"; }, now: () => 0, ttlMs: 10 });
    await assert.rejects(c.get("a")); assert.equal(await c.get("a"), "ok"); assert.equal(calls, 2);
  }],
  ["invalidate_cached_key", async () => {
    let calls = 0; const c = createAsyncCache({ load: () => ++calls, now: () => 0, ttlMs: 10 });
    assert.equal(await c.get("a"), 1); c.invalidate("a"); assert.equal(await c.get("a"), 2);
  }],
  ["stale_resolution_cannot_replace_new_entry", async () => {
    const a = defer(), b = defer(); let calls = 0;
    const c = createAsyncCache({ load: () => ++calls === 1 ? a.promise : b.promise, now: () => 0, ttlMs: 10 });
    const old = c.get("a"); await turn(); c.invalidate("a"); const current = c.get("a"); await turn(); assert.equal(calls, 2);
    a.resolve("old"); assert.equal(await old, "old"); const joined = c.get("a"); await turn(); assert.equal(calls, 2);
    b.resolve("new"); assert.deepEqual(await Promise.all([current, joined, c.get("a")]), ["new", "new", "new"]);
  }],
  ["stale_rejection_cannot_erase_new_entry", async () => {
    const a = defer(), b = defer(); let calls = 0;
    const c = createAsyncCache({ load: () => ++calls === 1 ? a.promise : b.promise, now: () => 0, ttlMs: 10 });
    const old = c.get("a"); await turn(); c.invalidate("a"); const current = c.get("a"); await turn();
    a.reject(new Error("synthetic")); await assert.rejects(old); const joined = c.get("a"); await turn(); assert.equal(calls, 2);
    b.resolve("new"); assert.deepEqual(await Promise.all([current, joined]), ["new", "new"]);
  }],
  ["client_normalizes_both_operations", async () => {
    const seen = []; const c = createUserClient({ fetchUser: id => { seen.push(id); return id; }, now: () => 0, ttlMs: 10 });
    assert.deepEqual(await Promise.all([c.getUser(" a "), c.getUser("a")]), ["a", "a"]); assert.deepEqual(seen, ["a"]);
    c.invalidateUser(" a "); await c.getUser("a"); assert.deepEqual(seen, ["a", "a"]);
  }],
  ["client_rejects_non_string_or_blank", () => {
    let calls = 0; const c = createUserClient({ fetchUser: () => { calls++; }, now: () => 0, ttlMs: 1 });
    for (const id of [null, 1, undefined, "", "  "]) { assert.throws(() => c.getUser(id), TypeError); assert.throws(() => c.invalidateUser(id), TypeError); }
    assert.equal(calls, 0);
  }],
];
const results = [];
for (const [name, check] of cases) { try { await check(); results.push({ name, passed: true }); } catch { results.push({ name, passed: false }); } }
const passed = results.filter(value => value.passed).length;
console.log(JSON.stringify({ task: "async-cache", total: cases.length, passed, failed: cases.length - passed, results }));
if (passed !== cases.length) process.exitCode = 1;

import assert from "node:assert/strict";
import { isValidUser, canAccess } from "./policy.mjs";
import { handle } from "./gateway.mjs";
const member = Object.freeze({ id: "alice", role: "member" }), admin = Object.freeze({ id: "root", role: "admin" });
const record = Object.freeze({ id: "record1", ownerId: "alice", title: "before", archived: false, secret: "SYNTHETIC_NOT_A_CREDENTIAL" });
function fixture(found = record) {
  const calls = [];
  const repo = { async findById(id) { calls.push(["find", id]); return found; }, async updateTitle(id, title) { calls.push(["update", id, title]); return { ...record, title, secret: "not-disclosed" }; }, async delete(id) { calls.push(["delete", id]); } };
  return { calls, repo };
}
const request = (method, user = member, body) => Object.freeze({ method, user, id: "record1", ...(body === undefined ? {} : { body }) });
const cases = [
  ["user_own_fields_required", () => {
    for (const user of [null, {}, [], { id: "alice", role: "superuser" }, { id: "", role: "admin" }, { id: "Alice", role: "admin" }, Object.create(admin)]) assert.equal(isValidUser(user), false);
    assert.equal(isValidUser(member), true); assert.equal(isValidUser(admin), true);
  }],
  ["members_only_own_read_update", () => {
    assert.equal(canAccess(member, "read", record), true); assert.equal(canAccess(member, "update", record), true);
    assert.equal(canAccess({ id: "bob", role: "member" }, "read", record), false); assert.equal(canAccess(member, "delete", record), false);
  }],
  ["admin_delete_requires_archived", () => {
    assert.equal(canAccess(admin, "read", record), true); assert.equal(canAccess(admin, "delete", record), false);
    assert.equal(canAccess(admin, "delete", { ...record, archived: true }), true);
  }],
  ["policy_defaults_deny_malformed_records_actions", () => {
    for (const value of [null, [], {}, { ...record, archived: "true" }, { ...record, ownerId: null }, Object.create(record)]) assert.equal(canAccess(admin, "read", value), false);
    assert.equal(canAccess(admin, "execute", record), false); assert.equal(canAccess(null, "read", record), false);
  }],
  ["unknown_method_no_repo_access", async () => { const f = fixture(); assert.deepEqual(await handle(request("POST"), f.repo), { status: 405, body: null }); assert.deepEqual(f.calls, []); }],
  ["null_request_bad_request", async () => { const f = fixture(); assert.deepEqual(await handle(null, f.repo), { status: 400, body: null }); assert.deepEqual(f.calls, []); }],
  ["unauthenticated_no_lookup", async () => { const f = fixture(); assert.deepEqual(await handle(request("GET", null), f.repo), { status: 401, body: null }); assert.deepEqual(f.calls, []); }],
  ["bad_id_no_lookup", async () => { const f = fixture(); assert.deepEqual(await handle({ ...request("GET"), id: "../record1" }, f.repo), { status: 400, body: null }); assert.deepEqual(f.calls, []); }],
  ["not_found", async () => { const f = fixture(null); assert.deepEqual(await handle(request("GET"), f.repo), { status: 404, body: null }); assert.deepEqual(f.calls, [["find", "record1"]]); }],
  ["wrong_resource_id_denied", async () => { const f = fixture({ ...record, id: "other" }); assert.deepEqual(await handle(request("PATCH", member, { title: "new" }), f.repo), { status: 403, body: null }); assert.deepEqual(f.calls, [["find", "record1"]]); }],
  ["get_returns_public_projection_only", async () => { const f = fixture(); assert.deepEqual(await handle(request("GET"), f.repo), { status: 200, body: { id: "record1", title: "before" } }); assert.deepEqual(f.calls, [["find", "record1"]]); }],
  ["foreign_owner_denied_no_write", async () => { const f = fixture(); assert.deepEqual(await handle(request("PATCH", { id: "bob", role: "member" }, { title: "new" }), f.repo), { status: 403, body: null }); assert.deepEqual(f.calls, [["find", "record1"]]); }],
  ["patch_body_validation_precedes_lookup", async () => {
    for (const body of [null, [], {}, { title: " " }, { title: 1 }, { title: "x".repeat(81) }, { title: "new", ownerId: "bob" }, Object.create({ title: "new" })]) {
      const f = fixture(); assert.deepEqual(await handle(request("PATCH", member, body), f.repo), { status: 400, body: null }); assert.deepEqual(f.calls, []);
    }
  }],
  ["patch_trims_and_does_not_leak_repo_result", async () => {
    const body = Object.freeze({ title: " new title " }), req = request("PATCH", member, body), before = JSON.stringify(req), f = fixture();
    assert.deepEqual(await handle(req, f.repo), { status: 200, body: { id: "record1", title: "new title" } });
    assert.deepEqual(f.calls, [["find", "record1"], ["update", "record1", "new title"]]); assert.equal(JSON.stringify(req), before); assert.equal(record.title, "before");
  }],
  ["unarchived_admin_delete_no_mutation", async () => { const f = fixture(); assert.deepEqual(await handle(request("DELETE", admin), f.repo), { status: 403, body: null }); assert.deepEqual(f.calls, [["find", "record1"]]); }],
  ["archived_admin_delete_once", async () => { const f = fixture(Object.freeze({ ...record, archived: true })); assert.deepEqual(await handle(request("DELETE", admin), f.repo), { status: 204, body: null }); assert.deepEqual(f.calls, [["find", "record1"], ["delete", "record1"]]); }],
  ["repository_rejections_propagate", async () => {
    const f = fixture(); f.repo.updateTitle = async () => { throw new Error("synthetic repository rejection"); };
    await assert.rejects(handle(request("PATCH", member, { title: "new" }), f.repo));
    await assert.rejects(handle(request("GET"), { findById: async () => { throw new Error("synthetic lookup rejection"); } }));
  }],
];
const results = [];
for (const [name, check] of cases) { try { await check(); results.push({ name, passed: true }); } catch { results.push({ name, passed: false }); } }
const passed = results.filter(value => value.passed).length;
console.log(JSON.stringify({ task: "record-gateway", total: cases.length, passed, failed: cases.length - passed, results }));
if (passed !== cases.length) process.exitCode = 1;

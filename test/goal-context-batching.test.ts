import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { contextSnapshot, checkGoalContext, goalContextSnapshotPlan, goalControlFileIO } from "../src/goal-run-effects.ts";
import { GOAL_RUN_ERROR } from "../src/goal-run.ts";

const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "jev-context-batch-")), cwd = path.join(root, "work"), agentDirectory = path.join(root, "config");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd); await mkdir(agentDirectory);
  const profile = path.join(agentDirectory, "agents", "worker.md"), files = [{ path: "src/deep/fixture.txt" }];
  const plan = goalContextSnapshotPlan(cwd, agentDirectory, profile, files);
  return { cwd, agentDirectory, profile, files, plan };
}
function row(text: string) {
  const digest = createHash("sha256").update(text).digest("hex");
  return { text, version: { identity: { dev: 1, ino: "ntfs:0000000000000001" }, stamp: digest, digest, bytes: Buffer.byteLength(text) } };
}

test("context plan preserves profile/models and every ordered named rule without discovery, mutation or deduplication of aliases", () => {
  const cwd = path.resolve("synthetic-work"), agent = path.resolve("synthetic-config"), profile = path.join(agent, "agents", "worker.md");
  const files = Object.freeze([Object.freeze({ path: "src/deep/a.txt" }), Object.freeze({ path: "src/deep/b.txt" })]);
  const before = structuredClone(files), plan = goalContextSnapshotPlan(cwd, agent, profile, files);
  assert.deepEqual(plan.paths.slice(0, 2), [profile, path.join(agent, "models.json")]);
  assert.deepEqual(plan.paths.slice(2), plan.directories.flatMap(dir => names.map(name => path.join(dir, name))));
  assert.equal(plan.directories[0], agent); assert.ok(plan.directories.indexOf(path.parse(cwd).root) < plan.directories.indexOf(cwd));
  assert.equal(plan.directories.filter(dir => dir === path.join(cwd, "src", "deep")).length, 1);
  assert.deepEqual(files, before); assert.deepEqual(goalContextSnapshotPlan(cwd, agent, profile, files), plan);
});

test("context path overflow is rejected before any native snapshot; the original 128-path bound includes profile/models", async t => {
  const snapshot = t.mock.method(goalControlFileIO, "snapshot", async () => assert.fail("No I/O after invalid plan"));
  const cwd = path.resolve("synthetic-work"), agent = path.resolve("synthetic-config"), profile = path.join(agent, "agents", "worker.md");
  const files = [{ path: Array.from({ length: 128 }, (_, i) => `dir-${i}`).join("/") + "/file.txt" }];
  assert.throws(() => goalContextSnapshotPlan(cwd, agent, profile, files), { message: GOAL_RUN_ERROR });
  await assert.rejects(contextSnapshot(cwd, agent, profile, files), { message: GOAL_RUN_ERROR });
  assert.equal(snapshot.mock.callCount(), 0);
});

test("Windows context preparation uses one fresh held-handle batch, preserves priority/missing rows and keeps profile/model text out of state", async t => {
  const f = await fixture(t);
  // On other native hosts this is only a portable path-plan assertion, never an OS/UID impersonation.
  if (process.platform !== "win32") { assert.equal(f.plan.paths.length, f.plan.directories.length * names.length + 2); return; }
  const snapshot = t.mock.method(goalControlFileIO, "snapshot", async (paths: readonly string[]) => paths.map(value =>
    value === f.profile ? row("SYNTHETIC_PROFILE_ONLY") : value === f.plan.paths[1] ? row("SYNTHETIC_MODEL_ONLY") :
      value === path.join(f.cwd, "AGENTS.override.md") ? row("Selected override") : value === path.join(f.cwd, "AGENTS.md") ? row("Inactive fallback") : null));
  const context = await contextSnapshot(f.cwd, f.agentDirectory, f.profile, f.files);
  assert.equal(snapshot.mock.callCount(), 1); assert.deepEqual(snapshot.mock.calls[0]!.arguments[0], f.plan.paths);
  assert.deepEqual(context.map(entry => entry.path), f.plan.paths);
  assert.ok(!JSON.stringify(context).includes("SYNTHETIC_PROFILE_ONLY")); assert.ok(!JSON.stringify(context).includes("SYNTHETIC_MODEL_ONLY"));
  assert.equal(context.find(entry => entry.path === path.join(f.cwd, "AGENTS.override.md"))?.text, "Selected override");
  assert.equal(context.find(entry => entry.path === path.join(f.cwd, "AGENTS.md"))?.text, null);
  assert.equal(context.find(entry => entry.path === path.join(f.cwd, "missing.md")), undefined);
  assert.ok(context.some(entry => entry.version === null && entry.text === null && !entry.active));
  await checkGoalContext({ body: { context } });
  assert.equal(snapshot.mock.callCount(), 2); assert.deepEqual(snapshot.mock.calls[1]!.arguments[0], f.plan.paths);
});

test("missing profile or failed combined Windows snapshot never retries smaller batches or admits a context", async t => {
  const f = await fixture(t);
  if (process.platform !== "win32") { assert.equal(f.plan.paths[0], f.profile); return; }
  const snapshot = t.mock.method(goalControlFileIO, "snapshot", async (paths: readonly string[]) => paths.map(() => null));
  await assert.rejects(contextSnapshot(f.cwd, f.agentDirectory, f.profile, f.files), { message: GOAL_RUN_ERROR });
  assert.equal(snapshot.mock.callCount(), 1);
  snapshot.mock.mockImplementation(async () => { throw new Error("Synthetic native refusal"); });
  await assert.rejects(contextSnapshot(f.cwd, f.agentDirectory, f.profile, f.files), { message: "Synthetic native refusal" });
  assert.equal(snapshot.mock.callCount(), 2);
});

test("the post-preparation fresh check still refuses a changed profile rather than reusing the combined version", async t => {
  const f = await fixture(t);
  if (process.platform !== "win32") { assert.equal(f.plan.paths[1], path.join(f.agentDirectory, "models.json")); return; }
  const snapshot = t.mock.method(goalControlFileIO, "snapshot", async (paths: readonly string[]) => paths.map(value => value === f.profile ? row("Initial profile") : null));
  const context = await contextSnapshot(f.cwd, f.agentDirectory, f.profile, f.files);
  snapshot.mock.mockImplementation(async (paths: readonly string[]) => paths.map(value => value === f.profile ? row("Changed profile") : null));
  await assert.rejects(checkGoalContext({ body: { context } }), { message: GOAL_RUN_ERROR });
  assert.equal(snapshot.mock.callCount(), 2);
});

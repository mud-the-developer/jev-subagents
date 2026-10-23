import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reduceStudio, type StudioState, type StudioReview } from "../src/setup-studio-machine.ts";
import { SetupStudioOwner, registerSetupStudio } from "../src/setup-studio.ts";
import { bunWorkerOptions } from "../src/worker-runtime.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
const review: StudioReview = Object.freeze({ id: "synthetic-review", deadline: 2000, packet: "exact synthetic packet", profiles: Object.freeze([
  Object.freeze({ file: "/synthetic/scout.md", content: "readonly synthetic" }), Object.freeze({ file: "/synthetic/worker.md", content: "synthetic" }),
]) });
function waiting(): StudioState { return reduceStudio({ phase: "checking", operation: "setup" }, { type: "review", review }).state; }

test("Studio pure reducer binds full packet, reviewed files, exact id, deadline and consumes approval once", () => {
  const initial = waiting();
  const approved = reduceStudio(initial, { type: "decision", id: review.id, packet: review.packet, accepted: true, reviewed: review.profiles.map(p => p.file), now: 1000 });
  assert.equal(approved.state.phase, "creating"); assert.deepEqual(approved.effects, [{ type: "resolve-review", accepted: true }]);
  assert.deepEqual(reduceStudio(approved.state, { type: "decision", id: review.id, packet: review.packet, accepted: true, reviewed: review.profiles.map(p => p.file), now: 1000 }).effects, []);
  for (const data of [ { packet: "modified" }, { reviewed: [] }, { reviewed: [review.profiles[0]!.file, review.profiles[0]!.file] }, { now: 2000 }, { accepted: false } ]) {
    const denied = reduceStudio(waiting(), { type: "decision", id: review.id, packet: review.packet, accepted: true, reviewed: review.profiles.map(p => p.file), now: 1000, ...data });
    assert.equal(denied.state.phase, "cancelled"); assert.deepEqual(denied.effects, [{ type: "resolve-review", accepted: false }]);
  }
  assert.equal(initial.phase, "review");
});

test("Studio cannot revive wrong session, busy start, cancelled or late review", () => {
  const current = waiting();
  assert.equal(reduceStudio(current, { type: "decision", id: "other-session", packet: review.packet, accepted: true, reviewed: [], now: 1000 }).state, current);
  assert.equal(reduceStudio(current, { type: "start", operation: "status" }).state, current);
  const cancelled = reduceStudio(current, { type: "cancel", reason: "closed" });
  assert.deepEqual(cancelled.effects, [{ type: "resolve-review", accepted: false }]);
  assert.deepEqual(reduceStudio(cancelled.state, { type: "review", review }).effects, []);
  assert.deepEqual(reduceStudio({ phase: "idle" }, { type: "start", operation: "status" }).effects, [{ type: "run", operation: "status" }]);
});

async function fixture(t: TestContext) {
  const { execPath: bun } = bunWorkerOptions();
  const previous = process.env;
  const directory = await mkdtemp(path.join(os.tmpdir(), "jev-studio-fixture-")), bin = path.join(directory, "bin"), agentDir = path.join(directory, "agent");
  await mkdir(bin); await mkdir(agentDir);
  process.env = { SystemRoot: previous.SystemRoot, TEMP: previous.TEMP, TMP: previous.TMP, PATH: bin + path.delimiter + path.dirname(process.execPath),
    PI_CODING_AGENT_DIR: agentDir, HOME: directory, JEV_BUN_EXECUTABLE: bun };
  t.after(async () => { process.env = previous; await rm(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network in offline Studio tests"); });
  if (process.getuid) t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => 1000);
  const cli = process.platform === "win32" ? path.join(bin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js") : path.join(bin, "pi");
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, `#!/usr/bin/env ${process.versions.bun ? "bun" : "node"}\nconsole.log('0.85.1');\n`, { mode: 0o755 });
  if (process.platform === "win32") await writeFile(path.join(bin, "pi.cmd"), "@echo off\r\n");
  const owner = new SetupStudioOwner(root, () => false);
  owner.context({ mode: "print", hasUI: true, isIdle: () => true } as ExtensionContext);
  t.after(() => owner.dispose());
  const { lease } = owner.attach({});
  const heartbeat = setInterval(() => { try { owner.heartbeat({ lease }); } catch { /* Replaced viewer is revoked. */ } }, 1000); t.after(() => clearInterval(heartbeat));
  return { owner, agentDir, lease };
}
function until(owner: SetupStudioOwner, phase: string, signal: AbortSignal): Promise<void> {
  if (owner.state.phase === phase) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Studio fixture did not reach " + phase + ": " + owner.state.phase)); }, 20_000);
    const unsubscribe = owner.subscribe(state => {
      if (state.phase === phase) { clearTimeout(timer); unsubscribe(); resolve(); }
      else if (["error", "cancelled", "complete"].includes(state.phase)) { clearTimeout(timer); unsubscribe(); reject(new Error(`Studio stopped at ${state.phase} before ${phase}`)); }
    });
    signal.addEventListener("abort", () => { clearTimeout(timer); unsubscribe(); reject(signal.reason); }, { once: true });
  });
}

test("Studio actual checked creation needs explicit exact review, rejects replay and preserves user files", { timeout: 30_000 }, async t => {
  const { owner, agentDir, lease } = await fixture(t);
  owner.start({ operation: "setup", lease }); await until(owner, "review", t.signal);
  assert.equal(owner.state.phase, "review"); if (owner.state.phase !== "review") assert.fail();
  const receipt = { ...owner.state.review };
  for (const profile of receipt.profiles) await assert.rejects(readFile(profile.file), { code: "ENOENT" });
  assert.throws(() => owner.decide({ id: receipt.id, packet: receipt.packet, reviewed: [], accepted: "yes", lease }));
  assert.equal(owner.decide({ id: receipt.id, packet: receipt.packet, reviewed: receipt.profiles.map(p => p.file), accepted: true, lease }).accepted, true);
  await until(owner, "complete", t.signal);
  assert.match(await readFile(path.join(agentDir, "agents", "worker.md"), "utf8"), /gpt-5.6-luna/);
  assert.throws(() => owner.decide({ id: receipt.id, packet: receipt.packet, reviewed: receipt.profiles.map(p => p.file), accepted: true, lease }));
});

test("Studio cancellation and new viewer revoke pending authority without creating profiles", { timeout: 30_000 }, async t => {
  const { owner, agentDir, lease } = await fixture(t);
  owner.start({ operation: "setup", lease }); await until(owner, "review", t.signal);
  assert.equal(owner.state.phase, "review"); if (owner.state.phase !== "review") assert.fail();
  const receipt = owner.state.review;
  owner.attach({}); await until(owner, "cancelled", t.signal);
  assert.throws(() => owner.decide({ id: receipt.id, packet: receipt.packet, reviewed: receipt.profiles.map(p => p.file), accepted: true, lease }));
  await assert.rejects(readFile(path.join(agentDir, "agents", "worker.md")), { code: "ENOENT" });
});

test("Studio read-only status reports actual worker imports without approval or network", { timeout: 30_000 }, async t => {
  const { owner, lease } = await fixture(t);
  owner.start({ operation: "status", lease }); await until(owner, "complete", t.signal);
  assert.equal(owner.state.phase, "complete"); if (owner.state.phase !== "complete") assert.fail();
  assert.equal(owner.state.report?.workerVersion, "0.85.1");
  assert.ok(owner.state.report?.profiles.every(p => p.status === "missing"));
});

test("Desktop view registers once, discovery reuses declaration and lifecycle cancels owner", async t => {
  let declaration: unknown, count = 0;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { events: { emit: (name: string, input: { declaration: unknown; accept: () => void }) => {
    if (name.endsWith(":register")) { count++; if (declaration) assert.equal(input.declaration, declaration); declaration = input.declaration; input.accept(); }
  }, on: (name: string, callback: (...args: unknown[]) => unknown) => { handlers.set(name, callback); return () => handlers.delete(name); } },
  on: (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback),
  } as unknown as ExtensionAPI;
  const registered = registerSetupStudio(pi, root, () => false)!;
  t.after(() => registered.owner.dispose());
  assert.equal(registered.available, true); handlers.get("pi-gui:desktop-view:discover")!(); assert.equal(count, 2);
  await handlers.get("session_shutdown")!(); assert.equal(registered.available, false);
});

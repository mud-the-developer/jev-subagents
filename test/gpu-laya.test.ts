import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import childProcess, { type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GPU_LAYA, GPU_STAGES, gpuPacket, reduceGpu, validGpuPlan } from "../src/gpu-laya.ts";
import { createGpuInstaller, gpuInstallIO, gpuEnvironment, type OwnedGpu } from "../src/gpu-laya-effects.ts";
import { allowedGpuDownload, downloadGpuFile, uvExecutable } from "../src/gpu-laya-download-effects.ts";
import { validGpuManifest } from "../src/gpu-laya-worker.ts";
import { reduceSessionSetup, sessionChoices } from "../src/session-setup.ts";
import { registerManagedJev, readJevConnection, withJevSession } from "../src/jev-config.ts";
import { SESSION_SETUP_ENTRY, validBackendSelection } from "../src/jev-backend.ts";
import type { WindowsJob } from "../src/windows-job.ts";
import { sequencePlan, validSequenceInput, type SequenceGrant, type SequenceInput } from "../src/goal-sequence.ts";
const plan = { version: 1 as const, mode: "install" as const, root: "C:\\fixture\\laya-gpu-v1", sourceDigest: "a".repeat(64), runtimeExecutable: "C:\\bun\\bun.exe", workerScript: "C:\\source\\gpu-laya-worker.ts" };
const signal = () => new AbortController().signal;
const ctx = (id = "gpu-fixture"): ExtensionContext => ({ hasUI: true, mode: "rpc", ui: { setStatus() {} }, sessionManager: { getSessionId: () => id } }) as unknown as ExtensionContext;
function boundaries(t: TestContext) {
  t.mock.method(gpuInstallIO, "platform", () => ({ os: "win32", arch: "x64" }));
  t.mock.method(gpuInstallIO, "inspect", async () => ({ ...plan }));
  t.mock.method(gpuInstallIO, "sourceDigest", async () => plan.sourceDigest);
}
async function temporary(t: TestContext) { const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-gpu-fixture-"))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("parent dispatch pure policy binds explicit profiles per criterion without invented JEV support or authority", () => {
  const input: SequenceInput = { task: "Synthetic task", agent: "worker", planner: "planner", files: [{ path: "fixture.txt", access: "read_write" }], journalDirectory: "C:\\private-journal",
    acceptanceCriteria: ["Criterion A", "Criterion B"], nonGoals: [], maxModelCalls: 2, budget: { workerRuns: 2, plannerCalls: 3, workerCalls: 4, totalCalls: 7, durationSeconds: 120 },
    dispatch: { additionalAgents: ["strong"], assignments: [{ criterionId: "criterion-1", agent: "strong" }, { criterionId: "criterion-2", agent: "worker" }] } };
  assert.ok(validSequenceInput(input)); assert.equal(validSequenceInput({ ...input, routing: { additionalAgents: [], summary: "Public", maxCalls: 0 } }), false);
  const worker = { name: "worker", model: { provider: "offline", id: "fixed-worker" }, thinking: "low" }, strong = { name: "strong", model: { provider: "offline", id: "fixed-strong" }, thinking: "high" };
  const grant = { body: { request: { input }, run: { agent: worker }, workers: [worker, strong] } } as unknown as SequenceGrant;
  const selected = sequencePlan(grant, undefined, ["criterion-1"]); assert.equal(selected.agent, "strong"); assert.equal(selected.source, "parent"); assert.equal(selected.thinking, "high");
  assert.deepEqual(selected.model, strong.model); assert.equal("support" in selected, false);
  assert.throws(() => sequencePlan(grant, undefined, ["criterion-1", "criterion-2"]), /ambiguous/);
  assert.throws(() => sequencePlan(grant, undefined, ["criterion-8"]), /ambiguous/);
  assert.equal(validSequenceInput({ ...input, dispatch: { ...input.dispatch!, assignments: [{ criterionId: "criterion-1", agent: "outside" }, { criterionId: "criterion-2", agent: "worker" }] } }), false);
});

test("GPU reducer requires literal review, owns inputs, orders stages, and terminal states ignore late events", () => {
  const before = structuredClone(plan), review = reduceGpu({ status: "idle" }, { type: "prepare", plan });
  assert.equal(review.state.status, "reviewing"); assert.equal(review.effects[0]?.type, "review"); assert.deepEqual(plan, before);
  for (const accepted of [false, "true", 1]) assert.equal(reduceGpu(review.state, { type: "approved", accepted: accepted as boolean }).state.status, "cancelled");
  const running = reduceGpu(review.state, { type: "approved", accepted: true }); assert.equal(running.effects[0]?.type, "run");
  assert.equal(reduceGpu(running.state, { type: "ready", origin: "http://127.0.0.1:5555" }).state.status, "failed");
  let state = running.state; for (const stage of GPU_STAGES) state = reduceGpu(state, { type: "progress", stage }).state;
  const ready = reduceGpu(state, { type: "ready", origin: "http://127.0.0.1:5555" }).state; assert.equal(ready.status, "ready");
  assert.equal(reduceGpu(ready, { type: "fail" }).state, ready);
  assert.equal(reduceGpu(state, { type: "progress", stage: "torch" }).state.status, "failed");
  for (const origin of ["http://localhost:5555", "http://127.0.0.1:65536", "https://evil.invalid"]) assert.equal(reduceGpu(state, { type: "ready", origin }).state.status, "failed");
  assert.equal(validGpuPlan({ ...plan, command: "arbitrary" }), false); assert.equal(validGpuPlan({ ...plan, mode: "cpu" }), false);
});

test("native installation packet pins sources, uv venv, GPU-only commands, boundaries and uncertainty", () => {
  const packet = gpuPacket(plan);
  for (const value of [GPU_LAYA.uvSha256, GPU_LAYA.sourceSha256, GPU_LAYA.weightsSha256, GPU_LAYA.revision, "uv venv", "uv pip", "--no-registry", "20 GiB", "20 minutes", "third-party", "CPU", "transitive dependency", "Global Python"]) assert.ok(packet.includes(value));
  assert.doesNotMatch(packet, /python -m pip|pip install -e|0\.0\.0\.0|fixture-private/);
});

test("GPU install option is not discovered/ready or activation permission; only owned Laya can be saved", () => {
  const origin = "http://127.0.0.1:8080", availability = { results: [{ origin, presets: [], status: "unavailable" as const }], typesafeReady: false, gpuLaya: "install" as const };
  const choices = sessionChoices(availability, [origin]); assert.deepEqual(choices.map(c => c.id), ["gpu-laya", "off"]); assert.deepEqual(choices[0]?.selection, { mode: "off" });
  const transition = reduceSessionSetup({ status: "choosing", sessionId: "s", choices, localCount: 0 }, { type: "choose", id: "gpu-laya" });
  assert.equal(transition.state.status, "installing"); assert.equal(transition.effects[0]?.type, "install");
  assert.equal(reduceSessionSetup(transition.state, { type: "installed", selection: { mode: "typesafe" } }).state.status, "failed");
  assert.equal(reduceSessionSetup(transition.state, { type: "installed", selection: { mode: "local", preset: "laya", origin } }).state.status, "failed");
  const selected = { mode: "local" as const, preset: "laya" as const, origin: "http://127.0.0.1:59999", managed: true as const };
  assert.equal(reduceSessionSetup(transition.state, { type: "installed", selection: selected }).state.status, "saving");
  assert.equal(validBackendSelection({ ...selected, preset: "clef" }), false);
});

test("decline, missing UI, abort and changed source never launch installation", async t => {
  boundaries(t); const start = t.mock.method(gpuInstallIO, "start", async () => assert.fail("No execution"));
  const declined = createGpuInstaller(async () => false); assert.equal(await declined.activate(ctx(), signal(), () => true), undefined);
  assert.equal(await createGpuInstaller(async () => true).activate({ ...ctx(), hasUI: false }, signal(), () => true), undefined);
  const cancelled = new AbortController(); cancelled.abort(); assert.equal(await createGpuInstaller(async () => true).activate(ctx(), cancelled.signal, () => true), undefined);
  t.mock.method(gpuInstallIO, "sourceDigest", async () => "b".repeat(64));
  await assert.rejects(createGpuInstaller(async () => true).activate(ctx(), signal(), () => true), /Changed installer source/); assert.equal(start.mock.callCount(), 0);
});

test("approved managed runtime reuses only current live ownership and closes without persisted execution grants", async t => {
  boundaries(t); let live = true, approvals = 0;
  const handle: OwnedGpu = { origin: "http://127.0.0.1:59999", alive: () => live, async close() { live = false; return true; } };
  const start = t.mock.method(gpuInstallIO, "start", async (...[_plan, _signal, stage]: Parameters<typeof gpuInstallIO.start>) => { stage("server"); return handle; });
  const installer = createGpuInstaller(async () => { approvals++; return true; });
  const first = await installer.activate(ctx("owned-one"), signal(), () => true); assert.equal(first?.mode, "local");
  assert.deepEqual(await installer.activate(ctx("owned-one"), signal(), () => true), first); assert.equal(approvals, 1); assert.equal(start.mock.callCount(), 1);
  assert.equal(await installer.available("owned-one"), "running"); assert.equal(await installer.close(), true); assert.equal(installer.alive("owned-one"), false);
});

test("session movement after readiness closes late server, and uncertain closure retains ownership", async t => {
  boundaries(t); let current = true, closes = 0;
  t.mock.method(gpuInstallIO, "start", async (...[_plan, _signal, stage]: Parameters<typeof gpuInstallIO.start>) => { stage("server"); current = false; return { origin: "http://127.0.0.1:59998", alive: () => false, async close() { closes++; return false; } }; });
  const installer = createGpuInstaller(async () => true);
  await assert.rejects(installer.activate(ctx(), signal(), () => current), /ownership retained/); assert.equal(closes, 1); assert.equal(await installer.close(), false);
});

test("managed selection strips remote credentials, fails after close/reload and cannot inherit another session's process", t => {
  let live = true; const id = "managed-connection-test", origin = "http://127.0.0.1:55555";
  registerManagedJev(id, origin, () => live);
  const entries = [{ type: "custom", customType: SESSION_SETUP_ENTRY, data: { version: 1, sessionId: id, outcome: "selected", selection: { mode: "local", preset: "laya", origin, managed: true } } }];
  const context = { hasUI: true, sessionManager: { getSessionId: () => id, getBranch: () => entries, getEntries: () => entries } } as unknown as ExtensionContext;
  const old = process.env.OPENJEV_API_KEY; process.env.OPENJEV_API_KEY = "fixture-private-remote-key";
  t.after(() => { if (old === undefined) delete process.env.OPENJEV_API_KEY; else process.env.OPENJEV_API_KEY = old; });
  const cfg = withJevSession(context, readJevConnection); assert.ok(cfg.ok); assert.equal(cfg.connection.apiKey, null);
  live = false; assert.equal(withJevSession(context, readJevConnection).ok, false);
  const reloaded = { ...context, sessionManager: { getSessionId: () => "unowned-id", getBranch: () => entries.map(e => ({ ...e, data: { ...e.data, sessionId: "unowned-id" } })), getEntries: () => [] } } as unknown as ExtensionContext;
  assert.equal(withJevSession(reloaded, readJevConnection).ok, false);
});

test("child environment never inherits credentials, hooks, global Python/cache/proxy config or registry writes", () => {
  const env = gpuEnvironment(plan.root, { SystemRoot: "C:\\Windows", PATH: "node-path", TYPESAFE_API_KEY: "private", OPENJEV_API_KEY: "private", HF_TOKEN: "private",
    HTTPS_PROXY: "private", UV_INDEX_URL: "private", NODE_OPTIONS: "private", PYTHONPATH: "private", PYTHONSTARTUP: "private", HOME: "private" });
  assert.ok(!JSON.stringify(env).includes("private")); assert.equal(env.UV_PYTHON_INSTALL_REGISTRY, "0"); assert.equal(env.UV_PYTHON_INSTALL_BIN, "0");
  assert.equal(env.UV_HTTP_RETRIES, "0"); assert.equal(env.CUDA_VISIBLE_DEVICES, "0"); assert.match(env.UV_PYTHON_INSTALL_DIR!, /laya-gpu-v1/);
});

test("fixed cache manifest rejects missing/extra/mutated files, foreign source and wrong weights", () => {
  const manifest = { version: 1, sourceDigest: plan.sourceDigest, uvDigest: "a".repeat(64), helperDigest: "a".repeat(64), files: GPU_LAYA.files.map(name => ({ name, digest: name === "model.safetensors" ? GPU_LAYA.weightsSha256 : "b".repeat(64) })) };
  assert.ok(validGpuManifest(manifest, plan.sourceDigest)); assert.equal(validGpuManifest(manifest, "b".repeat(64)), false);
  assert.equal(validGpuManifest({ ...manifest, command: "bad" }, plan.sourceDigest), false);
  assert.equal(validGpuManifest({ ...manifest, files: manifest.files.slice(1) }, plan.sourceDigest), false);
  assert.equal(validGpuManifest({ ...manifest, files: manifest.files.map(f => ({ ...f, digest: "a".repeat(64) })) }, plan.sourceDigest), false);
});

test("public downloader hashes and bounds anonymous bytes; malicious redirects and overwrites fail without retries", async t => {
  const dir = await temporary(t), filename = path.join(dir, "asset"), content = Buffer.from("fixture-public-bytes"), digest = createHash("sha256").update(content).digest("hex");
  const fetcher = t.mock.method(globalThis, "fetch", async (...[_url, options]: Parameters<typeof fetch>) => { assert.equal(options?.redirect, "manual"); assert.equal(options?.headers, undefined); assert.equal(options?.body, undefined); return new Response(content); });
  assert.equal(await downloadGpuFile("https://huggingface.co/fixed", filename, 64, signal(), digest), digest);
  assert.deepEqual(await readFile(filename), content); await assert.rejects(downloadGpuFile("https://huggingface.co/fixed", filename, 64, signal(), digest));
  fetcher.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
  const calls = fetcher.mock.callCount(); await assert.rejects(downloadGpuFile("https://github.com/fixed", path.join(dir, "redirect"), 64, signal()), /Unsupported download/);
  assert.equal(fetcher.mock.callCount(), calls + 1);
  for (const value of ["http://github.com/file", "https://user:pass@github.com/file", "https://evil.invalid/file", "https://github.com:444/file"]) assert.equal(allowedGpuDownload(new URL(value)), false);
});

test("small uv archive decoder never extracts arbitrary members and bounds decompression", () => {
  function zip(name: string) {
    const n = Buffer.from(name), bytes = Buffer.from("MZfixture-only-not-executable"), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(n.length, 26); const offset = local.length + n.length + bytes.length;
    central.writeUInt32LE(0x02014b50); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(n.length, 28);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([local, n, bytes, central, n, end]);
  }
  assert.match(uvExecutable(zip("uv.exe")).toString(), /^MZfixture/);
  assert.throws(() => uvExecutable(zip("../uv.exe")), /Missing uv executable/); assert.throws(() => uvExecutable(Buffer.alloc(22)), /Invalid uv archive/);
});

test("owned transport admits no payload before Windows ownership and releases only its confirmed ready lease", async t => {
  const dir = await temporary(t), root = path.join(dir, "installation"), ownedPlan = { ...plan, root };
  t.mock.method(gpuInstallIO, "inspect", async () => ownedPlan);
  t.mock.method(gpuInstallIO, "runtime", (env = {}) => ({ execPath: ownedPlan.runtimeExecutable, execArgv: ["--no-env-file", "--no-install", "--config=C:\\trusted\\worker-bunfig.toml"], serialization: "json" as const, env }));
  const savedRoot = process.env.SystemRoot; process.env.SystemRoot = "C:\\Windows"; t.after(() => { if (savedRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = savedRoot; });
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, connected: true, kill: () => true,
    send: t.mock.fn((value: { nonce: string }, callback: (error: Error | null) => void) => { ownerNonce = value.nonce; callback(null); queueMicrotask(() => {
      child.emit("message", { type: "progress", stage: "server" }); child.emit("message", { type: "ready", origin: "http://127.0.0.1:49999" });
    }); }) });
  let ownerNonce = "", admit!: (job: WindowsJob) => void;
  t.mock.method(childProcess, "fork", () => child as unknown as ChildProcess);
  t.mock.method(gpuInstallIO, "own", () => new Promise<WindowsJob>(resolve => { admit = resolve; }));
  t.mock.method(globalThis, "fetch", async (...[url]: Parameters<typeof fetch>) => String(url).endsWith("/__jev_owned") ? Response.json({ owner: ownerNonce, model: "laya-1.0", device: "cuda:0" }) : Response.json({ data: [{ id: "laya-1.0" }] }));
  const start = gpuInstallIO.start(ownedPlan, signal(), () => {});
  for (let i = 0; i < 50 && !admit; i++) await new Promise<void>(resolve => setTimeout(resolve, 10));
  assert.equal(child.send.mock.callCount(), 0); assert.ok(admit);
  admit({ async close() { child.exitCode = 1; child.emit("close", 1); return true; } });
  const handle = await start; assert.equal(handle.alive(), true); assert.equal(child.send.mock.callCount(), 1);
  assert.equal(await handle.close(), true); assert.equal(handle.alive(), false); await assert.rejects(lstat(path.join(root, "owner.json")), { code: "ENOENT" });
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { prepareGoalFileScope, checkGoalFileScope } from "../src/goal-file-effects.ts";
import { prepareVerification, runGoalVerification } from "../src/goal-verification-effects.ts";
import { validVerificationInput, validVerificationGrant, imageEnvironment, matchesVerificationContainer, type VerificationInput, type VerificationRequest } from "../src/goal-verification.ts";
import { dockerFixture, IMAGE } from "./helpers/goal-docker-fixture.ts";

async function fixture(t: TestContext, mode = "ok", exit = 0) {
  const docker = await dockerFixture(t, mode, () => exit), cwd = path.join(docker.root, "project"), journalDirectory = path.join(docker.root, "journal"), agentDirectory = path.join(docker.root, "config");
  for (const dir of [cwd, journalDirectory, agentDirectory]) await mkdir(dir, { mode: 0o700 });
  await writeFile(path.join(cwd, "subject.mjs"), "export const value = 1;\n");
  await writeFile(path.join(cwd, "check.mjs"), "// Pinned test entry, never executed by the protocol fixture.\n");
  const protections = { journalDirectory, agentDirectory };
  const scope = await prepareGoalFileScope({ cwd, files: [{ path: "subject.mjs", access: "read_write" }] }, protections);
  const check = { id: "one", criteriaIds: ["criterion-1"], command: "/usr/local/bin/node", args: ["check.mjs", "literal;not-a-shell"], entry: "check.mjs", coverage: "One declared criterion" };
  const input: VerificationInput = { socketPath: docker.socketPath, image: IMAGE, nodePath: "/usr/local/bin/node", files: ["check.mjs"], checks: [check], final: { ...check, id: "all" },
    budget: { runs: 4, repairs: 1 }, failureProtocol: "exit_42_assertions_only" };
  const grant = await prepareVerification(input, cwd, protections);
  const run = (request: VerificationRequest = { stage: "step", checkId: "one" }, signal?: AbortSignal) => runGoalVerification(input, grant, scope, request,
    { id: "operation-1", goalId: "goal-1", activationId: "activation-1", deadline: Date.now() + 60_000 }, protections,
    async (signal) => { await checkGoalFileScope(scope, protections, signal); }, signal);
  return { ...docker, cwd, input, grant, scope, protections, run };
}

test("C2 schemas bind complete criterion groups, protected inputs and full worst-case budgets", async (t) => {
  const f = await fixture(t);
  assert.equal(validVerificationInput(f.input, 1, 2, 4, 1, 5, 2), true);
  for (const change of [
    { budget: { runs: 3, repairs: 1 } }, { failureProtocol: "no_automatic_repair" }, { image: "latest" }, { socketPath: "tcp://localhost:2375" },
    { files: ["../check.mjs"] }, { checks: [{ ...f.input.checks[0], entry: "unlisted.mjs" }] },
    { checks: [{ ...f.input.checks[0], criteriaIds: ["criterion-2"] }] }, { final: { ...f.input.final, criteriaIds: ["criterion-2"] } },
  ]) assert.equal(validVerificationInput({ ...f.input, ...change }, 1, 2, 4, 1, 5, 2), false);
  assert.equal(validVerificationInput(f.input, 1, 1, 4, 1, 5, 2), false);
  assert.equal(validVerificationInput(f.input, 1, 2, 3, 1, 5, 2), false);
  assert.equal(validVerificationGrant(f.input, f.grant, f.scope), true);
  const overlap = structuredClone(f.grant); overlap.files.files[0]!.version.identity = f.scope.files[0]!.version.identity;
  assert.equal(validVerificationGrant(f.input, overlap, f.scope), false);
  assert.deepEqual(imageEnvironment({ Id: IMAGE, Os: "linux", Config: { Env: ["TOKEN=PRIVATE", "NODE_OPTIONS=PRIVATE", "PATH=PRIVATE"] } }, IMAGE)?.slice(0, 2), ["NODE_OPTIONS=", "TOKEN="]);
});

test("C2 Unix transport pins settings, stages only named read-only files, and removes only its acknowledged container", async (t) => {
  const f = await fixture(t, "ok", 42), done = await f.run();
  assert.equal(done.started, true); assert.equal(done.cleanupConfirmed, true);
  assert.equal(done.reply.status, "exited"); assert.equal(done.reply.exitCode, 42); assert.equal(done.reply.isolated, true); assert.equal(done.reply.filesCurrent, true);
  assert.ok(done.reply.elapsedMs > 0); assert.equal(f.containers.length, 1); assert.equal(f.containers[0]!.removed, true);
  const body = f.containers[0]!.body;
  assert.deepEqual(body.Entrypoint, [f.input.nodePath, "--disable-sigusr1"]);
  assert.deepEqual(JSON.parse(body.Cmd[1]!).args, f.input.checks[0]!.args);
  assert.deepEqual(body.HostConfig.Mounts.map((mount) => mount.Target), ["/jev/guard.mjs", "/workspace/subject.mjs", "/workspace/check.mjs"]);
  assert.ok(body.Env.includes("PRIVATE_IMAGE_ENV=")); assert.ok(!JSON.stringify(body).includes("DO_NOT_INHERIT"));
  assert.equal(body.HostConfig.NetworkMode, "none"); assert.equal(body.HostConfig.ReadonlyRootfs, true); assert.equal(body.HostConfig.Init, false);
  assert.deepEqual(body.HostConfig.CapDrop, ["ALL"]); assert.deepEqual(body.HostConfig.LogConfig, { Type: "none", Config: {} });
  assert.equal(f.requests.filter((request) => request.route.endsWith("/start")).length, 1);
  assert.ok(f.requests.every((request) => !/logs|exec|pull|images\/create|archive/.test(request.route)));
  assert.deepEqual(await readdir(f.protections.journalDirectory), []);
  assert.equal(await readFile(path.join(f.cwd, "subject.mjs"), "utf8"), "export const value = 1;\n");
});

test("C2 probe mounts disposable canaries, not project data", async (t) => {
  const f = await fixture(t), done = await f.run({ stage: "probe", checkId: "probe" });
  assert.equal(done.reply.exitCode, 0);
  assert.deepEqual(f.containers[0]!.body.HostConfig.Mounts.map((mount) => mount.Target), ["/jev/guard.mjs", "/jev/canary"]);
});

test("C2 Docker boundary failures never retry, pull, start unconfirmed isolation, or invent clean removal", async (t) => {
  for (const mode of ["http", "oversized", "utf8", "unsupported", "clock", "volume", "lost_create", "warning", "isolation", "foreign", "oom", "wait_mismatch", "remove"]) await t.test(mode, async (t) => {
    const f = await fixture(t, mode), done = await f.run();
    assert.ok(done.reply.status !== "exited" || !done.cleanupConfirmed);
    assert.ok(!JSON.stringify(done).includes("PRIVATE_"));
    assert.ok(f.requests.filter((request) => request.route.includes("/create?")).length <= 1);
    assert.ok(f.requests.filter((request) => request.route.endsWith("/start")).length <= 1);
    if (["warning", "isolation", "foreign"].includes(mode)) assert.equal(f.requests.some((request) => request.route.endsWith("/start")), false);
    if (["lost_create", "foreign", "remove"].includes(mode)) {
      assert.equal(done.cleanupConfirmed, false); assert.ok((await readdir(f.protections.journalDirectory)).some((name) => name.startsWith("verification-")));
      if (mode !== "remove") assert.equal(f.requests.some((request) => request.method === "DELETE"), false);
    } else { assert.equal(done.cleanupConfirmed, true); assert.deepEqual(await readdir(f.protections.journalDirectory), []); }
  });
});

test("C2 cancellation waits for namespace stop/removal and retains the observed cancelled status", async (t) => {
  const f = await fixture(t, "hold"), controller = new AbortController();
  const running = f.run(undefined, controller.signal);
  await f.waiting; controller.abort();
  const done = await running;
  assert.equal(done.reply.status, "cancelled"); assert.equal(done.cleanupConfirmed, true); assert.equal(f.containers[0]!.removed, true);
  const actions = f.requests.map((request) => `${request.method} ${request.route}`);
  assert.ok(actions.findIndex((item) => item.includes("/kill?")) < actions.findIndex((item) => item.startsWith("DELETE")));
  assert.equal(actions.filter((item) => item.includes("/kill?")).length, 1);
});

test("C2 input changes and pre-abort stop before a container request", async (t) => {
  for (const change of ["subject", "checker", "abort"]) await t.test(change, async (t) => {
    const f = await fixture(t), controller = new AbortController();
    if (change === "abort") controller.abort();
    else await writeFile(path.join(f.cwd, change === "subject" ? "subject.mjs" : "check.mjs"), "changed");
    const done = await f.run(undefined, controller.signal);
    assert.equal(done.started, false); assert.equal(done.cleanupConfirmed, true); assert.equal(f.requests.length, 0);
  });
});

test("C2 lost temporary-directory acknowledgement retains cleanup uncertainty", async (t) => {
  const f = await fixture(t), native = fs.mkdtemp;
  const mocked = t.mock.method(fs, "mkdtemp", async (prefix: string) => { await native(prefix); throw new Error("PRIVATE_DIRECTORY_ERROR"); });
  syncBuiltinESMExports();
  try {
    const done = await f.run(); assert.equal(done.started, false); assert.equal(done.cleanupConfirmed, false);
    assert.equal(f.containers.length, 0); assert.equal((await readdir(f.protections.journalDirectory)).length, 1);
    assert.ok(!JSON.stringify(done).includes("PRIVATE_DIRECTORY_ERROR"));
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("C2 rechecks source versions after container/snapshot cleanup, not only before it", async (t) => {
  const f = await fixture(t), native = fs.rm;
  const mocked = t.mock.method(fs, "rm", async (target: Parameters<typeof fs.rm>[0], options?: Parameters<typeof fs.rm>[1]) => {
    await native(target, options);
    if (String(target).startsWith(path.join(f.protections.journalDirectory, "verification-"))) await writeFile(path.join(f.cwd, "subject.mjs"), "EXTERNAL CHANGE DURING CLEANUP");
  });
  syncBuiltinESMExports();
  try {
    const done = await f.run(); assert.equal(done.cleanupConfirmed, true); assert.equal(done.reply.exitCode, 0);
    assert.equal(done.reply.status, "failed"); assert.equal(done.reply.filesCurrent, false);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("C2 inspection rejects relaxed authority and unsupported image metadata", async (t) => {
  const f = await fixture(t); await f.run(); const container = f.containers[0]!, expected = container.body;
  const view = { Id: container.id, Image: IMAGE, Config: structuredClone(expected), HostConfig: structuredClone(expected.HostConfig),
    Mounts: expected.HostConfig.Mounts.map((mount) => ({ Type: "bind", Source: mount.Source, Destination: mount.Target, RW: false, Propagation: "rprivate" })) };
  assert.equal(matchesVerificationContainer(view, expected, container.id), true);
  // Docker Engine 29.5.2 normalizes an explicitly empty Links array to null.
  assert.equal(matchesVerificationContainer({ ...view, HostConfig: { ...view.HostConfig, Links: null } }, expected, container.id), true);
  for (const patch of [{ Privileged: true }, { PidMode: "host" }, { IpcMode: "host" }, { Memory: 0 }, { SecurityOpt: [] }, { CapAdd: ["SYS_ADMIN"] }, { Binds: ["/:/host"] }, { GroupAdd: ["0"] }, { LogConfig: { Type: "json-file" } }])
    assert.equal(matchesVerificationContainer({ ...view, HostConfig: { ...view.HostConfig, ...patch } }, expected, container.id), false);
  assert.equal(matchesVerificationContainer({ ...view, Mounts: view.Mounts.map((mount) => ({ ...mount, RW: true })) }, expected, container.id), false);
  assert.equal(imageEnvironment({ Id: IMAGE, Os: "linux", Config: { Env: ["BAD-NAME=value"] } }, IMAGE), null);
});

test("container guard refuses host execution; isolated child mocks exercise argv, error and independent timer paths (not kernel isolation)", () => {
  const guard = fileURLToPath(new URL("../src/goal-verification-worker.mjs", import.meta.url));
  const direct = spawnSync(process.execPath, [guard, "{}"], { env: {}, timeout: 5000, encoding: "utf8" });
  assert.equal(direct.status, 125); assert.equal(direct.stdout, ""); assert.equal(direct.stderr, "");
  for (const mode of ["ok", "assertion", "error", "signal", "hang", "expired", "invalid", "debuggable", "ptrace", "missing_yama"]) {
    // Node may read module sources through this same fs export; mock only the kernel setting.
    const code = `import cp from 'node:child_process'; import fs from 'node:fs'; import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
      Object.defineProperty(process,'pid',{value:1});Object.defineProperty(process,'platform',{value:'linux'});process.getuid=()=>501;
      process.execArgv=${mode === "debuggable" ? "[]" : "['--disable-sigusr1']"};
      const readFileSync=fs.readFileSync;fs.readFileSync=(file,...args)=>{if(file!=='/proc/sys/kernel/yama/ptrace_scope')return readFileSync(file,...args);${mode === "missing_yama" ? "throw new Error('PRIVATE_KERNEL_ERROR')" : `return '${mode === "ptrace" ? "0" : "1"}'`}};
      cp.spawn=(command,args,options)=>{fs.writeSync(1,JSON.stringify({command,args,options}));const c=new EventEmitter();queueMicrotask(()=>{${mode === "hang" ? "" : mode === "error" ? "c.emit('error',new Error('PRIVATE_CHILD_ERROR'))" : `c.emit('close',${mode === "assertion" ? 42 : 0},${mode === "signal" ? "'SIGTERM'" : "null"})`}});return c;};syncBuiltinESMExports();
      process.argv=[process.execPath,${JSON.stringify(guard)},JSON.stringify(${mode === "invalid" ? "{}" : `{command:'/usr/bin/check',args:['literal;not-shell'],deadline:Date.now()+${mode === "expired" ? 0 : mode === "hang" ? 1100 : 5000}}`})];await import(${JSON.stringify(new URL("../src/goal-verification-worker.mjs", import.meta.url).href)});`;
    const child = spawnSync(process.execPath, ["--disable-sigusr1", "--input-type=module", "-e", code], { env: {}, timeout: 6000, encoding: "utf8" });
    assert.equal(child.status, mode === "ok" ? 0 : mode === "assertion" ? 42 : mode === "hang" || mode === "expired" ? 124 : 125, mode);
    assert.equal(child.stderr, "", mode);
    if (!["invalid", "expired", "debuggable", "ptrace", "missing_yama"].includes(mode)) {
      assert.notEqual(child.stdout, "", `${mode}: mocked spawn report was not flushed before the worker exited`);
      const call = JSON.parse(child.stdout); assert.equal(call.command, "/usr/bin/check"); assert.deepEqual(call.args, ["literal;not-shell"]);
      assert.equal(call.options.shell, false); assert.equal(call.options.stdio, "ignore"); assert.equal(call.options.cwd, "/workspace");
    } else assert.equal(child.stdout, "", `${mode}: guard must refuse before spawning`);
  }
});

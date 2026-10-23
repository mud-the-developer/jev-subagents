import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, realpath, readFile, writeFile, appendFile, link, symlink, rm, chmod } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { snapshotGoalText } from "../src/goal-file-effects.ts";
import { snapshotVerificationSocket } from "../src/goal-verification-effects.ts";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { bunWorkerOptions, workerEnvironment, workerRuntimeIO, WORKER_BUN_VERSION, WORKER_RUNTIME_ERROR } from "../src/worker-runtime.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-bun-runtime-policy-"))), file = path.join(root, process.platform === "win32" ? "bun.exe" : "bun");
  await writeFile(file, "Synthetic metadata-only executable fixture. Never execute.\n", { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file };
}
test("public tooling and CI use sealed Bun commands without changing test deadlines or file-worker limits", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.engines.bun, WORKER_BUN_VERSION);
  const prefix = "bun --no-env-file --no-install --config=src/worker-bunfig.toml";
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.ok(typeof command === "string"); assert.doesNotMatch(command, /\b(?:node|npm|npx)\b/);
    for (const part of command.split("&&")) assert.ok(part.trim().startsWith(prefix), name);
    if (name.startsWith("test")) {
      assert.ok(command.includes(" test --parallel=4 "), name);
      assert.ok(command.includes(`--timeout=${name === "test:windows:goal-boundary" ? 50000 : 30000}`), name);
    }
  }
  const workflow = await readFile(new URL("../.github/workflows/check.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /setup-node|\bnpm\b/);
  assert.match(workflow, /bun-version: '1\.4\.3'/);
  assert.match(workflow, /--frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /persist-credentials: false/);
});

test("worker SQLite compatibility keeps extension loading, quoted strings, foreign keys and changed-row semantics guarded", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:", { allowExtension: false, enableDoubleQuotedStringLiterals: false, enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; CREATE TABLE p(id INTEGER PRIMARY KEY, quota INTEGER NOT NULL) STRICT; CREATE TABLE c(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES p(id)) STRICT; BEGIN IMMEDIATE");
    assert.throws(() => db.enableLoadExtension(true)); assert.throws(() => db.prepare('SELECT "unapproved_string_literal"').get());
    assert.throws(() => db.prepare("INSERT INTO p VALUES(?,?)").run(1, "not_an_integer"));
    db.prepare("INSERT INTO p VALUES(?,?)").run(1, 10); assert.throws(() => db.prepare("INSERT INTO c VALUES(?,?)").run(1, 999));
    assert.equal(Number(db.prepare("UPDATE p SET quota=? WHERE id=?").run(11, 1).changes), 1);
    assert.equal(Number(db.prepare("UPDATE p SET quota=? WHERE id=?").run(12, 999).changes), 0);
    db.exec("COMMIT"); assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1); assert.equal(db.prepare("PRAGMA trusted_schema").get()?.trusted_schema, 0);
  } finally { db.close(); }
});
test("worker environment removes ambient Bun/preload and Node hooks without mutating the selected SDK environment", () => {
  const input = Object.freeze({ PATH: "synthetic-path", NODE_OPTIONS: "--require PRIVATE_HOOK", NODE_PATH: "PRIVATE_MODULES", BUN_OPTIONS: "PRIVATE_BUN_HOOK",
    BUN_INSTALL: "PRIVATE_CACHE", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "PRIVATE_CACHE", JEV_BUN_EXECUTABLE: "PRIVATE_PATH", OPENAI_API_KEY: "synthetic-provider-key" });
  const env = workerEnvironment(input);
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_INSTALL", "JEV_BUN_EXECUTABLE"]) assert.equal(env[key], undefined);
  assert.equal(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, "0"); assert.equal(env.DO_NOT_TRACK, "1"); assert.equal(env.OPENAI_API_KEY, input.OPENAI_API_KEY);
  assert.equal(input.BUN_OPTIONS, "PRIVATE_BUN_HOOK");
});
test("only an explicitly verified Bun gets JSON IPC and trusted no-env/no-install/config launch arguments", async t => {
  const f = await fixture(t), probe = t.mock.method(workerRuntimeIO, "metadata", (file: string) => ({ version: WORKER_BUN_VERSION, executable: file }));
  const opts = bunWorkerOptions({ JEV_BUN_EXECUTABLE: f.file, NODE_OPTIONS: "PRIVATE_HOOK" });
  assert.equal(opts.execPath, f.file); assert.equal(opts.serialization, "json");
  assert.deepEqual(opts.execArgv.slice(0, 2), ["--no-env-file", "--no-install"]); assert.match(opts.execArgv[2]!, /^--config=.+worker-bunfig\.toml$/);
  assert.match(opts.execArgv[3]!, /^--tsconfig-override=.+tsconfig\.json$/);
  assert.equal(opts.env.NODE_OPTIONS, undefined); assert.equal(opts.env.JEV_BUN_EXECUTABLE, undefined);
  bunWorkerOptions({ JEV_BUN_EXECUTABLE: f.file }); assert.equal(probe.mock.callCount(), 1);
  await appendFile(f.file, "Changed identity must not be re-adopted automatically.\n");
  assert.throws(() => bunWorkerOptions({ JEV_BUN_EXECUTABLE: f.file }), { message: WORKER_RUNTIME_ERROR }); assert.equal(probe.mock.callCount(), 1);
});
test("the installer's bunx hardlink is allowed for the runtime without changing task-file link guards", async t => {
  const f = await fixture(t); await link(f.file, path.join(f.root, process.platform === "win32" ? "bunx.exe" : "bunx"));
  t.mock.method(workerRuntimeIO, "metadata", (file: string) => ({ version: WORKER_BUN_VERSION, executable: file }));
  assert.equal(bunWorkerOptions({ JEV_BUN_EXECUTABLE: f.file }).execPath, f.file);
});
test("cloned Windows Path casing is honored; a standalone Bun parent still keeps its own executable", async t => {
  const f = await fixture(t);
  t.mock.method(os, "homedir", () => path.join(f.root, "no-home-fallback"));
  t.mock.method(workerRuntimeIO, "metadata", (file: string) => ({ version: WORKER_BUN_VERSION, executable: file }));
  const opts = bunWorkerOptions(process.platform === "win32" ? { Path: f.root } : { PATH: f.root });
  assert.equal(opts.execPath, process.versions.bun ? process.execPath : f.file);
});
test("missing, changed-version and compiled-host-shaped executable metadata never falls back to Node or another path", async t => {
  const f = await fixture(t), probe = t.mock.method(workerRuntimeIO, "metadata", (file: string) => ({ version: "1.2.0", executable: file }));
  for (const input of [{ JEV_BUN_EXECUTABLE: path.join(f.root, "missing.exe") }, { JEV_BUN_EXECUTABLE: "relative-bun" }, { JEV_BUN_EXECUTABLE: f.file }])
    assert.throws(() => bunWorkerOptions(input), error => error instanceof Error && error.message === WORKER_RUNTIME_ERROR && !error.message.includes(f.root));
  assert.equal(probe.mock.callCount(), 1);
});
test("executable metadata probe cannot load task config or inherit provider credentials and sanitizes malformed output", async t => {
  const f = await fixture(t);
  let invalid = false;
  const executable = t.mock.method(cp, "execFileSync", ((file: string, args: readonly string[], options: cp.ExecFileSyncOptions) => {
    if (invalid) return "PRIVATE_INVALID_EXECUTABLE_OUTPUT";
    assert.equal(file, f.file); assert.ok(args.includes("--no-env-file")); assert.ok(args.includes("--no-install"));
    assert.ok(args.some(arg => arg.startsWith("--config="))); assert.ok(args.some(arg => arg.startsWith("--tsconfig-override="))); assert.ok(args.includes("--eval"));
    for (const key of ["OPENAI_API_KEY", "TYPESAFE_API_KEY", "NODE_OPTIONS", "BUN_OPTIONS", "PI_CODING_AGENT_DIR"]) assert.equal(options.env?.[key], undefined);
    assert.equal(path.basename(String(options.cwd)), "src");
    return JSON.stringify({ version: WORKER_BUN_VERSION, executable: f.file });
  }) as typeof cp.execFileSync);
  assert.deepEqual(workerRuntimeIO.metadata(f.file), { version: WORKER_BUN_VERSION, executable: f.file });
  invalid = true;
  assert.throws(() => workerRuntimeIO.metadata(f.file), error => error instanceof Error && error.message === WORKER_RUNTIME_ERROR && !error.message.includes("PRIVATE_INVALID"));
  assert.equal(executable.mock.callCount(), 2);
});
test("Node and Bun preserve exact POSIX file and verification-socket snapshots", { skip: process.platform === "win32" }, async t => {
  const root = await realpath(await mkdtemp("/tmp/jev-bun-stat-")), file = path.join(root, "fixture.txt"), socket = path.join(root, "fixture.sock");
  await writeFile(file, "Synthetic cross-runtime snapshot.\n", { mode: 0o600 });
  const server = createServer(); server.listen(socket); await once(server, "listening"); await chmod(socket, 0o600);
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const leafLink = path.join(root, "linked.sock"), directoryLink = path.join(root, "linked-parent");
  await symlink(socket, leafLink); await symlink(root, directoryLink, "dir");
  const aliases = [leafLink, path.join(directoryLink, "fixture.sock"), `${root}/./fixture.sock`];
  const textModule = fileURLToPath(new URL("../src/goal-file-effects.ts", import.meta.url)), socketModule = fileURLToPath(new URL("../src/goal-verification-effects.ts", import.meta.url));
  const code = `import {snapshotGoalText} from ${JSON.stringify(textModule)};import {snapshotVerificationSocket} from ${JSON.stringify(socketModule)};
    import {lstat,realpath} from 'node:fs/promises';import {lstatSync,realpathSync} from 'node:fs';
    const target=process.argv[2],flags={};const inspect=(s)=>({socket:s.isSocket(),oneLink:s.nlink===1n,owned:s.uid===0n||s.uid===BigInt(process.getuid()),notWorldWritable:(s.mode&2n)===0n,identityFits:s.dev<=BigInt(Number.MAX_SAFE_INTEGER)&&s.ino<=BigInt(Number.MAX_SAFE_INTEGER)});
    try{flags.asyncRealpath=(await realpath(target))===target}catch{flags.asyncRealpath=false}
    try{flags.syncRealpath=realpathSync(target)===target}catch{flags.syncRealpath=false}
    try{flags.asyncStat=inspect(await lstat(target,{bigint:true}))}catch{flags.asyncStat=false}
    try{flags.syncStat=inspect(lstatSync(target,{bigint:true}))}catch{flags.syncStat=false}
    const output=[];for(const read of [()=>snapshotGoalText(process.argv[1]),()=>snapshotVerificationSocket(target),...process.argv.slice(3).map(value=>()=>snapshotVerificationSocket(value))]){try{output.push({ok:true,value:await read()})}catch{output.push({ok:false,flags})}}console.log(JSON.stringify(output));`;
  const runtime = bunWorkerOptions(), actual: { ok: boolean; value?: unknown; flags?: unknown }[] = JSON.parse(cp.execFileSync(runtime.execPath, [...runtime.execArgv, "--eval", code, file, socket, ...aliases], {
    encoding: "utf8", timeout: 10000, maxBuffer: 16384, stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
  }));
  const expected = [await snapshotGoalText(file), await snapshotVerificationSocket(socket)];
  for (const [index, value] of expected.entries()) {
    assert.equal(actual[index]?.ok, true, `${index === 0 ? "Bun rejected the same POSIX file" : "Bun rejected the same verification socket"}: ${JSON.stringify(actual[index]?.flags ?? {})}`);
    assert.deepEqual(actual[index]?.value, value, index === 0 ? "Exact file snapshot changed across runtimes" : "Exact verification socket snapshot changed across runtimes");
  }
  for (const [index, alias] of aliases.entries()) {
    await assert.rejects(snapshotVerificationSocket(alias)); assert.equal(actual[index + 2]?.ok, false, "Bun must reject socket leaf/parent links and lexical aliases");
  }
  await chmod(socket, 0o602); await assert.rejects(snapshotVerificationSocket(socket));
});

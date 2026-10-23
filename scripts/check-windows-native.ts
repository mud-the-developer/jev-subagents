import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { bunWorkerOptions, WORKER_BUN_VERSION } from "../src/worker-runtime.ts";
import { checkWindowsActor } from "../src/windows-profile-files.ts";
import { canonicalDirectory } from "../src/goal-run-effects.ts";

assert.equal(process.platform, "win32", "Native Windows is required; Linux contract fixtures are not acceptance.");
assert.equal(process.versions.bun, WORKER_BUN_VERSION);
await checkWindowsActor();
const source = fileURLToPath(new URL("../", import.meta.url));
await canonicalDirectory(source);
const { execPath, execArgv } = bunWorkerOptions();
const blocked = ["node.exe", "node", "npm.cmd", "npm", "npx.cmd", "npx"];
for (const name of blocked) assert.equal(fs.existsSync(path.join(path.dirname(execPath), name)), false, "Use a standalone Bun directory without Node/npm siblings.");
for (let directory = path.resolve(source); ; directory = path.dirname(directory)) {
  for (const name of blocked) assert.equal(fs.existsSync(path.join(directory, "node_modules", ".bin", name)), false, "A package executable would bypass the Node-free PATH.");
  if (path.dirname(directory) === directory) break;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-windows-native-")), home = path.join(root, "home");
fs.mkdirSync(home); fs.mkdirSync(path.join(home, "agent")); fs.mkdirSync(path.join(home, "tmp"));
await canonicalDirectory(home, true);
const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).filter(dir => blocked.every(name => !fs.existsSync(path.join(dir, name))));
const env: NodeJS.ProcessEnv = { PATH: [path.dirname(execPath), ...dirs].join(path.delimiter), HOME: home, USERPROFILE: home,
  APPDATA: home, LOCALAPPDATA: home, TEMP: path.join(home, "tmp"), TMP: path.join(home, "tmp"),
  PI_CODING_AGENT_DIR: path.join(home, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  JEV_BUN_EXECUTABLE: execPath, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", DO_NOT_TRACK: "1", NO_COLOR: "1", TERM: "dumb" };
for (const key of ["SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "PROGRAMW6432"]) if (process.env[key]) env[key] = process.env[key];
assert.ok(env.SystemRoot ?? env.SYSTEMROOT, "The native Windows system root is required.");
const completed: string[] = [];
const checks: { command: string; exitCode: number | null; signal: NodeJS.Signals | null; errorCode: string | null; elapsedMs: number; logPath: string }[] = [];
for (const command of ["check:windows", "demo:job"]) {
  const logPath = path.join(home, `${command.replaceAll(":", "-")}.log`), fd = fs.openSync(logPath, "wx", 0o600);
  console.log(JSON.stringify({ kind: "native_windows_phase", command, logPath }));
  const started = performance.now();
  let result: cp.SpawnSyncReturns<Buffer>;
  try { result = cp.spawnSync(execPath, [...execArgv, "run", command], { cwd: source, env, stdio: ["ignore", fd, fd], timeout: 900_000, windowsHide: true }); }
  finally { fs.closeSync(fd); }
  assert.ok(fs.statSync(logPath).isFile(), "The private child log must be retained even on failure.");
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const errorCode = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : result.error ? "UNKNOWN" : null;
  checks.push({ command, exitCode: result.status, signal: result.signal, errorCode, elapsedMs: performance.now() - started, logPath });
  if (result.error || result.signal || result.status !== 0) { process.exitCode = 1; break; }
  completed.push(command);
}
const digest = (name: string) => createHash("sha256").update(fs.readFileSync(path.join(source, name))).digest("hex");
const revision = cp.spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, env, encoding: "utf8", timeout: 5000, windowsHide: true });
const commit = revision.status === 0 ? revision.stdout.trim() : "";
const sourceCommit = /^[a-f0-9]{40}$/.test(commit) ? commit : null;
const receipt = { kind: "native_windows_bun_gate", passed: completed.length === 2, platform: process.platform, release: os.release(), arch: process.arch,
  bun: WORKER_BUN_VERSION, nonAdminActorVerified: true, source, sourceCommit, manifestSha256: digest("package.json"), lockSha256: digest("bun.lock"),
  completed, checks, keylessEnvironment: true, nodeCommandsAvailableInPath: false, retainedWorkspace: root,
  physicalUiCertified: false, liveModels: false, officialReleaseArchive: false };
fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(receipt));

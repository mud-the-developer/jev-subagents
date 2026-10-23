import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bunWorkerOptions, WORKER_BUN_VERSION } from "../src/worker-runtime.ts";

// A PATH dependency check, not an OS sandbox or a claim that Node is uninstalled.
assert.equal(process.versions.bun, WORKER_BUN_VERSION);
assert.ok(process.platform === "linux" || process.platform === "darwin", "Run native Windows acceptance separately as a non-admin user.");
const { execPath, execArgv } = bunWorkerOptions();
const source = fileURLToPath(new URL("../", import.meta.url));
const names = ["node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd"];
for (const name of names) assert.equal(fs.existsSync(path.join(path.dirname(execPath), name)), false, "Use a standalone Bun directory without Node/npm siblings.");
for (let directory = path.resolve(source); ; directory = path.dirname(directory)) {
  for (const name of names) assert.equal(fs.existsSync(path.join(directory, "node_modules", ".bin", name)), false, "A package executable would bypass the Node CLI trap.");
  if (path.dirname(directory) === directory) break;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-bun-only-")), bin = path.join(root, "bin"), home = path.join(root, "home");
fs.mkdirSync(bin); fs.mkdirSync(home); fs.mkdirSync(path.join(home, "agent"));
fs.symlinkSync(execPath, path.join(bin, "bun"));
for (const name of ["git", "bash", "sh", "env", "make", "tar", "unzip"]) {
  let executable: string | undefined;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(dir, name);
    if (candidate.startsWith(path.join(source, "node_modules") + path.sep)) continue;
    try { fs.accessSync(candidate, fs.constants.X_OK); executable = fs.realpathSync(candidate); break; } catch { /* Try the next existing system path. */ }
  }
  assert.ok(executable, `Required validation tool unavailable: ${name}`);
  fs.symlinkSync(executable, path.join(bin, name));
}
const marker = path.join(root, "node-attempts");
const literal = `'${marker.replaceAll("'", "'\\''")}'`;
for (const name of ["node", "npm", "npx"]) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf 'blocked-cli\\n' >> ${literal}\nexit 97\n`, { mode: 0o700, flag: "wx" });
const env: NodeJS.ProcessEnv = { PATH: bin, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, "agent"),
  PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", JEV_BUN_EXECUTABLE: execPath,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", DO_NOT_TRACK: "1", NO_COLOR: "1", TERM: "dumb" };
const armed = cp.spawnSync("node", ["--version"], { env, stdio: "ignore" });
assert.equal(armed.status, 97); assert.equal(fs.readFileSync(marker, "utf8"), "blocked-cli\n"); fs.unlinkSync(marker);
const completed: string[] = [];
for (const command of ["check", "demo:job"]) {
  const result = cp.spawnSync(execPath, [...execArgv, "run", command], { cwd: source, env, stdio: "inherit", timeout: 600_000 });
  if (result.error || result.signal || result.status !== 0) { process.exitCode = 1; break; }
  completed.push(command);
}
const attempts = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").length : 0;
if (attempts) process.exitCode = 1;
console.log(JSON.stringify({ kind: "bun_only_cli_gate", bun: WORKER_BUN_VERSION, completed, blockedCliInvocations: attempts,
  passed: completed.length === 2 && attempts === 0, retainedKeylessWorkspace: root, osSandbox: false }));

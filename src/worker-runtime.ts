import cp from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_BUN_VERSION = "1.4.3";
export const WORKER_RUNTIME_ERROR = "Verified standalone Bun worker runtime unavailable or changed. No Node fallback, alternate-version adoption or automatic installation.";
const config = fileURLToPath(new URL("./worker-bunfig.toml", import.meta.url));
const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const configText = "preload = []\nenv = false\n";
const verified = new Map<string, string>();
const fail = (): never => { throw new Error(WORKER_RUNTIME_ERROR); };
const metadataCode = "console.log(JSON.stringify({version:process.versions.bun,executable:process.execPath}))";

export function workerEnvironment(input: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("BUN_") || ["NODE_OPTIONS", "NODE_PATH", "JEV_BUN_EXECUTABLE"].includes(key.toUpperCase())) delete env[key];
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"; env.DO_NOT_TRACK = "1";
  return env;
}
/** Version probes have no user credentials/config, run outside the task cwd and never import task code. */
export const workerRuntimeIO = {
  metadata(executable: string): { version: string; executable: string } {
    const env: NodeJS.ProcessEnv = { PATH: path.dirname(executable), HOME: path.dirname(config), USERPROFILE: path.dirname(config),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", DO_NOT_TRACK: "1" };
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (system) env.SystemRoot = system;
    try {
      const text = cp.execFileSync(executable, ["--no-env-file", "--no-install", `--config=${config}`, `--tsconfig-override=${tsconfig}`, "--eval", metadataCode],
        { cwd: path.dirname(config), env, encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || !("version" in value) || !("executable" in value) ||
        typeof value.version !== "string" || typeof value.executable !== "string") return fail();
      return { version: value.version, executable: value.executable };
    } catch { return fail(); }
  },
};
function identity(file: string): string {
  const stat = lstatSync(file, { bigint: true });
  // Bun's installer intentionally hard-links bunx to bun; this is not a writable task-file lease.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1n || stat.size <= 0n) return fail();
  return `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}`;
}
function executable(input: Readonly<NodeJS.ProcessEnv>): string {
  const value = (name: string) => process.platform === "win32" ? Object.entries(input).find(([key]) => key.toUpperCase() === name)?.[1] : input[name];
  const configured = value("JEV_BUN_EXECUTABLE");
  if (configured !== undefined) {
    if (!path.isAbsolute(configured) || /[\x00-\x1f\x7f]/.test(configured)) return fail();
    return realpathSync(configured);
  }
  if (process.versions.bun && /^bun(?:\.exe)?$/i.test(path.basename(process.execPath))) return realpathSync(process.execPath);
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  const candidates = [...(value("PATH") ?? "").split(path.delimiter).filter(Boolean).filter(path.isAbsolute).map(base => path.join(base, name)),
    path.join(os.homedir(), ".bun", "bin", name)];
  for (const candidate of candidates) {
    try { return realpathSync(candidate); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return fail(); }
  }
  return fail();
}
/** Effect-local executable cache, not stored permission. Every launch rechecks the exact binary/config identity. */
export function bunWorkerOptions(input: Readonly<NodeJS.ProcessEnv> = process.env) {
  try {
    const configStat = lstatSync(tsconfig);
    if (readFileSync(config, "utf8").replaceAll("\r\n", "\n") !== configText || !configStat.isFile() || configStat.isSymbolicLink()) return fail();
    const file = executable(input), stamp = identity(file), previous = verified.get(file);
    if (previous && previous !== stamp) return fail();
    if (!previous) {
      const metadata = workerRuntimeIO.metadata(file);
      if (metadata.version !== WORKER_BUN_VERSION || !path.isAbsolute(metadata.executable) || identity(realpathSync(metadata.executable)) !== stamp || identity(file) !== stamp) return fail();
      verified.set(file, stamp);
    }
    return { execPath: file, execArgv: ["--no-env-file", "--no-install", `--config=${config}`, `--tsconfig-override=${tsconfig}`],
      serialization: "json" as const, env: workerEnvironment(input) };
  } catch { return fail(); }
}

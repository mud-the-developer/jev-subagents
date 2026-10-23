import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { bunWorkerOptions, WORKER_BUN_VERSION } from "../src/worker-runtime.ts";

export type SourceRelease = { version: string; tag: string; commit: string; archive: string; checksum: string; sha256: string; files: number };
type BunLockMetadata = { lockfileVersion?: number; workspaces?: Record<string, Record<string, unknown>>; overrides?: unknown };
const refuse = (reason: string): never => { throw new Error(`Source release refused: ${reason}. No publication or overwrite performed.`); };
const stringMap = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
const overrideMap = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string" || stringMap(item));
const privatePath = /(^|\/)(?:node_modules|\.pi|\.ssh|\.aws|\.gnupg|Microsoft|\.git)(?:\/|$)|(^|\/)(?:\.env(?:\..*)?|auth\.json|models\.json|\.npmrc|.*\.pfx|.*\.p12|.*\.sqlite(?:-.*)?|.*\.db(?:-.*)?|.*\.pem|.*\.key|.*\.log|.*acl.*backup.*|.*sddl.*|.*session.*\.jsonl|goal\.jsonl|owner\.lock|\.jev[^/]*\.lock|\.jev-memory\.jsonl|\.jev-context-application\.jsonl)$/i;

/** Source artifacts only: no install, npm publication, Git ref mutation or user settings access. */
export function createSourceRelease(repoRoot: string, outputDirectory: string): SourceRelease {
  if (process.versions.bun !== WORKER_BUN_VERSION) return refuse(`Bun${WORKER_BUN_VERSION} is required`);
  bunWorkerOptions();
  const bun = (globalThis as typeof globalThis & { Bun: { JSONC: { parse(text: string): BunLockMetadata } } }).Bun;
  const root = fs.realpathSync(repoRoot), output = fs.realpathSync(outputDirectory), relative = path.relative(root, output);
  if (!fs.statSync(output).isDirectory() || !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return refuse("output must be an existing directory outside the checkout");
  const git = (args: readonly string[]) => {
    try { return cp.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true }); }
    catch { return refuse("committed Git metadata is unavailable"); }
  };
  if (git(["status", "--porcelain=v1"]).trim()) return refuse("checkout must be clean, including untracked source");
  const commit = git(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) return refuse("invalid commit identity");
  const entries = git(["ls-tree", "-r", "-z", commit]).split("\0").filter(Boolean);
  for (const entry of entries) {
    const tab = entry.indexOf("\t"), file = entry.slice(tab + 1);
    if (tab < 0 || !/^(?:100644|100755) blob [a-f0-9]{40}$/.test(entry.slice(0, tab))) return refuse("only regular committed files may be archived");
    if (file !== ".env.example" && privatePath.test(file)) return refuse("tracked local or private artifacts are outside the release scope");
  }
  let name: string, version: string;
  try {
    const pkg = JSON.parse(git(["show", `${commit}:package.json`])) as { name?: string; version?: string; private?: boolean;
      dependencies?: unknown; devDependencies?: unknown; peerDependencies?: unknown; overrides?: unknown };
    const lock = bun.JSONC.parse(git(["show", `${commit}:bun.lock`]));
    const workspace = lock.workspaces?.[""];
    const overrides = pkg.overrides === undefined ? {} : pkg.overrides;
    const lockedOverrides = lock.overrides === undefined ? {} : lock.overrides;
    const dependencies = (["dependencies", "devDependencies", "peerDependencies"] as const).every(key => {
      const declared = pkg[key] === undefined ? {} : pkg[key], locked = workspace?.[key] === undefined ? {} : workspace[key];
      return stringMap(declared) && stringMap(locked) && isDeepStrictEqual(declared, locked);
    });
    if (pkg.private !== true || typeof pkg.name !== "string" || pkg.name.trim() !== pkg.name || !/^[a-z0-9][a-z0-9._-]*$/.test(pkg.name) ||
      typeof pkg.version !== "string" || pkg.version.trim() !== pkg.version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version) ||
      lock.lockfileVersion !== 3 || workspace?.name !== pkg.name || !dependencies ||
      !overrideMap(overrides) || !overrideMap(lockedOverrides) || !isDeepStrictEqual(overrides, lockedOverrides))
      return refuse("private manifest and Bun lock dependency policy must match");
    name = pkg.name; version = pkg.version;
  } catch { return refuse("invalid private manifest or lock metadata"); }
  const basename = `${name}-${version}-source.zip`, archive = path.join(output, basename), checksum = path.join(output, "SHA256SUMS");
  for (const file of [archive, checksum]) if (fs.existsSync(file)) return refuse("an output artifact already exists");
  let bytes: Buffer;
  try { bytes = cp.execFileSync("git", ["-C", root, "archive", "--format=zip", `--prefix=${name}-${version}/`, commit], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }); }
  catch { return refuse("source archive creation failed"); }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let zip: number | undefined, sums: number | undefined;
  try {
    zip = fs.openSync(archive, "wx", 0o600); sums = fs.openSync(checksum, "wx", 0o600);
    fs.writeFileSync(zip, bytes); fs.fsyncSync(zip);
    fs.writeFileSync(sums, `${sha256}  ${basename}\n`); fs.fsyncSync(sums);
  } catch { throw new Error("Source artifact write failed; partial files are preserved. No overwrite or publication performed."); }
  finally { if (zip !== undefined) fs.closeSync(zip); if (sums !== undefined) fs.closeSync(sums); }
  return { version, tag: `v${version}`, commit, archive, checksum, sha256, files: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: bun scripts/release-source.ts <existing-output-directory-outside-checkout>");
  console.log(JSON.stringify(createSourceRelease(path.resolve(import.meta.dirname, ".."), process.argv[2]!)));
}

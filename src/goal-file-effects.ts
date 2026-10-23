import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { lstat, realpath, type FileHandle } from "node:fs/promises";
import { join, relative, isAbsolute, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { snapshotWindowsGoalText, checkWindowsGoalFileScope, prepareWindowsGoalFileScope, executeWindowsGoalFileEffect } from "./windows-goal-files.ts";
import { GOAL_FILES_ERROR, MAX_GOAL_FILE_BYTES, MAX_GOAL_FILES_BYTES, goalFileDigest as hash, goalFileReplacement, goalTextBytes,
  validGoalFileInput, validGoalFileRequest, validGoalFileScope,
  type FileIdentity, type GoalFile, type GoalFileInput, type GoalFileIoEffect, type GoalFileIoEvent,
  type GoalFileScope, type GoalFileVersion } from "./goal-files.ts";

/** Trusted host paths, never worker tool arguments. Both directories must already exist. */
export type GoalFileProtections = { readonly journalDirectory: string; readonly agentDirectory: string };
type Root = Pick<GoalFileScope, "root" | "rootIdentity">;
type View = { handle: FileHandle; text: string; version: GoalFileVersion };
const fail = (): never => { throw new Error(GOAL_FILES_ERROR); };
function identity(stat: BigIntStats): FileIdentity {
  const value = { dev: Number(stat.dev), ino: Number(stat.ino) };
  if (Object.values(value).some((part) => !Number.isSafeInteger(part) || part < 0)) fail();
  return value;
}
function safeStat(stat: BigIntStats, directory: boolean): void {
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(MAX_GOAL_FILE_BYTES))) fail();
}
function stamp(stat: BigIntStats): string {
  return hash([stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(":"));
}
async function directory(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096 || /[\u0000-\u001f\u007f\\]/.test(path)) fail();
  // lstat("link/") follows a directory symlink on POSIX; inspect the actual leaf.
  const before = await lstat(path.replace(/\/+$/, "") || "/", { bigint: true });
  if (!before.isDirectory()) fail();
  const canonical = await realpath(path);
  if (!isDeepStrictEqual(identity(before), identity(await lstat(canonical, { bigint: true })))) fail();
  return canonical;
}
async function protectedDirectories(protections: GoalFileProtections): Promise<string[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") fail();
  return Promise.all([protections.journalDirectory, protections.agentDirectory,
    fileURLToPath(new URL("../", import.meta.url))].map(directory));
}
function outsideProtected(path: string, protectedPaths: readonly string[]): void {
  if (protectedPaths.some((base) => { const part = relative(base, path); return part === "" || (!part.startsWith("../") && part !== ".." && !isAbsolute(part)); })) fail();
}
async function checkLocation(root: string, path: string, protectedPaths: readonly string[]): Promise<void> {
  const canonical = await realpath(join(root, path));
  outsideProtected(canonical, protectedPaths);
  // Reject case aliases as well as symlinked components; approve the exact spelling.
  if (relative(root, canonical) !== path) fail();
}
async function checkPath(root: Root, file: Pick<GoalFile, "path">): Promise<BigIntStats> {
  const rootStat = await lstat(root.root, { bigint: true });
  safeStat(rootStat, true);
  if (!isDeepStrictEqual(identity(rootStat), root.rootIdentity)) fail();
  const parts = file.path.split("/");
  let path = root.root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = await lstat(path, { bigint: true });
    safeStat(stat, index < parts.length - 1);
    if (index === parts.length - 1) return stat;
  }
  return fail();
}
async function contents(handle: FileHandle, signal?: AbortSignal): Promise<Omit<View, "handle">> {
  signal?.throwIfAborted();
  const before = await handle.stat({ bigint: true });
  safeStat(before, false);
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (bytesRead <= 0 || bytesRead > bytes.length - offset) fail();
    offset += bytesRead;
  }
  signal?.throwIfAborted();
  if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) fail();
  if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) fail();
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (goalTextBytes(text) !== bytes.length) fail();
  return { text, version: { identity: identity(before), stamp: stamp(before), digest: hash(bytes), bytes: bytes.length } };
}
async function inspect(root: Root, file: Pick<GoalFile, "path">, writable: boolean, signal?: AbortSignal): Promise<View> {
  signal?.throwIfAborted();
  const before = await checkPath(root, file);
  // No O_CREAT/O_TRUNC. O_NONBLOCK avoids blocking if a leaf is replaced by a FIFO.
  const handle = await fs.open(join(root.root, file.path), (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (stamp(before) !== stamp(await handle.stat({ bigint: true }))) fail();
    const view = await contents(handle, signal);
    if (stamp(before) !== view.version.stamp || stamp(await checkPath(root, file)) !== view.version.stamp) fail();
    return { handle, ...view };
  } catch {
    await handle.close();
    return fail();
  }
}
async function checkAll(scope: GoalFileScope, signal?: AbortSignal): Promise<void> {
  // ponytail: bounded full scan (16 files / 128 KiB); no watcher or cache to invalidate.
  for (const file of scope.files) {
    const view = await inspect(scope, file, false, signal);
    try { if (!isDeepStrictEqual(view.version, file.version)) fail(); }
    finally { await view.handle.close(); }
  }
}

/** Trusted host only: explicitly named profile/instruction/control files, never a worker tool. */
export async function snapshotGoalText(path: string, signal?: AbortSignal): Promise<{ text: string; version: GoalFileVersion } | null> {
  if (process.platform === "win32") return snapshotWindowsGoalText(path, signal);
  const root = await directory(dirname(path));
  if (join(root, basename(path)) !== path) fail();
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const view = await inspect({ root, rootIdentity: identity(await lstat(root, { bigint: true })) }, { path: basename(path) }, false, signal);
  try { return { text: view.text, version: view.version }; } finally { await view.handle.close(); }
}
export async function checkGoalFileScope(scope: GoalFileScope, protections: GoalFileProtections, signal?: AbortSignal): Promise<void> {
  if (process.platform === "win32") return checkWindowsGoalFileScope(scope, protections, signal);
  if (!validGoalFileScope(scope)) fail();
  const protectedPaths = await protectedDirectories(protections);
  outsideProtected(scope.root, protectedPaths);
  if (await directory(scope.root) !== scope.root) fail();
  for (const file of scope.files) await checkLocation(scope.root, file.path, protectedPaths);
  await checkAll(scope, signal);
  signal?.throwIfAborted();
}

/** Local inspection only. Returns owned metadata, not file contents or execution authority. */
export async function prepareGoalFileScope(input: GoalFileInput, protections: GoalFileProtections, signal?: AbortSignal): Promise<GoalFileScope> {
  if (process.platform === "win32") return prepareWindowsGoalFileScope(input, protections, signal);
  try {
    if (!validGoalFileInput(input)) fail();
    const job = structuredClone(input);
    const protectedPaths = await protectedDirectories(structuredClone(protections));
    signal?.throwIfAborted();
    const root = await directory(job.cwd);
    if (!validGoalFileInput({ ...job, cwd: root })) fail();
    outsideProtected(root, protectedPaths);
    const scope: GoalFileScope = { id: randomUUID(), root, rootIdentity: identity(await lstat(root, { bigint: true })), files: [] };
    for (const [index, file] of job.files.entries()) {
      await checkLocation(root, file.path, protectedPaths);
      const view = await inspect(scope, file, false, signal);
      try { scope.files.push({ ...file, id: `file-${index + 1}`, version: view.version }); }
      finally { await view.handle.close(); }
      if (scope.files.reduce((sum, entry) => sum + entry.version.bytes, 0) > MAX_GOAL_FILES_BYTES) fail();
    }
    if (!validGoalFileScope(scope)) fail();
    await checkAll(scope, signal);
    signal?.throwIfAborted();
    return scope;
  } catch { return fail(); }
}

/** Execute only reducer-issued effects; serial scheduling/approval remain the trusted host's job. */
export async function executeGoalFileEffect(effect: GoalFileIoEffect, protections: GoalFileProtections, signal?: AbortSignal): Promise<GoalFileIoEvent> {
  if (process.platform === "win32") return executeWindowsGoalFileEffect(effect, protections, signal);
  const scopeId = effect.scope.id;
  const requestId = effect.request.id;
  let mayHaveWritten = false;
  try {
    if (effect.type !== "file_io" || !validGoalFileScope(effect.scope) || !validGoalFileRequest(effect.request)) fail();
    const { scope, request } = structuredClone(effect);
    const protectedPaths = await protectedDirectories(structuredClone(protections));
    outsideProtected(scope.root, protectedPaths);
    if (await directory(scope.root) !== scope.root) fail();
    for (const file of scope.files) await checkLocation(scope.root, file.path, protectedPaths);
    const file = scope.files.find((entry) => entry.id === request.fileId);
    if (!file || (request.action !== "read" && file.access !== "read_write")) return fail();
    await checkAll(scope, signal);
    const view = await inspect(scope, file, request.action !== "read", signal);
    let result: GoalFileIoEvent;
    try {
      if (!isDeepStrictEqual(view.version, file.version)) fail();
      if (request.action === "read") {
        await checkAll(scope, signal);
        result = { type: "file_done", scopeId, requestId, version: view.version, reply: { action: "read", text: view.text } };
      } else {
        const replacement = goalFileReplacement(view.text, request);
        const bytes = Buffer.from(replacement, "utf8");
        if (scope.files.reduce((sum, entry) => sum + entry.version.bytes, 0) - file.version.bytes + bytes.length > MAX_GOAL_FILES_BYTES) fail();
        signal?.throwIfAborted();
        mayHaveWritten = true; // A failed or cancelled write cannot establish rollback.
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const { bytesWritten } = await view.handle.write(bytes, offset, bytes.length - offset, offset);
          if (bytesWritten <= 0 || bytesWritten > bytes.length - offset) fail();
          offset += bytesWritten;
        }
        signal?.throwIfAborted();
        await view.handle.truncate(bytes.length);
        await view.handle.sync();
        const stored = await contents(view.handle, signal);
        if (stored.text !== replacement || !isDeepStrictEqual(stored.version.identity, file.version.identity)) fail();
        const updated = { ...scope, files: scope.files.map((entry) => entry.id === file.id ? { ...entry, version: stored.version } : entry) };
        await checkAll(updated, signal);
        result = { type: "file_done", scopeId, requestId, version: stored.version, reply: { action: request.action, bytes: bytes.length } };
      }
    } finally { await view.handle.close(); }
    signal?.throwIfAborted();
    return result;
  } catch {
    return { type: "file_failed", scopeId, requestId, cancelled: signal?.aborted === true, mayHaveWritten };
  }
}

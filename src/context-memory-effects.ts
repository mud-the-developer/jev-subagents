import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { lstat, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { snapshotGoalText } from "./goal-file-effects.ts";
import { confirmContextPacket } from "./context-approval.ts";
import { canonicalDirectory, openGoalProjectLock, type GoalProjectOwner } from "./goal-run-effects.ts";
import { MEMORY_APPROVAL_MS, MEMORY_BYTES, MEMORY_ERROR, MEMORY_FILE, memoryHash, reduceMemory,
  type MemoryEffect, type MemoryEvent, type MemoryGrant, type MemoryInput, type MemoryResult, type MemoryState } from "./context-memory.ts";

const fail = (): never => { throw new Error(MEMORY_ERROR); };
const identity = (stat: { dev: number; ino: number }) => ({ dev: stat.dev, ino: stat.ino });
const inside = (root: string, value: string) => { const relative = path.relative(root, value); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
export function memoryOwner(grant: MemoryGrant, store = false) {
  return { ref: { goalId: grant.id, revision: 1, scopeDigest: grant.digest }, activationId: grant.id,
    body: { run: { cwd: store ? grant.body.directory : grant.body.project.path },
      files: { rootIdentity: store ? grant.body.directoryIdentity : grant.body.project.identity } } };
}
export async function prepareMemory(input: MemoryInput, cwd: string, signal?: AbortSignal): Promise<MemoryGrant> {
  if (!["darwin", "linux"].includes(process.platform) || !process.getuid || process.getuid() === 0) return fail();
  const owned = structuredClone(input), project = await canonicalDirectory(cwd), directory = await canonicalDirectory(owned.directory, true);
  const extension = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  let agent = path.resolve(getAgentDir());
  try { agent = await realpath(agent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(); }
  if (inside(project, directory) || inside(directory, project) || inside(extension, directory) || inside(agent, directory)) return fail();
  signal?.throwIfAborted();
  const snapshot = await snapshotGoalText(path.join(directory, MEMORY_FILE), signal), preparedAt = Date.now();
  const body: MemoryGrant["body"] = { input: owned, requestedCwd: cwd, project: { path: project, identity: identity(await lstat(project)) },
    directory, directoryIdentity: identity(await lstat(directory)), snapshot, preparedAt, approvalDeadline: preparedAt + MEMORY_APPROVAL_MS };
  signal?.throwIfAborted();
  return { id: randomUUID(), digest: memoryHash(body), body };
}
export async function checkMemory(grant: MemoryGrant, signal?: AbortSignal): Promise<void> {
  const { body } = grant;
  if (await canonicalDirectory(body.requestedCwd) !== body.project.path || await canonicalDirectory(body.input.directory, true) !== body.directory ||
      !isDeepStrictEqual(identity(await lstat(body.project.path)), body.project.identity) ||
      !isDeepStrictEqual(identity(await lstat(body.directory)), body.directoryIdentity) ||
      !isDeepStrictEqual(await snapshotGoalText(path.join(body.directory, MEMORY_FILE), signal), body.snapshot)) return fail();
  signal?.throwIfAborted();
}

/** Append only. The caller owns the directory lease; a lost write/sync/close acknowledgement is unknown, never retried. */
export async function appendContextFile(filename: string, directoryIdentity: { dev: number; ino: number }, expected: Awaited<ReturnType<typeof snapshotGoalText>>, line: string,
  signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; uncertain: boolean }> {
  let file: FileHandle | undefined, dir: FileHandle | undefined, uncertain = false;
  let text: string | undefined;
  try {
    signal?.throwIfAborted();
    const bytes = Buffer.from(line), prefix = expected?.text ?? "";
    if (Buffer.byteLength(prefix) + bytes.length > MEMORY_BYTES || !line.endsWith("\n") || line.includes("\0")) return { ok: false, uncertain: false };
    if (!isDeepStrictEqual(await snapshotGoalText(filename, signal), expected)) return { ok: false, uncertain: false };
    dir = await fs.open(path.dirname(filename), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!isDeepStrictEqual(identity(await dir.stat()), directoryIdentity)) fail();
    if (!expected) uncertain = true; // Even a rejected create can have applied before acknowledgement was lost.
    file = await fs.open(filename, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | (expected ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
    const stat = await file.stat();
    if (!isDeepStrictEqual(identity(await lstat(path.dirname(filename))), directoryIdentity)) fail();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 ||
        (expected && (!isDeepStrictEqual(identity(stat), expected.version.identity) || stat.size !== expected.version.bytes))) fail();
    if (expected && !isDeepStrictEqual(await snapshotGoalText(filename, signal), expected)) fail();
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted(); uncertain = true;
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) fail();
      offset += bytesWritten;
    }
    await file.sync(); await dir.sync();
    const observed = await snapshotGoalText(filename);
    if (!isDeepStrictEqual(identity(await lstat(path.dirname(filename))), directoryIdentity)) fail();
    if (!observed || !isDeepStrictEqual(observed.version.identity, identity(stat)) || observed.text !== prefix + line) fail();
    text = observed!.text;
  } catch { uncertain = true; /* Read/open/close failures can also leave native ownership uncertain. */ }
  finally {
    try { await file?.close(); } catch { text = undefined; uncertain = true; }
    try { await dir?.close(); } catch { text = undefined; uncertain = true; }
  }
  return text === undefined ? { ok: false, uncertain } : { ok: true, text };
}

export async function manageMemory(input: MemoryInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<MemoryResult> {
  const controller = new AbortController(), execution = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let state: MemoryState = { status: "idle" }, owner: GoalProjectOwner | undefined, store: GoalProjectOwner | undefined;
  let ownerAttempted = false, storeAttempted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const effects: MemoryEffect[] = [];
  const send = (event: MemoryEvent) => {
    const next = reduceMemory(state, event); state = next.state;
    for (const effect of next.effects) { if (effect.type === "abort_memory") controller.abort(); else effects.push(effect); }
  };
  const cancel = () => send({ type: "cancel" });
  signal?.addEventListener("abort", cancel, { once: true });
  send({ type: "start", input, cwd: ctx.cwd });
  if (signal?.aborted) cancel();
  const execute = async (effect: MemoryEffect): Promise<MemoryEvent | undefined> => {
    if (effect.type === "abort_memory") { controller.abort(); return; }
    if (effect.type === "close_memory") {
      let ok = true, keep = effect.keep || (ownerAttempted && !owner) || (storeAttempted && !store);
      try { if (store) keep = await store.close(keep) || keep; } catch { ok = false; keep = true; }
      try { if (owner) keep = await owner.close(keep) || keep; } catch { ok = false; keep = true; }
      return { type: "closed", id: effect.grant.id, ok, retained: keep };
    }
    try {
      execution.throwIfAborted();
      if (!ctx.hasUI) return { type: "failed", uncertain: false };
      if (effect.type === "prepare_memory") {
        const grant = await prepareMemory(effect.input, effect.cwd, execution);
        timer = setTimeout(cancel, Math.max(1, grant.body.approvalDeadline - Date.now()));
        return { type: "prepared", grant };
      }
      const { grant } = effect;
      if (effect.type === "confirm_memory") {
        const approved = await confirmContextPacket(ctx, "Approve this local memory operation?",
          `One project only; no model/JEV/network call. Append only: no overwrite/delete/merge/rotation/retry/recovery. ` +
          `A 32 KiB / 64-record limit stops rather than moving stores. Search is bounded literal matching, not semantic retrieval. ` +
          `Origins/references are recorded claims, not independently verified facts or authority. Different notes on one topic stay separate. ` +
          `Results are reference-only snapshots; later edits/notes may make them stale. Only an explicitly approved bundle may be passed to a worker. ` +
          `The project and store both use exclusive .jev-goal.lock markers; uncertain creation/write/cleanup retains ownership. ` +
          `Cancellation is not rollback. Do not store secrets. Exact request, locations, identities and prior file version:\n\n` +
          JSON.stringify({ id: grant.id, digest: grant.digest, input: grant.body.input, project: grant.body.project,
            directory: grant.body.directory, directoryIdentity: grant.body.directoryIdentity, priorVersion: grant.body.snapshot?.version ?? null }, null, 2),
          grant.body.approvalDeadline, execution);
        return { type: "approval", id: grant.id, digest: grant.digest, approved, now: Date.now() };
      }
      if (effect.type === "open_memory") {
        await checkMemory(grant, execution);
        ownerAttempted = true; owner = await openGoalProjectLock(memoryOwner(grant), execution);
        storeAttempted = true; store = await openGoalProjectLock(memoryOwner(grant, true), execution);
        await checkMemory(grant, execution);
        return { type: "opened", id: grant.id, now: Date.now() };
      }
      await checkMemory(grant, execution);
      const written = await appendContextFile(path.join(grant.body.directory, MEMORY_FILE), grant.body.directoryIdentity, grant.body.snapshot, effect.line, execution);
      return written.ok ? { type: "written", id: grant.id, text: written.text } : { type: "failed", id: grant.id, uncertain: written.uncertain };
    } catch { return { type: "failed", uncertain: (ownerAttempted && !owner) || (storeAttempted && !store) }; }
  };
  try {
    while (effects.length) { const event = await execute(effects.shift()!); if (event) send(event); }
    const final = state as MemoryState;
    if (final.status !== "done") return fail();
    return final.result;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); controller.abort(); }
}

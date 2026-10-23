import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs, { lstat, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openWindowsGoalJournal } from "./windows-journal.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { applyGoalRecord, replayGoal, GoalDigestSchema, GoalHeadSchema, GoalRecordSchema, MAX_GOAL_RECORDS,
  type GoalEvent, type GoalHead, type GoalLedger, type GoalRecord, type GoalStorageEffect } from "./goal-machine.ts";

export const MAX_GOAL_RECORD_BYTES = 65_536;
export const MAX_GOAL_JOURNAL_BYTES = 4 * 1_024 * 1_024;
export const GOAL_JOURNAL_ERROR = "Goal journal is locked, stale, invalid, or unavailable. No automatic retry or recovery.";
const envelopeSchema = Type.Object({
  version: Type.Literal(1), sequence: Type.Integer({ minimum: 1, maximum: MAX_GOAL_RECORDS }),
  previous: Type.Union([GoalDigestSchema, Type.Null()]), record: GoalRecordSchema, checksum: GoalDigestSchema,
}, { additionalProperties: false });
const effectSchema = Type.Object({ type: Type.Literal("append_goal"), expected: GoalHeadSchema, record: GoalRecordSchema }, { additionalProperties: false });
export type GoalJournalSnapshot = { readonly records: readonly GoalRecord[]; readonly head: GoalHead; readonly ledger: GoalLedger | null };
const failure = (): never => { throw new Error(GOAL_JOURNAL_ERROR); };
function checksum(sequence: number, previous: string | null, record: GoalRecord): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, sequence, previous, record })).digest("hex");
}

/** Effect-layer decoding: strict UTF-8, canonical JSONL, hash chain, then the shared pure fold. */
export function decodeGoalJournal(bytes: Uint8Array): GoalJournalSnapshot {
  try {
    if (bytes.byteLength > MAX_GOAL_JOURNAL_BYTES) return failure();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text && !text.endsWith("\n")) return failure();
    const lines = text ? text.slice(0, -1).split("\n") : [];
    if (lines.length > MAX_GOAL_RECORDS) return failure();
    const records: GoalRecord[] = [];
    let head: GoalHead = { sequence: 0, hash: null };
    for (const line of lines) {
      if (!line || Buffer.byteLength(line) + 1 > MAX_GOAL_RECORD_BYTES) return failure();
      const envelope: unknown = JSON.parse(line);
      if (!Value.Check(envelopeSchema, envelope) || JSON.stringify(envelope) !== line ||
          envelope.sequence !== head.sequence + 1 || envelope.previous !== head.hash ||
          envelope.checksum !== checksum(envelope.sequence, envelope.previous, envelope.record)) return failure();
      records.push(envelope.record);
      head = { sequence: envelope.sequence, hash: envelope.checksum };
    }
    return { records, head, ledger: replayGoal(records) };
  } catch { return failure(); }
}

type Identity = { readonly dev: number; readonly ino: number };
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
export type GoalJournal = {
  readonly load: () => Promise<GoalJournalSnapshot>;
  readonly append: (effect: GoalStorageEffect, signal?: AbortSignal) => Promise<GoalHead>;
  readonly close: () => Promise<void>;
};

/** Caller supplies an existing private directory. No default path, mkdir, lock takeover, or truncation. */
export async function openGoalJournal(directory: string, mode: "create" | "open", signal?: AbortSignal): Promise<GoalJournal> {
  if (process.platform === "win32") return openWindowsGoalJournal(directory, mode, signal);
  let directoryHandle: FileHandle | undefined, lock: FileHandle | undefined, journal: FileHandle | undefined;
  let root = "", lockIdentity: Identity | undefined, directoryIdentity: Identity | undefined;
  let active = true, busy = false, poisoned = false;
  let closing: Promise<void> | undefined;
  const removeOwnLock = async () => {
    if (!lockIdentity || !directoryIdentity || !directoryHandle) return;
    const [dir, current] = await Promise.all([lstat(root), lstat(path.join(root, "owner.lock"))]);
    if (!dir.isDirectory() || !sameFile(dir, directoryIdentity) || !current.isFile() || !sameFile(current, lockIdentity)) return failure();
    await unlink(path.join(root, "owner.lock"));
    await directoryHandle.sync();
    lockIdentity = undefined;
  };
  try {
    signal?.throwIfAborted();
    if (!["darwin", "linux"].includes(process.platform) || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory) ||
        !["create", "open"].includes(mode)) return failure();
    // A trailing separator makes POSIX lstat follow a directory symlink; inspect the leaf itself.
    const supplied = await lstat(directory.replace(/\/+$/, "") || "/"), uid = process.getuid?.();
    if (uid === undefined || !supplied.isDirectory() || (supplied.mode & 0o077) !== 0 || supplied.uid !== uid) return failure();
    root = await realpath(directory);
    directoryHandle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directoryIdentity = await directoryHandle.stat();
    if (!sameFile(supplied, directoryIdentity)) return failure();
    lock = await fs.open(path.join(root, "owner.lock"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    lockIdentity = await lock.stat();
    await lock.sync();
    await directoryHandle.sync();
    signal?.throwIfAborted();
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    journal = await fs.open(path.join(root, "goal.jsonl"), flags | (mode === "create" ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
    const journalIdentity = await journal.stat();
    if (!journalIdentity.isFile() || journalIdentity.nlink !== 1 || (journalIdentity.mode & 0o077) !== 0 || journalIdentity.uid !== uid) return failure();
    if (mode === "create") { await journal.sync(); await directoryHandle.sync(); }
    const file = journal, dirHandle = directoryHandle, rootIdentity = directoryIdentity, ownerIdentity = lockIdentity;
    const assertOwner = async () => {
      if (!active || poisoned) return failure();
      const [dir, owner, current] = await Promise.all([lstat(root), lstat(path.join(root, "owner.lock")), lstat(path.join(root, "goal.jsonl"))]);
      if (!dir.isDirectory() || !sameFile(dir, rootIdentity) || !owner.isFile() || owner.nlink !== 1 || !sameFile(owner, ownerIdentity) ||
          !current.isFile() || current.nlink !== 1 || !sameFile(current, journalIdentity) ||
          [dir, owner, current].some((entry) => entry.uid !== uid || (entry.mode & 0o077) !== 0)) return failure();
    };
    const read = async (expected?: GoalHead) => {
      await assertOwner();
      const before = await file.stat();
      if (before.size > MAX_GOAL_JOURNAL_BYTES) return failure();
      const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_GOAL_JOURNAL_BYTES + 1));
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== before.size || (await file.stat()).size !== before.size) return failure();
      await assertOwner();
      const snapshot = decodeGoalJournal(bytes.subarray(0, length));
      if (expected && !isDeepStrictEqual(snapshot.head, expected)) return failure();
      return { snapshot, length };
    };
    let knownHead = (await read()).snapshot.head; // Pin this handle's history, not live goal authority.
    signal?.throwIfAborted();
    return {
      async load() {
        if (busy || !active || poisoned) return failure();
        busy = true;
        try { return (await read(knownHead)).snapshot; }
        catch { poisoned = true; return failure(); }
        finally { busy = false; }
      },
      async append(input, appendSignal) {
        if (busy || !active || poisoned) return failure();
        busy = true;
        try {
          if (!Value.Check(effectSchema, input)) return failure();
          const effect = structuredClone(input);
          appendSignal?.throwIfAborted();
          const { snapshot, length } = await read(knownHead);
          if (!isDeepStrictEqual(snapshot.head, effect.expected)) return failure();
          applyGoalRecord(snapshot.ledger, effect.record);
          const sequence = snapshot.head.sequence + 1;
          const hash = checksum(sequence, snapshot.head.hash, effect.record);
          const bytes = Buffer.from(JSON.stringify({ version: 1, sequence, previous: snapshot.head.hash, record: effect.record, checksum: hash }) + "\n");
          const settlementRoom = effect.record.type === "reserved" ? MAX_GOAL_RECORD_BYTES : 0;
          if (bytes.length > MAX_GOAL_RECORD_BYTES || length + bytes.length + settlementRoom > MAX_GOAL_JOURNAL_BYTES || sequence > MAX_GOAL_RECORDS) return failure();
          await assertOwner();
          appendSignal?.throwIfAborted();
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
            if (bytesWritten <= 0) return failure();
            offset += bytesWritten;
          }
          await file.sync();
          await dirHandle.sync();
          const head = { sequence, hash };
          if ((await read(head)).length !== length + bytes.length) return failure();
          appendSignal?.throwIfAborted(); // A lost/cancelled ack is not evidence that the write did not apply.
          knownHead = head;
          return { ...head };
        } catch { poisoned = true; return failure(); }
        finally { busy = false; }
      },
      async close() {
        if (closing) return closing;
        if (busy) return failure();
        active = false;
        closing = (async () => {
          let failed = false;
          try { await file.close(); } catch { failed = true; }
          if (!failed) { try { await removeOwnLock(); } catch { failed = true; } }
          for (const handle of [lock, directoryHandle]) { try { await handle?.close(); } catch { failed = true; } }
          if (failed) return failure();
        })();
        return closing;
      },
    };
  } catch {
    // No rollback of a created/partially written journal. Only release this invocation's resources.
    let closed = true;
    try { await journal?.close(); } catch { closed = false; }
    if (closed) { try { await removeOwnLock(); } catch { /* A remaining owner marker requires explicit inspection. */ } }
    try { await lock?.close(); } catch { /* No raw filesystem exception. */ }
    try { await directoryHandle?.close(); } catch { /* No raw filesystem exception. */ }
    return failure();
  }
}

/** Storage wiring only. No admission, worker, network, approval UI, or dispatch executor exists here. */
export async function executeGoalStorageEffect(effect: GoalStorageEffect, journal: GoalJournal, signal?: AbortSignal): Promise<GoalEvent> {
  let owned: GoalStorageEffect;
  try {
    if (!Value.Check(effectSchema, effect)) return failure();
    owned = structuredClone(effect);
  } catch { return failure(); }
  try {
    if (signal?.aborted) return { type: "cancel" };
    const head = await journal.append(owned, signal);
    return signal?.aborted ? { type: "cancel" }
      : { type: "persisted", expected: owned.expected, record: owned.record, head, now: Date.now() };
  } catch { return signal?.aborted ? { type: "cancel" } : { type: "storage_failed", expected: owned.expected, record: owned.record }; }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs, { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ownWindowsProcess, type WindowsJob } from "../src/windows-job.ts";
import { isWindowsPrivateProfile } from "../src/windows-profile-files.ts";
import { decodeGoalJournal, executeGoalStorageEffect, openGoalJournal, GOAL_JOURNAL_ERROR,
  MAX_GOAL_JOURNAL_BYTES, MAX_GOAL_RECORD_BYTES, type GoalJournal } from "../src/goal-journal.ts";
import { reduceGoal, ZERO_GOAL_UNITS, EMPTY_GOAL_HEAD, MAX_GOAL_RECORDS,
  type GoalDefinition, type GoalEvent, type GoalRecord, type GoalStorageEffect, type GoalTransition, type GoalUnits } from "../src/goal-machine.ts";

const ref = { goalId: "fixture-goal", revision: 1, scopeDigest: "a".repeat(64) };
const definition: GoalDefinition = { ref, limits: { ...ZERO_GOAL_UNITS, workerRuns: 2, workerCalls: 6 }, maxTotalCalls: 6, deadlineMs: 10_000 };
const activationId = "activation-one";
const records: GoalRecord[] = [
  { type: "created", definition, at: 100 },
  { type: "approved", ref, activationId, at: 110 },
  { type: "reserved", ref, activationId, at: 120,
    intent: { id: "operation-one", planDigest: "b".repeat(64), reserve: { ...ZERO_GOAL_UNITS, workerRuns: 1, workerCalls: 4 } } },
];
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "jev-goal-"));
  const journals: GoalJournal[] = [];
  t.after(async () => {
    // Close descriptors before deleting paths; intentional close failures are asserted by their tests.
    for (const journal of journals.toReversed()) { try { await journal.close(); } catch { /* Negative fixture. */ } }
    await rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, "journal");
  await mkdir(directory, { mode: 0o700 });
  return { root, directory, file: path.join(directory, "goal.jsonl"), lock: path.join(directory, "owner.lock"),
    async open(mode: "create" | "open" = "create") {
      const journal = await openGoalJournal(directory, mode);
      journals.push(journal);
      return journal;
    } };
}
async function append(journal: GoalJournal, record: GoalRecord) {
  const snapshot = await journal.load();
  return journal.append({ type: "append_goal", expected: snapshot.head, record });
}
async function captureJournalHandle(t: TestContext, openJournal: () => Promise<GoalJournal>) {
  const nativeOpen = fs.open;
  let handle: FileHandle | undefined;
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await nativeOpen(...args);
    if (path.basename(String(args[0])) === "goal.jsonl") handle = file;
    return file;
  });
  syncBuiltinESMExports();
  try {
    const journal = await openJournal();
    assert.ok(handle);
    return { journal, handle };
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
}
async function handlePrototype(root: string): Promise<Pick<FileHandle, "sync" | "write">> {
  const probe = await open(path.join(root, "probe"), "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, "sync" | "write">;
  await probe.close();
  return prototype;
}
function wire(records: readonly GoalRecord[]): Buffer {
  let previous: string | null = null;
  return Buffer.from(records.map((record, i) => {
    const body = { version: 1, sequence: i + 1, previous, record };
    const checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    previous = checksum;
    return JSON.stringify({ ...body, checksum }) + "\n";
  }).join(""));
}
function effect(t: GoalTransition): GoalStorageEffect {
  const value = t.effects[0];
  if (value?.type !== "append_goal") throw new Error("Missing fixture append");
  return value;
}

test("recorded real-model C2 journal replays offline without restoring execution authority", async () => {
  const base = new URL("../benchmarks/goal-c2/", import.meta.url);
  const report = JSON.parse(await readFile(new URL("live-2026-09-26.json", base), "utf8"));
  const bytes = await readFile(new URL("live-2026-09-26.jsonl", base));
  assert.equal(bytes.length, report.journal.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), report.journal.sha256);
  assert.equal(createHash("sha256").update(report.fixture.checkerSource).digest("hex"), report.fixture.checkerSha256);
  const snapshot = decodeGoalJournal(bytes), ledger = snapshot.ledger;
  assert.ok(ledger);
  assert.deepEqual(snapshot.head, { sequence: 23, hash: report.journal.headHash });
  assert.deepEqual(ledger.spent, report.observed.spent);
  assert.equal(ledger.spent.workerCalls + ledger.spent.plannerCalls, 11);
  assert.equal(ledger.spent.repairs, 1);
  assert.equal(ledger.totalUsd, report.observed.estimatedTotalUsd);
  assert.deepEqual(ledger.held, ZERO_GOAL_UNITS);
  assert.equal(ledger.pending, null); assert.equal(ledger.activationId, null); assert.equal(ledger.blocked, false);
  const settlements = snapshot.records.filter(record => record.type === "settled");
  assert.ok(settlements.every(record => record.result.accountingComplete && record.result.cleanupConfirmed));
  const checks = settlements.flatMap(record => record.result.verification ? [record.result.verification] : []);
  assert.deepEqual(checks.map(({ stage, checkId, exitCode }) => ({ stage, checkId, exitCode })), report.observed.checks);
  assert.ok(checks.every(check => check.status === "exited" && check.isolated && check.filesCurrent));
  const repair = snapshot.records.findIndex(record => record.type === "reserved" && record.intent.reserve.repairs === 1);
  const beforeRepair = snapshot.records[repair - 1];
  assert.ok(beforeRepair?.type === "settled");
  assert.equal(beforeRepair.result.verification?.stage, "step");
  assert.equal(beforeRepair.result.verification?.exitCode, 42);
  const restored = reduceGoal({ status: "idle" }, { type: "restore", records: snapshot.records,
    head: snapshot.head, activationId: "offline-c2-review", now: ledger.lastAt + 1 });
  assert.equal(restored.state.status, "awaiting_approval");
  assert.deepEqual(restored.effects, []);
});

test("native goal journal syncs bounded records, owns snapshots, and restores without granting execution", async (t) => {
  t.mock.method(Date, "now", () => 1_000);
  const f = await fixture(t), journal = await f.open();
  let transition = reduceGoal({ status: "idle" }, { type: "create", definition, activationId, now: 100 });
  const store = async () => { transition = reduceGoal(transition.state, await executeGoalStorageEffect(effect(transition), journal)); };
  await store();
  assert.equal(transition.state.status, "awaiting_approval");
  transition = reduceGoal(transition.state, { type: "approval", ref, activationId, approved: true, now: 1_000 });
  await store();
  const reserve = records[2];
  if (reserve?.type !== "reserved") return assert.fail();
  transition = reduceGoal(transition.state, { type: "reserve", ref, activationId, intent: reserve.intent, now: 1_000 });
  await store();
  assert.equal(transition.state.status, "checking");
  assert.equal(transition.effects[0]?.type, "check_goal_admission");
  const snapshot = await journal.load();
  assert.equal(snapshot.head.sequence, 3);
  assert.equal(snapshot.ledger?.held.workerCalls, 4);
  assert.equal(snapshot.ledger?.totalUsd, null);
  // NTFS mode bits do not describe DACL privacy. Held native descriptors enforce it on every load;
  // audit the persisted leaf independently after verified close below, without weakening sharing.
  if (process.platform !== "win32") {
    assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.lock)).mode & 0o777, 0o600);
  }
  if (snapshot.records[0]?.type !== "created") return assert.fail();
  snapshot.records[0].definition.limits.workerCalls = 999;
  assert.equal((await journal.load()).ledger?.definition.limits.workerCalls, 6);
  await journal.close();
  if (process.platform === "win32") assert.equal(await isWindowsPrivateProfile(f.file), true);
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
  const restoredStore = await f.open("open"), restored = await restoredStore.load();
  const projection = reduceGoal({ status: "idle" }, { type: "restore", records: restored.records, head: restored.head, activationId: "activation-two", now: 2_000 });
  assert.equal(projection.state.status, "needs_review");
  assert.deepEqual(projection.effects, []);
  assert.equal("ledger" in projection.state && projection.state.ledger?.held.workerCalls, 4);
});

test("journal rejects stale CAS, duplicate append, concurrent owners and queued writers without overwriting", async (t) => {
  const f = await fixture(t), journal = await f.open();
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
  const first: GoalStorageEffect = { type: "append_goal", expected: EMPTY_GOAL_HEAD, record: records[0]! };
  const one = journal.append(first), two = journal.append(first);
  await assert.rejects(two, { message: GOAL_JOURNAL_ERROR });
  await one;
  const before = await readFile(f.file);
  await assert.rejects(journal.append(first), { message: GOAL_JOURNAL_ERROR });
  assert.deepEqual(await readFile(f.file), before);
  await journal.close();
  const reopened = await f.open("open");
  const head = (await reopened.load()).head;
  await assert.rejects(reopened.append({ type: "append_goal", expected: { ...head, hash: "f".repeat(64) }, record: records[1]! }), { message: GOAL_JOURNAL_ERROR });
  assert.deepEqual(await readFile(f.file), before);
});

test("strict journal decoding rejects truncation, corruption, reordered/duplicate records, duplicate keys and malformed UTF-8", () => {
  const valid = wire(records), text = valid.toString("utf8"), lines = text.trimEnd().split("\n");
  assert.equal(decodeGoalJournal(valid).ledger?.pending?.id, "operation-one");
  const forged = structuredClone(records);
  if (forged[2]?.type !== "reserved") return assert.fail();
  forged[2].intent.reserve.workerCalls = 7;
  for (const bytes of [valid.subarray(0, valid.length - 1), Buffer.from(text + "\n"),
    Buffer.from(text.replace('"workerCalls":4', '"workerCalls":5')),
    Buffer.from([lines[1], lines[0], lines[2]].join("\n") + "\n"),
    Buffer.from(text + lines[2] + "\n"), Buffer.from(text.replace('"version":1', '"version":1,"version":1')),
    Buffer.from(text.replace('"at":100', '"at":1e2')), Buffer.from(text.replace('"version":1', '"version":2')),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), Buffer.concat([valid, Buffer.from([0xc3, 0x28, 0x0a])]),
    Buffer.alloc(MAX_GOAL_RECORD_BYTES + 1, 32), Buffer.alloc(MAX_GOAL_JOURNAL_BYTES + 1), wire(forged)]) {
    assert.throws(() => decodeGoalJournal(bytes), { message: GOAL_JOURNAL_ERROR });
  }
  assert.deepEqual(decodeGoalJournal(Buffer.alloc(0)), { records: [], head: EMPTY_GOAL_HEAD, ledger: null });
});

test("journal refuses existing files, symlinks, hardlinks and shared directories without reading or replacing targets", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "untouched");
  await writeFile(target, "fixture-private-marker", { mode: 0o600 });
  await symlink(target, f.file);
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
  assert.ok((await lstat(f.file)).isSymbolicLink());
  assert.equal(await readFile(target, "utf8"), "fixture-private-marker");
  await unlink(f.file);
  await symlink(path.join(f.root, "missing"), f.lock);
  await assert.rejects(openGoalJournal(f.directory, "create"), { message: GOAL_JOURNAL_ERROR });
  assert.ok((await lstat(f.lock)).isSymbolicLink());
  await unlink(f.lock);
  await link(target, f.file);
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
  assert.equal(await readFile(target, "utf8"), "fixture-private-marker");
  await unlink(f.file);
  const journal = await f.open();
  await journal.close();
  await assert.rejects(openGoalJournal(f.directory, "create"), { message: GOAL_JOURNAL_ERROR });
  assert.equal((await readFile(f.file)).length, 0);
  const alias = path.join(f.root, "alias");
  await symlink(f.directory, alias);
  await assert.rejects(openGoalJournal(alias, "open"), { message: GOAL_JOURNAL_ERROR });
  for (const suffix of ["/", "///"]) {
    await assert.rejects(openGoalJournal(alias + suffix, "open").then((unexpected) => unexpected.close()), { message: GOAL_JOURNAL_ERROR });
  }
  await (await openGoalJournal(f.directory + "/", "open")).close();
  await chmod(f.directory, 0o755);
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
});

test("record and byte ceilings fail closed without truncation or implicit rotation", async (t) => {
  const f = await fixture(t);
  const bounded: GoalRecord[] = [records[0]!];
  let active = "";
  for (let i = 1; i < MAX_GOAL_RECORDS; i++) {
    if (i % 2) { active = `activation-${i}`; bounded.push({ type: "approved", ref, activationId: active, at: 100 + i }); }
    else bounded.push({ type: "closed", ref, activationId: active, at: 100 + i, reason: "paused" });
  }
  const bytes = wire(bounded);
  assert.ok(bytes.length < MAX_GOAL_JOURNAL_BYTES);
  await writeFile(f.file, bytes, { flag: "wx", mode: 0o600 });
  const journal = await f.open("open");
  const snapshot = await journal.load();
  assert.equal(snapshot.head.sequence, MAX_GOAL_RECORDS);
  await assert.rejects(journal.append({ type: "append_goal", expected: snapshot.head,
    record: { type: "closed", ref, activationId: active, at: 5_000, reason: "paused" } }), { message: GOAL_JOURNAL_ERROR });
  assert.deepEqual(await readFile(f.file), bytes);
  await journal.close();
  await writeFile(f.file, Buffer.alloc(MAX_GOAL_JOURNAL_BYTES + 1));
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
  assert.equal((await lstat(f.file)).size, MAX_GOAL_JOURNAL_BYTES + 1);
});

test("sync failure after a write is sanitized and never acknowledges admission; a lost ack retains the reservation", async (t) => {
  const f = await fixture(t), journal = await f.open();
  await append(journal, records[0]!); await append(journal, records[1]!);
  const before = await journal.load(), inode = (await lstat(f.file)).ino;
  const prototype = await handlePrototype(f.root), sync = prototype.sync;
  const mock = t.mock.method(prototype, "sync", async function(this: FileHandle) {
    await sync.call(this);
    if ((await this.stat()).ino === inode) throw new Error("fixture-private-filesystem-error");
  });
  const write: GoalStorageEffect = { type: "append_goal", expected: before.head, record: records[2]! };
  const failure = await executeGoalStorageEffect(write, journal);
  assert.equal(failure.type, "storage_failed");
  assert.ok(!JSON.stringify(failure).includes("fixture-private-filesystem-error"));
  mock.mock.restore();
  await assert.rejects(journal.load(), { message: GOAL_JOURNAL_ERROR });
  await journal.close();
  const reopened = await f.open("open"), disk = await reopened.load();
  assert.equal(disk.head.sequence, 3);
  const restored = reduceGoal({ status: "idle" }, { type: "restore", records: disk.records, head: disk.head, activationId: "activation-two", now: 1_000 });
  assert.equal(restored.state.status, "needs_review");
  assert.equal("ledger" in restored.state && restored.state.ledger?.held.workerCalls, 4);
  assert.deepEqual(restored.effects, []);
});

test("cancellation before append writes nothing; cancellation during sync is not a not-applied acknowledgement", async (t) => {
  const f = await fixture(t), journal = await f.open();
  const already = new AbortController(); already.abort();
  assert.deepEqual(await executeGoalStorageEffect({ type: "append_goal", expected: EMPTY_GOAL_HEAD, record: records[0]! }, journal, already.signal), { type: "cancel" });
  assert.equal((await readFile(f.file)).length, 0);
  await append(journal, records[0]!); await append(journal, records[1]!);
  const current = await journal.load(), controller = new AbortController(), inode = (await lstat(f.file)).ino;
  const prototype = await handlePrototype(f.root), sync = prototype.sync;
  const mock = t.mock.method(prototype, "sync", async function(this: FileHandle) {
    await sync.call(this); if ((await this.stat()).ino === inode) controller.abort();
  });
  const event = await executeGoalStorageEffect({ type: "append_goal", expected: current.head, record: records[2]! }, journal, controller.signal);
  assert.deepEqual(event, { type: "cancel" });
  mock.mock.restore();
  assert.equal(decodeGoalJournal(await readFile(f.file)).ledger?.pending?.id, "operation-one");
});

test("partial writes and replaced file/owner identities cannot be silently repaired or acknowledged", async (t) => {
  const f = await fixture(t), journal = await f.open();
  const inode = (await lstat(f.file)).ino;
  const prototype = await handlePrototype(f.root), write = prototype.write;
  const mock = t.mock.method(prototype, "write", (async function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number | null) {
    if ((await this.stat()).ino !== inode) return Reflect.apply(write, this, [bytes, offset, length, position]);
    await Reflect.apply(write, this, [bytes, offset, Math.min(20, length), position]);
    throw new Error("fixture-partial-write");
  }) as FileHandle["write"]);
  await assert.rejects(append(journal, records[0]!), { message: GOAL_JOURNAL_ERROR });
  mock.mock.restore();
  await journal.close();
  assert.equal((await lstat(f.file)).size, 20);
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
  assert.equal((await lstat(f.file)).size, 20);
  // Explicit fixture cleanup, not a production repair API.
  await unlink(f.file);
  const replaced = await f.open();
  await rename(f.file, path.join(f.root, "original"));
  await writeFile(f.file, "", { flag: "wx", mode: 0o600 });
  await assert.rejects(replaced.load(), { message: GOAL_JOURNAL_ERROR });
  await rename(f.lock, path.join(f.root, "original-lock"));
  await writeFile(f.lock, "replacement-owner", { flag: "wx", mode: 0o600 });
  await assert.rejects(replaced.close(), { message: GOAL_JOURNAL_ERROR });
  assert.equal(await readFile(f.lock, "utf8"), "replacement-owner");
});

test("a crashed native owner leaves a lock and unresolved intent, never an automatically resumed worker", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t), script = path.join(f.root, "crash.mjs");
  const source = `import {once} from 'node:events';
import {openGoalJournal} from ${JSON.stringify(new URL("../src/goal-journal.ts", import.meta.url).href)};
const started=once(process,'message'); process.send({idle:true});
if((await started)[0]!=='start') throw new Error('invalid fixture admission');
const journal=await openGoalJournal(${JSON.stringify(f.directory)},'create');
for(const record of ${JSON.stringify(records)}) { const {head}=await journal.load(); await journal.append({type:'append_goal',expected:head,record}); }
process.send({ready:true}); setInterval(()=>{},1000);`;
  await writeFile(script, source, { flag: "wx", mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", HOME: f.root, USERPROFILE: f.root,
    PI_CODING_AGENT_DIR: f.root, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.ok(systemRoot && path.isAbsolute(systemRoot));
    Object.assign(env, { SystemRoot: systemRoot, TEMP: f.root, TMP: f.root });
  }
  const born = Date.now(), child = fork(script, [], { execPath: process.execPath, execArgv: [], env,
    stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let job: WindowsJob | undefined;
  t.after(async () => {
    if (job) assert.equal(await job.close(), true);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  });
  const message = () => once(child, "message", { signal: AbortSignal.timeout(5_000) });
  assert.deepEqual((await message())[0], { idle: true });
  if (process.platform === "win32") job = await ownWindowsProcess(child, born);
  const ready = message(); child.send("start");
  assert.deepEqual((await ready)[0], { ready: true });
  const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
  // Parent exit alone is not descendant-cleanup proof; confirm the existing Job before inspection.
  if (job) assert.equal(await job.close(), true);
  assert.ok((await lstat(f.lock)).isFile());
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
  // Simulate explicit human inspection of this isolated dead fixture owner, never automatic takeover.
  await unlink(f.lock);
  const reopened = await f.open("open"), snapshot = await reopened.load();
  const restored = reduceGoal({ status: "idle" }, { type: "restore", records: snapshot.records, head: snapshot.head, activationId: "activation-two", now: 1_000 });
  assert.equal(restored.state.status, "needs_review");
  assert.deepEqual(restored.effects, []);
  assert.equal("ledger" in restored.state && restored.state.ledger?.totalUsd, null);
});

test("an open journal rejects valid prefix rollback and same-length history replacement", async (t) => {
  for (const mutation of ["prefix", "replacement"] as const) {
    const f = await fixture(t), journal = await f.open();
    for (const record of records) await append(journal, record);
    const changed = structuredClone(records);
    if (changed[0]?.type !== "created") return assert.fail();
    changed[0].definition.limits.workerCalls = 5;
    const bytes = wire(mutation === "prefix" ? records.slice(0, 2) : changed);
    assert.ok(decodeGoalJournal(bytes).ledger);
    if (mutation === "replacement") assert.equal(bytes.length, (await readFile(f.file)).length);
    await writeFile(f.file, bytes);
    await assert.rejects(journal.load(), { message: GOAL_JOURNAL_ERROR });
    assert.deepEqual(await readFile(f.file), bytes, "no automatic restoration or truncation");
    await journal.close();
  }
});

test("append must observe its actual stored head after sync before acknowledging admission", async (t) => {
  const f = await fixture(t), journal = await f.open();
  await append(journal, records[0]!); await append(journal, records[1]!);
  const head = (await journal.load()).head, inode = (await lstat(f.file)).ino;
  const prototype = await handlePrototype(f.root), sync = prototype.sync;
  const hook = t.mock.method(prototype, "sync", async function(this: FileHandle) {
    await sync.call(this);
    if ((await this.stat()).ino === inode) await writeFile(f.file, wire(records.slice(0, 2)));
  });
  try {
    const event = await executeGoalStorageEffect({ type: "append_goal", expected: head, record: records[2]! }, journal);
    assert.equal(event.type, "storage_failed");
    await assert.rejects(journal.load(), { message: GOAL_JOURNAL_ERROR });
    assert.equal(decodeGoalJournal(await readFile(f.file)).head.sequence, 2);
  } finally { hook.mock.restore(); await journal.close(); }
});

test("concurrent close waits for the same cleanup rather than reporting success early", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t), { journal, handle } = await captureJournalHandle(t, f.open);
  const close = handle.close.bind(handle);
  let enter = () => {}, release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const hook = t.mock.method(handle, "close", async () => {
    enter(); await proceed;
    return close();
  });
  const first = journal.close();
  await entered;
  let returned = false;
  const second = journal.close().then(() => { returned = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(returned, false);
    assert.ok((await lstat(f.lock)).isFile());
  } finally { release(); await Promise.all([first, second]); hook.mock.restore(); }
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
});

test("a failed journal close remains failed and retains ownership when descriptor closure is uncertain", async (t) => {
  const f = await fixture(t), { journal, handle } = await captureJournalHandle(t, f.open);
  const close = handle.close.bind(handle);
  const hook = t.mock.method(handle, "close", async () => {
    await close();
    throw new Error("fixture-private-close-error");
  });
  await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
  hook.mock.restore();
  await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
  assert.ok((await lstat(f.lock)).isFile());
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
});

test("startup cleanup also retains ownership when closing an invalid journal cannot be confirmed", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "fixture-invalid-journal", { flag: "wx", mode: 0o600 });
  const nativeOpen = fs.open;
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await nativeOpen(...args);
    if (path.basename(String(args[0])) === "goal.jsonl") {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); throw new Error("fixture-private-startup-close-error"); });
    }
    return file;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR }); }
  finally { hook.mock.restore(); syncBuiltinESMExports(); }
  assert.ok((await lstat(f.lock)).isFile());
  assert.equal(await readFile(f.file, "utf8"), "fixture-invalid-journal");
  await assert.rejects(openGoalJournal(f.directory, "open"), { message: GOAL_JOURNAL_ERROR });
});

test("short native reads/writes preserve exact bytes and snapshots; busy close cannot release ownership", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t), { journal, handle } = await captureJournalHandle(t, f.open);
  const nativeRead = handle.read.bind(handle), nativeWrite = handle.write.bind(handle), nativeSync = handle.sync.bind(handle);
  let reads = 0, writes = 0, enter = () => {}, release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const readHook = t.mock.method(handle, "read", (async (bytes: Uint8Array, offset: number, length: number, position: number) => {
    reads++;
    return Reflect.apply(nativeRead, undefined, [bytes, offset, Math.min(length, 19), position]);
  }) as FileHandle["read"]);
  const writeHook = t.mock.method(handle, "write", (async (bytes: Uint8Array, offset: number, length: number, position: number | null) => {
    writes++;
    return Reflect.apply(nativeWrite, undefined, [bytes, offset, Math.min(length, 23), position]);
  }) as FileHandle["write"]);
  const syncHook = t.mock.method(handle, "sync", async () => { enter(); await proceed; await nativeSync(); });
  const input: GoalStorageEffect = { type: "append_goal", expected: { ...EMPTY_GOAL_HEAD }, record: structuredClone(records[0]!) };
  const pending = journal.append(input);
  try {
    await Promise.race([entered, pending.then(() => assert.fail("Missing sync barrier"))]);
    if (input.record.type !== "created") return assert.fail();
    input.record.definition.limits.workerCalls = 999;
    Object.assign(input.expected, { sequence: 999 });
    await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
    await assert.rejects(journal.load(), { message: GOAL_JOURNAL_ERROR });
    assert.ok((await lstat(f.lock)).isFile());
    release();
    const head = await pending;
    Object.assign(head, { hash: "f".repeat(64) });
    assert.deepEqual(await readFile(f.file), wire(records.slice(0, 1)));
    const snapshot = await journal.load();
    assert.equal(snapshot.ledger?.definition.limits.workerCalls, 6);
    assert.notEqual(snapshot.head.hash, head.hash);
    assert.ok(reads > 1 && writes > 1);
  } finally {
    release();
    try { await pending; }
    finally { readHook.mock.restore(); writeHook.mock.restore(); syncHook.mock.restore(); await journal.close(); }
  }
});

test("native journal roundtrip preserves mixed budgets across checkpoints and renewed approval without executing a model", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const f = await fixture(t);
  let journal = await f.open();
  const grant: GoalDefinition = { ...definition, limits: { ...ZERO_GOAL_UNITS,
    workerRuns: 2, workerCalls: 4, plannerCalls: 1, summaryCalls: 1, jevCalls: 1, verificationRuns: 1 }, maxTotalCalls: 5 };
  let transition = reduceGoal({ status: "idle" }, { type: "create", definition: grant, activationId, now });
  const send = (event: GoalEvent) => { transition = reduceGoal(transition.state, event); };
  const save = async () => {
    send(await executeGoalStorageEffect(effect(transition), journal));
    if (!("ledger" in transition.state)) return assert.fail();
    assert.deepEqual(transition.state.ledger, (await journal.load()).ledger);
    return transition;
  };
  await save();
  send({ type: "approval", ref, activationId, approved: true, now }); await save();
  const operations: Partial<GoalUnits>[] = [{ plannerCalls: 1 }, { jevCalls: 1 },
    { workerRuns: 1, workerCalls: 3 }, { verificationRuns: 1 }, { summaryCalls: 1 }];
  let dispatches = 0;
  for (const [i, counts] of operations.entries()) {
    const intent = { id: `operation-${i}`, planDigest: "b".repeat(64), reserve: { ...ZERO_GOAL_UNITS, ...counts } };
    send({ type: "reserve", ref, activationId, intent, now });
    assert.equal(transition.effects[0]?.type, "append_goal");
    const saved = await save(), observation = saved.effects[0];
    if (observation?.type !== "check_goal_admission") return assert.fail();
    const admission: GoalEvent = { type: "admission", ref, activationId, intentId: intent.id, head: observation.head, current: true, now };
    send(admission);
    assert.equal(transition.effects[0]?.type, "dispatch_goal_operation"); dispatches++;
    send(admission); assert.deepEqual(transition.effects, []);
    // These are synthetic observations, not worker/planner/verifier execution.
    const used = { ...intent.reserve, ...(counts.workerCalls ? { workerCalls: 2 } : {}) };
    const settlement: GoalEvent = { type: "settlement", ref, activationId, intentId: intent.id, now,
      result: { outcome: "succeeded", used, observedUsd: 0.01, accountingComplete: true, cleanupConfirmed: true } };
    send(settlement); await save();
    send(settlement); assert.deepEqual(transition.effects, []);
    assert.equal(transition.state.status, "ready");
  }
  assert.equal(dispatches, 5);
  const complete = (await journal.load()).ledger;
  assert.equal(complete?.observedUsd, 0.05);
  assert.equal(complete?.totalUsd, 0.05);
  assert.deepEqual(complete?.held, ZERO_GOAL_UNITS);
  assert.equal(complete?.spent.workerCalls, 2);
  send({ type: "pause" }); await save(); assert.equal(transition.state.status, "paused");
  await journal.close(); journal = await f.open("open");
  const snapshot = await journal.load();
  now = 2_000;
  transition = reduceGoal({ status: "idle" }, { type: "restore", records: snapshot.records, head: snapshot.head, activationId: "activation-two", now });
  assert.equal(transition.state.status, "awaiting_approval"); assert.deepEqual(transition.effects, []);
  send({ type: "approval", ref, activationId, approved: true, now }); assert.deepEqual(transition.effects, []);
  send({ type: "approval", ref, activationId: "activation-two", approved: true, now }); await save();
  send({ type: "reserve", ref, activationId: "activation-two", now,
    intent: { id: "cannot-reset-budget", planDigest: "b".repeat(64), reserve: { ...ZERO_GOAL_UNITS, workerCalls: 1 } } });
  assert.equal(transition.state.status, "needs_review"); assert.deepEqual(transition.effects, []);
  assert.deepEqual((await journal.load()).ledger?.spent, complete?.spent);
  await journal.close();
});

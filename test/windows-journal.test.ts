import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile, link, symlink, rename, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createWindowsProfiles, isWindowsPrivateProfile } from "../src/windows-profile-files.ts";
import { openWindowsGoalJournal, windowsJournalIO } from "../src/windows-journal.ts";
import { GOAL_JOURNAL_ERROR, openGoalJournal, type GoalJournal } from "../src/goal-journal.ts";
import { ZERO_GOAL_UNITS, type GoalRecord } from "../src/goal-machine.ts";

const windows = { skip: process.platform !== "win32", timeout: 60000 };
const ref = { goalId: "native-offline-fixture", revision: 1, scopeDigest: "a".repeat(64) };
const records: GoalRecord[] = [
  { type: "created", at: 100, definition: { ref, limits: { ...ZERO_GOAL_UNITS, workerRuns: 1, workerCalls: 2 }, maxTotalCalls: 2, deadlineMs: 10000 } },
  { type: "approved", ref, at: 110, activationId: "synthetic-not-human-approval" },
  { type: "reserved", ref, at: 120, activationId: "synthetic-not-human-approval", intent: { id: "synthetic-intent", planDigest: "b".repeat(64), reserve: { ...ZERO_GOAL_UNITS, workerRuns: 1, workerCalls: 2 } } },
];
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "jev-native-journal-test-")), directory = path.join(root, "private"), journals: GoalJournal[] = [];
  // Only owned synthetic fixtures, never user profiles/auth/storage or a consumed real Goal.
  await createWindowsProfiles([{ file: path.join(directory, "fixture.txt"), content: "synthetic-marker" }]);
  await unlink(path.join(directory, "fixture.txt"));
  t.after(async () => { for (const journal of journals.toReversed()) { try { await journal.close(); } catch { /* Asserted fail-closed fixture. */ } } await rm(root, { recursive: true, force: true }); });
  const open = async (mode: "create" | "open" = "create") => { const journal = await openGoalJournal(directory, mode); journals.push(journal); return journal; };
  return { root, directory, file: path.join(directory, "goal.jsonl"), lock: path.join(directory, "owner.lock"), open };
}
async function append(journal: GoalJournal, record: GoalRecord) {
  return journal.append({ type: "append_goal", expected: (await journal.load()).head, record });
}

test("NTFS native journal durably appends the shared canonical chain and replays without granting a worker", windows, async t => {
  const f = await fixture(t), journal = await f.open();
  assert.deepEqual((await journal.load()).head, { sequence: 0, hash: null });
  for (const record of records) await append(journal, record);
  const snapshot = await journal.load(); assert.equal(snapshot.head.sequence, 3); assert.deepEqual(snapshot.records, records);
  assert.equal(snapshot.ledger?.pending?.id, "synthetic-intent");
  await Promise.all([journal.close(), journal.close()]);
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
  assert.equal(await isWindowsPrivateProfile(f.file), true);
  const reopened = await f.open("open"); assert.deepEqual(await reopened.load(), snapshot);
});

test("NTFS bound directory/file handles prevent root substitution and concurrent journal takeover", windows, async t => {
  const f = await fixture(t), journal = await f.open();
  await append(journal, records[0]!);
  await assert.rejects(rename(f.directory, path.join(f.root, "swapped")));
  await assert.rejects(rename(f.file, path.join(f.directory, "replaced")));
  await assert.rejects(f.open("open"), { message: GOAL_JOURNAL_ERROR });
  assert.equal((await journal.load()).head.sequence, 1);
});

test("NTFS existing foreign owner or journal is preserved; startup failures never steal/delete markers", windows, async t => {
  const owned = await fixture(t); await writeFile(owned.lock, "foreign-owner");
  await assert.rejects(owned.open(), { message: GOAL_JOURNAL_ERROR });
  assert.equal(await readFile(owned.lock, "utf8"), "foreign-owner");
  const existing = await fixture(t); await createWindowsProfiles([{ file: existing.file, content: "not-a-journal" }]);
  await assert.rejects(existing.open(), { message: GOAL_JOURNAL_ERROR });
  assert.equal(await readFile(existing.file, "utf8"), "not-a-journal");
  assert.ok((await lstat(existing.lock)).isFile()); // Uncertain startup retains its reservation marker.
});

test("NTFS journal rejects hard-linked leaves and reparse directories without changing targets", windows, async t => {
  const f = await fixture(t); await createWindowsProfiles([{ file: f.file, content: "original" }]);
  const target = path.join(f.directory, "other-link"); await link(f.file, target);
  await assert.rejects(f.open("open"), { message: GOAL_JOURNAL_ERROR });
  assert.equal(await readFile(target, "utf8"), "original");
  const clean = await fixture(t), junction = path.join(clean.root, "junction"); await symlink(clean.directory, junction, "junction");
  await assert.rejects(openWindowsGoalJournal(junction, "create"), { message: GOAL_JOURNAL_ERROR });
  await assert.rejects(lstat(path.join(clean.directory, "owner.lock")), { code: "ENOENT" });
});

test("NTFS pre-open cancellation writes/spawns nothing and never exposes an abort reason", windows, async t => {
  const spawn = t.mock.method(windowsJournalIO, "spawn");
  const aborted = new AbortController(); aborted.abort(new Error("private-abort-reason"));
  await assert.rejects(openWindowsGoalJournal("C:\\synthetic-never-created", "create", aborted.signal), { message: GOAL_JOURNAL_ERROR });
  assert.equal(spawn.mock.callCount(), 0);
});

test("NTFS aborted/stale appends acknowledge nothing, preserve bytes and retain ownership on poison", windows, async t => {
  for (const cancelled of [false, true]) {
    const f = await fixture(t), journal = await f.open(); await append(journal, records[0]!);
    const head = (await journal.load()).head, controller = new AbortController();
    if (cancelled) controller.abort("private-message");
    await assert.rejects(journal.append({ type: "append_goal", expected: cancelled ? head : { sequence: 0, hash: null }, record: records[1]! }, controller.signal), { message: GOAL_JOURNAL_ERROR });
    await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
    const persisted = await readFile(f.file, "utf8"); assert.equal(persisted.split("\n").filter(Boolean).length, 1);
    assert.ok((await lstat(f.lock)).isFile());
  }
});

test("NTFS null DACL is not a private empty rule list in profile or journal boundaries", windows, async t => {
  const f = await fixture(t), marker = path.join(f.directory, "private.txt");
  await createWindowsProfiles([{ file: marker, content: "nonsecret-synthetic" }]);
  const code = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class JevNullDaclFixture { [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string p,int type,uint flags,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
public static void Set(string p){if(SetNamedSecurityInfo(p,1,4,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero)!=0)throw new InvalidOperationException();}}
'@
[JevNullDaclFixture]::Set([Console]::In.ReadLine())`;
  const powershell = path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  cp.execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { input: marker + "\n", timeout: 20000, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  assert.equal(await isWindowsPrivateProfile(marker), false);
  cp.execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { input: f.directory + "\n", timeout: 20000, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  await assert.rejects(f.open(), { message: GOAL_JOURNAL_ERROR });
  await assert.rejects(createWindowsProfiles([{ file: path.join(f.directory, "must-not-create"), content: "synthetic" }]));
  await assert.rejects(lstat(path.join(f.directory, "must-not-create")), { code: "ENOENT" });
});

/** Faults are injected in the trusted effect adapter, not accepted from model/tool/storage arguments. */
function kernelFault(t: TestContext, transform: (source: string) => string) {
  const native = windowsJournalIO.spawn;
  t.mock.method(windowsJournalIO, "spawn", ((command: string, args: readonly string[], options: cp.SpawnOptions) => {
    const source = Buffer.from(args.at(-1)!, "base64").toString("utf16le"), changed = transform(source);
    assert.notEqual(changed, source);
    return native(command, [...args.slice(0, -1), Buffer.from(changed, "utf16le").toString("base64")], options);
  }) as typeof native);
}

test("NTFS native short writes complete exactly; a partial native write is not acknowledged or repaired", windows, async t => {
  for (const partial of [false, true]) await t.test(partial ? "partial" : "short", async t => {
    kernelFault(t, source => source.replace(
      '[DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o);',
      '[DllImport("kernel32.dll",EntryPoint="WriteFile",SetLastError=true)] static extern bool NativeWrite(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o);' +
      `static int writes;static bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o){if(++writes>1&&${partial ? "true" : "false"}){written=0;return false;}return NativeWrite(h,b,Math.Min(n,3u),out written,o);}`));
    const f = await fixture(t), journal = await f.open();
    if (partial) {
      await assert.rejects(append(journal, records[0]!), { message: GOAL_JOURNAL_ERROR });
      await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
      assert.equal((await readFile(f.file)).length, 3); assert.ok((await lstat(f.lock)).isFile());
    } else {
      await append(journal, records[0]!); assert.deepEqual((await journal.load()).records, [records[0]]);
    }
  });
});

test("NTFS failed sync or failed descriptor closure cannot issue a durability/cleanup receipt", windows, async t => {
  for (const closing of [false, true]) await t.test(closing ? "close" : "sync", async t => {
    kernelFault(t, source => closing ? source.replace('AssertOwner();Close(file);var info=', 'AssertOwner();Check(false);Close(file);var info=') :
      source.replace('Check(FlushFileBuffers(file)&&FlushFileBuffers(root));string current=Read();', 'Check(false);string current=Read();'));
    const f = await fixture(t), journal = await f.open();
    if (!closing) await assert.rejects(append(journal, records[0]!), { message: GOAL_JOURNAL_ERROR });
    await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
    assert.ok((await lstat(f.lock)).isFile());
  });
});

test("NTFS lost append acknowledgement or cancellation after sync preserves actual bytes and unknown ownership", windows, async t => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancelled" : "lost-ack", async t => {
    const controller = new AbortController(), native = windowsJournalIO.spawn;
    t.mock.method(windowsJournalIO, "spawn", ((...args: Parameters<typeof native>) => {
      const child = native(...args);
      child.stdout!.prependListener("data", (data: string | Buffer) => {
        if (/"id":4(?:,|})/.test(data.toString())) {
          if (cancel) controller.abort("private-reason"); else child.emit("error", new Error("private-native-error"));
        }
      });
      return child;
    }) as typeof native);
    const f = await fixture(t), journal = await f.open(), expected = (await journal.load()).head;
    await assert.rejects(journal.append({ type: "append_goal", expected, record: records[0]! }, controller.signal), { message: GOAL_JOURNAL_ERROR });
    await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
    assert.match(await readFile(f.file, "utf8"), /"type":"created"/); assert.ok((await lstat(f.lock)).isFile());
  });
});

test("NTFS lost clean-close acknowledgement remains unknown even if deletion actually applied", windows, async t => {
  const native = windowsJournalIO.spawn;
  t.mock.method(windowsJournalIO, "spawn", ((...args: Parameters<typeof native>) => {
    const child = native(...args);
    child.stdout!.prependListener("data", (data: string | Buffer) => { if (/"id":2(?:,|})/.test(data.toString())) child.emit("error", new Error("lost-close")); });
    return child;
  }) as typeof native);
  const f = await fixture(t), journal = await f.open();
  await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
  await assert.rejects(journal.close(), { message: GOAL_JOURNAL_ERROR });
  await assert.rejects(lstat(f.lock), { code: "ENOENT" }); // Observed deletion is not a confirmed close receipt.
});

test("NTFS process ownership denial precedes compilation/payload and cannot create store files", windows, async t => {
  t.mock.method(windowsJournalIO, "own", async () => { throw new Error("private-ownership-error"); });
  const f = await fixture(t); await assert.rejects(f.open(), { message: GOAL_JOURNAL_ERROR });
  await assert.rejects(lstat(f.lock), { code: "ENOENT" }); await assert.rejects(lstat(f.file), { code: "ENOENT" });
});

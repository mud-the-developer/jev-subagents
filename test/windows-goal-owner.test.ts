import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { prepareGoalFileScope, snapshotGoalText } from "../src/goal-file-effects.ts";
import { openGoalProjectLock, canonicalDirectory } from "../src/goal-run-effects.ts";
import { snapshotWindowsGoalTexts, windowsGoalFileIO } from "../src/windows-goal-files.ts";
import { GOAL_PROJECT_LOCK, GOAL_RUN_ERROR, goalLockText } from "../src/goal-run.ts";
const windows = { skip: process.platform !== "win32", timeout: 30000 };
async function fixture(t: TestContext) {
  const base = await fs.mkdtemp(path.join(tmpdir(), "jev-ntfs-project-owner-")), cwd = path.join(base, "work");
  const protections = { journalDirectory: path.join(base, "journal"), agentDirectory: path.join(base, "agent") };
  for (const value of [cwd, ...Object.values(protections)]) await fs.mkdir(value, { mode: 0o700 });
  await fs.writeFile(path.join(cwd, "a.txt"), "owned source"); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const scope = await prepareGoalFileScope({ cwd, files: [{ path: "a.txt", access: "read_write" }] }, protections);
  const grant = { ref: { goalId: randomUUID(), revision: 1, scopeDigest: "a".repeat(64) }, activationId: randomUUID(), body: { run: { cwd }, files: scope } };
  return { cwd, grant, marker: path.join(cwd, GOAL_PROJECT_LOCK), protections };
}
function fault(t: TestContext, transform: (source: string) => string) {
  const native = windowsGoalFileIO.spawn;
  t.mock.method(windowsGoalFileIO, "spawn", ((...args: Parameters<typeof native>) => {
    const child = native(...args), write = child.stdin!.write.bind(child.stdin!); let first = true;
    child.stdin!.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (first) { first = false; const original = Buffer.from(chunk.toString().trim(), "base64").toString("utf8"), changed = transform(original); assert.notEqual(changed, original); chunk = Buffer.from(changed).toString("base64") + "\n"; }
      return Reflect.apply(write, child.stdin, [chunk, ...rest]);
    }) as NonNullable<typeof child.stdin>["write"];
    return child;
  }) as typeof native);
}

test("NTFS project owner creates one private bound marker, serves trusted read leases and deletes only its held inode", windows, async t => {
  const f = await fixture(t), owner = await openGoalProjectLock(f.grant);
  t.after(() => owner.close(true));
  assert.equal((await snapshotGoalText(f.marker))?.text, goalLockText(f.grant));
  assert.deepEqual((await snapshotGoalText(f.marker))?.version, owner.version);
  await assert.rejects(openGoalProjectLock(f.grant), { message: GOAL_RUN_ERROR });
  assert.equal(await canonicalDirectory(f.cwd), f.cwd);
  assert.equal(await owner.close(false), false); assert.equal(await owner.close(true), false);
  await assert.rejects(fs.lstat(f.marker), { code: "ENOENT" }); assert.equal(await fs.readFile(path.join(f.cwd, "a.txt"), "utf8"), "owned source");
});

test("NTFS retained project owner is never stolen, removed or resumed by a later exact grant", windows, async t => {
  const f = await fixture(t), owner = await openGoalProjectLock(f.grant), before = await fs.readFile(f.marker);
  assert.equal(await owner.close(true), true); assert.equal(await owner.close(false), true);
  await assert.rejects(openGoalProjectLock({ ...f.grant, activationId: randomUUID() }), { message: GOAL_RUN_ERROR });
  assert.deepEqual(await fs.readFile(f.marker), before);
});

test("NTFS project identity mismatch, existing foreign marker and cancelled admission create no replacement", windows, async t => {
  const f = await fixture(t);
  await assert.rejects(openGoalProjectLock({ ...f.grant, body: { ...f.grant.body, files: { rootIdentity: { ...f.grant.body.files.rootIdentity, ino: "ntfs:0000000000000000" } } } }), { message: GOAL_RUN_ERROR });
  await assert.rejects(fs.lstat(f.marker), { code: "ENOENT" });
  const controller = new AbortController(); controller.abort(); await assert.rejects(openGoalProjectLock(f.grant, controller.signal), { message: GOAL_RUN_ERROR });
  await fs.writeFile(f.marker, "foreign synthetic marker"); await assert.rejects(openGoalProjectLock(f.grant), { message: GOAL_RUN_ERROR });
  assert.equal(await fs.readFile(f.marker, "utf8"), "foreign synthetic marker");
});

test("NTFS marker flush/delete/close failures preserve uncertainty, never acknowledge a clean removal", windows, async t => {
  for (const kind of ["start-sync", "delete", "close"] as const) await t.test(kind, async t => {
    const f = await fixture(t);
    fault(t, source => kind === "start-sync" ? source.replace('Check(FlushFileBuffers(root));markerStamp=', 'Check(false);markerStamp=') :
      kind === "delete" ? source.replace('Check(SetFileInformationByHandle(f.handle,4,ref info,(uint)Marshal.SizeOf(typeof(DeleteInfo))));', 'Check(false);') :
      source.replace('Close(f.handle);Check(FlushFileBuffers(root));', 'Check(false);Close(f.handle);Check(FlushFileBuffers(root));'));
    if (kind === "start-sync") await assert.rejects(openGoalProjectLock(f.grant), { message: GOAL_RUN_ERROR });
    else { const owner = await openGoalProjectLock(f.grant); await assert.rejects(owner.close(false), { message: GOAL_RUN_ERROR }); }
    // Delete marking may already have applied before a close fault; never claim the marker
    // must exist after unknown deletion. The synthetic cleanup does not reset any real lease.
    if (kind !== "close") assert.equal(await fs.readFile(f.marker, "utf8"), goalLockText(f.grant));
  });
});

test("NTFS named control batches cover drive-root absence and case-only instruction spellings without discovery", windows, async t => {
  const f = await fixture(t), rule = path.join(f.cwd, "AGENTS.md"); await fs.writeFile(rule, "owned synthetic rule");
  const missingAtDrive = path.join(path.parse(f.cwd).root, `jev-missing-${randomUUID()}.md`);
  const result = await snapshotWindowsGoalTexts([rule, path.join(f.cwd, "AGENTS.MD"), missingAtDrive]);
  assert.equal(result[0]?.text, "owned synthetic rule"); assert.deepEqual(result[0], result[1]); assert.equal(result[2], null);
  assert.equal(await snapshotGoalText(missingAtDrive), null);
});

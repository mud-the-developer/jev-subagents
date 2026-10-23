import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWindowsProfiles } from "../src/windows-profile-files.ts";
import { MEMORY_DB, MEMORY_JOURNAL, MEMORY_LOCK, memoryProjectKey, memorySnapshot } from "../src/project-memory.ts";
import { mutateProjectMemory, probeMemoryCreation, readProjectMemory } from "../src/project-memory-store.ts";
import { openMemoryFileLease } from "../src/project-memory-files.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-sqlite-fixture-")), directory = path.join(root, "private");
  let retain = false;
  t.after(async () => {
    if (retain) return;
    try { await access(path.join(directory, MEMORY_LOCK)); return; } catch { /* No owned/uncertain writer marker remains. */ }
    await rm(root, { recursive: true, force: true });
  });
  if (process.platform === "win32") await createWindowsProfiles([{ file: path.join(directory, "seed.md"), content: "Disposable private fixture.\n" }]);
  else await mkdir(directory, { mode: 0o700 });
  const key = memoryProjectKey("/fixture-project");
  return { directory, key, keep: () => { retain = true; } };
}
async function create(f: Awaited<ReturnType<typeof fixture>>) {
  const initial = await probeMemoryCreation(f.directory);
  return await mutateProjectMemory({ operation: "create", directory: f.directory }, f.key, initial.token);
}
test("real SQLite uses an existing private directory, exact project and no leftover writer marker", async t => {
  const f = await fixture(t), result = await create(f), loaded = await readProjectMemory(f.directory, f.key);
  assert.equal(result.state.revision, 0); assert.deepEqual(loaded.state, result.state);
  assert.match((await readFile(path.join(f.directory, MEMORY_DB))).subarray(0, 16).toString(), /SQLite format 3/);
  assert.equal((await stat(path.join(f.directory, MEMORY_JOURNAL))).size, 0);
  await assert.rejects(access(path.join(f.directory, MEMORY_LOCK)), { code: "ENOENT" });
});
test("SQLite connections release prepared statements before returning without GC", async t => {
  const f = await fixture(t), empty = await create(f);
  const content = 'Bound "quoted" text and 한글 remain data.';
  await mutateProjectMemory({ operation: "remember", directory: f.directory, expectedRevision: 0,
    record: { kind: "decision", title: "Handle lifetime", content, provenance: "Synthetic fixture.", relatedIds: [] } }, f.key, empty.token);
  assert.equal((await readProjectMemory(f.directory, f.key)).state.facts[0]?.content, content);
  const file = path.join(f.directory, MEMORY_DB);
  if (process.platform === "linux") {
    const targets = await Promise.all((await readdir("/proc/self/fd")).map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => null)));
    assert.equal(targets.includes(file), false, "Closed SQLite statements must not keep the database descriptor alive.");
  }
  const moved = `${file}.closed`;
  await rename(file, moved); await rename(moved, file);
});
test("parent-reviewed records and related links commit atomically; explicit forget deletes only the reviewed record", async t => {
  const f = await fixture(t), empty = await create(f);
  const first = await mutateProjectMemory({ operation: "remember", directory: f.directory, expectedRevision: 0,
    record: { kind: "decision", title: "Use the tested parser", content: "Reviewed fact one.", provenance: "Parent review, not independent proof.", relatedIds: [] } }, f.key, empty.token);
  assert.ok(first.id); assert.equal(first.state.revision, 1);
  const second = await mutateProjectMemory({ operation: "remember", directory: f.directory, expectedRevision: 1,
    record: { kind: "constraint", title: "Keep the API", content: "Reviewed fact two.", provenance: "Explicit parent review.", relatedIds: [first.id] } }, f.key, first.token);
  assert.equal(second.state.facts.length, 2); assert.equal(second.state.edges.length, 1);
  const snapshot = memorySnapshot(second.state, [first.id]); assert.equal(snapshot.records[0]?.content, "Reviewed fact one.");
  const forgotten = await mutateProjectMemory({ operation: "forget", directory: f.directory, expectedRevision: 2, id: first.id }, f.key, second.token);
  assert.equal(forgotten.state.revision, 3); assert.equal(forgotten.state.facts.length, 1); assert.equal(forgotten.state.edges.length, 0);
  assert.equal((await readProjectMemory(f.directory, f.key)).state.facts[0]?.id, second.id);
});
test("stale mutation and cross-project access reject without data replacement or permission repair", async t => {
  const f = await fixture(t), empty = await create(f);
  const record = { kind: "decision", title: "Reviewed title", content: "Reviewed value.", provenance: "Parent review.", relatedIds: [] };
  const saved = await mutateProjectMemory({ operation: "remember", directory: f.directory, expectedRevision: 0, record }, f.key, empty.token);
  await assert.rejects(mutateProjectMemory({ operation: "remember", directory: f.directory, expectedRevision: 0, record }, f.key, empty.token));
  await assert.rejects(readProjectMemory(f.directory, memoryProjectKey("/other-project")));
  assert.deepEqual((await readProjectMemory(f.directory, f.key)).state, saved.state);
  await assert.rejects(access(path.join(f.directory, MEMORY_LOCK)), { code: "ENOENT" });
});
test("changed directory identity and reparse roots reject before private file creation", async t => {
  const f = await fixture(t), identity = await lstat(f.directory, { bigint: true });
  await assert.rejects(openMemoryFileLease(f.directory, "create", t.signal, { dev: identity.dev.toString(), ino: (identity.ino + 1n).toString() }));
  for (const file of [MEMORY_DB, MEMORY_JOURNAL, MEMORY_LOCK]) await assert.rejects(access(path.join(f.directory, file)), { code: "ENOENT" });
  const alias = f.directory + "-link"; await symlink(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(openMemoryFileLease(alias, "create", t.signal));
  for (const file of [MEMORY_DB, MEMORY_JOURNAL, MEMORY_LOCK]) await assert.rejects(access(path.join(f.directory, file)), { code: "ENOENT" });
});

test("unknown journal and stale locks are preserved; read never creates a missing database", async t => {
  const f = await fixture(t); await assert.rejects(readProjectMemory(f.directory, f.key));
  await assert.rejects(access(path.join(f.directory, MEMORY_DB)), { code: "ENOENT" });
  await create(f); f.keep();
  await writeFile(path.join(f.directory, MEMORY_JOURNAL), "Unconfirmed fixture journal.");
  await assert.rejects(readProjectMemory(f.directory, f.key));
  assert.equal(await readFile(path.join(f.directory, MEMORY_JOURNAL), "utf8"), "Unconfirmed fixture journal.");
});

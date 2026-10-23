import assert from "node:assert/strict";
import fs, { chmod, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { GOAL_FILES_ERROR, MAX_GOAL_FILE_BYTES, MAX_GOAL_FILE_OPERATIONS, reduceGoalFiles,
  type GoalFileInput, type GoalFileIoEffect, type GoalFileIoEvent, type GoalFileRequest, type GoalFileScope,
  type GoalFilesState, type GoalFilesTransition } from "../src/goal-files.ts";
import { executeGoalFileEffect, prepareGoalFileScope } from "../src/goal-file-effects.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jev-goal-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "work"), journalDirectory = join(root, "journal"), agentDirectory = join(root, "agent");
  for (const path of [cwd, journalDirectory, agentDirectory, join(cwd, "src")]) await mkdir(path, { mode: 0o700 });
  const a = join(cwd, "src/a.txt"), b = join(cwd, "b.txt");
  await writeFile(a, "alpha\n", { mode: 0o600 }); await writeFile(b, "reference\n", { mode: 0o600 });
  const protections = { journalDirectory, agentDirectory };
  const files: GoalFileInput["files"] = [{ path: "src/a.txt", access: "read_write" }, { path: "b.txt", access: "read" }];
  return { root, cwd, a, b, protections, files,
    prepare: (selected = files) => prepareGoalFileScope({ cwd, files: selected }, protections) };
}
function ready(scope: GoalFileScope): GoalFilesState {
  const started = reduceGoalFiles({ status: "idle" }, { type: "start", scope });
  return reduceGoalFiles(started.state, { type: "approval", scopeId: scope.id, approved: true }).state;
}
function issue(state: GoalFilesState, request: GoalFileRequest): GoalFilesTransition {
  assert.ok("scope" in state);
  return reduceGoalFiles(state, { type: "request", scopeId: state.scope.id, request });
}
function io(transition: GoalFilesTransition): GoalFileIoEffect {
  const effect = transition.effects[0];
  assert.equal(effect?.type, "file_io");
  if (effect?.type !== "file_io") throw new Error("Missing fixture I/O");
  return effect;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const part of Object.values(value)) freeze(part); }
  return value;
}
async function prototype(f: { a: string }): Promise<FileHandle> {
  const handle = await open(f.a, "r");
  const result = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  return result;
}

test("file snapshots need matching fresh host approval, contain no contents, and are owned by the pure reducer", async (t) => {
  const f = await fixture(t), scope = await f.prepare(), original = structuredClone(scope);
  assert.equal(JSON.stringify(scope).includes("reference"), false);
  assert.equal(scope.files[0]?.version.bytes, 6);
  assert.notEqual((await f.prepare()).id, scope.id);
  const start = freeze({ type: "start" as const, scope });
  const transition = reduceGoalFiles({ status: "idle" }, start);
  assert.deepEqual(transition, reduceGoalFiles({ status: "idle" }, start));
  assert.equal(transition.state.status, "awaiting_approval");
  assert.deepEqual(issue(transition.state, { id: "early", fileId: "file-1", action: "write", text: "denied" }).effects, []);
  assert.deepEqual(reduceGoalFiles(transition.state, { type: "approval", scopeId: "old", approved: true }).state, transition.state);
  const denied = reduceGoalFiles(transition.state, { type: "approval", scopeId: scope.id, approved: false });
  assert.equal(denied.state.status, "cancelled");
  assert.deepEqual(reduceGoalFiles(denied.state, { type: "approval", scopeId: scope.id, approved: true }), { state: denied.state, effects: [] });
  assert.equal(await readFile(f.a, "utf8"), "alpha\n");
  const approved = ready(scope);
  const request = freeze({ id: "one", fileId: "file-1", action: "write" as const, text: "new" });
  const step = issue(freeze(approved), request);
  assert.deepEqual(step, issue(approved, request));
  io(step).scope.files[0]!.path = "b.txt";
  if (io(step).request.action === "write") Object.assign(io(step).request, { text: "changed" });
  assert.deepEqual("scope" in step.state && step.state.scope, original);
  assert.deepEqual("request" in step.state && step.state.request, request);
});

test("native approved file-ID read/edit/write preserves UTF-8, literal edits, inode/mode, and acknowledged byte accounting", async (t) => {
  const f = await fixture(t);
  await writeFile(f.a, "\ufeff한글 alpha\r\n");
  const scope = await f.prepare(), before = await lstat(f.a);
  let state = ready(scope);
  const requests: GoalFileRequest[] = [
    { id: "read", fileId: "file-1", action: "read" },
    { id: "edit", fileId: "file-1", action: "edit", oldText: "alpha", newText: "$&β" },
    { id: "write", fileId: "file-1", action: "write", text: "" },
  ];
  for (const request of requests) {
    const step = issue(state, request), result = await executeGoalFileEffect(io(step), f.protections);
    assert.equal(result.type, "file_done");
    const acknowledged = reduceGoalFiles(step.state, result);
    assert.equal(acknowledged.state.status, "ready");
    assert.equal(acknowledged.effects[0]?.type, "file_reply");
    state = acknowledged.state;
    if (request.action === "edit") assert.equal(await readFile(f.a, "utf8"), "\ufeff한글 $&β\r\n");
    if (result.type === "file_done") result.version.digest = "f".repeat(64);
  }
  assert.equal(await readFile(f.a, "utf8"), "");
  const after = await lstat(f.a);
  assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
  assert.ok("scope" in state);
  assert.equal(state.operations, 3); assert.equal(state.readBytes, Buffer.byteLength("\ufeff한글 alpha\r\n"));
  assert.equal(state.writtenBytes, Buffer.byteLength("\ufeff한글 $&β\r\n")); assert.equal(state.changed, true);
  assert.equal(state.uncertain, false);
  assert.equal(reduceGoalFiles(state, { type: "close" }).state.status, "closed");
});

test("unknown IDs, write-denied files, path/command injection and malformed requests stop without I/O", async (t) => {
  const f = await fixture(t), scope = await f.prepare();
  for (const request of [
    { id: "one", fileId: "file-2", action: "write", text: "no" },
    { id: "one", fileId: "../outside", action: "read" },
    { id: "one", fileId: "missing", action: "read" },
    { id: "one", fileId: "file-1", action: "bash", command: "touch no" },
    { id: "one", fileId: "file-1", action: "read", path: f.b },
    { id: "one", fileId: "file-1", action: "write", text: "\ud800" },
    { id: "one", fileId: "file-1", action: "write", text: "nul\0text" },
    { id: "one", fileId: "file-1", action: "edit", oldText: "", newText: "x" },
  ]) {
    const stopped = issue(ready(scope), request as GoalFileRequest);
    assert.equal(stopped.state.status, "failed"); assert.deepEqual(stopped.effects, []);
  }
  assert.equal(await readFile(f.a, "utf8"), "alpha\n"); assert.equal(await readFile(f.b, "utf8"), "reference\n");
});

test("64 file operations are allowed but the next one and reused request IDs stop; stale/late events do not grant work", async (t) => {
  const f = await fixture(t), scope = await f.prepare();
  let state = ready(scope);
  for (let count = 0; count < MAX_GOAL_FILE_OPERATIONS; count++) {
    const step = issue(state, { id: `read-${count}`, fileId: "file-1", action: "read" });
    io(step);
    const result: GoalFileIoEvent = { type: "file_done", scopeId: scope.id, requestId: `read-${count}`, version: scope.files[0]!.version, reply: { action: "read", text: "alpha\n" } };
    assert.deepEqual(reduceGoalFiles(step.state, { ...result, scopeId: "foreign" }).state, step.state);
    state = reduceGoalFiles(step.state, result).state;
    assert.deepEqual(reduceGoalFiles(state, result), { state, effects: [] });
  }
  const stopped = issue(state, { id: "extra", fileId: "file-1", action: "read" });
  assert.equal(stopped.state.status, "failed"); assert.deepEqual(stopped.effects, []);
  assert.deepEqual(reduceGoalFiles(stopped.state, { type: "start", scope }), { state: stopped.state, effects: [] });
  const duplicate = issue(state, { id: "read-0", fileId: "file-1", action: "read" });
  assert.equal(duplicate.state.status, "failed");
  const first = issue(ready(scope), { id: "same", fileId: "file-1", action: "read" });
  const done = await executeGoalFileEffect(io(first), f.protections);
  assert.equal(issue(reduceGoalFiles(first.state, done).state, { id: "same", fileId: "file-1", action: "read" }).state.status, "failed");
});

test("input paths are exact existing relative files, never traversal, discovery, private config, instruction files or creation", async (t) => {
  const f = await fixture(t);
  for (const path of ["", "/etc/passwd", "../b.txt", "src/../b.txt", "src//a.txt", "src/./a.txt", "src/a.txt/", "src\\a.txt", "a\n.txt", "new.txt",
    "AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md", ".git/config", ".pi/settings.json", ".ENV.local", ".ssh/key", ".aws/config", "node_modules/a", "auth.json", "models.json", ".npmrc", "goal.jsonl", "owner.lock"]) {
    await assert.rejects(f.prepare([{ path, access: "read_write" }]), { message: GOAL_FILES_ERROR });
  }
  await assert.rejects(f.prepare([]), { message: GOAL_FILES_ERROR });
  await assert.rejects(f.prepare([f.files[0]!, f.files[0]!]), { message: GOAL_FILES_ERROR });
  await mkdir(join(f.root, ".pi")); await writeFile(join(f.root, ".pi", "arbitrary.txt"), "private");
  await assert.rejects(prepareGoalFileScope({ cwd: join(f.root, ".pi"), files: [{ path: "arbitrary.txt", access: "read" }] }, f.protections), { message: GOAL_FILES_ERROR });
});

test("file count and byte bounds apply to inspected UTF-8 and resulting writes, including aggregate growth", async (t) => {
  const f = await fixture(t), selected: GoalFileInput["files"] = [];
  for (let i = 0; i < 17; i++) {
    const path = `small-${i}.txt`; await writeFile(join(f.cwd, path), "x"); selected.push({ path, access: "read_write" });
  }
  assert.equal((await f.prepare(selected.slice(0, 16))).files.length, 16);
  await assert.rejects(f.prepare(selected), { message: GOAL_FILES_ERROR });
  await writeFile(f.a, "x".repeat(MAX_GOAL_FILE_BYTES));
  assert.equal((await f.prepare([f.files[0]!])).files[0]?.version.bytes, MAX_GOAL_FILE_BYTES);
  await writeFile(f.a, "x".repeat(MAX_GOAL_FILE_BYTES + 1));
  await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("binary\0"), Buffer.from("한".repeat(12_000))]) {
    await writeFile(f.a, bytes); await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
  }
  // A regular-file stat size is not sufficient: reject data beyond the declared end.
  await writeFile(f.a, "");
  const proto = await prototype(f), nativeRead = proto.read;
  const hook = t.mock.method(proto, "read", (async function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
    if (bytes.length === 1 && position === 0) { bytes[0] = 120; return { bytesRead: 1, buffer: bytes }; }
    return Reflect.apply(nativeRead, this, [bytes, offset, length, position]);
  }) as FileHandle["read"]);
  try { await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR }); }
  finally { hook.mock.restore(); }
  for (let i = 0; i < 5; i++) await writeFile(join(f.cwd, selected[i]!.path), "x".repeat(i < 3 ? MAX_GOAL_FILE_BYTES : i === 3 ? MAX_GOAL_FILE_BYTES - 1 : 1));
  const scope = await f.prepare(selected.slice(0, 5));
  const step = issue(ready(scope), { id: "overflow", fileId: "file-5", action: "write", text: "xx" });
  const result = await executeGoalFileEffect(io(step), f.protections);
  assert.deepEqual(result, { type: "file_failed", scopeId: scope.id, requestId: "overflow", cancelled: false, mayHaveWritten: false });
  assert.equal(await readFile(join(f.cwd, selected[4]!.path), "utf8"), "x");
  await writeFile(join(f.cwd, selected[4]!.path), "xx");
  await assert.rejects(f.prepare(selected.slice(0, 5)), { message: GOAL_FILES_ERROR });
});

test("symlink leaves/ancestors/roots, hardlinks and group-writable files are rejected without changing targets", async (t) => {
  const f = await fixture(t);
  await symlink(f.a, join(f.cwd, "alias.txt"));
  await symlink(join(f.cwd, "src"), join(f.cwd, "alias-dir"));
  for (const path of ["alias.txt", "alias-dir/a.txt"]) await assert.rejects(f.prepare([{ path, access: "read_write" }]), { message: GOAL_FILES_ERROR });
  const rootLink = join(f.root, "work-link"); await symlink(f.cwd, rootLink);
  for (const suffix of ["", "/", "///"]) await assert.rejects(prepareGoalFileScope({ cwd: rootLink + suffix, files: f.files }, f.protections), { message: GOAL_FILES_ERROR });
  await link(f.a, join(f.cwd, "hard.txt"));
  await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
  await rm(join(f.cwd, "hard.txt")); await chmod(f.a, 0o666);
  await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
  assert.equal(await readFile(f.a, "utf8"), "alpha\n");
});

test("caller-specified journal/config and this extension runtime stay protected, including canonical paths", async (t) => {
  const f = await fixture(t);
  for (const directory of [f.protections.journalDirectory, f.protections.agentDirectory]) await writeFile(join(directory, "notes.txt"), "protected");
  for (const path of ["journal/notes.txt", "agent/notes.txt", "JOURNAL/notes.txt"]) {
    await assert.rejects(prepareGoalFileScope({ cwd: f.root, files: [{ path, access: "read_write" }] }, f.protections), { message: GOAL_FILES_ERROR });
  }
  const runtime = fileURLToPath(new URL("../", import.meta.url));
  await assert.rejects(prepareGoalFileScope({ cwd: runtime, files: [{ path: "README.md", access: "read_write" }] }, f.protections), { message: GOAL_FILES_ERROR });
  assert.equal(await readFile(join(f.protections.journalDirectory, "notes.txt"), "utf8"), "protected");
});

test("same-size content changes, inode replacement, metadata changes and sibling edits invalidate approval before any write", async (t) => {
  for (const change of ["content", "inode", "mode", "sibling", "restored-content", "deleted", "root"]) {
    const f = await fixture(t), scope = await f.prepare();
    if (change === "content") await writeFile(f.a, "other\n");
    if (change === "inode") { await rename(f.a, f.a + ".old"); await writeFile(f.a, "alpha\n"); }
    if (change === "mode") await chmod(f.a, 0o400);
    if (change === "sibling") await writeFile(f.b, "modified!\n");
    if (change === "restored-content") { await writeFile(f.a, "other\n"); await writeFile(f.a, "alpha\n"); }
    if (change === "deleted") await rm(f.a);
    if (change === "root") { await rename(f.cwd, f.cwd + "-old"); await mkdir(f.cwd); await mkdir(join(f.cwd, "src")); await writeFile(f.a, "alpha\n"); await writeFile(f.b, "reference\n"); }
    const step = issue(ready(scope), { id: "edit", fileId: "file-1", action: "write", text: "must not write" });
    const result = await executeGoalFileEffect(io(step), f.protections);
    assert.equal(result.type, "file_failed", change);
    assert.ok(result.type === "file_failed" && !result.mayHaveWritten);
    assert.equal(reduceGoalFiles(step.state, result).state.status, "failed");
    if (change !== "deleted") assert.notEqual(await readFile(f.a, "utf8"), "must not write");
  }
});

test("post-approval symlink/hardlink substitution and parent directory swaps cannot write through to another target", async (t) => {
  for (const change of ["leaf", "hardlink", "directory"]) {
    const f = await fixture(t), scope = await f.prepare(), target = join(f.root, "untouched.txt");
    await writeFile(target, "outside");
    if (change === "leaf") { await rm(f.a); await symlink(target, f.a); }
    if (change === "hardlink") await link(f.a, join(f.root, "linked.txt"));
    if (change === "directory") { await rename(join(f.cwd, "src"), join(f.cwd, "saved")); await symlink(join(f.cwd, "saved"), join(f.cwd, "src")); }
    const step = issue(ready(scope), { id: "write", fileId: "file-1", action: "write", text: "denied" });
    const result = await executeGoalFileEffect(io(step), f.protections);
    assert.ok(result.type === "file_failed" && !result.mayHaveWritten);
    assert.equal(await readFile(target, "utf8"), "outside");
  }
});

test("exact edits reject missing and overlapping ambiguous matches without fuzzy fallback", async (t) => {
  const f = await fixture(t); await writeFile(f.a, "aaa");
  for (const oldText of ["aa", "missing"]) {
    const scope = await f.prepare(), step = issue(ready(scope), { id: "edit", fileId: "file-1", action: "edit", oldText, newText: "x" });
    const result = await executeGoalFileEffect(io(step), f.protections);
    assert.ok(result.type === "file_failed" && !result.mayHaveWritten);
    assert.equal(await readFile(f.a, "utf8"), "aaa");
  }
});

test("cancellation before I/O writes nothing; terminal cancellation ignores late events", async (t) => {
  const f = await fixture(t), scope = await f.prepare(), controller = new AbortController();
  const step = issue(ready(scope), { id: "write", fileId: "file-1", action: "write", text: "no" });
  const draining = reduceGoalFiles(step.state, { type: "cancel" });
  assert.equal(draining.state.status, "draining"); assert.equal(draining.effects[0]?.type, "abort_file_io");
  controller.abort();
  const event = await executeGoalFileEffect(io(step), f.protections, controller.signal);
  assert.ok(event.type === "file_failed" && event.cancelled && !event.mayHaveWritten);
  const done = reduceGoalFiles(draining.state, event);
  assert.equal(done.state.status, "cancelled");
  assert.deepEqual(reduceGoalFiles(done.state, event), { state: done.state, effects: [] });
  assert.equal(await readFile(f.a, "utf8"), "alpha\n");
});

test("partial native writes are not rolled back, never acknowledged, and keep application unknown without raw errors", async (t) => {
  const f = await fixture(t); await writeFile(f.a, "a".repeat(40));
  const scope = await f.prepare(), proto = await prototype(f), nativeWrite = proto.write;
  const hook = t.mock.method(proto, "write", (async function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
    await Reflect.apply(nativeWrite, this, [bytes, offset, Math.min(length, 7), position]);
    throw new Error("fixture-private-transport-detail");
  }) as unknown as FileHandle["write"]);
  const step = issue(ready(scope), { id: "partial", fileId: "file-1", action: "write", text: "b".repeat(40) });
  const event = await executeGoalFileEffect(io(step), f.protections);
  hook.mock.restore();
  assert.ok(event.type === "file_failed" && event.mayHaveWritten && !event.cancelled);
  const stopped = reduceGoalFiles(step.state, event);
  assert.ok(stopped.state.status === "failed" && stopped.state.progress?.uncertain);
  assert.equal(stopped.state.progress.writtenBytes, 0);
  assert.equal(JSON.stringify(stopped).includes("fixture-private"), false);
  assert.equal(await readFile(f.a, "utf8"), "b".repeat(7) + "a".repeat(33));
});

test("sync failure, cancellation after sync and changed readback cannot turn applied writes into success", async (t) => {
  for (const fault of ["sync", "cancel", "readback"]) {
    const f = await fixture(t), scope = await f.prepare(), proto = await prototype(f), nativeSync = proto.sync, controller = new AbortController();
    const hook = t.mock.method(proto, "sync", async function(this: FileHandle) {
      await nativeSync.call(this);
      if (fault === "sync") throw new Error("fixture-private-sync-detail");
      if (fault === "cancel") controller.abort();
      if (fault === "readback") await writeFile(f.a, "external");
    });
    const step = issue(ready(scope), { id: "write", fileId: "file-1", action: "write", text: "applied" });
    const event = await executeGoalFileEffect(io(step), f.protections, controller.signal);
    hook.mock.restore();
    assert.ok(event.type === "file_failed" && event.mayHaveWritten);
    assert.equal(event.cancelled, fault === "cancel");
    const stopped = reduceGoalFiles(step.state, event);
    assert.ok("progress" in stopped.state && stopped.state.progress?.uncertain);
    assert.equal(await readFile(f.a, "utf8"), fault === "readback" ? "external" : "applied");
  }
});

test("short native reads/writes are complete and effect inputs and returned versions cannot rewrite accepted state", async (t) => {
  const f = await fixture(t), scope = await f.prepare(), proto = await prototype(f), nativeRead = proto.read, nativeWrite = proto.write;
  let reads = 0, writes = 0;
  const rh = t.mock.method(proto, "read", (async function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
    reads++; return Reflect.apply(nativeRead, this, [bytes, offset, Math.min(length, 3), position]);
  }) as FileHandle["read"]);
  const wh = t.mock.method(proto, "write", (async function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
    writes++; return Reflect.apply(nativeWrite, this, [bytes, offset, Math.min(length, 5), position]);
  }) as FileHandle["write"]);
  const text = "한글".repeat(10), step = issue(ready(scope), { id: "write", fileId: "file-1", action: "write", text });
  const effect = io(step), pending = executeGoalFileEffect(effect, f.protections);
  effect.scope.files[0]!.path = "b.txt"; Object.assign(effect.request, { text: "changed" });
  const event = await pending;
  rh.mock.restore(); wh.mock.restore();
  assert.equal(event.type, "file_done");
  const accepted = reduceGoalFiles(step.state, event);
  const snapshot = structuredClone(accepted.state);
  if (event.type === "file_done") event.version.bytes = 99;
  assert.deepEqual(accepted.state, snapshot);
  assert.equal(await readFile(f.a, "utf8"), text); assert.equal(await readFile(f.b, "utf8"), "reference\n");
  assert.ok(reads > 1 && writes > 1);
});

test("malformed completion drains instead of abandoning I/O; cancellation wins and late content is not delivered", async (t) => {
  const f = await fixture(t), scope = await f.prepare();
  const step = issue(ready(scope), { id: "read", fileId: "file-1", action: "read" });
  const event = await executeGoalFileEffect(io(step), f.protections);
  assert.equal(event.type, "file_done");
  for (const malformed of [
    { ...event, reply: { action: "read", text: "other\n" } },
    { ...event, reply: { action: "read", text: "alpha\n", extra: true } },
    { type: "file_failed", scopeId: scope.id, requestId: "read", cancelled: "yes", mayHaveWritten: false },
  ]) assert.equal(reduceGoalFiles(step.state, malformed as unknown as GoalFileIoEvent).state.status, "draining");
  const invalid = { ...event, version: undefined } as unknown as GoalFileIoEvent;
  const draining = reduceGoalFiles(step.state, invalid);
  assert.equal(draining.state.status, "draining"); assert.equal(draining.effects[0]?.type, "abort_file_io");
  assert.deepEqual(reduceGoalFiles(draining.state, invalid), { state: draining.state, effects: [] });
  const failed = reduceGoalFiles(draining.state, event);
  assert.equal(failed.state.status, "failed"); assert.deepEqual(failed.effects, []);
  const cancelled = reduceGoalFiles(draining.state, { type: "cancel" });
  const done = reduceGoalFiles(cancelled.state, event);
  assert.equal(done.state.status, "cancelled"); assert.deepEqual(done.effects, []);
  assert.ok(done.state.status === "cancelled" && done.state.progress?.uncertain);
  assert.equal(done.state.progress.readBytes, 6);
});

test("resulting edit bytes and multibyte write inputs cannot exceed the per-file limit", async (t) => {
  const f = await fixture(t), original = "a" + "x".repeat(MAX_GOAL_FILE_BYTES - 1);
  await writeFile(f.a, original);
  const scope = await f.prepare(), step = issue(ready(scope), { id: "edit", fileId: "file-1", action: "edit", oldText: "a", newText: "aa" });
  const event = await executeGoalFileEffect(io(step), f.protections);
  assert.ok(event.type === "file_failed" && !event.mayHaveWritten);
  const oversized = issue(ready(scope), { id: "unicode", fileId: "file-1", action: "write", text: "한".repeat(10_923) });
  assert.equal(oversized.state.status, "failed"); assert.deepEqual(oversized.effects, []);
  assert.equal(await readFile(f.a, "utf8"), original);
});

test("in-flight cancellation drains the native operation and preserves partial application without releasing late content", { timeout: 5_000 }, async (t) => {
  const f = await fixture(t), scope = await f.prepare(), proto = await prototype(f), nativeWrite = proto.write, controller = new AbortController();
  let enter = () => {}, release = () => {};
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const proceed = new Promise<void>((resolve) => { release = resolve; });
  const hook = t.mock.method(proto, "write", (async function(this: FileHandle, bytes: Uint8Array, offset: number, length: number, position: number) {
    const result = await Reflect.apply(nativeWrite, this, [bytes, offset, Math.min(length, 2), position]);
    enter(); await proceed; return result;
  }) as FileHandle["write"]);
  const step = issue(ready(scope), { id: "write", fileId: "file-1", action: "write", text: "changed" });
  const pending = executeGoalFileEffect(io(step), f.protections, controller.signal);
  try {
    await Promise.race([entered, pending.then(() => assert.fail("Missing native write barrier"))]);
    const draining = reduceGoalFiles(step.state, { type: "cancel" });
    assert.equal(draining.state.status, "draining");
    controller.abort(); release();
    const event = await pending, stopped = reduceGoalFiles(draining.state, event);
    assert.ok(stopped.state.status === "cancelled" && stopped.state.progress?.uncertain);
    assert.equal(stopped.state.progress.operations, 1);
    assert.deepEqual(stopped.effects, []);
    assert.equal(await readFile(f.a, "utf8"), "chpha\n");
  } finally { release(); await pending; hook.mock.restore(); }
});

test("native descriptor close failure cannot acknowledge a write or expose its exception", async (t) => {
  const f = await fixture(t), scope = await f.prepare(), nativeOpen = fs.open;
  const hook = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args);
    if (typeof args[1] === "number" && (args[1] & 3) === 2) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => { await close(); throw new Error("fixture-private-close-detail"); });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const step = issue(ready(scope), { id: "write", fileId: "file-1", action: "write", text: "applied" });
    const result = await executeGoalFileEffect(io(step), f.protections);
    assert.ok(result.type === "file_failed" && result.mayHaveWritten);
    assert.equal(JSON.stringify(result).includes("fixture-private"), false);
    assert.equal(await readFile(f.a, "utf8"), "applied");
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

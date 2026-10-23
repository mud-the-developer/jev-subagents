import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import fs, { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile, appendFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import childProcess from "node:child_process";
import { confirmContextPacket } from "../src/context-approval.ts";
import { snapshotGoalText } from "../src/goal-file-effects.ts";
import { decodeMemory, memoryHash, memoryRecord, memoryBundle, MEMORY_BYTES, MEMORY_BUNDLE_BYTES, reduceMemory, validMemoryBundle, validMemoryInput, MEMORY_FILE, MEMORY_ERROR,
  type MemoryEvent, type MemoryInput, type MemoryNote, type MemoryState } from "../src/context-memory.ts";
import { appendContextFile, manageMemory, prepareMemory } from "../src/context-memory-effects.ts";
import { syntheticPacketCustom } from "./helpers/native-packet.ts";

const note: MemoryNote = { topic: "design", text: "Use pure reducers. 한글", origin: "user_note", reference: "user-approved design; not independently verified" };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-memory-"))), cwd = path.join(root, "work"), directory = path.join(root, "memory"), agent = path.join(root, "config");
  await Promise.all([cwd, directory, agent].map(dir => mkdir(dir, { mode: 0o700 })));
  const before = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => { if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before; await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External HTTP forbidden"); });
  const custom = t.mock.fn(syntheticPacketCustom());
  const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "legacy-memory-fixture" }, ui: { custom } } as unknown as ExtensionContext;
  const input: MemoryInput = { action: "append", directory, note };
  return { root, cwd, directory, ctx, input, confirmations: () => custom.mock.callCount(), file: path.join(directory, MEMORY_FILE) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

test("local memory appends, deduplicates, searches and shares only bounded reference snapshots", async t => {
  const f = await fixture(t), first = await manageMemory(f.input, f.ctx);
  assert.equal(first.status, "succeeded"); assert.equal(first.application, "saved"); assert.equal(first.cleanupConfirmed, true); assert.equal(first.locksRetained, false);
  assert.equal(validMemoryBundle(first.bundle), true); assert.equal(first.bundle?.trust, "reference_only");
  const bytes = await readFile(f.file), again = await manageMemory({ ...f.input, note: { reference: note.reference, origin: note.origin, text: note.text, topic: note.topic } }, f.ctx);
  assert.equal(again.application, "already_present"); assert.deepEqual(await readFile(f.file), bytes);
  const search = await manageMemory({ action: "search", directory: f.directory, query: "PURE 한글" }, f.ctx);
  assert.equal(search.status, "succeeded"); assert.deepEqual(search.bundle?.items, first.bundle?.items);
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  const second = await manageMemory({ ...f.input, note: { ...note, text: "A conflicting note stays separate." } }, f.ctx);
  assert.equal(second.status, "succeeded"); assert.deepEqual(second.bundle?.possibleConflictTopics, ["design"]);
  assert.deepEqual((await readFile(f.file)).subarray(0, bytes.length), bytes);
  const read = await manageMemory({ action: "read", directory: f.directory, ids: first.bundle!.items.map(x => x.id) }, f.ctx);
  assert.deepEqual(read.bundle?.items, first.bundle?.items); assert.equal(read.bundle?.head.sequence, 2);
  assert.equal(f.confirmations(), 5);
  await assert.rejects(lstat(path.join(f.cwd, ".jev-goal.lock")), { code: "ENOENT" });
  await assert.rejects(lstat(path.join(f.directory, ".jev-goal.lock")), { code: "ENOENT" });
});

test("memory denies missing UI, decline, changed snapshots and cross-project stores without returning contents", async t => {
  const f = await fixture(t);
  const noUi = await manageMemory(f.input, { ...f.ctx, hasUI: false }); assert.equal(noUi.status, "failed"); assert.equal(f.confirmations(), 0);
  const decline = await manageMemory(f.input, { ...f.ctx, ui: { ...f.ctx.ui, custom: async <T>() => false as T } }); assert.equal(decline.status, "cancelled");
  const invalid = await manageMemory(f.input, { ...f.ctx, ui: { ...f.ctx.ui, custom: async <T>() => "yes" as T } }); assert.equal(invalid.status, "cancelled");
  await assert.rejects(lstat(f.file), { code: "ENOENT" });
  const changed = await manageMemory(f.input, { ...f.ctx, ui: { ...f.ctx.ui, custom: syntheticPacketCustom(async () => { await writeFile(f.file, "PRIVATE_INVALID_RECORD\n", { mode: 0o600 }); }) } });
  assert.equal(changed.status, "needs_review"); assert.equal(changed.bundle, undefined); assert.equal(JSON.stringify(changed).includes("PRIVATE_INVALID_RECORD"), false);
  await rm(f.file); await manageMemory(f.input, f.ctx);
  const other = path.join(f.root, "other"); await mkdir(other, { mode: 0o700 });
  const foreign = await manageMemory({ action: "search", directory: f.directory, query: "pure" }, { ...f.ctx, cwd: other });
  assert.equal(foreign.status, "failed"); assert.equal(foreign.bundle, undefined);
  const unsafe = await manageMemory({ ...f.input, directory: f.cwd }, f.ctx); assert.equal(unsafe.status, "failed");
});

test("memory rejects malformed UTF-8 text, duplicate JSON keys, torn data and forged checksums", async t => {
  const f = await fixture(t), saved = await manageMemory(f.input, f.ctx), text = await readFile(f.file, "utf8"), scope = saved.bundle!.project;
  for (const bad of [text.slice(0, -1), text + "\n", text.replace('"version":1', '"version":1,"version":1'), text.replace("Use pure", "Use fake"), "PRIVATE_BAD_JSON\n"])
    assert.throws(() => decodeMemory(bad, scope), { message: MEMORY_ERROR });
  assert.equal(validMemoryInput({ ...f.input, note: { ...note, text: "\ud800" } }), false);
  assert.equal(validMemoryInput({ ...f.input, note: { ...note, text: "\0" } }), false);
  assert.equal(validMemoryBundle({ ...saved.bundle, items: saved.bundle!.items.map(x => ({ ...x, note: { ...x.note, text: "forged" } })) }), false);
});

test("memory bundles reject impossible sequence, omission and conflict metadata", async t => {
  const f = await fixture(t); await manageMemory(f.input, f.ctx);
  await manageMemory({ ...f.input, note: { ...note, text: "A separate claim with the same topic." } }, f.ctx);
  const result = await manageMemory({ action: "search", directory: f.directory, query: note.topic }, f.ctx);
  const bundle = result.bundle; assert.ok(bundle); assert.equal(bundle.items.length, 2); assert.ok(validMemoryBundle(bundle));
  for (const bad of [
    { ...bundle, items: bundle.items.map(x => ({ ...x, sequence: 1 })) },
    { ...bundle, omitted: bundle.head.sequence },
    { ...bundle, possibleConflictTopics: ["unrelated"] },
    { ...bundle, possibleConflictTopics: ["\ud800"] },
    { ...bundle, head: { sequence: 1, hash: bundle.head.hash }, items: bundle.items.filter(x => x.sequence === 1) },
  ]) assert.equal(validMemoryBundle(bad), false);
});

test("memory reducer owns inputs, drains cancellation and ignores foreign or terminal events", async t => {
  const f = await fixture(t), grant = await prepareMemory(f.input, f.cwd), events: MemoryEvent[] = [
    { type: "start", input: f.input, cwd: f.cwd }, { type: "prepared", grant },
    { type: "approval", id: grant.id, digest: grant.digest, approved: true, now: grant.body.preparedAt + 1 },
    { type: "opened", id: grant.id, now: grant.body.preparedAt + 2 },
  ];
  let state: MemoryState = { status: "idle" };
  for (const event of events) {
    const copy: MemoryState = structuredClone(state);
    const next: ReturnType<typeof reduceMemory> = reduceMemory(freeze(state), freeze(event));
    assert.deepEqual(state, copy); assert.deepEqual(next, reduceMemory(state, event)); state = next.state;
  }
  assert.equal(state.status, "writing"); if (state.status !== "writing") return;
  assert.equal(reduceMemory(state, { type: "written", id: "foreign", text: state.expected }).state, state);
  const cancelled = reduceMemory(state, { type: "cancel" });
  const written = reduceMemory(cancelled.state, { type: "written", id: grant.id, text: state.expected });
  assert.equal(written.state.status, "closing");
  const done = reduceMemory(written.state, { type: "closed", id: grant.id, ok: true, retained: false });
  assert.equal(done.state.status, "done"); if (done.state.status !== "done") return;
  assert.equal(done.state.result.status, "cancelled"); assert.equal(done.state.result.application, "saved"); assert.equal(done.state.result.bundle, undefined);
  for (const event of [...events, { type: "cancel" } as const]) assert.deepEqual(reduceMemory(done.state, event), { state: done.state, effects: [] });
  assert.equal(createHash("sha256").update(grant.body.snapshot?.text ?? "").digest("hex").length, 64);
  assert.equal(grant.digest, memoryHash(grant.body));
});

test("a lost append sync acknowledgement keeps both owners and never retries", async t => {
  const f = await fixture(t); await manageMemory(f.input, f.ctx);
  const nativeOpen = fs.open; let writes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]) === f.file && typeof args[1] === "number" && (args[1] & 3) === 1) {
      const nativeWrite = handle.write.bind(handle);
      Object.defineProperty(handle, "write", { configurable: true, value: async (...values: Parameters<typeof handle.write>) => { writes++; return nativeWrite(...values); } });
      Object.defineProperty(handle, "sync", { configurable: true, value: async () => { throw new Error("PRIVATE_SYNC_FAILURE"); } });
    }
    return handle;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await manageMemory({ ...f.input, note: { ...note, text: "second" } }, f.ctx);
  assert.equal(result.status, "needs_review"); assert.equal(result.application, "unknown"); assert.equal(result.locksRetained, true); assert.equal(writes, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE_SYNC_FAILURE"), false);
  await lstat(path.join(f.cwd, ".jev-goal.lock")); await lstat(path.join(f.directory, ".jev-goal.lock"));
  assert.equal(decodeMemory(await readFile(f.file, "utf8"), (await prepareMemory(f.input, f.cwd)).body.project).length, 2);
});

test("memory stops at record/byte bounds, preserves conflicts and reports omitted data instead of silently rotating", () => {
  const scope = { path: "/project", identity: { dev: 1, ino: 2 } }, records: ReturnType<typeof memoryRecord>[] = [];
  for (let i = 0; i < 64; i++) records.push(memoryRecord(scope, records, { topic: "same", text: String(i), origin: "user_note", reference: "x" }, i));
  assert.throws(() => memoryRecord(scope, records, { ...note, text: "65" }, 65), { message: MEMORY_ERROR });
  const text = records.map(x => JSON.stringify(x) + "\n").join(""); assert.ok(Buffer.byteLength(text) <= MEMORY_BYTES); assert.deepEqual(decodeMemory(text, scope), records);
  const bundle = memoryBundle(scope, records, { action: "search", directory: "/memory", query: "same", limit: 8 });
  assert.equal(bundle.items.length, 8); assert.equal(bundle.omitted, 56); assert.deepEqual(bundle.possibleConflictTopics, ["same"]);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) <= MEMORY_BUNDLE_BYTES);
  assert.equal(memoryBundle(scope, records, { action: "search", directory: "/memory", query: ".*" }).items.length, 0);
  assert.throws(() => decodeMemory(text + " ".repeat(MEMORY_BYTES), scope), { message: MEMORY_ERROR });
});

test("append storage handles short writes and never overwrites a concurrent suffix", async t => {
  const f = await fixture(t), stat = await lstat(f.directory), directoryIdentity = { dev: stat.dev, ino: stat.ino };
  await writeFile(f.file, "prefix\n", { mode: 0o600 }); const expected = await snapshotGoalText(f.file), nativeOpen = fs.open;
  let inject = false, injected = false, writes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]) === f.file && typeof args[1] === "number" && (args[1] & 3) === constants.O_WRONLY) {
      assert.ok(args[1] & constants.O_APPEND); const write = handle.write.bind(handle);
      Object.defineProperty(handle, "write", { configurable: true, value: async (bytes: Buffer, offset: number, length: number, position: number | null) => {
        if (inject && !injected) { injected = true; await appendFile(f.file, "OUTSIDER\n"); }
        writes++; return write(bytes, offset, Math.min(3, length), position);
      } });
    }
    return handle;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await appendContextFile(f.file, directoryIdentity, expected, "first\n"), { ok: true, text: "prefix\nfirst\n" });
  assert.ok(writes > 1);
  const next = await snapshotGoalText(f.file); inject = true;
  assert.deepEqual(await appendContextFile(f.file, directoryIdentity, next, "second\n"), { ok: false, uncertain: true });
  assert.equal(await readFile(f.file, "utf8"), "prefix\nfirst\nOUTSIDER\nsecond\n");
});

test("approval deadline and cancellation also bound a UI that never opens, and a late factory cannot revive consent", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  for (const mode of ["timeout", "abort"]) {
    let factory: Factory | undefined, reply: ((value: boolean) => void) | undefined, answer: boolean | undefined;
    const controller = new AbortController();
    const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "deadline-fixture" }, ui: { custom: (value: Factory) => {
      factory = value; return new Promise<boolean>(resolve => { reply = resolve; });
    } } } as unknown as ExtensionContext;
    const pending = confirmContextPacket(ctx, "Bounded review", "packet", Date.now() + 60_000, controller.signal).then(value => { answer = value; });
    if (mode === "timeout") t.mock.timers.tick(60_000); else controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(answer, false); await pending;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0); assert.ok(factory);
    let closed: unknown;
    const component = await factory({} as Parameters<Factory>[0], {} as Parameters<Factory>[1], {} as Parameters<Factory>[2], value => { closed = value; });
    assert.equal(closed, false); assert.deepEqual(component.render(80), []);
    reply?.(true); await Promise.resolve(); assert.equal(answer, false);
  }
});

test("rejected approval UI leaves no timer, abort listener or live approval callback", async t => {
  initTheme("dark", false); t.mock.timers.enable({ apis: ["setTimeout"] });
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  let component: Awaited<ReturnType<Factory>> | undefined, completions = 0;
  const controller = new AbortController();
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "rejected-ui-fixture" }, ui: { custom: async (factory: Factory) => {
    component = await factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } } as Parameters<Factory>[0],
      {} as Parameters<Factory>[1], { matches: () => false } as unknown as Parameters<Factory>[2], () => { completions++; });
    throw new Error("PRIVATE_UI_FAILURE");
  } } } as unknown as ExtensionContext;
  assert.equal(await confirmContextPacket(ctx, "Rejected review", "packet", Date.now() + 60_000, controller.signal), false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort(); t.mock.timers.tick(60_000); component?.handleInput?.("\r"); component?.dispose?.();
  assert.equal(completions, 0);
});

test("a bare UI receipt without exact native editor submission never approves", async () => {
  for (const value of [true, false, "yes", 1, { approved: true }, undefined]) {
    const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "bare-receipt-fixture" }, ui: { custom: async () => value } } as unknown as ExtensionContext;
    assert.equal(await confirmContextPacket(ctx, "Receipt check", "packet", Date.now() + 1000, new AbortController().signal), false);
  }
});

test("native review component retains the whole packet and denies edits, cancellation, disposal and expiry without launching an editor", async t => {
  initTheme("dark", false);
  const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("No process allowed"); });
  const spawnSync = t.mock.method(childProcess, "spawnSync", () => { throw new Error("No process allowed"); });
  const packet = Array.from({ length: 200 }, (_, i) => `Line ${i}: exact approved data 한글`).join("\n");
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  for (const mode of ["approve", "edit", "escape", "external", "abort", "dispose", "timeout", "close_throw"]) {
    const controller = new AbortController();
    const custom = (factory: Factory) => new Promise<boolean>((resolve, reject) => {
      const tui = { requestRender() {}, terminal: { rows: 40, columns: 80 } } as Parameters<Factory>[0];
      const keys = { matches: (data: string, key: string) => key === "app.editor.external" && data === "\x07" } as Parameters<Factory>[2];
      void Promise.resolve(factory(tui, {} as Parameters<Factory>[1], keys, value => { if (mode === "close_throw") throw new Error("PRIVATE_UI_CLOSE"); resolve(value === true); })).then(component => {
        assert.ok("children" in component && Array.isArray(component.children));
        const editor = component.children.find((child: { getExpandedText?: () => string }) => typeof child.getExpandedText === "function");
        assert.ok(editor); assert.equal(editor.getExpandedText(), packet); assert.ok(component.render(80).length > 0);
        if (mode === "abort") controller.abort();
        else if (mode === "dispose") component.dispose?.();
        else if (mode === "escape") component.handleInput?.("\x1b");
        else if (mode !== "timeout") {
          if (mode === "edit") component.handleInput?.("x");
          if (mode === "external") component.handleInput?.("\x07");
          component.handleInput?.("\r");
        }
      }).catch(reject);
    });
    const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "component-fixture" }, ui: { custom } } as unknown as ExtensionContext;
    assert.equal(await confirmContextPacket(ctx, "Offline fixture: no execution grant", packet, Date.now() + (mode === "timeout" ? 30 : 2000), controller.signal),
      mode === "approve" || mode === "external", mode);
  }
  assert.equal(spawn.mock.callCount(), 0); assert.equal(spawnSync.mock.callCount(), 0);
});

test("native approval compares the untrimmed packet, including whitespace and expanded paste edits", async () => {
  initTheme("dark", false);
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  const observed: Record<string, boolean> = {};
  for (const [name, packet, edit] of [
    ["padded", "\n  원문 packet  \n", ""],
    ["normalized_tab", "원문\tpacket", ""],
    ["normalized_eol", "원문\r\npacket", ""],
    ["space", "원문 packet", " "],
    ["newline", "원문 packet", "\x1b[13;2~"],
    ["paste", "원문 packet", `\x1b[200~${" ".repeat(3000)}\x1b[201~`],
    ["backslash", "원문 packet\\", "\x1b[13;2~"],
  ] as const) {
    const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "untrimmed-fixture" }, ui: { custom: (factory: Factory) => new Promise<boolean>((resolve, reject) => {
      void Promise.resolve(factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } } as Parameters<Factory>[0],
        {} as Parameters<Factory>[1], { matches: () => false } as unknown as Parameters<Factory>[2], value => resolve(value === true)))
        .then(component => { if (edit) component.handleInput?.(edit); component.handleInput?.("\r"); }).catch(reject);
    }) } } as unknown as ExtensionContext;
    observed[name] = await confirmContextPacket(ctx, "Offline UI fixture, no effects", packet, Date.now() + 2000, new AbortController().signal);
  }
  assert.deepEqual(observed, { padded: true, normalized_tab: false, normalized_eol: false, space: false, newline: false, paste: false, backslash: false });
});

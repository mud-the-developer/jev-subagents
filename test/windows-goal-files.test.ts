import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { prepareGoalFileScope, executeGoalFileEffect, checkGoalFileScope, snapshotGoalText } from "../src/goal-file-effects.ts";
import { GOAL_FILES_ERROR, MAX_GOAL_FILE_BYTES, MAX_GOAL_FILES_BYTES, validGoalFileInput, validGoalFileScope,
  type GoalFileScope, type GoalFileRequest } from "../src/goal-files.ts";
import { canonicalWindowsGoalDirectory, snapshotWindowsGoalTexts, windowsGoalFileIO, withWindowsGoalReadBatch } from "../src/windows-goal-files.ts";
import { DirectoryValidationError } from "../src/directory-diagnostics.ts";
import { executeGoalSession } from "../src/goal-worker.ts";

const windows = { skip: process.platform !== "win32", timeout: 60000 };
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "jev-ntfs-file-fixture-")), cwd = path.join(root, "work"), a = path.join(cwd, "src", "a.txt"), b = path.join(cwd, "b.txt");
  const protections = { journalDirectory: path.join(root, "journal"), agentDirectory: path.join(root, "agent") };
  await fs.mkdir(path.dirname(a), { recursive: true, mode: 0o700 });
  await fs.mkdir(protections.journalDirectory, { mode: 0o700 }); await fs.mkdir(protections.agentDirectory, { mode: 0o700 });
  await fs.writeFile(a, "\ufeffalpha 한글\n"); await fs.writeFile(b, "sibling");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = [{ path: "src/a.txt", access: "read_write" as const }, { path: "b.txt", access: "read" as const }];
  const prepare = () => prepareGoalFileScope({ cwd, files }, protections);
  const run = (scope: GoalFileScope, request: GoalFileRequest, signal?: AbortSignal) => executeGoalFileEffect({ type: "file_io", scope, request }, protections, signal);
  return { root, cwd, a, b, protections, files, prepare, run };
}
/** Trusted offline adapter fault, never runtime/user/model parameters. Changes only owned fixtures. */
function sourceFault(t: TestContext, transform: (source: string) => string) {
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

// Portable pure syntax/ID test: acceptance of Windows syntax is NOT an ownership/execution grant.
test("file scope admits drive syntax and lossless NTFS IDs, never UNC/device/dot or private root aliases", () => {
  const files = [{ path: "src/a.txt", access: "read" }];
  assert.equal(validGoalFileInput({ cwd: "C:\\owned\\work", files }), true);
  assert.equal(validGoalFileInput({ cwd: "C:/owned/work", files }), true);
  for (const cwd of ["\\\\host\\share", "\\\\?\\C:\\work", "C:work", "C:\\work\\..\\other", "C:\\work\\bad.", "C:\\owned\\.PI\\work"])
    assert.equal(validGoalFileInput({ cwd, files }), false);
  const version = { identity: { dev: 123, ino: "ntfs:ffffffffffffffff" }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 0 };
  const scope = { id: "fixture", root: "C:\\owned\\work", rootIdentity: version.identity, files: [{ id: "file-1", ...files[0], version }] };
  assert.equal(validGoalFileScope(scope), true);
  for (const ino of ["ntfs:FFFFFFFFFFFFFFFF", "ntfs:10000000000000000", "18446744073709551615", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(validGoalFileScope({ ...scope, rootIdentity: { dev: 123, ino } }), false);
});

test("NTFS public file effects keep complete 64-bit IDs, UTF-8 BOM and checked read/edit/write receipts", windows, async t => {
  const f = await fixture(t), scope = await f.prepare(), original = await fs.lstat(f.a, { bigint: true });
  assert.equal(scope.files[0]!.version.identity.ino, "ntfs:" + original.ino.toString(16).padStart(16, "0"));
  assert.equal(JSON.stringify(scope).includes("alpha"), false); await checkGoalFileScope(scope, f.protections);
  const read = await f.run(scope, { id: "read", fileId: "file-1", action: "read" });
  assert.equal(read.type, "file_done"); if (read.type !== "file_done" || read.reply.action !== "read") return assert.fail("read receipt");
  assert.equal(read.reply.text, "\ufeffalpha 한글\n");
  const edited = await f.run(scope, { id: "edit", fileId: "file-1", action: "edit", oldText: "alpha", newText: "beta" });
  assert.equal(edited.type, "file_done"); if (edited.type !== "file_done") return assert.fail("edit receipt");
  assert.deepEqual(edited.version.identity, scope.files[0]!.version.identity);
  const next = { ...scope, files: scope.files.map(x => x.id === "file-1" ? { ...x, version: edited.version } : x) };
  const written = await f.run(next, { id: "write", fileId: "file-1", action: "write", text: "new 한글" }); assert.equal(written.type, "file_done");
  assert.equal(await fs.readFile(f.a, "utf8"), "new 한글"); assert.equal((await fs.lstat(f.a, { bigint: true })).ino, original.ino);
  assert.equal(await fs.readFile(f.b, "utf8"), "sibling");
});

test("NTFS snapshots inspect only named control files, handle missing leaves and recheck stable versions", windows, async t => {
  const f = await fixture(t), control = path.join(f.root, "AGENTS.md"); await fs.writeFile(control, "synthetic instruction");
  assert.equal((await snapshotGoalText(control))?.text, "synthetic instruction");
  assert.equal(await snapshotGoalText(path.join(f.root, "missing.md")), null);
  assert.equal(await canonicalWindowsGoalDirectory(f.cwd), f.cwd);
  assert.equal(await canonicalWindowsGoalDirectory(`${f.cwd}${path.sep}`), f.cwd);
  const scope = await f.prepare(); await fs.writeFile(f.b, "changed");
  await assert.rejects(checkGoalFileScope(scope, f.protections), { message: GOAL_FILES_ERROR });
  const stopped = await f.run(scope, { id: "changed", fileId: "file-1", action: "write", text: "no" });
  assert.equal(stopped.type, "file_failed"); if (stopped.type === "file_failed") assert.equal(stopped.mayHaveWritten, false);
});

test("NTFS fresh-read batch reuses owned code but reopens handles and observes changed content", windows, async t => {
  const f = await fixture(t), control = path.join(f.cwd, "AGENTS.md"); await fs.writeFile(control, "before");
  const native = windowsGoalFileIO.spawn, spawn = t.mock.method(windowsGoalFileIO, "spawn", (...args: Parameters<typeof native>) => native(...args));
  await withWindowsGoalReadBatch(async () => {
    assert.equal(await canonicalWindowsGoalDirectory(f.cwd), f.cwd);
    const before = (await snapshotWindowsGoalTexts([control]))[0]!;
    await fs.rename(control, control + ".old"); await fs.writeFile(control, "after");
    await withWindowsGoalReadBatch(async () => {
      const after = (await snapshotWindowsGoalTexts([control]))[0]!;
      assert.equal(after.text, "after"); assert.notDeepEqual(after.version.identity, before.version.identity);
    }, t.signal);
    assert.equal(await canonicalWindowsGoalDirectory(f.cwd), f.cwd);
  }, t.signal);
  assert.equal(spawn.mock.callCount(), 1);
});
test("NTFS fresh-read cancellation and late callbacks cannot reuse or restart a closed invocation", windows, async t => {
  const f = await fixture(t), native = windowsGoalFileIO.spawn;
  const spawn = t.mock.method(windowsGoalFileIO, "spawn", (...args: Parameters<typeof native>) => native(...args));
  const controller = new AbortController(); let release!: () => void, late: Promise<string> | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await withWindowsGoalReadBatch(async () => {
    assert.equal(await canonicalWindowsGoalDirectory(f.cwd, false, controller.signal), f.cwd);
    late = pending.then(() => canonicalWindowsGoalDirectory(f.cwd));
    controller.abort(); await assert.rejects(canonicalWindowsGoalDirectory(f.cwd, false, controller.signal));
  }, controller.signal);
  release(); await assert.rejects(late!);
  assert.equal(spawn.mock.callCount(), 1);
});
test("NTFS fresh-read batch preserves unknown Job cleanup and never restarts a refused helper", windows, async t => {
  const f = await fixture(t), native = windowsGoalFileIO.spawn, own = windowsGoalFileIO.own;
  const spawn = t.mock.method(windowsGoalFileIO, "spawn", (...args: Parameters<typeof native>) => native(...args));
  await withWindowsGoalReadBatch(async () => {
    await assert.rejects(canonicalWindowsGoalDirectory(path.join(f.cwd, "missing")));
    await assert.rejects(canonicalWindowsGoalDirectory(f.cwd));
  }, t.signal);
  assert.equal(spawn.mock.callCount(), 1);
  t.mock.method(windowsGoalFileIO, "own", async (...args: Parameters<typeof own>) => {
    const job = await own(...args); return { close: async () => { await job.close(); return false; } };
  });
  await assert.rejects(withWindowsGoalReadBatch(async () => {
    assert.equal(await canonicalWindowsGoalDirectory(f.cwd), f.cwd);
  }, t.signal), error => error instanceof DirectoryValidationError && error.cleanupConfirmed === false);
});

test("NTFS batch cannot suppress unknown ownership cleanup by catching an open refusal", windows, async t => {
  const f = await fixture(t);
  t.mock.method(windowsGoalFileIO, "own", async () => { throw new Error("Synthetic ownership refusal"); });
  await assert.rejects(withWindowsGoalReadBatch(async () => {
    await assert.rejects(canonicalWindowsGoalDirectory(f.cwd));
  }, t.signal), error => error instanceof DirectoryValidationError && error.cleanupConfirmed === false);
});

test("NTFS scoped worker retains measured usage when its read-helper Job cleanup is unknown", windows, async t => {
  const f = await fixture(t), files = await f.prepare(), own = windowsGoalFileIO.own;
  t.mock.method(windowsGoalFileIO, "own", async (...args: Parameters<typeof own>) => {
    const job = await own(...args); return { close: async () => { await job.close(); return false; } };
  });
  t.mock.method(globalThis, "fetch", async () => assert.fail("No network in this fixture."));
  const model = { provider: "offline", id: "offline" }, systemPrompt = "Inspect only the approved file.";
  const run = { cwd: f.cwd, task: "Inspect the approved file.", model, maxModelCalls: 1,
    agent: { name: "worker", model, description: "Inspect code.", systemPrompt, tools: ["read"], file: path.join(f.protections.agentDirectory, "agents", "worker.md") } };
  const session = { model, thinkingLevel: "off", systemPrompt: `${systemPrompt}\nCurrent working directory: ${f.cwd.replace(/\\/g, "/")}\n`,
    agent: { streamFunction: async (_model: unknown, _context: unknown) => {} },
    prompt: async () => { await session.agent.streamFunction(model, {}); },
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Observed the approved fixture." }], usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } }],
    getSessionStats: () => ({ assistantMessages: 1, tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 }), dispose() {}, abort: async () => {} };
  const io = { createModelRuntime: async () => ({ getModel: () => model }), createAgentSession: async () => ({ session }) };
  const result = await executeGoalSession({ run, files, ...f.protections, systemPrompt, prompt: run.task, deadline: Date.now() + 30000 }, async () => {}, "worker", t.signal,
    io as unknown as NonNullable<Parameters<typeof executeGoalSession>[4]>);
  assert.equal(result.reply.report.modelCalls, 1); assert.equal(result.reply.report.accounting.status, "reported");
  if (result.reply.report.accounting.status === "reported") assert.equal(result.reply.report.accounting.complete, false);
  assert.equal(result.files.uncertain, true); assert.equal(result.files.finished, false);
});

test("NTFS directory/file reparse, hardlink, reserved-name/ADS and protected subtree refusal changes no targets", windows, async t => {
  const f = await fixture(t); await fs.link(f.a, path.join(f.cwd, "alias"));
  await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR }); await fs.unlink(path.join(f.cwd, "alias"));
  const junction = path.join(f.root, "junction"); await fs.symlink(f.cwd, junction, "junction");
  await assert.rejects(prepareGoalFileScope({ cwd: junction, files: f.files }, f.protections), { message: GOAL_FILES_ERROR });
  for (const name of ["src/a.txt:stream", "src/a.txt.", "src/CON", "src/a.txt "])
    await assert.rejects(prepareGoalFileScope({ cwd: f.cwd, files: [{ path: name, access: "read" }] }, f.protections), { message: GOAL_FILES_ERROR });
  const protectedInside = path.join(f.cwd, "storage"); await fs.mkdir(protectedInside); await fs.writeFile(path.join(protectedInside, "opaque.txt"), "must remain private");
  await assert.rejects(prepareGoalFileScope({ cwd: f.cwd, files: [{ path: "storage/opaque.txt", access: "read" }] }, { ...f.protections, journalDirectory: protectedInside }), { message: GOAL_FILES_ERROR });
  assert.equal(await fs.readFile(f.a, "utf8"), "\ufeffalpha 한글\n");
});

test("NTFS real byte limits, invalid UTF-8, NUL and aggregate growth stop without acknowledgement", windows, async t => {
  const f = await fixture(t);
  for (const content of [Buffer.from([0xc3, 0x28]), Buffer.from("nul\0"), Buffer.alloc(MAX_GOAL_FILE_BYTES + 1)]) {
    await fs.writeFile(f.a, content); await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
  }
  const files: { path: string; access: "read_write" }[] = [];
  for (let i = 0; i < 5; i++) { const name = `bound-${i}`; await fs.writeFile(path.join(f.cwd, name), "x".repeat(i < 3 ? MAX_GOAL_FILE_BYTES : i === 3 ? MAX_GOAL_FILE_BYTES - 1 : 1)); files.push({ path: name, access: "read_write" }); }
  const scope = await prepareGoalFileScope({ cwd: f.cwd, files }, f.protections); assert.equal(scope.files.reduce((n, x) => n + x.version.bytes, 0), MAX_GOAL_FILES_BYTES);
  const failed = await f.run(scope, { id: "grow", fileId: "file-5", action: "write", text: "xx" }); assert.equal(failed.type, "file_failed");
  if (failed.type === "file_failed") assert.equal(failed.mayHaveWritten, false);
  assert.equal(await fs.readFile(path.join(f.cwd, "bound-4"), "utf8"), "x");
});

test("NTFS native short writes complete; partial writes remain applied/unknown, never repaired", windows, async t => {
  for (const partial of [false, true]) await t.test(partial ? "partial" : "short", async t => {
    const f = await fixture(t), scope = await f.prepare();
    sourceFault(t, source => source.replace('[DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o);',
      '[DllImport("kernel32.dll",EntryPoint="WriteFile",SetLastError=true)] static extern bool NativeWrite(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o);' +
      `static int writes;static bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o){if(++writes>1&&${partial ? "true" : "false"}){written=0;return false;}return NativeWrite(h,b,Math.Min(n,3u),out written,o);}`));
    const result = await f.run(scope, { id: "write", fileId: "file-1", action: "write", text: "changed native bytes" });
    assert.equal(result.type, partial ? "file_failed" : "file_done");
    if (result.type === "file_failed") { assert.equal(result.mayHaveWritten, true); assert.equal((await fs.readFile(f.a)).subarray(0, 3).toString(), "cha"); }
    else assert.equal(await fs.readFile(f.a, "utf8"), "changed native bytes");
  });
});

test("NTFS native EOF contradiction, flush failure and checked-close failure never mint receipts", windows, async t => {
  for (const fault of ["eof", "sync", "close"] as const) await t.test(fault, async t => {
    const f = await fixture(t), scope = await f.prepare();
    sourceFault(t, source => fault === "eof" ? source.replace('Check(ReadFile(f.handle,new byte[1],1,out extra,IntPtr.Zero)&&extra==0);', 'Check(false);') :
      fault === "sync" ? source.replace('Check(SetEndOfFile(f.handle)&&FlushFileBuffers(f.handle));', 'Check(SetEndOfFile(f.handle));Check(false);') :
      source.replace('public void Finish(){AssertRoot();', 'public void Finish(){AssertRoot();Check(false);'));
    if (fault === "eof") await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
    else { const result = await f.run(scope, { id: "fault", fileId: "file-1", action: "write", text: "observed" }); assert.equal(result.type, "file_failed"); if (result.type === "file_failed") assert.equal(result.mayHaveWritten, true); assert.equal(await fs.readFile(f.a, "utf8"), "observed"); }
  });
});

test("NTFS cancellation/lost ACK after synced writes reports unknown, never late content or rollback", windows, async t => {
  for (const cancel of [false, true]) await t.test(cancel ? "cancel" : "lost-ack", async t => {
    const f = await fixture(t), scope = await f.prepare(), controller = new AbortController(), native = windowsGoalFileIO.spawn;
    t.mock.method(windowsGoalFileIO, "spawn", ((...args: Parameters<typeof native>) => {
      const child = native(...args); child.stdout!.prependListener("data", (chunk: string | Buffer) => {
        if (/"id":2(?:,|})/.test(chunk.toString())) { if (cancel) controller.abort("private-reason"); else child.emit("error", new Error("private-native-error")); }
      }); return child;
    }) as typeof native);
    const result = await f.run(scope, { id: "unknown", fileId: "file-1", action: "write", text: "actually applied" }, controller.signal);
    assert.equal(result.type, "file_failed"); if (result.type === "file_failed") { assert.equal(result.mayHaveWritten, true); assert.equal(result.cancelled, cancel); }
    assert.equal(await fs.readFile(f.a, "utf8"), "actually applied");
  });
});

test("NTFS NULL DACL and untrusted write ACL on files/parents invalidate scope without touching contents", windows, async t => {
  const code = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class JevFileNullFixture { [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfo(string p,int type,uint flags,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
public static void Set(string p){if(SetNamedSecurityInfo(p,1,4,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero)!=0)throw new InvalidOperationException();}}
'@
$p=[Console]::In.ReadLine();$kind=[Console]::In.ReadLine()
if($kind -eq 'null'){[JevFileNullFixture]::Set($p)}
elseif($kind -eq 'restore-owned-leaf'){$acl=New-Object Security.AccessControl.FileSecurity;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')));Set-Acl -LiteralPath $p -AclObject $acl}
else{$acl=Get-Acl -LiteralPath $p;$sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'Write','Allow')));Set-Acl -LiteralPath $p -AclObject $acl}`;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT; assert.ok(systemRoot);
  for (const target of ["leaf-null", "parent-null", "leaf-write"] as const) await t.test(target, async t => {
    const f = await fixture(t), scope = await f.prepare(), filename = target === "parent-null" ? path.dirname(f.a) : f.a;
    cp.execFileSync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
      { input: filename + "\n" + (target === "leaf-write" ? "write" : "null") + "\n", timeout: 20000, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR });
    const failed = await f.run(scope, { id: "acl", fileId: "file-1", action: "write", text: "no" }); assert.equal(failed.type, "file_failed"); if (failed.type === "file_failed") assert.equal(failed.mayHaveWritten, false);
    // NULL parent inheritance can deny the ordinary read on its owned child. Restore ONLY
    // this synthetic leaf's read authority after the refusal, for independent byte inspection.
    // This is not a production fallback/retry and the old scope is never executed again.
    if (target === "parent-null") cp.execFileSync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")],
      { input: f.a + "\nrestore-owned-leaf\n", timeout: 20000, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
    assert.equal(await fs.readFile(f.a, "utf8"), "\ufeffalpha 한글\n");
  });
});

test("NTFS pre-I/O cancellation and ownership denial spawn/admit no native filesystem work", windows, async t => {
  const f = await fixture(t), scope = await f.prepare(), controller = new AbortController(); controller.abort();
  const spawn = t.mock.method(windowsGoalFileIO, "spawn");
  const cancelled = await f.run(scope, { id: "cancel", fileId: "file-1", action: "read" }, controller.signal); assert.equal(cancelled.type, "file_failed"); assert.equal(spawn.mock.callCount(), 0); spawn.mock.restore();
  const denied = t.mock.method(windowsGoalFileIO, "own", async () => { throw new Error("private-ownership-error"); });
  await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR }); assert.equal(await fs.readFile(f.a, "utf8"), "\ufeffalpha 한글\n"); denied.mock.restore();
  // Structurally valid but incomplete startup metadata must also stop and close the Job;
  // a leaked exclusive leaf would make this independent native read fail.
  sourceFault(t, source => source.replace('files=rows.ToArray()', 'files=new Row[0]'));
  await assert.rejects(f.prepare(), { message: GOAL_FILES_ERROR }); assert.equal(await fs.readFile(f.a, "utf8"), "\ufeffalpha 한글\n");
});

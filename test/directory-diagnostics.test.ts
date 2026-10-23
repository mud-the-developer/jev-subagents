import assert from "node:assert/strict";
import { test } from "node:test";
import { DIRECTORY_REASONS, DirectoryValidationError, DirectoryPreparationError, directoryError, directoryIssues,
  directoryIssueRows, directoryPreparationIssues, directorySystemReason } from "../src/directory-diagnostics.ts";
import { OrdinaryPreparationError, ordinaryDirectoryIssues } from "../src/ordinary-diagnostics.ts";
import { canonicalDirectory, canonicalOrdinaryDirectories, goalDirectoryIO } from "../src/goal-run-effects.ts";
import { ordinaryDelegate, ordinaryIO } from "../src/ordinary-effects.ts";
import { delegateResultView } from "../src/delegate-presentation.ts";
import { basicRunSummary } from "../src/basic-execution.ts";
import { doctorEnvironmentText } from "../src/doctor.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OrdinaryScopeInput } from "../src/ordinary-authorization.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { canonicalWindowsGoalDirectory, windowsGoalFileIO } from "../src/windows-goal-files.ts";
const issue = { target: "workspace" as const, reason: "unsafe_write_acl" as const, cleanupConfirmed: true };
const input: OrdinaryScopeInput = { task: "Read an approved fixture.", agents: ["scout"], files: [{ path: "sample.txt", access: "read" }],
  tasks: [{ id: "read", agent: "scout", summary: "Read file-1 and report one limitation." }], selection: "parent_only",
  limits: { workerRuns: 1, modelCalls: 2, perWorkerCalls: 2, seconds: 30 } };
test("directory detail projections allow only own fixed categories, never private getters, paths or raw causes", () => {
  let getterReads = 0;
  for (const reason of DIRECTORY_REASONS) {
    const rows = directoryIssueRows([{ ...issue, reason, private: "PRIVATE_KEY_PATH_MESSAGE" }]);
    assert.match(rows.join("\n"), new RegExp(reason)); assert.doesNotMatch(rows.join("\n"), /PRIVATE|SID|C:\\/);
  }
  for (const value of [[{ ...issue, target: "PRIVATE" }], [{ ...issue, reason: "constructor" }], [Object.create(issue)], [issue, issue],
    [{ ...issue, get reason(): never { getterReads++; return assert.fail("Do not execute getters"); } }], Object.assign([], { 0: issue, length: 3 })]) {
    assert.equal(directoryIssues(value), undefined); assert.deepEqual(directoryIssueRows(value), []);
  }
  const error = new DirectoryValidationError("Fixed public message", "access_denied", false);
  assert.deepEqual(directoryError(error), { reason: "access_denied", cleanupConfirmed: false });
  Object.defineProperty(error, "reason", { get() { assert.fail("No getter"); } }); assert.equal(directoryError(error), undefined);
  assert.equal(directoryError({ reason: "unsafe_write_acl", cleanupConfirmed: true }), undefined);
  assert.equal(directorySystemReason({ code: "ENOENT", message: "PRIVATE" }), "missing");
  assert.equal(directorySystemReason({ get code(): never { getterReads++; return assert.fail("No OS getter"); } }), "unknown");
  assert.equal(getterReads, 0);
});
test("both directory rejections drain and retain their own target/reason without exposing private exceptions", async t => {
  t.mock.method(goalDirectoryIO, "canonical", async (folder: string) => { throw new DirectoryValidationError("PRIVATE_NATIVE_ERROR", folder.includes("work") ? "unsafe_write_acl" : "missing", true); });
  await assert.rejects(canonicalOrdinaryDirectories("/work", "/config", t.signal), error => {
    const issues = directoryPreparationIssues(error);
    assert.deepEqual(issues, [issue, { target: "agent_directory", reason: "missing", cleanupConfirmed: true }]);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE|\/work|\/config/); return true;
  });
});
test("invalid paths and pre-cancel emit exact safe refusal before native directory IO", async () => {
  await assert.rejects(canonicalDirectory("relative/private"), error => directoryError(error)?.reason === "invalid_path");
  const abort = new AbortController(); abort.abort();
  await assert.rejects(canonicalDirectory("/private", false, abort.signal), error => directoryError(error)?.reason === "cancelled");
});
test("preparation details reach ordinary, basic, collapsed/expanded and Doctor views; no model/approval/owner starts", async t => {
  const ctx = { cwd: "/synthetic", mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "synthetic" }, ui: { confirm: async () => assert.fail("No approval") } } as unknown as ExtensionContext;
  const io = { ...ordinaryIO, prepare: async () => { throw new OrdinaryPreparationError("directories", [issue]); },
    own: async () => assert.fail("No owner"), run: async () => assert.fail("No worker"), select: async () => assert.fail("No JEV") };
  const result = await ordinaryDelegate(input, ctx, t.signal, undefined, io);
  assert.equal(result.status, "stopped"); assert.equal(result.cleanupConfirmed, true); assert.equal(result.lockRetained, false);
  assert.equal(result.workersStarted, 0); assert.equal(result.modelCalls, 0); assert.equal(result.jevRequests, 0);
  assert.deepEqual(result.diagnostic?.directoryIssues, [issue]);
  for (const expanded of [false, true]) {
    const text = delegateResultView({ details: result }, { expanded, isPartial: false, isError: true }).text;
    assert.match(text, /workspace.*unsafe_write_acl/); assert.match(text, /Review.*ACL/); assert.match(text, /no worker\/model\/JEV admission or task-file changes/);
    assert.doesNotMatch(text, /PRIVATE|\/synthetic|Changes may remain/);
  }
  assert.match(basicRunSummary(result), /unsafe_write_acl/);
  const text = doctorEnvironmentText({ runtime: { feature: "ordinary-scoped/v1", catalog: "scoped_visible", active: "yes", approvalApi: "supported", mode: "tui" },
    workspace: "refused_or_unconfirmed", agentDirectory: "passed", directoryIssues: [issue], blocked: undefined, cancelled: false });
  assert.match(text, /unsafe_write_acl/); assert.match(text, /Pi configuration permissions.*guard passed/);
});
test("uncertain native cleanup blocks new work and never turns the total into known zero", async t => {
  const marked = new OrdinaryPreparationError("directories", [{ ...issue, cleanupConfirmed: false }]);
  assert.equal(ordinaryDirectoryIssues(marked)?.[0]?.cleanupConfirmed, false);
  const ctx = { cwd: "/synthetic", mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "synthetic" }, ui: { confirm: async () => false } } as unknown as ExtensionContext;
  const result = await ordinaryDelegate(input, ctx, t.signal, undefined, { ...ordinaryIO, prepare: async () => { throw marked; } });
  assert.equal(result.cleanupConfirmed, false); assert.equal(result.lockRetained, true); assert.equal(result.costEstimate.delegationTotalUsd, null);
  assert.match(basicRunSummary(result), /new execution blocked/);
});
test("native directory failures preserve only correlated known codes; foreign/private frames stay protocol failures", { skip: process.platform !== "win32" }, async t => {
  for (const [frame, expected] of [[{ id: 1, ok: false, reason: "unsafe_write_acl" }, "unsafe_write_acl"],
    [{ id: 0, ok: false, reason: "helper_setup" }, "helper_setup"],
    [{ id: 2, ok: false, reason: "unsafe_write_acl" }, "helper_protocol"],
    [{ id: 1, ok: false, reason: "PRIVATE_RAW_ERROR" }, "helper_protocol"],
    [{ id: 1, ok: false, reason: "unsafe_write_acl", path: "PRIVATE_PATH" }, "helper_protocol"]] as const) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
    let writes = 0, closes = 0;
    child.stdin.write = ((_value: string) => { if (++writes === 2) child.stdout.write(JSON.stringify(frame) + "\n"); return true; }) as typeof child.stdin.write;
    const spawn = t.mock.method(windowsGoalFileIO, "spawn", () => child as unknown as ReturnType<typeof windowsGoalFileIO.spawn>);
    const own = t.mock.method(windowsGoalFileIO, "own", async () => ({ close: async () => { closes++; return true; } }));
    await assert.rejects(canonicalWindowsGoalDirectory("C:\\synthetic\\work"), error => {
      assert.deepEqual(directoryError(error), { reason: expected, cleanupConfirmed: true }); assert.doesNotMatch(JSON.stringify(error), /PRIVATE|synthetic/); return true;
    });
    assert.equal(closes, 1); spawn.mock.restore(); own.mock.restore();
  }
});
test("native ownership refusal sends no directory payload and preserves cleanup uncertainty", { skip: process.platform !== "win32" }, async t => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
  let writes = 0; child.stdin.write = (() => { writes++; return true; }) as typeof child.stdin.write;
  t.mock.method(windowsGoalFileIO, "spawn", () => child as unknown as ReturnType<typeof windowsGoalFileIO.spawn>);
  t.mock.method(windowsGoalFileIO, "own", async () => { throw new Error("PRIVATE_OWNERSHIP"); });
  await assert.rejects(canonicalWindowsGoalDirectory("C:\\synthetic\\work"), error => {
    assert.deepEqual(directoryError(error), { reason: "ownership_refused", cleanupConfirmed: false }); assert.doesNotMatch(JSON.stringify(error), /PRIVATE|synthetic/); return true;
  });
  assert.equal(writes, 0);
});
test("native directory timeout and cancellation stop the same helper without a fabricated reason or clean receipt", { skip: process.platform !== "win32" }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancel of [false, true]) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
    child.stdin.write = (() => true) as typeof child.stdin.write;
    const spawn = t.mock.method(windowsGoalFileIO, "spawn", () => child as unknown as ReturnType<typeof windowsGoalFileIO.spawn>);
    const own = t.mock.method(windowsGoalFileIO, "own", async () => ({ close: async () => false }));
    const signal = new AbortController(), work = canonicalWindowsGoalDirectory("C:\\synthetic\\work", false, signal.signal);
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    if (cancel) signal.abort(); else t.mock.timers.tick(20000);
    await assert.rejects(work, error => {
      assert.deepEqual(directoryError(error), { reason: cancel ? "cancelled" : "helper_timeout", cleanupConfirmed: false }); return true;
    });
    spawn.mock.restore(); own.mock.restore();
  }
});

test("preparation markers copy safe details and reject forged or getter-backed fields", () => {
  const rows = [issue], marked = new OrdinaryPreparationError("directories", rows); rows.length = 0;
  assert.deepEqual(ordinaryDirectoryIssues(marked), [issue]);
  Object.defineProperty(marked, "directoryIssues", { get() { assert.fail("No diagnostic getter"); } });
  assert.equal(ordinaryDirectoryIssues(marked), undefined);
  const unknown = new DirectoryPreparationError("Fixed", [{ ...issue, reason: "PRIVATE" as typeof issue.reason }]);
  assert.deepEqual(directoryPreparationIssues(unknown), [{ target: "workspace", reason: "unknown", cleanupConfirmed: false }]);
});

// Zero-provider safety/wiring tests. Uses real native file/Job guards and a fake SDK only where stated.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createControlTools } from "./scope-tools.mjs";
import { runOwnedDirect } from "./owned-run.mjs";
import { runDirectControl, accountingProjection } from "./direct-worker.mjs";
assert.equal(process.platform, "win32"); assert.equal(process.versions.bun, "1.4.3");
const runtimeRoot = path.resolve(process.argv[2] ?? ""); assert.ok(process.argv[2]);
const root = path.join(os.tmpdir(), `jev-direct-offline-${randomUUID()}`);
const ps = String.raw`$ErrorActionPreference='Stop';$p=[Console]::In.ReadLine();if([IO.Directory]::Exists($p)-or[IO.File]::Exists($p)){throw 'Fresh root required'};$id=[Security.Principal.WindowsIdentity]::GetCurrent();if((New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Non-admin required'};$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner($id.User);$a.SetAccessRuleProtection($true,$false);foreach($s in @($id.User.Value,'S-1-5-18','S-1-5-32-544')){$sid=[Security.Principal.SecurityIdentifier]::new($s);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit-bor[Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};[IO.Directory]::CreateDirectory($p,$a)|Out-Null`;
const created = spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ps], { input: root + "\n", encoding: "utf8", timeout: 30000 });
assert.equal(created.status, 0, "Could not create a new private offline fixture; no retry or ACL repair.");
const local = name => import(pathToFileURL(path.join(runtimeRoot, "src", name)).href);
const { prepareGoalFileScope } = await local("goal-file-effects.ts"), { contextSnapshot } = await local("goal-run-effects.ts");
const workspace = path.join(root, "workspace"), agentDirectory = path.join(root, "agent");
await fs.mkdir(workspace); await fs.mkdir(agentDirectory); await fs.mkdir(path.join(agentDirectory, "agents"));
const profile = path.join(agentDirectory, "agents/probe.md"); await fs.writeFile(profile, "Synthetic offline profile; no authentication or model execution.");
await fs.writeFile(path.join(agentDirectory, "models.json"), "{}");
const protections = { agentDirectory, journalDirectory: agentDirectory }, checks = [];
let sequence = 0, completed = false;
async function input() {
  const name = `case-${sequence++}`; await fs.mkdir(path.join(workspace, name));
  await fs.writeFile(path.join(workspace, name, "source.mjs"), "before"); await fs.writeFile(path.join(workspace, name, "SPEC.md"), "synthetic spec");
  const files = [{ path: `${name}/source.mjs`, access: "read_write" }, { path: `${name}/SPEC.md`, access: "read" }];
  const scope = await prepareGoalFileScope({ cwd: workspace, files }, protections, AbortSignal.timeout(45000));
  const context = await contextSnapshot(workspace, agentDirectory, profile, files, AbortSignal.timeout(45000));
  return { type: "direct_sdk_control", id: name, runtimeRoot, cwd: workspace, agentDirectory, scope, protections, context,
    model: { provider: "offline", id: "synthetic" }, thinking: "low", systemPrompt: "Synthetic offline system.", prompt: "No provider request.", deadline: Date.now() + 300000 };
}
try {
  const probe = fileURLToPath(new URL("./offline-probe.mjs", import.meta.url));
  const owned = await runOwnedDirect(await input(), { childFile: probe, seconds: 30 });
  assert.equal(owned.status, "offline_probe"); assert.equal(owned.sdkCalls, 0); assert.ok(owned.cleanupConfirmed && owned.childExitConfirmed && owned.files.ioFinished);
  assert.deepEqual(owned.checks, ["read", "write", "edit", "version_updated"]); checks.push("real_job_owned_guarded_io_and_exit");
  for (const [name, action] of [["read_only_write_refused", "readonly"], ["unknown_file_id_refused", "unknown"], ["closed_schema_refused", "extra"]]) {
    const i = await input(), controller = new AbortController(), tools = await createControlTools({ ...i, signal: controller.signal });
    const tool = tools.tools.find(tool => tool.name === "scope_write");
    await assert.rejects(tool.execute("invalid", action === "readonly" ? { fileId: "file-2", text: "not allowed" } : action === "unknown" ? { fileId: "missing", text: "not allowed" } : { fileId: "file-1", text: "not allowed", path: "outside" }, controller.signal));
    assert.equal(await fs.readFile(path.join(workspace, i.scope.files[1].path), "utf8"), "synthetic spec");
    assert.equal(await fs.readFile(path.join(workspace, i.scope.files[0].path), "utf8"), "before"); await tools.close(); checks.push(name);
  }
  const stale = await input(), staleSignal = new AbortController(), staleTools = await createControlTools({ ...stale, signal: staleSignal.signal });
  await fs.writeFile(path.join(workspace, stale.scope.files[0].path), "external change"); await assert.rejects(staleTools.fresh()); staleSignal.abort(); await staleTools.close(); checks.push("file_freshness_change_refused");
  const changed = await input(), changedSignal = new AbortController(), contextTools = await createControlTools({ ...changed, signal: changedSignal.signal });
  await fs.writeFile(profile, "Synthetic changed instruction."); await assert.rejects(contextTools.fresh()); changedSignal.abort(); await contextTools.close(); checks.push("instruction_freshness_change_refused");
  const cancelInput = await input(), cancelled = new AbortController(); cancelled.abort();
  const cancelledTools = await createControlTools({ ...cancelInput, signal: cancelled.signal }); await assert.rejects(cancelledTools.fresh()); await cancelledTools.close(); checks.push("cancel_before_io_refused");
  const waited = await runOwnedDirect({ ...await input(), probeMode: "wait" }, { childFile: probe, seconds: 0.2 });
  assert.ok(waited.deadlineReached && waited.cleanupConfirmed && waited.childExitConfirmed);
  assert.ok(waited.sdkCalls === 0 || waited.sdkCalls === null); // No receipt is unknown, never invented zero-cost accounting.
  if (waited.sdkCalls === null) assert.equal(waited.accounting.status, "unknown");
  checks.push("deadline_job_cleanup_without_model");
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Offline simulation; tests not run." }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
  const fakeSession = { messages: [message], getSessionStats: () => ({ assistantMessages: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0 }) };
  assert.equal(accountingProjection(fakeSession, 1, true).status, "reported_complete");
  assert.equal(accountingProjection({ ...fakeSession, messages: [{ ...message, usage: undefined }] }, 1, true).status, "unknown");
  assert.equal(accountingProjection(fakeSession, 2, true).status, "unknown"); checks.push("offline_accounting_missing_usage_and_count_refused");
  const i = await input(); let subscriptions = 0, disposed = false;
  const sdk = { VERSION: "0.85.1", SettingsManager: { inMemory: value => value }, ModelRuntime: { create: async () => ({ getModel: () => i.model }) },
    DefaultResourceLoader: class { async reload() {} }, SessionManager: { inMemory: () => ({}) },
    createAgentSession: async options => {
      assert.deepEqual(options.tools.sort(), ["scope_edit", "scope_read", "scope_write"]); assert.equal(options.settingsManager.retry.enabled, false); assert.equal(options.settingsManager.compaction.enabled, false);
      const session = { ...fakeSession, messages: [], model: i.model, thinkingLevel: i.thinking,
        systemPrompt: `${i.systemPrompt}\nCurrent working directory: ${i.cwd.replace(/\\/g, "/")}\n`,
        getActiveToolNames: () => options.tools, agent: { streamFunction: async () => ({ offline: true }) },
        subscribe: () => { subscriptions++; return () => { subscriptions--; }; }, abort: async () => {}, dispose: () => { disposed = true; },
        async prompt() { await session.agent.streamFunction(i.model, {}, {}); session.messages.push(message); } };
      return { session };
    } };
  const wired = await runDirectControl(i, new AbortController().signal, sdk);
  assert.equal(wired.status, "completed_unverified"); assert.ok(wired.injectedOfflineSdk && wired.disposed && wired.files.ioFinished && disposed); assert.equal(subscriptions, 0); checks.push("fake_sdk_direct_wiring_and_disposal");
  completed = true;
  console.log(JSON.stringify({ kind: "direct_sdk_control_offline_checks", checks, passed: checks.length, realProviderCalls: 0,
    mockAccountingIsLiveEvidence: false, existingCredentialsRead: false, productionExecutionApiCalls: 0 }, null, 2));
} finally {
  if (completed) await fs.rm(root, { recursive: true, force: true });
  else console.error("Offline check incomplete; owned fixture evidence retained, not swept.");
}

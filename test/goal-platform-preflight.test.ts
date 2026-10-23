import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareContext } from "../src/context-control-effects.ts";
import { validContextInput, type ContextInput, type ContextSource } from "../src/context-control.ts";
import { supportsManagedContext } from "../src/platform-support.ts";

const contextInput: ContextInput = { agent: "summary", journalDirectory: "/synthetic/private-journal", notes: "Explicit non-sensitive test notes.",
  preserve: { goal: "Review a bounded change", scope: "Approved files only", constraints: ["Keep approval gates"], nonGoals: ["No extra work"],
    remaining: ["Human review"], failedChecks: [], uncertainties: ["Not verified"], currentTurn: "Preflight only, not execution" } };

test("managed context support requires the native POSIX non-root UID; Windows or unknown facts never borrow an identity", () => {
  for (const platform of ["linux", "darwin", "win32", "unknown"]) {
    for (const uid of [undefined, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 1, 1000]) {
      assert.equal(supportsManagedContext(platform, uid), (platform === "linux" || platform === "darwin") && (uid === 1 || uid === 1000));
    }
  }
  assert.equal(validContextInput(contextInput), true);
});

test("native managed preflight refusal precedes all SDK/model/worker I/O on unsupported hosts without changing platform or UID", async t => {
  const native = supportsManagedContext(process.platform, process.getuid?.());
  const fork = t.mock.method(childProcess, "fork", () => assert.fail("No native work during a refusal"));
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("No model/JEV/HTTP during a refusal"));
  if (!native) {
    await assert.rejects(prepareContext(contextInput, "/synthetic/root-that-must-not-be-accessed", {} as ContextSource, t.signal));
  } else {
    // Do not simulate a privileged/foreign OS to force a real native success.
    // The native POSIX model path remains covered by its existing integration tests.
    assert.ok(process.getuid && process.getuid() > 0);
  }
  assert.equal(fork.mock.callCount(), 0); assert.equal(fetch.mock.callCount(), 0);
});

test("ordinary entry registers parent memory but no retired Goal/SoL-Pi tools and startup cannot admit native work or restore authority", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-goal-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fork = t.mock.method(childProcess, "fork", () => assert.fail("No child before a tool invocation and exact approval"));
  const fetch = t.mock.method(globalThis, "fetch", async () => assert.fail("No remote/model work during entry/lifecycle checks"));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))] });
  await loader.reload(); const loaded = loader.getExtensions(); t.after(() => loaded.runtime.invalidate());
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
  const entry = loaded.extensions[0]!;
  assert.deepEqual([...entry.tools.keys()], ["jev_route", "jev_decide", "jev_delegate", "jev_memory"]);
  assert.equal(entry.tools.has("jev_goal_sequence"), false); assert.equal(entry.tools.has("jev_memory"), true);
  assert.deepEqual([...entry.handlers.keys()].sort(), ["before_agent_start", "session_before_compact", "session_before_fork", "session_before_switch",
    "session_before_tree", "session_shutdown", "session_start"]);
  const ctx = { cwd: root, hasUI: false, ui: { confirm: () => assert.fail("Lifecycle is not a grant"), select: () => assert.fail("No setup"),
    notify: () => assert.fail("No raw lifecycle notifications") } } as unknown as ExtensionContext;
  for (const hook of entry.handlers.get("before_agent_start") ?? []) await Reflect.apply(hook, undefined, [{ type: "before_agent_start" }, ctx]);
  assert.deepEqual(await readdir(root), []);
  assert.equal(fork.mock.callCount(), 0); assert.equal(fetch.mock.callCount(), 0);
});

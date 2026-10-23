import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { isWindowsPrivateProfile } from "../src/windows-profile-files.ts";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DefaultResourceLoader, SettingsManager, initTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerOnboarding, setupReportText, JEV_HELP } from "../src/onboarding.ts";
import { THINKING_LEVELS, type Thinking } from "../src/planning.ts";
import { SETUP_ROLES, executeSetupEffect, reduceSetup, runCommand, runSetup, setupIO, type SetupEvent, type SetupState } from "../scripts/setup.ts";
import { bunWorkerOptions, workerRuntimeIO, WORKER_BUN_VERSION, WORKER_RUNTIME_ERROR } from "../src/worker-runtime.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const piCli = path.join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const context = Object.freeze({ root: "/checkout", agentDir: "/user/pi", pi: "/bin/pi", bun: "/bin/bun", piVersion: "0.85.1", testedVersion: "0.85.1" });
const templates = ["scout", "worker", "worker_strong"].map((name) => Object.freeze({
  name: name as "scout" | "worker" | "worker_strong", file: `/user/pi/agents/${name}.md`, exists: name === "worker_strong",
  content: `---\nname: ${name}\nmodel: ""\n---\nRead the task.\n`,
}));
const answer = (text: string): SetupEvent => ({ type: "answer", text });
function ready(profiles = templates, levels: readonly Thinking[] = THINKING_LEVELS) {
  let state = reduceSetup({ status: "idle" }, { type: "start", root: context.root }).state;
  state = reduceSetup(state, { type: "checked", context }).state;
  state = reduceSetup(state, answer("yes")).state;
  state = reduceSetup(state, { type: "command_done", step: "install" }).state;
  state = reduceSetup(state, { type: "command_done", step: "test" }).state;
  return reduceSetup(state, { type: "profiles_loaded", templates: profiles, levels }).state;
}

test("setup reducer owns inputs, requires exact approvals, and ignores terminal/phase-mismatched events", () => {
  const input = { ...context, pi: String(context.pi), piVersion: "0.86.0" };
  const prepared = reduceSetup({ status: "checking" }, { type: "checked", context: input });
  input.pi = "/unapproved/pi";
  assert.equal(prepared.effects[0]?.type, "ask");
  assert.match(JSON.stringify(prepared.effects), /Compatibility is not guaranteed/);
  assert.ok(!JSON.stringify(prepared).includes("unapproved"));
  assert.equal(reduceSetup(prepared.state, answer("")).state.status, "cancelled");
  assert.equal(reduceSetup(prepared.state, answer("y")).state.status, "cancelled");
  const started = reduceSetup(prepared.state, answer("YES"));
  assert.deepEqual(started.effects, [{ type: "command", step: "install", context: { ...context, piVersion: "0.86.0" } }]);
  assert.deepEqual(reduceSetup(started.state, { type: "command_done", step: "register" }), { state: started.state, effects: [] });
  const terminals: SetupState[] = [{ status: "cancelled" }, { status: "failed", error: "fixed" }, { status: "succeeded", registered: false }];
  for (const state of terminals) for (const event of [answer("yes"), { type: "cancel" }, { type: "failed", error: "late" }, { type: "start", root: "/other" }] as SetupEvent[]) {
    assert.deepEqual(reduceSetup(Object.freeze(state), event), { state, effects: [] });
  }
});

test("setup reducer validates model/thinking, preserves exact file previews, and is deterministic", () => {
  let state = ready();
  for (const text of ["invalid", "provider/id\nmodel: injected", "provider/$(touch file)", "provider/" + "x".repeat(257)]) {
    const result = reduceSetup(Object.freeze(state), answer(text));
    assert.deepEqual(result, reduceSetup(state, answer(text)));
    assert.equal(result.state.status === "active" && result.state.step, "model");
    assert.ok(!JSON.stringify(result).includes(text));
  }
  state = reduceSetup(state, answer("openai-codex/example")).state;
  const skipped = reduceSetup(state, answer("")).state;
  assert.equal(skipped.status === "active" && skipped.step, "model");
  assert.equal(skipped.status === "active" && skipped.data.index, 1);
  for (const text of ["off", "minimal", "HIGH"]) assert.equal(reduceSetup(state, answer(text)).state.status === "active" && (reduceSetup(state, answer(text)).state as { step: string }).step, "thinking");
  state = reduceSetup(state, answer("low")).state;
  const preview = reduceSetup(state, answer("anthropic/example"));
  assert.equal(preview.state.status === "active" && preview.state.step, "confirm_profiles");
  const before = structuredClone(preview.state);
  assert.equal(reduceSetup(preview.state, answer("no")).state.status, "cancelled");
  const written = reduceSetup(preview.state, answer("yes"));
  assert.deepEqual(preview.state, before);
  assert.equal(written.effects[0]?.type, "write_profiles");
  if (written.effects[0]?.type !== "write_profiles") return assert.fail();
  assert.equal(written.effects[0].profiles.length, 2);
  assert.match(written.effects[0].profiles[0]!.content, /model: "openai-codex\/example"\nthinking: low/);
  assert.ok(!written.effects[0].profiles[1]!.content.includes("thinking:"));
  for (const profile of written.effects[0].profiles) assert.ok(preview.effects[0]?.type === "ask" && preview.effects[0].message.includes(profile.content));
  const registration = reduceSetup(written.state, { type: "profiles_written" });
  assert.deepEqual(reduceSetup(registration.state, answer("")).state, { status: "succeeded", registered: false });
  const registering = reduceSetup(registration.state, answer("yes"));
  assert.deepEqual(registering.effects, [{ type: "command", step: "register", context }]);
  assert.deepEqual(reduceSetup(registering.state, { type: "command_done", step: "register" }).state, { status: "succeeded", registered: true });
});

test("setup recommends exact role defaults on Enter without approving file creation", () => {
  let state = ready(templates.map((template) => ({ ...template, exists: false })));
  const expected = [
    ["openai-codex/gpt-5.6-luna", "low"], ["openai-codex/gpt-5.6-luna", "low"], ["openai-codex/gpt-6-astra", "max"],
  ];
  for (const [model, thinking] of expected) {
    const before = structuredClone(state);
    const invalid = reduceSetup(Object.freeze(state), answer("invalid"));
    assert.ok(invalid.effects[0]?.type === "ask" && invalid.effects[0].message.includes(`Enter=suggested ${model}`));
    const chosen = reduceSetup(state, answer("  "));
    assert.deepEqual(state, before);
    assert.deepEqual(chosen, reduceSetup(state, answer("  ")));
    assert.equal(chosen.state.status === "active" && chosen.state.data.model, model);
    assert.ok(chosen.effects[0]?.type === "ask" && chosen.effects[0].message.includes(`Enter=suggested ${thinking}`));
    const badThinking = reduceSetup(chosen.state, answer("HIGH"));
    assert.ok(badThinking.effects[0]?.type === "ask" && badThinking.effects[0].message.includes(`Enter=suggested ${thinking}`));
    state = reduceSetup(badThinking.state, answer("")).state;
  }
  assert.equal(state.status === "active" && state.step, "confirm_profiles");
  for (const decline of ["", "y", "no"]) assert.equal(reduceSetup(state, answer(decline)).state.status, "cancelled");
  const approved = reduceSetup(state, answer(" YES "));
  if (approved.effects[0]?.type !== "write_profiles") return assert.fail();
  assert.equal(approved.effects[0].profiles.length, 3);
  for (const [index, profile] of approved.effects[0].profiles.entries()) {
    const [model, thinking] = expected[index]!;
    assert.ok(profile.content.includes(`model: "${model}"\nthinking: ${thinking}\n`));
  }
});

test("setup skips explicitly, keeps custom thinking manual, and never inherits an incompatible default", () => {
  let state = ready();
  state = reduceSetup(state, answer("")).state; // Recommended scout model.
  state = reduceSetup(state, answer(" SKIP ")).state; // Skip the whole profile at thinking.
  assert.equal(state.status === "active" && state.data.profiles.length, 0);
  state = reduceSetup(state, answer("skip")).state; // Skip worker at model; existing strong is untouched.
  assert.equal(state.status === "active" && state.step, "confirm_register");
  assert.deepEqual(reduceSetup(state, answer("")).state, { status: "succeeded", registered: false });

  const missing = templates.map((template) => ({ ...template, exists: false }));
  for (const limitedLevels of [false, true]) {
    state = ready(missing, limitedLevels ? ["low"] : THINKING_LEVELS);
    state = reduceSetup(state, answer("skip")).state;
    state = reduceSetup(state, answer("skip")).state;
    const chosen = reduceSetup(state, answer(limitedLevels ? "" : "openai-codex/gpt-5.3-codex-spark"));
    assert.ok(chosen.effects[0]?.type === "ask" && chosen.effects[0].message.includes("no suggestion; Enter=skip profile"));
    const skipped = reduceSetup(chosen.state, answer(""));
    assert.equal(skipped.state.status === "active" && skipped.state.step, "confirm_register");
    const explicit = reduceSetup(chosen.state, answer("low"));
    const approved = reduceSetup(explicit.state, answer("yes"));
    if (approved.effects[0]?.type !== "write_profiles") return assert.fail();
    assert.equal(approved.effects[0].profiles.length, 1);
    assert.match(approved.effects[0].profiles[0]!.content, /thinking: low\n/);
  }
});

async function fixture(t: TestContext) {
  const { execPath: bun, execArgv: bunArgs } = bunWorkerOptions();
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-setup-")));
  const root = path.join(dir, "checkout with spaces;$quotes'");
  const agentDir = path.join(dir, "user config"), bin = path.join(dir, "bin"), log = path.join(dir, "commands.jsonl");
  for (const value of [path.join(root, "agents"), bin, path.join(agentDir, "agents")]) await mkdir(value, { recursive: true });
  await writeFile(path.join(root, "package.json"), await readFile(path.join(repo, "package.json")));
  for (const name of SETUP_ROLES) await writeFile(path.join(root, "agents", `${name}.md`), await readFile(path.join(repo, "agents", `${name}.md`)));
  await writeFile(log, "");
  const oldEnv = process.env;
  process.env = { SystemRoot: oldEnv.SystemRoot, TEMP: oldEnv.TEMP, TMP: oldEnv.TMP,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`, HOME: dir, PI_CODING_AGENT_DIR: agentDir,
    FIXTURE_LOG: log, JEV_BUN_EXECUTABLE: bun, TYPESAFE_API_KEY: "offline-installer-key", NODE_OPTIONS: "must-not-reach-children",
    NODE_PATH: "must-not-reach-children", BUN_OPTIONS: "--preload=must-not-run" };
  t.after(async () => { process.env = oldEnv; await rm(dir, { recursive: true, force: true }); });
  if (process.getuid) t.mock.method(process as NodeJS.Process & { getuid: () => number }, "getuid", () => 1000);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("External requests forbidden."); });
  t.mock.method(console, "log", () => {});
  for (const name of ["pi", "bun"]) {
    let executable = path.join(bin, name === "pi" ? "pi" : "bun-fixture.cjs");
    if (process.platform === "win32") {
      if (name === "pi") await writeFile(path.join(bin, "pi.cmd"), "@echo off\r\n");
      executable = path.join(bin, "node_modules", ...(name === "pi"
        ? ["@earendil-works", "pi-coding-agent", "dist", "cli.js"] : ["bun", "bin", "bun-cli.cjs"]));
      await mkdir(path.dirname(executable), { recursive: true });
    }
    await writeFile(executable, `#!/usr/bin/env ${process.versions.bun ? "bun" : "node"}\n` +
    `const fs = require('node:fs'); const args = process.argv.slice(2);\n` +
    `fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({bin:${JSON.stringify(name)},args,cwd:process.cwd(),dir:process.env.PI_CODING_AGENT_DIR,key:!!process.env.TYPESAFE_API_KEY,nodeOptions:!!process.env.NODE_OPTIONS,bunHooks:!!process.env.BUN_OPTIONS||!!process.env.NODE_PATH,offline:process.env.PI_OFFLINE})+'\\n');\n` +
    `if (${JSON.stringify(name)} === 'pi' && args[0] === '--version') console.log(process.env.FIXTURE_VERSION || '0.85.1');\n` +
    `if (process.env.FIXTURE_FAIL === ${JSON.stringify(name)} + ':' + (args.find(arg => arg === 'install' || arg === 'run') || args[0])) process.exit(17);\n`, { mode: 0o755 });
  }
  // Exercise exact Bun command admission without performing dependency installation or registry I/O.
  t.mock.method(setupIO, "command", async (...[command, args, cwd, directory, signal, timeoutMs]: Parameters<typeof runCommand>) => {
    if (command !== bun) return await runCommand(command, args, cwd, directory, signal, timeoutMs);
    assert.deepEqual(args.slice(0, bunArgs.length), bunArgs);
    if (!["install", "run"].includes(args[bunArgs.length] ?? "")) return await runCommand(command, args, cwd, directory, signal, timeoutMs);
    const script = process.platform === "win32" ? path.join(bin, "node_modules", "bun", "bin", "bun-cli.cjs") : path.join(bin, "bun-fixture.cjs");
    await runCommand(process.execPath, [script, ...args], cwd, directory, signal, timeoutMs);
  });
  const calls = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const prompts: string[] = [];
  const run = (answers: string[], signal = new AbortController().signal) => runSetup(root, async (message) => {
    prompts.push(message); assert.ok(answers.length, "Unexpected installer question"); return answers.shift()!;
  }, signal);
  return { dir, root, agentDir, bin, bun, bunArgs, calls, run, prompts };
}

test("setup rejects missing or wrong Bun before approval and refuses changed runtime or arguments before commands", async t => {
  const f = await fixture(t), command = t.mock.method(setupIO, "command", async () => assert.fail("No command after invalid runtime"));
  process.env.JEV_BUN_EXECUTABLE = path.join(f.bin, "missing-bun");
  const question = async () => assert.fail("No approval after invalid runtime");
  assert.equal((await runSetup(f.root, question, t.signal, { report: () => {} })).status, "failed");
  assert.equal((await f.calls()).length, 0);
  const binary = path.join(f.bin, "synthetic-bun"); await writeFile(binary, "synthetic runtime identity");
  process.env.JEV_BUN_EXECUTABLE = binary;
  const metadata = t.mock.method(workerRuntimeIO, "metadata", (file: string) => ({ version: "0.0.0", executable: file }));
  assert.equal((await runSetup(f.root, question, t.signal, { report: () => {} })).status, "failed");
  metadata.mock.mockImplementation((file: string) => ({ version: WORKER_BUN_VERSION, executable: file }));
  const runtime = bunWorkerOptions();
  const checked = { ...context, root: f.root, agentDir: f.agentDir, bun: runtime.execPath, bunArgs: runtime.execArgv };
  await assert.rejects(executeSetupEffect({ type: "command", step: "install", context: { ...checked, bunArgs: [...checked.bunArgs, "--preload=unapproved"] } }, question, t.signal, () => {}), { message: WORKER_RUNTIME_ERROR });
  await writeFile(binary, "changed runtime identity");
  await assert.rejects(executeSetupEffect({ type: "command", step: "install", context: checked }, question, t.signal, () => {}), { message: WORKER_RUNTIME_ERROR });
  assert.equal(command.mock.callCount(), 0); assert.equal((await f.calls()).length, 0);
});

test("Windows command bootstrap keeps the verified selector parent-local when Bun is absent from fixture PATH", async t => {
  const f = await fixture(t), platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const verify = t.mock.method(setupIO, "verifyWindows", async (...[cwd, command, env, signal, timeout]: Parameters<typeof setupIO.verifyWindows>) => {
    assert.equal(cwd, f.root); assert.deepEqual(command, { command: "fixture-command", args: ["literal argument"] });
    assert.equal(signal, t.signal); assert.equal(timeout, 1000); assert.equal(env.JEV_BUN_EXECUTABLE, f.bun);
    for (const key of ["TYPESAFE_API_KEY", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"]) assert.equal(env[key], undefined);
    const child = bunWorkerOptions(env);
    assert.equal(child.execPath, f.bun); assert.equal(child.env.JEV_BUN_EXECUTABLE, undefined);
    return { type: "verified" as const, result: { status: "passed" as const, exitCode: 0 } };
  });
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    await runCommand("fixture-command", ["literal argument"], f.root, f.agentDir, t.signal, 1000);
    assert.equal(verify.mock.callCount(), 1);
    process.env.JEV_BUN_EXECUTABLE = path.join(f.bin, "missing-runtime");
    await assert.rejects(runCommand("fixture-command", [], f.root, f.agentDir, t.signal, 1000), { message: WORKER_RUNTIME_ERROR });
    assert.equal(verify.mock.callCount(), 1);
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("known JavaScript Pi entries use the verified Bun runtime and sealed arguments without a Node launcher", async t => {
  const f = await fixture(t);
  let entry = path.join(f.bin, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  if (process.platform !== "win32") {
    await rm(path.join(f.bin, "pi")); entry = path.join(f.bin, "pi.js");
    await writeFile(entry, "console.log('0.85.1');\n", { mode: 0o755 });
    await symlink(entry, path.join(f.bin, "pi"));
  }
  const result = await executeSetupEffect({ type: "inspect", root: f.root }, async () => assert.fail("No setup approval during inspection"), t.signal, () => {});
  assert.equal(result.type, "checked"); if (result.type !== "checked") assert.fail();
  assert.equal(result.context.pi, f.bun); assert.deepEqual(result.context.piArgs, [...f.bunArgs, await realpath(entry)]);
  const run = t.mock.method(setupIO, "command", async (...[command, args]: Parameters<typeof runCommand>) => {
    assert.equal(command, f.bun); assert.deepEqual(args, [...f.bunArgs, await realpath(entry), "install", f.root]);
  });
  await executeSetupEffect({ type: "command", step: "register", context: result.context }, async () => assert.fail("No extra approval in the command effect"), t.signal, () => {});
  assert.equal(run.mock.callCount(), 1);
});

test("installer uses existing pi and exact argv, preserves profiles, and creates approved files exclusively", async (t) => {
  const f = await fixture(t);
  const worker = path.join(f.agentDir, "agents", "worker.md");
  await writeFile(worker, "KEEP EXISTING PROFILE\n");
  const template = (await readFile(path.join(repo, "agents", "scout.md"), "utf8")).replace(/\n/g, "\r\n");
  await writeFile(path.join(f.root, "agents", "scout.md"), template);
  const localBin = path.join(f.root, "node_modules", ".bin");
  await mkdir(localBin, { recursive: true });
  await writeFile(path.join(localBin, "pi"), `#!/usr/bin/env ${process.versions.bun ? "bun" : "node"}\nprocess.exit(99);\n`, { mode: 0o755 });
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH}`;
  // Ignore the checkout's CLI even when npm/script environments put it first on PATH.
  assert.deepEqual(await f.run(["yes", "openai-codex/example", "low", "skip", "skip", "yes", "yes"]), { status: "succeeded", registered: true });
  const calls = await f.calls();
  assert.deepEqual(calls.map(({ bin, args }) => [bin, args]), [
    ["pi", ["--version"]], ["bun", [...f.bunArgs, "install", "--frozen-lockfile", "--ignore-scripts"]],
    ["bun", [...f.bunArgs, "run", process.platform === "win32" ? "check:windows" : "check"]], ["pi", ["install", await realpath(f.root)]],
  ]);
  assert.ok(calls.every((call) => !call.key && !call.nodeOptions && !call.bunHooks && call.offline === "1" && call.dir === f.agentDir));
  assert.ok(f.prompts.some(message => message.includes("fetch pinned packages from the registry")));
  assert.ok(f.prompts.every(message => !message.includes("offline-installer-key")));
  assert.equal(await readFile(worker, "utf8"), "KEEP EXISTING PROFILE\n");
  const scout = path.join(f.agentDir, "agents", "scout.md");
  const body = await readFile(scout, "utf8");
  assert.match(body, /model: "openai-codex\/example"\nthinking: low/);
  assert.ok(f.prompts.some((message) => message.includes(body)));
  if (process.platform === "win32") assert.equal(await isWindowsPrivateProfile(scout), true);
  else assert.equal((await stat(scout)).mode & 0o777, 0o600);
  assert.ok(!body.includes("offline-installer-key"));
  assert.equal(await readFile(path.join(f.root, "agents", "scout.md"), "utf8"), template);
});

test("installer previews and writes recommended profiles only after yes, without auto-registration", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(["yes", "", "", "", "", "", "", "", "", ""]), { status: "cancelled" });
  for (const name of SETUP_ROLES) await assert.rejects(readFile(path.join(f.agentDir, "agents", `${name}.md`)), { code: "ENOENT" });
  const answers = ["yes", "", "", "", "", "", "", "", "", "yes", ""];
  assert.deepEqual(await f.run(answers), { status: "succeeded", registered: false });
  assert.equal(answers.length, 0);
  for (const name of SETUP_ROLES) {
    const file = path.join(f.agentDir, "agents", `${name}.md`);
    const body = await readFile(file, "utf8");
    const model = name === "sol" ? "gpt-5.6-sol" : name === "worker_strong" ? "gpt-6-astra" : "gpt-5.6-luna", thinking = name === "worker_strong" ? "max" : "low";
    const template = await readFile(path.join(f.root, "agents", `${name}.md`), "utf8");
    assert.equal(body, template.replace(/^model: ""$/m, `model: "openai-codex/${model}"\nthinking: ${thinking}`));
    assert.ok(f.prompts.some((message) => message.includes(body)));
    assert.ok(f.prompts.some((message) => message.includes(`Enter=suggested openai-codex/${model}`)));
    if (process.platform === "win32") assert.equal(await isWindowsPrivateProfile(file), true);
    else assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.deepEqual((await f.calls()).map(({ bin, args }) => [bin, args[bin === "bun" ? f.bunArgs.length : 0]]), [
    ["pi", "--version"], ["bun", "install"], ["bun", "run"], ["pi", "--version"], ["bun", "install"], ["bun", "run"],
  ]);
});

test("installer declines, cancellations, and failed commands stop before later changes", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.run([""]), { status: "cancelled" });
  assert.equal((await f.calls()).length, 1);
  for (const failed of ["bun:install", "bun:run"]) {
    process.env.FIXTURE_FAIL = failed;
    const before = (await f.calls()).length;
    assert.equal((await f.run(["yes"])).status, "failed");
    assert.equal((await f.calls()).length - before, failed === "bun:install" ? 2 : 3);
  }
  delete process.env.FIXTURE_FAIL;
  assert.deepEqual(await f.run(["yes", "anthropic/example", "skip", "skip", "skip", "no"]), { status: "cancelled" });
  await assert.rejects(readFile(path.join(f.agentDir, "agents", "scout.md")), { code: "ENOENT" });
  const abort = new AbortController();
  const result = await runSetup(f.root, async () => { abort.abort(); return "yes"; }, abort.signal);
  assert.deepEqual(result, { status: "cancelled" });
  assert.ok(!(await f.calls()).some((call) => call.bin === "pi" && call.args[0] === "install"));
  process.env.FIXTURE_FAIL = "pi:install";
  assert.equal((await f.run(["yes", "skip", "skip", "skip", "skip", "yes"])).status, "failed");
  assert.equal((await f.calls()).filter((call) => call.bin === "pi" && call.args[0] === "install").length, 1);
});

test("profile creation races fail closed; no overwrite, secret exception, or registration follows", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.agentDir, "agents", "worker.md");
  const answers = ["yes", "anthropic/scout-model", "anthropic/worker-model", "skip", "skip", "yes"];
  const result = await runSetup(f.root, async (message) => {
    if (message.includes("Create this exact content")) await writeFile(target, "CREATED DURING APPROVAL\n");
    return answers.shift()!;
  }, new AbortController().signal);
  assert.equal(result.status, "failed");
  assert.equal(await readFile(target, "utf8"), "CREATED DURING APPROVAL\n");
  assert.match(await readFile(path.join(f.agentDir, "agents", "scout.md"), "utf8"), /anthropic\/scout-model/); // Earlier writes remain; no rollback.
  assert.ok(!(await f.calls()).some((call) => call.bin === "pi" && call.args[0] === "install"));
  const failed = await runSetup(f.root, async () => { throw new Error("private-input-must-not-leak"); }, new AbortController().signal);
  assert.equal(failed.status, "failed");
  assert.ok(!JSON.stringify(failed).includes("private-input-must-not-leak"));
  await rm(target);
  await symlink(path.join(f.dir, "missing-target"), target, process.platform === "win32" ? "junction" : undefined);
  assert.deepEqual(await f.run(["yes", "skip", "skip", "no"]), { status: "succeeded", registered: false });
  assert.equal((await lstat(target)).isSymbolicLink(), true); // Preserve dangling symlinks too.
});

test("installer preflight and CLI reject unsafe locations and non-interactive approvals", async (t) => {
  const f = await fixture(t);
  for (const agentDir of ["relative", f.root, path.join(f.root, "config")]) {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    assert.equal((await f.run([])).status, "failed");
  }
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  process.env.PATH = path.dirname(process.execPath);
  assert.equal((await f.run([])).status, "failed");
  const result = await promisify(execFile)(process.execPath, [path.join(repo, "scripts", "setup.ts")], {
    env: { PATH: process.env.PATH, HOME: f.dir }, timeout: 10_000,
  }).then(() => null, (error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /real terminal/);
  assert.equal((await f.calls()).length, 0);
});

test("installer commands are bounded and cancellation reaps a SIGTERM-ignoring process", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], f.root, f.agentDir, new AbortController().signal, 100));
  const marker = path.join(f.dir, "pid");
  const abort = new AbortController();
  const pending = assert.rejects(runCommand(process.execPath, ["-e", `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`],
    f.root, f.agentDir, abort.signal, 10_000));
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) { try { pid = Number(await readFile(marker, "utf8")); } catch { await delay(20); } }
  assert.ok(pid);
  abort.abort();
  await pending;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("profile-only reducer prepares one exact four-profile review, never installs or registers", () => {
  const start = Object.freeze({ type: "start", root: context.root, mode: "profiles" } as const);
  const begun = reduceSetup(Object.freeze({ status: "idle" } as const), start);
  assert.deepEqual(begun, reduceSetup({ status: "idle" }, start));
  const loaded = reduceSetup(begun.state, { type: "checked", context });
  assert.deepEqual(loaded.effects, [{ type: "load_profiles", context }]);
  const source = SETUP_ROLES.map(name => ({ name, file: `/user/pi/agents/${name}.md`, exists: false,
    content: `---\nname: ${name}\nmodel: ""\n---\nFixture instructions.\n` }));
  const event = { type: "profiles_loaded", templates: source, levels: THINKING_LEVELS } as const;
  const preview = reduceSetup(Object.freeze(loaded.state), event);
  assert.deepEqual(preview, reduceSetup(loaded.state, event));
  source[0]!.content = "PRIVATE_CHANGED_TEMPLATE";
  assert.ok(!JSON.stringify(preview).includes("PRIVATE_CHANGED_TEMPLATE"));
  assert.equal(preview.effects[0]?.type, "ask");
  const allowed = reduceSetup(preview.state, answer("yes"));
  assert.equal(allowed.effects[0]?.type, "write_profiles");
  if (allowed.effects[0]?.type !== "write_profiles") return assert.fail();
  assert.equal(allowed.effects[0].profiles.length, 4);
  assert.match(allowed.effects[0].profiles[3]!.content, /model: "openai-codex\/gpt-5.6-sol"\nthinking: low/);
  for (const profile of allowed.effects[0].profiles) assert.ok(preview.effects[0]?.type === "ask" && preview.effects[0].message.includes(profile.content));
  assert.deepEqual(reduceSetup(allowed.state, { type: "profiles_written" }), { state: { status: "succeeded", registered: false }, effects: [] });
  assert.equal(reduceSetup(preview.state, answer("no")).state.status, "cancelled");
  const unsupported = reduceSetup(loaded.state, { ...event, levels: ["low"] });
  assert.equal(unsupported.state.status, "failed");
  assert.deepEqual(unsupported.effects, []);
});

test("profile-only setup uses one approval, preserves existing files and skips dependency installation/registration", async (t) => {
  const f = await fixture(t);
  const worker = path.join(f.agentDir, "agents", "worker.md");
  await writeFile(worker, "KEEP\n");
  const question = t.mock.fn(async (message: string) => {
    assert.match(message, /gpt-5.6-sol/); assert.match(message, /gpt-6-astra/);
    assert.ok(!message.includes("KEEP")); return "yes";
  });
  const options = { mode: "profiles" as const, report: () => {} };
  const done = await runSetup(f.root, question, t.signal, options);
  assert.deepEqual(done, { status: "succeeded", registered: false });
  assert.equal(question.mock.callCount(), 1);
  for (const name of SETUP_ROLES) assert.equal((await stat(path.join(f.agentDir, "agents", `${name}.md`))).isFile(), true);
  assert.equal(await readFile(worker, "utf8"), "KEEP\n");
  assert.deepEqual(await runSetup(f.root, async () => assert.fail("Existing profiles must not prompt"), t.signal, options), done);
  assert.deepEqual((await f.calls()).map(({ bin, args }) => [bin, args]), [["pi", ["--version"]], ["pi", ["--version"]]]);
});

test("profile-only decline, symlink directories and approval races cannot overwrite or escape", async (t) => {
  const f = await fixture(t);
  const options = { mode: "profiles" as const, report: () => {} };
  assert.equal((await runSetup(f.root, async () => "no", t.signal, options)).status, "cancelled");
  await assert.rejects(readFile(path.join(f.agentDir, "agents", "sol.md")), { code: "ENOENT" });
  const outside = path.join(f.dir, "outside"); await mkdir(outside);
  const result = await runSetup(f.root, async () => {
    await rm(path.join(f.agentDir, "agents"), { recursive: true });
    await symlink(outside, path.join(f.agentDir, "agents"), process.platform === "win32" ? "junction" : undefined);
    return "yes";
  }, t.signal, options);
  assert.equal(result.status, "failed");
  await assert.rejects(readFile(path.join(outside, "scout.md")), { code: "ENOENT" });
  assert.ok((await lstat(path.join(f.agentDir, "agents"))).isSymbolicLink());
});

test("local diagnostics report missing/invalid/valid profiles without leaking prompts, keys or invoking models", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.agentDir, "agents", "worker.md"), "PRIVATE_INVALID_PROFILE\n");
  const template = await readFile(path.join(repo, "agents", "scout.md"), "utf8");
  await writeFile(path.join(f.agentDir, "agents", "scout.md"), template.replace('model: ""', 'model: "openai-codex/gpt-5.6-luna"\nthinking: low') + "PRIVATE_PROMPT\n");
  const auth = path.join(f.agentDir, "auth.json"); await writeFile(auth, "PRIVATE_AUTH_NOT_JSON\n");
  const state = await runSetup(f.root, async () => assert.fail("Read-only status never approves"), t.signal, { mode: "status", report: () => {} });
  assert.ok(state.status === "succeeded" && state.report);
  const report = state.report;
  assert.deepEqual(report.profiles.map(p => [p.name, p.status]), [["scout", "valid"], ["worker", "invalid"], ["worker_strong", "missing"], ["sol", "missing"]]);
  assert.equal(report.workerVersion, null); // This isolated checkout deliberately has no runtime dependencies.
  assert.equal(report.jevKeyPresent, true);
  const text = setupReportText(report);
  assert.match(text, /install.sh/); assert.match(text, /validity unconfirmed/);
  assert.ok(!/PRIVATE_|offline-installer-key/.test(text + JSON.stringify(state)));
  assert.equal(await readFile(auth, "utf8"), "PRIVATE_AUTH_NOT_JSON\n");
  assert.deepEqual((await f.calls()).map(({ bin, args }) => [bin, args]), [["pi", ["--version"]]]);
  assert.deepEqual(reduceSetup(state, { type: "diagnosed", report: { ...report, jevKeyPresent: false } }), { state, effects: [] });
});

test("diagnostic requires ordinary and scoped workers, never imports retired Goal/SoL-Pi/context entries", async (t) => {
  const f = await fixture(t);
  const sdk = path.join(f.root, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(sdk, { recursive: true });
  await mkdir(path.join(f.root, "src"));
  await writeFile(path.join(sdk, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(path.join(sdk, "index.js"), 'export const VERSION = "0.85.1";\n');
  await writeFile(path.join(f.root, "src", "subagent-worker.ts"), "export {};\n");
  const status = async () => {
    const state = await runSetup(f.root, async () => assert.fail("Diagnostics never approve execution"), t.signal,
      { mode: "status", report: () => {} });
    assert.ok(state.status === "succeeded" && state.report);
    assert.ok(!JSON.stringify(state).includes("PRIVATE_WORKER_IMPORT"));
    return state.report;
  };
  assert.equal((await status()).workerVersion, null, "The scoped entry is still required");
  const scoped = path.join(f.root, "src", "ordinary-worker.ts");
  await writeFile(scoped, "export {};\n");
  assert.equal((await status()).workerVersion, "0.85.1");
  for (const name of ["goal-worker", "goal-sequence-worker", "sol-pi-worker", "context-worker"]) {
    await writeFile(path.join(f.root, "src", `${name}.ts`), 'throw new Error("PRIVATE_WORKER_IMPORT");\n');
  }
  assert.equal((await status()).workerVersion, "0.85.1", "Independent/retired harnesses cannot break ordinary readiness");
  await writeFile(scoped, 'throw new Error("PRIVATE_WORKER_IMPORT");\n');
  assert.equal((await status()).workerVersion, null);
  assert.ok((await f.calls()).every(({ bin, args }) => bin === "pi" && args[0] === "--version"));
});

test("diagnostic independently imports the real worker SDK with isolated settings and reports no key", async (t) => {
  await fixture(t);
  delete process.env.TYPESAFE_API_KEY;
  const state = await runSetup(repo, async () => assert.fail(), t.signal, { mode: "status", report: () => {} });
  assert.ok(state.status === "succeeded" && state.report);
  assert.equal(state.report.workerVersion, "0.85.1");
  assert.equal(state.report.jevKeyPresent, false);
  assert.ok(state.report.profiles.every(profile => profile.status === "missing"));
  assert.match(setupReportText(state.report), /Standalone Bun worker loading: passed/);
});

test("native onboarding is explicit, rejects missing UI/busy sessions and cancels on lifecycle changes", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const lifecycle = new Map<string, () => Promise<void>>();
  registerOnboarding({ registerCommand(name: string, definition: typeof command) {
    assert.equal(name, "jev-subagents"); command = definition;
  }, on(event: string, handler: () => Promise<void>) { lifecycle.set(event, handler); } } as unknown as ExtensionAPI);
  assert.deepEqual(await command.getArgumentCompletions?.("s"), [{ value: "setup", label: "setup" }, { value: "status", label: "status" }]);
  for (const value of ["setup", "status", "profiles", "help", "goal"])  assert.deepEqual(await command.getArgumentCompletions?.(value), []);
  assert.deepEqual(await command.getArgumentCompletions?.("doctor"), ["doctor run", "doctor last", "doctor help"].map(value => ({ value, label: value })));
  assert.deepEqual(await command.getArgumentCompletions?.("g"), []);
  const notices: string[] = [];
  let open = () => {};
  const opened = new Promise<void>(resolve => { open = resolve; });
  const ctx = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "synthetic-onboarding-session" },
    ui: { notify(message: string) { notices.push(message); }, custom: async () => { open(); return new Promise(() => {}); } } } as unknown as ExtensionCommandContext;
  await command.handler("help", ctx);
  assert.equal(notices.pop(), JEV_HELP);
  assert.match(JEV_HELP, /^jev-subagents · Getting started/);
  assert.doesNotMatch(JEV_HELP, /\/jev(?![-a-z_])/i);
  await command.handler("goal", ctx);
  assert.equal(notices.pop(), JEV_HELP); assert.doesNotMatch(JEV_HELP, /\/jev-subagents goal|jev_goal|jev_memory|solPi\s*=/);
  assert.deepEqual([...lifecycle.keys()].sort(), ["before_agent_start", "session_before_compact", "session_before_fork", "session_before_switch", "session_before_tree", "session_shutdown", "session_start"]);
  assert.equal((await f.calls()).length, 0);
  for (const blocked of [{ ...ctx, hasUI: false }, { ...ctx, isIdle: () => false }]) await command.handler("profiles", blocked);
  assert.equal((await f.calls()).length, 0);
  const work = command.handler("profiles", ctx);
  await opened;
  await lifecycle.get("session_shutdown")!();
  await work;
  assert.match(notices.at(-1)!, /Cancelled/);
  await assert.rejects(readFile(path.join(f.agentDir, "agents", "scout.md")), { code: "ENOENT" });
});

test("native onboarding uses only a literal approval and shares the checked creation path", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  registerOnboarding({ registerCommand(_name: string, definition: typeof command) { command = definition; }, on() {} } as unknown as ExtensionAPI);
  const notices: string[] = []; initTheme("dark", false);
  for (const approved of ["yes", false, true]) {
    let exactSubmitted = false;
    const ctx = { mode: "tui", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "synthetic-onboarding-session" }, ui: {
      notify(message: string) { notices.push(message); }, custom: async (factory: (...args: unknown[]) => unknown) => {
        if (approved !== true) return approved;
        return await new Promise<boolean>(resolve => {
          const view = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, {}, { matches: () => false }, resolve) as {
            children: { getExpandedText?(): string }[]; handleInput(data: string): void; dispose(): void };
          const editor = view.children.find(child => child.getExpandedText); assert.ok(editor);
          const exact = editor.getExpandedText!(); assert.match(exact, /openai-codex\/gpt-5.6-sol/);
          for (const role of SETUP_ROLES) assert.ok(exact.includes(path.join(f.agentDir, "agents", role + ".md").replaceAll("\\", "\\\\")));
          view.handleInput("\r"); exactSubmitted = true; view.dispose();
        });
      },
    } } as unknown as ExtensionCommandContext;
    await command.handler("profiles", ctx);
    assert.equal(exactSubmitted, approved === true);
    if (approved !== true) await assert.rejects(readFile(path.join(f.agentDir, "agents", "sol.md")), { code: "ENOENT" });
    else assert.match(await readFile(path.join(f.agentDir, "agents", "sol.md"), "utf8"), /gpt-5.6-sol/);
  }
  assert.match(notices.at(-1)!, /Profile preparation complete/);
  assert.ok((await f.calls()).every(({ bin, args }) => bin === "pi" && args[0] === "--version"));
});

test("desktop print-mode /jev-subagents profiles reaches native exact review and checked NTFS creation", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  registerOnboarding({ registerCommand(_name: string, definition: typeof command) { command = definition; }, on() {} } as unknown as ExtensionAPI);
  const notices: string[] = [];
  for (const approved of [false, true]) {
    let reviewed = false;
    const ctx = { mode: "print", hasUI: true, isIdle: () => true, ui: {
      notify: (message: string) => notices.push(message),
      custom: () => assert.fail("Installed desktop host does not implement TUI custom"),
      confirm: async (_title: string, message: string) => {
        reviewed = true;
        for (const name of SETUP_ROLES) assert.ok(message.includes(path.join(f.agentDir, "agents", name + ".md").replaceAll("\\", "\\\\")));
        assert.match(message, /openai-codex\/gpt-5.6-luna/);
        assert.match(message, /openai-codex\/gpt-6-astra/);
        assert.match(message, /openai-codex\/gpt-5.6-sol/);
        return approved;
      },
    } } as unknown as ExtensionCommandContext;
    await command.handler("profiles", ctx);
    assert.equal(reviewed, true);
    if (!approved) await assert.rejects(readFile(path.join(f.agentDir, "agents", "sol.md")), { code: "ENOENT" });
    else assert.match(await readFile(path.join(f.agentDir, "agents", "sol.md"), "utf8"), /gpt-5.6-sol/);
  }
  assert.match(notices.at(-1)!, /Profile preparation complete/);
});

test("runtime SDK and TypeBox have pinned production dependency entries in the Bun lock", async () => {
  type ProductionLock = { workspaces: { "": { name: string; dependencies: Record<string, string> } }; packages: Record<string, [string, ...unknown[]]> };
  const bun = (globalThis as typeof globalThis & { Bun: { JSONC: { parse(text: string): ProductionLock } } }).Bun;
  const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  const lock = bun.JSONC.parse(await readFile(path.join(repo, "bun.lock"), "utf8"));
  assert.equal(pkg.name, "jev-subagents"); assert.equal(lock.workspaces[""].name, pkg.name);
  for (const name of ["@earendil-works/pi-coding-agent", "typebox"]) {
    assert.match(pkg.dependencies[name], /^\d+\.\d+\.\d+$/);
    assert.equal(lock.workspaces[""].dependencies[name], pkg.dependencies[name]);
    assert.equal(lock.packages[name]?.[0], `${name}@${pkg.dependencies[name]}`);
  }
});

test("native pi install discovers the package tools and onboarding without -e or automatic profile creation", async (t) => {
  const f = await fixture(t);
  const registered = await executeSetupEffect({ type: "command", step: "register", context: {
    ...context, root: repo, agentDir: f.agentDir, pi: f.bun, piArgs: [...f.bunArgs, piCli], bun: f.bun, bunArgs: f.bunArgs,
  } }, async () => assert.fail("Installation was explicitly selected by the fixture"), t.signal);
  assert.deepEqual(registered, { type: "command_done", step: "register" });
  const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.agentDir,
    settingsManager: SettingsManager.create(f.root, f.agentDir),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  t.after(() => loaded.runtime.invalidate());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual([...loaded.extensions[0]!.tools.keys()].sort(), ["jev_decide", "jev_delegate", "jev_memory", "jev_route"]);
  assert.deepEqual([...loaded.extensions[0]!.commands.keys()], ["jev-subagents"]);
  for (const name of SETUP_ROLES) await assert.rejects(readFile(path.join(f.agentDir, "agents", `${name}.md`)), { code: "ENOENT" });
});

test("registration through real pi preserves unrelated isolated settings and auth files", async (t) => {
  const f = await fixture(t);
  const settings = path.join(f.agentDir, "settings.json"), auth = path.join(f.agentDir, "auth.json");
  await writeFile(settings, JSON.stringify({ theme: "dark", defaultProvider: "offline", packages: [] }));
  await writeFile(auth, "{}\n");
  const event = await executeSetupEffect({ type: "command", step: "register", context: {
    ...context, root: f.root, agentDir: f.agentDir, pi: f.bun, piArgs: [...f.bunArgs, piCli], bun: f.bun, bunArgs: f.bunArgs,
  } }, async () => { throw new Error("No implicit confirmation"); }, new AbortController().signal);
  assert.deepEqual(event, { type: "command_done", step: "register" });
  const saved = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(saved.theme, "dark");
  assert.equal(saved.defaultProvider, "offline");
  assert.equal(saved.packages.length, 1);
  assert.equal(path.resolve(f.agentDir, saved.packages[0]), f.root);
  assert.equal(await readFile(auth, "utf8"), "{}\n");
});

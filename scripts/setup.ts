import cp from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Thinking } from "../src/planning.ts";
import { checkWindowsActor, createWindowsProfiles } from "../src/windows-profile-files.ts";
import { verifyWindows } from "../src/windows-worker-effects.ts";
import { readJevConnection, stripJevEnvironment, type JevTarget } from "../src/jev-config.ts";
import { bunWorkerOptions, workerEnvironment, WORKER_BUN_VERSION, WORKER_RUNTIME_ERROR } from "../src/worker-runtime.ts";

export const SETUP_ROLES = ["scout", "worker", "worker_strong", "sol"] as const;
const recommendations = {
  scout: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
  worker: { model: "openai-codex/gpt-5.6-luna", thinking: "low" },
  worker_strong: { model: "openai-codex/gpt-6-astra", thinking: "max" },
  sol: { model: "openai-codex/gpt-5.6-sol", thinking: "low" },
} as const;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
type Role = typeof SETUP_ROLES[number];
export type SetupMode = "install" | "profiles" | "status";
export type SetupReport = {
  readonly root: string; readonly agentDir: string; readonly bun: string; readonly platform?: string;
  readonly piVersion: string; readonly testedVersion: string; readonly workerVersion: string | null;
  readonly jevKeyPresent: boolean;
  readonly jevProvider?: { readonly ready: boolean; readonly target?: JevTarget; readonly error?: string };
  readonly profiles: readonly { readonly name: Role; readonly status: "missing" | "valid" | "invalid"; readonly plan?: string }[];
};
type Context = { readonly root: string; readonly agentDir: string; readonly pi: string; readonly bun: string;
  readonly piVersion: string; readonly testedVersion: string;
  readonly piArgs?: readonly string[]; readonly bunArgs?: readonly string[]; readonly checkScript?: "check" | "check:windows" };
type Template = { readonly name: Role; readonly file: string; readonly content: string; readonly exists: boolean };
type Profile = { readonly file: string; readonly content: string };
export type SetupQuestion = (message: string, profiles?: readonly Profile[]) => Promise<string>;
type Data = { readonly context: Context; readonly mode: SetupMode; readonly templates: readonly Template[]; readonly levels: readonly Thinking[];
  readonly index: number; readonly profiles: readonly Profile[]; readonly model: string };
type Step = "confirm_prepare" | "install" | "test" | "load_profiles" | "model" | "thinking" |
  "confirm_profiles" | "write_profiles" | "confirm_register" | "register" | "diagnose";
export type SetupState = { readonly status: "idle" } | { readonly status: "checking"; readonly mode?: SetupMode }
  | { readonly status: "active"; readonly step: Step; readonly data: Data }
  | { readonly status: "succeeded"; readonly registered: boolean; readonly report?: SetupReport }
  | { readonly status: "cancelled" } | { readonly status: "failed"; readonly error: string };
export type SetupEvent = { readonly type: "start"; readonly root: string; readonly mode?: SetupMode } | { readonly type: "checked"; readonly context: Context }
  | { readonly type: "diagnosed"; readonly report: SetupReport }
  | { readonly type: "answer"; readonly text: string }
  | { readonly type: "command_done"; readonly step: "install" | "test" | "register" }
  | { readonly type: "profiles_loaded"; readonly templates: readonly Template[]; readonly levels: readonly Thinking[] }
  | { readonly type: "profiles_written" } | { readonly type: "cancel" } | { readonly type: "failed"; readonly error: string };
export type SetupEffect = { readonly type: "inspect"; readonly root: string; readonly mode?: SetupMode } | { readonly type: "ask"; readonly message: string; readonly profiles?: readonly Profile[] }
  | { readonly type: "diagnose"; readonly context: Context }
  | { readonly type: "command"; readonly step: "install" | "test" | "register"; readonly context: Context }
  | { readonly type: "load_profiles"; readonly context: Context }
  | { readonly type: "write_profiles"; readonly profiles: readonly Profile[] };
type Transition = { state: SetupState; effects: readonly SetupEffect[] };
const stay = (state: SetupState): Transition => ({ state, effects: [] });
const active = (data: Data, step: Step, effect: SetupEffect): Transition => ({ state: { status: "active", step, data }, effects: [effect] });
const ask = (data: Data, step: Step, message: string) => active(data, step, { type: "ask", message,
  ...(step === "confirm_profiles" ? { profiles: data.profiles.map(profile => ({ ...profile })) } : {}) });
const yes = (text: string) => text.trim().toLowerCase() === "yes";
const registration = (data: Data) => data.mode === "profiles" ? stay({ status: "succeeded", registered: false }) : ask(data, "confirm_register",
  `\nAutoload registration: ${JSON.stringify([data.context.pi, ...(data.context.piArgs ?? []), "install", data.context.root])}\n` +
  `Changes the package list in user configuration ${JSON.stringify(data.context.agentDir)}. Existing profiles/keys stay untouched.\nRegister? [yes/default no]: `);

function recommendedThinking(data: Data): Thinking | undefined {
  const preset = recommendations[data.templates[data.index]!.name];
  return data.model === preset.model && data.levels.includes(preset.thinking) ? preset.thinking : undefined;
}

function profileQuestion(data: Data, step: "model" | "thinking", invalid = false): Transition {
  const name = data.templates[data.index]!.name;
  const value = step === "model" ? recommendations[name].model : recommendedThinking(data);
  const label = step === "model" ? "exact provider/model ID (never enter a key)" : `thinking (${data.levels.join(" / ")})`;
  return ask(data, step, `\n${invalid ? "Invalid format. " : ""}${name}: ${label}; ` +
    `${value ? `Enter=suggested ${value}` : "no suggestion; Enter=skip profile"}; enter a value or skip=omit profile: `);
}

function nextProfile(data: Data): Transition {
  let index = data.index;
  while (data.templates[index]?.exists) index++;
  const next = { ...data, index, model: "" };
  const template = data.templates[index];
  if (template) return profileQuestion(next, "model");
  if (!data.profiles.length) return registration(next);
  return ask(next, "confirm_profiles", `\nCreate only these missing files. Existing files are never overwritten.\n` +
    data.profiles.map((profile) => `${JSON.stringify(profile.file)}\n${profile.content}`).join("\n") + "\nCreate this exact content? [yes/default no]: ");
}

function profileContent(template: Template, model: string, thinking?: Thinking): string {
  return template.content.replace(/^model: ""$/m, `model: ${JSON.stringify(model)}${thinking ? `\nthinking: ${thinking}` : ""}`);
}

function addProfile(data: Data, thinking?: Thinking): Transition {
  const template = data.templates[data.index]!;
  const content = profileContent(template, data.model, thinking);
  return nextProfile({ ...data, index: data.index + 1, profiles: [...data.profiles, { file: template.file, content }] });
}

export function reduceSetup(state: SetupState, event: SetupEvent): Transition {
  if (state.status === "succeeded" || state.status === "cancelled" || state.status === "failed") return stay(state);
  if (event.type === "cancel" || event.type === "failed") return stay(event.type === "cancel"
    ? { status: "cancelled" } : { status: "failed", error: event.error });
  if (state.status === "idle" && event.type === "start") return { state: { status: "checking", mode: event.mode ?? "install" },
    effects: [{ type: "inspect", root: event.root, mode: event.mode ?? "install" }] };
  if (state.status === "checking" && event.type === "checked") {
    const context = { ...event.context, ...(event.context.piArgs ? { piArgs: [...event.context.piArgs] } : {}),
      ...(event.context.bunArgs ? { bunArgs: [...event.context.bunArgs] } : {}) };
    const data: Data = { context, mode: state.mode ?? "install", templates: [], levels: [], index: 0, profiles: [], model: "" };
    if (data.mode === "status") return active(data, "diagnose", { type: "diagnose", context });
    if (data.mode === "profiles") return active(data, "load_profiles", { type: "load_profiles", context });
    return ask(data, "confirm_prepare",
      `\nExtension: ${JSON.stringify(context.root)}\nUser configuration: ${JSON.stringify(context.agentDir)}\n` +
      `Existing Pi: ${JSON.stringify([context.pi, ...(context.piArgs ?? [])])} (${context.piVersion}); tested version: ${context.testedVersion}\n` +
      (context.piVersion === context.testedVersion ? "" : "Warning: existing Pi differs from the tested version. Compatibility is not guaranteed; stopping is recommended.\n") +
      `Runs frozen Bun install with --ignore-scripts and the Bun check command in the extension directory.\n` +
      (context.checkScript === "check:windows" ? "Windows basic/setup checks, not complete Goal/SoL-Pi/D/v1 acceptance evidence.\n" : "") +
      "Frozen install may fetch pinned packages from the registry and replace node_modules. Lifecycle scripts are disabled; no Node fallback. Stop running Pi/workers first.\n" +
      "No global Pi/OS packages/shell settings change, model calls, login or key storage.\nContinue? [yes/default no]: ");
  }
  if (state.status !== "active") return stay(state);
  const { data, step } = state;
  if (event.type === "command_done" && event.step === step) {
    if (step === "register") return stay({ status: "succeeded", registered: true });
    if (step === "install") return active(data, "test", { type: "command", step: "test", context: data.context });
    if (step === "test") return active(data, "load_profiles", { type: "load_profiles", context: data.context });
  }
  if (step === "diagnose" && event.type === "diagnosed") return stay({ status: "succeeded", registered: false,
    report: { ...event.report, profiles: event.report.profiles.map(profile => ({ ...profile })) } });
  if (step === "load_profiles" && event.type === "profiles_loaded") {
    const next = { ...data, templates: event.templates.map(template => ({ ...template })), levels: [...event.levels] };
    if (data.mode !== "profiles") return nextProfile(next);
    const profiles: Profile[] = [];
    for (const template of next.templates) {
      if (template.exists) continue;
      const preset = recommendations[template.name];
      if (!next.levels.includes(preset.thinking)) return stay({ status: "failed", error: "Suggested thinking level unsupported. No automatic substitution." });
      profiles.push({ file: template.file, content: profileContent(template, preset.model, preset.thinking) });
    }
    return nextProfile({ ...next, profiles, index: next.templates.length });
  }
  if (step === "write_profiles" && event.type === "profiles_written") return registration(data);
  if (event.type !== "answer") return stay(state);
  const text = event.text.trim();
  switch (step) {
    case "confirm_prepare": return yes(text) ? active(data, "install", { type: "command", step: "install", context: data.context }) : stay({ status: "cancelled" });
    case "model": {
      if (text.toLowerCase() === "skip") return nextProfile({ ...data, index: data.index + 1 });
      const model = text || recommendations[data.templates[data.index]!.name].model;
      // ponytail: safe ASCII IDs only; unusual IDs and pools use the manual profile guide.
      if (!/^[a-z][a-z0-9_-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/.test(model))
        return profileQuestion(data, "model", true);
      const next = { ...data, model };
      return model.startsWith("openai-codex/") ? profileQuestion(next, "thinking") : addProfile(next);
    }
    case "thinking": {
      const value = text || recommendedThinking(data);
      if (!value || text.toLowerCase() === "skip") return nextProfile({ ...data, index: data.index + 1 });
      const level = data.levels.find((level) => level === value);
      return level ? addProfile(data, level) : profileQuestion(data, "thinking", true);
    }
    case "confirm_profiles": return yes(text) ? active(data, "write_profiles", { type: "write_profiles", profiles: data.profiles }) : stay({ status: "cancelled" });
    case "confirm_register": return yes(text) ? active(data, "register", { type: "command", step: "register", context: data.context })
      : stay({ status: "succeeded", registered: false });
    default: return stay(state);
  }
}

function environment(agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...workerEnvironment(process.env), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
    PI_CODING_AGENT_DIR: agentDir };
  stripJevEnvironment(env);
  return env;
}

/** Recognize the reviewed managed Pi launcher without running a .cmd or interpolating a shell. */
async function managedPiEntry(dir: string): Promise<string | undefined> {
  const shim = path.join(dir, "pi.cmd");
  const content = (await readFile(shim, "utf8")).replaceAll("\r\n", "\n").trim();
  const nodeShim = '@ECHO off\nnode "%~dp0pi-launcher.js" %*';
  const bunShim = '@ECHO off\nbun --smol --no-env-file --no-install --config=NUL "%~dp0pi-launcher.js" %*';
  if (content !== nodeShim && content !== bunShim) return undefined;
  const install = path.join(path.dirname(dir), "install"), version = (await readFile(path.join(install, "current-version"), "utf8")).trim();
  if (!versionPattern.test(version)) return undefined;
  const pkg = await realpath(path.join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent"));
  let data: { name?: string; version?: string; bin?: string | { pi?: string } };
  try { data = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8")); }
  catch { return undefined; }
  const bin = typeof data.bin === "string" ? data.bin : data.bin?.pi;
  if (data.name !== "@earendil-works/pi-coding-agent" || data.version !== version || typeof bin !== "string" || !bin) return undefined;
  const entry = await realpath(path.resolve(pkg, content === bunShim ? "dist/bun/cli.js" : bin)), relative = path.relative(pkg, entry);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep) || !(await lstat(entry)).isFile()) return undefined;
  return entry;
}
async function piExecutable(root: string, runtime: Pick<ReturnType<typeof bunWorkerOptions>, "execPath" | "execArgv">): Promise<{ file: string; args: readonly string[] } | undefined> {
  const windows = process.platform === "win32";
  const javascript = (entry: string) => ({ file: runtime.execPath, args: [...runtime.execArgv, entry] });
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of windows ? [".exe", ".cmd"] : [""]) {
      const file = path.resolve(dir, "pi" + suffix);
      try {
        await access(file, constants.X_OK);
        const resolved = await realpath(file);
        if (resolved.toLowerCase().startsWith((path.join(root, "node_modules") + path.sep).toLowerCase())) continue;
        if (!(await lstat(resolved)).isFile()) continue;
        if (!windows || suffix === ".exe") return /\.[cm]?js$/i.test(resolved) ? javascript(resolved) : { file, args: [] };
        const managed = await managedPiEntry(dir).catch(() => undefined);
        if (managed) return javascript(managed);
        // Only known npm-managed shims; execute the existing CLI directly, never through a shell.
        const entry = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
        const target = await realpath(entry);
        if (!(await lstat(target)).isFile() || target.toLowerCase().startsWith((path.join(root, "node_modules") + path.sep).toLowerCase())) continue;
        return javascript(target);
      } catch { /* Continue PATH; never install or substitute the checkout's CLI. */ }
    }
  }
  return undefined;
}

export async function runCommand(command: string, args: readonly string[], cwd: string, agentDir: string,
  signal: AbortSignal, timeoutMs: number): Promise<void> {
  signal.throwIfAborted();
  if (process.platform === "win32") {
    const runtime = bunWorkerOptions();
    // Parent-only selector: the Windows transport strips it before spawning the owned runner.
    const outcome = await setupIO.verifyWindows(cwd, { command, args: [...args] }, { ...environment(agentDir), JEV_BUN_EXECUTABLE: runtime.execPath }, signal, timeoutMs);
    if (outcome.type !== "verified" || outcome.result.status !== "passed") throw new Error("Windows command failed or was cancelled; no retry.");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(command, [...args], { cwd, env: environment(agentDir), shell: false, detached: true, stdio: ["ignore", "inherit", "inherit"] });
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (value: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, value); } catch { child.kill(value); } };
    const stop = () => { if (stopped) return; stopped = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 2_000); };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", stop);
    child.once("close", (code) => {
      clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", stop);
      kill("SIGKILL");
      if (stopped || signal.aborted || code !== 0) reject(new Error("Installation command failed, was cancelled or exceeded its deadline. No automatic retry."));
      else resolve();
    });
    if (signal.aborted) stop();
  });
}

async function resolveLocation(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(await resolveLocation(path.dirname(file)), path.basename(file));
  }
}

async function diagnoseSetup(context: Context, signal: AbortSignal): Promise<SetupReport> {
  let workerVersion: string | null = null;
  try {
    const runtime = bunWorkerOptions({ ...process.env, JEV_BUN_EXECUTABLE: context.bun });
    const result = await promisify(cp.execFile)(runtime.execPath, [...runtime.execArgv, "-e",
      'const { VERSION } = await import("@earendil-works/pi-coding-agent"); ' +
      'for (const name of ["subagent-worker", "ordinary-worker"]) ' +
      'await import(`./src/${name}.ts`); process.stdout.write(VERSION);'], {
      cwd: context.root, env: { PATH: process.env.PATH, HOME: context.agentDir, USERPROFILE: context.agentDir,
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
        PI_CODING_AGENT_DIR: context.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_DISABLE_COMPILE_CACHE: "1" },
      signal, timeout: 10_000, maxBuffer: 4_096, encoding: "utf8",
    });
    if (versionPattern.test(result.stdout.trim())) workerVersion = result.stdout.trim();
  } catch { /* Absence/incompatibility is diagnostic data, not a paid access probe or raw exception. */ }
  signal.throwIfAborted();
  const { loadAgents } = await import("../src/delegate-effects.ts");
  const profiles: SetupReport["profiles"][number][] = [];
  for (const name of SETUP_ROLES) {
    signal.throwIfAborted();
    const file = path.join(context.agentDir, "agents", `${name}.md`);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 32_768) { profiles.push({ name, status: "invalid" }); continue; }
    } catch (error) {
      profiles.push({ name, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" }); continue;
    }
    try {
      const [agent] = await loadAgents([name], signal);
      if (!agent) throw new Error("Missing profile");
      profiles.push({ name, status: "valid", plan: agent.pool ? "explicit model pool"
        : `${agent.model.provider}/${agent.model.id}${agent.thinking ? ` · ${agent.thinking}` : ""}` });
    } catch { profiles.push({ name, status: "invalid" }); }
  }
  signal.throwIfAborted();
  const configuration = readJevConnection();
  const jevProvider = configuration.ok ? { ready: true, target: { backend: configuration.connection.backend,
    endpoint: configuration.connection.endpoint, model: configuration.connection.model } } : { ready: false, error: configuration.error };
  return { root: context.root, agentDir: context.agentDir, bun: WORKER_BUN_VERSION, platform: process.platform,
    piVersion: context.piVersion, testedVersion: context.testedVersion, workerVersion,
    jevKeyPresent: !!process.env.TYPESAFE_API_KEY?.trim(), jevProvider, profiles };
}

export const setupIO = { command: runCommand, verifyWindows };

export async function executeSetupEffect(effect: SetupEffect, question: SetupQuestion, signal: AbortSignal,
  report: (message: string) => void = console.log): Promise<SetupEvent> {
  signal.throwIfAborted();
  switch (effect.type) {
    case "inspect": {
      if (!["linux", "darwin", "win32"].includes(process.platform) || process.platform !== "win32" && process.getuid?.() === 0)
        return { type: "failed", error: "Run as a normal user on a supported OS. Do not use sudo/administrator mode." };
      if (process.platform === "win32") await checkWindowsActor(signal);
      let runtime;
      try { runtime = bunWorkerOptions(); }
      catch { return { type: "failed", error: "Verified standalone Bun1.4.3 is required. No automatic installation or Node fallback." }; }
      const root = await realpath(effect.root);
      if (root.split(path.sep).includes("node_modules")) return { type: "failed", error: "The checkout must be outside node_modules." };
      const rawDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
      const agentDir = rawDir.startsWith("~/") ? path.join(os.homedir(), rawDir.slice(2)) : rawDir;
      if (!path.isAbsolute(agentDir) || /[\x00-\x1f\x7f]/.test(agentDir)) return { type: "failed", error: "PI_CODING_AGENT_DIR must be an absolute path without control characters." };
      const storage = await resolveLocation(path.resolve(agentDir));
      if (storage === root || storage.startsWith(root + path.sep)) return { type: "failed", error: "Keep user Pi configuration outside the extension checkout." };
      const pi = await piExecutable(root, runtime);
      if (!pi) return { type: "failed", error: "Existing Pi executable not found on PATH. No separate installation or update." };
      const result = await promisify(cp.execFile)(pi.file, [...pi.args, "--version"], { env: environment(agentDir), signal, timeout: 10_000, maxBuffer: 4_096, encoding: "utf8" });
      const piVersion = result.stdout.trim();
      if (!versionPattern.test(piVersion)) return { type: "failed", error: "Could not confirm the existing Pi version." };
      let pkg;
      try { pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); }
      catch { return { type: "failed", error: "Could not read or parse package.json." }; }
      const testedVersion = pkg?.dependencies?.["@earendil-works/pi-coding-agent"];
      if (pkg?.name !== "jev-subagents" || typeof testedVersion !== "string" || !versionPattern.test(testedVersion))
        return { type: "failed", error: "Invalid extension checkout root or pinned Pi version." };
      return { type: "checked", context: { root, agentDir: storage, pi: pi.file, piArgs: [...pi.args], bun: runtime.execPath, bunArgs: [...runtime.execArgv], piVersion, testedVersion,
        ...(process.platform === "win32" ? { checkScript: "check:windows" as const } : {}) } };
    }
    case "diagnose": return { type: "diagnosed", report: await diagnoseSetup(effect.context, signal) };
    case "ask": return { type: "answer", text: await question(effect.message, effect.profiles) };
    case "command": {
      const { root, agentDir, pi, bun, piArgs, bunArgs, checkScript } = effect.context;
      const args = [...(effect.step === "register" ? piArgs ?? [] : bunArgs ?? []), ...(effect.step === "install"
        ? ["install", "--frozen-lockfile", "--ignore-scripts"]
        : effect.step === "test" ? ["run", checkScript ?? "check"] : ["install", root])];
      report(`\n[${effect.step}] ${JSON.stringify(args)}`);
      if (effect.step !== "register") {
        const runtime = bunWorkerOptions({ ...process.env, JEV_BUN_EXECUTABLE: bun });
        if (runtime.execPath !== bun || runtime.execArgv.length !== (bunArgs?.length ?? 0) || runtime.execArgv.some((arg, index) => arg !== bunArgs?.[index])) throw new Error(WORKER_RUNTIME_ERROR);
      }
      await setupIO.command(effect.step === "register" ? pi : bun, args, root, agentDir, signal, effect.step === "install" ? 600_000 : effect.step === "test" ? 180_000 : 30_000);
      return { type: "command_done", step: effect.step };
    }
    case "load_profiles": {
      const { THINKING_LEVELS } = await import("../src/planning.ts"); // Dependencies exist only after the approved install/check.
      const templates: Template[] = [];
      for (const name of SETUP_ROLES) {
        signal.throwIfAborted();
        const file = path.join(effect.context.agentDir, "agents", `${name}.md`);
        const templateFile = path.join(effect.context.root, "agents", `${name}.md`);
        const info = await lstat(templateFile);
        if (!info.isFile() || info.size > 32_768) throw new Error("Invalid profile template.");
        const content = (await readFile(templateFile, "utf8")).replace(/\r\n/g, "\n");
        if (Buffer.byteLength(content) > 32_768 || content.match(/^model: ""$/gm)?.length !== 1 || !content.includes(`\nname: ${name}\n`)) throw new Error("Invalid profile template.");
        let exists = false;
        try { await lstat(file); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (exists) report(`Preserved/skipped: ${JSON.stringify(file)} (existing content/model support not inspected)`);
        templates.push({ name, file, content, exists });
      }
      report("\nOnly input format is validated. Check model support/authentication/cost through /model and user configuration. Configure model pools manually.");
      report("Suggestions are fixed; the model catalog is not queried. Enter accepts the displayed suggestion; skip omits it. Choose thinking explicitly for other manually entered Codex models.");
      report("Suggested scout/worker: Luna/low; worker_strong: Astra/max; sol: Sol/low. No price/subscription-quota/quality guarantee. Actual support is checked separately before execution.");
      report("Selecting a suggestion does not approve file creation, registration or execution. No automatic escalation or SoL-Pi activation.");
      return { type: "profiles_loaded", templates, levels: [...THINKING_LEVELS] };
    }
    case "write_profiles":
      if (process.platform === "win32") {
        await createWindowsProfiles(effect.profiles, signal);
        for (const profile of effect.profiles) report(`Created: ${JSON.stringify(profile.file)}`);
        return { type: "profiles_written" };
      }
      for (const profile of effect.profiles) {
        signal.throwIfAborted();
        const parent = path.dirname(profile.file);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const info = await lstat(parent);
        if (!info.isDirectory() || info.uid !== process.geteuid?.() || info.mode & 0o022 || await realpath(parent) !== parent)
          throw new Error("Could not confirm profile-directory ownership/path.");
        signal.throwIfAborted();
        await writeFile(profile.file, profile.content, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 });
        report(`Created: ${JSON.stringify(profile.file)}`);
      }
      return { type: "profiles_written" };
  }
}

export async function runSetup(root: string, question: SetupQuestion, signal: AbortSignal,
  options: { mode?: SetupMode; report?: (message: string) => void } = {}): Promise<SetupState> {
  let transition = reduceSetup({ status: "idle" }, { type: "start", root, mode: options.mode ?? "install" });
  while (transition.effects.length) {
    let event: SetupEvent;
    try { event = await executeSetupEffect(transition.effects[0]!, question, signal, options.report); }
    catch { event = { type: "failed", error: "Installation stage incomplete. Check paths, permissions, tool versions and command output. Raw exceptions are withheld." }; }
    transition = reduceSetup(transition.state, signal.aborted ? { type: "cancel" } : event);
  }
  return transition.state;
}

async function main() {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Usage: ./install.sh in a real terminal (no piped input or automatic-approval option)"); process.exitCode = 1; return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", abort); rl.on("close", abort);
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const state = await runSetup(root, (message) => rl.question(message, { signal: controller.signal }), controller.signal);
    if (state.status === "succeeded") {
      console.log(state.registered ? "\nInstallation/registration complete. Restart existing Pi in the target project." : "\nPreparation complete. Autoload was not registered.");
      console.log(`Single-session load: pi -e '${path.join(root, "src", "index.ts").replaceAll("'", "'\\''")}'`);
      console.log("Use Pi /login for authentication and /model to inspect models. Export JEV keys explicitly in the launching shell. The installer never asks for, stores or prints keys.");
      console.log("Live-model/TUI validation is separate. See docs/installation.md.");
    } else {
      console.error(state.status === "cancelled" ? "\nInstallation cancelled." : "\nInstallation failed. " + (state.status === "failed" ? state.error : ""));
      process.exitCode = state.status === "cancelled" ? 130 : 1;
    }
    console.log("Installed dependencies, created profiles and registration changes are not rolled back automatically. Reruns never overwrite existing profiles.");
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import childProcess from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, lstat, mkdir, open, unlink, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GPU_LAYA, GPU_STAGES, gpuPacket, reduceGpu, type GpuPlan, type GpuStage } from "./gpu-laya.ts";
import { noLinks } from "./gpu-laya-download-effects.ts";
import { readGpuManifest } from "./gpu-laya-worker.ts";
import { ownWindowsProcess, type WindowsJob } from "./windows-job.ts";
import { registerManagedJev } from "./jev-config.ts";
import { discoverLocalModels } from "./jev-backend-effects.ts";
import type { BackendSelection } from "./jev-backend.ts";
import { bunWorkerOptions } from "./worker-runtime.ts";

export type OwnedGpu = { readonly origin: string; alive(): boolean; close(): Promise<boolean> };
export type GpuInstaller = { available(id: string): Promise<"install" | "start" | "running" | undefined>;
  activate(ctx: ExtensionContext, signal: AbortSignal, current: () => boolean): Promise<BackendSelection | undefined>;
  close(): Promise<boolean>; alive(id: string): boolean };
type Review = (ctx: ExtensionContext, packet: string, signal: AbortSignal) => Promise<boolean>;
const sources = ["gpu-laya.ts", "gpu-laya-effects.ts", "gpu-laya-worker.ts", "gpu-laya-download-effects.ts", "gpu-laya-server.py", "windows-job.ts", "worker-runtime.ts", "worker-bunfig.toml", "../tsconfig.json"];
// Lifecycle handles only. Unknown cleanup blocks new preparation/navigation; no ownership-marker bypass.
const unconfirmedJobs = new Set<WindowsJob>();
export async function gpuSourceDigest(): Promise<string> {
  const hash = createHash("sha256");
  for (const filename of sources) { hash.update(filename); hash.update(await readFile(fileURLToPath(new URL(filename, import.meta.url)))); }
  return hash.digest("hex");
}
export function gpuEnvironment(root: string, env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  // Allowlist, never copy provider/login/proxy/Python/uv hook credentials or the user's HOME.
  const system = env.SystemRoot ?? env.SYSTEMROOT;
  if (!system || !path.win32.isAbsolute(system) || !/^[A-Za-z]:[\\\\/]/.test(system)) throw new Error("Windows runtime unavailable.");
  return { SystemRoot: system, WINDIR: system, PATH: env.PATH ?? "", HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "appdata"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"),
    UV_CACHE_DIR: path.join(root, "uv-cache"), UV_PYTHON_INSTALL_DIR: path.join(root, "python"), UV_PYTHON_BIN_DIR: path.join(root, "bin"),
    UV_PYTHON_INSTALL_BIN: "0", UV_PYTHON_INSTALL_REGISTRY: "0", UV_NO_CONFIG: "1", UV_HTTP_RETRIES: "0", UV_HTTP_TIMEOUT: "120",
    UV_KEYRING_PROVIDER: "disabled", UV_LINK_MODE: "copy", HF_HOME: path.join(root, "hf"), HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONNOUSERSITE: "1", CUDA_VISIBLE_DEVICES: "0", DO_NOT_TRACK: "1", NO_COLOR: "1" };
}
async function inspect(root: string): Promise<GpuPlan> {
  if (!/^[A-Za-z]:[\\\\/]/.test(root)) throw new Error("A local Windows drive is required.");
  const runtimeExecutable = gpuInstallIO.runtime().execPath, workerScript = fileURLToPath(new URL("./gpu-laya-worker.ts", import.meta.url));
  await noLinks(root); const sourceDigest = await gpuSourceDigest();
  let existing = false;
  try { const stat = await lstat(root); if (!stat.isDirectory()) throw new Error(); existing = true; }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("Review the existing install directory."); }
  let ancestor = existing ? root : path.dirname(root);
  for (;;) {
    try { const space = await statfs(ancestor); if (Number(space.bavail) * Number(space.bsize) < (existing ? 256 * 1024 ** 2 : GPU_LAYA.freeBytes)) throw new Error("Insufficient install space."); break; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; ancestor = path.dirname(ancestor); }
  }
  if (existing) {
    // An outstanding lease, unrecognised directory, or partial install never authorises recovery.
    try { await lstat(path.join(root, "owner.json")); throw new Error("Existing owner needs review."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await readGpuManifest(root, sourceDigest);
  }
  return { version: 1, mode: existing ? "start" : "install", root, sourceDigest, runtimeExecutable, workerScript };
}
async function ownedHealth(origin: string, nonce: string, signal: AbortSignal): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin) || Number(origin.split(":").at(-1)) > 65535) throw new Error("Invalid owned origin.");
  for (let attempt = 0; attempt < 20 && !signal.aborted; attempt++) {
    try {
      const response = await fetch(`${origin}/__jev_owned`, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) });
      const reader = response.body?.getReader(); if (!reader) throw new Error(); let text = "";
      try { for (;;) { const value = await reader.read(); if (value.done) break; text += Buffer.from(value.value).toString("utf8"); if (text.length > 2048) throw new Error(); } }
      finally { await reader.cancel().catch(() => {}); }
      const value: unknown = JSON.parse(text);
      if (!response.ok || !value || typeof value !== "object" || !("owner" in value) || value.owner !== nonce || !("model" in value) || value.model !== "laya-1.0" || !("device" in value) || value.device !== "cuda:0") throw new Error();
      const [metadata] = await discoverLocalModels([origin], signal); if (!metadata?.presets.includes("laya")) throw new Error(); return;
    } catch { if (signal.aborted) break; }
    await new Promise<void>(resolve => { const timer = setTimeout(done, 250); function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); } signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done(); });
  }
  throw new Error("Owned model readiness not confirmed.");
}
async function startOwnedGpu(plan: GpuPlan, signal: AbortSignal, onStage: (stage: GpuStage) => void): Promise<OwnedGpu> {
  if (signal.aborted) throw new Error("Cancelled.");
  const latest = await gpuInstallIO.inspect(plan.root); if (JSON.stringify(latest) !== JSON.stringify(plan)) throw new Error("Install plan changed.");
  const runtime = gpuInstallIO.runtime({ ...gpuEnvironment(plan.root, process.env), JEV_BUN_EXECUTABLE: plan.runtimeExecutable });
  if (runtime.execPath !== plan.runtimeExecutable) throw new Error("Approved Bun executable changed.");
  await mkdir(path.dirname(plan.root), { recursive: true }); await noLinks(plan.root);
  if (plan.mode === "install") await mkdir(plan.root, { mode: 0o700 });
  const nonce = randomBytes(32).toString("hex"), owner = path.join(plan.root, "owner.json");
  const lock = await open(owner, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ version: 1, sourceDigest: plan.sourceDigest, nonce })); await lock.sync(); await lock.close();
  for (const directory of ["tmp", "appdata"]) await mkdir(path.join(plan.root, directory), { recursive: true });
  const earliest = Date.now();
  const child = childProcess.fork(plan.workerScript, [],
    { ...runtime, cwd: plan.root, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let active = true, ready = false, origin = "", stopped = false, job: WindowsJob | undefined, closing: Promise<boolean> | undefined;
  const ownership = gpuInstallIO.own(child, earliest);
  const close = (): Promise<boolean> => {
    if (closing) return closing; stopped = true; active = false;
    closing = (async () => {
      let clean = false;
      try { clean = await (job ?? await ownership).close(); } catch { child.kill("SIGKILL"); }
      // Release only our exact lease, only after confirmed process-tree cleanup and a successful ready state.
      if (clean && ready) {
        try { await noLinks(owner); const data: unknown = JSON.parse(await readFile(owner, "utf8")); if (!data || typeof data !== "object" || !("nonce" in data) || data.nonce !== nonce) throw new Error(); await unlink(owner); }
        catch { clean = false; }
      }
      if (!clean && job) unconfirmedJobs.add(job);
      return clean;
    })(); return closing;
  };
  return await new Promise<OwnedGpu>((resolve, reject) => {
    let completed = false, checking = false;
    const abort = () => { if (!completed) { completed = true; cleanup(); void close().then(() => reject(new Error("GPU installation cancelled."))); } };
    const timer = setTimeout(abort, GPU_LAYA.timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const fail = () => { if (!completed) { completed = true; cleanup(); void close().then(() => reject(new Error("GPU installation/startup or cleanup failed; files retained for review."))); } };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", fail); child.once("close", () => { active = false; fail(); });
    child.on("message", (message: unknown) => {
      if (completed || stopped) return;
      if (!message || typeof message !== "object" || !("type" in message)) { fail(); return; }
      if (message.type === "progress" && Object.keys(message).sort().join() === "stage,type" && "stage" in message && GPU_STAGES.includes(message.stage as GpuStage) && !checking) {
        try { onStage(message.stage as GpuStage); } catch { fail(); } return;
      }
      if (message.type !== "ready" || checking || Object.keys(message).sort().join() !== "origin,type" || !("origin" in message) || typeof message.origin !== "string") { fail(); return; }
      checking = true; origin = message.origin;
      void ownedHealth(origin, nonce, signal).then(() => {
        if (completed || stopped || signal.aborted || !active) { fail(); return; }
        completed = true; ready = true; cleanup(); resolve({ origin, alive: () => active && !stopped && child.exitCode === null && child.signalCode === null, close });
      }, fail);
    });
    void ownership.then(owned => {
      job = owned; if (completed || stopped || signal.aborted) { void close(); return; }
      child.send({ plan, nonce }, error => { if (error) fail(); });
    }, fail);
    if (signal.aborted) abort();
  });
}
// Offline tests replace OS/filesystem/process boundaries, never production review or approvals.
export const gpuInstallIO = { own: ownWindowsProcess, runtime: bunWorkerOptions, inspect, start: startOwnedGpu, sourceDigest: gpuSourceDigest,
  platform: () => ({ os: process.platform, arch: process.arch }) };
export function createGpuInstaller(review: Review): GpuInstaller {
  const root = path.join(os.homedir(), ".cache", "jev-local", "laya-gpu-v1"), handles = new Map<string, OwnedGpu>();
  return {
    alive(id) { return handles.get(id)?.alive() === true; },
    async available(id) {
      const platform = gpuInstallIO.platform();
      if (platform.os !== "win32" || platform.arch !== "x64" || unconfirmedJobs.size) return undefined;
      if (handles.get(id)?.alive()) return "running";
      try { return (await gpuInstallIO.inspect(root)).mode; } catch { return undefined; }
    },
    async activate(ctx, signal, current) {
      const platform = gpuInstallIO.platform();
      if (platform.os !== "win32" || platform.arch !== "x64" || !ctx.hasUI || !current() || signal.aborted || unconfirmedJobs.size) return undefined;
      const id = ctx.sessionManager.getSessionId(), existing = handles.get(id);
      if (existing?.alive() && current()) return { mode: "local", preset: "laya", origin: existing.origin, managed: true };
      let transition = reduceGpu({ status: "idle" }, { type: "prepare", plan: await gpuInstallIO.inspect(root) });
      while (transition.effects.length) {
        if (!current()) return undefined;
        const effect = transition.effects[0]!;
        if (effect.type === "review") {
          const accepted = await review(ctx, gpuPacket(effect.plan), signal);
          transition = reduceGpu(transition.state, current() ? { type: "approved", accepted: accepted === true } : { type: "cancel" });
        } else {
          if (!current() || await gpuInstallIO.sourceDigest() !== effect.plan.sourceDigest) throw new Error("Changed installer source.");
          const handle = await gpuInstallIO.start(effect.plan, signal, stage => {
            transition = reduceGpu(transition.state, { type: "progress", stage });
            if (transition.state.status === "failed") throw new Error("Invalid GPU progress.");
            try { ctx.ui.setStatus?.("jev-setup", `Laya GPU · ${stage}…`); } catch { /* Cosmetic only. */ }
          });
          if (!current()) {
            if (!await handle.close()) { handles.set(id, handle); throw new Error("GPU cleanup is uncertain; ownership retained."); }
            return undefined;
          }
          transition = reduceGpu(transition.state, { type: "ready", origin: handle.origin });
          if (transition.state.status !== "ready") {
            if (!await handle.close()) handles.set(id, handle);
            throw new Error("Invalid owned readiness; cleanup may require review.");
          }
          handles.set(id, handle); registerManagedJev(id, handle.origin, handle.alive);
        }
      }
      return transition.state.status === "ready" ? { mode: "local", preset: "laya", origin: transition.state.origin, managed: true } : undefined;
    },
    async close() {
      const results = await Promise.all([...handles.entries()].map(async ([id, handle]) => {
        const clean = await handle.close(); if (clean) handles.delete(id); return clean;
      }));
      return unconfirmedJobs.size === 0 && results.every(result => result === true);
    },
  };
}

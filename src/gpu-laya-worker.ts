import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GPU_LAYA, validGpuPlan, type GpuPlan, type GpuStage } from "./gpu-laya.ts";
import { downloadGpuFile, noLinks, uvExecutable } from "./gpu-laya-download-effects.ts";

export type GpuManifest = { version: 1; sourceDigest: string; uvDigest: string; helperDigest: string; files: { name: string; digest: string }[] };
export function validGpuManifest(value: unknown, digest: string): value is GpuManifest {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "files,helperDigest,sourceDigest,uvDigest,version" || !("version" in value) || value.version !== 1 ||
    !("sourceDigest" in value) || value.sourceDigest !== digest || !("uvDigest" in value) || typeof value.uvDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.uvDigest) ||
    !("helperDigest" in value) || typeof value.helperDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.helperDigest) || !("files" in value) || !Array.isArray(value.files) || value.files.length !== GPU_LAYA.files.length) return false;
  return value.files.every((file: unknown, i) => file && typeof file === "object" && Object.keys(file).sort().join() === "digest,name" && "name" in file && file.name === GPU_LAYA.files[i] &&
    "digest" in file && typeof file.digest === "string" && /^[a-f0-9]{64}$/.test(file.digest) && (file.name !== "model.safetensors" || file.digest === GPU_LAYA.weightsSha256));
}
export async function gpuFileDigest(filename: string): Promise<string> {
  await noLinks(filename); const stat = await lstat(filename);
  if (!stat.isFile() || stat.size > 1024 ** 3) throw new Error("Changed cached file.");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer); return hash.digest("hex");
}
export async function readGpuManifest(root: string, sourceDigest: string): Promise<GpuManifest> {
  const filename = path.join(root, "ready.json"); await noLinks(filename);
  if ((await lstat(filename)).size > 65536) throw new Error("Invalid cache manifest.");
  try { const value: unknown = JSON.parse(await readFile(filename, "utf8")); if (!validGpuManifest(value, sourceDigest)) throw new Error(); return value; }
  catch { throw new Error("Invalid cache manifest."); }
}
function progress(stage: GpuStage): void { process.send?.({ type: "progress", stage }); }
async function command(executable: string, args: readonly string[], root: string, signal: AbortSignal, input?: string, expected?: string): Promise<void> {
  if (signal.aborted) throw new Error("Stopped.");
  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(executable, [...args], { cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "", invalid = false;
    const stop = () => child.kill(); signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => { if (output.length + data.length > 4096) { invalid = true; child.kill(); } else output += data.toString("utf8"); });
    child.once("error", () => { invalid = true; });
    child.once("close", code => { signal.removeEventListener("abort", stop); if (signal.aborted || invalid || code !== 0 || expected && output.trim() !== expected) reject(new Error("Approved command failed.")); else resolve(); });
    child.stdin.on("error", () => { invalid = true; }); child.stdin.end(input ?? ""); if (signal.aborted) stop();
  });
}
export async function prepareGpu(plan: GpuPlan, nonce: string, signal: AbortSignal): Promise<void> {
  const root = plan.root, uv = path.join(root, "uv.exe"), python = path.join(root, "venv", "Scripts", "python.exe"), helper = path.join(root, "server.py");
  const helperSource = await readFile(fileURLToPath(new URL("./gpu-laya-server.py", import.meta.url)));
  const helperDigest = createHash("sha256").update(helperSource).digest("hex");
  if (plan.mode === "install") {
    progress("bootstrap");
    const zipPath = path.join(root, "uv.zip");
    await downloadGpuFile(GPU_LAYA.uvUrl, zipPath, 24 * 1024 ** 2, signal, GPU_LAYA.uvSha256);
    const zip = await readFile(zipPath);
    if (createHash("sha256").update(zip).digest("hex") !== GPU_LAYA.uvSha256) throw new Error("Changed uv archive.");
    const binary = uvExecutable(zip); await writeFile(uv, binary, { flag: "wx", mode: 0o700 });
    await writeFile(helper, helperSource, { flag: "wx", mode: 0o600 });
    const runUv = (args: readonly string[]) => command(uv, ["--no-config", "--no-progress", ...args], root, signal);
    progress("python"); await runUv(["python", "install", "--no-bin", "--no-registry", "--install-dir", path.join(root, "python"), GPU_LAYA.python]);
    progress("venv"); await runUv(["--managed-python", "--no-python-downloads", "venv", "--python", GPU_LAYA.python, path.join(root, "venv")]);
    progress("torch"); await runUv(["pip", "install", "--python", python, "--only-binary", ":all:", "--index-url", "https://download.pytorch.org/whl/cu128", `torch==${GPU_LAYA.torch}`]);
    progress("gpu-check"); await command(python, ["-I", "-u", helper], root, signal, JSON.stringify({ mode: "probe", root, nonce }) + "\n", '{"type":"gpu_ok"}');
    progress("packages"); await runUv(["pip", "install", "--python", python, "--only-binary", ":all:", "--index-url", "https://pypi.org/simple", ...GPU_LAYA.packages]);
    progress("source"); const archive = path.join(root, "openjev.tar.gz");
    await downloadGpuFile(GPU_LAYA.sourceUrl, archive, 1024 ** 2, signal, GPU_LAYA.sourceSha256);
    await runUv(["pip", "install", "--python", python, "--no-deps", "--no-build-isolation", archive]);
    progress("model"); const files: GpuManifest["files"] = [];
    for (const name of GPU_LAYA.files) {
      const digest = await downloadGpuFile(`https://huggingface.co/${GPU_LAYA.repo}/resolve/${GPU_LAYA.revision}/${name}`, path.join(root, "model", ...name.split("/")),
        name === "model.safetensors" ? GPU_LAYA.weightsBytes : 16 * 1024 ** 2, signal, name === "model.safetensors" ? GPU_LAYA.weightsSha256 : undefined);
      files.push({ name, digest });
    }
    const manifest: GpuManifest = { version: 1, sourceDigest: plan.sourceDigest, uvDigest: createHash("sha256").update(binary).digest("hex"), helperDigest, files };
    await writeFile(path.join(root, "ready.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
  } else {
    const manifest = await readGpuManifest(root, plan.sourceDigest);
    if (manifest.helperDigest !== helperDigest || await gpuFileDigest(helper) !== helperDigest || await gpuFileDigest(uv) !== manifest.uvDigest) throw new Error("Changed cached runtime.");
    progress("gpu-check"); await command(python, ["-I", "-u", helper], root, signal, JSON.stringify({ mode: "probe", root, nonce }) + "\n", '{"type":"gpu_ok"}');
    progress("model"); for (const file of manifest.files) if (await gpuFileDigest(path.join(root, "model", ...file.name.split("/"))) !== file.digest) throw new Error("Changed cached model.");
  }
}
async function serveGpu(plan: GpuPlan, nonce: string, signal: AbortSignal): Promise<void> {
  progress("server");
  const child = childProcess.spawn(path.join(plan.root, "venv", "Scripts", "python.exe"), ["-I", "-u", path.join(plan.root, "server.py")],
    { cwd: plan.root, env: process.env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"] });
  await new Promise<void>((resolve, reject) => {
    let buffer = "", seen = false, bad = false;
    const stop = () => child.kill(); signal.addEventListener("abort", stop, { once: true });
    child.once("error", () => { bad = true; }); child.stdin.on("error", () => { bad = true; });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8"); if (buffer.length > 4096) { bad = true; stop(); return; }
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (seen || !value || typeof value !== "object" || Object.keys(value).sort().join() !== "owner,port,type" || !("type" in value) || value.type !== "ready" ||
            !("owner" in value) || value.owner !== nonce || !("port" in value) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new Error();
          seen = true; process.send?.({ type: "ready", origin: `http://127.0.0.1:${value.port}` });
        } catch { bad = true; stop(); }
      }
    });
    child.once("close", () => { signal.removeEventListener("abort", stop); if (signal.aborted && !bad) resolve(); else reject(new Error("Owned GPU server stopped.")); });
    child.stdin.end(JSON.stringify({ mode: "serve", root: plan.root, nonce }) + "\n"); if (signal.aborted) stop();
  });
}
// The process remains inert until its parent has attached a Windows Job and sent this one payload.
if (process.send && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(); let admitted = false;
  process.on("disconnect", () => { controller.abort(); process.exitCode = 1; });
  process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "gpu_cancel") { controller.abort(); return; }
    if (admitted) { controller.abort(); return; } admitted = true;
    if (!message || typeof message !== "object" || Object.keys(message).sort().join() !== "nonce,plan" || !("plan" in message) || !validGpuPlan(message.plan) ||
      !("nonce" in message) || typeof message.nonce !== "string" || !/^[a-f0-9]{64}$/.test(message.nonce)) { process.send?.({ type: "failed" }, () => {}); process.exitCode = 1; if (process.connected) process.disconnect?.(); return; }
    const plan = message.plan, nonce = message.nonce;
    const timeout = setTimeout(() => controller.abort(), GPU_LAYA.timeoutMs);
    void prepareGpu(plan, nonce, controller.signal).then(() => { clearTimeout(timeout); return serveGpu(plan, nonce, controller.signal); }).then(() => {
      if (process.connected) process.disconnect?.();
    }, () => { clearTimeout(timeout); process.send?.({ type: "failed" }, () => {}); process.exitCode = 1; if (process.connected) process.disconnect?.(); });
  });
}

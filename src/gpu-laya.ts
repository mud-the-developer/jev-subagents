import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// Installation is a separate permission from choosing a connection. No implicit CPU fallback.
export const GPU_LAYA = {
  version: 1, python: "3.12.11", uv: "0.8.22", torch: "2.8.0", cuda: "12.8", model: "laya-1.0",
  uvUrl: "https://github.com/astral-sh/uv/releases/download/0.8.22/uv-x86_64-pc-windows-msvc.zip",
  uvSha256: "5049375aa2a5162f132b2c1cb992e25d42d47d934cab8c174dbe6f60973dcc12",
  sourceUrl: "https://codeload.github.com/razorback16/openjev/tar.gz/75f22b6dad8c360fdba0e0ebd3dc0a1187628f60",
  sourceSha256: "5e84d87188899bdfde7a3392426081d6b4da0370443f028527b9bbcd484388d3",
  revision: "e929ae5cf69bc34259cd2f95c9e91145b818b1f0", repo: "convaiinnovations/laya-typed-decisions",
  weightsSha256: "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e", weightsBytes: 842609220,
  timeoutMs: 1_200_000, freeBytes: 20 * 1024 ** 3,
  packages: ["laya==0.3.6", "transformers==4.57.1", "tokenizers==0.22.1", "huggingface-hub==0.35.3", "safetensors==0.5.3",
    "numpy==2.2.6", "fastapi==0.115.12", "uvicorn==0.34.3", "httpx==0.28.1", "jinja2==3.1.6", "setuptools==80.9.0", "wheel==0.45.1"],
  files: ["config.json", "encoder/config.json", "rl_agent_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "model.safetensors"],
} as const;
export const GPU_STAGES = ["bootstrap", "python", "venv", "torch", "gpu-check", "packages", "source", "model", "server"] as const;
export type GpuStage = typeof GPU_STAGES[number];
export const GpuPlanSchema = Type.Object({ version: Type.Literal(1), mode: Type.Union([Type.Literal("install"), Type.Literal("start")]),
  root: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[A-Za-z]:[\\\\/]" }),
  sourceDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  runtimeExecutable: Type.String({ minLength: 1, maxLength: 4096 }), workerScript: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
export type GpuPlan = Static<typeof GpuPlanSchema>;
export function validGpuPlan(value: unknown): value is GpuPlan { return Value.Check(GpuPlanSchema, value); }
export type GpuState = { readonly status: "idle" } | { readonly status: "reviewing"; readonly plan: GpuPlan }
  | { readonly status: "running"; readonly plan: GpuPlan; readonly stage: GpuStage | null }
  | { readonly status: "ready"; readonly origin: string } | { readonly status: "cancelled" } | { readonly status: "failed" };
export type GpuEvent = { readonly type: "prepare"; readonly plan: GpuPlan } | { readonly type: "approved"; readonly accepted: boolean }
  | { readonly type: "progress"; readonly stage: GpuStage } | { readonly type: "ready"; readonly origin: string }
  | { readonly type: "cancel" } | { readonly type: "fail" };
export type GpuEffect = { readonly type: "review"; readonly plan: GpuPlan } | { readonly type: "run"; readonly plan: GpuPlan };
export function reduceGpu(state: GpuState, event: GpuEvent): { state: GpuState; effects: readonly GpuEffect[] } {
  if (["ready", "cancelled", "failed"].includes(state.status)) return { state, effects: [] };
  if (event.type === "cancel" || event.type === "fail") return { state: { status: event.type === "cancel" ? "cancelled" : "failed" }, effects: [] };
  if (state.status === "idle" && event.type === "prepare") return validGpuPlan(event.plan)
    ? { state: { status: "reviewing", plan: structuredClone(event.plan) }, effects: [{ type: "review", plan: structuredClone(event.plan) }] }
    : { state: { status: "failed" }, effects: [] };
  if (state.status === "reviewing" && event.type === "approved") return event.accepted === true
    ? { state: { status: "running", plan: state.plan, stage: null }, effects: [{ type: "run", plan: structuredClone(state.plan) }] }
    : { state: { status: "cancelled" }, effects: [] };
  if (state.status === "running" && event.type === "progress") {
    const index = GPU_STAGES.indexOf(event.stage), previous = state.stage === null ? -1 : GPU_STAGES.indexOf(state.stage);
    return index < 0 || index < previous ? { state: { status: "failed" }, effects: [] } : { state: { ...state, stage: event.stage }, effects: [] };
  }
  if (state.status === "running" && event.type === "ready") return state.stage === "server" && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(event.origin) &&
    Number(event.origin.split(":").at(-1)) <= 65535 ? { state: { status: "ready", origin: event.origin }, effects: [] } : { state: { status: "failed" }, effects: [] };
  return { state, effects: [] };
}
export function gpuPacket(plan: GpuPlan): string {
  return ["Laya GPU · uv-managed Python + uv venv · Windows x64 · installation/server approval", `Operation: ${plan.mode === "install" ? "download → private install → GPU kernel check → server start" : "validate installed environment → GPU kernel check → server start (no new install)"}`,
    `Path: ${JSON.stringify(plan.root)} · source fingerprint: ${plan.sourceDigest}`, `Owned IPC runner: ${JSON.stringify(plan.runtimeExecutable)} ${JSON.stringify(plan.workerScript)} (verified standalone Bun; no Node or alternate CLI/PATH fallback)`,
    `GPU check/server command: ${JSON.stringify(plan.root + "\\venv\\Scripts\\python.exe")} -I -u ${JSON.stringify(plan.root + "\\server.py")} · separate private stdin/IPC input · synthetic Laya warmup after installation · at most20 owned loopback metadata/health probes (1s request +250ms gap)`,  `Python ${GPU_LAYA.python} / uv ${GPU_LAYA.uv} / PyTorch ${GPU_LAYA.torch}+cu128 / CUDA device 0`,
    "Global Python, PATH, registry, pip, CUDA drivers and Pi settings are unchanged. Always use uv venv and uv pip.",
    `uv: ${GPU_LAYA.uvUrl} · SHA256 ${GPU_LAYA.uvSha256}`, `OpenJev: ${GPU_LAYA.sourceUrl} · SHA256 ${GPU_LAYA.sourceSha256}`,
    `Model: ${GPU_LAYA.repo}@${GPU_LAYA.revision} · safetensors ${GPU_LAYA.weightsBytes} bytes · SHA256 ${GPU_LAYA.weightsSha256}`,
    `Top-level packages: ${GPU_LAYA.packages.join(", ")} (complete transitive dependency lock/hashes are not pinned)`,
    "Sources: GitHub/release CDN, download.pytorch.org, PyPI/files.pythonhosted.org, Hugging Face/HF CDN. Public downloads only; user keys, projects and conversations are not sent.",
    "Estimated initial download:5–8 GB (estimate, not a hard byte quota). At least20 GiB free space. Installation/readiness limit20 minutes; approval window60 seconds. Actual size/speed unmeasured.",
    "Commands: uv --no-config python install --no-bin --no-registry --install-dir <root>/python 3.12.11; uv --no-config --managed-python --no-python-downloads venv --python 3.12.11 <root>/venv; uv --no-config pip install --python <venv>/Scripts/python.exe (GPU wheel index / PyPI / pinned local OpenJev archive).",
    "Runs public third-party Python/native code. Not a sandbox. Installed GPU packages perform a small synthetic tensor/kernel check and model loading, not user-task inference or quality validation.",
    "CUDA/architecture/kernel errors stop. No automatic CPU, alternate model or paid-provider substitution. No CUDA/driver installation or update.",
    "The server binds only a temporary127.0.0.1 port; its unauthenticated local API is accessible to other local processes. Session switch/fork/shutdown stops the owned process tree. Tree navigation/compaction cancels only an active installation.",
    "Cancellation/failure stops owned processes but does not roll back/delete downloaded files. Incomplete installation/unknown cleanup is not recovered automatically. Reusing an installation still needs separate server-start approval.",
    "This approval covers Laya preparation only. Task subagents, file edits, bash and remote transmission require separate approval."].join("\n");
}

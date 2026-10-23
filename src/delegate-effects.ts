import childProcess from "node:child_process";
import type { FullAccessLease } from "./delegation-access-effects.ts";
import { runWindowsSubagent, verifyWindows } from "./windows-worker-effects.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { progressReceiver, type WorkerProgress, type WorkerProgressObserver } from "./worker-progress.ts";
import { executeEffect as executeRouteEffect, requestJev } from "./effects.ts";
import { readJevConnection, describeJevTarget, stripJevEnvironment, type JevConnection } from "./jev-config.ts";
import { codexThinkingLevels, type Capability } from "./planning.ts";
import { AssessmentPacketSchema, assessmentQuestions, parseAssessment } from "./assessment.ts";
import { AGENT_NAME_PATTERN, LIMITS } from "./machine.ts";
import { readJevReport } from "./choice.ts";
import { englishProse } from "./internal-language.ts";
import { prepareSolPi } from "./sol-pi-effects.ts";
import { runSolPi } from "./sol-pi-run.ts";
import { solTools, SOL_STORAGE_BYTES, SOL_OUTPUT_TOKENS, SOL_TOOL_CALLS } from "./sol-pi.ts";
import { confirmContextPacket } from "./context-approval.ts";
import { taskReviewContent, type RunApproval } from "./task-review-machine.ts";
import { confirmNativeTaskReview } from "./native-task-review.ts";
import { bunWorkerOptions, WORKER_RUNTIME_ERROR } from "./worker-runtime.ts";
import {
  AgentDefinitionSchema, DEFAULT_TOOLS, executionSeconds, executionTimeoutMessage, RunSchema, VERIFY_TIMEOUT_MS, VerificationCommandSchema, WorkerReplySchema, initialState, reduce,
  type AgentDefinition, type DelegateInput, type Effect, type Event, type Run, type State, type WorkerReply,
} from "./delegate-machine.ts";

function modelRef(value: unknown) {
  const slash = typeof value === "string" ? value.indexOf("/") : -1;
  if (typeof value !== "string" || value !== value.trim() || slash < 1 || slash === value.length - 1 || /[\u0000-\u001f]/.test(value)) {
    throw new Error("Every agent must declare an explicit provider/model.");
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
function list(value: unknown): unknown[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim());
  if (Array.isArray(value)) return value;
  throw new Error("Expected an explicit list.");
}
export async function loadAgents(names: readonly string[], signal?: AbortSignal): Promise<readonly AgentDefinition[]> {
  const agents: AgentDefinition[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    if (name.length > LIMITS.name || !new RegExp(AGENT_NAME_PATTERN).test(name)) throw new Error("Invalid candidate name.");
    const file = path.join(getAgentDir(), "agents", `${name}.md`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    let content: string;
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Agent must be a regular file.");
      // Bounded read, even if a file grows after stat().
      const buffer = Buffer.alloc(32_769);
      let size = 0;
      while (size < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > 32_768) throw new Error("Agent definition is too large.");
      content = buffer.subarray(0, size).toString("utf8");
    } finally {
      await handle.close();
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    if (frontmatter.model !== undefined && frontmatter.models !== undefined) throw new Error("Use model or models, not both.");
    const models = frontmatter.models === undefined ? undefined : list(frontmatter.models).map(modelRef);
    const model = models ? models[0] : modelRef(frontmatter.model);
    const agent = {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: body,
      tools: frontmatter.tools === undefined ? [...DEFAULT_TOOLS]
        : typeof frontmatter.tools === "string" ? frontmatter.tools.split(",").map((tool) => tool.trim()) : frontmatter.tools,
      model,
      ...(models ? { pool: { models, thinking: list(frontmatter.thinking) } }
        : frontmatter.thinking === undefined ? {} : { thinking: frontmatter.thinking }),
      file,
    };
    if (!Value.Check(AgentDefinitionSchema, agent) || agent.name !== name || !englishProse(agent.description) || !englishProse(agent.systemPrompt)) throw new Error("Invalid agent definition; model-facing profile prose must be English.");
    agents.push(agent);
  }
  return agents;
}

function childEnvironment() {
  const env = { ...process.env };
  stripJevEnvironment(env);
  delete env.NODE_OPTIONS;
  return env;
}

export async function runSubagent(run: Run, signal?: AbortSignal, onProgress?: WorkerProgressObserver): Promise<Event> {
  if (signal?.aborted) return { type: "cancel" };
  if (!Value.Check(RunSchema, run)) return { type: "failed", error: "Invalid approved worker input." };
  if (process.platform === "win32") {
    if (run.solPi) return { type: "failed", error: "SoL-Pi private storage is not yet supported on native Windows." };
    return await runWindowsSubagent(run, childEnvironment(), signal, onProgress);
  }
  return new Promise((resolve) => {
    const deadline = Date.now() + executionSeconds(run) * 1000;
    const env = childEnvironment();
    if (run.solPi) {
      delete env.NODE_PATH;
      const temporary = path.join(run.solPi.options.storageDirectory, "tmp");
      Object.assign(env, { TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        PI_CODING_AGENT_DIR: path.dirname(path.dirname(run.agent.file)), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
        PI_DISABLE_ANALYTICS: "1", PI_DISABLE_INSTALL_TELEMETRY: "1", NODE_DISABLE_COMPILE_CACHE: "1" });
    }
    let runtime: ReturnType<typeof bunWorkerOptions>;
    try { runtime = bunWorkerOptions(env); } catch { resolve({ type: "failed", error: WORKER_RUNTIME_ERROR }); return; }
    if (signal?.aborted) { resolve({ type: "cancel" }); return; }
    if (Date.now() >= deadline) { resolve({ type: "failed", error: executionTimeoutMessage(run) }); return; }
    const child = childProcess.fork(fileURLToPath(new URL(run.solPi ? "./sol-pi-worker.ts" : "./subagent-worker.ts", import.meta.url)), [], {
      ...runtime, cwd: run.cwd,
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const receiveProgress = progressReceiver(onProgress);
    let reply: WorkerReply | undefined;
    let stopped: Event | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (event: Event) => {
      if (stopped) return;
      stopped = event;
      // pi's bash tool owns detached process groups: let session.abort() clean them up first.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      }, 2_000);
    };
    const onAbort = () => stop({ type: "cancel" });
    const timer = setTimeout(() => stop({ type: "failed", error: executionTimeoutMessage(run) }), Math.max(1, deadline - Date.now()));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("message", (message) => {
      // Keep a final accounting report during graceful cancellation, without accepting success.
      const progress = !run.solPi && !reply ? receiveProgress(message) : "not_progress";
      if (progress === "accepted") return;
      if (progress === "invalid" || reply || !Value.Check(WorkerReplySchema, message)) {
        stop({ type: "failed", error: "Subagent returned an invalid result." });
      } else reply = message;
    });
    child.on("error", () => stop({ type: "failed", error: "Unable to start or communicate with the subagent." }));
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const outcome: Event = signal?.aborted ? { type: "cancel" } : stopped
        ?? (code === 0 && reply ? reply : { type: "failed", error: "Subagent exited without a successful result." });
      const report = reply?.report;
      resolve(report ? { ...outcome, report: {
        ...report, accounting: report.accounting.status === "reported" && (stopped || code !== 0)
          ? { ...report.accounting, complete: false } : report.accounting,
      } } : outcome);
    });
    if (signal?.aborted) onAbort();
    if (!stopped) child.send(run, (error) => {
      if (error) stop({ type: "failed", error: "Unable to send the approved task to the subagent." });
    });
  });
}

export async function verify(cwd: string, command: NonNullable<Run["verification"]>, signal?: AbortSignal,
  timeoutMs = VERIFY_TIMEOUT_MS): Promise<Event> {
  if (signal?.aborted) return { type: "cancel" };
  const failed: Event = { type: "verified", result: { status: "failed", exitCode: null } };
  if (!Value.Check(VerificationCommandSchema, command)) return failed;
  if (process.platform === "win32") return await verifyWindows(cwd, command, childEnvironment(), signal, timeoutMs);
  try {
    return await new Promise<Event>((resolve) => {
      const child = childProcess.spawn(command.command, command.args, {
        cwd, env: childEnvironment(), shell: false, detached: true, stdio: "ignore",
      });
      let stopped: Event | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, signal); }
        catch { child.kill(signal); }
      };
      const stop = (event: Event) => {
        if (stopped) return;
        stopped = event;
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
      };
      const onAbort = () => stop({ type: "cancel" });
      const timer = setTimeout(() => stop({ type: "verified", result: { status: "timed_out", exitCode: null } }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", () => stop(failed));
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", onAbort);
        kill("SIGKILL"); // Reap remaining members of this command's process group, too.
        resolve(signal?.aborted ? { type: "cancel" } : stopped ?? { type: "verified", result: code === 0
          ? { status: "passed", exitCode: 0 } : { status: "failed", exitCode: code } });
      });
      if (signal?.aborted) onAbort();
    });
  } catch { return signal?.aborted ? { type: "cancel" } : failed; }
}

export async function executeEffect(effect: Effect, ctx: ExtensionContext, signal?: AbortSignal, presentApproval?: RunApproval,
  assessmentConnection?: JevConnection, onWorkerProgress?: (progress: WorkerProgress, run: Run) => void, access?: FullAccessLease): Promise<Event> {
  if (signal?.aborted) return { type: "cancel" };
  try {
    switch (effect.type) {
      case "load_agents": {
        if (!["darwin", "linux", "win32"].includes(process.platform)) return { type: "failed", error: "Unsupported subagent execution platform." };
        if (effect.needsAssessment) {
          const configuration = readJevConnection();
          if (!configuration.ok) return { type: "failed", error: `Completion assessment unavailable before execution: ${configuration.error}` };
        }
        const agents = await loadAgents(effect.names, signal);
        const capabilities: Capability[] = [];
        if (agents.some((agent) => agent.pool || agent.thinking)) {
          const agentDir = getAgentDir();
          const deadline = AbortSignal.timeout(10_000);
          const metadataSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
          const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
            allowModelNetwork: false, signal: metadataSignal });
          metadataSignal.throwIfAborted();
          for (const model of runtime.getAvailableSnapshot()) {
            if (!agents.some((agent) => (agent.pool?.models ?? [agent.model]).some((allowed) => allowed.provider === model.provider && allowed.id === model.id))) continue;
            capabilities.push({ model: { provider: model.provider, id: model.id }, thinking: codexThinkingLevels(model), contextWindow: model.contextWindow });
          }
        }
        return { type: "agents_loaded", agents, capabilities };
      }
      case "call_jev":
      case "sample_route":
        return await executeRouteEffect(effect, signal);
      case "prepare_sol": {
        const prepared = await prepareSolPi(effect.run, effect.options, signal);
        return { type: "sol_prepared", prepared, now: Date.now() };
      }
      case "confirm_run": {
        if (!ctx.hasUI) return { type: "failed", error: "Interactive approval is required." };
        if (effect.run.solPi) {
          const grant = effect.run.solPi;
          const packet = [
            "One Sol + pinned SoL-Pi worker. No other extensions, inherited parent conversation, model fallback, retry or restored grants.",
            `All worker, evidence-reducer and native-summary SDK calls share ${effect.run.maxModelCalls} calls / 120 seconds. Sub-limits are below. Not an HTTP/token/dollar cap.`,
            `Effective tools: ${JSON.stringify(solTools(effect.run.agent.tools, grant.options))}. All worker/reducer/native-summary model calls use ${effect.run.model.provider}/${effect.run.model.id}, thinking ${effect.run.agent.thinking}. The upstream default Luna reducer is explicitly overridden; no substitution. Requested output maximum ${SOL_OUTPUT_TOKENS} tokens (Codex may ignore it); 64 KiB observation stop and 30-second deadline per call, not hard server-side caps; tool admission cap ${SOL_TOOL_CALLS}.`,
            "Action Fusion, if enabled, allows model-selected shell commands after edits/writes. Shell/network/filesystem access is NOT sandboxed; cancellation is not rollback. Shell can invoke external programs outside SDK accounting. Fused tests are NOT the independent verifier.",
            "Evidence reduction, if enabled, may transmit eligible worker-visible diagnostic logs to the displayed fixed reducer model. Online compaction, if enabled, may transmit this worker's history and continue this same invocation within the same budgets. Neither touches the parent session.",
            `Worker session/history, original observations and diagnostic logs are retained in the explicit private storage directory. Admission inspection limit ${SOL_STORAGE_BYTES} bytes / 256 entries, not an OS disk quota. Native session fsync durability is NOT asserted. Uncertain accounting/storage/cleanup retains ownership; do not delete locks or bypass them.`,
            "Missing verifier means unverified completion. Any completion assessment still requires its separate exact-packet approval. No automatic task rework.",
            `Exact system prompt including SDK suffix: ${JSON.stringify(grant.systemPrompt + "\nCurrent working directory: " + effect.run.cwd + "\n")}`,
            JSON.stringify(effect.run, null, 2),
          ].join("\n\n");
          const approved = await confirmContextPacket(ctx, "Approve this bounded Sol + SoL-Pi worker?", packet, grant.approvalDeadline, signal ?? new AbortController().signal);
          return { type: "approval", approved, now: Date.now() };
        }
        const content = taskReviewContent(effect.run, effect.selection);
        const presented = access ? access.authorize(ctx, signal) : await presentApproval?.(content, ctx, signal);
        const approved = presented === undefined ? await confirmNativeTaskReview(content, ctx, signal) : presented;
        return { type: "approval", approved: approved === true };
      }
      case "run_agent":
        if (effect.run.solPi) return await runSolPi(effect.run, runSubagent, signal);
        return await runSubagent(effect.run, signal, progress => onWorkerProgress?.(progress, effect.run));
      case "verify":
        return await verify(effect.cwd, effect.command, signal);
      case "confirm_assessment": {
        if (!ctx.hasUI || !Value.Check(AssessmentPacketSchema, effect.packet)) return { type: "assessment_approval", approved: false };
        const configuration = assessmentConnection ? { ok: true as const, connection: assessmentConnection } : readJevConnection();
        if (!configuration.ok) return { type: "assessment_approval", approved: false };
        if (access) return { type: "assessment_approval", approved: access.authorize(ctx, signal) };
        const approved = await ctx.ui.confirm(`Send this completion evidence to ${configuration.connection.backend === "typesafe" ? "TypeSafe JEV" : configuration.connection.backend === "clef" ? "Local Clef" : "OpenJEV"}?`, [
          describeJevTarget(configuration.connection),
          "One additional JEV request. This is an AI assessment, not a proof of correctness. No automatic rework follows.",
          "Only the exact packet below will be sent. The worker claim is untrusted. Approve only a non-sensitive prose summary; decline if it contains code, diffs, logs, credentials, or needs more evidence. No files or conversation are gathered for this review.",
          JSON.stringify(effect.packet, null, 2),
        ].join("\n\n"), { ...(signal ? { signal } : {}), timeout: 60_000 });
        return { type: "assessment_approval", approved: approved === true };
      }
      case "assess": {
        if (!Value.Check(AssessmentPacketSchema, effect.packet)) return { type: "assessment_failed" };
        const response = await requestJev(effect.packet, assessmentQuestions(effect.packet), signal, undefined, assessmentConnection);
        const jev = response.type === "response" ? readJevReport(response.body) : response.jev;
        if (signal?.aborted || response.type === "cancel") return { type: "cancel", ...(jev ? { jev } : {}) };
        if (response.type !== "response") return { type: "assessment_failed", ...(jev ? { jev } : {}) };
        try { return { type: "assessed", reply: parseAssessment(response.body, effect.packet.criteria.length) }; }
        catch { return { type: "assessment_failed", ...(jev ? { jev } : {}) }; }
      }
      default:
        effect satisfies never;
        throw new Error("Unhandled delegation effect.");
    }
  } catch {
    return signal?.aborted ? { type: "cancel" }
      : { type: "failed", error: effect.type === "load_agents"
        ? "Agent preparation failed. Run /jev-subagents status; use /jev-subagents setup for missing default profiles. Review custom profiles and model authentication separately. No routing or worker execution was attempted; raw errors were withheld."
        : "Delegation effect failed. Check the candidate files, required provider/model entries, and execution environment; raw errors were withheld." };
  }
}

export async function delegate(input: DelegateInput, ctx: ExtensionContext, signal?: AbortSignal,
  onProgress?: (status: State["status"]) => void | Promise<void>, presentApproval?: RunApproval,
  onWorkerProgress?: (progress: WorkerProgress, run: Run) => void, access?: FullAccessLease): Promise<State> {
  if (access) signal = AbortSignal.any([access.signal, ...(signal ? [signal] : [])]);
  const started = performance.now();
  let assessmentConnection: JevConnection | undefined; // Effect-local; never serialized with approvals or reducer state.
  let transition = reduce(initialState(), signal?.aborted ? { type: "cancel" } : {
    type: "start", canConfirm: ctx.hasUI, job: { input, cwd: ctx.cwd },
  });
  // ponytail: one effect per transition; add a queue only when deliberately introducing fan-out.
  while (transition.effects.length) {
    const effectStarted = performance.now();
    try { void Promise.resolve(onProgress?.(transition.state.status)).catch(() => {}); }
    catch { /* Display failures must not control execution or approvals. */ }
    const effect = transition.effects[0]!;
    if (effect.type === "confirm_assessment") {
      const configuration = readJevConnection();
      assessmentConnection = configuration.ok ? configuration.connection : undefined;
    }
    const event = await executeEffect(effect, ctx, signal, presentApproval, assessmentConnection, onWorkerProgress, access);
    const ended = performance.now();
    transition = reduce(transition.state, { ...event, aborted: signal?.aborted === true,
      timing: { effectMs: ended - effectStarted, elapsedMs: ended - started } });
  }
  return transition.state;
}

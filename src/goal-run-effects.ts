import { randomUUID } from "node:crypto";
import childProcess, { type Serializable } from "node:child_process";
import { constants } from "node:fs";
import fs, { lstat, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { progressReceiver, type WorkerProgressObserver } from "./worker-progress.ts";
import { getAgentDir, ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { loadAgents } from "./delegate-effects.ts";
import { stripJevEnvironment } from "./jev-config.ts";
import { DEFAULT_MAX_MODEL_CALLS, type BoundedRun as Run } from "./delegate-machine.ts";
import { codexThinkingLevels } from "./planning.ts";
import { DirectoryValidationError, DirectoryPreparationError, directoryError, directoryPreparationIssues, directorySystemReason, type DirectoryReason, type DirectoryTarget } from "./directory-diagnostics.ts";
import { prepareGoalFileScope, checkGoalFileScope, snapshotGoalText } from "./goal-file-effects.ts";
import { canonicalWindowsGoalDirectory, openWindowsGoalProjectOwner, snapshotWindowsGoalTexts, withWindowsGoalReadBatch, withIndependentWindowsGoalRead } from "./windows-goal-files.ts";
import { runWindowsGoalProcess, markOwnedReplyIncomplete, type OwnedProcessReply } from "./windows-goal-process.ts";
import { bunWorkerOptions } from "./worker-runtime.ts";
import { goalFileDigest, validGoalFilePath, MAX_GOAL_FILE_BYTES, MAX_GOAL_FILES_BYTES } from "./goal-files.ts";
import { decodeGoalJournal, openGoalJournal, executeGoalStorageEffect, type GoalJournal } from "./goal-journal.ts";
import { GOAL_RUN_ERROR, GOAL_PROJECT_LOCK, GOAL_APPROVAL_MS, GOAL_WORKER_MS, GoalRunInputSchema, GoalWorkerReplySchema,
  goalLockText, goalPrompts, goalWorkerTools, validGoalGrant, reduceGoalRun,
  type GoalGrant, type GoalContextFile, type GoalRunJob, type GoalRunInput, type GoalRunState, type GoalRunEffect, type GoalRunEvent,
  type GoalLease, type GoalObservation, type GoalWorkerReply, type GoalAuthority } from "./goal-run.ts";

const fail = (): never => { throw new Error(GOAL_RUN_ERROR); };
const protections = (grant: GoalAuthority) => ({ journalDirectory: grant.body.journalDirectory, agentDirectory: grant.body.agentDirectory });
const same = (a: { dev: number; ino: number | string }, b: { dev: number; ino: number | string }) => a.dev === b.dev && a.ino === b.ino;
export async function canonicalDirectory(value: string, privateDirectory = false, signal?: AbortSignal): Promise<string> {
  const refuse = (reason: DirectoryReason): never => { throw new DirectoryValidationError(GOAL_RUN_ERROR, reason); };
  try {
    if (signal?.aborted) return refuse("cancelled");
    if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value)) return refuse("invalid_path");
    if (process.platform === "win32") {
      const root = await canonicalWindowsGoalDirectory(value, privateDirectory, signal);
      if (signal?.aborted) return refuse("cancelled");
      return root;
    }
    // POSIX identity is required on POSIX; Windows attests SID/DACL instead, never a fake UID.
    const getuid = process.getuid;
    if (typeof getuid !== "function") return refuse("actor_unavailable");
    const uid = getuid.call(process);
    if (!Number.isSafeInteger(uid) || uid < 0) return refuse("actor_unavailable");
    const before = await fs.lstat(value.replace(/\/+$/, "") || "/");
    if (before.isSymbolicLink()) return refuse("reparse_path");
    if (!before.isDirectory()) return refuse("not_directory");
    if (before.uid !== uid) return refuse("owner_mismatch");
    if ((before.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) return refuse(privateDirectory ? "unsafe_private_acl" : "unsafe_write_acl");
    const root = await realpath(value);
    if (!same(before, await fs.lstat(root))) return refuse("identity_changed");
    if (signal?.aborted) return refuse("cancelled");
    return root;
  } catch (error) {
    const detail = directoryError(error);
    throw new DirectoryValidationError(GOAL_RUN_ERROR, signal?.aborted ? "cancelled" : detail?.reason ?? directorySystemReason(error), detail?.cleanupConfirmed ?? true);
  }
}
/** Trusted effect/test seam, never a tool parameter or permission/identity cache. */
export const goalDirectoryIO = { canonical: canonicalDirectory };
/** Fresh independent reads only; drain both before admission or propagating failure. */
export async function checkFreshReadPair(first: () => Promise<void>, second: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  return withWindowsGoalReadBatch(async () => {
    signal?.throwIfAborted();
    const results = await Promise.allSettled([first, second].map(check => Promise.resolve().then(() => { signal?.throwIfAborted(); return check(); })));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.some(result => directoryError(result.reason)?.cleanupConfirmed === false || directoryPreparationIssues(result.reason)?.some(issue => !issue.cleanupConfirmed))) {
      throw new DirectoryValidationError(GOAL_RUN_ERROR, "unknown", false);
    }
    signal?.throwIfAborted();
    if (failures.length) throw failures[0]!.reason;
  }, signal);
}
/** Independent, read-only preparation. Drain every owned validation even on failure;
 * no file/model work or grant construction starts with partial directory results. */
export async function canonicalGoalDirectories(cwd: string, journalDirectory: string, agentDirectory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const requests = [{ path: cwd, private: false }, { path: journalDirectory, private: true }, { path: agentDirectory, private: false }];
  const results = await Promise.allSettled(requests.map(request => Promise.resolve().then(() =>
    withIndependentWindowsGoalRead(() => goalDirectoryIO.canonical(request.path, request.private, signal)))));
  signal?.throwIfAborted();
  const values = results.map(result => result.status === "fulfilled" ? result.value : fail());
  return { cwd: values[0]!, journalDirectory: values[1]!, agentDirectory: values[2]! };
}
/** Ordinary jobs have no journal. Drain both independent read-only directory
 * validations under the same real cancellation signal before any file/profile work. */
export async function canonicalOrdinaryDirectories(cwd: string, agentDirectory: string, signal?: AbortSignal) {
  const targets: readonly DirectoryTarget[] = ["workspace", "agent_directory"];
  if (signal?.aborted) throw new DirectoryPreparationError(GOAL_RUN_ERROR, targets.map(target => ({ target, reason: "cancelled", cleanupConfirmed: true })));
  const results = await Promise.allSettled([cwd, agentDirectory].map(value =>
    Promise.resolve().then(() => withIndependentWindowsGoalRead(() => goalDirectoryIO.canonical(value, false, signal)))));
  const issues = results.flatMap((result, index) => {
    if (result.status === "fulfilled" && !signal?.aborted) return [];
    const detail = result.status === "rejected" ? directoryError(result.reason) : undefined;
    return [{ target: targets[index]!, reason: signal?.aborted ? "cancelled" as const : detail?.reason ?? "unknown" as const,
      cleanupConfirmed: detail?.cleanupConfirmed ?? result.status === "fulfilled" }];
  });
  if (issues.length) throw new DirectoryPreparationError(GOAL_RUN_ERROR, issues);
  const values = results.map(result => result.status === "fulfilled" ? result.value : fail());
  return { cwd: values[0]!, agentDirectory: values[1]! };
}
/** Trusted effect/test seam only: fresh held-handle reads, never a cache or public worker option. */
export const goalControlFileIO = { snapshot: snapshotWindowsGoalTexts };
const ruleNames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** Pure named-path plan, not discovery, a snapshot cache or an execution grant. */
export function goalContextSnapshotPlan(cwd: string, agentDirectory: string, profile: string, files: readonly { path: string }[]) {
  const ancestors: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) { ancestors.unshift(dir); if (path.dirname(dir) === dir) break; }
  const directories = new Set([agentDirectory, ...ancestors]);
  for (const file of files) {
    let dir = cwd;
    for (const part of file.path.split("/").slice(0, -1)) { dir = path.join(dir, part); directories.add(dir); }
  }
  if (directories.size * ruleNames.length + 2 > 128) fail();
  return { directories: [...directories], paths: [profile, path.join(agentDirectory, "models.json"),
    ...[...directories].flatMap(directory => ruleNames.map(name => path.join(directory, name)))] };
}
export async function contextSnapshot(cwd: string, agentDirectory: string, profile: string, files: readonly { path: string }[], signal?: AbortSignal): Promise<GoalContextFile[]> {
  const { directories, paths } = goalContextSnapshotPlan(cwd, agentDirectory, profile, files), modelsPath = paths[1]!;
  // The final fresh check already reads exactly this full set under the same native
  // path/byte/frame caps. Combining initial reads does not admit a broader grant;
  // failures never retry a smaller batch or reuse an earlier profile/version.
  const nativeSnapshots = process.platform === "win32" ? await goalControlFileIO.snapshot(paths, signal) : undefined;
  const result: GoalContextFile[] = [];
  const profileSnapshot = nativeSnapshots ? nativeSnapshots[0] : await snapshotGoalText(profile, signal);
  if (!profileSnapshot) return fail();
  result.push({ path: profile, active: false, text: null, version: profileSnapshot.version });
  const modelSnapshot = nativeSnapshots ? nativeSnapshots[1] : await snapshotGoalText(modelsPath, signal);
  result.push({ path: modelsPath, active: false, text: null, version: modelSnapshot?.version ?? null });
  let snapshotIndex = 2;
  for (const directory of directories) {
    // ponytail: linked-worktree/submodule context shadowing is not admitted until a bounded resolver exists.
    try { if ((await lstat(path.join(directory, ".git"))).isFile()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let selected = false;
    for (const name of ruleNames) {
      const location = path.join(directory, name), snapshot = nativeSnapshots ? nativeSnapshots[snapshotIndex++]! : await snapshotGoalText(location, signal);
      const active: boolean = !selected && snapshot !== null;
      selected ||= active;
      result.push({ path: location, active, text: active ? snapshot!.text : null, version: snapshot?.version ?? null });
    }
  }
  return result;
}
export async function checkGoalContext(grant: { readonly body: Pick<GoalAuthority["body"], "context"> }, signal?: AbortSignal): Promise<void> {
  const nativeSnapshots = process.platform === "win32" ? await goalControlFileIO.snapshot(grant.body.context.map(entry => entry.path), signal) : undefined;
  for (const [index, entry] of grant.body.context.entries()) {
    const current = nativeSnapshots ? nativeSnapshots[index] : await snapshotGoalText(entry.path, signal);
    if (!isDeepStrictEqual(current?.version ?? null, entry.version)) fail();
  }
  signal?.throwIfAborted();
}
export async function loadGoalProfile(name: string, agentDirectory: string, signal?: AbortSignal) {
  const profile = path.join(agentDirectory, "agents", `${name}.md`), modelsPath = path.join(agentDirectory, "models.json");
  const nativeBefore = process.platform === "win32" ? await goalControlFileIO.snapshot([profile, modelsPath], signal) : undefined;
  const before = nativeBefore ? nativeBefore[0] : await snapshotGoalText(profile, signal);
  if (!before) return fail();
  const [definition] = await loadAgents([name], signal);
  if (!definition || definition.pool) return fail();
  const { pool: _pool, ...source } = definition;
  const agent = { ...source, file: profile };
  const modelConfiguration = (nativeBefore ? nativeBefore[1] : await snapshotGoalText(modelsPath, signal))?.version ?? null;
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDirectory, "auth.json"), modelsPath, allowModelNetwork: false,
    ...(signal ? { signal } : {}) });
  const model = runtime.getModel(agent.model.provider, agent.model.id);
  if (!model || model.provider !== agent.model.provider || model.id !== agent.model.id ||
    (agent.thinking ? !codexThinkingLevels(model).some(level => level === agent.thinking) : model.provider === "openai-codex")) fail();
  const nativeAfter = process.platform === "win32" ? await goalControlFileIO.snapshot([profile, modelsPath], signal) : undefined;
  if (!isDeepStrictEqual((nativeAfter ? nativeAfter[0] : await snapshotGoalText(profile, signal))?.version, before.version) ||
    !isDeepStrictEqual((nativeAfter ? nativeAfter[1] : await snapshotGoalText(modelsPath, signal))?.version ?? null, modelConfiguration)) fail();
  return { agent, profileVersion: before.version, modelConfiguration, publicModel: { api: model!.api, endpoint: model!.baseUrl } };
}
export async function prepareGoalRun(job: GoalRunJob, signal?: AbortSignal, extraContextFiles: readonly { path: string }[] = []): Promise<GoalGrant> {
  try {
    if (!Value.Check(GoalRunInputSchema, job.input) || !["darwin", "linux", "win32"].includes(process.platform) ||
      !Array.isArray(extraContextFiles) || extraContextFiles.length > 16 || extraContextFiles.some((file) => !validGoalFilePath(file.path))) fail();
    const request = structuredClone(job), contextFiles = structuredClone(extraContextFiles);
    const { cwd, journalDirectory, agentDirectory } = await canonicalGoalDirectories(request.cwd, request.input.journalDirectory, getAgentDir(), signal);
    const { agent, profileVersion, modelConfiguration } = await loadGoalProfile(request.input.agent, agentDirectory, signal);
    const files = await prepareGoalFileScope({ cwd, files: request.input.files }, { journalDirectory, agentDirectory }, signal);
    const context = await contextSnapshot(cwd, agentDirectory, agent.file, [...request.input.files, ...contextFiles], signal);
    if (!isDeepStrictEqual(context.find((entry) => entry.path === agent.file)?.version, profileVersion) ||
      !isDeepStrictEqual(context.find((entry) => entry.path === path.join(agentDirectory, "models.json"))?.version, modelConfiguration)) fail();
    const run: Run = { cwd, task: request.input.task, agent, model: agent.model, maxModelCalls: request.input.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS,
      ...(request.input.acceptanceCriteria ? { acceptanceCriteria: request.input.acceptanceCriteria } : {}) };
    const preparedAt = Date.now();
    const body: GoalGrant["body"] = { request, run, files, journalDirectory, agentDirectory, context, ...goalPrompts(run, files, context, request.input.memory),
      preparedAt, approvalDeadline: preparedAt + GOAL_APPROVAL_MS, deadline: preparedAt + GOAL_APPROVAL_MS + GOAL_WORKER_MS };
    const grant: GoalGrant = { body, ref: { goalId: randomUUID(), revision: 1, scopeDigest: goalFileDigest(JSON.stringify(body)) }, activationId: randomUUID(), intentId: randomUUID() };
    if (!validGoalGrant(grant)) fail();
    await checkGoalContext(grant, signal);
    signal?.throwIfAborted();
    return grant;
  } catch { return fail(); }
}

export type GoalProjectOwner = { readonly version: GoalLease["lockVersion"]; close(keep: boolean): Promise<boolean> };
export async function openGoalProjectLock(grant: Pick<GoalAuthority, "ref" | "activationId"> & {
  readonly body: { readonly run: Pick<GoalAuthority["body"]["run"], "cwd">; readonly files: Pick<GoalAuthority["body"]["files"], "rootIdentity"> };
}, signal?: AbortSignal): Promise<GoalProjectOwner> {
  const root = grant.body.run.cwd, filename = path.join(root, GOAL_PROJECT_LOCK);
  if (process.platform === "win32") {
    try {
      const owner = await openWindowsGoalProjectOwner(root, grant.body.files.rootIdentity, goalLockText(grant), signal);
      return { version: owner.version, async close(keep) { try { return await owner.close(keep); } catch { return fail(); } } };
    } catch { return fail(); }
  }
  let dir: FileHandle | undefined, file: FileHandle | undefined, version: GoalLease["lockVersion"] | undefined;
  let closing: Promise<boolean> | undefined;
  try {
    signal?.throwIfAborted();
    dir = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!same(await dir.stat(), grant.body.files.rootIdentity)) fail();
    file = await fs.open(filename, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const identity = await file.stat();
    const bytes = Buffer.from(goalLockText(grant));
    let offset = 0;
    while (offset < bytes.length) { const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset); if (bytesWritten <= 0) fail(); offset += bytesWritten; }
    await file.sync(); await dir.sync();
    const snapshot = await snapshotGoalText(filename);
    if (!snapshot || snapshot.text !== bytes.toString("utf8") || !same(snapshot.version.identity, identity)) return fail();
    version = snapshot.version;
    const ownedFile = file, ownedDir = dir, ownedVersion = version;
    return { version: structuredClone(version),
      close(keep) {
        if (closing) return closing;
        closing = (async () => {
          let ok = true;
          try { await ownedFile.close(); } catch { keep = true; ok = false; }
          if (!keep) {
            try {
              const current = await snapshotGoalText(filename);
              if (!current || !isDeepStrictEqual(current.version, ownedVersion) || !same(await lstat(root), grant.body.files.rootIdentity)) fail();
              await unlink(filename); await ownedDir.sync();
            } catch { keep = true; ok = false; }
          }
          try { await ownedDir.close(); } catch { ok = false; }
          if (!ok) return fail();
          return keep;
        })();
        return closing;
      },
    };
  } catch {
    // A partially created owner is intentionally retained for human inspection; never unlink an unknown marker.
    try { await file?.close(); } catch { /* Retain marker. */ }
    try { await dir?.close(); } catch { /* Sanitized below. */ }
    return fail();
  }
}
/** Pure transport sizing only; does not grant authority, cache versions, or perform I/O. */
export function goalLeaseControlBatches(context: readonly GoalContextFile[], ownerPath: string, journalPath: string, ownerBytes: number): [string[], ...string[][]] {
  const leasePaths = [ownerPath, journalPath], paths = [...leasePaths, ...context.map(entry => entry.path)];
  const bytes = ownerBytes + context.reduce((sum, entry) => sum + (entry.version?.bytes ?? 0), 0) + MAX_GOAL_FILE_BYTES;
  // Reserve a full possible journal, per-row metadata, root and worst-case JSON escaping.
  // Plan separate reads up front if the existing aggregate/128-path/200000-frame cap could be exceeded.
  const frame = Math.ceil(bytes / 3) * 4 + 4096 * 6 + 1024 + paths.reduce((sum, value) => sum + value.length * 6 + 1024, 0);
  return paths.length <= 128 && bytes <= MAX_GOAL_FILES_BYTES && frame <= 200000 ? [paths] : [leasePaths, context.map(entry => entry.path)];
}
export async function readGoalLeaseSnapshot(grant: GoalAuthority, lease: GoalLease, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const ownerPath = path.join(grant.body.run.cwd, GOAL_PROJECT_LOCK), journalPath = path.join(grant.body.journalDirectory, "goal.jsonl");
  // Choose the batch before I/O using approved byte upper bounds. Large scopes retain
  // separate bounded reads; never retry a failed batch or relax existing native caps.
  const batches = process.platform === "win32" ? goalLeaseControlBatches(grant.body.context, ownerPath, journalPath, lease.lockVersion.bytes) : undefined;
  const combined = batches?.length === 1;
  const native = batches ? await goalControlFileIO.snapshot(batches[0], signal) : undefined;
  const owner = native ? native[0] : await snapshotGoalText(ownerPath, signal);
  if (!owner || owner.text !== goalLockText(grant) || !isDeepStrictEqual(owner.version, lease.lockVersion)) fail();
  const journal = native ? native[1] : await snapshotGoalText(journalPath, signal);
  if (!journal) return fail();
  const snapshot = decodeGoalJournal(Buffer.from(journal.text));
  if (!isDeepStrictEqual(snapshot.head, lease.head) || !isDeepStrictEqual(snapshot.ledger?.definition.ref, grant.ref) ||
    snapshot.ledger?.activationId !== grant.activationId || !snapshot.ledger.pending || snapshot.ledger.blocked) return fail();
  if (combined) {
    for (const [index, entry] of grant.body.context.entries()) if (!isDeepStrictEqual(native?.[index + 2]?.version ?? null, entry.version)) fail();
  } else await checkGoalContext(grant, signal);
  signal?.throwIfAborted();
  return { ...snapshot, ledger: snapshot.ledger };
}
export async function readGoalLease(grant: GoalAuthority, lease: GoalLease, signal?: AbortSignal) {
  return (await readGoalLeaseSnapshot(grant, lease, signal)).ledger;
}
export async function checkGoalLease(grant: GoalGrant, lease: GoalLease, signal?: AbortSignal): Promise<void> {
  if ((await readGoalLease(grant, lease, signal)).pending?.id !== grant.intentId) fail();
}

function alive(pid: number): boolean { try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
export async function runGoalSubagent(grant: GoalGrant, lease: GoalLease, signal?: AbortSignal): Promise<GoalObservation> {
  return runGoalProcess({ script: "goal-worker.ts", cwd: grant.body.run.cwd, input: { grant, lease }, deadline: grant.body.deadline, timeoutMs: GOAL_WORKER_MS },
    (value): value is GoalWorkerReply => Value.Check(GoalWorkerReplySchema, value), signal);
}
export async function runGoalProcess<R extends OwnedProcessReply>(
  request: { readonly script: "goal-worker.ts" | "goal-sequence-worker.ts" | "context-worker.ts" | "ordinary-worker.ts" | "parallel-read-worker.ts" | "task-tree-worker.ts"; readonly cwd: string; readonly input: Serializable; readonly deadline: number; readonly timeoutMs: number },
  validReply: (value: unknown) => value is R, signal?: AbortSignal, onProgress?: WorkerProgressObserver,
): Promise<{ started: boolean; cleanupConfirmed: boolean; result: R | null }> {
  if (signal?.aborted) return { started: false, cleanupConfirmed: true, result: null };
  if (process.platform === "win32") return runWindowsGoalProcess(request, validReply, signal, onProgress);
  let launchAttempted = false;
  try {
    if (Buffer.byteLength(JSON.stringify(request.input)) > 393_216 || Date.now() >= request.deadline) return { started: false, cleanupConfirmed: true, result: null };
    return await new Promise<{ started: boolean; cleanupConfirmed: boolean; result: R | null }>((resolve) => {
      const startedAt = Date.now();
      const env: NodeJS.ProcessEnv = { ...process.env, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", PI_DISABLE_ANALYTICS: "1", PI_DISABLE_INSTALL_TELEMETRY: "1" };
      stripJevEnvironment(env); delete env.NODE_OPTIONS;
      const runtime = bunWorkerOptions(env);
      if (signal?.aborted || Date.now() >= request.deadline || Date.now() - startedAt >= request.timeoutMs) { resolve({ started: false, cleanupConfirmed: true, result: null }); return; }
      launchAttempted = true;
      const child = childProcess.fork(fileURLToPath(new URL(request.script, import.meta.url)), [], { ...runtime, cwd: request.cwd,
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const receiveProgress = progressReceiver(onProgress);
      let started = false, stopped = false, result: R | null = null;
      let exited = false, finishing = false, exitCode: number | null = null;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (stopped || finishing) return; stopped = true; child.kill("SIGTERM"); killTimer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 2_000); };
      const timer = setTimeout(stop, Math.max(1, Math.min(request.timeoutMs - (Date.now() - startedAt), request.deadline - Date.now())));
      signal?.addEventListener("abort", stop, { once: true });
      child.once("spawn", () => { started = true; });
      child.on("message", (message) => {
        if (finishing) return;
        const progress = started && !result && ["ordinary-worker.ts", "parallel-read-worker.ts", "task-tree-worker.ts"].includes(request.script) ? receiveProgress(message) : "not_progress";
        if (progress === "accepted") return;
        if (progress === "invalid" || result || !validReply(message) || Buffer.byteLength(JSON.stringify(message)) > 65_536) stop();
        else result = structuredClone(message);
      });
      child.on("error", stop);
      const finish = async (code: number | null) => {
        if (finishing) return;
        finishing = true;
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener("abort", stop);
        if (child.pid && alive(child.pid)) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Confirm below, never assume. */ }
          for (let i = 0; i < 20 && alive(child.pid); i++) await new Promise((done) => setTimeout(done, 10));
        }
        if (result && (stopped || code !== 0)) markOwnedReplyIncomplete(result);
        resolve({ started, cleanupConfirmed: !child.pid || !alive(child.pid), result });
      };
      child.once("close", finish);
      // Node 22 can omit `close` after an explicit IPC disconnect. Stdio is ignored:
      // process exit plus closed IPC is sufficient, still followed by group cleanup.
      child.once("exit", (code) => { exited = true; exitCode = code; if (!child.connected) void finish(code); });
      child.once("disconnect", () => { if (exited) void finish(exitCode); else if (!result) stop(); });
      if (signal?.aborted) stop();
      if (!stopped) { try { child.send(request.input, (error) => { if (error) stop(); }); } catch { stop(); } }
    });
  } catch { return { started: false, cleanupConfirmed: !launchAttempted, result: null }; }
}

/** Each call owns its machine, filesystem handles and worker controller; no shared domain state. */
export async function goalRun(input: GoalRunInput, ctx: ExtensionContext, signal?: AbortSignal,
  onProgress?: (status: string) => void | Promise<void>, runWorker = runGoalSubagent): Promise<GoalRunState> {
  let owner: GoalProjectOwner | undefined, journal: GoalJournal | undefined;
  let ownerAttempted = false, journalAttempted = false;
  const workerController = new AbortController();
  const executionSignal = signal ? AbortSignal.any([signal, workerController.signal]) : workerController.signal;
  let cancelled = false;
  const execute = async (effect: GoalRunEffect): Promise<GoalRunEvent> => {
    try {
      switch (effect.type) {
        case "prepare_goal_run": return { type: "prepared", grant: await prepareGoalRun(effect.job, executionSignal) };
        case "confirm_goal_run": {
          if (!ctx.hasUI) return { type: "failed" };
          const approved = await ctx.ui.confirm("Run this restricted-file Goal once?", [
            "One worker, no planner, routing, verifier, repair or automatic next task. The result is UNVERIFIED and needs human review.",
            "Only the displayed file-ID tools are installed, not the profile's bash/discovery tools. No OS sandbox, concurrent-editor protection, money cap or rollback. Model/auth runtime is trusted; additional model costs or subscription usage apply.",
            `Effective tools: ${JSON.stringify(goalWorkerTools(effect.grant))}; effective thinking: ${JSON.stringify(effect.grant.body.run.agent.thinking ?? "off")}. No parent-model/settings inheritance.`,
            "Selected file contents and the exact task/instructions may be sent to the displayed worker model. No JEV packet, parent conversation, skills or project extensions are sent/loaded.",
            `At most ${effect.grant.body.run.maxModelCalls} SDK stream calls (not HTTP attempts); 120 seconds; 64 file requests. Exact existing files only: 16 / 32 KiB each / 128 KiB total.`,
            `Host control file: ${path.join(effect.grant.body.run.cwd, GOAL_PROJECT_LOCK)}. Created exclusively after approval; only its own marker is removed after confirmed cleanup. Stale/uncertain ownership stops, never auto-taken over.`,
            "Create-only journal in the displayed existing private directory: synced metadata/digests/budgets/observations, not file bodies. No automatic directory creation, replay, retry, deletion or retention cleanup. A used journal requires inspection, not another run.",
            `Exact effective system prompt (JSON string): ${JSON.stringify(effect.grant.body.systemPrompt + "\nCurrent working directory: " + effect.grant.body.run.cwd + "\n")}`,
            `Exact worker prompt (JSON string): ${JSON.stringify(effect.grant.body.prompt)}`,
            JSON.stringify(effect.grant, null, 2),
          ].join("\n\n"), { signal: executionSignal, timeout: Math.max(1, effect.grant.body.approvalDeadline - Date.now()) });
          return { type: "approval", digest: effect.grant.ref.scopeDigest, approved: approved === true, now: Date.now() };
        }
        case "open_goal_run": {
          executionSignal.throwIfAborted();
          await checkGoalFileScope(effect.grant.body.files, protections(effect.grant), executionSignal);
          await checkGoalContext(effect.grant, executionSignal);
          ownerAttempted = true;
          owner = await openGoalProjectLock(effect.grant, executionSignal);
          executionSignal.throwIfAborted();
          journalAttempted = true;
          journal = await openGoalJournal(effect.grant.body.journalDirectory, "create", executionSignal);
          return { type: "opened", lockVersion: owner.version, now: Date.now() };
        }
        case "goal_control": {
          const current = effect.effect;
          if (current.type === "append_goal") {
            if (!journal) return { type: "failed" };
            // Settlement/closure must preserve observations even after execution cancellation.
            const storageSignal = current.record.type === "settled" || current.record.type === "closed" ? AbortSignal.timeout(10_000) : executionSignal;
            return { type: "control", event: await executeGoalStorageEffect(current, journal, storageSignal) };
          }
          if (current.type === "check_goal_admission") {
            let currentAuthority = false;
            try {
              if (!journal || !isDeepStrictEqual((await journal.load()).head, current.head)) fail();
              await checkGoalLease(effect.grant, effect.lease, executionSignal);
              await checkGoalFileScope(effect.grant.body.files, protections(effect.grant), executionSignal);
              currentAuthority = !executionSignal.aborted;
            } catch { /* Observation, not fallback permission. */ }
            return { type: "control", event: { type: "admission", ref: current.ref, activationId: current.activationId,
              intentId: current.intent.id, head: current.head, current: currentAuthority, now: Date.now() } };
          }
          if (current.type === "stop_goal_operation") { workerController.abort(); return { type: "stop_ack" }; }
          return { type: "observed", observation: await runWorker(effect.grant, effect.lease, executionSignal), now: Date.now() };
        }
        case "close_goal_run": {
          // A rejected open does not acknowledge journal startup cleanup (including descriptor close).
          let ok = (!ownerAttempted || owner !== undefined) && (!journalAttempted || journal !== undefined), keep = effect.keepLock || !ok;
          try { await journal?.close(); } catch { ok = false; keep = true; }
          try { keep = owner ? await owner.close(keep) : keep; } catch { ok = false; keep = true; }
          return { type: "closed", ok, lockRetained: keep };
        }
      }
    } catch { return { type: "failed" }; }
  };
  let transition = reduceGoalRun({ status: "idle" }, { type: "start", job: { cwd: ctx.cwd, input }, hasUI: ctx.hasUI });
  let queue = [...transition.effects];
  while (queue.length) {
    try { void Promise.resolve(onProgress?.(transition.state.status === "working" ? transition.state.core.status : transition.state.status)).catch(() => {}); } catch { /* Presentation is not authority. */ }
    const event = await execute(queue.shift()!);
    if (signal?.aborted && !cancelled) {
      cancelled = true;
      transition = reduceGoalRun(transition.state, { type: "cancel" });
      queue = [...transition.effects];
    }
    transition = reduceGoalRun(transition.state, event);
    queue.push(...transition.effects);
  }
  return transition.state;
}

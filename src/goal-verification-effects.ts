import { request as httpRequest } from "node:http";
import fs, { lstat, realpath, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import { prepareGoalFileScope, checkGoalFileScope, snapshotGoalText } from "./goal-file-effects.ts";
import type { GoalFileScope } from "./goal-files.ts";
import { GOAL_VERIFICATION_MS, VERIFICATION_API, VERIFICATION_PROBE, VerificationRequestSchema,
  imageEnvironment, matchesVerificationContainer, object, requestedCheck, supportedVerificationEngine, verificationContainer,
  type VerificationGrant, type VerificationInput, type VerificationRequest, type VerificationReply, type VerificationMount, type VerificationContainer,
} from "./goal-verification.ts";

export const GOAL_VERIFICATION_ERROR = "Isolated verification could not be confirmed. No host fallback, pull, retry, or automatic repair.";
const guardPath = fileURLToPath(new URL("./goal-verification-worker.mjs", import.meta.url));
function fail(): never { throw new Error(GOAL_VERIFICATION_ERROR); }
type Protections = { journalDirectory: string; agentDirectory: string };
export async function snapshotVerificationSocket(value: string): Promise<VerificationGrant["socket"]> {
  const directory = path.dirname(value);
  // Bun on macOS cannot realpath a socket leaf; canonical parent + lstat socket type still forbids every link.
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || path.join(directory, path.basename(value)) !== value ||
    await realpath(directory) !== directory || !process.getuid) return fail();
  const stat = await lstat(value, { bigint: true });
  if (!stat.isSocket() || stat.nlink !== 1n || stat.uid !== 0n && stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o002n) !== 0n ||
    stat.dev > BigInt(Number.MAX_SAFE_INTEGER) || stat.ino > BigInt(Number.MAX_SAFE_INTEGER)) return fail();
  return { path: value, identity: { dev: Number(stat.dev), ino: Number(stat.ino) },
    stamp: [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.nlink, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(":") };
}
export async function prepareVerification(input: VerificationInput, cwd: string, protections: Protections, signal?: AbortSignal): Promise<VerificationGrant> {
  try {
    const own = structuredClone(input);
    signal?.throwIfAborted();
    const socket = await snapshotVerificationSocket(own.socketPath);
    const files = await prepareGoalFileScope({ cwd, files: own.files.map((path) => ({ path, access: "read" as const })) }, protections, signal);
    const guard = await snapshotGoalText(guardPath, signal);
    if (!guard) return fail();
    return { files, socket, guard: guard.version };
  } catch { return fail(); }
}
export async function checkVerification(grant: VerificationGrant, protections: Protections, signal?: AbortSignal): Promise<void> {
  if (!isDeepStrictEqual(await snapshotVerificationSocket(grant.socket.path), grant.socket)) return fail();
  await checkGoalFileScope(grant.files, protections, signal);
  const guard = await snapshotGoalText(guardPath, signal);
  if (!guard || !isDeepStrictEqual(guard.version, grant.guard)) return fail();
}

/** Local Unix socket only; no Docker context, registry auth, image pull, remote endpoint, logs, or retries. */
async function docker(socket: VerificationGrant["socket"], method: string, route: string, expected: number, signal: AbortSignal, body?: unknown): Promise<unknown> {
  signal.throwIfAborted();
  if (!isDeepStrictEqual(await snapshotVerificationSocket(socket.path), socket)) return fail();
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  if (bytes && bytes.length > 65536) return fail();
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error(GOAL_VERIFICATION_ERROR));
    const request = httpRequest({ socketPath: socket.path, path: VERIFICATION_API + route, method, agent: false, signal,
      headers: bytes ? { "Content-Type": "application/json", "Content-Length": bytes.length } : {} }, (response) => {
      if (response.statusCode !== expected) { response.destroy(); stop(); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65536) { response.destroy(); request.destroy(); stop(); } else chunks.push(chunk);
      });
      response.on("error", stop);
      response.on("end", () => {
        try {
          const data = Buffer.concat(chunks);
          resolve(data.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) : null);
        } catch { stop(); }
      });
    });
    request.on("error", stop);
    request.end(bytes ?? undefined);
  });
}
export type VerificationExecution = { started: boolean; cleanupConfirmed: boolean; reply: VerificationReply };
export async function runGoalVerification(
  input: VerificationInput, grant: VerificationGrant, scope: GoalFileScope, request: VerificationRequest,
  operation: { id: string; goalId: string; activationId: string; deadline: number }, protections: Protections,
  checkCurrent: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal,
): Promise<VerificationExecution> {
  // These variables are native I/O/ownership observations, not Goal state. Only the outer reducer can authorize more work.
  const own = structuredClone({ input, grant, scope, request, operation, protections });
  const began = performance.now();
  let temporary: string | undefined, temporaryIdentity: { dev: number; ino: number } | undefined, temporaryAttempted = false;
  let id: string | null = null, attempted = false, cleanupConfirmed = true, isolated = false, filesCurrent = false;
  let exitCode: number | null = null, status: VerificationReply["status"] = "failed", expected: VerificationContainer | undefined;
  const timer = AbortSignal.timeout(Math.max(1, Math.min(GOAL_VERIFICATION_MS, own.operation.deadline - Date.now())));
  const active = signal ? AbortSignal.any([signal, timer]) : timer;
  const call = (method: string, route: string, code: number, body?: unknown, wait = false) =>
    docker(own.grant.socket, method, route, code, wait ? active : AbortSignal.any([active, AbortSignal.timeout(5000)]), body);
  const labels = { "ai.jev.goal": own.operation.goalId, "ai.jev.activation": own.operation.activationId, "ai.jev.operation": own.operation.id };
  const owned = (data: unknown) => { const record = object(data), config = object(record?.Config), seen = object(config?.Labels);
    return record?.Id === id && !!seen && Object.entries(labels).every(([key, value]) => seen[key] === value); };
  try {
    active.throwIfAborted();
    if (!Value.Check(VerificationRequestSchema, own.request) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(own.operation.id) ||
      !process.getuid || !process.getgid || process.getuid() === 0 || own.operation.deadline <= Date.now()) return fail();
    await checkCurrent(active);
    await checkVerification(own.grant, own.protections, active);
    const info = await call("GET", "/info", 200);
    const systemTime = object(info)?.SystemTime;
    if (!supportedVerificationEngine(info) || typeof systemTime !== "string" || !Number.isFinite(Date.parse(systemTime)) || Math.abs(Date.parse(systemTime) - Date.now()) > 1000) return fail();
    const env = imageEnvironment(await call("GET", `/images/${encodeURIComponent(own.input.image)}/json`, 200), own.input.image);
    if (!env) return fail();
    temporaryAttempted = true;
    temporary = await fs.mkdtemp(path.join(own.protections.journalDirectory, "verification-"));
    const directory = await lstat(temporary); temporaryIdentity = { dev: directory.dev, ino: directory.ino };
    const mounts: VerificationMount[] = [];
    const mount = async (text: string, target: string) => {
      active.throwIfAborted();
      const source = path.join(temporary!, String(mounts.length));
      await writeFile(source, text, { flag: "wx", mode: 0o444 });
      await chmod(source, 0o444); // Private parent + read-only bind; works with an unprivileged/rootless container UID too.
      if ((await snapshotGoalText(source, active))?.text !== text) return fail();
      mounts.push({ Type: "bind", Source: source, Target: target, ReadOnly: true, BindOptions: { Propagation: "rprivate" } });
    };
    const guard = await snapshotGoalText(guardPath, active);
    if (!guard || !isDeepStrictEqual(guard.version, own.grant.guard)) return fail();
    await mount(guard.text, "/jev/guard.mjs");
    let command: string, args: string[];
    if (own.request.stage === "probe") {
      if (own.request.checkId !== "probe") return fail();
      await mount("disposable canary\n", "/jev/canary"); command = "/bin/sh"; args = ["-c", VERIFICATION_PROBE];
    } else {
      const check = requestedCheck(own.input, own.request);
      if (!check) return fail();
      const selected = new Map(own.scope.files.map((file) => [file.path, file]));
      for (const file of own.grant.files.files) {
        const prior = selected.get(file.path);
        if (prior && !isDeepStrictEqual(prior.version, file.version)) return fail();
        selected.set(file.path, file);
      }
      for (const file of selected.values()) {
        const source = await snapshotGoalText(path.join(own.scope.root, file.path), active);
        if (!source || !isDeepStrictEqual(source.version, file.version)) return fail();
        await mount(source.text, `/workspace/${file.path}`);
      }
      command = check.command; args = check.args;
    }
    await checkCurrent(active);
    expected = verificationContainer(own.input.image, `${process.getuid()}:${process.getgid()}`, own.input.nodePath,
      ["/jev/guard.mjs", JSON.stringify({ command, args, deadline: own.operation.deadline })], env, mounts, labels);
    const name = `jev-${own.operation.goalId}-${own.operation.id}`;
    if (Buffer.byteLength(JSON.stringify(expected)) > 65536) return fail();
    attempted = true; // An unacknowledged create is not proof that no container exists.
    const created = object(await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, 201, expected));
    if (typeof created?.Id !== "string" || !/^[a-f0-9]{64}$/.test(created.Id)) return fail();
    id = created.Id;
    if (created.Warnings != null && (!Array.isArray(created.Warnings) || created.Warnings.length !== 0)) return fail();
    if (!matchesVerificationContainer(await call("GET", `/containers/${id}/json`, 200), expected, id)) return fail();
    isolated = true;
    await checkCurrent(active);
    if (own.operation.deadline <= Date.now() + 1000) return fail();
    await call("POST", `/containers/${id}/start`, 204);
    const waited = object(await call("POST", `/containers/${id}/wait?condition=not-running`, 200, undefined, true));
    const finished = await call("GET", `/containers/${id}/json`, 200), state = object(object(finished)?.State);
    if (!matchesVerificationContainer(finished, expected, id) || !state || !waited || state.Status !== "exited" || state.Running !== false || state.Pid !== 0 ||
      state.OOMKilled !== false || state.Dead !== false || state.Paused !== false || typeof state.StartedAt !== "string" || !Number.isFinite(Date.parse(state.StartedAt)) || state.StartedAt.startsWith("0001-") ||
      typeof waited.StatusCode !== "number" || !Number.isInteger(waited.StatusCode) || waited.StatusCode < 0 || waited.StatusCode > 255 || state.ExitCode !== waited.StatusCode || waited.Error != null) return fail();
    exitCode = waited.StatusCode;
    status = exitCode === 124 ? "timed_out" : exitCode >= 125 ? "failed" : "exited";
    await checkCurrent(active);
    await checkVerification(own.grant, own.protections, active);
    filesCurrent = true;
  } catch {
    status = signal?.aborted ? "cancelled" : timer.aborted ? "timed_out" : "failed";
  } finally {
    const cleanup = AbortSignal.timeout(10_000);
    try {
      if (attempted && id === null || temporaryAttempted && temporary === undefined) fail();
      if (id !== null) {
        const inspect = () => docker(own.grant.socket, "GET", `/containers/${id}/json`, 200, cleanup);
        let seen = await inspect();
        if (!owned(seen)) fail();
        let state = object(object(seen)?.State);
        if (!state) fail();
        if (state.Running === true || state.Paused === true) {
          await docker(own.grant.socket, "POST", `/containers/${id}/kill?signal=KILL`, 204, cleanup);
          // Wait for the namespace init to die; do not confuse a kill acknowledgement with completed cleanup.
          await docker(own.grant.socket, "POST", `/containers/${id}/wait?condition=not-running`, 200, cleanup);
          seen = await inspect(); state = object(object(seen)?.State);
        }
        if (!owned(seen) || !state || state.Running !== false || state.Pid !== 0 || !["created", "exited"].includes(String(state.Status))) fail();
        await docker(own.grant.socket, "DELETE", `/containers/${id}?v=true`, 204, cleanup);
      }
      if (temporary) {
        const stat = await lstat(temporary);
        if (!stat.isDirectory() || !isDeepStrictEqual({ dev: stat.dev, ino: stat.ino }, temporaryIdentity)) fail();
        await fs.rm(temporary, { recursive: true });
      }
    } catch { cleanupConfirmed = false; }
  }
  // Cleanup itself awaits the daemon and filesystem. Re-fence after those awaits before promoting a pass or a repair cause.
  if (cleanupConfirmed && status === "exited") {
    filesCurrent = false;
    try { await checkCurrent(active); await checkVerification(own.grant, own.protections, active); filesCurrent = true; }
    catch { status = signal?.aborted ? "cancelled" : timer.aborted ? "timed_out" : "failed"; }
  }
  return finish(cleanupConfirmed);
  function finish(clean: boolean): VerificationExecution {
    return { started: attempted, cleanupConfirmed: clean, reply: { type: "verification_result", operationId: own.operation.id, containerId: id,
      status: signal?.aborted ? "cancelled" : status, exitCode, isolated, filesCurrent, elapsedMs: Math.max(0, performance.now() - began) } };
  }
}

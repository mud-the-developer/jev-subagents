import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { VerificationEvidenceSchema } from "./goal-machine.ts";
export type { VerificationEvidence } from "./goal-machine.ts";
import { FileIdentitySchema, GoalFileScopeSchema, GoalFileVersionSchema, validGoalFilePath, validGoalFileScope, goalTextBytes, type GoalFileScope } from "./goal-files.ts";

const closed = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const id = Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" });
const absolute = Type.String({ minLength: 2, maxLength: 4096, pattern: "^/[^\\u0000-\\u001f\\u007f]*$" });
export const GOAL_VERIFICATION_MS = 30_000;
// This is an explicit checker protocol, NOT a reinterpretation of npm/Jest/pytest's generic exit 1.
export const GOAL_ASSERTION_EXIT = 42;
export const VerificationCheckSchema = Type.Object({ id, criteriaIds: Type.Array(Type.String({ pattern: "^criterion-[1-8]$" }), { minItems: 1, maxItems: 8, uniqueItems: true }),
  command: absolute, args: Type.Array(Type.String({ maxLength: 1024, pattern: "^[^\\u0000]*$" }), { maxItems: 32 }),
  entry: text(512), coverage: text(512),
}, closed);
export type VerificationCheck = Static<typeof VerificationCheckSchema>;
export const VerificationInputSchema = Type.Object({ socketPath: absolute, image: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }), nodePath: absolute,
  files: Type.Array(text(512), { minItems: 1, maxItems: 16, uniqueItems: true }),
  checks: Type.Array(VerificationCheckSchema, { minItems: 1, maxItems: 3 }), final: VerificationCheckSchema,
  budget: Type.Object({ runs: Type.Integer({ minimum: 3, maximum: 5 }), repairs: Type.Integer({ minimum: 0, maximum: 1 }) }, closed),
  failureProtocol: Type.Union([Type.Literal("no_automatic_repair"), Type.Literal("exit_42_assertions_only")]),
}, closed);
export type VerificationInput = Static<typeof VerificationInputSchema>;
export const VerificationGrantSchema = Type.Object({ files: GoalFileScopeSchema, guard: GoalFileVersionSchema,
  socket: Type.Object({ path: absolute, identity: FileIdentitySchema, stamp: text(512) }, closed),
}, closed);
export type VerificationGrant = Static<typeof VerificationGrantSchema>;
export const VerificationRequestSchema = Type.Pick(VerificationEvidenceSchema, ["stage", "checkId"]);
export type VerificationRequest = Static<typeof VerificationRequestSchema>;
export const VerificationReplySchema = Type.Object({ type: Type.Literal("verification_result"),
  ...Type.Omit(VerificationEvidenceSchema, ["stage", "checkId", "sourceDigest"]).properties,
}, closed);
export type VerificationReply = Static<typeof VerificationReplySchema>;

export function validVerificationInput(input: unknown, criterionCount: number, workers: number, workerCalls: number, plannerCalls: number, totalCalls: number, callLimit: number): input is VerificationInput {
  if (!Value.Check(VerificationInputSchema, input) || Buffer.byteLength(JSON.stringify(input)) > 32768) return false;
  const ids = Array.from({ length: criterionCount }, (_, i) => `criterion-${i + 1}`), used = input.checks.flatMap((check) => check.criteriaIds);
  const count = input.checks.length + input.budget.repairs;
  return isDeepStrictEqual([...used].sort(), [...ids].sort()) && isDeepStrictEqual([...input.final.criteriaIds].sort(), [...ids].sort()) &&
    new Set([...input.checks, input.final].map((check) => check.id)).size === input.checks.length + 1 &&
    [...input.checks, input.final].every((check) => check.id !== "probe" && validGoalFilePath(check.entry) && input.files.includes(check.entry) &&
      Buffer.byteLength(JSON.stringify([check.command, check.args])) <= 8192 &&
      [check.coverage, check.command, ...check.args].every((value) => goalTextBytes(value) !== null)) &&
    input.files.every(validGoalFilePath) && input.budget.runs >= input.checks.length + input.budget.repairs + 2 &&
    workers >= count && workerCalls >= count * callLimit && plannerCalls >= input.checks.length && totalCalls >= count * callLimit + input.checks.length &&
    (input.budget.repairs === 0 ? input.failureProtocol === "no_automatic_repair" : input.failureProtocol === "exit_42_assertions_only");
}
export function validVerificationGrant(input: VerificationInput, grant: unknown, scope: GoalFileScope): grant is VerificationGrant {
  return Value.Check(VerificationGrantSchema, grant) && validGoalFileScope(grant.files) && grant.files.root === scope.root &&
    isDeepStrictEqual(grant.files.rootIdentity, scope.rootIdentity) && grant.socket.path === input.socketPath &&
    isDeepStrictEqual(grant.files.files.map((file) => file.path), input.files) && grant.files.files.every((file) => file.access === "read" &&
      !scope.files.some((source) => source.access === "read_write" && (source.path === file.path || isDeepStrictEqual(source.version.identity, file.version.identity))));
}
export function checkForCriteria(input: VerificationInput, ids: readonly string[]): VerificationCheck | undefined {
  return input.checks.find((check) => isDeepStrictEqual([...check.criteriaIds].sort(), [...ids].sort()));
}
export function requestedCheck(input: VerificationInput, request: VerificationRequest): VerificationCheck | undefined {
  return request.stage === "final" ? input.final.id === request.checkId ? input.final : undefined : input.checks.find((check) => check.id === request.checkId);
}

// Only disposable canaries are tested. No real project file, credential, network endpoint or shell interpolation.
export const VERIFICATION_PROBE = 'test "$(id -u)" != 0 && test -r /jev/canary && ! (printf changed > /jev/canary) && ! (printf changed > /jev/new-file) && (printf temporary > /tmp/jev-canary) && set -- /sys/class/net/* && test "$#" = 1 && test "$1" = /sys/class/net/lo';
export const VERIFICATION_API = "/v1.47";
export const VERIFICATION_MEMORY = 256 * 1024 * 1024;
export const VERIFICATION_TMP_BYTES = 64 * 1024 * 1024;
export const object = (input: unknown): Record<string, unknown> | null => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
export function supportedVerificationEngine(input: unknown): boolean {
  const data = object(input);
  return data?.OSType === "linux" && data.CgroupVersion === "2" && data.MemoryLimit === true && data.SwapLimit === true && data.PidsLimit === true && data.CpuCfsQuota === true &&
    Array.isArray(data.SecurityOptions) && data.SecurityOptions.includes("name=seccomp,profile=builtin");
}
export function imageEnvironment(input: unknown, image: string): string[] | null {
  const data = object(input), config = object(data?.Config);
  if (data?.Id !== image || data.Os !== "linux" || !config || config.Volumes != null && Object.keys(object(config.Volumes) ?? { invalid: true }).length) return null;
  const env = config.Env ?? [];
  if (!Array.isArray(env) || env.length > 128 || env.some((value) => typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}=/.test(value))) return null;
  // Do not inherit image or host credentials, NODE_OPTIONS, proxy configuration, or Docker context.
  const names = new Set(env.map((value: string) => value.slice(0, value.indexOf("="))));
  for (const name of ["PATH", "HOME", "TMPDIR", "XDG_CACHE_HOME", "npm_config_cache"]) names.delete(name);
  return [...[...names].sort().map((name) => `${name}=`), "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp", "TMPDIR=/tmp", "XDG_CACHE_HOME=/tmp/cache", "npm_config_cache=/tmp/npm"];
}
export type VerificationMount = { Type: "bind"; Source: string; Target: string; ReadOnly: true; BindOptions: { Propagation: "rprivate" } };
export function verificationContainer(image: string, user: string, command: string, args: readonly string[], env: readonly string[], mounts: readonly VerificationMount[], labels: Record<string, string>) {
  return { Image: image, User: user, WorkingDir: "/workspace", Entrypoint: [command, "--disable-sigusr1"], Cmd: [...args], Env: [...env], Labels: { ...labels },
    AttachStdin: false, AttachStdout: false, AttachStderr: false, OpenStdin: false, Tty: false, NetworkDisabled: true,
    Healthcheck: { Test: ["NONE"] }, HostConfig: { NetworkMode: "none", PidMode: "", IpcMode: "private", CgroupnsMode: "private", Init: false,
      ReadonlyRootfs: true, Privileged: false, CapAdd: [], CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128, Memory: VERIFICATION_MEMORY, MemorySwap: VERIFICATION_MEMORY, NanoCpus: 1_000_000_000,
      Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${VERIFICATION_TMP_BYTES},mode=1777` }, Mounts: structuredClone(mounts),
      LogConfig: { Type: "none", Config: {} }, RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, AutoRemove: false,
      Devices: [], DeviceRequests: [], PortBindings: {}, PublishAllPorts: false, Links: [], ExtraHosts: [], GroupAdd: [],
    } };
}
export type VerificationContainer = ReturnType<typeof verificationContainer>;
export function matchesVerificationContainer(value: unknown, expected: VerificationContainer, id: string): boolean {
  const data = object(value), config = object(data?.Config), host = object(data?.HostConfig);
  if (!data || data.Id !== id || data.Image !== expected.Image || !config || !host) return false;
  for (const key of ["User", "WorkingDir", "Entrypoint", "Cmd", "Env", "OpenStdin", "Tty", "Healthcheck"] as const)
    if (!isDeepStrictEqual(config[key], expected[key])) return false;
  const labels = object(config.Labels);
  if (!labels || Object.entries(expected.Labels).some(([key, value]) => labels[key] !== value)) return false;
  for (const key of ["NetworkMode", "PidMode", "IpcMode", "CgroupnsMode", "Init", "ReadonlyRootfs", "Privileged", "CapDrop", "SecurityOpt", "PidsLimit", "Memory", "MemorySwap", "NanoCpus", "Tmpfs", "LogConfig", "RestartPolicy", "AutoRemove", "PublishAllPorts"] as const)
    if (!isDeepStrictEqual(host[key], expected.HostConfig[key])) return false;
  for (const key of ["CapAdd", "Devices", "DeviceRequests", "Links", "ExtraHosts", "GroupAdd", "Binds", "VolumesFrom"])
    if (host[key] != null && (!Array.isArray(host[key]) || host[key].length !== 0)) return false;
  if (host.PortBindings != null && Object.keys(object(host.PortBindings) ?? { invalid: true }).length !== 0) return false;
  const mounts = data.Mounts;
  if (!Array.isArray(mounts) || mounts.filter((value) => object(value)?.Type === "bind").length !== expected.HostConfig.Mounts.length ||
    mounts.filter((value) => object(value)?.Type === "tmpfs").length > 1 || mounts.some((value) => {
      const seen = object(value); return seen?.Type !== "bind" && !(seen?.Type === "tmpfs" && seen.Destination === "/tmp" && seen.RW === true);
    })) return false;
  return expected.HostConfig.Mounts.every((mount) => mounts.some((value) => { const seen = object(value); return seen?.Type === "bind" && seen.Source === mount.Source && seen.Destination === mount.Target && seen.RW === false && seen.Propagation === "rprivate"; }));
}

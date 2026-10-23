import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { GoalDigestSchema } from "./goal-machine.ts";

export const MAX_GOAL_FILES = 16;
export const MAX_GOAL_FILE_BYTES = 32 * 1_024;
export const MAX_GOAL_FILES_BYTES = 128 * 1_024;
export const MAX_GOAL_FILE_OPERATIONS = 64;
export const GOAL_FILES_ERROR = "Goal file access stopped: invalid permission, changed file, limit, cancellation, or I/O failure. No retry or rollback.";
const closed = { additionalProperties: false } as const;
const id = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const text = Type.String({ maxLength: MAX_GOAL_FILE_BYTES });
const spec = { path: Type.String({ minLength: 1, maxLength: 512 }), access: Type.Union([Type.Literal("read"), Type.Literal("read_write")]) };
export const GoalFileInputSchema = Type.Object({ cwd: Type.String({ minLength: 1, maxLength: 4_096 }),
  files: Type.Array(Type.Object(spec, closed), { minItems: 1, maxItems: MAX_GOAL_FILES }) }, closed);
// POSIX numeric inode, or lossless NTFS 64-bit file-index encoding. Never round a native ID
// through JavaScript Number or substitute an invented UID/inode to make Windows pass.
export const FileIdentitySchema = Type.Object({ dev: integer,
  ino: Type.Union([integer, Type.String({ pattern: "^ntfs:[a-f0-9]{16}$" })]) }, closed);
export const GoalFileVersionSchema = Type.Object({ identity: FileIdentitySchema, stamp: GoalDigestSchema,
  digest: GoalDigestSchema, bytes: Type.Integer({ minimum: 0, maximum: MAX_GOAL_FILE_BYTES }) }, closed);
export const GoalFileScopeSchema = Type.Object({ id, root: Type.String({ minLength: 1, maxLength: 4_096 }), rootIdentity: FileIdentitySchema,
  files: Type.Array(Type.Object({ id, ...spec, version: GoalFileVersionSchema }, closed), { minItems: 1, maxItems: MAX_GOAL_FILES }) }, closed);
export const GoalFileRequestSchema = Type.Union([
  Type.Object({ id, fileId: id, action: Type.Literal("read") }, closed),
  Type.Object({ id, fileId: id, action: Type.Literal("write"), text }, closed),
  Type.Object({ id, fileId: id, action: Type.Literal("edit"), oldText: Type.String({ minLength: 1, maxLength: MAX_GOAL_FILE_BYTES }), newText: text }, closed),
]);
export type GoalFileInput = Static<typeof GoalFileInputSchema>;
export type FileIdentity = Static<typeof FileIdentitySchema>;
export type GoalFileVersion = Static<typeof GoalFileVersionSchema>;
export type GoalFileScope = Static<typeof GoalFileScopeSchema>;
export type GoalFileRequest = Static<typeof GoalFileRequestSchema>;
export type GoalFile = GoalFileScope["files"][number];

/** Defense in depth, not a detector for secrets embedded in arbitrary source files. */
function protectedName(value: string): boolean {
  const forbidden = [".git", ".pi", "node_modules", ".ssh", ".aws", ".gnupg", "agents.md", "agents.override.md", "claude.md", "system.md", "append_system.md", "auth.json", "models.json", ".npmrc", "goal.jsonl", "owner.lock", ".jev-goal.lock", ".jev-memory.jsonl", ".jev-context-application.jsonl"];
  return value.split(/[\\/]/).some((part) => part.toLowerCase().startsWith(".env") || forbidden.includes(part.toLowerCase()));
}
export function validGoalFilePath(value: string): boolean {
  return !!value && value.length <= 512 && !/[\\\u0000-\u001f\u007f]/.test(value) && !protectedName(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
// Deterministic fingerprint only, never a permission token or signature.
export function goalFileDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function goalTextBytes(value: string): number {
  if (value.length > MAX_GOAL_FILE_BYTES || value.includes("\0") || Buffer.from(value, "utf8").toString("utf8") !== value) throw new Error(GOAL_FILES_ERROR);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_GOAL_FILE_BYTES) throw new Error(GOAL_FILES_ERROR);
  return bytes;
}
// Syntax only, not a filesystem/identity grant. Native Windows effects attest SID/DACL and paths.
function absoluteGoalRoot(value: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/")) return !value.includes("\\");
  return /^[A-Za-z]:[\\/](?![\\/])/.test(value) && value.slice(3).split(/[\\/]/).every(part =>
    !!part && part !== "." && part !== ".." && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part));
}
export function validGoalFileInput(input: unknown): input is GoalFileInput {
  return Value.Check(GoalFileInputSchema, input) && absoluteGoalRoot(input.cwd) && !protectedName(input.cwd) &&
    input.files.every((file) => validGoalFilePath(file.path)) && new Set(input.files.map((file) => file.path)).size === input.files.length;
}
export function validGoalFileScope(scope: unknown): scope is GoalFileScope {
  return Value.Check(GoalFileScopeSchema, scope) && validGoalFileInput({ cwd: scope.root, files: scope.files.map(({ path, access }) => ({ path, access })) }) &&
    new Set(scope.files.map((file) => file.id)).size === scope.files.length &&
    new Set(scope.files.map((file) => `${file.version.identity.dev}:${file.version.identity.ino}`)).size === scope.files.length &&
    scope.files.reduce((sum, file) => sum + file.version.bytes, 0) <= MAX_GOAL_FILES_BYTES;
}
export function validGoalFileRequest(request: unknown): request is GoalFileRequest {
  if (!Value.Check(GoalFileRequestSchema, request)) return false;
  try {
    if (request.action === "write") goalTextBytes(request.text);
    if (request.action === "edit") { goalTextBytes(request.oldText); goalTextBytes(request.newText); }
    return true;
  } catch { return false; }
}
/** Exact unique replacement only: no fuzzy match, path inference, shell, or file creation. */
export function goalFileReplacement(current: string, request: Exclude<GoalFileRequest, { action: "read" }>): string {
  let result = request.action === "write" ? request.text : current;
  if (request.action === "edit") {
    const index = current.indexOf(request.oldText);
    if (!request.oldText || index < 0 || current.indexOf(request.oldText, index + 1) >= 0) throw new Error(GOAL_FILES_ERROR);
    result = current.slice(0, index) + request.newText + current.slice(index + request.oldText.length);
  }
  goalTextBytes(result);
  return result;
}

type Progress = { readonly scope: GoalFileScope; readonly operations: number; readonly requestIds: readonly string[];
  readonly readBytes: number; readonly writtenBytes: number; readonly changed: boolean; readonly uncertain: boolean };
export type GoalFilesState =
  | { readonly status: "idle" }
  | ({ readonly status: "awaiting_approval" | "ready" } & Progress)
  | ({ readonly status: "operating"; readonly request: GoalFileRequest } & Progress)
  | ({ readonly status: "draining"; readonly outcome: "failed" | "cancelled"; readonly request: GoalFileRequest } & Progress)
  | { readonly status: "failed"; readonly progress: Progress | null; readonly error?: string }
  | { readonly status: "cancelled"; readonly progress: Progress | null; readonly error?: string }
  | { readonly status: "closed"; readonly progress: Progress | null; readonly error?: string };
const GoalFileReplySchema = Type.Union([
  Type.Object({ action: Type.Literal("read"), text }, closed),
  Type.Object({ action: Type.Union([Type.Literal("write"), Type.Literal("edit")]), bytes: Type.Integer({ minimum: 0, maximum: MAX_GOAL_FILE_BYTES }) }, closed),
]);
export type GoalFileReply = Static<typeof GoalFileReplySchema>;
export type GoalFilesEffect =
  | { readonly type: "file_io"; readonly scope: GoalFileScope; readonly request: GoalFileRequest }
  | { readonly type: "abort_file_io"; readonly scopeId: string; readonly requestId: string }
  | { readonly type: "file_reply"; readonly scopeId: string; readonly requestId: string; readonly reply: GoalFileReply };
export type GoalFileIoEffect = Extract<GoalFilesEffect, { type: "file_io" }>;
export type GoalFileIoEvent =
  | { readonly type: "file_done"; readonly scopeId: string; readonly requestId: string; readonly version: GoalFileVersion; readonly reply: GoalFileReply }
  | { readonly type: "file_failed"; readonly scopeId: string; readonly requestId: string; readonly cancelled: boolean; readonly mayHaveWritten: boolean };
export type GoalFilesEvent = GoalFileIoEvent
  | { readonly type: "start"; readonly scope: GoalFileScope }
  | { readonly type: "approval"; readonly scopeId: string; readonly approved: boolean }
  | { readonly type: "request"; readonly scopeId: string; readonly request: GoalFileRequest }
  | { readonly type: "cancel" | "close" };
export type GoalFilesTransition = { readonly state: GoalFilesState; readonly effects: readonly GoalFilesEffect[] };
const stopped = (status: "failed" | "cancelled" | "closed", progress: Progress | null): GoalFilesTransition =>
  ({ state: { status, progress, ...(status === "failed" ? { error: GOAL_FILES_ERROR } : {}) }, effects: [] });
const progressOf = (state: Progress): Progress => ({ scope: state.scope, operations: state.operations, requestIds: state.requestIds,
  readBytes: state.readBytes, writtenBytes: state.writtenBytes, changed: state.changed, uncertain: state.uncertain });

/** Invocation-local file permission machine. Approval events are trusted-host input, not a model API. */
export function reduceGoalFiles(state: GoalFilesState, event: GoalFilesEvent): GoalFilesTransition {
  const unchanged = { state, effects: [] };
  if (state.status === "failed" || state.status === "cancelled" || state.status === "closed") return unchanged;
  const progress = state.status === "idle" ? null : progressOf(state);
  try {
    if (event.type === "cancel" || event.type === "close") {
      if (state.status === "draining") return event.type === "cancel" ? { state: { ...state, outcome: "cancelled" }, effects: [] } : unchanged;
      if (state.status === "operating") return { state: { ...state, status: "draining", outcome: "cancelled" }, effects: [
        { type: "abort_file_io", scopeId: state.scope.id, requestId: state.request.id }] };
      return stopped(event.type === "cancel" ? "cancelled" : "closed", progress);
    }
    if (state.status === "idle") {
      if (event.type !== "start") return unchanged;
      if (!validGoalFileScope(event.scope)) return stopped("failed", null);
      return { state: { status: "awaiting_approval", scope: structuredClone(event.scope), operations: 0,
        requestIds: [], readBytes: 0, writtenBytes: 0, changed: false, uncertain: false }, effects: [] };
    }
    if (state.status === "awaiting_approval" && event.type === "approval") {
      if (event.scopeId !== state.scope.id) return unchanged;
      return event.approved === true ? { state: { ...state, status: "ready" }, effects: [] } : stopped("cancelled", progress);
    }
    if (state.status === "ready" && event.type === "request") {
      if (event.scopeId !== state.scope.id) return unchanged;
      if (!validGoalFileRequest(event.request) || state.operations >= MAX_GOAL_FILE_OPERATIONS || state.requestIds.includes(event.request.id)) return stopped("failed", progress);
      const file = state.scope.files.find((file) => file.id === event.request.fileId);
      if (!file || (event.request.action !== "read" && file.access !== "read_write")) return stopped("failed", progress);
      return { state: { ...state, status: "operating", operations: state.operations + 1,
        requestIds: [...state.requestIds, event.request.id], request: structuredClone(event.request) }, effects: [
        { type: "file_io", scope: structuredClone(state.scope), request: structuredClone(event.request) }] };
    }
    if ((state.status === "operating" || state.status === "draining") && (event.type === "file_done" || event.type === "file_failed")) {
      if (event.scopeId !== state.scope.id || event.requestId !== state.request.id) return unchanged;
      if (event.type === "file_failed") {
        if (typeof event.cancelled !== "boolean" || typeof event.mayHaveWritten !== "boolean") throw new Error(GOAL_FILES_ERROR);
        return stopped(state.status === "draining" ? state.outcome : event.cancelled ? "cancelled" : "failed",
          { ...progress!, uncertain: state.uncertain || event.mayHaveWritten });
      }
      const file = state.scope.files.find((file) => file.id === state.request.fileId);
      if (!file || !Value.Check(GoalFileVersionSchema, event.version) || !isDeepStrictEqual(file.version.identity, event.version.identity) ||
          !Value.Check(GoalFileReplySchema, event.reply) || event.reply.action !== state.request.action) throw new Error(GOAL_FILES_ERROR);
      if (event.reply.action === "read") {
        if (!isDeepStrictEqual(file.version, event.version) || goalTextBytes(event.reply.text) !== event.version.bytes || goalFileDigest(event.reply.text) !== file.version.digest) throw new Error(GOAL_FILES_ERROR);
      } else {
        const request = state.request;
        if (request.action === "read") throw new Error(GOAL_FILES_ERROR);
        const expectedBytes = request.action === "write" ? goalTextBytes(request.text) : file.version.bytes - goalTextBytes(request.oldText) + goalTextBytes(request.newText);
        if (event.reply.bytes !== event.version.bytes || event.reply.bytes !== expectedBytes ||
            (request.action === "write" && goalFileDigest(request.text) !== event.version.digest)) throw new Error(GOAL_FILES_ERROR);
      }
      const scope = { ...state.scope, files: state.scope.files.map((entry) => entry.id === file.id ? { ...entry, version: structuredClone(event.version) } : entry) };
      if (!validGoalFileScope(scope)) throw new Error(GOAL_FILES_ERROR);
      const next: Progress = { ...progress!, scope, readBytes: state.readBytes + (event.reply.action === "read" ? event.version.bytes : 0),
        writtenBytes: state.writtenBytes + (event.reply.action === "read" ? 0 : event.version.bytes), changed: state.changed || event.reply.action !== "read" };
      if (state.status === "draining") return stopped(state.outcome, next); // Preserve accounting, suppress late content.
      return { state: { status: "ready", ...next }, effects: [{ type: "file_reply", scopeId: scope.id,
        requestId: state.request.id, reply: structuredClone(event.reply) }] };
    }
    return unchanged;
  } catch {
    if (state.status === "operating") return { state: { ...state, status: "draining", outcome: "failed", uncertain: true }, effects: [
      { type: "abort_file_io", scopeId: state.scope.id, requestId: state.request.id }] };
    if (state.status === "draining") return unchanged;
    return stopped("failed", progress);
  }
}

import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalDirectory } from "./goal-run-effects.ts";
import { openMemoryFileLease, type MemoryFileLease } from "./project-memory-files.ts";
import { MEMORY_DB, MEMORY_JOURNAL, MEMORY_LOCK, MEMORY_MAX_FACTS, memoryDigest, validMemoryInput, validMemoryState,
  type MemoryState, type ProjectMemoryInput } from "./project-memory.ts";

const APP_ID = 1246058061;
type MemoryDatabase = Pick<DatabaseSync, "prepare" | "exec" | "close">;
const ddl = [
  "CREATE TABLE memory_meta (id INTEGER PRIMARY KEY CHECK(id=1), project_key TEXT NOT NULL, revision INTEGER NOT NULL) STRICT",
  "CREATE TABLE memory_facts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, provenance TEXT NOT NULL, created_revision INTEGER NOT NULL) STRICT",
  "CREATE TABLE memory_edges (from_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE, to_id TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE, PRIMARY KEY(from_id,to_id), CHECK(from_id<to_id)) STRICT",
];
export type MemoryRead = { readonly state: MemoryState; readonly token: string; readonly directory: string };
export class ProjectMemoryError extends Error {
  readonly stage: "storage" | "changed" | "invalid";
  readonly application: "not_applied" | "unknown";
  constructor(stage: "storage" | "changed" | "invalid", application: "not_applied" | "unknown" = "not_applied") {
    super("Project memory operation refused or unconfirmed. No retry or rollback claim; preserve remaining files and locks.");
    this.stage = stage; this.application = application;
  }
}
const refuse = (stage: "storage" | "changed" | "invalid" = "storage", application: "not_applied" | "unknown" = "not_applied"): never => { throw new ProjectMemoryError(stage, application); };
/** Private test seam only; never a caller-provided lease, identity or directory permission. */
export const projectMemoryStoreIO = { canonical: canonicalDirectory, lease: openMemoryFileLease };
async function identity(file: string) {
  const info = await lstat(file);
  if (info.isSymbolicLink()) refuse();
  return { dev: info.dev, ino: info.ino, bytes: info.size };
}
async function rootIdentity(directory: string) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) return refuse();
  return { dev: info.dev.toString(), ino: info.ino.toString() };
}
async function token(directory: string, state: MemoryState): Promise<string> {
  const root = await rootIdentity(directory);
  return `${root.dev}:${root.ino}:${memoryDigest({ state, directory, root, db: await identity(path.join(directory, MEMORY_DB)), journal: await identity(path.join(directory, MEMORY_JOURNAL)) })}`;
}
export async function probeMemoryCreation(directory: string, signal?: AbortSignal): Promise<{ directory: string; token: string }> {
  try {
    const root = await projectMemoryStoreIO.canonical(directory, true, signal);
    for (const name of [MEMORY_DB, MEMORY_JOURNAL, MEMORY_LOCK, `${MEMORY_DB}-wal`, `${MEMORY_DB}-shm`]) {
      try { await lstat(path.join(root, name)); return refuse("changed"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    signal?.throwIfAborted(); const rootInfo = await rootIdentity(root);
    return { directory: root, token: `${rootInfo.dev}:${rootInfo.ino}:${memoryDigest({ directory: root, root: rootInfo, absent: true })}` };
  } catch { return refuse(); }
}
function load(db: MemoryDatabase, projectKey: string): MemoryState {
  const app = db.prepare("PRAGMA application_id").get(), version = db.prepare("PRAGMA user_version").get(), page = db.prepare("PRAGMA page_size").get();
  if (app?.application_id !== APP_ID || version?.user_version !== 1 || page?.page_size !== 4096) return refuse("invalid");
  const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if (schema.length !== ddl.length || !schema.every(row => ddl.includes(String(row.sql)))) return refuse("invalid");
  const meta = db.prepare("SELECT project_key, revision FROM memory_meta WHERE id=1").get();
  if (meta?.project_key !== projectKey || typeof meta.revision !== "number") return refuse("invalid");
  const state = { version: 1, projectKey, revision: meta.revision,
    facts: db.prepare("SELECT id,kind,title,content,provenance,created_revision AS createdRevision FROM memory_facts ORDER BY id").all(),
    edges: db.prepare("SELECT from_id AS 'from',to_id AS 'to' FROM memory_edges ORDER BY from_id,to_id").all() };
  if (!validMemoryState(state)) return refuse("invalid");
  return state;
}
async function database(directory: string, readonly: boolean): Promise<MemoryDatabase> {
  let db: MemoryDatabase;
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite" as string);
    const native = new Database(path.join(directory, MEMORY_DB), { readonly, create: !readonly, strict: true });
    // Cached native queries finalize on close; Bun's Node shim defers statement release until GC.
    // Bun exposes no DQS switch; reject quotes in fixed SQL while leaving bound user data untouched.
    const sql = (text: string) => { if (text.includes('"')) return refuse("invalid"); return text; };
    db = { prepare: text => native.query(sql(text)), exec: text => { native.exec(sql(text)); }, close: () => native.close(true) };
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(path.join(directory, MEMORY_DB), { readOnly: readonly, allowExtension: false, enableDoubleQuotedStringLiterals: false, enableForeignKeyConstraints: true });
  }
  try { db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON"); return db; }
  catch { db.close(); return refuse(); }
}
export async function readProjectMemory(directory: string, projectKey: string, signal?: AbortSignal): Promise<MemoryRead> {
  if (!/^[a-f0-9]{64}$/.test(projectKey)) return refuse("invalid");
  let lease: MemoryFileLease | undefined, db: MemoryDatabase | undefined, answer: MemoryRead | undefined, clean = false;
  try {
    lease = await projectMemoryStoreIO.lease(directory, "read", signal); await lease.check();
    db = await database(lease.directory, true); db.exec("BEGIN");
    const state = load(db, projectKey); db.exec("COMMIT"); db.close(); db = undefined;
    signal?.throwIfAborted(); await lease.check(); answer = { state, directory: lease.directory, token: await token(lease.directory, state) };
  } catch { /* Raw SQL/filesystem data never becomes a tool error. */ }
  finally { try { db?.close(); clean = lease ? await lease.close(false) : false; } catch { clean = false; } }
  return answer && clean ? answer : refuse();
}
type Mutation = Extract<ProjectMemoryInput, { operation: "create" | "remember" | "forget" }>;
/** Exact native approval belongs to the caller. This effect alone is never an execution grant. */
export async function mutateProjectMemory(input: Mutation, projectKey: string, expectedToken: string, signal?: AbortSignal): Promise<MemoryRead & { readonly id?: string }> {
  if (!validMemoryInput(input) || !/^[a-f0-9]{64}$/.test(projectKey) || !/^[0-9]+:[0-9]+:[a-f0-9]{64}$/.test(expectedToken)) return refuse("invalid");
  input = structuredClone(input);
  let lease: MemoryFileLease | undefined, db: MemoryDatabase | undefined, keep = false, applied = false, ownerAttempted = false;
  let answer: (MemoryRead & { id?: string }) | undefined, failure: ProjectMemoryError | undefined, clean = false;
  try {
    if (input.operation === "create") { const current = await probeMemoryCreation(input.directory, signal); if (current.token !== expectedToken) return refuse("changed"); }
    const [dev, ino] = expectedToken.split(":"); ownerAttempted = true;
    if (input.operation === "create") keep = true;
    lease = await projectMemoryStoreIO.lease(input.directory, input.operation === "create" ? "create" : "write", signal, { dev: dev!, ino: ino! });
    await lease.check(); db = await database(lease.directory, false);
    let state: MemoryState;
    if (input.operation === "create") state = { version: 1, projectKey, revision: 0, facts: [], edges: [] };
    else {
      state = load(db, projectKey);
      if (state.revision !== input.expectedRevision || await token(lease.directory, state) !== expectedToken) return refuse("changed");
      if (input.operation === "forget" && !state.facts.some(fact => fact.id === input.id)) return refuse("changed");
      if (input.operation === "remember" && (state.facts.length >= MEMORY_MAX_FACTS || input.record.relatedIds.some(id => !state.facts.some(fact => fact.id === id)))) return refuse("invalid");
    }
    signal?.throwIfAborted();
    const id = input.operation === "remember" ? `fact_${randomUUID().replaceAll("-", "")}` : undefined;
    if (input.operation === "remember") {
      const next: MemoryState = { ...state, revision: state.revision + 1,
        facts: [...state.facts, { id: id!, kind: input.record.kind, title: input.record.title, content: input.record.content, provenance: input.record.provenance, createdRevision: state.revision + 1 }],
        edges: [...state.edges, ...input.record.relatedIds.map(other => id! < other ? { from: id!, to: other } : { from: other, to: id! })] };
      if (!validMemoryState(next)) return refuse("invalid");
    }
    if (!Number.isSafeInteger(state.revision + 1)) return refuse("invalid");
    keep = true;
    if (input.operation === "create") db.exec("PRAGMA page_size=4096");
    db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA max_page_count=1024; BEGIN IMMEDIATE");
    if (input.operation === "create") {
      for (const sql of ddl) db.exec(sql);
      db.prepare("INSERT INTO memory_meta VALUES(1,?,0)").run(projectKey);
      db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1`);
    } else if (input.operation === "remember") {
      db.prepare("INSERT INTO memory_facts VALUES(?,?,?,?,?,?)").run(id!, input.record.kind, input.record.title, input.record.content, input.record.provenance, state.revision + 1);
      const link = db.prepare("INSERT INTO memory_edges VALUES(?,?)");
      for (const other of input.record.relatedIds) link.run(...(id! < other ? [id!, other] : [other, id!]));
      db.prepare("UPDATE memory_meta SET revision=revision+1 WHERE id=1 AND revision=?").run(state.revision);
    } else {
      db.prepare("DELETE FROM memory_facts WHERE id=?").run(input.id);
      db.prepare("UPDATE memory_meta SET revision=revision+1 WHERE id=1 AND revision=?").run(state.revision);
    }
    db.exec("COMMIT"); applied = true;
    const result = load(db, projectKey); db.close(); db = undefined;
    for (const name of [MEMORY_DB, MEMORY_JOURNAL]) { const handle = await open(path.join(lease.directory, name), "r+"); try { await handle.sync(); } finally { await handle.close(); } }
    await lease.check(); answer = { state: result, directory: lease.directory, token: await token(lease.directory, result), ...(id ? { id } : {}) }; keep = false;
  } catch (error) { failure = error instanceof ProjectMemoryError ? error : new ProjectMemoryError("storage", keep || applied ? "unknown" : "not_applied"); }
  finally {
    try { db?.close(); } catch { keep = true; }
    try { clean = lease ? await lease.close(keep) : false; } catch { clean = false; }
  }
  if (answer && clean && !keep) return answer;
  return refuse(failure?.stage, failure?.application === "unknown" || !clean && (applied || keep || ownerAttempted) ? "unknown" : "not_applied");
}

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { ExecutionSecondsSchema, ModelCallLimitSchema, RunSchema, type Run } from "./delegate-machine.ts";
import { GoalContextFileSchema } from "./goal-run.ts";
import { AGENT_NAME_PATTERN, LIMITS } from "./machine.ts";
import { englishModelData } from "./internal-language.ts";
import { goalFileDigest } from "./goal-files.ts";

const closed = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
const agentName = Type.String({ minLength: 1, maxLength: 64, pattern: AGENT_NAME_PATTERN });
const stamp = Type.String({ pattern: "^[a-f0-9]{64}$" });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const ApprovalPolicySchema = Type.Object({ version: Type.Literal(1), approval: Type.Object({ level: Type.Union([Type.Literal("balanced"), Type.Literal("strict")]) }, closed) }, closed);
export type ApprovalPolicy = Static<typeof ApprovalPolicySchema>;
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { version: 1, approval: { level: "balanced" } };
export const ParallelReadInputSchema = Type.Object({ task: Type.String({ minLength: 1, maxLength: LIMITS.task }),
  tasks: Type.Array(Type.Object({ id, agent: agentName, summary: Type.String({ minLength: 1, maxLength: LIMITS.task }) }, closed), { minItems: 1, maxItems: 3 }),
  limits: Type.Object({ seconds: ExecutionSecondsSchema, modelCalls: Type.Optional(ModelCallLimitSchema), perWorkerCalls: Type.Optional(ModelCallLimitSchema) }, closed),
}, { ...closed, description: "Decide the independent read-only split/count through ordinary JEV advice/planning before constructing tasks. Exact-approved task count determines concurrent lanes (1..3); three is only an internal safety ceiling. No extra width/planner request once the catalog is fixed; the pool makes no JEV decision. Fixed profiles, read/grep/find/ls only; ordinary permissions, not a file-ID sandbox. Operator config selects balanced (one complete batch review, default) or strict (ALL per-task reviews before any child); decline launches none. No writes, retries, memory, dependencies or restored approval." });
export type ParallelReadInput = Static<typeof ParallelReadInputSchema>;
export const ParallelReadTargetSchema = Type.Object({ api: Type.String({ minLength: 1, maxLength: 128 }), endpoint: Type.String({ minLength: 1, maxLength: 2048 }) }, closed);
export const ParallelReadPreparedSchema = Type.Object({ id, sessionId: Type.String({ minLength: 1, maxLength: 128 }), cwd: Type.String({ minLength: 1, maxLength: 4096 }),
  agentDirectory: Type.String({ minLength: 1, maxLength: 4096 }), input: ParallelReadInputSchema, policy: ApprovalPolicySchema, policyVersion: stamp,
  context: Type.Array(GoalContextFileSchema, { maxItems: 128 }), tasks: Type.Array(Type.Object({ id, run: RunSchema, target: ParallelReadTargetSchema }, closed), { minItems: 1, maxItems: 3 }),
}, closed);
export type ParallelReadPrepared = Static<typeof ParallelReadPreparedSchema>;
export const ParallelReadWorkerInputSchema = Type.Object({ version: Type.Literal(1), run: RunSchema, context: Type.Array(GoalContextFileSchema, { maxItems: 128 }),
  approvedAt: count, deadline: count, policyVersion: stamp, target: ParallelReadTargetSchema }, closed);
export type ParallelReadWorkerInput = Static<typeof ParallelReadWorkerInputSchema>;
export function parallelReadTask(task: string, summary: string): string { return `Approved overall task (data):\n${task}\n\nThis independent read-only task:\n${summary}`; }
export function validParallelReadInput(value: unknown): value is ParallelReadInput {
  try {
    if (!Value.Check(ParallelReadInputSchema, value) || !value.task.trim() || new Set(value.tasks.map(task => task.id)).size !== value.tasks.length ||
      !value.tasks.every(task => task.summary.trim() && parallelReadTask(value.task, task.summary).length <= LIMITS.task) || !englishModelData(value)) return false;
    const shared = value.limits.modelCalls, per = value.limits.perWorkerCalls;
    return shared == null || per != null && Number.isSafeInteger(per * value.tasks.length) && per * value.tasks.length <= shared;
  } catch { return false; }
}
export function validReadOnlyRun(value: unknown): value is Run {
  try { return Value.Check(RunSchema, value) && path.isAbsolute(value.cwd) && path.isAbsolute(value.agent.file) && value.solPi === undefined && value.verification === undefined && value.acceptanceCriteria === undefined &&
    value.agent.tools.length > 0 && value.agent.tools.every(tool => READ_ONLY_TOOLS.includes(tool as typeof READ_ONLY_TOOLS[number])) && englishModelData({ task: value.task, description: value.agent.description, systemPrompt: value.agent.systemPrompt }); }
  catch { return false; }
}
function validTarget(target: Static<typeof ParallelReadTargetSchema>): boolean {
  try {
    const url = new URL(target.endpoint);
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}
export function validParallelReadPrepared(value: unknown): value is ParallelReadPrepared {
  try {
    if (!Value.Check(ParallelReadPreparedSchema, value) || !validParallelReadInput(value.input) || value.tasks.length !== value.input.tasks.length) return false;
    return value.tasks.every((task, index) => {
      const declared = value.input.tasks[index]!;
      if (task.id !== declared.id || task.run.agent.name !== declared.agent || task.run.cwd !== value.cwd || !validReadOnlyRun(task.run) ||
        path.dirname(path.dirname(task.run.agent.file)) !== value.agentDirectory ||
        task.run.seconds !== value.input.limits.seconds || task.run.maxModelCalls !== (value.input.limits.perWorkerCalls ?? null) ||
        task.run.task !== parallelReadTask(value.input.task, declared.summary) || !isDeepStrictEqual(task.run.model, task.run.agent.model)) return false;
      return validTarget(task.target);
    });
  } catch { return false; }
}
export function parallelReadDigest(prepared: ParallelReadPrepared): string { return goalFileDigest(JSON.stringify(prepared)); }
export function validParallelReadWorker(value: unknown): value is ParallelReadWorkerInput {
  return Value.Check(ParallelReadWorkerInputSchema, value) && validReadOnlyRun(value.run) && validTarget(value.target) && value.deadline > value.approvedAt &&
    value.deadline - value.approvedAt <= (value.run.seconds ?? 0) * 1000;
}

export type ParallelObservation = { readonly outcome: "completed" | "failed" | "cancelled"; readonly started: boolean;
  readonly modelCalls: number | null; readonly accountingComplete: boolean; readonly cleanupConfirmed: boolean; readonly observedUsd: number | null };
export type ParallelLedger = { readonly stopped: boolean; readonly approvedAt: number; readonly deadline: number; readonly peak: number; readonly maximum: number;
  readonly rows: readonly { readonly id: string; readonly phase: "queued" | "running" | "settled"; readonly reservation: number | null; readonly observation?: ParallelObservation }[] };
export function startParallelLedger(prepared: ParallelReadPrepared, approvedAt: number): ParallelLedger {
  if (!validParallelReadPrepared(prepared) || !Number.isSafeInteger(approvedAt) || approvedAt < 0 || !Number.isSafeInteger(approvedAt + prepared.input.limits.seconds * 1000)) throw new Error("Invalid read-only batch ledger.");
  return { stopped: false, approvedAt, deadline: approvedAt + prepared.input.limits.seconds * 1000, peak: 0, maximum: prepared.tasks.length,
    rows: prepared.tasks.map(task => ({ id: task.id, phase: "queued", reservation: task.run.maxModelCalls })) };
}
export function reserveParallelTask(state: ParallelLedger, id: string, now: number): ParallelLedger {
  const active = state.rows.filter(row => row.phase === "running").length;
  if (state.stopped || !Number.isSafeInteger(now) || now < state.approvedAt || now >= state.deadline || active >= state.maximum || !state.rows.some(row => row.id === id && row.phase === "queued"))
    return { ...state, stopped: true };
  return { ...state, peak: Math.max(state.peak, active + 1), rows: state.rows.map(row => row.id === id ? { ...row, phase: "running" } : row) };
}
export function observeParallelTask(state: ParallelLedger, id: string, observation: ParallelObservation): ParallelLedger {
  const row = state.rows.find(row => row.id === id && row.phase === "running");
  if (!row || observation.modelCalls !== null && row.reservation !== null && observation.modelCalls > row.reservation || observation.modelCalls !== null && (!Number.isSafeInteger(observation.modelCalls) || observation.modelCalls < 0) ||
    observation.observedUsd !== null && (!Number.isFinite(observation.observedUsd) || observation.observedUsd < 0) ||
    !observation.started && observation.modelCalls !== 0 || observation.outcome === "completed" && (!observation.started || observation.modelCalls === null || observation.modelCalls < 1 || !observation.accountingComplete || !observation.cleanupConfirmed)) return { ...state, stopped: true };
  return { ...state, stopped: state.stopped || observation.outcome !== "completed" || !observation.accountingComplete || !observation.cleanupConfirmed,
    rows: state.rows.map(row => row.id === id ? { ...row, phase: "settled", observation: structuredClone(observation) } : row) };
}
export function parallelLedgerMetrics(state: ParallelLedger) {
  let modelCalls: number | null = 0, reserved: number | null = 0, observedUsd = 0, costKnown = true;
  for (const row of state.rows) {
    const value = row.observation;
    if (row.phase === "queued") continue;
    if (value?.modelCalls == null || modelCalls === null || !Number.isSafeInteger(modelCalls + value.modelCalls)) modelCalls = null;
    else modelCalls += value.modelCalls;
    if (!value?.accountingComplete) {
      if (row.reservation === null || reserved === null || !Number.isSafeInteger(reserved + row.reservation)) reserved = null;
      else reserved += row.reservation;
    }
    if (!value || value.observedUsd === null || !value.accountingComplete) costKnown = false;
    if (value?.observedUsd !== null && value?.observedUsd !== undefined) {
      if (Number.isFinite(observedUsd + value.observedUsd)) observedUsd += value.observedUsd; else costKnown = false;
    }
  }
  return { modelCalls, reservedModelCalls: reserved, observedUsd, totalUsd: costKnown ? observedUsd : null,
    cleanupConfirmed: state.rows.every(row => row.phase === "queued" || row.phase === "settled" && row.observation?.cleanupConfirmed === true) };
}
/** Default rows project only finite public counters, never profile source, task text or model claims. */
export function parallelReadText(value: unknown): string {
  const fallback = "JEV · Read-only batch / inspect state; private data withheld";
  try {
    if (!value || typeof value !== "object") return fallback;
    const own = (key: string) => { const data: unknown = Object.getOwnPropertyDescriptor(value, key)?.value; return typeof data === "number" || typeof data === "string" ? data : undefined; };
    const number = (key: string, maximum: number) => { const data = own(key); return typeof data === "number" && Number.isSafeInteger(data) && data >= 0 && data <= maximum ? data : "unknown"; };
    if (own("kind") === "parallel_read_progress") return `JEV · Read-only fanout · active ${number("active", 3)}/${number("maximum", 3)} catalog lanes · settled ${number("settled", 3)}`;
    const status = own("status");
    if (own("kind") !== "parallel_read" || status !== "completed_unverified" && status !== "stopped") return fallback;
    return `JEV · Read-only batch · ${status}\nTasks attempted ${number("attemptedTasks", 3)} · peak ${number("peakActiveTasks", 3)} · reviews ${number("approvals", 3)} · SDK ${number("modelCalls", Number.MAX_SAFE_INTEGER)}\nRead-only profile permissions, not a sandbox. Findings remain unverified.`;
  } catch { return fallback; }
}

import { constants, type BigIntStats } from "node:fs";
import type { FullAccessLease } from "./delegation-access-effects.ts";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { canConfirmContextPacket, confirmContextPacket } from "./context-approval.ts";
import { canonicalDirectory, canonicalOrdinaryDirectories, contextSnapshot, checkGoalContext, loadGoalProfile, runGoalProcess } from "./goal-run-effects.ts";
import { goalFileDigest } from "./goal-files.ts";
import { WorkerReplySchema, type WorkerReply, type WorkerReport } from "./delegate-machine.ts";
import { taskReviewContent, humanLiteral } from "./task-review-machine.ts";
import { ApprovalPolicySchema, DEFAULT_APPROVAL_POLICY, parallelReadTask, validParallelReadInput,
  validParallelReadPrepared, validReadOnlyRun, parallelReadDigest, startParallelLedger, reserveParallelTask, observeParallelTask, parallelLedgerMetrics,
  type ApprovalPolicy, type ParallelReadInput, type ParallelReadPrepared, type ParallelLedger, type ParallelReadWorkerInput } from "./parallel-read.ts";
import type { GoalContextFile } from "./goal-run.ts";
import type { WorkerProgressObserver } from "./worker-progress.ts";
import type { ApprovalUiObserver } from "./approval-ui-diagnostics.ts";
import { DirectoryValidationError, directoryError, directoryPreparationIssues } from "./directory-diagnostics.ts";

export const PARALLEL_READ_ERROR = "Read-only batch stopped: invalid/changed scope, policy, approval or accounting. No automatic retry, wider permission or fallback.";
const fail = (): never => { throw new Error(PARALLEL_READ_ERROR); };
export type PolicySnapshot = { readonly policy: ApprovalPolicy; readonly version: string };
export const parallelPolicyIO = { open };
/** Operator preferences select review granularity, never fanout or execution permission. */
export async function readApprovalPolicy(cwd: string, signal?: AbortSignal): Promise<PolicySnapshot> {
  const file = path.join(cwd, ".pi", "jev-orchestration.json");
  try {
    signal?.throwIfAborted();
    let before: BigIntStats;
    try { before = await lstat(file, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { policy: structuredClone(DEFAULT_APPROVAL_POLICY), version: goalFileDigest("missing:" + file) };
      return fail();
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n || await realpath(file) !== file) return fail();
    const handle = await parallelPolicyIO.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.dev !== before.dev || info.ino !== before.ino) return fail();
      const bytes = Buffer.alloc(4097); let length = 0;
      while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      const after = await handle.stat({ bigint: true }); signal?.throwIfAborted();
      if (length > 4096 || after.size !== BigInt(length) || after.size !== info.size || after.mtimeNs !== info.mtimeNs) return fail();
      const text = bytes.subarray(0, length).toString("utf8");
      if (!bytes.subarray(0, length).equals(Buffer.from(text))) return fail();
      const value: unknown = JSON.parse(text);
      if (!Value.Check(ApprovalPolicySchema, value)) return fail();
      return { policy: structuredClone(value), version: goalFileDigest(JSON.stringify({ dev: after.dev.toString(), ino: after.ino.toString(), text })) };
    } finally { try { await handle.close(); } catch { throw new DirectoryValidationError(PARALLEL_READ_ERROR, "unknown", false); } }
  } catch (error) { if (directoryError(error)?.cleanupConfirmed === false) throw error; return fail(); }
}
export async function prepareParallelRead(input: ParallelReadInput, ctx: ExtensionContext, signal: AbortSignal): Promise<ParallelReadPrepared> {
  if (!validParallelReadInput(input)) return fail();
  const owned = structuredClone(input), sessionId = ctx.sessionManager.getSessionId();
  const directories = await canonicalOrdinaryDirectories(ctx.cwd, getAgentDir(), signal), policy = await readApprovalPolicy(directories.cwd, signal);
  const contexts = new Map<string, GoalContextFile>(), profiles = new Map<string, Awaited<ReturnType<typeof loadGoalProfile>>>();
  for (const name of new Set(owned.tasks.map(task => task.agent))) {
    const profile = await loadGoalProfile(name, directories.agentDirectory, signal);
    const run = { cwd: directories.cwd, task: parallelReadTask(owned.task, owned.tasks.find(task => task.agent === name)!.summary), agent: profile.agent,
      model: profile.agent.model, maxModelCalls: owned.limits.perWorkerCalls ?? null, seconds: owned.limits.seconds };
    if (!validReadOnlyRun(run)) return fail();
    const context = await contextSnapshot(directories.cwd, directories.agentDirectory, profile.agent.file, [], signal);
    if (!isDeepStrictEqual(context.find(row => row.path === profile.agent.file)?.version, profile.profileVersion) ||
      !isDeepStrictEqual(context.find(row => row.path === path.join(directories.agentDirectory, "models.json"))?.version ?? null, profile.modelConfiguration)) return fail();
    for (const row of context) { const previous = contexts.get(row.path); if (previous && !isDeepStrictEqual(previous, row)) return fail(); contexts.set(row.path, row); }
    profiles.set(name, profile);
  }
  const prepared: ParallelReadPrepared = { id: randomUUID(), sessionId, cwd: directories.cwd, agentDirectory: directories.agentDirectory,
    input: owned, policy: policy.policy, policyVersion: policy.version, context: [...contexts.values()], tasks: owned.tasks.map(task => {
      const profile = profiles.get(task.agent)!;
      return { id: task.id, run: { cwd: directories.cwd, task: parallelReadTask(owned.task, task.summary), agent: profile.agent, model: profile.agent.model,
        maxModelCalls: owned.limits.perWorkerCalls ?? null, seconds: owned.limits.seconds }, target: profile.publicModel };
    }) };
  if (!validParallelReadPrepared(prepared)) return fail();
  return prepared;
}
export function parallelReadApproval(prepared: ParallelReadPrepared, reviewingTask?: string): { packet: string; text: string } {
  const packet = JSON.stringify({ protocol: "One new fixed read-only batch; config preferences are not permission.",
    constraints: "read/grep/find/ls profile permissions, NOT file-ID restriction or an OS sandbox. No writes, shell, installation, nested agents, model fallback, task retry or sibling-report forwarding. All required literal native replies precede execution. Exact-approved task count determines concurrent lanes; the pool makes no JEV decision. One shared original runtime deadline; cancel stops and drains all children.",
    ...(reviewingTask ? { reviewingTask } : {}), digest: parallelReadDigest(prepared), prepared }, null, 2);
  const text = ["JEV · Exact independent read-only batch approval", `Approval level: ${prepared.policy.approval.level} · concurrent lanes ${prepared.tasks.length} from the exact task catalog`,
    "Ordinary read-only profile permissions; not a file-ID sandbox. Reading may disclose accessible workspace files to the selected model.",
    "No child starts until all required reviews are accepted. User waiting does not consume execution time; all tasks share one deadline without extensions.",
    ...(reviewingTask ? [`Current task review: ${reviewingTask}`] : []),
    ...prepared.tasks.flatMap(task => {
      const view = taskReviewContent(task.run);
      return [humanLiteral(`── ${task.id} / ${task.run.agent.name} / ${task.run.model.provider}/${task.run.model.id} / ${task.run.agent.thinking ?? "off"} ──`),
        ...view.risks.map(humanLiteral), ...view.sections.map(section => humanLiteral(`${section.title}\n${section.text}`))];
    }), "── Complete exact source / context / policy / budgets ──", humanLiteral(packet)].join("\n\n");
  return { packet, text };
}
export const parallelReadIO = {
  prepare: prepareParallelRead, policy: readApprovalPolicy, canonical: canonicalDirectory, context: checkGoalContext, confirm: confirmContextPacket,
  run: (input: ParallelReadWorkerInput, signal: AbortSignal, progress?: WorkerProgressObserver) => runGoalProcess({ script: "parallel-read-worker.ts", cwd: input.run.cwd,
    input, deadline: input.deadline, timeoutMs: Math.max(1, input.deadline - Date.now()) }, (value): value is WorkerReply => Value.Check(WorkerReplySchema, value), signal, progress),
};
export type ParallelReadResult = { readonly authorization?: "full_access"; readonly kind: "parallel_read"; readonly status: "completed_unverified" | "stopped"; readonly reason: string;
  readonly taskAcceptance: "needs_human_review"; readonly approvalLevel?: ApprovalPolicy["approval"]["level"]; readonly approvals: number; readonly peakActiveTasks: number;
  readonly attemptedTasks: number; readonly modelCalls: number | null; readonly reservedModelCalls: number | null; readonly cleanupConfirmed: boolean;
  readonly rows: readonly { id: string; agent: string; model: { provider: string; id: string }; maxModelCalls: number | null;
    status: "not_started" | "completed" | "failed" | "cancelled" | "unknown"; modelCalls: number | null; accounting: "not_started" | "unknown" | "reported";
    accountingComplete: boolean; diagnostic?: NonNullable<WorkerReport["diagnostic"]>; text?: string; truncated?: boolean }[];
  readonly costEstimate: { readonly observedUsd: number; readonly delegationTotalUsd: number | null } };
/** Actual fanout belongs inside one owned invocation; the public control plane still serializes native review dialogs. */
export async function parallelRead(input: unknown, ctx: ExtensionContext, signal?: AbortSignal, io = parallelReadIO,
  onProgress?: (value: { active: number; settled: number; maximum: number }) => void, observeUi?: ApprovalUiObserver, access?: FullAccessLease): Promise<ParallelReadResult> {
  const controller = new AbortController(), combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(access ? [access.signal] : [])]);
  let prepared: ParallelReadPrepared | undefined, ledger: ParallelLedger | undefined, approvals = 0, reason = "failed", timer: ReturnType<typeof setTimeout> | undefined;
  const replies = new Map<string, WorkerReply>(); let preparationCleanupConfirmed = true;
  const observeError = (error: unknown) => {
    if (directoryError(error)?.cleanupConfirmed === false || directoryPreparationIssues(error)?.some(issue => !issue.cleanupConfirmed)) preparationCleanupConfirmed = false;
  };
  try {
    if (!validParallelReadInput(input) || !canConfirmContextPacket(ctx) || combined.aborted) return stopped();
    const owned = structuredClone(input);
    prepared = structuredClone(await io.prepare(owned, ctx, combined));
    if (!validParallelReadPrepared(prepared) || !isDeepStrictEqual(prepared.input, owned)) return stopped();
    const digest = parallelReadDigest(prepared);
    const fresh = async () => {
      combined.throwIfAborted();
      if (!prepared || parallelReadDigest(prepared) !== digest || ctx.sessionManager.getSessionId() !== prepared.sessionId ||
        await io.canonical(ctx.cwd, false, combined) !== prepared.cwd || (await io.policy(prepared.cwd, combined)).version !== prepared.policyVersion) return fail();
      await io.context({ body: { context: prepared.context } }, combined);
      combined.throwIfAborted(); if (ledger && Date.now() >= ledger.deadline || parallelReadDigest(prepared) !== digest) return fail();
    };
    await fresh();
    const reviews = prepared.policy.approval.level === "strict" ? prepared.tasks.map(task => task.id) : [undefined];
    for (const id of reviews) {
      const view = parallelReadApproval(prepared, id);
      const authorized = access ? access.authorize(ctx, combined) : await io.confirm(ctx, `JEV · Read-only batch${id ? ` / ${id}` : ""}`, view.packet, null, combined, "approval", observeUi, view.text);
      if (authorized !== true) {
        reason = "approval_not_received"; return stopped();
      }
      approvals++;
      if (approvals === reviews.length) {
        ledger = startParallelLedger(prepared, Date.now());
        timer = setTimeout(() => controller.abort(), Math.max(1, ledger.deadline - Date.now())); timer.unref();
      }
      await fresh();
    }
    if (!ledger) return fail();
    let cursor = 0;
    const lane = async () => {
      while (prepared && ledger && !ledger.stopped && !combined.aborted) {
        const task = prepared.tasks[cursor++]; if (!task) return;
        try {
          await fresh(); if (ledger.stopped || combined.aborted) return;
          ledger = reserveParallelTask(ledger, task.id, Date.now()); if (ledger.stopped) { controller.abort(); return; }
          publish();
          const result = await io.run({ version: 1, run: structuredClone(task.run), context: structuredClone(prepared.context), approvedAt: ledger.approvedAt,
            deadline: ledger.deadline, policyVersion: prepared.policyVersion, target: structuredClone(task.target) }, combined);
          const reply = result.result, accounting = reply?.report.accounting, calls = reply?.report.modelCalls ?? (result.started ? null : 0);
          if (reply) replies.set(task.id, structuredClone(reply));
          const accountingComplete = !result.started || accounting?.status === "not_started" && calls === 0 || accounting?.status === "reported" && accounting.complete;
          let current = !combined.aborted && Date.now() < ledger.deadline;
          if (current) { try { await fresh(); } catch (error) { observeError(error); current = false; } }
          ledger = observeParallelTask(ledger, task.id, { outcome: current && result.started && reply?.type === "completed" && calls !== null && calls > 0 && result.cleanupConfirmed && accountingComplete ? "completed" : combined.aborted ? "cancelled" : "failed",
            started: result.started, modelCalls: calls, accountingComplete, cleanupConfirmed: result.cleanupConfirmed,
            observedUsd: accounting?.status === "reported" ? accounting.stats.cost : !result.started || accounting?.status === "not_started" ? 0 : null });
          if (ledger.stopped) controller.abort(); publish();
        } catch (error) {
          observeError(error);
          if (ledger.rows.some(row => row.id === task.id && row.phase === "running")) ledger = observeParallelTask(ledger, task.id,
            { outcome: combined.aborted ? "cancelled" : "failed", started: true, modelCalls: null, accountingComplete: false, cleanupConfirmed: false, observedUsd: null });
          ledger = { ...ledger, stopped: true }; controller.abort(); publish();
        }
      }
    };
    await Promise.allSettled(Array.from({ length: ledger.maximum }, () => lane()));
    reason = combined.aborted ? "cancelled_or_failed" : "No independent verification or task acceptance.";
    return stopped();
  } catch (error) { observeError(error); return stopped(); }
  finally { clearTimeout(timer); controller.abort(); }
  function publish() {
    if (!ledger || !prepared) return;
    try { void Promise.resolve(onProgress?.({ active: ledger.rows.filter(row => row.phase === "running").length,
      settled: ledger.rows.filter(row => row.phase === "settled").length, maximum: ledger.maximum })).catch(() => {}); } catch { /* Display is not authority. */ }
  }
  function stopped(): ParallelReadResult {
    const metrics = ledger ? parallelLedgerMetrics(ledger) : { modelCalls: 0, reservedModelCalls: 0, observedUsd: 0, totalUsd: 0, cleanupConfirmed: true };
    const finished = ledger && !ledger.stopped && ledger.rows.every(row => row.phase === "settled" && row.observation?.outcome === "completed") && metrics.cleanupConfirmed && preparationCleanupConfirmed;
    return { kind: "parallel_read", status: finished ? "completed_unverified" : "stopped", reason, taskAcceptance: "needs_human_review",
      ...(prepared ? { approvalLevel: prepared.policy.approval.level } : {}), ...(access ? { authorization: access.source } : {}), approvals: access ? 0 : approvals, peakActiveTasks: ledger?.peak ?? 0,
      attemptedTasks: ledger?.rows.filter(row => row.phase !== "queued").length ?? 0, modelCalls: metrics.modelCalls, reservedModelCalls: metrics.reservedModelCalls,
      cleanupConfirmed: metrics.cleanupConfirmed && preparationCleanupConfirmed, rows: (prepared?.tasks ?? []).map(task => {
        const row = ledger?.rows.find(row => row.id === task.id), reply = replies.get(task.id);
        let accounting: "not_started" | "unknown" | "reported" = "unknown";
        if (!row || row.phase === "queued" || row.observation?.started === false) accounting = "not_started";
        if (reply) accounting = reply.report.accounting.status;
        let modelCalls: number | null = row?.phase === "running" ? null : 0;
        if (row?.observation) modelCalls = row.observation.modelCalls;
        return { id: task.id, agent: task.run.agent.name, model: structuredClone(task.run.model), maxModelCalls: task.run.maxModelCalls,
          status: row?.observation?.outcome ?? (row?.phase === "running" ? "unknown" : "not_started"),
          modelCalls, accounting,
          accountingComplete: row?.observation?.accountingComplete ?? (!row || row.phase === "queued"),
          ...(reply?.report.diagnostic ? { diagnostic: structuredClone(reply.report.diagnostic) } : {}),
          ...(reply?.type === "completed" ? { text: reply.result.text, truncated: reply.result.truncated } : {}) };
      }), costEstimate: { observedUsd: metrics.observedUsd, delegationTotalUsd: metrics.totalUsd } };
  }
}

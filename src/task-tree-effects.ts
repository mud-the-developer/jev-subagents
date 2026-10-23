import path from "node:path";
import { withWindowsGoalReadBatch } from "./windows-goal-files.ts";
import type { FullAccessLease } from "./delegation-access-effects.ts";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { canonicalOrdinaryDirectories, canonicalDirectory, loadGoalProfile, contextSnapshot, checkGoalContext, checkFreshReadPair, openGoalProjectLock, runGoalProcess, type GoalProjectOwner } from "./goal-run-effects.ts";
import { prepareGoalFileScope, checkGoalFileScope } from "./goal-file-effects.ts";
import type { GoalContextFile } from "./goal-run.ts";
import { canConfirmContextPacket, confirmContextPacket } from "./context-approval.ts";
import type { ApprovalUiObserver } from "./approval-ui-diagnostics.ts";
import { humanLiteral } from "./task-review-machine.ts";
import { readApprovalPolicy } from "./parallel-read-effects.ts";
import { ordinaryControlBatches, OrdinaryWorkerReplySchema, type OrdinaryWorkerReply } from "./ordinary-protocol.ts";
import { WorkerReplySchema, type WorkerReply } from "./delegate-machine.ts";
import { executeEffect } from "./effects.ts";
import { reduce as reduceRoute } from "./machine.ts";
import { reportData } from "./choice.ts";
import { readJevConnection, sameJevConnection, describeJevTarget, type JevConnection } from "./jev-config.ts";
import { directoryError, directoryPreparationIssues } from "./directory-diagnostics.ts";
import type { WorkerProgressObserver } from "./worker-progress.ts";
import { reduceTaskTree, treeLive, treeTasks, treeInfos, treeReferences, treeDigest, treeOptions, treeRequest, treeNeedsRouting, treeSnapshot, treeMetrics, treeReceipts, treeCompatibleFiles, validTaskTree, validTreePrepared,
  type TreePrepared, type TaskTreeInput, type TreeEvent, type TreeEffect, type TreeSelection, type TreeUpdate, type TreeState } from "./task-tree.ts";
import { treeOwner, treeLock, treePrompts, validTreeWorker, type TreeWorkerInput } from "./task-tree-protocol.ts";
import { taskTreeView } from "./task-tree-view.ts";
import type { PlanView } from "./plan-presentation.ts";

export const TREE_ERROR = "Task tree stopped. No automatic retry, fallback, grant extension or rollback.";
const fail = (): never => { throw new Error(TREE_ERROR); };
export type TreeQuestion = { readonly kind: "tree_parent"; readonly jobId: string; readonly questionId: string; readonly taskId: string;
  readonly purpose: "selection" | "generated_information"; readonly query: string;
  readonly options: readonly { id: string; selection: TreeSelection; description: string }[];
  readonly missing: readonly { id: string; title: string; kind: string; producer: string }[];
  readonly reports: readonly { taskId: string; text: string; truncated: boolean }[] };
export type TreeAnswer = { readonly selection: TreeSelection } | { readonly records: TreeUpdate } | null;
export type TreeParent = (question: TreeQuestion, signal: AbortSignal) => Promise<TreeAnswer>;
export async function prepareTaskTree(input: TaskTreeInput, ctx: ExtensionContext, signal: AbortSignal): Promise<TreePrepared> {
  if (!validTaskTree(input)) return fail();
  const owned = structuredClone(input), directories = await canonicalOrdinaryDirectories(ctx.cwd, getAgentDir(), signal);
  const policy = await readApprovalPolicy(directories.cwd, signal);
  const files = owned.files ? await prepareGoalFileScope({ cwd: directories.cwd, files: owned.files }, { agentDirectory: directories.agentDirectory, journalDirectory: directories.agentDirectory }, signal) : undefined;
  const context = new Map<string, GoalContextFile>(), agents: TreePrepared["agents"] = [], targets: TreePrepared["targets"] = [];
  for (const name of new Set(treeTasks(owned).flatMap(task => task.agents))) {
    const profile = await loadGoalProfile(name, directories.agentDirectory, signal);
    agents.push(profile.agent); targets.push({ agent: name, ...profile.publicModel });
    const source = await contextSnapshot(directories.cwd, directories.agentDirectory, profile.agent.file, owned.files ?? [], signal);
    if (!isDeepStrictEqual(source.find(row => row.path === profile.agent.file)?.version, profile.profileVersion) ||
      !isDeepStrictEqual(source.find(row => row.path === path.join(directories.agentDirectory, "models.json"))?.version ?? null, profile.modelConfiguration)) return fail();
    for (const entry of source) { if (context.has(entry.path) && !isDeepStrictEqual(context.get(entry.path), entry)) return fail(); context.set(entry.path, entry); }
  }
  const connection = treeNeedsRouting(owned) ? readJevConnection() : null;
  if (connection && !connection.ok) return fail();
  const tree: TreePrepared = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(), cwd: directories.cwd, agentDirectory: directories.agentDirectory,
    input: owned, agents, targets, context: [...context.values()], ...(files ? { files } : {}), policy: policy.policy, policyVersion: policy.version,
    routingTarget: connection?.ok ? describeJevTarget(connection.connection) : null };
  if (!validTreePrepared(tree)) return fail();
  for (const task of treeTasks(owned)) if (treeOptions(tree, task.id).length > 1 && reduceRoute({ status: "idle" }, { type: "route_plans", request: treeRequest(tree, task.id) }).state.status !== "routing") return fail();
  return tree;
}
function makeWorker(tree: TreePrepared, state: TreeState, taskId: string, owner?: GoalProjectOwner): TreeWorkerInput {
  const live = treeLive(state); if (!live) return fail();
  const task = treeTasks(tree.input).find(task => task.id === taskId)!, row = live.rows.find(row => row.id === taskId)!;
  const selected = row.selection; if (!selected) return fail();
  const original = tree.agents.find(agent => agent.name === selected.agent)!, agent = task.mode === "read" ? original : { ...original, tools: original.tools.filter(tool => ["read", "edit", "write"].includes(tool)) };
  const target = tree.targets.find(target => target.agent === selected.agent)!;
  const snapshot = treeSnapshot(tree, live.records, selected.ids);
  const input: TreeWorkerInput = { version: 1, treeId: tree.id, scopeDigest: treeDigest(tree), overallTask: tree.input.task, task,
    run: { cwd: tree.cwd, task: task.summary, agent, model: agent.model, maxModelCalls: tree.input.limits.perWorkerCalls ?? null, seconds: tree.input.limits.seconds },
    target: { api: target.api, endpoint: target.endpoint }, context: tree.context, policyVersion: tree.policyVersion,
    approvedAt: live.approvedAt, deadline: live.deadline,
    ...(owner ? { owner: { ...treeLock(tree), version: owner.version, active: false } } : {}),
    ...(task.mode === "mutation" ? { files: live.files } : {}), ...(snapshot ? { snapshot } : {}) };
  if (!validTreeWorker(input)) return fail();
  return structuredClone(input);
}
export function taskTreeApproval(tree: TreePrepared, taskId?: string, update?: TreeUpdate) {
  const packet = JSON.stringify({ protocol: "One ephemeral parent-authored tree; native human approval, never caller or persisted authority.",
    tree, reviewingTask: taskId ?? null, generatedBodies: update ?? [],
    rules: "Maximum3 total workers. Independent read/grep/find/ls profiles may overlap; ordinary read-only permissions are NOT file-ID isolation or an OS sandbox. Mutation runs exclusively through existing scoped file IDs (16 files,32KiB each,128KiB total,64 operations per worker). All initial reviews precede any dispatch. Fixed supported profiles/models/thinking/endpoints only. One combined metadata-only model/information decision per task (maximum3), one choice bypasses JEV. No paid width/planner/completion judge, retry or fallback. Only query, public titles/kinds/IDs/relations and fixed tuple metadata go to JEV; never task source, record bodies or worker text. Only selected readonly records reach a child (8 records/8KiB); no database, parent history or implicit sibling sharing. Parent receives worker reports as unverified data. Parent-authored generated bodies require a fresh exact disclosure/execution review for the declared downstream tasks and fixed candidate tuples. No tasks, edges, candidates or permissions can be added. No automatic collection or persistence.",
    budgets: "Omitted/null call limits mean SDK natural completion, not zero cost or a token/dollar cap. Explicit finite limits remain binding. One deadline starts at the last actual initial positive review and includes all later selection/disclosure waits. It is never restarted or extended. Cost may be substantial. Cancellation is not rollback; unknown usage/cleanup blocks successors and new admission.",
    routing: treeTasks(tree.input).map(task => ({ taskId: task.id, request: treeOptions(tree, task.id).length > 1 ? treeRequest(tree, task.id) : null })),
    prompts: treeTasks(tree.input).flatMap(task => task.agents.map(name => {
      const original = tree.agents.find(agent => agent.name === name)!, agent = task.mode === "read" ? original : { ...original, tools: original.tools.filter(tool => ["read", "edit", "write"].includes(tool)) };
      return { taskId: task.id, agent: name, ...treePrompts({ overallTask: tree.input.task, task, run: { cwd: tree.cwd, task: task.summary, agent, model: agent.model,
        maxModelCalls: tree.input.limits.perWorkerCalls ?? null, seconds: tree.input.limits.seconds }, context: tree.context, ...(task.mode === "mutation" ? { files: tree.files } : {}) }),
        snapshotPolicy: "The exact selected records replace the no-reference sentence. Only records referenced by this task in the reviewed graph may be selected. Bodies and all permitted recipients are fully listed in this packet." };
    })),
  }, null, 2);
  const text = `JEV · ${update ? "Fresh generated-information disclosure and downstream execution review" : "Exact parent-authored task tree approval"}\n\n${humanLiteral(packet)}`;
  if (Buffer.byteLength(packet) > 262144 || Buffer.byteLength(text) > 262144) return fail();
  return { packet, text };
}
export const taskTreeIO = { prepare: prepareTaskTree, canonical: canonicalDirectory, policy: readApprovalPolicy, context: checkGoalContext,
  files: checkGoalFileScope, own: openGoalProjectLock, confirm: confirmContextPacket, select: executeEffect,
  run: (input: TreeWorkerInput, signal: AbortSignal, progress?: WorkerProgressObserver) => runGoalProcess({ script: "task-tree-worker.ts", cwd: input.run.cwd,
    input, deadline: input.deadline, timeoutMs: Math.max(1, input.deadline - Date.now()) }, (value): value is WorkerReply | OrdinaryWorkerReply =>
    Value.Check(WorkerReplySchema, value) || Value.Check(OrdinaryWorkerReplySchema, value), signal, progress),
};
export type TreeResult = { readonly authorization?: "full_access"; readonly kind: "task_tree"; readonly status: "completed_unverified" | "stopped"; readonly reason: string; readonly taskAcceptance: "needs_human_review";
  readonly metrics: ReturnType<typeof treeMetrics>; readonly receipts: ReturnType<typeof treeReceipts>; readonly cleanupConfirmed: boolean; readonly lockRetained: boolean; readonly plan?: PlanView;
  readonly reports: readonly { taskId: string; text: string; truncated: boolean }[] };
/** I/O interpreter: concurrent owned work returns events; only the reducer admits work or changes graph data. */
export async function taskTree(input: unknown, ctx: ExtensionContext, signal?: AbortSignal, io = taskTreeIO,
  onPlan?: (view: PlanView) => void, parent?: TreeParent, observeUi?: ApprovalUiObserver, access?: FullAccessLease): Promise<TreeResult> {
  let state: TreeState = { phase: "idle" }, tree: TreePrepared | undefined, fingerprint: string | undefined, owner: GoalProjectOwner | undefined;
  let connection: JevConnection | null = null, timer: ReturnType<typeof setTimeout> | undefined, ownerAttempted = false, cleanup = true, retained = false;
  const controller = new AbortController(), combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(access ? [access.signal] : [])]);
  const queue: TreeEffect[] = [], pending = new Set<Promise<void>>(), reports: { taskId: string; text: string; truncated: boolean }[] = [];
  // Windows file-scope reads hold exclusive handles; serialize them without caching freshness.
  let fileChecks = Promise.resolve();
  const readState = (): TreeState => state;
  const display = () => { if (tree) { try { onPlan?.(taskTreeView(tree, state, Date.now())); } catch { /* Observer-only. */ } } };
  const send = (event: TreeEvent) => { const step = reduceTaskTree(state, event); state = step.state; queue.push(...step.effects); display(); };
  const cancelled = () => send({ type: "stop", reason: "cancelled_or_expired" });
  const current = async (files = treeLive(state)?.files) => {
    if (!tree || treeDigest(tree) !== fingerprint || ctx.sessionManager.getSessionId() !== tree.sessionId) return fail();
    const ownership = owner ? [{ ...treeLock(tree), version: owner.version, active: false }] : [];
    const currentTree = tree;
    await checkFreshReadPair(async () => {
      if (await io.canonical(ctx.cwd, false, combined) !== currentTree.cwd ||
        (await io.policy(currentTree.cwd, combined)).version !== currentTree.policyVersion) return fail();
      if (connection) { const fresh = readJevConnection(); if (!fresh.ok || !sameJevConnection(fresh.connection, connection)) return fail(); }
    }, () => checkFreshReadPair(async () => {
      const control = ownership[0];
      if (control && ordinaryControlBatches(currentTree.context, control.path, control.version.bytes).length > 1) {
        await io.context({ body: { context: currentTree.context } }, combined); await io.context({ body: { context: ownership } }, combined);
      } else await io.context({ body: { context: [...currentTree.context, ...ownership] } }, combined);
    }, async () => {
      if (files) {
        const check = fileChecks.then(() => { combined.throwIfAborted(); return io.files(files, { agentDirectory: currentTree.agentDirectory, journalDirectory: currentTree.agentDirectory }, combined); });
        fileChecks = check;
        await check;
      }
    }, combined), combined);
    const live = treeLive(state); combined.throwIfAborted(); if (live && Date.now() >= live.deadline || treeDigest(tree) !== fingerprint || ctx.sessionManager.getSessionId() !== tree.sessionId) return fail();
  };
  const error = (error: unknown) => {
    if (directoryError(error)?.cleanupConfirmed === false || directoryPreparationIssues(error)?.some(issue => !issue.cleanupConfirmed) || ownerAttempted && !owner) cleanup = false;
    send({ type: "stop", reason: cleanup ? "failed_or_changed" : "unknown_cleanup" });
  };
  const execute = async (effect: TreeEffect) => {
    if (effect.type === "abort") { controller.abort(); return; }
    if (combined.aborted || state.phase === "draining" || state.phase === "terminal") {
      if (effect.type === "run") send({ type: "observed", taskId: effect.taskId, observation: { outcome: "cancelled", started: false, modelCalls: 0, accountingComplete: true, cleanupConfirmed: true, observedUsd: 0, current: false } });
      return;
    }
    if (effect.type === "prepare") {
      tree = structuredClone(await io.prepare(effect.input, ctx, combined));
      if (!validTreePrepared(tree) || !isDeepStrictEqual(tree.input, effect.input)) return fail();
      fingerprint = treeDigest(tree);
      if (tree.routingTarget) { const result = readJevConnection(); if (!result.ok || describeJevTarget(result.connection) !== tree.routingTarget) return fail(); connection = result.connection; }
      for (const task of treeTasks(tree.input)) if (treeOptions(tree, task.id).length > 1 && reduceRoute({ status: "idle" }, { type: "route_plans", request: treeRequest(tree, task.id) }).state.status !== "routing") return fail();
      await current(tree.files); send({ type: "prepared", tree }); return;
    }
    if (!tree) return fail();
    if (effect.type === "review" || effect.type === "disclose") {
      await current();
      const records = effect.type === "disclose" ? treeLive(state)?.control?.records : undefined;
      const view = taskTreeApproval(tree, effect.taskId, records);
      const accepted = access ? access.authorize(ctx, combined) : await io.confirm(ctx, "JEV · Task tree exact review", view.packet, null, combined, "approval", observeUi, view.text);
      const now = Date.now();
      if (effect.type === "disclose") {
        if (accepted === true) await current();
        send({ type: "disclosure", taskId: effect.taskId, accepted }); return;
      }
      send({ type: "approval", accepted, now });
      const live = treeLive(state);
      if (!timer && live && state.phase === "active") { timer = setTimeout(() => controller.abort(), Math.max(1, live.deadline - Date.now())); timer.unref(); }
      if (accepted === true && readState().phase !== "terminal" && readState().phase !== "draining") {
        await current();
        if (readState().phase === "active" && tree.files && !owner) { ownerAttempted = true; owner = await io.own(treeOwner(tree), combined); await current(); }
      }
      return;
    }
    await current();
    if (readState().phase !== "active" || combined.aborted) {
      if (effect.type === "run") send({ type: "observed", taskId: effect.taskId, observation: { outcome: "cancelled", started: false, modelCalls: 0, accountingComplete: true, cleanupConfirmed: true, observedUsd: 0, current: false } });
      return;
    }
    if (effect.type === "route") {
      if (!connection) return fail();
      const result = await io.select({ type: "call_jev", request: treeRequest(tree, effect.taskId) }, combined, () => {
        if (combined.aborted || state.phase !== "active" || Date.now() >= state.deadline) return fail();
        send({ type: "attempt", taskId: effect.taskId }); if (state.phase !== "active") return fail();
      }, connection);
      const report = result.type === "resolved" ? reportData(result.decision) : "jev" in result ? result.jev : undefined;
      // Settle correlated late routing receipts even after cancellation, without scheduling successors.
      send({ type: "decision", taskId: effect.taskId, option: result.type === "resolved" ? result.decision.agent : "", support: result.type === "resolved" ? result.decision.confidence : -1, ...(report ? { report } : {}) });
    } else if (effect.type === "choose" || effect.type === "update") {
      if (!parent) return fail();
      const live = treeLive(state)!;
      const missing = treeReferences(tree.input, effect.taskId).filter(id => !live.records.some(record => record.id === id)).map(id => {
        const info = treeInfos(tree!.input).find(info => info.id === id)!;
        return { id, title: info.title, kind: info.infoKind, producer: tree!.input.edges.find(edge => edge.kind === "produced" && edge.to === id)!.from };
      });
      const answer = await parent({ kind: "tree_parent", jobId: tree.id, questionId: randomUUID(), taskId: effect.taskId,
        purpose: effect.type === "choose" ? "selection" : "generated_information", query: treeTasks(tree.input).find(task => task.id === effect.taskId)!.query,
        options: effect.type === "choose" ? treeOptions(tree, effect.taskId) : [], missing, reports: reports.filter(report => missing.some(info => info.producer === report.taskId)) }, combined);
      if (!answer) return fail();
      if (effect.type === "choose" && "selection" in answer) send({ type: "choice", taskId: effect.taskId, selection: answer.selection });
      else if (effect.type === "update" && "records" in answer) send({ type: "update", taskId: effect.taskId, records: answer.records }); else return fail();
    } else if (effect.type === "check") send({ type: "fresh", taskId: effect.taskId, current: true, now: Date.now() });
    else if (effect.type === "run") {
      const packet = makeWorker(tree, state, effect.taskId, owner);
      let result: Awaited<ReturnType<typeof io.run>>;
      try { result = await io.run(packet, combined, progress => send({ type: "progress", taskId: effect.taskId, progress })); }
      catch { send({ type: "observed", taskId: effect.taskId, observation: { outcome: "failed", started: true, modelCalls: null, accountingComplete: false, cleanupConfirmed: false, observedUsd: null, current: false } }); return; }
      const wrapped = result.result?.type === "goal_result" ? result.result : undefined, reply = wrapped?.reply ?? (result.result?.type !== "goal_result" ? result.result : undefined);
      const accounting = reply?.report.accounting;
      let fresh = false;
      const expectedReply = packet.task.mode === "mutation" ? !!wrapped && treeCompatibleFiles(packet.files, wrapped.scope) : !wrapped;
      if (expectedReply && !combined.aborted && state.phase === "active") { try { await current(wrapped?.scope ?? treeLive(state)?.files); fresh = true; } catch (failure) { error(failure); } }
      if (reply?.type === "completed") reports.push({ taskId: effect.taskId, text: reply.result.text, truncated: reply.result.truncated });
      send({ type: "observed", taskId: effect.taskId, observation: { started: result.started,
        outcome: reply?.type === "completed" && (!wrapped || wrapped.files.finished) ? "completed" : combined.aborted ? "cancelled" : "failed",
        modelCalls: reply?.report.modelCalls ?? (result.started ? null : 0), accountingComplete: !result.started || accounting?.status === "reported" && accounting.complete,
        cleanupConfirmed: result.cleanupConfirmed && wrapped?.files.uncertain !== true, observedUsd: accounting?.status === "reported" ? accounting.stats.cost : !result.started ? 0 : null,
        current: fresh, ...(wrapped ? { files: wrapped.scope } : {}) } });
    }
  };
  try {
    await withWindowsGoalReadBatch(async () => {
      try {
        send({ type: "start", input });
        if (!canConfirmContextPacket(ctx) || combined.aborted) send({ type: "stop", reason: "approval_ui_unavailable_or_cancelled" });
        combined.addEventListener("abort", cancelled, { once: true });
        while (queue.length || pending.size) {
          while (queue.length) {
            const effect = queue.shift()!;
            const work = Promise.resolve().then(() => execute(effect)).catch(error).finally(() => pending.delete(work));
            pending.add(work);
          }
          if (pending.size) await Promise.race(pending);
        }
        if (readState().phase === "active") send({ type: "stop", reason: "incomplete_tree" });
      } finally {
        const closing = readState();
        if (closing.phase !== "draining" || closing.reason !== "completed_unverified") controller.abort();
        await Promise.allSettled(pending);
      }
    }, combined);
  } catch (failure) { error(failure); }
  finally {
    // Revocation never abandons an owned operation or its late accounting receipt.
    const closing = readState();
    if (closing.phase !== "draining" || closing.reason !== "completed_unverified") controller.abort();
    await Promise.allSettled(pending);
    const metrics = treeMetrics(state);
    retained = !cleanup || !metrics.cleanupConfirmed || metrics.reservedModelCalls !== 0 || metrics.reservedJevRequests > 0;
    if (owner) { try { retained = await owner.close(retained); } catch { retained = true; cleanup = false; } }
    send({ type: "drained", cleanupConfirmed: cleanup && metrics.cleanupConfirmed && !retained });
    clearTimeout(timer); combined.removeEventListener("abort", cancelled); controller.abort();
  }
  const final = readState(), metrics = treeMetrics(final), plan = tree ? taskTreeView(tree, final, Date.now()) : undefined;
  return { kind: "task_tree", ...(access ? { authorization: access.source } : {}), status: final.phase === "terminal" ? final.outcome : "stopped", reason: final.phase === "terminal" ? final.reason : TREE_ERROR,
    taskAcceptance: "needs_human_review", metrics, receipts: treeReceipts(final), cleanupConfirmed: cleanup && metrics.cleanupConfirmed && !retained, lockRetained: owner !== undefined && retained,
    ...(plan ? { plan } : {}), reports };
}

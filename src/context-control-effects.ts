import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { canonicalDirectory, contextSnapshot, loadGoalProfile, checkGoalContext, openGoalProjectLock, readGoalLeaseSnapshot, runGoalProcess } from "./goal-run-effects.ts";
import { snapshotGoalText } from "./goal-file-effects.ts";
import { GoalWorkerReplySchema, GOAL_PROJECT_LOCK, goalLockText, type GoalLease, type GoalObservation } from "./goal-run.ts";
import { openGoalJournal, executeGoalStorageEffect } from "./goal-journal.ts";
import { ZERO_GOAL_UNITS } from "./goal-machine.ts";
import { memoryHash } from "./context-memory.ts";
import { appendContextFile } from "./context-memory-effects.ts";
import { canConfirmContextPacket, confirmContextPacket } from "./context-approval.ts";
import { supportsManagedContext } from "./platform-support.ts";
import { CONTEXT_ERROR, CONTEXT_MS, CONTEXT_APPROVAL_MS, SUMMARY_MS, SUMMARY_TASK, CONTEXT_APPLICATION_FILE, reduceContext, validContextGrant,
  validContextInput, summaryPrompts, applicationDigest, contextSummaryText, type ContextGrant, type ContextInput, type ContextSource,
  type ContextApplication, type ContextState, type ContextEffect, type ContextEvent } from "./context-control.ts";

export type NativeContext = {
  prepare(signal: AbortSignal): Promise<ContextSource>;
  current(source: ContextSource): boolean;
  apply(source: ContextSource, text: string, operationId: string, deadline: number, check: () => Promise<void>, signal: AbortSignal): Promise<{ application: ContextApplication; entryId?: string }>;
  close(): Promise<boolean>;
};
const fail = (): never => { throw new Error(CONTEXT_ERROR); };
const identity = (stat: { dev: number; ino: number }) => ({ dev: stat.dev, ino: stat.ino });
const inside = (root: string, value: string) => { const relative = path.relative(root, value); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
export async function prepareContext(input: ContextInput, requestedCwd: string, source: ContextSource, signal?: AbortSignal): Promise<ContextGrant> {
  if (!validContextInput(input) || !supportsManagedContext(process.platform,
    ["darwin", "linux"].includes(process.platform) && process.getuid ? process.getuid() : undefined)) return fail();
  const owned = structuredClone(input), cwd = await canonicalDirectory(requestedCwd), journalDirectory = await canonicalDirectory(owned.journalDirectory, true);
  const agentDirectory = await canonicalDirectory(getAgentDir()), extension = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  if (inside(cwd, journalDirectory) || inside(journalDirectory, cwd) || inside(agentDirectory, journalDirectory) || inside(extension, journalDirectory)) return fail();
  if (await snapshotGoalText(path.join(cwd, GOAL_PROJECT_LOCK), signal) || await snapshotGoalText(path.join(journalDirectory, CONTEXT_APPLICATION_FILE), signal)) return fail();
  const { agent, profileVersion, modelConfiguration } = await loadGoalProfile(owned.agent, agentDirectory, signal);
  const context = await contextSnapshot(cwd, agentDirectory, agent.file, [], signal);
  if (!isDeepStrictEqual(context.find(x => x.path === agent.file)?.version, profileVersion) ||
      !isDeepStrictEqual(context.find(x => x.path === path.join(agentDirectory, "models.json"))?.version, modelConfiguration)) return fail();
  const run = { cwd, agent, model: agent.model, task: SUMMARY_TASK, maxModelCalls: 1 }, preparedAt = Date.now();
  const body: ContextGrant["body"] = { input: owned, source: structuredClone(source), run,
    files: { id: randomUUID(), root: cwd, rootIdentity: identity(await lstat(cwd)), files: [] }, journalDirectory,
    journalIdentity: identity(await lstat(journalDirectory)), agentDirectory, context, ...summaryPrompts(owned, run, context),
    preparedAt, approvalDeadline: preparedAt + CONTEXT_APPROVAL_MS, deadline: preparedAt + CONTEXT_MS };
  const grant = { body, ref: { goalId: randomUUID(), revision: 1, scopeDigest: memoryHash(body) }, activationId: randomUUID(), intentId: randomUUID() };
  if (!validContextGrant(grant)) return fail();
  await checkContext(grant, signal); return grant;
}
export async function checkContext(grant: ContextGrant, signal?: AbortSignal): Promise<void> {
  if (!validContextGrant(grant) || await canonicalDirectory(grant.body.run.cwd) !== grant.body.files.root ||
    !isDeepStrictEqual(identity(await lstat(grant.body.run.cwd)), grant.body.files.rootIdentity) ||
    await canonicalDirectory(grant.body.journalDirectory, true) !== grant.body.journalDirectory ||
    !isDeepStrictEqual(identity(await lstat(grant.body.journalDirectory)), grant.body.journalIdentity)) return fail();
  await checkGoalContext(grant, signal); signal?.throwIfAborted();
}
export async function checkContextLease(grant: ContextGrant, lease: GoalLease, signal?: AbortSignal): Promise<void> {
  await checkContext(grant, signal);
  const { ledger } = await readGoalLeaseSnapshot(grant, lease, signal), expected = { ...ZERO_GOAL_UNITS, summaryCalls: 1 };
  if (ledger.pending?.id !== grant.intentId || ledger.pending.planDigest !== grant.ref.scopeDigest || !isDeepStrictEqual(ledger.pending.reserve, expected) ||
    !isDeepStrictEqual(ledger.definition.limits, expected) || ledger.definition.maxTotalCalls !== 1 || ledger.definition.deadlineMs !== grant.body.deadline || Date.now() >= grant.body.deadline) return fail();
}
export async function runContextSummary(grant: ContextGrant, lease: GoalLease, signal: AbortSignal): Promise<GoalObservation> {
  try { await checkContextLease(grant, lease, signal); } catch { return { started: false, cleanupConfirmed: true, result: null }; }
  return runGoalProcess({ script: "context-worker.ts", cwd: grant.body.run.cwd, input: { grant, lease }, deadline: grant.body.deadline, timeoutMs: SUMMARY_MS },
    (value): value is import("./goal-run.ts").GoalWorkerReply => Value.Check(GoalWorkerReplySchema, value), signal);
}
export async function manageContext(input: ContextInput, ctx: ExtensionContext, native: NativeContext, signal?: AbortSignal,
  runSummary = runContextSummary, approve = confirmContextPacket) {
  const controller = new AbortController(), execution = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let owner: Awaited<ReturnType<typeof openGoalProjectLock>> | undefined, journal: Awaited<ReturnType<typeof openGoalJournal>> | undefined;
  let ownerAttempted = false, journalAttempted = false, state: ContextState = { status: "idle" }, effects: ContextEffect[] = [], timer: ReturnType<typeof setTimeout> | undefined;
  let applicationSnapshot: Awaited<ReturnType<typeof snapshotGoalText>> = null;
  const send = (event: ContextEvent) => { const next = reduceContext(state, event); state = next.state; effects.push(...next.effects); };
  const cancelled = () => { controller.abort(); send({ type: "cancel" }); };
  signal?.addEventListener("abort", cancelled, { once: true });
  const current = async (grant: ContextGrant, requireOwner = true) => {
    execution.throwIfAborted(); await checkContext(grant, execution);
    if (!native.current(grant.body.source)) return fail();
    if (requireOwner) {
      const snapshot = await snapshotGoalText(path.join(grant.body.run.cwd, GOAL_PROJECT_LOCK), execution);
      if (!owner || !snapshot || snapshot.text !== goalLockText(grant) || !isDeepStrictEqual(snapshot.version, owner.version)) return fail();
    }
  };
  const execute = async (effect: ContextEffect): Promise<ContextEvent | undefined> => {
    let recordAttempted = false;
    try {
      switch (effect.type) {
        case "prepare_context": {
          const source = await native.prepare(execution), grant = await prepareContext(effect.input, ctx.cwd, source, execution);
          timer = setTimeout(cancelled, Math.max(1, grant.body.deadline - Date.now()));
          return { type: "prepared", grant };
        }
        case "confirm_context": {
          const approved = await approve(ctx,
          "Approve ONE tool-free context summary?", ["One explicit-profile SDK call / 30 seconds; 180 seconds after preparation, with separate cleanup bounds. No JEV, retries, fallback, worker execution, file tools, transcript forwarding or memory write.",
            "Only the exact prompt below is transmitted. Notes/provenance are claims, not proof. This is a bounded, user-selected summary, NOT automatic coverage of the original conversation.",
            "The native cut is metadata only. A separate exact-output approval is required before native application. Original session entries remain; native pi durability is NOT fsync-acknowledged. Goal approvals never resume.",
            "Create-only synced metadata journal and project ownership marker; uncertain work retains ownership. Parent pi calls/costs are excluded from this one-summary budget. SDK calls are not HTTP/dollar caps.",
            `Effective tools: []; effective thinking: ${effect.grant.body.run.agent.thinking ?? "off"}. Exact system prompt includes the SDK cwd suffix: ${JSON.stringify(effect.grant.body.systemPrompt + "\nCurrent working directory: " + effect.grant.body.run.cwd + "\n")}`,
            JSON.stringify(effect.grant, null, 2)].join("\n\n"), effect.grant.body.approvalDeadline, execution);
          return { type: "approval", digest: effect.grant.ref.scopeDigest, approved, now: Date.now() };
        }
        case "open_context": {
          await current(effect.grant, false); ownerAttempted = true; owner = await openGoalProjectLock(effect.grant, execution);
          journalAttempted = true; journal = await openGoalJournal(effect.grant.body.journalDirectory, "create", execution);
          return { type: "opened", lockVersion: owner.version, now: Date.now() };
        }
        case "context_control": {
          const action = effect.effect;
          if (action.type === "append_goal") {
            if (!journal) return fail();
            return { type: "control", event: await executeGoalStorageEffect(action, journal,
              action.record.type === "settled" || action.record.type === "closed" ? AbortSignal.timeout(10_000) : execution) };
          }
          if (action.type === "stop_goal_operation") { controller.abort(); return undefined; }
          if (action.type === "check_goal_admission") {
            let valid = false;
            try { await current(effect.grant); await checkContextLease(effect.grant, effect.lease, execution); valid = true; } catch { /* Observation only. */ }
            return { type: "control", event: { type: "admission", ref: action.ref, activationId: action.activationId, intentId: action.intent.id, head: action.head, current: valid, now: Date.now() } };
          }
          const observation = await runSummary(effect.grant, effect.lease, execution);
          return { type: "observed", observation, now: Date.now() };
        }
        case "confirm_application": {
          await current(effect.view.grant);
          const approved = await approve(ctx, "Apply this exact summary to the pinned parent branch?", JSON.stringify({
            warning: "Lossy, user-reviewed claims. Original entries remain, but native pi persistence is not fsync-confirmed. No execution, verification or acceptance authority is restored.",
            source: effect.view.grant.body.source, summary: contextSummaryText(effect.view.grant, effect.view.draft!),
            applicationDigest: applicationDigest(effect.view), deadline: effect.view.applyDeadline,
            ledger: "ledger" in effect.view.core ? effect.view.core.ledger : null }, null, 2), effect.view.applyDeadline!, execution);
          return { type: "apply_approval", digest: applicationDigest(effect.view), approved, now: Date.now() };
        }
        case "record_intent": case "record_application": {
          if (effect.type === "record_intent") { await current(effect.view.grant); if (Date.now() >= effect.view.applyDeadline!) return fail(); }
          const filename = path.join(effect.view.grant.body.journalDirectory, CONTEXT_APPLICATION_FILE), kind = effect.type === "record_intent" ? "intent" : "applied";
          const line = JSON.stringify({ version: 1, kind, ref: effect.view.grant.ref, source: effect.view.grant.body.source, digest: applicationDigest(effect.view),
            ...(effect.view.entryId ? { entryId: effect.view.entryId } : {}) }) + "\n";
          recordAttempted = true;
          // The context append adapter remains POSIX-only; never coerce a lossless NTFS ID.
          const journalIdentity = effect.view.grant.body.journalIdentity;
          if (typeof journalIdentity.ino !== "number") return fail();
          const appended = await appendContextFile(filename, { dev: journalIdentity.dev, ino: journalIdentity.ino }, applicationSnapshot, line,
            kind === "applied" ? AbortSignal.timeout(10_000) : execution);
          if (!appended.ok) return { type: "failed", uncertain: appended.uncertain };
          applicationSnapshot = await snapshotGoalText(filename);
          if (!applicationSnapshot || applicationSnapshot.text !== appended.text) return { type: "failed", uncertain: true };
          return { type: "recorded", kind, digest: applicationDigest(effect.view) };
        }
        case "apply_context": {
          const view = effect.view;
          const applied = await native.apply(view.grant.body.source, contextSummaryText(view.grant, view.draft!), view.grant.intentId,
            view.applyDeadline!, () => current(view.grant), execution);
          return { type: "applied", ...applied };
        }
        case "abort_context": controller.abort(); return undefined;
        case "close_context": {
          clearTimeout(timer);
          let ok = false, keep = effect.keep;
          try { ok = await native.close(); } catch { /* Unknown native cleanup retains ownership. */ }
          if (ownerAttempted && !owner || journalAttempted && !journal) ok = false;
          try { await journal?.close(); } catch { ok = false; }
          keep ||= !ok;
          try { if (owner) keep = await owner.close(keep); } catch { ok = false; keep = true; }
          return { type: "closed", ok, retained: keep };
        }
      }
    } catch { return { type: "failed", uncertain: recordAttempted || ownerAttempted && !owner || journalAttempted && !journal }; }
  };
  send({ type: "start", input, available: canConfirmContextPacket(ctx) && !execution.aborted });
  try {
    while (effects.length) { const event = await execute(effects.shift()!); if (event) send(event); }
    const final = state as ContextState;
    if (final.status !== "done") return fail();
    return final.result;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); controller.abort(); }
}

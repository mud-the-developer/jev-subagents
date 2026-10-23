import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkGoalFileScope } from "./goal-file-effects.ts";
import { executeEffect as executeRouteEffect } from "./effects.ts";
import { confirmContextPacket } from "./context-approval.ts";
import { JEV_MODEL } from "./machine.ts";
import { readJevConnection } from "./jev-config.ts";
import { goalFileDigest } from "./goal-files.ts";
import { executeGoalStorageEffect, openGoalJournal, type GoalJournal } from "./goal-journal.ts";
import { GOAL_ASSERTION_EXIT, VERIFICATION_PROBE } from "./goal-verification.ts";
import { prepareVerification, checkVerification, runGoalVerification } from "./goal-verification-effects.ts";
import { GOAL_APPROVAL_MS, GOAL_PROJECT_LOCK, GOAL_RUN_ERROR, GOAL_WORKER_MS, goalWorkerTools, type GoalLease } from "./goal-run.ts";
import { prepareGoalRun, loadGoalProfile, checkGoalContext, openGoalProjectLock, readGoalLeaseSnapshot, runGoalProcess, type GoalProjectOwner } from "./goal-run-effects.ts";
import { GOAL_PLANNER_MS, GOAL_ROUTING_ERROR, SequenceJobSchema, SequenceReplySchema, reduceSequence, sequencePrompts, sequenceSession, singleRunInput,
  sequenceWorkers, sequenceRoutingRequest, sequenceProgress,
  validSequenceInput, validSequenceGrant, validSequenceOperation, sameSequenceScope, operationDigest, operationUnits, sequenceLimits,
  type SequenceInput, type SequenceJob, type SequenceGrant, type SequenceOperation, type SequenceReply, type SequenceObservation,
  type SequenceState, type SequenceEffect, type SequenceEvent } from "./goal-sequence.ts";

const fail = (): never => { throw new Error(GOAL_RUN_ERROR); };
const protections = (grant: SequenceGrant) => ({ journalDirectory: grant.body.journalDirectory, agentDirectory: grant.body.agentDirectory });
export async function prepareSequence(job: SequenceJob, signal?: AbortSignal): Promise<SequenceGrant> {
  try {
    if (!Value.Check(SequenceJobSchema, job) || !validSequenceInput(job.input)) return fail();
    const request = structuredClone(job);
    const base = await prepareGoalRun({ cwd: request.cwd, input: singleRunInput(request.input) }, signal,
      request.input.verification?.files.map((path) => ({ path })) ?? []);
    const verification = request.input.verification ? await prepareVerification(request.input.verification, base.body.run.cwd,
      { journalDirectory: base.body.journalDirectory, agentDirectory: base.body.agentDirectory }, signal) : undefined;
    const { agent: planner, profileVersion, modelConfiguration } = await loadGoalProfile(request.input.planner, base.body.agentDirectory, signal);
    const context = structuredClone(base.body.context), existing = context.find((file) => file.path === planner.file);
    if (existing && !isDeepStrictEqual(existing.version, profileVersion) ||
      !isDeepStrictEqual(context.find((file) => file.path === path.join(base.body.agentDirectory, "models.json"))?.version, modelConfiguration)) return fail();
    if (!existing) context.push({ path: planner.file, version: profileVersion, active: false, text: null });
    const selector = request.input.routing ?? request.input.dispatch;
    const workers = selector ? [base.body.run.agent] : undefined;
    for (const name of selector?.additionalAgents ?? []) {
      const loaded = await loadGoalProfile(name, base.body.agentDirectory, signal);
      const entry = context.find(file => file.path === loaded.agent.file);
      if (!isDeepStrictEqual(loaded.modelConfiguration, modelConfiguration) || entry && !isDeepStrictEqual(entry.version, loaded.profileVersion)) return fail();
      if (!entry) context.push({ path: loaded.agent.file, version: loaded.profileVersion, active: false, text: null });
      workers!.push(loaded.agent);
    }
    if (request.input.routing && workers && workers.length > 1) {
      const configuration = readJevConnection();
      // This separately approved/synced C1 routing contract still pins TypeSafe jev-1.13.0.
      if (!configuration.ok || configuration.connection.backend !== "typesafe") return fail();
    }
    const preparedAt = Date.now(), approvalDeadline = preparedAt + GOAL_APPROVAL_MS;
    const { prompt: _singlePrompt, ...baseBody } = base.body;
    const body: SequenceGrant["body"] = { ...baseBody, request, planner, context, preparedAt, approvalDeadline,
      deadline: approvalDeadline + request.input.budget.durationSeconds * 1000, ...sequencePrompts(base.body.run, base.body.files, context, planner, verification !== undefined, request.input.memory, request.input.dispatch),
      ...(verification ? { verification } : {}), ...(workers ? { workers } : {}) };
    const grant = { ...base, body, ref: { ...base.ref, scopeDigest: goalFileDigest(JSON.stringify(body)) } };
    if (!validSequenceGrant(grant)) return fail();
    await checkGoalContext(grant, signal);
    if (verification) await checkVerification(verification, protections(grant), signal);
    signal?.throwIfAborted();
    return grant;
  } catch { return fail(); }
}
export async function checkSequenceLease(grant: SequenceGrant, lease: GoalLease, operation: SequenceOperation, signal?: AbortSignal): Promise<void> {
  if (!validSequenceGrant(grant) || !validSequenceOperation(grant, operation) || !["verification", "routing"].includes(operation.kind) && Buffer.byteLength(sequenceSession(grant, operation).prompt) > 32_768) return fail();
  const snapshot = await readGoalLeaseSnapshot(grant, lease, signal), { ledger } = snapshot, budget = grant.body.request.input.budget;
  if (ledger.pending?.id !== operation.id || ledger.pending.planDigest !== operationDigest(operation) ||
    !isDeepStrictEqual(ledger.pending.reserve, operationUnits(grant, operation)) || ledger.definition.deadlineMs !== operation.deadline ||
    ledger.definition.maxTotalCalls !== budget.totalCalls || !isDeepStrictEqual(ledger.definition.limits, sequenceLimits(grant))) return fail();
  if (grant.body.request.input.routing && !isDeepStrictEqual(ledger.spent, operation.prior)) return fail();
  if (operation.selection && !snapshot.records.some(record => record.type === "settled" && record.result.outcome === "succeeded" &&
    record.result.accountingComplete && record.result.cleanupConfirmed && isDeepStrictEqual(record.result.routing, operation.selection))) return fail();
  if (!grant.body.verification) {
    if (ledger.spent.workerRuns !== operation.history.length || ledger.spent.plannerCalls !== operation.history.length + (["worker", "routing"].includes(operation.kind) ? 1 : 0)) return fail();
  } else {
    if (!isDeepStrictEqual(ledger.spent, operation.prior)) return fail();
    await checkVerification(grant.body.verification, protections(grant), signal);
    const evidence = snapshot.records.filter((record) => record.type === "settled" && record.result.verification &&
      record.result.outcome === "succeeded" && record.result.accountingComplete && record.result.cleanupConfirmed);
    if (operation.verification?.stage !== "probe" && !evidence.some((record) => record.type === "settled" &&
      record.result.verification?.stage === "probe" && record.result.verification.status === "exited" && record.result.verification.exitCode === 0 &&
      record.result.verification.isolated && record.result.verification.filesCurrent)) return fail();
    if (operation.kind === "repair") {
      const last = evidence.at(-1), cause = operation.repairOf;
      if (!cause || last?.type !== "settled" || last.intentId !== cause.verificationId || last.result.verification?.stage !== "step" ||
        last.result.verification.checkId !== cause.checkId || last.result.verification.status !== "exited" || last.result.verification.exitCode !== GOAL_ASSERTION_EXIT ||
        !last.result.verification.isolated || !last.result.verification.filesCurrent || last.result.verification.sourceDigest !== goalFileDigest(JSON.stringify(operation.scope))) return fail();
    }
  }
}
export async function runSequenceOperation(grant: SequenceGrant, lease: GoalLease, operation: SequenceOperation, signal?: AbortSignal): Promise<SequenceObservation> {
  try { await checkSequenceLease(grant, lease, operation, signal); }
  catch { return { started: false, cleanupConfirmed: true, result: null }; }
  if (operation.kind === "routing") {
    try { await checkGoalFileScope(operation.scope, protections(grant), signal); }
    catch { return { started: false, cleanupConfirmed: true, result: null }; }
    const configuration = readJevConnection();
    if (!configuration.ok || configuration.connection.backend !== "typesafe") return { started: false, cleanupConfirmed: true, result: null,
      routing: { type: "failed", error: GOAL_ROUTING_ERROR }, routingCurrent: false };
    let started = false;
    const response = await executeRouteEffect({ type: "call_jev", request: sequenceRoutingRequest(grant, operation.proposal!.criteriaIds) },
      signal, () => { started = true; }, configuration.connection);
    const routing: NonNullable<SequenceObservation["routing"]> = response.type === "resolved" ? response : response.type === "cancel" ? response :
      { type: "failed" as const, error: GOAL_ROUTING_ERROR, ...("jev" in response && response.jev ? { jev: response.jev } : {}) };
    let routingCurrent = false;
    try {
      await checkSequenceLease(grant, lease, operation, signal);
      await checkGoalFileScope(operation.scope, protections(grant), signal);
      routingCurrent = !signal?.aborted;
    } catch { /* Account the response, but never execute with a stale scope or revoked lease. */ }
    return { started, cleanupConfirmed: true, result: null, routing, routingCurrent };
  }
  if (operation.kind === "verification") {
    if (!grant.body.verification || !grant.body.request.input.verification || !operation.verification) return fail();
    const observed = await runGoalVerification(grant.body.request.input.verification, grant.body.verification, operation.scope, operation.verification,
      { id: operation.id, goalId: grant.ref.goalId, activationId: grant.activationId, deadline: operation.deadline }, protections(grant), async (signal) => {
        await checkSequenceLease(grant, lease, operation, signal);
        await checkGoalFileScope(operation.scope, protections(grant), signal);
      }, signal);
    return { started: observed.started, cleanupConfirmed: observed.cleanupConfirmed, result: null, verification: observed.reply };
  }
  const observation = await runGoalProcess({ script: "goal-sequence-worker.ts", cwd: grant.body.run.cwd, input: { grant, lease, operation },
    deadline: operation.deadline, timeoutMs: operation.kind === "planner" ? GOAL_PLANNER_MS : GOAL_WORKER_MS },
    (value): value is SequenceReply => Value.Check(SequenceReplySchema, value) && value.operationId === operation.id, signal);
  if (observation.result && observation.cleanupConfirmed && sameSequenceScope(operation.scope, observation.result.scope)) {
    try {
      await checkSequenceLease(grant, lease, operation, signal);
      await checkGoalFileScope(observation.result.scope, protections(grant), signal);
    } catch { observation.result.files.finished = false; observation.result.files.uncertain = true; }
  }
  return observation;
}
export async function goalSequence(input: SequenceInput, ctx: ExtensionContext, signal?: AbortSignal,
  onProgress?: (status: string, progress: ReturnType<typeof sequenceProgress>) => void | Promise<void>, runOperation = runSequenceOperation): Promise<SequenceState> {
  let owner: GoalProjectOwner | undefined, journal: GoalJournal | undefined, ownerAttempted = false, journalAttempted = false, cancelled = false;
  const controller = new AbortController(), executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const execute = async (effect: SequenceEffect): Promise<SequenceEvent> => {
    try {
      switch (effect.type) {
        case "prepare_sequence": return { type: "prepared", grant: await prepareSequence(effect.job, executionSignal) };
        case "confirm_sequence": {
          if (!ctx.hasUI) return { type: "failed" };
          const { grant } = effect, input = grant.body.request.input;
          const initial: SequenceOperation = { id: `${grant.intentId}-planner-1`, kind: "planner", deadline: grant.body.deadline, scope: grant.body.files, history: [], proposal: null };
          const packet = [
            "OPT-IN AUTONOMY: approve the displayed goal, exclusions, criteria and derived-task policy, not a prewritten list of tasks. One tool-free planner proposal at a time; one restricted worker per proposal. No repeated approvals inside this exact scope. Decline if you cannot review the full packet.",
            input.verification ? "C2 OPT-IN: one initial worker per approved criterion group, followed by its fixed container check. At most ONE explicitly eligible same-task/same-settings repair across the entire Goal, consuming the existing worker/SDK budgets, followed by the same check. A final all-criteria check follows all groups; its failure NEVER authorizes repair. Checks do not certify requirements; HUMAN TASK ACCEPTANCE IS STILL REQUIRED. No unapproved model changes, resume, re-planning a failed task, or automatic scope expansion." :
              "Each code-assigned criterion ID gets at most one worker attempt. No retry, repair, verifier, unapproved model selection/escalation, automatic memory/compaction, resume or expansion. Invalid/incomplete/uncertain work stops. All results are UNVERIFIED / HUMAN REVIEW REQUIRED. Code cannot prove a proposed task is semantically aligned or that a reported_done claim is true.",
            `Fixed planner: ${JSON.stringify(grant.body.planner.model)}, thinking ${JSON.stringify(grant.body.planner.thinking ?? "off")}, NO TOOLS, 1 SDK call / 30 seconds each. Fixed worker: ${JSON.stringify(grant.body.run.model)}, thinking ${JSON.stringify(grant.body.run.agent.thinking ?? "off")}, tools ${JSON.stringify(goalWorkerTools(grant))}, ${grant.body.run.maxModelCalls} SDK calls / 120 seconds each. No parent-model inheritance.`,
            ...(input.routing ? [
              `JEV OPT-IN: ${JEV_MODEL}; at most ${input.routing.maxCalls} requests, included in the SAME totalCalls ceiling. One candidate skips JEV; the primary agent is NOT a failure fallback. For each NEW task, select only an approved fixed profile/model/thinking combination. An eligible repair REUSES the original selection with no new JEV request. Missing/invalid/weak support (<0.5), failures and uncertainty stop, never substitute or escalate. Support is uncalibrated advice, not proof of model quality.`,
              `JEV transmission policy: ONLY this explicit summary, the assigned subset of these already-approved criterion IDs/text, and these exact candidate rubrics: ${JSON.stringify(sequenceRoutingRequest(grant, input.acceptanceCriteria.map((_, i) => `criterion-${i + 1}`)))}. No derived planner task, source, paths, profile prompts, worker claims, check results, memory, logs, diffs or conversation. One request/10 seconds/64 KiB response, no retry or redirect. This is routing, NOT completion assessment.`,
              ...sequenceWorkers(grant).map(agent => `Allowed worker: ${JSON.stringify({ name: agent.name, model: agent.model, thinking: agent.thinking ?? "off",
                tools: goalWorkerTools({ body: { files: grant.body.files, run: { ...grant.body.run, agent, model: agent.model } } }) })}; exact system prompt (JSON string): ${JSON.stringify(sequencePrompts({ ...grant.body.run, agent, model: agent.model }, grant.body.files,
                  grant.body.context, grant.body.planner, input.verification !== undefined, input.memory).systemPrompt + "\nCurrent working directory: " + grant.body.run.cwd + "\n")}`),
            ] : input.dispatch ? [
              `PARENT DISPATCH: the parent supplied these exact criterion→worker assignments before approval: ${JSON.stringify(input.dispatch.assignments)}. No JEV request, fabricated support or runtime model choice. Each derived task must contain criteria assigned to exactly one permitted worker; ambiguous/missing/out-of-scope assignments STOP. No per-subtask approval inside this ONE approved Goal. No new profile, scope, file, tool or budget may be admitted. Repairs preserve the original worker.`,
              ...sequenceWorkers(grant).map(agent => `Parent-permitted worker: ${JSON.stringify({ name: agent.name, model: agent.model, thinking: agent.thinking ?? "off",
                tools: goalWorkerTools({ body: { files: grant.body.files, run: { ...grant.body.run, agent, model: agent.model } } }) })}; exact system prompt: ${JSON.stringify(sequencePrompts({ ...grant.body.run, agent, model: agent.model }, grant.body.files, grant.body.context,
                  grant.body.planner, input.verification !== undefined, input.memory, input.dispatch).systemPrompt + "\nCurrent working directory: " + grant.body.run.cwd + "\n")}`),
            ] : ["No JEV routing or model changes in this fixed-worker activation."]),
            `Cumulative budget: ${JSON.stringify(input.budget)}; duration starts at approval. SDK stream invocations, not HTTP attempts, tokens or an invoice cap. These budgets/estimates exclude the parent pi session and container infrastructure costs. Only confirmed unused allocation is released; unknowns retain reservations and stop. Planner needs enough remaining allocation for itself plus a full worker reservation.`,
            "Planner transmission: these exact instructions/profile, goal, exclusions, criterion IDs/text, approved file metadata (IDs/paths/access/bytes/digests), budgets and code-owned attempted_unverified history (derived task, IDs, call/file counts/change flag, any accounted repair metadata). C2 also supplies the approved criterion groups, not checker source/argv/runtime details. No file contents, worker summaries/raw responses, diffs, logs, memory or parent conversation. Worker transmission: exact approved instructions/profile, original goal/exclusions/criteria, one validated derived task and current approved file metadata; selected file content through the approved tools. Only an eligible C2 repair adds original worker/check operation IDs, check ID and exit code 42; never logs, diffs, new criteria or raw prior replies. No source/history is automatically sent to JEV or another service.",
            "64 file requests per worker (at most 192 total); same existing file IDs/access across all steps: at most 16 files, UTF-8, 32 KiB each / 128 KiB total. No file creation/deletion/rename/discovery/bash/process/network tools. Worker file tools are not an OS sandbox, external-editor lock, atomic save or rollback. SDK model/auth runtime is trusted; paid model or subscription usage applies.",
            `Host marker ${path.join(grant.body.run.cwd, GOAL_PROJECT_LOCK)} and create-only journal ${grant.body.journalDirectory}. Exclusive ownership; only own marker removed after confirmed cleanup. Unknowns retain it. Identical roots only; no overlapping-root isolation. No stale-owner takeover, journal reuse, automatic recovery, reset via renaming, deletion or retention cleanup. goal.jsonl stores metadata/digests/accounting, not prompts/file bodies or reusable approval.`,
            ...(input.verification ? [
              `EXACT C2 CHECK CONTRACT: ${JSON.stringify(input.verification)}. You register each entry and its coverage/dispatch dependencies in verification.files, which cannot overlap writable worker files. Those files are fixed for the activation. Hash equality does not prove all transitive dependencies or semantic coverage; the pinned image and checker are trusted. Do not register a command whose test-selection/configuration can be weakened through a writable worker file.`,
              "Local trusted Docker-compatible Engine API v1.47 over this explicit Unix socket only. No context discovery, remote endpoint, image pull, package install or host fallback. Linux image must already exist by exact sha256 ID, include the declared Node >=22 with --disable-sigusr1 support plus /bin/sh and id, and contain needed dependencies. Linux cgroup v2/builtin seccomp and Yama ptrace_scope 1-3 are required; unsupported runtime settings fail closed. Only the named worker + checker files are copied/mounted at /workspace/<path>; no whole-project mount/discovery, host credentials, Docker socket, or implicit omitted files. Image contents are also readable. Temporary private input snapshots are created under the approved journal and may remain on uncertainty; do not treat them as reusable approval.",
              "Each check: literal command/argv under a pinned PID-1 guard, non-root UID, private PID/IPC/cgroup namespaces, network none, read-only image/input mounts, capabilities ALL dropped, no-new-privileges, no healthchecks/restarts/output logs, 128 PIDs, 256 MiB memory/no swap, 1 CPU, 64 MiB private /tmp. Image/host environment values are not inherited. 30s independent child deadline plus the approved activation deadline; daemon clock must match within 1s. SIGUSR1 inspection is disabled and Yama restricts same-UID debugging of PID 1. Sources/checkers/socket/guard are rechecked after cleanup too; offline fixtures are not proof of actual container isolation. Normal exit is not cleanup: namespace termination and container removal must be acknowledged before another operation. Missing support or uncertain cleanup retains ownership and stops.",
              `One pre-worker sandbox probe also consumes the explicit verification-run budget: /bin/sh ${JSON.stringify(["-c", VERIFICATION_PROBE])}, under the same Node guard/resource policy with disposable canaries only. The guard entrypoint is the exact nodePath with --disable-sigusr1, argv [\"/jev/guard.mjs\", JSON.stringify({command,args,deadline})]; working directory /workspace, no implicit shell around registered commands. Probe/start/runtime/transport/configuration/timeout/OOM/signal failures NEVER authorize repair.`,
              "Repair protocol: generic nonzero codes (including npm/Jest/pytest exit 1) are UNKNOWN CAUSE and stop. Only the separately registered exit_42_assertions_only contract means that this immutable checker deliberately returns 42 for a completed assertion failure and no setup/auth/transport/configuration error. Do not use an unconditional `|| exit 42` wrapper. If that meaning cannot be established, select no_automatic_repair. The code is evidence from the trusted checker, not a semantic proof. Persist/acknowledge the exact failure first; require a normal accounted/cleaned-up worker, fresh unchanged files/checks, remaining repair + recheck + final-check budgets. Never repair a final-check failure or an already repaired item.",
            ] : []),
            "Approval expires after 60 seconds. Navigation/fork/tree/compaction/shutdown revokes this activation and awaits cleanup. Stopping is not rollback; prior edits and charges remain.",
            `Exact planner system prompt (JSON string): ${JSON.stringify(grant.body.plannerSystemPrompt + "\nCurrent working directory: " + grant.body.run.cwd + "\n")}`,
            `Exact worker system prompt (JSON string): ${JSON.stringify(grant.body.systemPrompt + "\nCurrent working directory: " + grant.body.run.cwd + "\n")}`,
            `Initial planner packet and subsequent packet policy: ${sequenceSession(grant, initial).prompt}`,
            "Worker packets use the same goal/nonGoals/criteria/files/verification/taskAcceptance keys; assigned is the validated work proposal and maxFileRequests is 64. C2 repairOf adds only the approved short failure facts. No planner-selected profile, model, tools, argv, directory, criteria text or budgets are accepted. All IDs attempted ends C1; C2 additionally requires its step/rechecks and final check. Neither certifies the task.",
            JSON.stringify(grant, null, 2),
          ].join("\n\n");
          const approved = input.routing ? await confirmContextPacket(ctx, "Approve this JEV-routed bounded Goal?", packet, grant.body.approvalDeadline, executionSignal) :
            await ctx.ui.confirm("Approve this bounded sequential Goal?", packet, { signal: executionSignal, timeout: Math.max(1, grant.body.approvalDeadline - Date.now()) });
          return { type: "approval", digest: grant.ref.scopeDigest, approved: approved === true, now: Date.now() };
        }
        case "open_sequence": {
          executionSignal.throwIfAborted();
          if (Date.now() >= effect.deadline) return { type: "failed" };
          // A relative activation timer also fences wall-clock rollback and time spent between children.
          deadlineTimer = setTimeout(() => controller.abort(), Math.max(1, Math.min(effect.grant.body.request.input.budget.durationSeconds * 1000, effect.deadline - Date.now())));
          deadlineTimer.unref();
          await checkGoalContext(effect.grant, executionSignal);
          await checkGoalFileScope(effect.grant.body.files, protections(effect.grant), executionSignal);
          if (effect.grant.body.verification) await checkVerification(effect.grant.body.verification, protections(effect.grant), executionSignal);
          ownerAttempted = true;
          owner = await openGoalProjectLock(effect.grant, executionSignal);
          executionSignal.throwIfAborted();
          journalAttempted = true;
          journal = await openGoalJournal(effect.grant.body.journalDirectory, "create", executionSignal);
          return { type: "opened", lockVersion: owner.version, now: Date.now() };
        }
        case "sequence_control": {
          const current = effect.effect;
          if (current.type === "append_goal") {
            if (!journal) return { type: "failed" };
            return { type: "control", event: await executeGoalStorageEffect(current, journal,
              current.record.type === "settled" || current.record.type === "closed" ? AbortSignal.timeout(10_000) : executionSignal) };
          }
          if (current.type === "stop_goal_operation") { controller.abort(); return { type: "stop_ack" }; }
          if (current.type === "check_goal_admission") {
            let currentAuthority = false;
            try {
              if (!journal || !effect.operation || !isDeepStrictEqual((await journal.load()).head, current.head)) return fail();
              await checkSequenceLease(effect.grant, effect.lease, effect.operation, executionSignal);
              await checkGoalFileScope(effect.operation.scope, protections(effect.grant), executionSignal);
              currentAuthority = !executionSignal.aborted;
            } catch { /* False is an observation, never substitute permission. */ }
            return { type: "control", event: { type: "admission", ref: current.ref, activationId: current.activationId,
              intentId: current.intent.id, head: current.head, current: currentAuthority, now: Date.now() } };
          }
          if (!effect.operation) return fail();
          let observation: SequenceObservation;
          try { observation = await runOperation(effect.grant, effect.lease, effect.operation, executionSignal); }
          catch { observation = { started: true, cleanupConfirmed: false, result: null }; }
          return { type: "observed", operationId: effect.operation.id, observation, now: Date.now() };
        }
        case "close_sequence": {
          clearTimeout(deadlineTimer);
          let ok = (!ownerAttempted || owner !== undefined) && (!journalAttempted || journal !== undefined), keep = effect.keepLock || !ok;
          try { await journal?.close(); } catch { ok = false; keep = true; }
          try { keep = owner ? await owner.close(keep) : keep; } catch { ok = false; keep = true; }
          return { type: "closed", ok, lockRetained: keep };
        }
      }
    } catch { return { type: "failed" }; }
  };
  let transition = reduceSequence({ status: "idle" }, { type: "start", job: { cwd: ctx.cwd, input }, hasUI: ctx.hasUI });
  let queue = [...transition.effects];
  while (queue.length) {
    const state = transition.state;
    try { void Promise.resolve(onProgress?.(state.status === "working" ? state.core.status === "active" ? state.operation?.kind === "planner" ? "planning" : state.operation?.kind === "routing" ? "goal_routing" : state.operation?.kind === "verification" ? "goal_verifying" : state.operation?.kind === "repair" ? "goal_repairing" : "active" : state.core.status : state.status, sequenceProgress(state))).catch(() => {}); } catch { /* Presentation is not authority. */ }
    const event = await execute(queue.shift()!);
    if (signal?.aborted && !cancelled) { cancelled = true; transition = reduceSequence(transition.state, { type: "cancel" }); queue = [...transition.effects]; }
    transition = reduceSequence(transition.state, event);
    queue.push(...transition.effects);
  }
  return transition.state;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { ordinaryRoutingTasks, ordinaryScopeDigest, ordinarySelectionPlan, reduceOrdinaryAuthorization as reduce,
  validOrdinaryScopeInput, type OrdinaryPreparedScope, type OrdinaryAuthorizationState, type OrdinaryAuthorizationEvent } from "../src/ordinary-authorization.ts";
import { ordinaryContextDigest, ordinaryRun, validOrdinaryWorkerInput } from "../src/ordinary-protocol.ts";
import { ordinaryApprovalText } from "../src/ordinary-effects.ts";
import { ordinaryPlanView, planReceipt, validPlanReceipt } from "../src/plan-state.ts";
import { progressReceiver, WorkerProgressSchema } from "../src/worker-progress.ts";
import { Value } from "typebox/value";
import { memoryDigest, memoryProjectKey, memorySnapshot } from "../src/project-memory.ts";
import { ordinaryPrompts } from "../src/ordinary-protocol.ts";

function fixture(): OrdinaryPreparedScope {
  const model = { provider: "offline", id: "fixture" };
  return { id: "plan", sessionId: "session", approvalDeadline: null, contextDigest: ordinaryContextDigest([], "/account"),
    routingTarget: "Approved anonymous JEV fixture", fileProtocol: "scoped_existing_files",
    input: { task: "Implement one approved approach, then review.", agents: ["worker"], files: [{ path: "sample.txt", access: "read_write" }],
      tasks: [{ id: "implement", summary: "Choose an approved implementation.", agent: "worker", after: [],
        alternatives: [{ id: "a", summary: "PRIVATE_A_INPUT", description: "Use the existing parser." },
          { id: "b", summary: "PRIVATE_B_INPUT", description: "Use a bounded parser replacement." }] },
        { id: "review", summary: "Review the resulting approved file.", after: ["implement"], agent: "worker" }],
      selection: "parent_or_jev", limits: { workerRuns: 2, seconds: 86400, modelCalls: 4, perWorkerCalls: 2 } },
    agents: [{ name: "worker", model, file: "/account/agents/worker.md", description: "Approved file work.", systemPrompt: "Use approved file IDs only.", tools: ["read", "edit"] }],
    workerTargets: [{ agent: "worker", api: "openai-completions", endpoint: "http://127.0.0.1:8000/v1" }],
    files: { id: "files", root: "/workspace", rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "sample.txt", access: "read_write",
      version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 7 } }] } };
}
function approved(scope: OrdinaryPreparedScope) {
  let state: OrdinaryAuthorizationState = { phase: "idle" };
  for (const event of [{ type: "start", input: scope.input, sessionId: scope.sessionId, now: 1000 },
    { type: "prepared", grant: scope, now: 1001 }, { type: "approval", id: scope.id, digest: ordinaryScopeDigest(scope), approved: true, now: 1002 }] as OrdinaryAuthorizationEvent[]) state = reduce(state, event).state;
  assert.equal(state.phase, "selecting"); return state;
}

test("approved A/B plans require explicit JEV policy, unique branches and topological dependencies", () => {
  const scope = fixture(); assert.equal(validOrdinaryScopeInput(scope.input), true);
  assert.equal(ordinaryRoutingTasks(scope.input).length, 1);
  for (const change of [
    { ...scope.input, selection: "parent_only" },
    { ...scope.input, tasks: [{ ...scope.input.tasks[0]!, after: ["implement"] }] },
    { ...scope.input, tasks: [{ ...scope.input.tasks[0]!, after: ["review"] }, scope.input.tasks[1]!] },
    { ...scope.input, tasks: [{ ...scope.input.tasks[0]!, alternatives: [scope.input.tasks[0]!.alternatives![0]!, scope.input.tasks[0]!.alternatives![0]!] }] },
  ]) assert.equal(validOrdinaryScopeInput(change), false);
  const plan = ordinarySelectionPlan(scope, "implement"); assert.equal(plan?.source, "jev");
  if (plan?.source !== "jev") assert.fail();
  assert.deepEqual(plan.choices.map(choice => choice.alternativeId), ["a", "b"]);
  assert.equal(JSON.stringify(plan.request).includes("PRIVATE_A_INPUT"), false);
  assert.equal(JSON.stringify(plan.request).includes("PRIVATE_B_INPUT"), false);
});

test("only a selected approved alternative reaches the worker; failures never execute the other branch", () => {
  const scope = fixture(), state = approved(scope);
  const selected = reduce(state, { type: "selected", id: scope.id, taskId: "implement", selection: { source: "jev", agent: "worker", alternativeId: "b" }, now: 1003 });
  assert.equal(selected.state.phase, "checking");
  const changed = reduce(selected.state, { type: "stop", reason: "changed", now: 1004 }).state;
  assert.equal(ordinaryPlanView(scope, changed, 1, undefined, "implement").nodes[0]?.alternatives?.find(choice => choice.id === "b")?.selected, true);
  for (const selection of [{ source: "parent", agent: "worker", alternativeId: "b" }, { source: "jev", agent: "worker", alternativeId: "outside" }]) {
    assert.equal(reduce(state, { type: "selected", id: scope.id, taskId: "implement", selection, now: 1003 } as OrdinaryAuthorizationEvent).state.phase, "revoked");
  }
  const running = reduce(selected.state, { type: "fresh", id: scope.id, taskId: "implement", sessionId: scope.sessionId,
    digest: ordinaryScopeDigest(scope), current: true, now: 1004 });
  assert.equal(running.state.phase, "running");
  const run = ordinaryRun(scope, "implement", scope.agents[0]!, 2, "b"); assert.equal(run.task, "PRIVATE_B_INPUT");
  const dto = { scope, digest: ordinaryScopeDigest(scope), taskId: "implement", alternativeId: "b", run, context: [], agentDirectory: "/account",
    files: scope.files, lockVersion: scope.files.files[0]!.version, approvedAt: 1002, deadline: 86401002 };
  assert.equal(validOrdinaryWorkerInput(dto), true);
  assert.equal(validOrdinaryWorkerInput({ ...dto, alternativeId: "a" }), false);
  assert.equal(validOrdinaryWorkerInput({ ...dto, alternativeId: undefined }), false);
  const failed = reduce(running.state, { type: "observed", id: scope.id, taskId: "implement", now: 1005,
    observation: { outcome: "failed", modelCalls: 1, accountingComplete: true, cleanupConfirmed: true, files: scope.files } });
  assert.equal(failed.state.phase, "revoked"); assert.deepEqual(failed.effects, []);
  assert.deepEqual(reduce(failed.state, { type: "selected", id: scope.id, taskId: "implement", selection: { source: "jev", agent: "worker", alternativeId: "a" }, now: 1006 }).state, failed.state);
});

test("native preview includes every exact alternative, while progress receipts contain only safe identifiers", () => {
  const scope = fixture(), state = approved(scope);
  const doc = ordinaryApprovalText({ scope, context: [], agentDirectory: "/account" });
  for (const alternative of scope.input.tasks[0]!.alternatives!) assert.ok(doc.includes(alternative.summary));
  assert.ok(doc.includes("A/B")); assert.ok(doc.includes("DAG"));
  const view = ordinaryPlanView(scope, state, 1), receipt = planReceipt(view);
  assert.equal(validPlanReceipt(receipt), true);
  assert.equal(JSON.stringify(receipt).includes("Choose an approved"), false);
  assert.equal(validPlanReceipt({ ...receipt, nodes: [{ ...receipt.nodes[0], title: "PRIVATE_PROMPT" }] }), false);
  assert.equal(validPlanReceipt({ ...receipt, PRIVATE_ARGS: "hidden" }), false);
  assert.equal(validPlanReceipt({ get phase() { throw new Error("PRIVATE_UI_VALUE"); } }), false);
});

test("reviewed memory snapshots bind the current project and exact child prompt without backend authority", () => {
  const scope = fixture();
  scope.input.memorySnapshot = memorySnapshot({ version: 1, projectKey: memoryProjectKey(scope.files.root), revision: 1,
    facts: [{ id: "fact_a", kind: "decision", title: "Public memory title", content: "PRIVATE_MEMORY_REFERENCE", provenance: "Parent review only.", createdRevision: 1 }], edges: [] }, ["fact_a"]);
  assert.equal(validOrdinaryScopeInput(scope.input), true);
  const doc = ordinaryApprovalText({ scope, context: [], agentDirectory: "/account" }); assert.match(doc, /PRIVATE_MEMORY_REFERENCE/);
  const routing = ordinarySelectionPlan(scope, "implement"); assert.doesNotMatch(JSON.stringify(routing), /PRIVATE_MEMORY_REFERENCE/);
  const run = ordinaryRun(scope, "implement", scope.agents[0]!, 2, "b"), prompt = ordinaryPrompts(scope, scope.agents[0]!, run.task, []);
  assert.match(prompt.systemPrompt, /Untrusted historical reference data/); assert.match(prompt.systemPrompt, /PRIVATE_MEMORY_REFERENCE/);
  assert.deepEqual(run.agent.tools, ["read", "edit"]); assert.equal(run.task, "PRIVATE_B_INPUT");
  const dto = { scope, digest: ordinaryScopeDigest(scope), taskId: "implement", alternativeId: "b", run, context: [], agentDirectory: "/account",
    files: scope.files, lockVersion: scope.files.files[0]!.version, approvedAt: 1002, deadline: 86401002 };
  assert.equal(validOrdinaryWorkerInput(dto), true);
  const tampered = structuredClone(dto); tampered.scope.input.memorySnapshot!.records[0]!.content = "CHANGED_MEMORY";
  assert.equal(validOrdinaryWorkerInput(tampered), false);
  const foreign = structuredClone(scope), snapshot = foreign.input.memorySnapshot!; snapshot.projectKey = memoryProjectKey("/other");
  snapshot.digest = memoryDigest({ version: snapshot.version, projectKey: snapshot.projectKey, revision: snapshot.revision, records: snapshot.records });
  assert.equal(validOrdinaryWorkerInput({ ...dto, scope: foreign, digest: ordinaryScopeDigest(foreign) }), false);
});

test("progress frames are advisory, bounded, monotonic and never accept private fields or final results", () => {
  const frames: unknown[] = [], receive = progressReceiver(frame => { frames.push(frame); });
  const frame = { type: "jev_worker_progress", version: 1, sequence: 1, phase: "model_request", elapsedMs: 0, modelCalls: 1, toolCalls: 0 };
  assert.equal(Value.Check(WorkerProgressSchema, frame), true);
  assert.equal(receive(frame), "accepted"); assert.equal(frames.length, 1);
  assert.equal(receive(frame), "invalid");
  assert.equal(receive({ ...frame, sequence: 2, modelCalls: 0 }), "invalid");
  assert.equal(receive({ ...frame, sequence: 2, PRIVATE_ARGS: "secret" }), "invalid");
  assert.equal(receive({ ...frame, sequence: 2, currentTool: "PRIVATE_COMMAND" }), "invalid");
  assert.equal(receive({ type: "completed" }), "not_progress");
  assert.equal(receive({ ...frame, sequence: 2, elapsedMs: 1, toolCalls: 1, phase: "tool_start", currentTool: "scope_read" }), "accepted");
});

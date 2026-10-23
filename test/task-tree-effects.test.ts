import assert from "node:assert/strict";
import { accessFixture } from "./helpers/delegation-access-fixture.ts";
import { test } from "node:test";
import { taskTree, taskTreeApproval } from "../src/task-tree-effects.ts";
import { taskTreeOwner } from "../src/task-tree-owner.ts";
import { treeTasks, treeOptions, treeRequest, treeDigest } from "../src/task-tree.ts";
import { treeFixture, treeRouting } from "./helpers/task-tree-fixture.ts";
import type { TreeWorkerInput } from "../src/task-tree-protocol.ts";
import { DirectoryValidationError } from "../src/directory-diagnostics.ts";

const jev = { model: "openjev-0.1", provider: "openjev" as const, usage: { inputTokens: 1, outputTokens: 1 } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function mutationFixture() {
  const f = treeFixture(); f.tree.agents[0]!.tools = ["read", "edit"];
  treeTasks(f.input).forEach(task => { task.mode = "mutation"; }); f.input.files = [{ path: "sample.txt", access: "read_write" }];
  f.tree.files = { id: "files", root: f.tree.cwd, rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "sample.txt", access: "read_write", version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 1 } }] };
  f.io.run = async packet => {
    assert.ok(packet.files); f.packets.push(structuredClone(packet));
    return { started: true, cleanupConfirmed: true, result: { type: "goal_result", scope: packet.files,
      files: { operations: 0, readBytes: 0, writtenBytes: 0, changed: false, uncertain: false, finished: true }, reply: f.reply() } };
  };
  return f;
}
test("reviewed English labels travel only to the human observer, never plans, routing or child packets", async t => {
  const f = treeFixture(); let approvals = 0;
  const observations: { view: unknown; labels: Readonly<Record<string, string>> | undefined; approvals: number }[] = [];
  f.input.display = { labels: { a: "DISPLAY_ONLY_INSPECT", b: "DISPLAY_ONLY_TESTS", c: "DISPLAY_ONLY_REVIEW" } };
  f.ctx.ui.confirm = async (_title, packet) => { assert.match(packet, /DISPLAY_ONLY_INSPECT/); approvals++; return true; };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io, (view, labels) => {
    observations.push({ view: structuredClone(view), labels: labels ? { ...labels } : undefined, approvals });
  });
  assert.equal(result.status, "completed_unverified"); assert.ok(observations.some(row => row.labels));
  for (const row of observations) {
    assert.doesNotMatch(JSON.stringify(row.view), /DISPLAY_ONLY|PRIVATE_TASK/);
    if (row.labels) { assert.equal(row.approvals, 1); assert.equal(row.labels.a, "DISPLAY_ONLY_INSPECT"); }
    else assert.equal(row.approvals, 0);
  }
  assert.doesNotMatch(JSON.stringify(result), /DISPLAY_ONLY/);
  assert.doesNotMatch(JSON.stringify(f.packets), /DISPLAY_ONLY/);
  assert.doesNotMatch(JSON.stringify(treeRequest(f.tree, "a")), /DISPLAY_ONLY/);
  const changed = structuredClone(f.tree); changed.input.display!.labels!.a = "Different reviewed label";
  assert.notEqual(treeDigest(changed), treeDigest(f.tree));
});
test("unlabelled legacy trees use fixed English role text rather than private task summaries", async t => {
  for (const mutation of [false, true]) {
    const f = mutation ? mutationFixture() : treeFixture(), seen: string[] = [];
    const result = await taskTree(f.input, f.ctx, t.signal, f.io, (_view, labels) => { if (labels) seen.push(...Object.values(labels)); });
    assert.equal(result.status, "completed_unverified"); assert.ok(seen.length > 0);
    assert.ok(seen.every(text => text === (mutation ? "Apply approved file-ID changes" : "Read assigned source")));
    assert.doesNotMatch(seen.join("\n"), /PRIVATE_TASK/);
  }
});
test("tree freshness reads overlap without acquiring ownership or dispatching from partial checks", { timeout: 5000 }, async t => {
  const f = mutationFixture();
  let contextStarted = false, filesStarted = false, releaseContext!: () => void, releaseFiles!: () => void;
  const context = new Promise<void>(resolve => { releaseContext = resolve; }), files = new Promise<void>(resolve => { releaseFiles = resolve; });
  f.io.context = async () => { if (!contextStarted) { contextStarted = true; await context; } };
  f.io.files = async () => { if (!filesStarted) { filesStarted = true; await files; } };
  const work = taskTree(f.input, f.ctx, t.signal, f.io);
  try {
    while (!contextStarted) await tick();
    assert.equal(filesStarted, true); assert.equal(f.counts().owners, 0); assert.equal(f.packets.length, 0);
    releaseContext(); await tick(); assert.equal(f.counts().owners, 0); assert.equal(f.packets.length, 0);
    releaseFiles(); assert.equal((await work).status, "completed_unverified");
  } finally { releaseContext(); releaseFiles(); await work; }
});
test("parallel read lanes serialize exclusive file-scope checks without serializing workers", { timeout: 5000 }, async t => {
  const f = mutationFixture(), tasks = treeTasks(f.input);
  tasks[0]!.mode = "read"; tasks[1]!.mode = "read"; tasks[2]!.agents = ["writer"];
  f.tree.agents = [{ ...f.tree.agents[0]!, tools: ["read"] }, { ...f.tree.agents[0]!, name: "writer", tools: ["read", "edit"] }];
  f.tree.targets = [...f.tree.targets, { ...f.tree.targets[0]!, agent: "writer" }];
  const run = f.io.run; let activeFiles = 0, checks = 0, activeWorkers = 0, peakWorkers = 0, readers = 0;
  let releaseReaders!: () => void; const together = new Promise<void>(resolve => { releaseReaders = resolve; });
  t.after(() => releaseReaders());
  f.io.files = async () => {
    assert.equal(activeFiles++, 0, "Exclusive file checks must never overlap"); checks++;
    try { await new Promise(resolve => setTimeout(resolve, 10)); } finally { activeFiles--; }
  };
  f.io.run = async (packet, signal, progress) => {
    if (packet.task.mode === "mutation") return run(packet, signal, progress);
    activeWorkers++; peakWorkers = Math.max(peakWorkers, activeWorkers);
    if (++readers === 2) releaseReaders();
    try { await together; return { started: true, cleanupConfirmed: true, result: f.reply() }; } finally { activeWorkers--; }
  };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(result.cleanupConfirmed, true);
  assert.equal(peakWorkers, 2); assert.ok(checks > 2); assert.equal(activeFiles, 0);
});
test("tree read failure and cancellation retain an owner when late sibling cleanup is unknown", { timeout: 5000 }, async () => {
  for (const cancel of [false, true]) {
    const f = mutationFixture(), controller = new AbortController();
    let contextStarted = false, filesStarted = false, kept: boolean | undefined, releaseContext!: () => void, releaseFiles!: () => void;
    const context = new Promise<void>(resolve => { releaseContext = resolve; }), files = new Promise<void>(resolve => { releaseFiles = resolve; });
    const own = f.io.own; f.io.own = async (...args) => { const owner = await own(...args); return { ...owner, close: async keep => { kept = keep; return owner.close(keep); } }; };
    f.io.context = async () => { if (f.counts().owners && !contextStarted) { contextStarted = true; await context; throw new Error("Synthetic early refusal"); } };
    f.io.files = async () => { if (f.counts().owners && !filesStarted) { filesStarted = true; await files; throw new DirectoryValidationError("Fixed", "helper_timeout", false); } };
    const work = taskTree(f.input, f.ctx, controller.signal, f.io);
    try {
      while (!contextStarted) await tick(); assert.equal(filesStarted, true); assert.equal(f.packets.length, 0);
      if (cancel) controller.abort();
      releaseContext(); await tick(); assert.equal(kept, undefined);
      releaseFiles(); const result = await work;
      assert.equal(result.status, "stopped"); assert.equal(result.cleanupConfirmed, false); assert.equal(result.lockRetained, true);
      assert.equal(kept, true); assert.equal(f.packets.length, 0);
    } finally { releaseContext(); releaseFiles(); await work; }
  }
});
test("tree drains uncertain file cleanup after a concurrent canonical refusal", { timeout: 5000 }, async t => {
  const f = mutationFixture(), canonical = f.io.canonical, own = f.io.own;
  let canonicalRefused = false, filesStarted = false, kept: boolean | undefined, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.io.own = async (...args) => { const owner = await own(...args); return { ...owner, close: async keep => { kept = keep; return owner.close(keep); } }; };
  f.io.canonical = async (...args) => {
    if (f.counts().owners) { canonicalRefused = true; return "C:\\changed"; }
    return canonical(...args);
  };
  f.io.files = async () => { if (f.counts().owners) { filesStarted = true; await pending; throw new DirectoryValidationError("Fixed", "helper_timeout", false); } };
  const work = taskTree(f.input, f.ctx, t.signal, f.io);
  try {
    for (let attempt = 0; !filesStarted && attempt < 100; attempt++) await tick();
    assert.equal(filesStarted, true); assert.equal(canonicalRefused, true); assert.equal(kept, undefined); assert.equal(f.packets.length, 0);
    release(); const result = await work;
    assert.equal(result.status, "stopped"); assert.equal(result.cleanupConfirmed, false); assert.equal(result.lockRetained, true);
    assert.equal(kept, true); assert.equal(f.packets.length, 0);
  } finally { release(); await work; }
});
test("real effect dispatch overlaps independent branches and admits a descendant while its unrelated sibling is still running", { timeout: 5000 }, async t => {
  const f = treeFixture(), starts: string[] = [], releases = new Map<string, () => void>(), packets: TreeWorkerInput[] = [];
  f.io.run = async input => await new Promise(resolve => { starts.push(input.task.id); packets.push(input); releases.set(input.task.id, () => resolve({ started: true, cleanupConfirmed: true, result: f.reply() })); });
  const work = taskTree(f.input, f.ctx, t.signal, f.io);
  while (starts.length < 2) await tick(); assert.deepEqual(starts, ["a", "b"]); assert.equal(f.counts().confirmations, 1);
  releases.get("a")!(); while (starts.length < 3) await tick(); assert.deepEqual(starts, ["a", "b", "c"]);
  assert.equal(new Set(packets.map(packet => packet.deadline)).size, 1); assert.equal(new Set(packets.map(packet => packet.approvedAt)).size, 1);
  releases.get("b")!(); releases.get("c")!(); const result = await work;
  assert.equal(result.status, "completed_unverified"); assert.equal(result.metrics.peak, 2); assert.equal(result.metrics.modelCalls, 3); assert.equal(result.metrics.jevRequests, 0);
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.taskAcceptance, "needs_human_review");
});
test("all strict literal native reviews precede every child; any decline/nonliteral/missing UI launches zero", async t => {
  for (const denied of [false, "true", 1, null]) {
    const f = treeFixture(); f.tree.policy.approval.level = "strict"; let reviews = 0;
    f.ctx.ui.confirm = async () => { assert.equal(f.packets.length, 0); return ++reviews === 2 ? denied as boolean : true; };
    const result = await taskTree(f.input, f.ctx, t.signal, f.io);
    assert.equal(result.status, "stopped"); assert.equal(result.metrics.workersStarted, 0); assert.equal(result.metrics.jevRequests, 0); assert.equal(reviews, 2);
  }
  const f = treeFixture(); const result = await taskTree(f.input, { ...f.ctx, hasUI: false }, t.signal, f.io);
  assert.equal(result.metrics.workersStarted, 0); assert.equal(f.counts().preparations, 0);
});
test("strict mutation denial acquires no writer marker before all required replies", async t => {
  const f = treeFixture(); f.tree.policy.approval.level = "strict"; f.tree.agents[0]!.tools = ["read", "edit"];
  treeTasks(f.input).forEach(task => { task.mode = "mutation"; }); f.input.files = [{ path: "sample.txt", access: "read_write" }];
  f.tree.files = { id: "files", root: f.tree.cwd, rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "sample.txt", access: "read_write", version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 1 } }] };
  let reviews = 0; f.ctx.ui.confirm = async () => { assert.equal(f.counts().owners, 0); return ++reviews !== 2; };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io); assert.equal(result.status, "stopped"); assert.equal(result.metrics.workersStarted, 0); assert.equal(f.counts().owners, 0);
});
test("initial approval has no timer and last actual reply, not preparation, starts the shared deadline", async t => {
  const f = treeFixture(); let reply!: (value: boolean) => void;
  f.ctx.ui.confirm = async (_title, _text, options) => { assert.equal(options?.timeout, undefined); return await new Promise(resolve => { reply = resolve; }); };
  const work = taskTree(f.input, f.ctx, t.signal, f.io);
  while (!reply) await tick(); assert.equal(f.packets.length, 0);
  const acceptedAt = Date.now(); reply(true); const result = await work;
  assert.equal(result.status, "completed_unverified"); assert.ok(f.packets.every(packet => packet.approvedAt >= acceptedAt && packet.deadline - packet.approvedAt === 60000));
});
test("per-node supported fixed tuples are selected once and JEV never receives worker input, reports or record bodies", async t => {
  const f = treeFixture(); treeRouting(t, f.tree);
  f.tree.agents.push({ ...f.tree.agents[0]!, name: "second", model: { provider: "offline", id: "second" } });
  f.tree.targets.push({ ...f.tree.targets[0]!, agent: "second" });
  treeTasks(f.input).forEach(task => task.agents.push("second"));
  const requests: string[] = [];
  f.io.select = async (effect, _signal, started) => {
    assert.equal(effect.type, "call_jev"); if (effect.type !== "call_jev") assert.fail();
    const text = JSON.stringify(effect.request); assert.doesNotMatch(text, /PRIVATE|systemPrompt|content|provenance/); requests.push(text); started?.();
    const id = JSON.parse(effect.request.task).taskId;
    return { type: "resolved", decision: { ...jev, agent: id === "b" ? "option_1_0" : "option_0_0", confidence: 0.5 } };
  };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(requests.length, 3); assert.equal(result.metrics.jevRequests, 3);
  assert.equal(f.packets.find(packet => packet.task.id === "b")!.run.model.id, "second");
  assert.equal(f.packets.find(packet => packet.task.id === "a")!.run.model.id, "synthetic");
  assert.equal(result.metrics.totalUsd, null, "OpenJEV pricing is unknown, not TypeSafe list price");
});
test("generated graph bodies pause the same live job and require fresh exact downstream disclosure review", async t => {
  for (const allow of [true, false]) {
    const f = treeFixture(), owner = taskTreeOwner(); treeRouting(t, f.tree);
    f.input.nodes.push({ kind: "info", id: "finding", infoKind: "warning", title: "Public generated finding" });
    f.input.edges.push({ from: "a", to: "finding", kind: "produced" }, { from: "finding", to: "c", kind: "reference" });
    let approvals = 0, choices = 0;
    f.ctx.ui.confirm = async (_title, packet) => { approvals++; if (approvals === 2) { assert.match(packet, /FRESH_PARENT_AUTHORED_BODY/); assert.match(packet, /downstream execution/); return allow; } assert.doesNotMatch(packet, /FRESH_PARENT_AUTHORED_BODY/); return true; };
    f.io.select = async (effect, _signal, started) => {
      choices++; assert.doesNotMatch(JSON.stringify(effect), /FRESH_PARENT_AUTHORED_BODY|Synthetic child findings/); started?.();
      return { type: "resolved", decision: { ...jev, agent: "option_0_1", confidence: 0.5 } };
    };
    const paused = await owner.start(f.ctx, parent => taskTree(f.input, f.ctx, t.signal, f.io, undefined, parent));
    assert.equal(paused.kind, "tree_parent"); if (paused.kind !== "tree_parent") assert.fail();
    assert.equal(paused.purpose, "generated_information"); assert.equal(paused.missing[0]!.id, "finding"); assert.ok(paused.reports.some(report => report.taskId === "a"));
    assert.ok(!f.packets.some(packet => packet.task.id === "c"));
    await assert.rejects(owner.continue({ jobId: paused.jobId, questionId: "foreign", records: [{ id: "finding", content: "FRESH_PARENT_AUTHORED_BODY", provenance: "Parent-reviewed synthetic data." }] }, f.ctx), /No matching live/);
    const result = await owner.continue({ jobId: paused.jobId, questionId: paused.questionId, records: [{ id: "finding", content: "FRESH_PARENT_AUTHORED_BODY", provenance: "Parent-reviewed synthetic data." }] }, f.ctx);
    assert.equal(result.kind, "task_tree"); if (result.kind !== "task_tree") assert.fail();
    assert.equal(result.status, allow ? "completed_unverified" : "stopped"); assert.equal(approvals, 2); assert.equal(choices, allow ? 1 : 0);
    const descendant = f.packets.find(packet => packet.task.id === "c");
    assert.equal(descendant?.snapshot?.records[0]?.content, allow ? "FRESH_PARENT_AUTHORED_BODY" : undefined);
    assert.ok(f.packets.filter(packet => packet.task.id !== "c").every(packet => packet.snapshot === undefined));
    if (descendant) assert.equal(descendant.deadline, f.packets[0]!.deadline);
    await assert.rejects(owner.continue({ jobId: paused.jobId, questionId: paused.questionId, selection: { agent: "scout", ids: [] } }, f.ctx), /No matching live/);
  }
});
test("Full Access shares declared generated information without a second native review or broader JEV disclosure", async t => {
  const f = treeFixture(); treeRouting(t, f.tree);
  f.input.nodes.push({ kind: "info", id: "finding", infoKind: "warning", title: "Public generated finding" });
  f.input.edges.push({ from: "a", to: "finding", kind: "produced" }, { from: "finding", to: "c", kind: "reference" });
  const access = accessFixture(f.ctx), lease = await access.enable();
  f.io.confirm = async () => assert.fail("No task or generated-body popup in Full Access");
  f.io.select = async (effect, _signal, started) => {
    assert.doesNotMatch(JSON.stringify(effect), /PRIVATE_GENERATED_BODY|Synthetic child findings/); started?.();
    return { type: "resolved", decision: { ...jev, agent: "option_0_1", confidence: 0.5 } };
  };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io, undefined, async question => {
    assert.equal(question.purpose, "generated_information");
    return { records: [{ id: "finding", content: "PRIVATE_GENERATED_BODY", provenance: "Parent reference, not proof." }] };
  }, undefined, lease);
  assert.equal(result.status, "completed_unverified"); assert.equal(result.authorization, "full_access"); assert.equal(access.confirmations(), 1);
  const descendant = f.packets.find(packet => packet.task.id === "c")!;
  assert.equal(descendant.snapshot?.records[0]?.content, "PRIVATE_GENERATED_BODY");
  assert.equal(descendant.deadline, f.packets[0]!.deadline); assert.equal(result.metrics.workersStarted, 3);
  assert.ok(f.packets.filter(packet => packet.task.id !== "c").every(packet => packet.snapshot === undefined));
});

test("one bounded JEV decision can deliver multiple jointly needed references without exposing their bodies", async t => {
  const f = treeFixture(); treeRouting(t, f.tree);
  for (const id of ["first", "second"]) {
    f.input.nodes.push({ kind: "info", id, infoKind: "constraint", title: `Public ${id} constraint`, body: { content: `PRIVATE_BODY_${id}`, provenance: "Explicit parent reference." } });
    f.input.edges.push({ kind: "reference", from: id, to: "a" });
  }
  let decisions = 0;
  f.io.select = async (effect, _signal, started) => {
    decisions++; assert.doesNotMatch(JSON.stringify(effect), /PRIVATE_BODY|provenance/); started?.();
    const together = treeOptions(f.tree, "a").find(option => option.selection.ids.length === 2)!;
    return { type: "resolved", decision: { ...jev, agent: together.id, confidence: 0.5 } };
  };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io);
  assert.equal(result.status, "completed_unverified"); assert.equal(decisions, 1); assert.equal(f.counts().confirmations, 1);
  assert.deepEqual(f.packets.find(packet => packet.task.id === "a")?.snapshot?.records.map(record => record.id), ["first", "second"]);
  assert.ok(f.packets.filter(packet => packet.task.id !== "a").every(packet => packet.snapshot === undefined));

  const excess = treeFixture(), task = excess.input.nodes.find(node => node.kind === "task" && node.id === "a")!;
  if (task.kind !== "task") assert.fail(); task.agents.push("second", "third");
  for (let i = 0; i < 4; i++) {
    excess.input.nodes.push({ kind: "info", id: `ref_${i}`, infoKind: "warning", title: "Public warning", body: { content: "Approved data.", provenance: "Parent." } });
    excess.input.edges.push({ kind: "reference", from: `ref_${i}`, to: "a" });
  }
  const stopped = await taskTree(excess.input, excess.ctx, t.signal, excess.io);
  assert.equal(stopped.metrics.workersStarted, 0); assert.equal(stopped.metrics.jevRequests, 0); assert.equal(excess.counts().preparations, 0);
});
test("weak information choice goes to current parent without a new review; only explicit askUser opens a picker", async t => {
  for (const askUser of [false, true]) {
    const f = treeFixture(), owner = taskTreeOwner(); treeRouting(t, f.tree);
    f.input.nodes.push({ kind: "info", id: "rule", infoKind: "constraint", title: "Public rule", body: { content: "APPROVED_SOURCE", provenance: "Exact original data." } });
    f.input.edges.push({ from: "rule", to: "a", kind: "reference" }); let decisions = 0, pickers = 0;
    f.ctx.ui.select = async (_title, options) => { pickers++; return options[1]; };
    f.io.select = async (_effect, _signal, started) => { decisions++; started?.(); return { type: "resolved", decision: { ...jev, agent: "option_0_1", confidence: 0.49 } }; };
    const paused = await owner.start(f.ctx, parent => taskTree(f.input, f.ctx, t.signal, f.io, undefined, parent));
    if (paused.kind !== "tree_parent") assert.fail(); assert.equal(pickers, 0); assert.equal(f.packets.length, 0);
    const result = await owner.continue({ jobId: paused.jobId, questionId: paused.questionId, ...(askUser ? { askUser: true as const } : { selection: { agent: "scout", ids: ["rule"] } }) }, f.ctx);
    assert.equal(result.kind, "task_tree"); if (result.kind !== "task_tree") assert.fail(); assert.equal(result.status, "completed_unverified");
    assert.equal(pickers, askUser ? 1 : 0); assert.equal(decisions, 1); assert.equal(f.counts().confirmations, 1);
    assert.equal(f.packets.find(packet => packet.task.id === "a")?.snapshot?.records[0]?.id, "rule");
  }
});
test("scoped mutation is exclusive and shares one file-ID owner and confirmed writable versions", async t => {
  const f = treeFixture(); treeTasks(f.input).filter(task => task.id !== "a").forEach(task => { task.mode = "mutation"; task.agents = ["writer"]; });
  f.tree.agents.push({ ...f.tree.agents[0]!, name: "writer", tools: ["read", "edit", "bash"] }); f.tree.targets.push({ ...f.tree.targets[0]!, agent: "writer" });
  f.input.files = [{ path: "sample.txt", access: "read_write" }];
  f.tree.files = { id: "files", root: f.tree.cwd, rootIdentity: { dev: 1, ino: 1 }, files: [{ id: "file-1", path: "sample.txt", access: "read_write", version: { identity: { dev: 1, ino: 2 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 1 } }] };
  let active = 0, mutation = 0;
  f.io.run = async packet => {
    active++; assert.equal(active, 1); f.packets.push(packet); await tick(); active--;
    if (packet.task.mode === "read") return { started: true, cleanupConfirmed: true, result: f.reply() };
    mutation++; assert.deepEqual(packet.run.agent.tools, ["read", "edit"]); assert.equal(packet.files?.files[0]?.version.bytes, mutation);
    const files = structuredClone(packet.files!); files.files[0]!.version.bytes++;
    return { started: true, cleanupConfirmed: true, result: { type: "goal_result", reply: f.reply(), scope: files,
      files: { operations: 1, readBytes: 1, writtenBytes: 1, changed: true, uncertain: false, finished: true } } };
  };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io); assert.equal(result.status, "completed_unverified");
  assert.equal(mutation, 2); assert.equal(f.counts().owners, 1); assert.equal(f.counts().closes, 1); assert.equal(result.cleanupConfirmed, true);
});
test("cancellation drains in-flight workers and keeps late usage without unlocking descendants", { timeout: 5000 }, async t => {
  const f = treeFixture(), controller = new AbortController(), releases: (() => void)[] = []; let started = 0, cancelled = 0;
  f.io.run = async (_input, signal) => await new Promise(resolve => {
    started++; signal.addEventListener("abort", () => { cancelled++; }, { once: true });
    releases.push(() => resolve({ started: true, cleanupConfirmed: true, result: f.reply() }));
  });
  const work = taskTree(f.input, f.ctx, AbortSignal.any([controller.signal, t.signal]), f.io); let settled = false; void work.then(() => { settled = true; });
  while (started < 2) await tick(); controller.abort(); await tick(); assert.equal(cancelled, 2); assert.equal(settled, false);
  releases.forEach(release => release()); const result = await work;
  assert.equal(result.status, "stopped"); assert.equal(result.metrics.modelCalls, 2); assert.equal(result.metrics.reservedModelCalls, 0); assert.equal(result.metrics.workersStarted, 2);
});
test("three independent catalog tasks reserve and overlap without forecasting SDK-native calls", { timeout: 5000 }, async t => {
  const f = treeFixture(); f.input.edges = []; f.input.limits.modelCalls = null; f.input.limits.perWorkerCalls = null;
  let starts = 0; const releases: (() => void)[] = [];
  f.io.run = async packet => await new Promise(resolve => { starts++; assert.equal(packet.run.maxModelCalls, null); releases.push(() => resolve({ started: true, cleanupConfirmed: true, result: f.reply() })); });
  const work = taskTree(f.input, f.ctx, t.signal, f.io); while (starts < 3) await tick();
  releases.forEach(release => release()); const result = await work;
  assert.equal(result.metrics.peak, 3); assert.equal(result.metrics.modelCalls, 3); assert.equal(result.metrics.reservedModelCalls, 0);
});
test("late JEV receipts settle after cancellation, never select or dispatch a child", { timeout: 5000 }, async t => {
  const f = treeFixture(); treeRouting(t, f.tree);
  f.tree.agents.push({ ...f.tree.agents[0]!, name: "second" }); f.tree.targets.push({ ...f.tree.targets[0]!, agent: "second" }); treeTasks(f.input)[0]!.agents.push("second");
  const controller = new AbortController(); let reply!: () => void;
  f.io.select = async (_effect, _signal, started) => { started?.(); return await new Promise(resolve => { reply = () => resolve({ type: "resolved", decision: { ...jev, agent: "option_0_0", confidence: 1 } }); }); };
  const work = taskTree(f.input, f.ctx, AbortSignal.any([controller.signal, t.signal]), f.io);
  while (!reply) await tick(); controller.abort(); reply(); const result = await work;
  assert.equal(result.status, "stopped"); assert.equal(result.metrics.jevRequests, 1); assert.equal(result.metrics.reservedJevRequests, 0); assert.equal(result.receipts.jev.length, 1); assert.equal(f.packets.length, 0);
});
test("lifecycle cancellation consumes live parent questions without replacement or restored authority", async t => {
  const f = treeFixture(), owner = taskTreeOwner(), controller = new AbortController(); treeRouting(t, f.tree);
  f.input.nodes.push({ kind: "info", id: "rule", infoKind: "constraint", title: "Public rule", body: { content: "Approved data.", provenance: "Exact source." } });
  f.input.edges.push({ from: "rule", to: "a", kind: "reference" });
  f.io.select = async (_effect, _signal, started) => { started?.(); return { type: "resolved", decision: { ...jev, agent: "option_0_1", confidence: 0.49 } }; };
  let job!: ReturnType<typeof taskTree>;
  const paused = await owner.start(f.ctx, parent => { job = taskTree(f.input, f.ctx, AbortSignal.any([controller.signal, t.signal]), f.io, undefined, parent); return job; });
  if (paused.kind !== "tree_parent") assert.fail(); controller.abort(); const result = await job;
  assert.equal(result.status, "stopped"); assert.equal(result.metrics.workersStarted, 0);
  await assert.rejects(owner.continue({ jobId: paused.jobId, questionId: paused.questionId, selection: { agent: "scout", ids: [] } }, f.ctx), /No matching live/);
  assert.equal(f.packets.length, 0);
});
test("unknown routing receipts and changed policy never dispatch; missing usage/cleanup retains uncertainty", async t => {
  const f = treeFixture(); treeRouting(t, f.tree);
  f.tree.agents.push({ ...f.tree.agents[0]!, name: "second" }); f.tree.targets.push({ ...f.tree.targets[0]!, agent: "second" }); treeTasks(f.input)[0]!.agents.push("second");
  f.io.select = async (_effect, _signal, started) => { started?.(); return { type: "failed", error: "Synthetic unaccounted request." }; };
  const result = await taskTree(f.input, f.ctx, t.signal, f.io); assert.equal(result.status, "stopped"); assert.equal(result.metrics.reservedJevRequests, 1); assert.equal(f.packets.length, 0);
  const changed = treeFixture(); let reviewed = false; changed.ctx.ui.confirm = async () => { reviewed = true; return true; };
  changed.io.policy = async () => ({ policy: changed.tree.policy, version: reviewed ? "b".repeat(64) : changed.tree.policyVersion });
  assert.equal((await taskTree(changed.input, changed.ctx, t.signal, changed.io)).status, "stopped"); assert.equal(changed.packets.length, 0);
  const unknown = treeFixture(); unknown.io.run = async () => ({ started: true, cleanupConfirmed: false, result: null });
  const stopped = await taskTree(unknown.input, unknown.ctx, t.signal, unknown.io); assert.equal(stopped.status, "stopped"); assert.equal(stopped.metrics.modelCalls, null); assert.equal(stopped.cleanupConfirmed, false);
  assert.match(taskTreeApproval(f.tree).text, /NOT file-ID isolation or an OS sandbox/); assert.equal(treeOptions(f.tree, "a").length, 2);
});

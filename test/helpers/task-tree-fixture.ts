import type { TestContext } from "node:test";
import { parallelFixture } from "./parallel-read-fixture.ts";
import { taskTreeIO } from "../../src/task-tree-effects.ts";
import { describeJevTarget, resolveJevConnection } from "../../src/jev-config.ts";
import type { TaskTreeInput, TreePrepared } from "../../src/task-tree.ts";
import type { TreeWorkerInput } from "../../src/task-tree-protocol.ts";

export function treeFixture() {
  const original = parallelFixture(), base = original.prepared;
  const input: TaskTreeInput = { task: "Inspect the parent-authored synthetic tree.",
    nodes: ["a", "b", "c"].map(id => ({ kind: "task", id, summary: `PRIVATE_TASK_${id}: Inspect the synthetic assigned source.`, query: `Inspect public task ${id}.`, mode: "read", agents: ["scout"] })),
    edges: [{ from: "a", to: "c", kind: "dependency" }], limits: { workerRuns: 3, seconds: 60, modelCalls: 6, perWorkerCalls: 2 } };
  const tree: TreePrepared = { id: "tree", sessionId: base.sessionId, cwd: base.cwd, agentDirectory: base.agentDirectory, input,
    agents: [structuredClone(base.tasks[0]!.run.agent)], targets: [{ agent: "scout", ...base.tasks[0]!.target }], context: [], policy: base.policy, policyVersion: base.policyVersion, routingTarget: null };
  const packets: TreeWorkerInput[] = [];
  let preparations = 0, owners = 0, closes = 0;
  const io: typeof taskTreeIO = { ...taskTreeIO, prepare: async () => { preparations++; return structuredClone(tree); }, policy: original.io.policy,
    canonical: original.io.canonical, context: original.io.context, files: async () => {}, own: async () => { owners++; return { version: { identity: { dev: 1, ino: 5 }, stamp: "a".repeat(64), digest: "b".repeat(64), bytes: 10 }, close: async keep => { closes++; return keep; } }; },
    select: async () => { throw new Error("Unexpected JEV request."); }, run: async packet => { packets.push(structuredClone(packet)); return { started: true, cleanupConfirmed: true, result: original.reply() }; } };
  return { ...original, input, tree, io, packets, counts: () => ({ ...original.counts(), preparations, owners, closes }) };
}
export function treeRouting(t: TestContext, tree: TreePrepared) {
  const values = { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8000", OPENJEV_MODEL: "openjev-0.1", OPENJEV_API_KEY: "" };
  const keys = Object.keys(values), previous = keys.map(key => process.env[key]);
  Object.assign(process.env, values);
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  const config = resolveJevConnection(values); if (!config.ok) throw new Error("Invalid synthetic configuration.");
  tree.routingTarget = describeJevTarget(config.connection);
}

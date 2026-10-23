import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_APPROVAL_POLICY, parallelReadTask, type ParallelReadInput, type ParallelReadPrepared } from "../../src/parallel-read.ts";
import { parallelReadIO } from "../../src/parallel-read-effects.ts";
import type { WorkerReply } from "../../src/delegate-machine.ts";

export function parallelFixture(taskCount: 1 | 2 | 3 = 3) {
  const cwd = path.resolve(os.tmpdir(), "synthetic-parallel-not-created"), agentDirectory = path.join(cwd, "agent-not-created");
  const input: ParallelReadInput = { task: "Inspect three independent synthetic source seams without changes.",
    tasks: ["runtime", "storage", "tests"].slice(0, taskCount).map(id => ({ id, agent: "scout", summary: `Inspect the synthetic ${id} seam; report concise findings only.` })),
    limits: { seconds: 60, modelCalls: 6, perWorkerCalls: 2 } };
  const agent = { name: "scout", description: "Read-only synthetic inspection.", systemPrompt: "PRIVATE_REVIEWED_PROFILE_SOURCE. Read the requested source only; never edit or delegate.",
    tools: ["read", "grep", "find", "ls"], file: path.join(agentDirectory, "agents", "scout.md"), model: { provider: "offline", id: "synthetic" } };
  const prepared: ParallelReadPrepared = { id: "batch", sessionId: "session", cwd, agentDirectory, input: structuredClone(input), policy: structuredClone(DEFAULT_APPROVAL_POLICY),
    policyVersion: "a".repeat(64), context: [], tasks: input.tasks.map(task => ({ id: task.id, run: { cwd, task: parallelReadTask(input.task, task.summary), agent: structuredClone(agent),
      model: agent.model, maxModelCalls: 2, seconds: 60 }, target: { api: "openai-completions", endpoint: "http://127.0.0.1:9999/v1" } })) };
  let session = "session", confirmations = 0, preparations = 0, starts = 0;
  const packets: string[] = [], runs: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => session }, ui: {
    confirm: async (_title: string, packet: string) => { confirmations++; packets.push(packet); assert.match(packet, /PRIVATE_REVIEWED_PROFILE_SOURCE/); return true; },
  } } as unknown as ExtensionContext;
  const reply = (text = "Synthetic child findings; not independent verification."): WorkerReply => ({ type: "completed",
    result: { text, truncated: false, turns: 1, usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 },
    report: { startupMs: 1, executionMs: 1, modelCalls: 1, accounting: { status: "reported", complete: true,
      stats: { turns: 1, usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 } } } });
  const io: typeof parallelReadIO = { ...parallelReadIO, prepare: async () => { preparations++; return structuredClone(prepared); },
    policy: async () => ({ policy: structuredClone(prepared.policy), version: prepared.policyVersion }),
    canonical: async () => cwd, context: async () => {}, run: async input => {
      starts++; runs.push(input.run.task); assert.ok(confirmations > 0); return { started: true, cleanupConfirmed: true, result: reply() };
    } };
  return { input, prepared, ctx, io, reply, packets, runs, counts: () => ({ confirmations, preparations, starts }), move: () => { session = "moved"; } };
}

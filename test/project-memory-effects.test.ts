import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { executeProjectMemory, projectMemoryIO, registerProjectMemoryTool } from "../src/project-memory-effects.ts";
import { memoryDigest, memoryProjectKey, validMemorySnapshot, type MemoryState } from "../src/project-memory.ts";
import { ProjectMemoryError } from "../src/project-memory-store.ts";
import { memoryProgressText, type MemoryProgress } from "../src/project-memory-presentation.ts";

function fixture(t: TestContext) {
  const keys = ["JEV_BACKEND", "OPENJEV_BASE_URL", "OPENJEV_MODEL", "OPENJEV_API_KEY"], saved = keys.map(key => process.env[key]);
  Object.assign(process.env, { JEV_BACKEND: "openjev", OPENJEV_BASE_URL: "http://127.0.0.1:8000", OPENJEV_MODEL: "openjev-0.1" }); delete process.env.OPENJEV_API_KEY;
  t.after(() => keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }));
  let session = "fixture", reads = 0, mutations = 0, decisions = 0;
  const packets: string[] = [], transmitted: unknown[] = [];
  const state: MemoryState = { version: 1, projectKey: memoryProjectKey("/project"), revision: 1, facts: [
    { id: "fact_a", kind: "decision", title: "Public choice title", content: "PRIVATE_BODY_A", provenance: "PRIVATE_PROVENANCE", createdRevision: 1 },
    { id: "fact_b", kind: "decision", title: "Other public title", content: "PRIVATE_BODY_B", provenance: "Parent review.", createdRevision: 1 } ], edges: [{ from: "fact_a", to: "fact_b" }] };
  const ctx = { cwd: "/project", hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => session },
    ui: { confirm: async () => assert.fail("Private IO seam owns synthetic native replies") } } as unknown as ExtensionContext;
  const actions = ["node_decision", "node_0", "node_0", "accept", "stop"];
  const io: typeof projectMemoryIO = { ...projectMemoryIO,
    canonical: async value => { assert.equal(value, "/project"); return value; }, identity: async () => "one:project",
    read: async () => { reads++; return { state: structuredClone(state), directory: "/private", token: memoryDigest(state) }; },
    probe: async () => ({ directory: "/private", token: "empty" }),
    mutate: async () => { mutations++; return { state: structuredClone(state), directory: "/private", token: memoryDigest(state), id: "fact_new" }; },
    confirm: async (_ctx, _title, packet) => { packets.push(packet); return true; },
    decide: async (request, _signal, attempt) => {
      attempt(); transmitted.push(request); const agent = actions[decisions++]!;
      assert.ok(request.agents.some(candidate => candidate.name === agent));
      return { type: "resolved", decision: { agent, confidence: 1, model: "openjev-0.1", provider: "openjev", requestedModel: "openjev-0.1", usage: { inputTokens: 3, outputTokens: 1 } } };
    },
  };
  return { ctx, io, state, packets, transmitted, counts: () => ({ reads, mutations, decisions }), move: () => { session = "another"; } };
}
const search = { operation: "search", directory: "/private", query: "Find the reviewed decision.", maxVisits: 8, seconds: 60 };
test("memory no-UI and invalid calls have zero storage, native approval and JEV effects", async t => {
  const f = fixture(t); f.ctx.hasUI = false;
  f.io.canonical = async () => assert.fail("No filesystem inspection");
  f.io.confirm = async () => assert.fail("No approval"); f.io.decide = async () => assert.fail("No JEV");
  assert.equal((await executeProjectMemory(search, f.ctx, t.signal, f.io)).status, "failed");
  assert.equal((await executeProjectMemory({ ...search, approved: true }, f.ctx, t.signal, f.io)).stage, "input");
  assert.deepEqual(f.counts(), { reads: 0, mutations: 0, decisions: 0 });
});
test("bounded JEV navigation sends only approved public metadata and separately approves full snapshot disclosure", async t => {
  const f = fixture(t), progress: MemoryProgress[] = [];
  const result = await executeProjectMemory(search, f.ctx, t.signal, f.io, value => { progress.push(value); });
  assert.equal(result.status, "snapshot"); assert.equal(result.visits, 5); assert.equal(result.jevRequests, 5); assert.equal(result.pendingRequests, 0);
  assert.equal(result.snapshot?.records[0]?.content, "PRIVATE_BODY_A"); assert.equal(validMemorySnapshot(result.snapshot, f.state.projectKey), true);
  assert.equal(f.packets.length, 2); assert.doesNotMatch(f.packets[0]!, /PRIVATE_BODY|PRIVATE_PROVENANCE/); assert.match(f.packets[1]!, /PRIVATE_BODY_A/);
  assert.doesNotMatch(JSON.stringify(f.transmitted), /PRIVATE_BODY|PRIVATE_PROVENANCE|\/private|\/project/);
  assert.ok(f.transmitted.length === result.visits); assert.equal(f.counts().mutations, 0);
  assert.doesNotMatch(progress.map(memoryProgressText).join("\n"), /PRIVATE_BODY|PRIVATE_PROVENANCE|\/private|\/project|100%/);
  assert.equal(result.costEstimate.totalUsd, null, "Unknown local-provider price is not a zero invoice");
});
test("denied review or disclosure, nonliteral approval and stale project/revision return no memory bodies", async t => {
  for (const mode of ["initial", "disclosure", "session", "revision", "nonliteral", "disclosure_nonliteral", "provider"] as const) {
    const f = fixture(t), decide = f.io.decide;
    f.io.confirm = async (_ctx, _title, packet) => { f.packets.push(packet); return mode === "initial" ? false : mode === "nonliteral" || mode === "disclosure_nonliteral" && f.packets.length === 2 ? "true" as unknown as boolean : mode === "disclosure" ? f.packets.length < 2 : true; };
    if (mode === "session" || mode === "revision" || mode === "provider") f.io.decide = async (...args) => {
      const reply = await decide(...args); if (mode === "session") f.move(); else if (mode === "revision") f.state.revision++; else process.env.OPENJEV_MODEL = "changed-model"; return reply;
    };
    const result = await executeProjectMemory(search, f.ctx, t.signal, f.io);
    assert.equal(result.snapshot, undefined); assert.equal(result.parentLookup, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY/); assert.equal(f.counts().mutations, 0);
    if (mode === "initial" || mode === "nonliteral") assert.equal(f.counts().decisions, 0);
  }
});
test("weak JEV hands only the approved candidate graph to the current parent; full lookup still needs snapshot consent", async t => {
  const f = fixture(t), decide = f.io.decide;
  f.io.decide = async (...args) => { const response = await decide(...args); if (response.type !== "resolved") assert.fail(); return { ...response, decision: { ...response.decision, confidence: 0.49 } }; };
  const result = await executeProjectMemory(search, f.ctx, t.signal, f.io);
  assert.equal(result.status, "parent_lookup"); assert.equal(result.stage, "parent_lookup"); assert.equal(result.navigation, "uncertain");
  assert.equal(result.jevRequests, 1); assert.equal(result.pendingRequests, 0); assert.equal(f.counts().decisions, 1); assert.equal(f.counts().mutations, 0);
  assert.equal(result.snapshot, undefined); assert.equal(f.packets.length, 1);
  assert.deepEqual(result.parentLookup?.candidates, f.state.facts.map(({ id, kind, title }) => ({ id, kind, title })));
  assert.deepEqual(result.parentLookup?.edges, f.state.edges); assert.equal(result.parentLookup?.expectedRevision, 1);
  assert.match(result.parentLookup!.instruction, /Current parent model/); assert.match(f.packets[0]!, /current parent model/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|PRIVATE_PROVENANCE|\/private|\/project/);
  const request = { operation: "snapshot", directory: search.directory, expectedRevision: result.parentLookup!.expectedRevision, ids: [result.parentLookup!.candidates[0]!.id] };
  f.io.confirm = async () => false;
  const denied = await executeProjectMemory(request, f.ctx, t.signal, f.io); assert.equal(denied.snapshot, undefined); assert.equal(denied.status, "cancelled");
  f.io.confirm = async (_ctx, _title, packet) => { assert.match(packet, /PRIVATE_BODY_A/); assert.match(packet, /No automatic sibling or next-job sharing/); return true; };
  const disclosed = await executeProjectMemory(request, f.ctx, t.signal, f.io);
  assert.equal(disclosed.status, "snapshot"); assert.equal(disclosed.snapshot?.records[0]?.content, "PRIVATE_BODY_A"); assert.equal(f.counts().decisions, 1);
});

test("create/remember/forget mutate only after exact review; unknown application is retained without retry", async t => {
  for (const operation of ["create", "remember", "forget"] as const) {
    const f = fixture(t);
    const input = operation === "create" ? { operation, directory: "/private" } : operation === "forget" ? { operation, directory: "/private", id: "fact_a", expectedRevision: 1 }
      : { operation, directory: "/private", expectedRevision: 1, record: { kind: "decision", title: "Public reviewed title", content: "Proposed reviewed value.", provenance: "Parent review.", relatedIds: [] } };
    const mutate = f.io.mutate; f.io.mutate = async (...args) => { assert.equal(f.packets.length, 1); return mutate(...args); };
    assert.equal((await executeProjectMemory(input, f.ctx, t.signal, f.io)).application, "applied"); assert.equal(f.counts().mutations, 1);
    f.io.confirm = async () => false; assert.equal((await executeProjectMemory(input, f.ctx, t.signal, f.io)).application, "not_applied"); assert.equal(f.counts().mutations, 1);
  }
  const f = fixture(t); f.io.mutate = async () => { throw new ProjectMemoryError("storage", "unknown"); };
  const result = await executeProjectMemory({ operation: "create", directory: "/private" }, f.ctx, t.signal, f.io);
  assert.equal(result.status, "needs_review"); assert.equal(result.application, "unknown"); assert.equal(result.snapshot, undefined);
});
test("weak decisions and unknown receipts stop once; deadline cancellation never fabricates a snapshot", async t => {
  for (const mode of ["weak", "receipt", "cancel"] as const) {
    const f = fixture(t), decide = f.io.decide, controller = new AbortController();
    f.io.decide = async (...args) => {
      const response = await decide(...args); if (mode === "cancel") controller.abort();
      if (response.type !== "resolved") assert.fail();
      return mode === "receipt" ? { ...response, decision: { ...response.decision, usage: null } } as unknown as typeof response
        : { ...response, decision: { ...response.decision, confidence: mode === "weak" ? 0.49 : 1 } };
    };
    const result = await executeProjectMemory(search, f.ctx, controller.signal, f.io);
    assert.equal(result.snapshot, undefined); assert.equal(f.counts().decisions, 1); assert.equal(result.jevRequests, 1);
    if (mode === "weak") { assert.equal(result.status, "parent_lookup"); assert.ok(result.parentLookup); }
    else { assert.equal(result.parentLookup, undefined); assert.equal(result.status, mode === "cancel" ? "cancelled" : "needs_review"); }
    assert.equal(result.pendingRequests, mode === "receipt" ? 1 : 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY/);
  }
});
test("approved memory write owns its input and refuses storage inside the worker workspace", async t => {
  const f = fixture(t), input = { operation: "remember", directory: "/private", expectedRevision: 1,
    record: { kind: "decision", title: "Public title", content: "EXACT_REVIEWED_VALUE", provenance: "Parent review.", relatedIds: [] } };
  f.io.confirm = async (_ctx, _title, packet) => { assert.match(packet, /EXACT_REVIEWED_VALUE/); input.record.content = "UNREVIEWED_CHANGE"; return true; };
  const mutate = f.io.mutate; f.io.mutate = async (...args) => { assert.ok(args[0].operation === "remember"); assert.equal(args[0].record.content, "EXACT_REVIEWED_VALUE"); return mutate(...args); };
  assert.equal((await executeProjectMemory(input, f.ctx, t.signal, f.io)).application, "applied");
  const other = fixture(t); other.io.probe = async () => ({ directory: "/project/private", token: "none" });
  assert.equal((await executeProjectMemory({ operation: "create", directory: "/project/private" }, other.ctx, t.signal, other.io)).status, "needs_review");
  assert.equal(other.counts().mutations, 0); assert.equal(other.packets.length, 0);
});

test("memory response waiting consumes no search time; its later execution deadline stops without a snapshot", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const f = fixture(t); let approve!: (value: boolean) => void, shown!: () => void, requested!: () => void;
  const showing = new Promise<void>(resolve => { shown = resolve; }), started = new Promise<void>(resolve => { requested = resolve; });
  f.io.confirm = async () => { shown(); return await new Promise<boolean>(resolve => { approve = resolve; }); };
  f.io.decide = async (_request, signal, attempt) => { attempt(); requested(); return await new Promise(resolve => signal.addEventListener("abort", () => resolve({ type: "cancel" }), { once: true })); };
  const work = executeProjectMemory({ ...search, seconds: 1 }, f.ctx, t.signal, f.io);
  await showing; t.mock.timers.tick(86400000); assert.equal(f.counts().decisions, 0); approve(true); await started;
  t.mock.timers.tick(1001); const result = await work;
  assert.equal(result.status, "cancelled"); assert.equal(result.snapshot, undefined); assert.equal(result.jevRequests, 1); assert.equal(result.pendingRequests, 1);
});

test("parent-only memory registration cancels lifecycle work without a fallback or snapshot leak", async t => {
  const tools: ToolDefinition[] = [], hooks = new Map<string, () => void>();
  registerProjectMemoryTool({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, handler: () => void) { hooks.set(event, handler); } } as unknown as ExtensionAPI);
  assert.equal(tools.length, 1); assert.equal(tools[0]!.name, "jev_memory"); assert.equal(tools[0]!.executionMode, "sequential");
  const f = fixture(t); f.ctx.hasUI = false;
  const response = await tools[0]!.execute("fixture", search, t.signal, undefined, f.ctx);
  assert.equal((response.details as { status: string }).status, "failed");
  hooks.get("session_shutdown")!(); await assert.rejects(tools[0]!.execute("fixture", search, t.signal, undefined, f.ctx), /closed/);
});

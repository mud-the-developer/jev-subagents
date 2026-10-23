import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerJevTools } from "../src/index.ts";
import { taskTreeIO } from "../src/task-tree-effects.ts";
import { treeFixture } from "./helpers/task-tree-fixture.ts";
import { planReceipt, validPlanReceipt } from "../src/plan-state.ts";
import { renderPlan } from "../src/plan-presentation.ts";
import { taskTreeView } from "../src/task-tree-view.ts";
import { delegateResultView } from "../src/delegate-presentation.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const stop of ["complete", "abort", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "session_shutdown"]) test(`registered native task-tree TUI updates and clears on ${stop}`, { timeout: 10000 }, async t => {
  const f = treeFixture(), tools: ToolDefinition[] = [], hooks = new Map<string, (() => void | Promise<void>)[]>(), panels: (string | undefined)[] = [];
  f.input.display = { labels: { a: "Inspect approved source", b: "Read declared tests", c: "Review declared changes" } };
  const controller = new AbortController(), releases: (() => void)[] = []; let starts = 0, aborts = 0, reviews = 0, mounts = 0, renders = 0;
  let widget: { render(width: number): string[]; dispose?(): void } | undefined;
  const requestRender = () => {
    if (!widget) return;
    renders++;
    const text = widget.render(80).join("\n"); panels.push(text); assert.doesNotMatch(text, /PRIVATE|systemPrompt|%|https?:/);
  };
  initTheme("dark", false);
  const ctx = { ...f.ctx, mode: "tui", ui: { ...f.ctx.ui,
    custom: async (factory: (...args: unknown[]) => unknown) => await new Promise<boolean>(resolve => {
      reviews++;
      const component = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, {}, { matches: () => false }, resolve) as { render(width: number): string[]; handleInput(data: string): void };
      assert.ok(component.render(80).length); component.handleInput("\r");
    }),
    setWidget(_key: string, factory: unknown) {
      widget?.dispose?.(); widget = undefined;
      if (!factory) { panels.push(undefined); return; }
      mounts++;
      widget = (factory as (tui: unknown, theme: unknown) => NonNullable<typeof widget>)({ requestRender }, { fg: (_tone: string, text: string) => text });
      requestRender();
    },
  } } as unknown as ExtensionContext;
  f.io.run = async (input, signal, progress) => {
    starts++; progress?.({ type: "jev_worker_progress", version: 1, sequence: 1, phase: "model_request", elapsedMs: 1, modelCalls: 1, toolCalls: 0 });
    if (starts > 2 && stop === "complete") return { started: true, cleanupConfirmed: true, result: f.reply() };
    return await new Promise(resolve => {
      signal.addEventListener("abort", () => { aborts++; }, { once: true });
      releases.push(() => resolve({ started: true, cleanupConfirmed: true, result: f.reply(`PRIVATE_REPORT_${input.task.id}`) }));
    });
  };
  for (const key of Object.keys(f.io) as (keyof typeof taskTreeIO)[]) t.mock.method(taskTreeIO, key, f.io[key]);
  registerJevTools({ registerTool(tool: ToolDefinition) { tools.push(tool); }, on(event: string, callback: () => void | Promise<void>) { hooks.set(event, [...hooks.get(event) ?? [], callback]); } } as unknown as ExtensionAPI);
  const tool = tools.find(tool => tool.name === "jev_delegate")!, updates: unknown[] = [];
  const work = tool.execute("tree", { tree: f.input }, AbortSignal.any([controller.signal, t.signal]), update => { updates.push(update); }, ctx);
  const settled = stop === "complete" ? work : assert.rejects(work, /Task tree stopped/);
  while (starts < 2) await tick(); assert.equal(reviews, 1);
  assert.ok(panels.some(text => text?.includes("TASK TREE") && text.includes("DEPENDENCY") && text.includes("RUNNING")));
  assert.ok(panels.some(text => text?.includes("OBSERVED SDK 1") && text.includes("offline/synthetic")));
  assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_REPORT|PRIVATE_REVIEWED|PRIVATE_TASK|Inspect approved source|Read declared tests|Review declared changes/);
  assert.ok(panels.some(text => text?.includes("MODEL offline/synthetic — Inspect approved source")));
  await assert.rejects(tool.execute("other", { parallelRead: { task: "Read independent files.", tasks: [{ id: "x", agent: "scout", summary: "Read only." }], limits: { seconds: 60 } } }, t.signal, undefined, ctx), /closed, busy or uncertain/);
  let navigation: Promise<unknown> | undefined;
  if (stop === "abort") controller.abort();
  else if (stop !== "complete") navigation = Promise.all((hooks.get(stop) ?? []).map(callback => callback()));
  if (stop !== "complete") { await tick(); assert.equal(panels.at(-1), undefined); assert.equal(aborts, 2); }
  releases.forEach(release => release()); await settled; await navigation;
  assert.equal(panels.at(-1), undefined); const count = panels.length; await tick(); assert.equal(panels.length, count);
  assert.equal(mounts, 1); assert.ok(renders > 2, "Updates must render the existing component, not remount it");
  if (stop === "complete") {
    const result = await work; const plan = (result.details as { plan: unknown }).plan; assert.equal(validPlanReceipt(plan), true);
    assert.doesNotMatch(JSON.stringify(plan), /Inspect approved source|Read declared tests|Review declared changes/);
    assert.ok(panels.some(text => text?.includes("COMPLETED / UNVERIFIED"))); assert.equal(starts, 3);
  } else assert.equal(starts, 2);
});
test("final native tree rows distinguish unverified completion from stop and preserve unknown costs", () => {
  const details = { kind: "task_tree", status: "completed_unverified", taskAcceptance: "needs_human_review", cleanupConfirmed: true,
    metrics: { workersStarted: 3, modelCalls: 6, reservedModelCalls: 0, jevRequests: 1, reservedJevRequests: 0, observedUsd: 0.01, totalUsd: null }, reports: [{ text: "PRIVATE_REPORT" }] };
  const options = { expanded: true, isError: false, isPartial: false };
  const complete = delegateResultView({ details }, options); assert.match(complete.text, /ended \/ unverified/); assert.doesNotMatch(complete.text, /stopped|PRIVATE/); assert.match(complete.text, /delegation total unknown/);
  const stopped = delegateResultView({ content: [{ type: "text", text: `Task tree stopped.\n${JSON.stringify({ ...details, status: "stopped" })}` }] }, { ...options, isError: true });
  assert.match(stopped.text, /stopped/); assert.doesNotMatch(stopped.text, /PRIVATE|ended/);
});
test("persistent tree widget nests dependent tasks without expanding all information nodes", () => {
  const f = treeFixture();
  for (let i = 0; i < 8; i++) {
    f.input.nodes.push({ kind: "info", id: `info_${i}`, infoKind: "constraint", title: "Public reference", body: { content: "PRIVATE_BODY", provenance: "Parent." } });
    f.input.edges.push({ kind: "reference", from: `info_${i}`, to: "a" });
  }
  const original = taskTreeView(f.tree, { phase: "approval", tree: f.tree, reviews: 0 }, 1000);
  const view = { ...original, nodes: original.nodes.map(node => node.kind === "task" ? { ...node, model: "offline/synthetic", thinking: "off" } : node) };
  const compact = renderPlan(view, 80, undefined, true), expanded = renderPlan(view, 80), text = compact.join("\n");
  assert.ok(compact.length <= 30, `Expected a compact tree, got ${compact.length} rows`);
  assert.ok(compact.length < expanded.length);
  assert.match(text, /(?:│  | {3})└─ ○ c/); assert.match(text, /DEPENDENCY ← a/);
  assert.match(text, /MODEL offline\/synthetic · EFFORT off/); assert.match(text, /INFO 8 · READY 0/);
  assert.doesNotMatch(text, /INFO info_0|PRIVATE_BODY|%/); assert.match(expanded.join("\n"), /INFO info_0/);
});
test("tree receipt is bounded, connected and source-free across native widths, not a grant", () => {
  const f = treeFixture(), view = taskTreeView(f.tree, { phase: "approval", tree: f.tree, reviews: 0 }, 1000), receipt = planReceipt(view);
  assert.equal(validPlanReceipt(receipt), true);
  for (const width of [24, 48, 80, 120]) {
    const lines = renderPlan(receipt, width); assert.ok(lines.length < 200); assert.match(lines.join("\n"), /PENDING/); assert.doesNotMatch(lines.join("\n"), /PRIVATE|%/);
  }
  assert.equal(validPlanReceipt({ ...receipt, grant: true }), false);
  assert.equal(validPlanReceipt({ ...receipt, edges: [...receipt.edges!, { from: "c", to: "a", kind: "dependency", status: "pending" }] }), false);
});

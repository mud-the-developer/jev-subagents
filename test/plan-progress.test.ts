import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPlanWidgets } from "../src/plan-widget.ts";
import type { PlanView } from "../src/plan-presentation.ts";
import { runWindowsGoalProcess, windowsGoalProcessIO } from "../src/windows-goal-process.ts";
import { EMPTY_FILE_REPORT, type GoalWorkerReply } from "../src/goal-run.ts";

const view: PlanView = { phase: "running", elapsedMs: 1000, seconds: 86400, modelCalls: 2,
  nodes: [{ id: "implement", title: "PRIVATE_TASK_SOURCE", after: [], state: "running", agent: "worker", model: "offline/model", thinking: "low",
    alternatives: [{ id: "a", title: "PRIVATE_A", selected: false }, { id: "b", title: "PRIVATE_B", selected: true }] }] };

test("native plan panel is TUI-only, compact, observer-only and cleared on lifecycle or close", () => {
  const handlers = new Map<string, () => void>(), records: unknown[] = [], rendered: string[] = [];
  let component: { render(width: number): string[]; dispose?(): void } | undefined;
  const requestRender = () => { if (component) rendered.push(component.render(80).join("\n")); };
  const open = registerPlanWidgets({ on(event: string, handler: () => void) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  let session = "same";
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => session }, ui: {
    setWidget(_key: string, content: unknown, options?: { placement: string }) {
      records.push(content); component?.dispose?.(); component = undefined;
      if (content) {
        assert.equal(options?.placement, "aboveEditor");
        component = (content as (tui: unknown, theme: unknown) => NonNullable<typeof component>)({ requestRender }, { fg: (_tone: string, value: string) => value });
        requestRender();
      }
    },
  } } as unknown as ExtensionContext;
  const panel = open(ctx); panel.update(view);
  const text = rendered.at(-1)!;
  panel.update({ ...view, modelCalls: 3 });
  assert.equal(records.length, 1); assert.match(rendered.at(-1)!, /OBSERVED SDK 3/);
  assert.match(text, /RUNNING/); assert.match(text, /B · SELECTED/); assert.doesNotMatch(text, /PRIVATE|100%|tests passed/);
  assert.ok(text.split("\n").length < 20);
  handlers.get("session_before_tree")!(); assert.equal(records.at(-1), undefined);
  const count = records.length; panel.update(view); panel.close(); assert.equal(records.length, count);
  const next = open(ctx); next.update(view); session = "other"; next.update(view); next.close(); assert.equal(records.at(-1), undefined);
  const headless = open({ ...ctx, mode: "rpc" } as ExtensionContext), before = records.length;
  headless.update(view); headless.close(); assert.equal(records.length, before);
});

test("owned Windows scope transport accepts bounded progress separately and retains its sole final result", async t => {
  for (const malformed of [false, true]) {
    let cancelled = 0, closed = 0; const observations: unknown[] = [];
    const final: GoalWorkerReply = { type: "goal_result", files: { ...EMPTY_FILE_REPORT },
      reply: { type: "cancel", report: { startupMs: 0, executionMs: 1, modelCalls: 1, accounting: { status: "unknown" } } } };
    const frame = { type: "jev_worker_progress", version: 1, sequence: 1, phase: "tool_start", elapsedMs: 1, modelCalls: 1, toolCalls: 1, currentTool: "scope_read" };
    const child = Object.assign(new EventEmitter(), { pid: 123456, connected: true,
      kill() { queueMicrotask(() => child.emit("close", 1)); return true; },
      send(input: unknown, callback?: (error: null) => void) {
        callback?.(null);
        if (input && typeof input === "object" && "type" in input && input.type === "jev_worker_cancel") { cancelled++; queueMicrotask(() => child.emit("close", 1)); }
        else queueMicrotask(() => {
          child.emit("message", malformed ? { ...frame, PRIVATE_ARGS: "secret" } : frame);
          if (!malformed) { child.emit("message", final); child.emit("close", 0); }
        });
        return true;
      } });
    t.mock.method(windowsGoalProcessIO, "fork", () => { queueMicrotask(() => child.emit("spawn")); return child as unknown as ChildProcess; });
    t.mock.method(windowsGoalProcessIO, "own", async () => ({ close: async () => { closed++; return true; } }));
    const result = await runWindowsGoalProcess({ script: "ordinary-worker.ts", cwd: "/fixture", input: { synthetic: true }, deadline: Date.now() + 10000, timeoutMs: 10000 },
      (value): value is GoalWorkerReply => !!value && typeof value === "object" && "type" in value && value.type === "goal_result", undefined, progress => { observations.push(progress); });
    assert.equal(result.cleanupConfirmed, true); assert.ok(closed > 0);
    assert.equal(observations.length, malformed ? 0 : 1); assert.equal(cancelled, malformed ? 1 : 0);
    assert.equal(result.result === null, malformed);
    if (result.result) assert.deepEqual(result.result, final);
    t.mock.restoreAll();
  }
});

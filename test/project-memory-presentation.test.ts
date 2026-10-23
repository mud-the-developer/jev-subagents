import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateToVisualLines, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { memoryProgressText, memoryResultText, memoryWidget } from "../src/project-memory-presentation.ts";

test("memory result rows project only whitelisted metadata, never full snapshot data or hostile properties", () => {
  const data = { kind: "project_memory", status: "snapshot", stage: "disclosure", jevRequests: 5, pendingRequests: 0, selected: 1, snapshot: { PRIVATE_BODY: "secret" } };
  assert.match(memoryResultText(data), /snapshot/); assert.doesNotMatch(memoryResultText(data), /PRIVATE|secret/);
  assert.match(memoryResultText({ ...data, status: "parent_lookup", stage: "parent_lookup", parentLookup: { content: "PRIVATE_PARENT_BODY" } }), /parent_lookup/);
  assert.doesNotMatch(memoryResultText({ ...data, status: "parent_lookup", stage: "parent_lookup", parentLookup: { content: "PRIVATE_PARENT_BODY" } }), /PRIVATE_PARENT_BODY/);
  assert.doesNotMatch(memoryResultText({ ...data, status: "PRIVATE_STATUS" }), /PRIVATE/);
  assert.doesNotMatch(memoryResultText({ ...data, stage: "PRIVATE_STAGE", jevRequests: "PRIVATE_COUNT" }), /PRIVATE/);
  let getters = 0;
  assert.doesNotMatch(memoryResultText({ get kind() { getters++; return "PRIVATE"; } }), /PRIVATE/); assert.equal(getters, 0);
  assert.match(memoryResultText({ ...data, pendingRequests: -1 }), /pending unknown/);
});
test("native memory graph panel is bounded, explicit about omitted rows and cleared without an input handler", () => {
  const frames: unknown[] = [];
  const ctx = { mode: "tui", hasUI: true, ui: { setWidget(_key: string, value: unknown, options?: { placement: string }) {
    frames.push(value); if (value) assert.equal(options?.placement, "aboveEditor");
  } } } as unknown as ExtensionContext;
  const panel = memoryWidget(ctx), value = { phase: "deciding", visits: 4, maximum: 8, selected: 1, current: "fact_a",
    trail: Array.from({ length: 4 }, () => ({ node: "fact_" + "a".repeat(60), choice: "node_decision", support: 0.8 })) };
  panel.update(value);
  const factory = frames.at(-1) as (screen: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
  const component = factory({}, { fg: (_color: string, text: string) => text });
  for (const width of [24, 48, 80, 120]) {
    const lines = component.render(width); assert.ok(lines.length <= 16);
    for (const line of lines) assert.equal(truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, width, 0).visualLines.length, 1);
    if (width === 24) assert.match(lines.join("\n"), /Path rows omitted/);
  }
  assert.equal("handleInput" in component, false);
  assert.doesNotMatch(memoryProgressText(value), /100%|verified|\$/);
  panel.close(); assert.equal(frames.at(-1), undefined); const count = frames.length; panel.update(value); assert.equal(frames.length, count);
  const headless = memoryWidget({ ...ctx, mode: "rpc" } as ExtensionContext); headless.update(value); headless.close(); assert.equal(frames.length, count);
});

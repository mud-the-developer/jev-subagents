import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { planText, renderPlan, type PlanNodeState, type PlanPhase, type PlanTheme, type PlanView } from "../src/plan-presentation.ts";

const preview: PlanView = {
  phase: "approval", elapsedMs: 0, seconds: 120, modelCalls: 0,
  nodes: [
    { id: "read", title: "Read src/input.ts", after: [], state: "waiting" },
    { id: "patch", title: "Patch parser", after: ["read"], state: "waiting", agent: "worker", model: "offline/local", thinking: "high",
      alternatives: [{ id: "stable", title: "Keep API" }, { id: "next", title: "Revise API" }] },
  ],
};

// Measure cells through the public SDK, not UTF-16 length or a transitive TUI
// import. Card lines end in a border, so trailing padding is also measured.
function measuredWidth(line: string): number {
  const fits = (width: number) => {
    const result = truncateToVisualLines(line, 2, width, 0);
    return result.skippedCount === 0 && result.visualLines.length <= 1;
  };
  assert.ok(fits(256));
  let low = 1, high = 256;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}
test("tree task labels are one-line human-only text with bounded columns and escaped controls", () => {
  const view: PlanView = { version: 3, phase: "running", elapsedMs: 1, seconds: 120, modelCalls: 1,
    nodes: [{ id: "inspect", title: "PRIVATE_SOURCE_TITLE", kind: "task", after: [], state: "running", model: "demo/scout", thinking: "low", modelCalls: 1 }], edges: [] };
  for (const width of [24, 48, 80, 120]) {
    const lines = renderPlan(view, width, undefined, true, undefined, { inspect: "Inspect the approved source and identify the exact parser boundary without edits" });
    assert.ok(lines.every(line => measuredWidth(line) <= width));
    assert.match(lines.join("\n"), /MODEL/); assert.doesNotMatch(lines.join("\n"), /PRIVATE_SOURCE_TITLE/);
    if (width < 120) assert.match(lines.join("\n"), /…/);
  }
  const escaped = renderPlan(view, 120, undefined, true, undefined, { inspect: "Inspect\n\u001b[31mtext https://example.invalid" }).join("\n");
  assert.doesNotMatch(escaped, /\u001b|https?:/); assert.match(escaped, /\\n/);
  assert.doesNotMatch(renderPlan(view, 120, undefined, true).join("\n"), /Inspect the approved source/);
});
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) frozen(child);
  }
  return value;
}
function normalized(lines: readonly string[]): string[] { return lines.map(line => line.replace(/ +│$/u, " │")); }

const tree: PlanView = {
  version: 3, phase: "running", elapsedMs: 2000, seconds: 60, modelCalls: 2, modelCallsKnown: false,
  display: { maxDepth: 3, animations: true },
  nodes: [
    { id: "a", title: "PRIVATE_A", kind: "task", after: [], state: "completed_unverified", modelCalls: 1 },
    { id: "b", title: "PRIVATE_B", kind: "task", after: ["a"], state: "running", model: "offline/synthetic", thinking: "high", modelCalls: null },
    { id: "c", title: "PRIVATE_C", kind: "task", after: ["a", "b"], state: "pending", modelCalls: 0 },
    { id: "info", title: "PRIVATE_INFO", kind: "info", after: [], state: "ready" },
  ],
  edges: [
    { from: "a", to: "b", kind: "dependency", status: "active" },
    { from: "a", to: "c", kind: "dependency", status: "active" },
    { from: "b", to: "c", kind: "dependency", status: "pending" },
    { from: "info", to: "b", kind: "reference", status: "active" },
  ],
};
const colored: PlanTheme = {
  fg: (color, text) => `\u001b[${color === "error" ? 31 : color === "warning" ? 33 : color === "accent" ? 36 : 37}m${text}\u001b[39m`,
};

test("native preview keeps the rounded card, connected checklist, dependencies and every pending A/B choice", () => {
  const edge = "─".repeat(78), divider = `├${edge}┤`;
  assert.deepEqual(normalized(renderPlan(preview, 80)), [
    `╭${edge}╮`,
    "│ JEV / EXECUTION PLAN  [◇ AWAITING APPROVAL] │",
    divider,
    "│ ├─ ○ 1 · WAITING │",
    "│ │  Read src/input.ts │",
    "│ │  ID read │",
    "│ │  AFTER ← none │",
    "│ │  AGENT pending · MODEL pending · EFFORT pending │",
    "│ │ │",
    "│ └─ ○ 2 · WAITING │",
    "│    Patch parser │",
    "│    ID patch │",
    "│    AFTER ← read │",
    "│    AGENT worker · MODEL offline/local · EFFORT high │",
    "│    ├─ ◇ A · WAITING │",
    "│    │  Keep API │",
    "│    │  ID stable │",
    "│    └─ ◇ B · WAITING │",
    "│       Revise API │",
    "│       ID next │",
    divider,
    "│ ELAPSED 0:00 · LIMIT 2:00 · OBSERVED SDK 0 │",
    "│ Plan summary · not a substitute for exact-source approval │",
    `╰${edge}╯`,
  ]);
  assert.equal(planText(preview), renderPlan(preview, 80).join("\n"));
  assert.doesNotMatch(planText(preview), /\p{Cf}|\u001b/u);
});

test("all phases have fixed badges; running shows only supplied elapsed, ceiling, tool and observed rounds", () => {
  const labels: Record<PlanPhase, string> = {
    preparing: "PREPARING", approval: "AWAITING APPROVAL", selecting: "SELECTING", checking: "CHECKING SCOPE",
    running: "RUNNING", finished: "ENDED / UNVERIFIED", stopped: "STOPPED",
  };
  for (const phase of Object.keys(labels) as PlanPhase[]) {
    const text = planText({ ...preview, phase });
    assert.ok(text.includes(labels[phase]));
    assert.doesNotMatch(text, /tests passed|work accepted|100%|%|\$/u);
  }
  const running: PlanView = { ...preview, phase: "running", elapsedMs: 65_999, seconds: 86_400, modelCalls: 7, currentTool: "read",
    nodes: preview.nodes.map(node => ({ ...node, state: "running" })) };
  const text = planText(running, 120);
  assert.match(text, /▶ 1 · RUNNING/u);
  assert.match(text, /ELAPSED 1:05 · LIMIT 24:00:00 · OBSERVED SDK 7/u);
  assert.match(text, /LAST TOOL read/u);
  assert.doesNotMatch(text, /remaining|estimate|%|\$/u);
});

test("completed means ended UNVERIFIED, and stopped/failed/blocked do not imply success or alter other nodes", () => {
  const labels: Record<PlanNodeState, string> = {
    waiting: "WAITING", selecting: "SELECTING", running: "RUNNING", completed: "ENDED / UNVERIFIED", failed: "FAILED", blocked: "BLOCKED",
  };
  for (const state of Object.keys(labels) as PlanNodeState[]) {
    const view: PlanView = { ...preview, phase: state === "completed" ? "finished" : "stopped", nodes: [{ ...preview.nodes[0]!, state }] };
    const tones: string[] = [];
    const lines = renderPlan(view, 80, { fg: (tone, text) => { tones.push(tone); return text; } });
    assert.ok(lines.join("\n").includes(labels[state]));
    assert.equal(tones.includes("success"), false);
    assert.doesNotMatch(lines.join("\n"), /✓|tests passed|work accepted|100%/u);
    if (state === "completed") {
      assert.match(lines.join("\n"), /Execution ended ≠ verification passed · human review required/u);
    } else assert.match(lines.join("\n"), /Stopped · applied changes may remain/u);
  }
  const text = planText({ ...preview, phase: "finished" });
  assert.match(text, /○ 1 · WAITING/u); // A phase is not authority to change node states.
  assert.match(text, /UNVERIFIED/u);
});

test("true selects, false marks unselected and undefined waits without hiding alternatives or rewriting source", () => {
  const view: PlanView = { ...preview, phase: "selecting", nodes: [{ ...preview.nodes[1]!, state: "selecting",
    alternatives: [{ id: "stable", title: "Keep API", selected: false }, { id: "next", title: "Revise API", selected: true }] }] };
  const text = planText(view);
  assert.match(text, /─ A · NOT SELECTED/u); assert.match(text, /◆ B · SELECTED/u);
  for (const literal of ["Keep API", "Revise API", "stable", "next", "Patch parser", "AFTER ← read"]) assert.ok(text.includes(literal));
  assert.match(planText(preview), /◇ A · WAITING/u); assert.match(planText(preview), /◇ B · WAITING/u);
  const colors = new Map<string, string>();
  renderPlan(view, 80, { fg: (tone, value) => { colors.set(value, tone); return value; } });
  assert.equal(colors.get("◆ B · SELECTED"), "accent"); assert.equal(colors.get("─ A · NOT SELECTED"), "dim");
});

test("Korean, grapheme emoji, paths and long model names fit measured widths with bounded rows, with or without a theme", () => {
  const view: PlanView = { ...preview, phase: "running", currentTool: "read", nodes: [
    { ...preview.nodes[0]!, title: 'Keep 한글 👩🏽‍💻 🇰🇷 e\u0301 in "src/계획.ts"', state: "completed", model: "provider/" + "long-model-".repeat(100), thinking: "high" },
    { ...preview.nodes[1]!, state: "running", alternatives: [
      { id: "stable", title: "Keep 👨‍👩‍👧‍👦 and 한글", selected: true },
      { id: "next", title: "Keep C:\\src\\코드.ts", selected: false },
    ] },
    { id: "report", title: "Report changes", after: ["read", "patch"], state: "blocked" },
  ] };
  for (const width of [24, 48, 80, 120]) {
    const plain = renderPlan(view, width), themed = renderPlan(view, width, colored);
    assert.ok(plain.length <= 128);
    assert.deepEqual(themed.map(stripVTControlCharacters), plain);
    for (const line of [...plain, ...themed]) assert.equal(measuredWidth(line), width);
    for (const line of plain) assert.doesNotMatch(line, /\p{Cc}/u);
    const text = plain.join("\n");
    assert.ok(text.includes("👩🏽‍💻")); assert.ok(text.includes("👨‍👩‍👧‍👦"));
    const unwrapped = text.replace(/│/g, " ").replace(/\s+/g, " ");
    assert.match(unwrapped, /◆ A · SELECTED/u); assert.match(unwrapped, /─ B · NOT SELECTED/u);
    assert.match(unwrapped, /Content omitted/u); assert.match(text, /MODEL/u); assert.match(text, /EFFORT high/u);
    assert.equal(planText(view, width), plain.join("\n"));
  }
  const wide = planText(view, 120);
  for (const source of ['Keep 한글 👩🏽‍💻 🇰🇷 e\u0301 in "src/계획.ts"', "C:\\src\\코드.ts", "AFTER ← read, patch"]) assert.ok(wide.includes(source));
  for (const width of [1, 2, 7, 8, 12, 16, 23, 240]) {
    const lines = renderPlan(view, width);
    assert.ok(lines.length <= 256);
    for (const line of lines) assert.ok(measuredWidth(line) <= width);
  }
  for (const width of [0, -1, NaN, Infinity, 24.5]) assert.deepEqual(renderPlan(view, width), []);
});

test("every DTO string quotes terminal/control/bidi data; URL spans and undeclared private fields stay out", () => {
  const hostile = "\u001b[31mX\u001b[0m\u009b2J\n\t\u061c\u200e\u202e\u2066\u2069";
  const view = { ...preview, currentTool: hostile, nodes: [{ id: hostile, title: hostile, after: [hostile], state: "waiting" as const,
    agent: hostile, model: hostile, thinking: hostile, alternatives: [{ id: hostile, title: hostile }] }],
    get args(): never { throw new Error("Private arguments must not be inspected."); },
    get output(): never { throw new Error("Private output must not be inspected."); },
    get reports(): never { throw new Error("Private reports must not be inspected."); },
  };
  const lines = renderPlan(view, 120), text = lines.join("\n");
  for (const line of lines) assert.doesNotMatch(line, /[\p{Cc}\u061c\u200e\u202a-\u202e\u2066-\u206f]/u);
  for (const escape of ["\\u001b", "\\u009b", "\\n", "\\t", "\\u061c", "\\u202e", "\\u2066"]) assert.ok(text.includes(escape));
  assert.equal(stripVTControlCharacters(text), text);
  assert.deepEqual(renderPlan(view, 120, colored).map(stripVTControlCharacters), lines);
  const urls = planText({ ...preview, currentTool: "https://private.invalid/key", nodes: [{ ...preview.nodes[0]!,
    title: "Read \u001b]8;;https://private.invalid/token\u0007source\u001b]8;;\u0007 then file:///secret/path" }] });
  assert.doesNotMatch(urls, /private\.invalid|\/secret\/path|https:\/\/|file:\/\//u);
  assert.match(urls, /address withheld/u);
});

test("source and out-of-contract collections are never silently truncated; invalid observations are not fabricated zeroes", () => {
  const long: PlanView = { ...preview, nodes: Array.from({ length: 4 }, (_, index) => ({
    id: `stage-${index}`, title: "Literal source ".repeat(2000), after: ["a", "b", "c", "d"], state: "waiting",
    alternatives: ["first", "second", "third"].map(id => ({ id, title: id.repeat(2000), selected: false })),
  })) };
  const lines = renderPlan(long, 24), text = lines.join("\n");
  assert.ok(lines.length <= 128);
  const unwrapped = text.split("\n").map(line => line.replace(/^│\s*|\s*│$/g, "")).join(" ").replace(/\s+/g, " ");
  assert.match(unwrapped, /Content omitted/u); assert.match(unwrapped, /additional stages/u); assert.match(unwrapped, /additional branches/u);
  assert.ok(lines.some(line => line.includes("…")));
  for (const value of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    const invalid = planText({ ...preview, elapsedMs: value, seconds: value, modelCalls: value }, 120);
    assert.match(invalid, /ELAPSED unknown · LIMIT unknown · OBSERVED SDK unknown/u);
  }
  assert.match(planText({ ...preview, nodes: [] }), /No planned stages/u);
});

test("compact tree depth shows every hidden state once; joins use their deepest predecessor and expanded plans stay complete", () => {
  for (const maxDepth of [1, 2, 3]) {
    const view = { ...tree, display: { maxDepth, animations: true } };
    const compact = renderPlan(view, 120, undefined, true).join("\n");
    const expanded = renderPlan(view, 120).join("\n");
    assert.match(compact, /COMPLETED \/ UNVERIFIED/);
    if (maxDepth === 1) {
      assert.match(compact, /2 hidden descendants · 1 PENDING · 1 RUNNING/);
      assert.doesNotMatch(compact, /▶ b|○ c/);
    } else if (maxDepth === 2) {
      assert.match(compact, /1 hidden descendant · 1 PENDING/); assert.match(compact, /▶ b/); assert.doesNotMatch(compact, /○ c/);
    } else { assert.doesNotMatch(compact, /hidden descendant/); assert.match(compact, / {6}└─ ○ c/); }
    for (const id of ["a", "b", "c"]) assert.match(expanded, new RegExp(`TASK ${id}`));
    assert.match(expanded, /INFO info/); assert.doesNotMatch(expanded, /hidden descendant/);
    assert.equal(expanded, renderPlan({ ...view, display: { maxDepth: 3, animations: false } }, 120).join("\n"));
    assert.deepEqual(renderPlan({ ...view, nodes: [...view.nodes].reverse(), edges: [...view.edges!].reverse() }, 120, undefined, true), renderPlan(view, 120, undefined, true));
  }
  const stopped = { ...tree, phase: "stopped" as const, display: { maxDepth: 1 }, nodes: tree.nodes.map(node => ({ ...node, state: "stopped" as const })) };
  assert.match(renderPlan(stopped, 120, undefined, true).join("\n"), /2 hidden descendants · 2 STOPPED/);
});

test("supplied frames animate spinners and live connectors deterministically without changing observations or terminal states", () => {
  const themed: PlanTheme = { ...colored, bg: (_tone, text) => `\u001b[44m${text}\u001b[49m`, bold: text => `\u001b[1m${text}\u001b[22m` };
  const before = structuredClone(tree), view = frozen(structuredClone(tree));
  for (const width of [24, 48, 80, 120]) {
    const frames = Array.from({ length: 8 }, (_, tick) => renderPlan(view, width, themed, true, { tick }));
    assert.equal(new Set(frames.map(lines => lines.join("\n"))).size, 8);
    for (const [tick, lines] of frames.entries()) {
      assert.deepEqual(renderPlan(view, width, themed, true, { tick }), lines);
      assert.deepEqual(lines.map(stripVTControlCharacters), renderPlan(view, width, undefined, true, { tick }));
      lines.forEach(line => assert.equal(measuredWidth(line), width));
      assert.doesNotMatch(stripVTControlCharacters(lines.join("\n")), /PRIVATE|%|\$|cleanup|accepted/);
    }
    assert.deepEqual(renderPlan(view, width, themed, true, { tick: 8 }), frames[0]);
    for (const staticView of [{ ...view, display: { animations: false } }, { ...view, phase: "finished" as const }, { ...view, phase: "stopped" as const }, { ...view, phase: "approval" as const }]) {
      assert.deepEqual(renderPlan(staticView, width, themed, true, { tick: 0 }), renderPlan(staticView, width, themed, true, { tick: 5 }));
    }
  }
  const first = renderPlan(view, 120, undefined, true, { tick: 0 }).join("\n"), next = renderPlan(view, 120, undefined, true, { tick: 1 }).join("\n");
  assert.match(first, /⠋ b/); assert.match(next, /⠙ b/); assert.match(next, /└╼/);
  for (const frame of [first, next]) {
    assert.match(frame, /OBSERVED SDK unknown/); assert.match(frame, /unknown \(observed 2\)/); assert.match(frame, /ELAPSED 0:02/);
    assert.match(frame, /MODEL offline\/synthetic · EFFORT high/);
  }
  assert.deepEqual(view, before);
});

test("animated tree Unicode and hostile data fit SDK cell widths; collapsed states never vanish at narrow widths", () => {
  const id = '한글 👩🏽‍💻 🇰🇷 e\u0301 \u001b[31mX\u001b[0m\n\t\u202e';
  const view: PlanView = { ...tree, nodes: tree.nodes.map(node => ({ ...node,
    id: node.id === "b" ? id : node.id, after: node.after.map(prior => prior === "b" ? id : prior),
    model: "https://private.invalid/key", thinking: "high\u009b2J", })),
    edges: tree.edges!.map(edge => ({ ...edge, from: edge.from === "b" ? id : edge.from, to: edge.to === "b" ? id : edge.to })),
  };
  for (const width of [24, 48, 80, 120]) for (const maxDepth of [1, 2, 3]) {
    const lines = renderPlan({ ...view, display: { maxDepth } }, width, colored, true, { tick: 2 });
    assert.ok(lines.length < 150);
    lines.forEach(line => assert.equal(measuredWidth(line), width));
    const text = lines.map(stripVTControlCharacters).join("\n");
    assert.doesNotMatch(text, /[\u001b\u009b\u202e]|private\.invalid|https:\/\/|%/);
    const unwrapped = text.replace(/│/g, " ").replace(/\s+/g, " ");
    assert.match(unwrapped, /RUNNING/); assert.match(unwrapped, /PENDING/);
    if (maxDepth < 3) assert.match(unwrapped, /hidden descendant/);
    if (maxDepth > 1) assert.match(text, /👩🏽‍💻/);
  }
});

test("rendering is deterministic, does not mutate frozen input and does no IO, clock reads, randomness or scheduling", t => {
  const input = frozen(structuredClone(preview)), before = structuredClone(input);
  const forbidden = () => { throw new Error("Presentation must be pure."); };
  const mocks = [
    t.mock.method(globalThis, "fetch", forbidden), t.mock.method(globalThis, "setTimeout", forbidden),
    t.mock.method(globalThis, "setInterval", forbidden), t.mock.method(Date, "now", forbidden), t.mock.method(performance, "now", forbidden), t.mock.method(Math, "random", forbidden),
    t.mock.method(fs, "readFileSync", forbidden), t.mock.method(fs, "writeFileSync", forbidden),
    t.mock.method(childProcess, "spawn", forbidden), t.mock.method(childProcess, "fork", forbidden),
  ];
  try {
    const first = renderPlan(input, 80);
    assert.deepEqual(renderPlan(input, 80), first);
    assert.equal(planText(input), first.join("\n"));
    renderPlan(input, 24, colored);
    for (const tick of [0, 1, 7]) renderPlan(tree, 48, colored, true, { tick });
    assert.deepEqual(input, before);
    for (const mock of mocks) assert.equal(mock.mock.callCount(), 0);
  } finally { t.mock.restoreAll(); }
});

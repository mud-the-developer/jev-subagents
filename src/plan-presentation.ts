import { truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";

export type PlanPhase = "preparing" | "approval" | "selecting" | "checking" | "running" | "finished" | "stopped";
export type PlanNodeState = "waiting" | "selecting" | "running" | "completed" | "failed" | "blocked";
export type GraphPlanNodeState = PlanNodeState | "ready" | "skipped" | "chosen" | "joined" | "pending" | "completed_unverified" | "stopped";
export type PlanAlternativeView = {
  readonly id: string;
  readonly title: string;
  readonly selected?: boolean;
};
export type PlanEdgeView = { readonly from: string; readonly to: string; readonly when?: string; readonly kind?: "dependency" | "produced" | "reference"; readonly status: "active" | "inactive" | "pending" };
export type PlanNodeView = {
  readonly id: string;
  readonly kind?: "task" | "choice" | "join" | "info";
  readonly modelCalls?: number | null;
  readonly chosenChoiceId?: string;
  readonly title: string;
  readonly after: readonly string[];
  readonly state: GraphPlanNodeState;
  readonly agent?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly alternatives?: readonly PlanAlternativeView[];
};
/** Public presentation data, never an execution/approval packet. The adapter owns
 * ordering, states and observations (legacy stages or a bounded v2 graph).
 * Supply public labels only: no arguments, output, reports, credentials or URLs. */
export type PlanView = {
  readonly version?: 2 | 3;
  readonly entry?: string;
  readonly edges?: readonly PlanEdgeView[];
  /** Tree-only presentation preferences. Never execution depth or animation clocks. */
  readonly display?: { readonly maxDepth?: number; readonly animations?: boolean };
  readonly phase: PlanPhase;
  readonly nodes: readonly PlanNodeView[];
  readonly elapsedMs: number;
  /** Approved execution-time ceiling, not an approval countdown. */
  readonly seconds: number;
  /** Observed SDK rounds, not predicted calls or a progress denominator. */
  readonly modelCalls: number;
  readonly modelCallsKnown?: boolean;
  /** Public tool name only, never its arguments. */
  readonly currentTool?: string;
};
export type PlanTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bg" | "bold">>;
/** Supplied by the ephemeral widget, never stored in a view or receipt. */
export type PlanFrame = { readonly tick: number };
/** Reviewed human-only labels travel separately from transcript-safe plan data. */
export type PlanTaskLabels = Readonly<Record<string, string>>;
export function planHasActivity(view: PlanView): boolean {
  return ["running", "selecting", "checking"].includes(view.phase);
}
const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

type Tone = "text" | "accent" | "muted" | "dim" | "warning" | "error" | "borderAccent" | "borderMuted";
type Badge = { readonly glyph: string; readonly label: string; readonly tone: Tone };
const phases: Readonly<Record<PlanPhase, Badge>> = {
  preparing: { glyph: "○", label: "PREPARING", tone: "muted" },
  approval: { glyph: "◇", label: "AWAITING APPROVAL", tone: "warning" },
  selecting: { glyph: "◇", label: "SELECTING", tone: "accent" },
  checking: { glyph: "◈", label: "CHECKING SCOPE", tone: "warning" },
  running: { glyph: "▶", label: "RUNNING", tone: "accent" },
  finished: { glyph: "■", label: "ENDED / UNVERIFIED", tone: "warning" },
  stopped: { glyph: "■", label: "STOPPED", tone: "error" },
};
const states: Readonly<Record<GraphPlanNodeState, Badge>> = {
  pending: { glyph: "○", label: "PENDING", tone: "muted" },
  completed_unverified: { glyph: "☑", label: "COMPLETED / UNVERIFIED", tone: "warning" },
  stopped: { glyph: "×", label: "STOPPED", tone: "error" },
  waiting: { glyph: "○", label: "WAITING", tone: "muted" },
  ready: { glyph: "◇", label: "READY", tone: "accent" },
  skipped: { glyph: "─", label: "SKIPPED", tone: "dim" },
  chosen: { glyph: "◆", label: "CHOSEN", tone: "accent" },
  joined: { glyph: "◈", label: "JOINED", tone: "muted" },
  selecting: { glyph: "◇", label: "SELECTING", tone: "accent" },
  running: { glyph: "▶", label: "RUNNING", tone: "accent" },
  completed: { glyph: "☑", label: "ENDED / UNVERIFIED", tone: "warning" },
  failed: { glyph: "×", label: "FAILED", tone: "error" },
  blocked: { glyph: "⊘", label: "BLOCKED", tone: "warning" },
};

// These are presentation bounds, not execution limits. Every omitted field tail,
// stage or branch is marked; this card must never replace immutable source review.
const MAX_STAGES = 3, MAX_ALTERNATIVES = 2, MAX_FIELD_UNITS = 4096;

/** Like humanLiteral in task-review-machine, keep ordinary source untranslated.
 * Here even newlines/tabs are quoted so data cannot forge checklist rows. C1,
 * directional marks/isolates, separators and lone surrogates are quoted too.
 * Keep ZWJ/ZWNJ and variation selectors intact (including emoji graphemes). */
function literal(value: string): string {
  return value
    .replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\b(?:mailto|data|javascript):|\bwww\.)[^\s\p{Cc}<>"']*/giu, "[address withheld]")
    .replace(/[\p{Cc}\p{Cs}\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, char => {
      if (char === "\n") return "\\n";
      if (char === "\r") return "\\r";
      if (char === "\t") return "\\t";
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });
}
function validCount(value: number | null): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function duration(seconds: number): string {
  if (!validCount(seconds)) return "unknown";
  const minutes = Math.floor(seconds / 60), rest = String(seconds % 60).padStart(2, "0");
  return minutes < 60 ? `${minutes}:${rest}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

// The public SDK pads each visual line to the requested width. Use that padding
// for the right border, rather than depending on a transitive pi-tui import or
// approximating CJK/emoji/ANSI cell widths. Never ask this tail-truncating helper
// to discard source: retain the head explicitly and mark omissions below.
function visualLines(text: string, width: number): string[] {
  return truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, width, 0).visualLines;
}
type Prefix = { readonly text: string; readonly columns: number };
const noPrefix: Prefix = { text: "", columns: 0 };

/** Pure, synchronous native Pi card. No clock, IO, state changes or theme globals.
 * Widths 24/48/80/120 are supported; cards stop growing at 120 columns. Below
 * eight columns only an ellipsis fits usefully. Long fields show their head plus
 * an explicit omission marker; all in-contract A/B choices retain separate rows.
 * The same bounded layout is used by planText, with no ANSI in unthemed output. */
export function renderPlan(view: PlanView, width: number, theme?: PlanTheme, summary = false, frame?: PlanFrame, taskLabels?: PlanTaskLabels): string[] {
  if (!Number.isSafeInteger(width) || width <= 0) return [];
  const columns = Math.min(width, 120);
  if (columns < 8) return ["…"];
  const inner = columns - 4, compact = columns < 24;
  const paint = (tone: Tone, text: string) => theme ? theme.fg(tone, text) : text;
  const tick = summary && view.display?.animations !== false && planHasActivity(view) && frame && validCount(frame.tick) ? frame.tick % spinners.length : undefined;
  const glyph = (badge: Badge, active: boolean) => active && tick !== undefined ? spinners[tick]! : badge.glyph;
  const pill = (badge: Badge, text: string) => {
    const styled = paint(badge.tone, theme?.bold ? theme.bold(text) : text);
    return theme?.bg ? theme.bg(badge.tone === "error" ? "toolErrorBg" : "toolPendingBg", styled) : styled;
  };
  const lines: string[] = [];
  let omitted = false;

  function source(value: string): string {
    if (value.length > MAX_FIELD_UNITS) omitted = true;
    // Do not split a surrogate pair at the resource bound.
    const end = value.length > MAX_FIELD_UNITS && /[\ud800-\udbff]/u.test(value[MAX_FIELD_UNITS - 1]!)
      ? MAX_FIELD_UNITS - 1 : MAX_FIELD_UNITS;
    return literal(value.slice(0, end)) + (value.length > MAX_FIELD_UNITS ? " …" : "");
  }
  function rule(left: string, right: string, tone: Tone = "borderMuted") {
    lines.push(paint(tone, left + "─".repeat(columns - 2) + right));
  }
  function row(text: string, prefix: Prefix = noPrefix, limit = 3, continuation: Prefix = prefix) {
    const available = inner - prefix.columns;
    const wrapped = visualLines(text, available);
    const clipped = wrapped.length > limit;
    if (clipped) omitted = true;
    const shown = clipped ? [...wrapped.slice(0, limit - 1), ...visualLines(paint("warning", "…"), available)] : wrapped;
    for (const [index, line] of (shown.length ? shown : [" ".repeat(available)]).entries()) {
      lines.push(paint("borderMuted", "│ ") + paint("borderMuted", index === 0 ? prefix.text : continuation.text) + line + paint("borderMuted", " │"));
    }
  }
  function field(label: string, value: string, prefix: Prefix, tone: Tone = "muted", limit = 3) {
    row(paint("dim", `${label} `) + paint(tone, source(value)), prefix, limit);
  }
  // Fixed notices are never truncated, even in very small terminals.
  function notice(text: string, tone: Tone = "muted") {
    row(paint(tone, text), noPrefix, Number.MAX_SAFE_INTEGER);
  }

  const phase = phases[view.phase];
  rule("╭", "╮", "borderAccent");
  const heading = "JEV / EXECUTION PLAN", badge = `[${glyph(phase, true)} ${phase.label}]`;
  const phaseBadge = view.version === 3 ? pill(phase, badge) : paint(phase.tone, badge);
  if (visualLines(`${heading}  ${badge}`, inner).length > 1) {
    row(paint("accent", heading), noPrefix, Number.MAX_SAFE_INTEGER);
    row(phaseBadge, noPrefix, Number.MAX_SAFE_INTEGER);
  } else row(paint("accent", heading) + "  " + phaseBadge, noPrefix, Number.MAX_SAFE_INTEGER);
  rule("├", "┤");

  const tree = view.version === 3, graph = view.version === 2 || tree, stageLimit = tree ? 11 : graph ? 16 : MAX_STAGES;
  const edges = (graph ? view.edges ?? [] : []).slice(0, 32).sort((a, b) => {
    const left = `${a.from}\0${a.to}\0${a.when ?? ""}`, right = `${b.from}\0${b.to}\0${b.when ?? ""}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let nodes = view.nodes.slice(0, stageLimit);
  if (graph) {
    const pending = [...nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ordered: PlanNodeView[] = [];
    const ids = new Set(nodes.map(node => node.id));
    let invalid = ids.size !== nodes.length || edges.some(edge => !ids.has(edge.from) || !ids.has(edge.to));
    while (pending.length) {
      const index = pending.findIndex(node => edges.every(edge => edge.to !== node.id || !pending.some(prior => prior.id === edge.from)));
      if (index < 0) { invalid = true; ordered.push(...pending); break; }
      ordered.push(pending.splice(index, 1)[0]!);
    }
    nodes = ordered;
    notice(`${tree ? "TASK TREE" : `DAG v2 · ENTRY ${source(view.entry ?? "unknown")}`} · ${view.nodes.length} NODES / ${view.edges?.length ?? 0} LINKS`, "accent");
    if (invalid) notice("Invalid graph connections · inspect the exact source", "warning");
    if (!tree && summary && nodes.length > 4) {
      const priority = [...nodes.filter(node => ["running", "selecting", "failed"].includes(node.state)),
        ...nodes.filter(node => node.kind === "choice" && node.state === "chosen"),
        ...nodes.filter(node => node.state === "ready"), ...nodes.filter(node => node.kind === "join"), ...nodes];
      const shown = new Set(priority.map(node => node.id).filter((id, index, all) => all.indexOf(id) === index).slice(0, 4));
      nodes = nodes.filter(node => shown.has(node.id));
      notice(`… ${ordered.length - nodes.length} more nodes · expand for the complete graph`, "dim");
    }
  }
  if (!nodes.length) notice("○ No planned stages");
  if (!graph) for (const [index, node] of nodes.entries()) {
    const last = index === nodes.length - 1;
    const head: Prefix = { text: last ? compact ? "└" : "└─ " : compact ? "├" : "├─ ", columns: compact ? 1 : 3 };
    const tail: Prefix = { text: last ? compact ? " " : "   " : compact ? "│" : "│  ", columns: compact ? 1 : 3 };
    const badge = states[node.state];
    row(paint(badge.tone, `${glyph(badge, node.state === "running" || node.state === "selecting")} ${index + 1} · ${summary ? `${source(node.id)} · ` : ""}${badge.label}`), head, 12, tail);
    if (!summary) { row(paint("text", source(node.title)), tail); field("ID", node.id, tail, "dim", 2); }
    // Do not infer edges from ordering, select a branch or propagate a failure.
    const dependencies = node.after.slice(0, MAX_STAGES).map(id => source(id));
    if (node.after.length > MAX_STAGES) { dependencies.push("…"); omitted = true; }
    row(paint("muted", `AFTER ← ${dependencies.length ? dependencies.join(", ") : "none"}`), tail, 3);

    const metadata = [
      ["AGENT", node.agent ?? "pending"], ["MODEL", node.model ?? "pending"], ["EFFORT", node.thinking ?? "pending"],
    ] as const;
    const strip = metadata.map(([label, value]) => paint("dim", `${label} `) + paint("muted", source(value))).join(paint("dim", " · "));
    if (!summary || node.state === "running" || node.state === "selecting") {
      if (visualLines(strip, inner - tail.columns).length === 1) row(strip, tail);
      else for (const [label, value] of metadata) field(label, value, tail, "muted", 3);
    }

    const alternatives = node.alternatives?.slice(0, MAX_ALTERNATIVES) ?? [];
    for (const [choiceIndex, choice] of alternatives.entries()) {
      const finalChoice = choiceIndex === alternatives.length - 1;
      const branchHead: Prefix = { text: tail.text + (finalChoice ? compact ? "└" : "└─ " : compact ? "├" : "├─ "), columns: compact ? 2 : 6 };
      const branchTail: Prefix = { text: tail.text + (finalChoice ? compact ? " " : "   " : compact ? "│" : "│  "), columns: compact ? 2 : 6 };
      const chosen: Badge = choice.selected === true ? { glyph: "◆", label: "SELECTED", tone: "accent" }
        : choice.selected === false ? { glyph: "─", label: "NOT SELECTED", tone: "dim" }
          : { glyph: "◇", label: "WAITING", tone: "muted" };
      row(paint(chosen.tone, `${chosen.glyph} ${choiceIndex === 0 ? "A" : "B"} · ${chosen.label}${summary ? ` · ${source(choice.id)}` : ""}`), branchHead, 8, branchTail);
      if (!summary) { row(paint(choice.selected === false ? "muted" : "text", source(choice.title)), branchTail); field("ID", choice.id, branchTail, "dim", 2); }
    }
    if ((node.alternatives?.length ?? 0) > MAX_ALTERNATIVES) {
      omitted = true;
      row(paint("warning", `… ${node.alternatives!.length - MAX_ALTERNATIVES} additional branches omitted`), tail, 12);
    }
    if (!last && !summary) row("", tail);
  }
  if (tree && summary) {
    const tasks = nodes.filter(node => node.kind === "task"), shown = new Set<string>(), depths = new Map<string, number>();
    const parents = new Map<string, string | undefined>();
    // Display joins once under the deepest predecessor (lexical tie-break), not array order.
    // This is layout only: all incoming dependencies stay explicit; states are never inferred.
    for (const node of tasks) {
      const predecessors = node.after.filter(id => tasks.some(task => task.id === id)).sort((a, b) =>
        (depths.get(b) ?? 0) - (depths.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
      depths.set(node.id, 1 + Math.max(0, ...predecessors.map(id => depths.get(id) ?? 0)));
      parents.set(node.id, predecessors[0]);
    }
    const limit = view.display?.maxDepth;
    const displayDepth = limit !== undefined && Number.isInteger(limit) && limit >= 1 && limit <= 3 ? limit : 3;
    const children = (id: string) => tasks.filter(task => parents.get(task.id) === id);
    const descendants = (id: string): PlanNodeView[] => {
      const found = new Set([id]), pending = [...children(id)], result: PlanNodeView[] = [];
      while (pending.length) {
        const node = pending.shift()!;
        if (found.has(node.id)) continue;
        found.add(node.id); result.push(node); pending.push(...children(node.id));
      }
      return result;
    };
    const active = (node: PlanNodeView) => node.state === "running" || node.state === "selecting";
    const stateCounts = (values: readonly PlanNodeView[]) => (Object.keys(states) as GraphPlanNodeState[]).flatMap(state => {
      const count = values.filter(node => node.state === state).length;
      return count ? [`${count} ${states[state].label}`] : [];
    }).join(" · ");
    const step = columns < 48 ? 1 : 3;
    const draw = (node: PlanNodeView, prefix: Prefix, last: boolean) => {
      if (shown.has(node.id)) return;
      shown.add(node.id);
      const below = descendants(node.id), live = tick !== undefined && [node, ...below].some(active);
      if (prefix.columns + step >= inner) { prefix = noPrefix; omitted = true; }
      const stroke = live ? ["─", "╼", "━", "╾"][tick! % 4]! : "─";
      const connector = (last ? "└" : "├") + (step === 3 ? `${stroke} ` : "");
      const tone: Tone = live && tick! % 2 === 0 ? "accent" : "borderMuted";
      const head: Prefix = { text: prefix.text + paint(tone, connector), columns: prefix.columns + step };
      const tail: Prefix = { text: prefix.text + paint(tone, last ? " ".repeat(step) : step === 1 ? "│" : "│  "), columns: head.columns };
      const badge = states[node.state], name = paint(badge.tone, `${glyph(badge, active(node))} ${source(node.id)}`);
      const status = pill(badge, `[${badge.label}]`), heading = `${name} · ${status}`;
      if (visualLines(heading, inner - head.columns).length <= 2) row(heading, head, 2, tail);
      else { row(name, head, 2, tail); row(status, tail, Number.MAX_SAFE_INTEGER); }
      const label: unknown = taskLabels ? Object.getOwnPropertyDescriptor(taskLabels, node.id)?.value : undefined;
      const labeled = typeof label === "string" && label.trim().length > 0;
      if (labeled) {
        const text = paint("muted", `MODEL ${source(node.model ?? "pending")} — ${source(label.slice(0, 120))}`);
        const available = inner - tail.columns, wrapped = visualLines(text, available);
        if (wrapped.length > 1) {
          omitted = true;
          row(visualLines(text, available - 2)[0]! + paint("warning", " …"), tail, 1);
        } else row(text, tail, 1);
      } else row(paint("muted", `MODEL ${source(node.model ?? "pending")} · EFFORT ${source(node.thinking ?? "pending")}`), tail, 3);
      if (node.after.length) row(paint("dim", `DEPENDENCY ← ${node.after.map(id => source(id)).join(", ")}`), tail, 2);
      const references = edges.filter(edge => edge.kind === "reference" && edge.to === node.id);
      if (references.length) {
        const selected = references.filter(edge => edge.status === "active").map(edge => source(edge.from));
        row(paint("dim", `REFERENCES ${selected.length ? selected.join(", ") : references.some(edge => edge.status === "pending") ? "pending" : "none"}`), tail, 2);
      }
      if (node.modelCalls !== undefined) row(paint("dim", `${labeled ? `EFFORT ${source(node.thinking ?? "pending")} · ` : ""}OBSERVED SDK ${validCount(node.modelCalls) ? node.modelCalls : "unknown"}`), tail, 2);
      else if (labeled) row(paint("dim", `EFFORT ${source(node.thinking ?? "pending")}`), tail, 2);
      if ((depths.get(node.id) ?? 1) >= displayDepth && below.length) {
        below.forEach(node => shown.add(node.id));
        row(paint("muted", `… ${below.length} hidden descendant${below.length === 1 ? "" : "s"} · ${stateCounts(below)}`), tail, Number.MAX_SAFE_INTEGER);
      } else children(node.id).forEach((child, index, all) => draw(child, tail, index === all.length - 1));
    };
    const roots = tasks.filter(node => !parents.get(node.id));
    roots.forEach((node, index) => draw(node, noPrefix, index === roots.length - 1));
    tasks.filter(node => !shown.has(node.id)).forEach(node => draw(node, noPrefix, true));
    const information = nodes.filter(node => node.kind === "info");
    if (information.length) notice(`INFO ${information.length} · READY ${information.filter(node => node.state === "ready").length}${information.some(node => node.state !== "ready") ? ` · ${stateCounts(information.filter(node => node.state !== "ready"))}` : ""} · expand for full links`, "dim");
  }
  if (graph && !(tree && summary)) for (const node of nodes) {
    const badge = states[node.state], kind = (node.kind ?? "task").toUpperCase();
    row(paint(badge.tone, `${glyph(badge, node.state === "running" || node.state === "selecting")} ${kind} ${source(node.id)} · ${badge.label}`), noPrefix, summary ? 2 : 8);
    if (!summary && node.title !== node.id) row(paint("text", source(node.title)));
    if (node.chosenChoiceId !== undefined) field("CHOICE", node.chosenChoiceId, noPrefix, "accent", 2);
    const incoming = edges.filter(edge => edge.to === node.id);
    if ((!summary || tree || node.kind === "join") && incoming.length) row(paint("dim", "IN ← ") + incoming.map(edge =>
      paint(edge.status === "inactive" ? "dim" : "muted", `${source(edge.from)} [${edge.status.toUpperCase()}]`)).join(paint("dim", ", ")), noPrefix, summary ? 2 : 5);
    if (node.kind === "task" && (!summary || tree || node.state === "running" || node.state === "selecting")) {
      const metadata = [["AGENT", node.agent ?? "pending"], ["MODEL", node.model ?? "pending"], ["EFFORT", node.thinking ?? "pending"]] as const;
      const strip = metadata.map(([label, value]) => `${label} ${source(value)}`).join(" · ");
      if (visualLines(strip, inner).length === 1) row(paint("muted", strip));
      else for (const [label, value] of metadata) field(label, value, noPrefix, "muted", summary ? 2 : 3);
    }
    if (tree && node.modelCalls !== undefined) row(paint("dim", `OBSERVED SDK ${validCount(node.modelCalls) ? node.modelCalls : "unknown"}`));
    const outgoing = edges.filter(edge => edge.from === node.id), shown = summary && !tree ? outgoing.slice(0, 2) : outgoing;
    for (const [index, edge] of shown.entries()) {
      const tone: Tone = edge.status === "active" ? "accent" : edge.status === "inactive" ? "dim" : "muted";
      const connector = index === shown.length - 1 ? "└" : "├", stroke = edge.status === "active" ? "━" : edge.status === "inactive" ? "┄" : "─";
      row(paint(tone, `${connector}${stroke} ${tree && edge.kind ? `${edge.kind.toUpperCase()} ` : ""}${edge.when !== undefined ? `[${source(edge.when)}] ` : ""}→ ${source(edge.to)} · ${edge.status.toUpperCase()}`), noPrefix, summary ? 2 : 8);
      const option = edge.when !== undefined ? node.alternatives?.find(choice => choice.id === edge.when) : undefined;
      if (!summary && option && option.title !== option.id) row(paint(tone, source(option.title)), { text: "   ", columns: 3 });
    }
    if (shown.length < outgoing.length) notice(`… ${outgoing.length - shown.length} more outgoing links · expand`, "dim");
    if (!summary) row("");
  }
  if (view.nodes.length > stageLimit) {
    omitted = true;
    notice(`… ${view.nodes.length - stageLimit} additional stages omitted`, "warning");
  }
  if (graph && (view.edges?.length ?? 0) > edges.length) { omitted = true; notice("… Additional graph links omitted", "warning"); }

  rule("├", "┤");
  const elapsed = validCount(view.elapsedMs) ? duration(Math.floor(view.elapsedMs / 1000)) : "unknown";
  const observed = validCount(view.modelCalls) ? view.modelCalls : "unknown";
  notice(`ELAPSED ${elapsed} · LIMIT ${duration(view.seconds)} · OBSERVED SDK ${view.modelCallsKnown === false ? `unknown (observed ${observed})` : observed}`);
  if (view.currentTool !== undefined) field("LAST TOOL", view.currentTool, noPrefix, "accent");
  if (view.phase === "finished" || nodes.some(node => node.state === "completed" || node.state === "completed_unverified")) notice("Execution ended ≠ verification passed · human review required", "warning");
  if (view.phase === "stopped") notice("Stopped · applied changes may remain", "warning");
  if (omitted) notice("… Content omitted · inspect the complete source", "warning");
  if (graph && !summary) notice(tree ? "ACTIVE = observed dependency / disclosed information / selected reference · not verification" : "ACTIVE = selected dependency · not execution or verification proof", "dim");
  notice(tree ? "Ephemeral tree · observer only, not approval or acceptance" : graph && summary ? "Expand for full DAG · summary is not approval" : "Plan summary · not a substitute for exact-source approval", "dim");
  rule("╰", "╯", "borderAccent");
  return lines;
}

/** Exact unthemed counterpart of the native card, not a full source approval. */
export function planText(view: PlanView, width = 80): string {
  return renderPlan(view, width).join("\n");
}

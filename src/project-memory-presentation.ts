import { truncateToVisualLines, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type MemoryProgress = { readonly phase: string; readonly visits: number; readonly maximum: number; readonly selected: number;
  readonly current?: string; readonly trail?: readonly { node: string; choice: string; support: number }[] };
/** Advisory public IDs/counters only; never memory bodies, database paths or authority. */
export function memoryProgressText(value: MemoryProgress): string {
  return ["JEV / MEMORY GRAPH", `STATE ${value.phase.toUpperCase()} · DECISIONS ${value.visits}/${value.maximum} · SELECTED ${value.selected}`,
    ...(value.current ? [`CURRENT ${value.current}`] : []),
    ...(value.trail ?? []).slice(-4).map((entry, index, shown) => `${index === shown.length - 1 ? "└" : "├"} ${entry.node} → ${entry.choice} · model support ${entry.support.toFixed(3)}`),
    "Reference lookup only · no execution authority"].join("\n");
}
export function memoryResultText(value: unknown): string {
  const fallback = "JEV memory · inspect state / private data withheld";
  try {
    if (!value || typeof value !== "object") return fallback;
    const own = (key: string): string | number | undefined => {
      const data: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
      return typeof data === "string" || typeof data === "number" ? data : undefined;
    };
    const status = own("status"), stage = own("stage");
    if (own("kind") !== "project_memory" || typeof status !== "string" || !["created", "saved", "forgotten", "inspected", "snapshot", "searched", "cancelled", "needs_review", "failed", "parent_lookup"].includes(status) ||
      typeof stage !== "string" || !["input", "interface", "preparing", "configuration", "approval", "storage", "search", "disclosure", "changed", "invalid", "parent_lookup"].includes(stage)) return fallback;
    const count = (key: string) => { const data = own(key); return typeof data === "number" && Number.isSafeInteger(data) && data >= 0 && data <= 16 ? data : "unknown"; };
    const navigation = own("navigation"), outcome = typeof navigation === "string" && ["done", "limit", "uncertain"].includes(navigation) ? ` · navigation ${navigation}` : "";
    return `JEV memory · ${status} · stage ${stage}${outcome}\nJEV ${count("jevRequests")} · pending ${count("pendingRequests")} · selected ${count("selected")}\n${status === "parent_lookup" ? "Parent model selects candidates; exact approval still gates full snapshots." : "Selected reference subset only; no task execution or verification authority."}`;
  } catch { return fallback; }
}
export function memoryWidget(ctx: ExtensionContext) {
  let mounted = false, closed = false;
  return { update(value: MemoryProgress) {
    if (closed || ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;
    const text = memoryProgressText(value);
    try { ctx.ui.setWidget("jev-memory", (_screen, theme) => ({ render: width => {
      if (width <= 0) return [];
      const lines = truncateToVisualLines(theme.fg("accent", text), Number.MAX_SAFE_INTEGER, width, 0).visualLines;
      return lines.length <= 16 ? lines : [...lines.slice(0, 15), ...truncateToVisualLines(theme.fg("warning", "… Path rows omitted"), 1, width, 0).visualLines];
    }, invalidate() {} }), { placement: "aboveEditor" }); mounted = true; }
    catch { /* Display errors cannot authorize, rerun or settle a memory operation. */ }
  }, close() { closed = true; if (mounted) { try { ctx.ui.setWidget("jev-memory", undefined); } catch { /* Lifecycle disposal is advisory only. */ } } mounted = false; } };
}

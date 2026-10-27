import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canConfirmContextPacket } from "./context-approval.ts";
import { APPROVAL_UI_TRACE_VERSION } from "./approval-ui-diagnostics.ts";
import type { RuntimeIdentity } from "./runtime-identity-effects.ts";

type Visibility = "scoped_visible" | "legacy_visible" | "not_registered" | "inconclusive";
export type RuntimeHealth = { readonly feature: "ordinary-scoped/v1"; readonly catalog: Visibility;
  readonly active: "yes" | "no" | "unknown"; readonly approvalApi: "supported" | "unsupported";
  readonly mode: "tui" | "rpc" | "print" | "unknown" };
// Inspect only own data properties: metadata getters and unrelated private fields
// are not a reason to execute code or echo complete tool schemas.
type CatalogField = string | boolean | object | undefined;
function own(value: unknown, key: string): CatalogField {
  if (!value || typeof value !== "object") return undefined;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" || typeof field === "boolean" || field !== null && typeof field === "object" ? field : undefined;
}
function scopedBranch(value: unknown): boolean {
  const props = own(value, "properties"), scope = own(props, "scope"), fields = own(scope, "properties");
  return own(value, "additionalProperties") === false && own(scope, "type") === "object" && own(scope, "additionalProperties") === false &&
    ["task", "agents", "files", "tasks", "selection", "limits"].every(key => own(fields, key) !== undefined);
}
/** Definition visibility only: not a permission, semantic schema certificate,
 * renderer/GUI acceptance, installed-model check, or execution grant. */
export function inspectDelegateCatalog(tools: unknown): Visibility {
  try {
    if (!Array.isArray(tools) || tools.length > 512) return "inconclusive";
    const matches = tools.filter(tool => own(tool, "name") === "jev_delegate");
    if (matches.length === 0) return "not_registered";
    if (matches.length !== 1) return "inconclusive";
    const schema = own(matches[0], "parameters");
    if (!schema || typeof schema !== "object") return "inconclusive";
    const branches = own(schema, "anyOf");
    if (Array.isArray(branches) && branches.length > 0 && branches.length <= 8 && branches.some(scopedBranch)) return "scoped_visible";
    const properties = own(schema, "properties");
    return own(properties, "task") !== undefined && own(properties, "agents") !== undefined ? "legacy_visible" : "inconclusive";
  } catch { return "inconclusive"; }
}
/** Read the current host's public catalog only. No discovery, profile/model load,
 * native confirmation, environment access, settings/prefs, or session persistence. */
export function readRuntimeHealth(pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
  ctx: Pick<ExtensionContext, "mode" | "hasUI" | "ui">): RuntimeHealth {
  let catalog: Visibility = "inconclusive", active: RuntimeHealth["active"] = "unknown";
  try { catalog = inspectDelegateCatalog(pi.getAllTools()); } catch { /* No raw host errors. */ }
  try {
    const names = pi.getActiveTools();
    if (Array.isArray(names) && names.length <= 512 && names.every(name => typeof name === "string")) active = names.includes("jev_delegate") ? "yes" : "no";
  } catch { /* Missing/throwing host APIs are unknown, not implicit readiness. */ }
  let approvalApi: RuntimeHealth["approvalApi"] = "unsupported", mode: RuntimeHealth["mode"] = "unknown";
  try {
    approvalApi = canConfirmContextPacket(ctx) ? "supported" : "unsupported";
    const observed = ctx.mode;
    mode = observed === undefined ? "tui" : observed === "tui" || observed === "rpc" || observed === "print" ? observed : "unknown";
  } catch { approvalApi = "unsupported"; mode = "unknown"; /* No raw errors or fallback. */ }
  return { feature: "ordinary-scoped/v1", catalog, active, approvalApi, mode };
}
export function runtimeIdentityRows(identity?: RuntimeIdentity): string[] {
  if (!identity) return [];
  // JSON escapes C0 controls, but file names can also contain C1 and bidi controls.
  const root = identity.packageRoot === null ? "unconfirmed" : JSON.stringify(identity.packageRoot).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return ["", "📦 Diagnostic code", `  Package version (metadata) · ${identity.packageVersion ?? "unconfirmed"}`,
    "  Package path ·", `  ${root}`,
    "  Identifies this diagnostic, not the active tool owner",
    "  Metadata does not verify loaded code or freshness",
    "  Check pi list; changing cwd does not reload a package"];
}
export function runtimeHealthText(health: RuntimeHealth, identity?: RuntimeIdentity): string {
  const catalog = { scoped_visible: "✅ New scope input visible in the current catalog", legacy_visible: "⚠️ Only legacy single delegation visible / check reload",
    not_registered: "⛔ jev_delegate is not registered", inconclusive: "❔ Inconclusive / not assumed successful" }[health.catalog];
  const active = { yes: "✅ jev_delegate active", no: "⏸️ jev_delegate inactive", unknown: "❔ Active tools unconfirmed" }[health.active];
  return [
    "✨ JEV Runtime",
    `Read-only diagnostic · ${health.feature}`,
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "🧩 Tool status",
    `  ${catalog}`,
    `  ${active}`,
    "",
    "🖥️ Host",
    `  Mode · ${health.mode === "unknown" ? "unconfirmed (unknown)" : health.mode}`,
    `  Approval UI API · ${health.approvalApi === "supported" ? "supported interface available" : "support unconfirmed"}`,
    "  ⚠️ Physical display/acceptance unverified",
    `  Approval instrumentation · ${APPROVAL_UI_TRACE_VERSION}`,
    ...runtimeIdentityRows(identity),
    "",
    "🔎 Diagnostic scope",
    "  Registration metadata / active tools / UI API shape",
    "  No execution: models / workers / JEV / installation",
    "  No request/change: approval / settings / permission restoration",
    "",
    "🔐 Separate validation required",
    "  Physical GUI/user approval / renderer parity",
    "  Model inference / complete supported acceptance",
    "  Reviewed · genuine exact-source approval required",
    "  Full Access · explicit live-session acknowledgement",
    "  Mode not inspected; check /jev-subagents access",
    "  Diagnostic metadata grants neither mode",
  ].join("\n");
}

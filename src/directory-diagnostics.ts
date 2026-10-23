// Directory observations only: never paths, raw errors, identities, credentials or authority.
export const DIRECTORY_REASONS = ["invalid_path", "missing", "not_directory", "actor_unavailable", "elevated_actor",
  "owner_mismatch", "missing_dacl", "unsupported_acl", "unsafe_write_acl", "unsafe_private_acl", "reparse_path",
  "unsupported_storage", "access_denied", "sharing_violation", "identity_changed", "system_root_missing",
  "helper_unavailable", "helper_setup", "helper_timeout", "helper_protocol", "ownership_refused", "cancelled", "unknown"] as const;
export type DirectoryReason = typeof DIRECTORY_REASONS[number];
export type DirectoryTarget = "workspace" | "agent_directory";
export type DirectoryIssue = { readonly target: DirectoryTarget; readonly reason: DirectoryReason; readonly cleanupConfirmed: boolean };
type DirectoryField = string | boolean | object | undefined;
function own(value: unknown, key: string): DirectoryField {
  if (!value || typeof value !== "object") return undefined;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" || typeof field === "boolean" || field !== null && typeof field === "object" ? field : undefined;
}
export function directoryReason(value: unknown): DirectoryReason | undefined {
  return typeof value === "string" && DIRECTORY_REASONS.some(reason => reason === value) ? value as DirectoryReason : undefined;
}
export function directorySystemReason(error: unknown): DirectoryReason {
  try {
    const code = own(error, "code");
    if (code === "ENOENT") return "missing";
    if (code === "ENOTDIR") return "not_directory";
    if (code === "EACCES" || code === "EPERM") return "access_denied";
    if (code === "ELOOP") return "reparse_path";
    if (code === "EBUSY") return "sharing_violation";
  } catch { /* A diagnostic getter/trap is not OS evidence. */ }
  return "unknown";
}
/** Native/effect producer marker. Keep the existing caller's public message, never Error.cause. */
export class DirectoryValidationError extends Error {
  readonly reason: DirectoryReason;
  readonly cleanupConfirmed: boolean;
  constructor(message: string, reason: DirectoryReason, cleanupConfirmed = true) {
    super(message); this.reason = reason; this.cleanupConfirmed = cleanupConfirmed;
  }
}
export function directoryError(error: unknown): { readonly reason: DirectoryReason; readonly cleanupConfirmed: boolean } | undefined {
  try {
    if (!(error instanceof DirectoryValidationError)) return undefined;
    const reason = directoryReason(own(error, "reason")), clean = own(error, "cleanupConfirmed");
    return reason && typeof clean === "boolean" ? { reason, cleanupConfirmed: clean } : undefined;
  } catch { return undefined; }
}
/** Safe projection for live errors and serialized tool rows; hostile getters/prototypes are not evidence. */
export function directoryIssues(value: unknown): readonly DirectoryIssue[] | undefined {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2) return undefined;
    const result: DirectoryIssue[] = [], targets = new Set<DirectoryTarget>();
    for (let i = 0; i < value.length; i++) {
      const row = own(value, String(i)), target = own(row, "target"), reason = directoryReason(own(row, "reason")), clean = own(row, "cleanupConfirmed");
      if ((target !== "workspace" && target !== "agent_directory") || !reason || typeof clean !== "boolean" || targets.has(target)) return undefined;
      targets.add(target); result.push({ target, reason, cleanupConfirmed: clean });
    }
    return result;
  } catch { return undefined; }
}
export class DirectoryPreparationError extends Error {
  readonly issues: readonly DirectoryIssue[];
  constructor(message: string, issues: readonly DirectoryIssue[]) {
    super(message); this.issues = directoryIssues(issues) ?? [{ target: "workspace", reason: "unknown", cleanupConfirmed: false }];
  }
}
export function directoryPreparationIssues(error: unknown): readonly DirectoryIssue[] | undefined {
  try { return error instanceof DirectoryPreparationError ? directoryIssues(own(error, "issues")) : undefined; } catch { return undefined; }
}
const explanations: Record<DirectoryReason, readonly [string, string]> = {
  invalid_path: ["Invalid absolute local path or disallowed location", "Explicitly check the current workspace/configuration path. No automatic path substitution."],
  missing: ["Directory or parent path is missing", "Check that the selected existing directory exists. Nothing is created automatically."],
  not_directory: ["Target is not a directory", "Explicitly select an existing directory, not a file."],
  actor_unavailable: ["Current user identity/security information unavailable", "Check the user session and OS security APIs. No identity is inferred."],
  elevated_actor: ["Administrator/elevated context is not permitted", "Request a new approved operation from a normal-user Pi session. No administrator bypass."],
  owner_mismatch: ["Directory owner differs from the current user", "Review ownership. Changes require separate approval and are never automatic."],
  missing_dacl: ["DACL missing or unconfirmed", "Review the DACL. A NULL DACL is not treated as a safe empty list."],
  unsupported_acl: ["ACL rules cannot be validated", "Review the ACL format. Unknown rules are not ignored."],
  unsafe_write_acl: ["Untrusted users/groups may write or change permissions", "Review shared write/modify ACL entries. Permission changes require separate approval."],
  unsafe_private_acl: ["Private directory permits untrusted access", "Review access to the private directory. Permissions are never restored automatically."],
  reparse_path: ["Links/reparse paths are not permitted", "Check for junctions/symlinks. No bypass by following links."],
  unsupported_storage: ["Unsupported filesystem/drive", "On Windows use an existing local fixed NTFS location. No UNC/removable-storage bypass."],
  access_denied: ["OS denied path/handle access", "Review read/validation access to the existing directory. ACLs are not changed automatically."],
  sharing_violation: ["Sharing/handle conflict with another process", "Check processes using the path. No forced termination or automatic retry."],
  identity_changed: ["Path/file identity changed during validation", "Check operations changing the target. Old validation is not cached and authority is not restored."],
  system_root_missing: ["Windows system location is unavailable", "Check SystemRoot and the existing PowerShell location. No automatic PATH/environment changes."],
  helper_unavailable: ["Existing native validation helper could not start", "Check the PowerShell executable and OS process policy. No install or alternate-runner fallback."],
  helper_setup: ["Native validation code/security API setup failed", "Check PowerShell Add-Type/.NET/OS security policy. Raw compiler errors stay private."],
  helper_timeout: ["Native validation response deadline exceeded", "Check OS/helper health. No deadline increase or automatic retry."],
  helper_protocol: ["Native response format/order unconfirmed", "Check helper/extension versions and environment. Corrupt responses never imply success."],
  ownership_refused: ["Validation process Job ownership refused", "Check Windows Job/process policy. Unowned validation cannot proceed."],
  cancelled: ["Validation cancelled", "Cancelled requests are not revived. Make a separate new request if needed."],
  unknown: ["No exact cause code recorded", "Use /jev-subagents doctor for current read-only directory checks. Historical errors are not inferred."],
};
export function directoryIssueRows(value: unknown): readonly string[] {
  const issues = directoryIssues(value); if (!issues) return [];
  return issues.flatMap(issue => {
    const [reason, remedy] = explanations[issue.reason], target = issue.target === "workspace" ? "workspace" : "Pi configuration directory";
    return [`Target · ${target} · cause ${issue.reason} · ${reason}`, `Action · ${remedy}`,
      ...(!issue.cleanupConfirmed ? ["Native validation ownership/cleanup unknown / new execution blocked / no automatic restoration"] : [])];
  });
}

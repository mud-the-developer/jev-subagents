// Fixed categories only. No raw errors, paths, prompts, credentials or grants.
import { directoryIssues, type DirectoryIssue } from "./directory-diagnostics.ts";
import type { JevRequestFailure } from "./jev-request-diagnostics.ts";
export const ORDINARY_PREPARATION_STAGES = ["input", "directories", "file_scope", "model_profile", "instructions",
  "routing_configuration", "prepared_scope", "freshness"] as const;
export type OrdinaryPreparationStage = typeof ORDINARY_PREPARATION_STAGES[number];
export type OrdinaryFailurePhase = "interface" | "preparing" | "awaiting_approval" | "selecting" | "routing_models" | "routing_thinking" | "checking" | "running" | "cleanup";
export type OrdinaryDiagnostic = { readonly phase: OrdinaryFailurePhase; readonly preparationStage?: OrdinaryPreparationStage; readonly directoryIssues?: readonly DirectoryIssue[]; readonly routingFailure?: JevRequestFailure };

/** Effect-side error marker. Never attach the private cause or interpolate input. */
export class OrdinaryPreparationError extends Error {
  readonly stage: OrdinaryPreparationStage;
  readonly directoryIssues?: readonly DirectoryIssue[];
  constructor(stage: OrdinaryPreparationStage, issues?: readonly DirectoryIssue[]) {
    super("Scoped preparation stopped. Review the declared input; no automatic retry or fallback.");
    this.name = "OrdinaryPreparationError";
    this.stage = stage;
    const safe = directoryIssues(issues); if (safe) this.directoryIssues = safe;
  }
}
export function ordinaryDirectoryIssues(error: unknown): readonly DirectoryIssue[] | undefined {
  try { return error instanceof OrdinaryPreparationError ? directoryIssues(Object.getOwnPropertyDescriptor(error, "directoryIssues")?.value) : undefined; }
  catch { return undefined; }
}
export function ordinaryPreparationStage(error: unknown): OrdinaryPreparationStage | undefined {
  try {
    if (!(error instanceof OrdinaryPreparationError)) return undefined;
    const stage: unknown = Object.getOwnPropertyDescriptor(error, "stage")?.value;
    return typeof stage === "string" && ORDINARY_PREPARATION_STAGES.some(value => value === stage) ? stage as OrdinaryPreparationStage : undefined;
  } catch { return undefined; }
}

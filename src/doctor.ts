import { Type } from "typebox";
import { Value } from "typebox/value";
import { BasicRunInputSchema, basicRunScope, basicRunSummary } from "./basic-execution.ts";
import type { OrdinaryScopeInput } from "./ordinary-authorization.ts";
import type { OrdinaryPublicResult } from "./ordinary-effects.ts";
import type { SetupReport } from "../scripts/setup.ts";
import type { RuntimeHealth } from "./runtime-health.ts";
import { workerRoundsText } from "./worker-rounds.ts";
import { directoryIssueRows, type DirectoryIssue } from "./directory-diagnostics.ts";

const DoctorRunInputSchema = Type.Object({
  agent: BasicRunInputSchema.properties.agent,
  file: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false });
export const DOCTOR_HELP = [
  "JEV Doctor · execution diagnostics",
  "/jev-subagents doctor last — last recorded failure/SDK count in this session (no new execution)",
  "/jev-subagents doctor — environment, current tools, workspace permissions and standalone Bun worker SDK import (no live model call)",
  '/jev-subagents doctor run {"agent":"scout","file":"sample.txt"} — real worker read test after fresh exact-source approval',
  "Execution test: one existing non-sensitive file/read only / one explicit fixed profile / one worker / at most two SDK rounds / 60 seconds",
  "Check success and actual execution success are separate. No installation, edits, permission restoration, JEV selection, automatic retry or fallback.",
  "Live-model cost/authentication may remain unknown. A diagnostic click or environment check creates no execution authority.",
].join("\n");
/** Closed syntax only; the shared native harness still prepares and approves the exact current scope. */
export function parseDoctorRun(text: string): OrdinaryScopeInput | undefined {
  if (!text || text.length > 4096) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (!Value.Check(DoctorRunInputSchema, value)) return undefined;
    return basicRunScope({ agent: value.agent, task: "Read file-1 using scope_read exactly once and report a brief non-sensitive execution observation. Do not edit, install, use shell, retry or request additional tools. Do not quote secrets.",
      files: [{ path: value.file, access: "read" }], maxModelCalls: 2, seconds: 60 });
  } catch { return undefined; }
}
export type DoctorEnvironment = {
  readonly runtime: RuntimeHealth;
  readonly workspace: "passed" | "refused_or_unconfirmed";
  readonly agentDirectory?: "passed" | "refused_or_unconfirmed";
  readonly directoryIssues?: readonly DirectoryIssue[];
  readonly setup?: SetupReport;
  readonly cancelled: boolean;
  readonly blocked: "closed" | "uncertain" | undefined;
  readonly lastFailure?: string;
};
/** Readiness is intentionally not a grant or a physical-UI/model/provider completion certificate. */
export function doctorEnvironmentText(result: DoctorEnvironment): string {
  const setup = result.setup;
  return ["JEV Doctor · environment check / not execution approval",
    ...(result.lastFailure ? ["Last recorded stop in this session:", result.lastFailure] : ["No recorded failure receipt (historical transcripts are not collected automatically)"]),
    `Current scope tool · ${result.runtime.catalog === "scoped_visible" && result.runtime.active === "yes" ? "confirmed" : "unconfirmed/inactive"}`,
    `Exact-source approval UI · ${result.runtime.approvalApi === "supported" ? "interface shape confirmed (physical display unverified)" : "support unconfirmed"}`,
    `Workspace permissions · ${result.workspace === "passed" ? "existing execution guard passed" : "refused/unknown / no bypass"}`,
    ...(result.agentDirectory ? [`Pi configuration permissions · ${result.agentDirectory === "passed" ? "existing execution guard passed" : "refused/unknown / no bypass"}`] : []),
    ...directoryIssueRows(result.directoryIssues),
    setup ? `Host Pi · ${setup.piVersion} · Bun ${setup.bun} · pinned worker SDK ${setup.testedVersion}` : "Environment/CLI check incomplete",
    `Standalone Bun worker SDK import · ${!setup ? "not reported (environment/CLI check incomplete)" : setup.workerVersion ? setup.workerVersion === setup.testedVersion ? "passed" : "pinned version mismatch" : "failed/unconfirmed"}`,
    ...(setup?.profiles.map(profile => `Profile ${profile.name} · ${profile.status === "valid" ? "explicit configuration shape confirmed (model/authentication unverified)" : profile.status === "missing" ? "missing" : "format/permissions unknown"}`) ?? []),
    ...(result.blocked ? [result.blocked === "uncertain" ? "Execution ownership/accounting unknown / records retained / new execution blocked" : "Execution owner closed / no automatic recovery"] : []),
    ...(result.cancelled ? ["Diagnostic cancelled / no automatic rerun"] : []),
    "Real worker/model/file read test: not requested",
    '/jev-subagents doctor run {"agent":"scout","file":"sample.txt"} — requires fresh exact-source approval',
    "Live provider, price, file contents and physical TUI success require separate checks. No installation/configuration/file/permission changes.",
  ].join("\n");
}
export function doctorRunText(result: OrdinaryPublicResult): string {
  return ["JEV Doctor · real worker read test",
    result.status === "completed_unverified" && result.workersStarted === 1 && result.cleanupConfirmed && !result.lockRetained
      ? "Execution path completed / response and task acceptance need human review" : "Execution path incomplete / no automatic retry or fallback",
    basicRunSummary(result),
    ...(result.workerRounds ? [workerRoundsText(result.workerRounds, result.workerRoundsCoverage)] : []),
    "File is read-only / /jev-subagents result explicitly opens the original response",
  ].join("\n");
}

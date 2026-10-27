const causes: Readonly<Record<string, string | undefined>> = {
  authentication: "Check authentication", rate_limited: "Check request limits", model_unavailable: "Check model availability",
  unsupported_setting: "Check model settings", request_rejected: "Check request settings", provider_error: "Provider error",
  transport: "Connection error", response_incomplete: "Incomplete model response", cancelled: "Request cancelled", unknown: "Unknown cause",
};
const stages: Readonly<Record<string, string | undefined>> = { input: "Approved input", model_loading: "Fixed-model loading",
  session_setup: "SDK setup", extension_loading: "Extension loading", model_request: "Model request", model_response: "Model response/stop format",
  internal_report: "Internal English report boundary", accounting: "Usage accounting", cleanup: "Worker cleanup" };
type DiagnosticField = string | number | undefined;
function own(value: unknown, key: string): DiagnosticField {
  try {
    const field: unknown = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
    return typeof field === "string" || typeof field === "number" ? field : undefined;
  } catch { return undefined; }
}
/** Fixed human labels only. No getters, raw errors, claims or execution authority. */
export function workerDiagnosticView(value: unknown): { readonly cause: string | undefined; readonly stage: string | undefined; readonly httpStatus: number | undefined } {
  const category = own(value, "category"), stage = own(value, "stage"), status = own(value, "httpStatus");
  return {
    cause: typeof category === "string" && Object.hasOwn(causes, category) ? causes[category] : undefined,
    stage: typeof stage === "string" && Object.hasOwn(stages, stage) ? stages[stage] : undefined,
    httpStatus: typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined,
  };
}

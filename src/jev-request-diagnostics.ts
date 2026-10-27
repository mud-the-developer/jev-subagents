// Finite observations only: never preserve provider bodies, transport exceptions or credentials.
export const JEV_REQUEST_FAILURES = ["http", "timeout", "transport", "invalid_response", "response_limit", "configuration"] as const;
export const JEV_CHOICE_FAILURES = ["choice_fields", "distribution_fields", "distribution_total", "choice_not_maximum"] as const;
export type JevRequestFailure = { readonly category: typeof JEV_REQUEST_FAILURES[number]; readonly httpStatus?: number;
  readonly choiceFailure?: typeof JEV_CHOICE_FAILURES[number]; readonly probabilityTotal?: number;
  readonly probabilityTolerance?: number; readonly candidateCount?: number };
export function jevChoiceFailure(error: unknown): JevRequestFailure {
  const messages = { "Invalid JEV choice.": "choice_fields", "Invalid JEV probability distribution.": "distribution_fields",
    "Invalid JEV probability total.": "distribution_total", "JEV choice is not a maximum.": "choice_not_maximum" } as const;
  try {
    const message = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
    if (typeof message === "string" && Object.hasOwn(messages, message)) return jevRequestFailure({ category: "invalid_response", choiceFailure: messages[message as keyof typeof messages],
      probabilityTotal: Object.getOwnPropertyDescriptor(error, "probabilityTotal")?.value,
      probabilityTolerance: Object.getOwnPropertyDescriptor(error, "probabilityTolerance")?.value,
      candidateCount: Object.getOwnPropertyDescriptor(error, "candidateCount")?.value,
    }) ?? { category: "invalid_response" };
  } catch { /* Unknown exceptions stay private. */ }
  return { category: "invalid_response" };
}
export function jevRequestFailure(value: unknown): JevRequestFailure | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const category = Object.getOwnPropertyDescriptor(value, "category")?.value;
    if (!JEV_REQUEST_FAILURES.some(item => item === category)) return undefined;
    if (category === "invalid_response") {
      const choiceFailure = Object.getOwnPropertyDescriptor(value, "choiceFailure")?.value;
      const probabilityTotal = Object.getOwnPropertyDescriptor(value, "probabilityTotal")?.value;
      const probabilityTolerance = Object.getOwnPropertyDescriptor(value, "probabilityTolerance")?.value;
      const candidateCount = Object.getOwnPropertyDescriptor(value, "candidateCount")?.value;
      const boundedTotal = choiceFailure === "distribution_total" && typeof candidateCount === "number" && Number.isSafeInteger(candidateCount) && candidateCount >= 2 && candidateCount <= 128 &&
        typeof probabilityTotal === "number" && Number.isFinite(probabilityTotal) && probabilityTotal >= 0 && probabilityTotal <= candidateCount &&
        typeof probabilityTolerance === "number" && Number.isFinite(probabilityTolerance) && probabilityTolerance > 0 && probabilityTolerance <= 1;
      return { category, ...(JEV_CHOICE_FAILURES.some(item => item === choiceFailure) ? { choiceFailure } : {}),
        ...(boundedTotal ? { probabilityTotal, probabilityTolerance, candidateCount } : {}) };
    }
    if (category !== "http") return { category };
    const httpStatus = Object.getOwnPropertyDescriptor(value, "httpStatus")?.value;
    return Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { category, httpStatus } : undefined;
  } catch { return undefined; }
}
export function jevRequestFailureLabel(value: unknown): string | undefined {
  const failure = jevRequestFailure(value); if (!failure) return undefined;
  if (failure.category === "http") return `JEV HTTP ${failure.httpStatus}`;
  const labels = { timeout: "JEV request timeout", transport: "JEV transport failure", invalid_response: "JEV response invalid or incomplete",
    response_limit: "JEV response exceeded its retained byte bound", configuration: "JEV connection changed or unavailable" };
  return labels[failure.category] + (failure.category === "invalid_response" && failure.choiceFailure ? ` · choice validation: ${failure.choiceFailure}` : "") +
    (failure.probabilityTotal === undefined ? "" : ` · probability total ${failure.probabilityTotal} · tolerance ${failure.probabilityTolerance} · candidates ${failure.candidateCount}`);
}

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const profiles = ["scout", "worker", "worker_strong"] as const;
export type Profile = typeof profiles[number];
type Case = { readonly id: string; readonly task: string; readonly expected: readonly Profile[] };

// Synthetic seed labels, not measured model quality or an independent held-out benchmark.
export const cases: readonly Case[] = [
  { id: "find-auth", task: "Find the authentication entry point and report its path. Do not modify files.", expected: ["scout"] },
  { id: "explain-cache", task: "Explain the cache invalidation flow with source references. No edits.", expected: ["scout"] },
  { id: "trace-config", task: "Trace how configuration reaches the HTTP client. Return findings only.", expected: ["scout"] },
  { id: "investigate-flake", task: "Investigate the flaky test and suggest a fix without changing anything.", expected: ["scout"] },
  { id: "review-security", task: "Review the authorization checks for security issues. Findings only; no changes.", expected: ["scout", "worker_strong"] },
  { id: "korean-discovery", task: "로그인 처리를 시작하는 파일을 찾아 경로만 알려줘. 수정하지 마.", expected: ["scout"] },
  { id: "summarize-module", task: "Summarize the responsibilities and callers of the billing module. Do not edit.", expected: ["scout"] },
  { id: "read-migrations", task: "Explain the existing database migration ordering. Read-only investigation.", expected: ["scout"] },
  { id: "typo", task: "Fix one spelling mistake in README.md.", expected: ["worker"] },
  { id: "null-guard", task: "Add a missing null guard in formatTitle and a focused regression test.", expected: ["worker"] },
  { id: "rename-local", task: "Rename the local variable tmp to title in one function; keep behavior unchanged.", expected: ["worker"] },
  { id: "test-boundary", task: "Add a unit test for an empty list in the existing sum function.", expected: ["worker"] },
  { id: "button-label", task: "Change the submit button label to Save and update its existing test.", expected: ["worker"] },
  { id: "korean-local-fix", task: "날짜 포맷 함수의 한 자리 월에 0을 붙이는 버그를 수정하고 테스트를 추가해.", expected: ["worker"] },
  { id: "mention-read-only", task: "Fix the misleading 'read-only' label in the settings UI. This is a one-string edit.", expected: ["worker"] },
  { id: "security-docs", task: "Correct a typo in the security documentation. Do not change any code.", expected: ["worker"] },
  { id: "race-fix", task: "Fix a concurrency race between cancellation and committing a multi-file operation, preserving atomicity.", expected: ["worker_strong"] },
  { id: "tenant-isolation", task: "Implement security isolation across a multi-tenant permission cache and its request handlers.", expected: ["worker_strong"] },
  { id: "schema-migration", task: "Implement a backwards-compatible database migration spanning three dependent modules, including recovery behavior.", expected: ["worker_strong"] },
  { id: "korean-architecture", task: "여러 모듈의 이벤트 처리 아키텍처를 변경하고 동시성 오류를 수정해. 기존 호환성은 유지해.", expected: ["worker_strong"] },
];

const PredictionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  agent: Type.Union([Type.String({ enum: [...profiles] }), Type.Null()]),
}, { additionalProperties: false });
const PredictionsSchema = Type.Array(PredictionSchema, { maxItems: cases.length });
export type Prediction = Static<typeof PredictionSchema>;

export function parseReplay(text: string): Prediction[] {
  try {
    const records: unknown = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (Value.Check(PredictionsSchema, records)) return records;
  } catch { /* Do not expose JSON parser excerpts from an external file. */ }
  throw new Error("Invalid replay JSONL.");
}

export function ruleBaseline(task: string): Profile {
  // ponytail: keyword-only comparison, not production policy; use held-out real tasks before tuning a router.
  if (/\b(find|locate|explain|inspect|investigate|trace|summarize|review)\b|찾아|설명|조사|읽기 전용/i.test(task)) return "scout";
  if (/\b(concurrency|race|security|migration|architecture|multi-tenant)\b|동시성|보안|마이그레이션|아키텍처/i.test(task)) return "worker_strong";
  return "worker";
}

export function evaluate(input: unknown) {
  if (!Value.Check(PredictionsSchema, input)) throw new Error("Invalid evaluation records.");
  const predictions = new Map<string, Prediction["agent"]>();
  for (const prediction of input) {
    if (predictions.has(prediction.id) || !cases.some((item) => item.id === prediction.id)) {
      throw new Error("Unknown or duplicate evaluation case ID.");
    }
    predictions.set(prediction.id, prediction.agent);
  }
  const results = cases.map((item) => ({
    id: item.id, expected: item.expected, actual: predictions.get(item.id) ?? null,
    correct: item.expected.some((agent) => agent === predictions.get(item.id)),
    missing: !predictions.has(item.id),
  }));
  const correct = results.filter((result) => result.correct).length;
  return { cases: cases.length, supplied: predictions.size, correct, accuracy: correct / cases.length,
    missing: results.filter((result) => result.missing).length,
    failed: input.filter((prediction) => prediction.agent === null).length,
    mismatches: results.filter((result) => !result.correct) };
}

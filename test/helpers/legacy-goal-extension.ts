// Historical adapters for isolated Goal regression tests only. Never loaded by the public JEV extension.
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GoalRunInputSchema, GOAL_RUN_ERROR, type GoalRunState } from "../../src/goal-run.ts";
import { goalRun } from "../../src/goal-run-effects.ts";
import { SequenceInputSchema, type SequenceState, type SequenceResult, type sequenceProgress } from "../../src/goal-sequence.ts";
import { goalSequence } from "../../src/goal-sequence-effects.ts";
import { withJevSession } from "../../src/jev-config.ts";

function sequenceResultText(result: SequenceResult): string {
  return [
    `Goal: ${result.status} · 검증 ${result.verification} · 최종 수락은 사람 검토 필요`,
    ...result.history.map((item, index) => `단계 ${index + 1}: ${JSON.stringify(item.plan ?? null)} · worker SDK ${item.modelCalls}${item.repair ? ` + 동일 설정 수정 ${item.repair.modelCalls}` : ""}`),
    `정산 JEV 요청 ${result.ledger?.spent.jevCalls ?? 0} · 보류 ${result.ledger?.held.jevCalls ?? 0} · 추정 총액 ${result.ledger?.totalUsd == null ? "미확정" : `$${result.ledger.totalUsd}`} (parent pi 제외, 청구액 아님)`,
    result.reason, JSON.stringify(result),
  ].join("\n");
}
function updateSequenceProgress(onUpdate: Parameters<ToolDefinition["execute"]>[3], status: string, progress: ReturnType<typeof sequenceProgress>) {
  if (!progress) return;
  const used = progress.settled, held = progress.reserved;
  return onUpdate?.({ content: [{ type: "text", text: [
    `JEV · ${status}`,
    ...(progress.plan ? [`실행 설정: ${JSON.stringify(progress.plan)}`] : []),
    `정산: worker ${used?.workerRuns ?? 0}/${progress.workerLimit}회 · planner SDK ${used?.plannerCalls ?? 0} · worker SDK ${used?.workerCalls ?? 0} · JEV 요청 ${used?.jevCalls ?? 0}`,
    `공통 호출 한도 ${progress.totalCallLimit} · 보류 호출 ${(held?.plannerCalls ?? 0) + (held?.workerCalls ?? 0) + (held?.jevCalls ?? 0)} · 관측 추정액 $${progress.observedUsd} · 총액 ${progress.totalUsd === null ? "미확정" : `$${progress.totalUsd}`}`,
    "정산 전 호출은 보류에 포함됩니다. JEV 요청은 fetch 시도 수이며 HTTP 수신·청구 보장이 아닙니다. 추정액은 parent pi 사용량을 제외합니다.",
  ].join("\n") }], details: { phase: status, progress } });
}
export default function legacyGoalFixture(pi: ExtensionAPI) {
  const active = new Map<AbortController, Promise<void>>();
  let closed = false;
  const stop = async () => {
    for (const controller of active.keys()) controller.abort();
    await Promise.allSettled([...active.values()]);
  };
  pi.on("session_before_switch", stop); pi.on("session_before_fork", stop);
  pi.on("session_before_tree", stop); pi.on("session_before_compact", stop);
  pi.on("session_shutdown", async () => { closed = true; await stop(); });
  const execute = async (signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<GoalRunState | SequenceState>) => {
    if (closed) throw new Error("Native execution owner is closed; no authority restoration.");
    const controller = new AbortController(); let done = () => {};
    active.set(controller, new Promise<void>(resolve => { done = resolve; }));
    try {
      const state = await run(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
      if (state.status !== "done") throw new Error(GOAL_RUN_ERROR);
      const result = state.result;
      if (result.status !== "completed_unverified" && result.status !== "completed_checked") throw new Error(`${GOAL_RUN_ERROR}\n${JSON.stringify(result)}`);
      return { content: [{ type: "text" as const, text: "history" in result ? sequenceResultText(result) : JSON.stringify(result) }], details: result };
    } finally { active.delete(controller); done(); }
  };
  pi.registerTool({ name: "jev_goal", label: "Legacy test Goal", description: "Private historical test adapter, not a public extension tool.",
    executionMode: "sequential", parameters: GoalRunInputSchema,
    async execute(_id, params, signal, _onUpdate, ctx) { return execute(signal, current => goalRun(params, ctx, current)); } });
  pi.registerTool({ name: "jev_goal_sequence", label: "Legacy test sequence", description: "Private historical test adapter, not a public extension tool.",
    executionMode: "sequential", parameters: SequenceInputSchema,
    async execute(_id, params, signal, onUpdate, ctx) {
      return withJevSession(ctx, () => execute(signal, current => goalSequence(params, ctx, current, (status, progress) => updateSequenceProgress(onUpdate, status, progress))));
    } });
}

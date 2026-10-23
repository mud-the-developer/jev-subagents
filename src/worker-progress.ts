import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const tools = ["read", "edit", "write", "bash", "grep", "find", "ls", "scope_read", "scope_edit", "scope_write", "goal_read", "goal_edit", "goal_write", "other"] as const;
export const WorkerProgressSchema = Type.Object({
  type: Type.Literal("jev_worker_progress"), version: Type.Literal(1),
  sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  phase: Type.Union([Type.Literal("model_request"), Type.Literal("tool_start"), Type.Literal("tool_end"), Type.Literal("turn_end")]),
  elapsedMs: count, modelCalls: count, toolCalls: count,
  currentTool: Type.Optional(Type.String({ enum: [...tools] })),
}, { additionalProperties: false });
export type WorkerProgress = Static<typeof WorkerProgressSchema>;
export type WorkerProgressObserver = (progress: WorkerProgress) => void;

/** Whitelisted advisory metadata only; never a model result, usage receipt or execution authority. */
export function progressEmitter(observer?: WorkerProgressObserver) {
  const started = performance.now();
  let sequence = 0, previous = -Infinity;
  return (phase: WorkerProgress["phase"], modelCalls: number, toolCalls: number, tool?: string) => {
    const now = performance.now();
    if (!observer || now - previous < 250) return;
    const frame: WorkerProgress = { type: "jev_worker_progress", version: 1, sequence: ++sequence, phase,
      elapsedMs: Math.max(0, Math.floor(now - started)), modelCalls, toolCalls,
      ...(tool ? { currentTool: tools.includes(tool as typeof tools[number]) ? tool : "other" } : {}) };
    if (!Value.Check(WorkerProgressSchema, frame)) return;
    previous = now;
    try { void Promise.resolve(observer(Object.freeze(frame))).catch(() => {}); } catch { /* Display failures never change execution or cause retries. */ }
  };
}

/** Each owned child gets its own monotonic receiver; rendering is rate-limited, not execution. */
export function progressReceiver(observer?: WorkerProgressObserver) {
  let previous: WorkerProgress | undefined, delivered = -Infinity;
  return (value: unknown): "not_progress" | "invalid" | "accepted" => {
    if (!value || typeof value !== "object" || !("type" in value) || value.type !== "jev_worker_progress") return "not_progress";
    if (!Value.Check(WorkerProgressSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 1024 ||
      previous && (value.sequence <= previous.sequence || value.elapsedMs < previous.elapsedMs || value.modelCalls < previous.modelCalls || value.toolCalls < previous.toolCalls)) return "invalid";
    previous = structuredClone(value);
    const now = performance.now();
    if (now - delivered >= 250) {
      delivered = now;
      try { void Promise.resolve(observer?.(Object.freeze(structuredClone(value)))).catch(() => {}); } catch { /* Presentation is not a process/settlement signal. */ }
    }
    return "accepted";
  };
}

/** Native-only caller wires this to process.send; raw arguments, text and credentials never enter a frame. */
export const sendWorkerProgress: WorkerProgressObserver = frame => {
  if (process.connected && process.send) { try { process.send(frame, () => {}); } catch { /* Parent loss is handled by the existing disconnect owner. */ } }
};

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { humanLiteral } from "./task-review-machine.ts";
import { MemoryChoiceInputSchema, type MemoryChoiceInput, type DelegationMemoryParent, type DelegationMemoryQuestion } from "./delegation-memory.ts";
import type { OrdinaryPublicResult } from "./ordinary-effects.ts";

export type DelegationMemoryPause = DelegationMemoryQuestion & { readonly kind: "delegation_memory_choice"; readonly status: "parent_lookup";
  readonly workersStarted: 0; readonly nextAction: string };
type Pending = { readonly question: DelegationMemoryQuestion; readonly sessionId: string; readonly cwd: string; readonly signal: AbortSignal;
  readonly work: Promise<OrdinaryPublicResult>; readonly finish: (ids: readonly string[] | null) => void };
const message = "No matching live approved memory job, or memory selection changed/cancelled. No restored grant or retry.";

/** Live I/O handles only. Nothing is serialized, adopted from callers or restored from history. */
export function delegationMemoryOwner() {
  const pending = new Map<string, Pending>();
  const same = (entry: Pending, ctx: ExtensionContext) => {
    try { return !entry.signal.aborted && entry.sessionId === ctx.sessionManager.getSessionId() && entry.cwd === ctx.cwd; } catch { return false; }
  };
  return {
    async start(ctx: ExtensionContext, start: (parent: DelegationMemoryParent) => Promise<OrdinaryPublicResult>): Promise<OrdinaryPublicResult | DelegationMemoryPause> {
      let sessionId: string, cwd: string;
      try { sessionId = ctx.sessionManager.getSessionId(); cwd = ctx.cwd; if (!sessionId || !cwd) throw new Error(); }
      catch { throw new Error(message); }
      let publish!: (value: DelegationMemoryPause) => void;
      const paused = new Promise<DelegationMemoryPause>(resolve => { publish = resolve; });
      let work!: Promise<OrdinaryPublicResult>;
      const parent: DelegationMemoryParent = (question, signal) => new Promise((resolve, reject) => {
        if (signal.aborted || pending.size || ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd) { reject(new Error(message)); return; }
        const original = structuredClone(question);
        const dispose = () => { signal.removeEventListener("abort", cancelled); pending.delete(question.jobId); };
        const cancelled = () => { dispose(); reject(new Error(message)); };
        const finish = (ids: readonly string[] | null) => { dispose(); resolve(ids === null ? null : [...ids]); };
        pending.set(question.jobId, { question: original, sessionId, cwd, signal, work, finish });
        signal.addEventListener("abort", cancelled, { once: true });
        if (signal.aborted) { cancelled(); return; }
        publish({ ...structuredClone(original), kind: "delegation_memory_choice", status: "parent_lookup", workersStarted: 0,
          nextAction: "The current parent selects approved catalog IDs, then calls jev_delegate with memoryChoice {jobId,ids}. Use askUser:true only if the parent also cannot decide. This continues the same live job, not a new approval, provider or worker grant." });
      });
      work = Promise.resolve().then(() => start(parent));
      // The active execution still owns cancellation/deadline and cleanup while its caller reasons.
      void work.catch(() => {});
      return await Promise.race([work, paused]);
    },
    async choose(input: MemoryChoiceInput, ctx: ExtensionContext, signal?: AbortSignal, cancel?: () => void): Promise<OrdinaryPublicResult> {
      if (!Value.Check(MemoryChoiceInputSchema, input)) throw new Error(message);
      const owned = structuredClone(input), entry = pending.get(owned.jobId);
      if (!entry || !same(entry, ctx)) throw new Error(message);
      pending.delete(owned.jobId); // Consume the choice before an asynchronous picker can be opened twice.
      const cancelled = () => { cancel?.(); entry.finish(null); };
      signal?.addEventListener("abort", cancelled, { once: true });
      try {
      if (signal?.aborted) { cancelled(); return await entry.work; }
      let ids: readonly string[] | null;
      if ("askUser" in owned) {
        if (!ctx.hasUI || typeof ctx.ui.select !== "function") { entry.finish(null); await entry.work; throw new Error(message); }
        const rows = ["No memory record is needed", ...entry.question.catalog.records.map(record => `${humanLiteral(record.title)} [${record.id}]`)];
        let selected: string | undefined;
        try {
          selected = await Promise.race([
            ctx.ui.select("JEV memory · Parent also uncertain / choose an approved record", rows, { signal: signal ? AbortSignal.any([entry.signal, signal]) : entry.signal }),
            entry.work.then(() => undefined, () => undefined),
          ]);
        } catch { selected = undefined; }
        if (!same(entry, ctx) || signal?.aborted) { entry.finish(null); await entry.work.catch(() => {}); throw new Error(message); }
        const index = selected === undefined ? -1 : rows.indexOf(selected);
        ids = index < 0 ? null : index === 0 ? [] : [entry.question.catalog.records[index - 1]!.id];
      } else ids = owned.ids;
      if (ids !== null && (new Set(ids).size !== ids.length || ids.some(id => !entry.question.catalog.records.some(record => record.id === id)))) {
        entry.finish(null); await entry.work.catch(() => {}); throw new Error(message);
      }
      entry.finish(ids);
      return await entry.work;
      } finally { signal?.removeEventListener("abort", cancelled); }
    },
  };
}

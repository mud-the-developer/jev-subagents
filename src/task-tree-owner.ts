import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { humanLiteral } from "./task-review-machine.ts";
import { TreeContinueSchema, type TreeContinue } from "./task-tree.ts";
import type { TreeAnswer, TreeParent, TreeQuestion, TreeResult } from "./task-tree-effects.ts";

export type TreePause = TreeQuestion & { readonly status: "parent_lookup"; readonly nextAction: string };
type Pending = { readonly question: TreeQuestion; readonly signal: AbortSignal; readonly sessionId: string; readonly cwd: string;
  readonly work: Promise<TreeResult>; readonly answer: (answer: TreeAnswer) => void; readonly next: () => Promise<TreePause> };
const message = "No matching live tree question. No restored permission, replacement execution or deadline extension.";
/** Effect-only live promises. No graph state or authority is persisted or accepted from callers. */
export function taskTreeOwner() {
  const pending = new Map<string, Pending>();
  const same = (entry: Pending, ctx: ExtensionContext) => { try { return !entry.signal.aborted && ctx.sessionManager.getSessionId() === entry.sessionId && ctx.cwd === entry.cwd; } catch { return false; } };
  return {
    async start(ctx: ExtensionContext, start: (parent: TreeParent) => Promise<TreeResult>): Promise<TreeResult | TreePause> {
      let sessionId: string, cwd: string;
      try { sessionId = ctx.sessionManager.getSessionId(); cwd = ctx.cwd; if (!sessionId || !cwd) throw new Error(); } catch { throw new Error(message); }
      let publish!: (pause: TreePause) => void, work!: Promise<TreeResult>;
      const next = () => new Promise<TreePause>(resolve => { publish = resolve; });
      const paused = next();
      const parent: TreeParent = (question, signal) => new Promise((resolve, reject) => {
        if (signal.aborted || pending.size || ctx.sessionManager.getSessionId() !== sessionId || ctx.cwd !== cwd) { reject(new Error(message)); return; }
        const original = structuredClone(question);
        const dispose = () => { signal.removeEventListener("abort", cancel); pending.delete(question.jobId); };
        const cancel = () => { dispose(); reject(new Error(message)); };
        const answer = (answer: TreeAnswer) => { dispose(); resolve(answer === null ? null : structuredClone(answer)); };
        pending.set(question.jobId, { question: original, signal, sessionId, cwd, work, answer, next });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) { cancel(); return; }
        publish({ ...original, status: "parent_lookup", nextAction: question.purpose === "selection"
          ? "Current parent: choose an approved agent and reference IDs with treeContinue {jobId,questionId,selection:{agent,ids}}. Only askUser:true requests a human choice. This is the same live tree and original deadline."
          : "Current parent: supply exactly the missing declared information bodies with treeContinue {jobId,questionId,records:[{id,content,provenance}]}. Fresh native disclosure/execution review is required. No automatic report collection or new task/edge is permitted." });
      });
      work = Promise.resolve().then(() => start(parent));
      return await Promise.race([work, paused]);
    },
    async continue(input: TreeContinue, ctx: ExtensionContext, signal?: AbortSignal, cancel?: () => void): Promise<TreeResult | TreePause> {
      if (!Value.Check(TreeContinueSchema, input)) throw new Error(message);
      const owned = structuredClone(input), entry = pending.get(owned.jobId);
      if (!entry || entry.question.questionId !== owned.questionId || !same(entry, ctx)) throw new Error(message);
      pending.delete(owned.jobId);
      const paused = entry.next(), cancelled = () => { cancel?.(); entry.answer(null); };
      signal?.addEventListener("abort", cancelled, { once: true });
      try {
        if (signal?.aborted) { cancelled(); return await entry.work; }
        let answer: TreeAnswer = "selection" in owned ? { selection: owned.selection } : "records" in owned ? { records: owned.records } : null;
        if ("askUser" in owned) {
          if (entry.question.purpose !== "selection" || !ctx.hasUI || typeof ctx.ui.select !== "function") { entry.answer(null); return await entry.work; }
          const choices = entry.question.options.map(option => `${option.id} · ${humanLiteral(option.description)}`);
          const selected = await Promise.race([ctx.ui.select("JEV tree · Parent also uncertain / choose an approved tuple and reference", choices,
            { signal: signal ? AbortSignal.any([signal, entry.signal]) : entry.signal }), entry.work.then(() => undefined)]);
          const index = selected === undefined ? -1 : choices.indexOf(selected);
          answer = index < 0 ? null : { selection: entry.question.options[index]!.selection };
        }
        if (!same(entry, ctx) || signal?.aborted) { entry.answer(null); return await entry.work; }
        entry.answer(answer);
        return await Promise.race([entry.work, paused]);
      } catch { entry.answer(null); await entry.work.catch(() => {}); throw new Error(message); }
      finally { signal?.removeEventListener("abort", cancelled); }
    },
  };
}

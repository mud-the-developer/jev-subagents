import path from "node:path";
import { readdir } from "node:fs/promises";
import { snapshotGoalText } from "./goal-file-effects.ts";
import { openGoalProjectLock } from "./goal-run-effects.ts";
import { appendContextFile } from "./context-memory-effects.ts";
import { checkSolPi, materializeSolPi, solOwner, inspectSolStorage } from "./sol-pi-effects.ts";
import { SOL_ERROR, SOL_RECORD, reduceSolJob, type SolJobState, type SolJobEvent, type SolJobEffect } from "./sol-pi.ts";
import type { Event, Run } from "./delegate-machine.ts";

/** Resource ownership stays here; authority and lifecycle decisions stay in reduceSolJob. */
export async function runSolPi(run: Run, execute: (run: Run, signal?: AbortSignal) => Promise<Event>, signal?: AbortSignal): Promise<Event> {
  if (!run.solPi) return { type: "failed", error: SOL_ERROR };
  let state: SolJobState = { status: "idle", run: structuredClone(run), outcome: null, attempted: false, cancelled: signal?.aborted === true, keep: false, lastAt: run.solPi.preparedAt };
  const effects: SolJobEffect[] = [];
  let project: Awaited<ReturnType<typeof openGoalProjectLock>> | undefined, storage: typeof project;
  let projectAttempted = false, storageAttempted = false;
  let record: Awaited<ReturnType<typeof snapshotGoalText>> = null;
  const send = (event: SolJobEvent) => { const next = reduceSolJob(state, event); state = next.state; effects.push(...next.effects); };
  const cancelled = () => send({ type: "cancel" });
  signal?.addEventListener("abort", cancelled, { once: true });
  function fail(): never { throw new Error(SOL_ERROR); }
  const grant = run.solPi, filename = path.join(grant.options.storageDirectory, SOL_RECORD);
  const append = async (value: unknown) => {
    const added = await appendContextFile(filename, grant.storageIdentity, record, JSON.stringify(value) + "\n", AbortSignal.timeout(10_000));
    if (!added.ok) fail();
    record = await snapshotGoalText(filename);
    if (!record || record.text !== added.text) fail();
  };
  send({ type: "start", now: Date.now() });
  try {
    while (effects.length) {
      const effect = effects.shift()!;
      try {
        switch (effect.type) {
          case "open": {
            signal?.throwIfAborted(); await checkSolPi(run, signal);
            if ((await readdir(grant.options.storageDirectory)).length) fail();
            projectAttempted = true; project = await openGoalProjectLock(solOwner(run), signal);
            storageAttempted = true; storage = await openGoalProjectLock(solOwner(run, true), signal);
            await materializeSolPi(run);
            if (!(await inspectSolStorage(grant.options.storageDirectory)).valid) fail();
            await append({ version: 1, kind: "admitted", operationId: grant.operationId, runDigest: grant.runDigest, sourceDigest: grant.sourceDigest });
            send({ type: "opened", now: Date.now() }); break;
          }
          case "execute": send({ type: "observed", outcome: await execute(run, signal) }); break;
          case "record": {
            await append({ version: 1, kind: "observed", operationId: grant.operationId,
              outcome: state.outcome?.type ?? "unknown", report: state.outcome?.report ?? null });
            send({ type: "recorded" }); break;
          }
          case "close": {
            let ok = !(projectAttempted && !project || storageAttempted && !storage), keep = effect.keep || !ok;
            try { if (storage) keep = await storage.close(keep) || keep; } catch { ok = false; keep = true; }
            try { if (project) keep = await project.close(keep) || keep; } catch { ok = false; keep = true; }
            send({ type: "closed", ok, retained: keep && (projectAttempted || storageAttempted) }); break;
          }
        }
      } catch { send({ type: "failed" }); }
    }
    const final = state as SolJobState;
    return final.status === "done" ? final.result : { type: "failed", error: SOL_ERROR };
  } finally { signal?.removeEventListener("abort", cancelled); }
}

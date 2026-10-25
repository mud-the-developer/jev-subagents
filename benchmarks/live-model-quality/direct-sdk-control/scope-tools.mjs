// Shared safety boundary only; no JEV worker, router, approval packet or orchestration API.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
export async function createControlTools({ runtimeRoot, scope, protections, context, signal }) {
  const require = createRequire(path.join(runtimeRoot, "package.json"));
  const { Type } = await import(pathToFileURL(require.resolve("typebox")).href);
  const { Value } = await import(pathToFileURL(require.resolve("typebox/value")).href);
  const local = name => import(pathToFileURL(path.join(runtimeRoot, "src", name)).href);
  const { reduceGoalFiles } = await local("goal-files.ts");
  const { executeGoalFileEffect, checkGoalFileScope } = await local("goal-file-effects.ts");
  const { checkGoalContext } = await local("goal-run-effects.ts");
  const { withWindowsGoalReadBatch } = await local("windows-goal-files.ts");
  const ownAbort = new AbortController(), combined = AbortSignal.any([signal, ownAbort.signal]);
  let state = reduceGoalFiles({ status: "idle" }, { type: "start", scope }).state;
  // The operator authorized this closed direct-control scope. This private file-state
  // transition is not a JEV execution grant, approval receipt, lease or restored authority.
  state = reduceGoalFiles(state, { type: "approval", scopeId: scope.id, approved: true }).state;
  assert.equal(state.status, "ready");
  let sequence = 0, pending;
  const stopped = () => new Error("Direct control file operation stopped.");
  async function fresh() {
    combined.throwIfAborted();
    assert.equal(state.status, "ready");
    // A version-only shared check: the object carries no execution/approval authority.
    await checkGoalContext({ body: { context } }, combined);
    await checkGoalFileScope(state.scope, protections, combined);
    combined.throwIfAborted();
  }
  const tools = ["read", "edit", "write"].map(action => {
    const fields = { fileId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" }) }, text = Type.String({ maxLength: 32768 });
    const parameters = Type.Object(action === "read" ? fields : action === "write" ? { ...fields, text }
      : { ...fields, oldText: Type.String({ minLength: 1, maxLength: 32768 }), newText: text }, { additionalProperties: false });
    return { name: `scope_${action}`, label: `Scope ${action}`, description: `Restricted ${action} of an approved existing file ID only. No paths, discovery or new files.`,
      executionMode: "sequential", parameters,
      async execute(_callId, args, toolSignal) {
        try {
          assert.equal(pending, undefined); await fresh();
          if (!Value.Check(parameters, args)) throw stopped();
          const id = `request-${++sequence}`, request = { ...args, id, action };
          const next = reduceGoalFiles(state, { type: "request", scopeId: scope.id, request }); state = next.state;
          const effect = next.effects.find(value => value.type === "file_io"); if (!effect) throw stopped();
          const ioSignal = toolSignal ? AbortSignal.any([combined, toolSignal]) : combined;
          pending = executeGoalFileEffect(effect, protections, ioSignal);
          const event = await pending; pending = undefined;
          const reply = reduceGoalFiles(state, event); state = reply.state;
          const result = reply.effects.find(value => value.type === "file_reply"); if (!result || state.status !== "ready") throw stopped();
          return { content: [{ type: "text", text: result.reply.action === "read" ? result.reply.text : JSON.stringify(result.reply) }], details: {} };
        } catch { ownAbort.abort(); throw stopped(); }
      },
    };
  });
  return {
    tools, fresh,
    schemaProjection: tools.map(({ name, description, parameters, executionMode }) => ({ name, description, parameters, executionMode })),
    async withinBatch(fn) { return await withWindowsGoalReadBatch(fn, combined); },
    async close() {
      try {
        if (pending) {
          const event = await pending; pending = undefined;
          state = reduceGoalFiles(state, event).state;
        }
        if (!combined.aborted) await fresh();
        state = reduceGoalFiles(state, { type: combined.aborted ? "cancel" : "close" }).state;
        const progress = state.progress;
        return { ioFinished: state.status === "closed" && !progress?.uncertain, changed: progress?.changed ?? false,
          operations: progress?.operations ?? 0, readBytes: progress?.readBytes ?? 0, writtenBytes: progress?.writtenBytes ?? 0 };
      } finally { ownAbort.abort(); }
    },
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerOnboarding } from "../src/onboarding.ts";
import { parseAutomaticRun, fixedBasicRun, type NativeExecutionHarness } from "../src/basic-execution.ts";
import { DelegateToolInputSchema } from "../src/ordinary-effects.ts";
import { inspectDelegateCatalog } from "../src/runtime-health.ts";
import type { OrdinaryPublicResult } from "../src/ordinary-effects.ts";

const raw = { task: "Repair the current parser.", files: [{ path: "parser.ts", access: "read_write" }], constraints: ["Preserve the interface."], observations: ["The empty-token test fails."] };
const result = { kind: "ordinary_scope", status: "completed_unverified", taskAcceptance: "needs_human_review", workersStarted: 1, modelCalls: 1,
  reservedModelCalls: 0, jevRequests: 1, cleanupConfirmed: true, lockRetained: false, reports: [], skillSuggestions: [] } as unknown as OrdinaryPublicResult;

test("native run defaults to available-model selection, with agent names used as permission templates", async () => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1], automatic = 0, fixed = 0;
  const harness: NativeExecutionHarness = { isBusy: () => false, blockedReason: () => undefined, cancel: async () => {}, lastFailure: () => undefined,
    run: async () => { fixed++; return result; }, automatic: async input => {
      automatic++; assert.equal(input.role, "scout"); assert.deepEqual(input.observations, raw.observations); return result;
    } };
  registerOnboarding({ on() {}, registerCommand(_name: string, value: typeof command) { command = value; } } as unknown as ExtensionAPI, harness);
  const ctx = { cwd: "/synthetic", mode: "rpc", hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => "automatic-native" }, ui: { notify() {} } } as unknown as ExtensionCommandContext;
  await command.handler(`run ${JSON.stringify({ ...raw, agent: "scout" })}`, ctx);
  assert.equal(automatic, 1); assert.equal(fixed, 0);
  await command.handler(`run ${JSON.stringify({ task: raw.task, files: raw.files, agent: "scout", modelSelection: "fixed" })}`, ctx);
  assert.equal(automatic, 1); assert.equal(fixed, 1);
});

test("automatic public API is closed and remains visible as a current tool catalog", () => {
  assert.equal(Value.Check(DelegateToolInputSchema, { auto: raw }), true);
  assert.equal(Value.Check(DelegateToolInputSchema, { auto: { ...raw, approved: true } }), false);
  assert.equal(Value.Check(DelegateToolInputSchema, { auto: { ...raw, model: "invented/model", thinking: "max" } }), false);
  assert.equal(inspectDelegateCatalog([{ name: "jev_delegate", parameters: DelegateToolInputSchema }]), "scoped_visible");
  assert.deepEqual(parseAutomaticRun(JSON.stringify(raw)), raw);
  assert.equal(parseAutomaticRun(JSON.stringify({ ...raw, history: ["PRIVATE_PARENT_HISTORY"] })), undefined);
  assert.equal(fixedBasicRun('{"modelSelection":"fixed"}'), true);
});

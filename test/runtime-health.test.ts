import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DelegateInputSchema } from "../src/delegate-machine.ts";
import { DelegateToolInputSchema } from "../src/ordinary-effects.ts";
import { inspectDelegateCatalog, readRuntimeHealth, runtimeHealthText } from "../src/runtime-health.ts";
import jevRouter from "../src/index.ts";

const tools = [{ name: "jev_delegate", parameters: DelegateToolInputSchema, description: "PRIVATE_PROMPT_NOT_FOR_DIAGNOSTICS" }];
const ctx = { mode: "print", hasUI: true, ui: { confirm: async () => assert.fail("No native approval in a runtime check") } } as unknown as ExtensionContext;

test("actual scoped/legacy/absent catalog visibility is not inferred from a source constant", () => {
  assert.equal(inspectDelegateCatalog(tools), "scoped_visible");
  assert.equal(inspectDelegateCatalog([{ name: "jev_delegate", parameters: DelegateInputSchema }]), "legacy_visible");
  assert.equal(inspectDelegateCatalog([]), "not_registered");
  assert.equal(inspectDelegateCatalog([...tools, ...tools]), "inconclusive");
  assert.equal(inspectDelegateCatalog([{ name: "jev_delegate" }]), "inconclusive");
  assert.equal(inspectDelegateCatalog([{ name: "jev_delegate", parameters: { anyOf: [...DelegateToolInputSchema.anyOf, null] } }]), "inconclusive", "The closed tree and live continuation branches are intentional; overlarge catalogs remain bounded");
});

test("inspection is immutable and malformed, overlarge, inherited or throwing metadata never certifies readiness", () => {
  const before = structuredClone(tools);
  Object.freeze(tools[0]); Object.freeze(tools);
  assert.equal(inspectDelegateCatalog(tools), "scoped_visible"); assert.deepEqual(tools, before);
  for (const value of [null, {}, [null], Array(513).fill(tools[0]), [{ name: "jev_delegate", parameters: { anyOf: [null] } }],
    [Object.create(tools[0]!)], [{ name: "jev_delegate", get parameters() { throw new Error("PRIVATE_METADATA_ERROR"); } }]]) {
    const result = inspectDelegateCatalog(value);
    assert.ok(result === "inconclusive" || result === "not_registered");
    assert.notEqual(result, "scoped_visible");
  }
});

test("current public tool activation and native API availability are separate observations, not permission or model checks", () => {
  const pi = { getAllTools: () => tools, getActiveTools: () => ["jev_delegate"] } as unknown as ExtensionAPI;
  const health = readRuntimeHealth(pi, ctx);
  assert.equal(health.catalog, "scoped_visible"); assert.equal(health.active, "yes"); assert.equal(health.approvalApi, "supported"); assert.equal(health.mode, "print");
  assert.equal(readRuntimeHealth({ ...pi, getActiveTools: () => [] }, ctx).active, "no");
  assert.equal(readRuntimeHealth(pi, { ...ctx, hasUI: false }).approvalApi, "unsupported");
  const text = runtimeHealthText(health);
  assert.match(text, /Physical display\/acceptance unverified/);
  assert.match(text, /Reviewed · genuine exact-source approval required/);
  assert.match(text, /Full Access · explicit live-session acknowledgement/);
  assert.match(text, /Diagnostic metadata grants neither mode/);
  assert.equal(text.includes("PRIVATE_PROMPT"), false);
});

test("runtime presentation uses spaced plain-text sections and bounded readable rows without terminal or HTML escapes", () => {
  const health = readRuntimeHealth({ getAllTools: () => tools, getActiveTools: () => ["jev_delegate"] } as unknown as ExtensionAPI, ctx);
  const before = structuredClone(health), text = runtimeHealthText(health);
  assert.match(text, /^✨ JEV Runtime\nRead-only diagnostic · ordinary-scoped\/v1\n/);
  for (const heading of ["🧩 Tool status", "🖥️ Host", "🔎 Diagnostic scope", "🔐 Separate validation required"]) {
    assert.ok(text.includes(`\n\n${heading}\n`));
  }
  assert.ok(text.split("\n").every(line => [...line].length <= 70));
  assert.equal(text.includes("\u001b"), false); assert.doesNotMatch(text, /<[^>]+>|```/);
  assert.deepEqual(health, before);
});

test("styled runtime states preserve negative, unknown and unverified distinctions without an overall success badge", () => {
  const base = readRuntimeHealth({ getAllTools: () => tools, getActiveTools: () => ["jev_delegate"] } as unknown as ExtensionAPI, ctx);
  for (const catalog of ["scoped_visible", "legacy_visible", "not_registered", "inconclusive"] as const) {
    for (const active of ["yes", "no", "unknown"] as const) {
      for (const approvalApi of ["supported", "unsupported"] as const) {
        const text = runtimeHealthText({ ...base, catalog, active, approvalApi, mode: "unknown" });
        assert.match(text, /Mode · unconfirmed \(unknown\)/);
        assert.match(text, /Physical display\/acceptance unverified/);
        assert.match(text, /Reviewed · genuine exact-source approval required/);
        assert.match(text, /Full Access · explicit live-session acknowledgement/);
        assert.match(text, /Diagnostic metadata grants neither mode/);
        assert.match(text, /No execution/); assert.match(text, /No request\/change/);
        assert.doesNotMatch(text, /preparation complete|overall success|approval complete/i);
        if (catalog === "legacy_visible") assert.match(text, /⚠️ Only legacy single delegation visible \/ check reload/);
        if (catalog === "not_registered") assert.match(text, /⛔ jev_delegate is not registered/);
        if (catalog === "inconclusive") assert.match(text, /❔ Inconclusive \/ not assumed successful/);
        if (active === "no") assert.match(text, /⏸️ jev_delegate inactive/);
        if (active === "unknown") assert.match(text, /❔ Active tools unconfirmed/);
        if (approvalApi === "unsupported") assert.match(text, /Approval UI API · support unconfirmed/);
      }
    }
  }
});

test("missing/throwing host and UI APIs stay unknown/unsupported without raw errors or automatic fallback", () => {
  const pi = { getAllTools: () => { throw new Error("PRIVATE_HOST_ERROR"); }, getActiveTools: () => { throw new Error("PRIVATE_ACTIVE_ERROR"); } } as unknown as ExtensionAPI;
  const broken = { hasUI: true, mode: "print", get ui() { throw new Error("PRIVATE_UI_ERROR"); } } as unknown as ExtensionContext;
  const health = readRuntimeHealth(pi, broken);
  assert.equal(health.catalog, "inconclusive"); assert.equal(health.active, "unknown"); assert.equal(health.approvalApi, "unsupported"); assert.equal(health.mode, "unknown");
  assert.equal(runtimeHealthText(health).includes("PRIVATE_"), false);
  assert.equal(readRuntimeHealth({} as ExtensionAPI, ctx).catalog, "inconclusive");
});

test("runtime command reads the live catalog and own package metadata; no setup, sessions, models, HTTP, child, approval or settings", async t => {
  const registered: ToolDefinition[] = [], notifications: string[] = [];
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const calls: string[] = [];
  const pi = { on() {}, registerCommand(name: string, value: typeof command) { assert.equal(name, "jev-subagents"); command = value; },
    registerTool(tool: ToolDefinition) { registered.push(tool); },
    getAllTools() { calls.push("catalog"); return registered; }, getActiveTools() { calls.push("active"); return ["jev_delegate"]; },
    appendEntry: () => assert.fail("No session write"), setActiveTools: () => assert.fail("No tool activation"),
  } as unknown as ExtensionAPI;
  jevRouter(pi);
  const http = t.mock.method(globalThis, "fetch", async () => assert.fail("No HTTP"));
  const fork = t.mock.method(childProcess, "fork", () => assert.fail("No native worker/process"));
  const context = { mode: "print", hasUI: true,
    get isIdle() { return () => assert.fail("No picker/installer work"); },
    get sessionManager() { throw new Error("No session read/write"); },
    ui: { confirm: async () => assert.fail("No actual approval"), select: async () => assert.fail("No selection"),
      custom: () => assert.fail("No custom UI"), notify(text: string) { notifications.push(text); } },
  } as unknown as ExtensionCommandContext;
  await command.handler("runtime", context);
  assert.deepEqual(calls, ["catalog", "active"]); assert.deepEqual(registered.map(tool => tool.name), ["jev_route", "jev_decide", "jev_delegate", "jev_memory"]); assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, /New scope input visible in the current catalog/);
  assert.ok(notifications[0]!.includes(JSON.stringify(fileURLToPath(new URL("../", import.meta.url)))));
  assert.match(notifications[0]!, /Package version \(metadata\) · \d+\.\d+\.\d+/);
  assert.match(notifications[0]!, /not the active tool owner/);
  assert.equal(http.mock.callCount(), 0); assert.equal(fork.mock.callCount(), 0);
  const completions = await command.getArgumentCompletions?.("run");
  assert.ok(completions?.some(item => item.value === "runtime"));
});

test("unsupported runtime notification cannot fail work or retry through another UI/model", async () => {
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1]; let notifications = 0;
  jevRouter({ on() {}, registerTool() {}, registerCommand(_name: string, value: typeof command) { command = value; },
    getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI);
  await command.handler("runtime", { mode: "rpc", hasUI: false, ui: { notify() { notifications++; throw new Error("PRIVATE_PRESENTATION_ERROR"); } } } as unknown as ExtensionCommandContext);
  assert.equal(notifications, 1);
});

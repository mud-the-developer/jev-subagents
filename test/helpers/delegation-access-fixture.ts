import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDelegationAccess } from "../../src/delegation-access-effects.ts";

export function accessFixture(context?: ExtensionContext, cancel: () => Promise<void> = async () => {}) {
  let session = "session", confirmations = 0;
  const hooks = new Map<string, (() => void | Promise<void>)[]>(), statuses: (string | undefined)[] = [], notices: string[] = [];
  const ctx = context ?? { mode: "rpc", cwd: "/synthetic", hasUI: true,
    sessionManager: { getSessionId: () => session }, ui: {} } as unknown as ExtensionContext;
  Object.assign(ctx, { isIdle: () => true });
  Object.assign(ctx.ui, { confirm: async (_title: string, packet: string, options?: { timeout?: number }) => {
    confirmations++; assert.match(packet, /Enable Full Access/); assert.match(packet, /NO cumulative/); assert.equal(options?.timeout, undefined); return true;
  }, setStatus: (_key: string, text?: string) => { statuses.push(text); }, notify: (text: string) => { notices.push(text); } });
  const access = registerDelegationAccess({ on(event: string, handler: () => void | Promise<void>) {
    hooks.set(event, [...hooks.get(event) ?? [], handler]);
  } } as unknown as ExtensionAPI, { isBusy: () => false, cancel });
  return { ctx, access, hooks, statuses, notices, confirmations: () => confirmations, move: () => { session = "other-session"; },
    enable: async () => { await access.handle("full", ctx); const lease = access.lease(ctx); assert.ok(lease); return lease; } };
}

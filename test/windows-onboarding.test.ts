import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { confirmOnboardingPacket } from "../src/onboarding.ts";
import { createWindowsProfiles, isWindowsPrivateProfile } from "../src/windows-profile-files.ts";

const native = { skip: process.platform !== "win32", timeout: 30_000 };
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-onboard-acl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("native NTFS profiles are private at creation and never overwrite existing content", native, async t => {
  const root = await fixture(t), file = path.join(root, "agents", "worker.md");
  await createWindowsProfiles([{ file, content: "synthetic offline data\n" }], t.signal);
  assert.equal(await isWindowsPrivateProfile(file, t.signal), true);
  await assert.rejects(createWindowsProfiles([{ file, content: "replacement" }], t.signal));
  assert.equal(await readFile(file, "utf8"), "synthetic offline data\n");
});

test("native profile creation rejects junction destinations and preserves outside files", native, async t => {
  const root = await fixture(t), outside = path.join(root, "outside"), alias = path.join(root, "agents");
  await mkdir(outside); await symlink(outside, alias, "junction");
  await assert.rejects(createWindowsProfiles([{ file: path.join(alias, "worker.md"), content: "forbidden" }], t.signal));
  await assert.rejects(readFile(path.join(outside, "worker.md")), { code: "ENOENT" });
});

test("native privacy rejects hardlinks and untrusted ACL read grants", native, async t => {
  const root = await fixture(t), file = path.join(root, "worker.md"), alias = path.join(root, "alias.md");
  await createWindowsProfiles([{ file, content: "synthetic" }], t.signal);
  await link(file, alias);
  assert.equal(await isWindowsPrivateProfile(file, t.signal), false);
  await rm(alias);
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$p=$env:JEV_TEST_ACL_FILE; $acl=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access); $sid=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'Read','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($p,$acl)"],
    { env: { SystemRoot: process.env.SystemRoot, JEV_TEST_ACL_FILE: file } });
  assert.equal(await isWindowsPrivateProfile(file, t.signal), false);
});

test("native cancellation admits no profile creation", native, async t => {
  const root = await fixture(t), file = path.join(root, "worker.md");
  await assert.rejects(createWindowsProfiles([{ file, content: "never written" }], AbortSignal.abort()));
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

const packet = "Exact profile review\nC:\\synthetic\\agents\\worker.md\n---\nmodel: explicitly-approved/model\n---\nSynthetic prompt.";
test("RPC approval displays the complete read-only packet and accepts only literal true", async () => {
  for (const answer of [true, false, "yes", undefined]) {
    let calls = 0;
    const ctx = { mode: "rpc", hasUI: true, ui: {
      custom: () => assert.fail("RPC must never call custom TUI"),
      confirm: async (title: string, message: string, options: { timeout: number; signal: AbortSignal }) => {
        calls++; assert.equal(title, "exact approval"); assert.equal(message, packet);
        assert.ok(options.timeout > 0 && options.timeout <= 60_000); return answer;
      },
    } } as unknown as ExtensionContext;
    assert.equal(await confirmOnboardingPacket(ctx, "exact approval", packet, Date.now() + 60_000, new AbortController().signal), answer === true);
    assert.equal(calls, 1);
  }
});

test("RPC approval expiry and lifecycle cancellation ignore late acceptance", { timeout: 5_000 }, async () => {
  for (const cancel of [false, true]) {
    let accept!: (value: boolean) => void;
    const controller = new AbortController();
    const ctx = { mode: "rpc", hasUI: true, ui: { confirm: () => new Promise<boolean>(resolve => { accept = resolve; }) } } as unknown as ExtensionContext;
    const pending = confirmOnboardingPacket(ctx, "approval", packet, Date.now() + (cancel ? 1000 : 10), controller.signal);
    if (cancel) controller.abort();
    assert.equal(await pending, false); accept(true);
  }
});

test("desktop SDK print mode uses native confirmation, never terminal-only custom UI", async () => {
  for (const answer of [true, false, "yes"]) {
    let calls = 0;
    const ctx = { mode: "print", hasUI: true, ui: {
      custom: async () => { throw new Error("__PI_GUI_UNSUPPORTED_HOST_UI__:custom"); },
      confirm: async (_title: string, message: string) => { calls++; assert.equal(message, packet); return answer; },
    } } as unknown as ExtensionContext;
    assert.equal(await confirmOnboardingPacket(ctx, "desktop approval", packet, Date.now() + 1000, new AbortController().signal), answer === true);
    assert.equal(calls, 1);
  }
});

test("desktop SDK print mode cancellation and timeout cannot revive approval", { timeout: 5_000 }, async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let accept!: (value: boolean) => void;
    const ctx = { mode: "print", hasUI: true, ui: {
      custom: () => assert.fail("Desktop must never enter TUI"),
      confirm: () => new Promise<boolean>(resolve => { accept = resolve; }),
    } } as unknown as ExtensionContext;
    const pending = confirmOnboardingPacket(ctx, "desktop approval", packet, Date.now() + (cancelled ? 1000 : 10), controller.signal);
    if (cancelled) controller.abort();
    assert.equal(await pending, false); accept(true);
  }
});

test("RPC missing UI and pre-cancellation never request approval", async () => {
  const ctx = { mode: "rpc", hasUI: false, ui: { confirm: () => assert.fail("No UI") } } as unknown as ExtensionContext;
  assert.equal(await confirmOnboardingPacket(ctx, "approval", packet, Date.now() + 1000, new AbortController().signal), false);
  assert.equal(await confirmOnboardingPacket({ ...ctx, hasUI: true }, "approval", packet, Date.now() + 1000, AbortSignal.abort()), false);
});

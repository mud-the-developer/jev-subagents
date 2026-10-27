import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { readRuntimeIdentity } from "../src/runtime-identity-effects.ts";
import { runtimeIdentityRows } from "../src/runtime-health.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-runtime-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  return { root, manifest: path.join(root, "package.json"), moduleUrl: pathToFileURL(path.join(root, "src", "onboarding.ts")).href };
}

test("own code identity reads only bounded version metadata from the command module's package", async t => {
  const f = await fixture(t);
  await writeFile(f.manifest, JSON.stringify({ version: "1.0.0-beta.1+local", description: "PRIVATE_NOT_FOR_DIAGNOSTICS", credentials: "PRIVATE_NOT_FOR_DIAGNOSTICS" }));
  const identity = readRuntimeIdentity(f.moduleUrl);
  assert.deepEqual(identity, { packageRoot: f.root + path.sep, packageVersion: "1.0.0-beta.1+local" });
  const text = runtimeIdentityRows(identity).join("\n");
  assert.ok(text.includes(JSON.stringify(identity.packageRoot))); assert.match(text, /not the active tool owner/);
  assert.match(text, /does not verify loaded code or freshness/); assert.equal(text.includes("PRIVATE_NOT_FOR_DIAGNOSTICS"), false);
});

test("missing, malformed, oversized and hostile version metadata remains unknown without exposing the error", async t => {
  const f = await fixture(t);
  assert.deepEqual(readRuntimeIdentity(f.moduleUrl), { packageRoot: f.root + path.sep, packageVersion: null });
  for (const text of ["not JSON", "null", "[]", "{}", '{"version":123}', '{"version":"PRIVATE_RAW_ERROR"}',
    JSON.stringify({ version: "1.0.0\nFORGED" }), JSON.stringify({ version: "1.0.0", padding: "x".repeat(32768) })]) {
    await writeFile(f.manifest, text);
    assert.deepEqual(readRuntimeIdentity(f.moduleUrl), { packageRoot: f.root + path.sep, packageVersion: null });
  }
  assert.deepEqual(readRuntimeIdentity("https://example.invalid/src/onboarding.ts"), { packageRoot: null, packageVersion: null });
});

test("code metadata closes its descriptor even when parsing fails", async t => {
  const f = await fixture(t); await writeFile(f.manifest, "invalid JSON");
  const close = t.mock.method(fs, "closeSync");
  assert.equal(readRuntimeIdentity(f.moduleUrl).packageVersion, null); assert.equal(close.mock.callCount(), 1);
});

test("linked manifests are not followed for diagnostic metadata", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), target = path.join(f.root, "unrelated.json");
  await writeFile(target, '{"version":"9.9.9"}'); await symlink(target, f.manifest);
  assert.equal(readRuntimeIdentity(f.moduleUrl).packageVersion, null);
});

test("package paths cannot inject terminal rows or bidi controls into diagnostics", () => {
  const identity = { packageRoot: "/tmp/한글\nFORGED\u001b[31m\u0085\u202e", packageVersion: "1.0.0" };
  const before = structuredClone(identity), text = runtimeIdentityRows(identity).join("\n");
  assert.equal(text.includes("\nFORGED"), false); assert.equal(text.includes("\u001b"), false); assert.equal(text.includes("\u0085"), false); assert.equal(text.includes("\u202e"), false);
  assert.ok(text.includes("한글")); assert.deepEqual(identity, before);
});

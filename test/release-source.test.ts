import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createSourceRelease } from "../scripts/release-source.ts";

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jev-release-fixture-"))), repo = path.join(root, "source"), output = path.join(root, "output");
  await fs.mkdir(repo); await fs.mkdir(output); await fs.mkdir(path.join(root, "empty-hooks")); await fs.mkdir(path.join(repo, "src"));
  const git = (...args: string[]) => cp.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q"); git("config", "user.name", "Synthetic release fixture"); git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false"); git("config", "core.hooksPath", path.join(root, "empty-hooks")); git("config", "core.autocrlf", "false");
  const pkg = { name: "synthetic-source", version: "0.5.0-rc.1", private: true, dependencies: { typebox: "1.3.7" }, overrides: { minimatch: { "brace-expansion": "5.0.12" } } };
  const lock = { lockfileVersion: 3, configVersion: 0, workspaces: { "": { name: pkg.name, dependencies: { ...pkg.dependencies } } }, overrides: structuredClone(pkg.overrides), packages: {} };
  await fs.writeFile(path.join(repo, "package.json"), JSON.stringify(pkg));
  await fs.writeFile(path.join(repo, "bun.lock"), `// Synthetic Bun JSONC lock\n${JSON.stringify(lock).slice(0, -1)},}\n`);
  await fs.writeFile(path.join(repo, "src", "index.ts"), "export const syntheticOnly = true;\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env\nauth.json\n");
  git("add", "."); git("commit", "-qm", "Synthetic source fixture only");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repo, output, git, pkg, lock };
}
test("private source artifact is a committed ZIP with a matching SHA256SUMS and no ignored user state", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, ".env"), "SYNTHETIC_NOT_FOR_ARCHIVE\n"); await fs.writeFile(path.join(f.repo, "auth.json"), "{}\n");
  const result = createSourceRelease(f.repo, f.output), bytes = await fs.readFile(result.archive);
  assert.deepEqual(bytes.subarray(0, 4), Buffer.from([80, 75, 3, 4]));
  assert.ok(bytes.includes(Buffer.from("synthetic-source-0.5.0-rc.1/src/index.ts")));
  assert.equal(bytes.includes(Buffer.from("/auth.json")), false); assert.equal(bytes.includes(Buffer.from("/.env")), false);
  assert.equal(result.commit, f.git("rev-parse", "HEAD").trim()); assert.equal(result.tag, "v0.5.0-rc.1");
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(await fs.readFile(result.checksum, "utf8"), `${result.sha256}  ${path.basename(result.archive)}\n`);
  assert.equal(f.git("status", "--porcelain").trim(), "");
});
test("dirty or dependency-inconsistent source cannot be packaged as a committed release", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, "src", "index.ts"), "export const changed = true;\n");
  assert.throws(() => createSourceRelease(f.repo, f.output), /clean/);
  f.lock.workspaces[""].dependencies.typebox = "0.0.1"; await fs.writeFile(path.join(f.repo, "bun.lock"), JSON.stringify(f.lock));
  f.git("add", "."); f.git("commit", "-qm", "Synthetic mismatch");
  assert.throws(() => createSourceRelease(f.repo, f.output), /manifest|metadata/); assert.deepEqual(await fs.readdir(f.output), []);
});
test("tracked private artifacts and a public npm manifest refuse source release before archive creation", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.repo, ".env"), "SYNTHETIC_PRIVATE_FIXTURE\n"); f.git("add", "-f", ".env"); f.git("commit", "-qm", "Synthetic forbidden path");
  assert.throws(() => createSourceRelease(f.repo, f.output), /private artifacts/); assert.deepEqual(await fs.readdir(f.output), []);
  f.git("rm", ".env"); f.pkg.private = false; await fs.writeFile(path.join(f.repo, "package.json"), JSON.stringify(f.pkg));
  f.git("add", "."); f.git("commit", "-qm", "Synthetic public manifest refused");
  assert.throws(() => createSourceRelease(f.repo, f.output), /private manifest/); assert.deepEqual(await fs.readdir(f.output), []);
});
test("Bun lock policy mismatches, malformed dependency maps and unsafe version text refuse packaging", async t => {
  for (const variant of ["override", "null-dependencies", "nested-override", "version-newline"]) {
    const f = await fixture(t);
    if (variant === "override") f.lock.overrides.minimatch["brace-expansion"] = "5.0.11";
    if (variant === "null-dependencies") {
      Object.assign(f.pkg, { dependencies: null }); Object.assign(f.lock.workspaces[""], { dependencies: null });
    }
    if (variant === "nested-override") {
      const unsupported = { sdk: { minimatch: { "brace-expansion": "5.0.12" } } };
      Object.assign(f.pkg, { overrides: unsupported }); Object.assign(f.lock, { overrides: unsupported });
    }
    if (variant === "version-newline") f.pkg.version = "1.0.0\n";
    await fs.writeFile(path.join(f.repo, "package.json"), JSON.stringify(f.pkg));
    await fs.writeFile(path.join(f.repo, "bun.lock"), JSON.stringify(f.lock));
    f.git("add", "."); f.git("commit", "-qm", "Synthetic invalid Bun metadata");
    assert.throws(() => createSourceRelease(f.repo, f.output), /manifest|metadata/);
    assert.deepEqual(await fs.readdir(f.output), []);
  }
});

test("source packaging never overwrites an artifact or writes it into the source checkout", async t => {
  const f = await fixture(t), result = createSourceRelease(f.repo, f.output), before = await fs.readFile(result.archive);
  assert.throws(() => createSourceRelease(f.repo, f.output), /already exists/); assert.deepEqual(await fs.readFile(result.archive), before);
  assert.throws(() => createSourceRelease(f.repo, f.repo), /outside/);
  await fs.mkdir(path.join(f.repo, "nested-output")); assert.throws(() => createSourceRelease(f.repo, path.join(f.repo, "nested-output")), /outside/);
});

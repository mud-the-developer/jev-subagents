import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile, link, symlink, rm, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test, type TestContext } from "node:test";
import { readApprovalPolicy, parallelPolicyIO, PARALLEL_READ_ERROR } from "../src/parallel-read-effects.ts";
import { directoryError } from "../src/directory-diagnostics.ts";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-parallel-policy-"))), directory = path.join(root, ".pi"), file = path.join(directory, "jev-orchestration.json");
  await mkdir(directory, { mode: 0o700 }); t.after(() => rm(root, { recursive: true, force: true })); return { root, directory, file };
}
const policy = { version: 1, approval: { level: "balanced" } };
test("missing operator config supplies preferences only; no file or stored execution grant is created", async t => {
  const f = await fixture(t), first = await readApprovalPolicy(f.root); assert.deepEqual(first.policy, policy);
  first.policy.approval.level = "strict"; assert.deepEqual((await readApprovalPolicy(f.root)).policy, policy);
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
});
test("the repository config example contains only the supported default review preference", async t => {
  const f = await fixture(t), example: unknown = JSON.parse(await readFile(new URL("../jev-orchestration.example.json", import.meta.url), "utf8"));
  assert.deepEqual(example, policy); await writeFile(f.file, JSON.stringify(example));
  assert.deepEqual((await readApprovalPolicy(f.root)).policy, policy);
});
test("existing closed config selects only review granularity and content changes invalidate its version", async t => {
  const f = await fixture(t); await writeFile(f.file, JSON.stringify(policy), { mode: 0o600 }); const first = await readApprovalPolicy(f.root);
  assert.deepEqual(first.policy, policy);
  await writeFile(f.file, JSON.stringify({ version: 1, approval: { level: "strict" } }));
  const next = await readApprovalPolicy(f.root); assert.deepEqual(next.policy, { version: 1, approval: { level: "strict" } }); assert.notEqual(first.version, next.version);
});
test("malformed/oversized/unknown or autoapprove config fails without echoing its source or using defaults", async t => {
  const f = await fixture(t);
  for (const value of ["PRIVATE_CONFIG_EXCERPT", " ".repeat(4097), JSON.stringify({ ...policy, approved: true }),
    JSON.stringify({ ...policy, approval: { level: "trusted" } }), JSON.stringify({ ...policy, parallel: { maxConcurrency: 4 } })]) {
    await writeFile(f.file, value);
    await assert.rejects(readApprovalPolicy(f.root), error => error instanceof Error && error.message === PARALLEL_READ_ERROR && !error.message.includes("PRIVATE_CONFIG_EXCERPT"));
  }
});
test("the removed parallel field is unknown even with former valid widths or an empty object", async t => {
  const f = await fixture(t);
  for (const parallel of [{}, null, ...[1, 2, 3].map(maxConcurrency => ({ maxConcurrency }))]) {
    await writeFile(f.file, JSON.stringify({ ...policy, parallel }));
    await assert.rejects(readApprovalPolicy(f.root), { message: PARALLEL_READ_ERROR });
  }
});
test("an unconfirmed operator-file close is retained as cleanup uncertainty, not a clean default", async t => {
  const f = await fixture(t); await writeFile(f.file, JSON.stringify(policy));
  t.mock.method(parallelPolicyIO, "open", async (...args: Parameters<typeof parallelPolicyIO.open>) => {
    const handle = await open(...args), close = handle.close.bind(handle);
    handle.close = async () => { await close(); throw new Error("PRIVATE_CLOSE_CAUSE"); }; return handle;
  });
  await assert.rejects(readApprovalPolicy(f.root), error => error instanceof Error && error.message === PARALLEL_READ_ERROR && directoryError(error)?.cleanupConfirmed === false);
});
test("operator config symlinks and hardlinks are refused before reading data through another path", async t => {
  const f = await fixture(t), target = path.join(f.root, "synthetic-private-config.json"); await writeFile(target, JSON.stringify(policy));
  await link(target, f.file); await assert.rejects(readApprovalPolicy(f.root), { message: PARALLEL_READ_ERROR }); await rm(f.file);
  const external = path.join(f.root, "linked-config"); await mkdir(external); await writeFile(path.join(external, "jev-orchestration.json"), JSON.stringify(policy));
  await rm(f.directory, { recursive: true }); await symlink(external, f.directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readApprovalPolicy(f.root), { message: PARALLEL_READ_ERROR }); assert.equal(await readFile(target, "utf8"), JSON.stringify(policy));
});

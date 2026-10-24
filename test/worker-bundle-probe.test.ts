import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdtemp, rm, lstat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runGoalProcess } from "../src/goal-run-effects.ts";
import { bunWorkerOptions, workerEnvironment } from "../src/worker-runtime.ts";
import type { WorkerReply } from "../src/delegate-machine.ts";
import { fixtureWorkDeadline, teardownOwnedFixture } from "./helpers/owned-fixture-teardown.ts";

const source = fileURLToPath(new URL("../src/", import.meta.url));
for (const worker of ["goal-sequence-worker", "sol-pi-worker"]) for (const variant of ["esm", "bytecode"]) test(`same-checkout ${worker}/${variant} rejects malformed/duplicate input and stays inert on import`, async t => {
  const bundle = path.join(source, `${worker}.probe-${variant}.js`), root = await mkdtemp(path.join(os.tmpdir(), "jev-bundle-wire-"));
  const owner = fixtureWorkDeadline(t.signal, 25_000), invocations: Promise<unknown>[] = []; let uncertain = false;
  t.after(() => teardownOwnedFixture({ async stop() { owner.close(); }, invocations: () => invocations, async release() {},
    async hasMarker() { return uncertain; }, remove: () => rm(root, { recursive: true, force: true }), reset() {} }));
  assert.ok((await lstat(bundle)).isFile());
  if (variant === "bytecode") assert.ok((await lstat(`${bundle}.jsc`)).isFile());
  const runtime = bunWorkerOptions(), fork = cp.fork;
  let program = bundle, duplicate = false, observed: unknown;
  t.mock.method(cp, "fork", (_script: string | URL, args: readonly string[], options: cp.ForkOptions) => {
    const child = fork(program, args, { ...options, env: workerEnvironment({ PATH: path.dirname(runtime.execPath), HOME: root, USERPROFILE: root,
      PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT, TEMP: root, TMP: root } : {}) }) });
    if (duplicate) {
      const send = child.send.bind(child); let injected = false;
      t.mock.method(child, "send", (...parameters: Parameters<typeof child.send>) => {
        const result = Reflect.apply(send, child, parameters) as boolean;
        if (!injected) { injected = true; send({}, () => {}); }
        return result;
      });
    }
    return child;
  });
  const run = async (input: Record<string, string>) => {
    const work = runGoalProcess({ script: "goal-sequence-worker.ts", cwd: root, input, deadline: Date.now() + 10_000, timeoutMs: 10_000 },
      (value): value is WorkerReply => { observed = value; return false; }, owner.signal).then(result => {
        uncertain ||= !result.cleanupConfirmed; return result;
      });
    invocations.push(work); const result = await work;
    assert.equal(result.started, true); assert.equal(result.cleanupConfirmed, true); assert.equal(result.result, null);
  };
  program = fileURLToPath(new URL("./fixtures/worker-bundle-import.mjs", import.meta.url));
  const extension = path.join(root, "synthetic-extension.ts");
  await writeFile(extension, 'import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent"; import { Type } from "typebox"; export default pi => { if (VERSION !== "0.85.1" || typeof getAgentDir !== "function" || typeof Type.Object !== "function") throw new Error("Synthetic SDK alias mismatch"); pi.on("before_agent_start", () => undefined); };');
  await run({ bundle, source, extension });
  assert.deepEqual(observed, { type: "bundle_import_probe", sdkVersion: "0.85.1", undiciVersion: "8.12.2", inert: true, loaderReady: true, runtimeFileMatches: true, configExists: true, synthetic: true, liveModels: false });
  observed = undefined; program = bundle;
  await run({});
  if (worker === "goal-sequence-worker") assert.equal(observed, undefined);
  else assert.equal((observed as { type?: string })?.type, "failed");
  observed = undefined; duplicate = true;
  await run({});
  if (worker === "goal-sequence-worker") assert.equal(observed, undefined);
  else assert.equal((observed as { type?: string })?.type, "failed");
});

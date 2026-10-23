import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { platformCapabilities } from "../src/platform-support.ts";
import { canonicalDirectory } from "../src/goal-run-effects.ts";
import { GOAL_RUN_ERROR } from "../src/goal-run.ts";
import { windowsGoalFileIO } from "../src/windows-goal-files.ts";

test("Windows basic support never implies POSIX Goal/D/SoL-Pi or Linux verifier support", () => {
  const entries = platformCapabilities("win32");
  assert.deepEqual(entries.map(x => x.supported), [true, false, false]);
  assert.match(entries[1]!.reason, /import success is not execution support/);
});
test("Linux and macOS retain distinct container contracts; unknown platforms fail closed", () => {
  assert.deepEqual(platformCapabilities("linux").map(x => x.supported), [true, true, true]);
  assert.deepEqual(platformCapabilities("darwin").map(x => x.supported), [true, true, false]);
  assert.deepEqual(platformCapabilities("unsupported").map(x => x.supported), [false, false, false]);
});

test("POSIX requires real UID; Windows requires verified native ownership before filesystem payload, with sanitized refusal", async t => {
  const nativeOwner = process.platform === "win32" ? t.mock.method(windowsGoalFileIO, "own", async () => { throw new Error("Synthetic Job ownership denial"); }) : undefined;
  const descriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  const stat = t.mock.method(fs, "lstat", async () => assert.fail("Unavailable ownership must stop before filesystem I/O"));
  syncBuiltinESMExports();
  t.after(() => {
    stat.mock.restore(); syncBuiltinESMExports();
    if (descriptor) Object.defineProperty(process, "getuid", descriptor); else Reflect.deleteProperty(process, "getuid");
  });
  const directory = path.resolve(tmpdir(), "synthetic-unavailable-ownership-never-created");
  for (const getuid of [undefined, () => NaN, () => -1, () => 1.5]) {
    Object.defineProperty(process, "getuid", { configurable: true, writable: true, value: getuid });
    for (const privateDirectory of [false, true])
      await assert.rejects(canonicalDirectory(directory, privateDirectory), { name: "Error", message: GOAL_RUN_ERROR });
  }
  assert.equal(stat.mock.callCount(), 0);
  if (nativeOwner) assert.equal(nativeOwner.mock.callCount(), 8);
  else {
    if (descriptor) Object.defineProperty(process, "getuid", descriptor);
    await assert.rejects(canonicalDirectory(directory), { name: "Error", message: GOAL_RUN_ERROR });
    assert.equal(stat.mock.callCount(), 1, "The native I/O hook must also be effective under Bun");
  }
});

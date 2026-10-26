// Zero-model check: only sample/count/path plumbing differs from the completed three-case harness.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = fileURLToPath(new URL("./", import.meta.url)), old = fileURLToPath(new URL("../multistage-bird-pilot/", import.meta.url));
let protocol, manifest;
try { protocol = JSON.parse(await fs.readFile(path.join(here, "protocol.json"), "utf8")); manifest = JSON.parse(await fs.readFile(path.join(old, "MANIFEST.json"), "utf8")); }
catch { assert.fail("Registration metadata invalid."); }
for (const [name, digest] of Object.entries(manifest.files)) assert.equal(createHash("sha256").update(await fs.readFile(path.join(old, name))).digest("hex"), digest);
let candidate = await fs.readFile(path.join(here, "run-workflow.mjs"), "utf8");
candidate = candidate.replace('fileURLToPath(new URL("../multistage-bird-pilot/phase-worker.mjs", import.meta.url))', 'path.join(here, "phase-worker.mjs")')
  .replace('  assert.equal(sha(await fs.readFile(phaseWorker)), protocol.sharedPhaseWorkerSha256);\n', '')
  .replaceAll('index < 21', 'index < 9').replaceAll('MULTISTAGE-EXTENSION-SAMPLE.json', 'MULTISTAGE-SAMPLE.json').replaceAll('prepared-multistage-extension', 'prepared-multistage');
assert.equal(candidate, await fs.readFile(path.join(old, "run-workflow.mjs"), "utf8"), "Prompts, routing, grade, limits or cleanup changed.");
assert.equal(protocol.cases.length, 7); assert.equal(protocol.order.length, 21);
assert.equal(new Set(protocol.cases.map(row => row.questionId)).size, 7);
assert.ok(protocol.cases.every(row => !protocol.excludedPreviousQuestionIds.includes(row.questionId)));
for (const row of protocol.cases) for (const arm of ["fixed_cheap", "fixed_strong", "routed"]) assert.equal(protocol.order.filter(trial => trial.questionId === row.questionId && trial.arm === arm).length, 1);
assert.equal(createHash("sha256").update(await fs.readFile(path.join(old, "results.json"))).digest("hex"), protocol.extension.previousResultsSha256);
assert.equal(createHash("sha256").update(await fs.readFile(path.join(old, "phase-worker.mjs"))).digest("hex"), protocol.sharedPhaseWorkerSha256);
const runtimeRoot = path.resolve(process.argv[2]);
const sdk = await import(pathToFileURL(path.join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
assert.equal(sdk.VERSION, "0.85.1"); assert.equal(process.versions.bun, "1.4.3");
const agent = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE, ".pi/agent");
for (const [name, expected] of Object.entries(protocol.profiles)) {
  const text = await fs.readFile(path.join(agent, "agents", name + ".md"), "utf8"), { frontmatter } = sdk.parseFrontmatter(text), rawBody = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1];
  assert.equal(createHash("sha256").update(rawBody).digest("hex"), expected.systemSha256); assert.equal(frontmatter.model, expected.model); assert.equal(frontmatter.thinking, expected.thinking);
  assert.equal(Array.isArray(frontmatter.tools) ? frontmatter.tools.join(", ") : frontmatter.tools, expected.tools);
}
console.log(JSON.stringify({ originalSixFrozenSourceHashesVerified: true, modelPromptsRubricsScoringAndSafetyUnchanged: true,
  newDistinctQuestions: 7, previousCasesNotRerun: 3, finalQuestionCount: 10, profilesUnchanged: true, workerCalls: 0, selectorRequests: 0 }));

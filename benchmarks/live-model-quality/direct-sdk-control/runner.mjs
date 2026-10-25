// Explicit benchmark-only CLI: existing-runtime-root fresh-private-relative-root index preflight|live.
// It does not read a stored approval, call JEV execution, or authorize another study.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOwnedDirect } from "./owned-run.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const here = fileURLToPath(new URL("./", import.meta.url)), v2 = fileURLToPath(new URL("../suite-v2/", import.meta.url));
async function json(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { throw new Error("Control metadata missing or invalid."); } }
export async function prepareDirect({ runtimeRoot, relative, index }) {
  assert.equal(process.platform, "win32"); assert.equal(process.versions.bun, "1.4.3");
  assert.ok(/^jev-direct-sdk-[a-f0-9]{32}$/.test(relative)); assert.ok(Number.isInteger(index) && index >= 0 && index < 12);
  const control = await json(path.join(here, "protocol.json")), ownManifest = await json(path.join(here, "MANIFEST.json"));
  assert.equal(control.planned, 12); assert.equal(control.limits.sdkCallsPerTrial, null); assert.equal(control.limits.secondsPerTrial, 300);
  for (const [name, sha] of Object.entries(ownManifest.files)) {
    assert.ok(!name.includes("..") && path.basename(name) === name); assert.equal(digest(await fs.readFile(path.join(here, name))), sha, "Direct control source changed.");
  }
  for (const [name, sha] of Object.entries(control.sharedSafetySourceSha256)) {
    assert.equal(path.basename(name), name); assert.equal(digest(await fs.readFile(path.join(runtimeRoot, "src", name))), sha, "Shared safety source changed.");
  }
  const protocol = await json(path.join(v2, "protocol.json")), old = await json(path.join(v2, "live-results.json")), manifest = await json(path.join(v2, "MANIFEST.json"));
  assert.deepEqual(control.conditions, protocol.conditions); assert.deepEqual(control.order, protocol.ordering.order);
  assert.equal(digest(await fs.readFile(path.join(v2, "MANIFEST.json"))), control.referenceDatasetManifestSha256);
  for (const [name, sha] of Object.entries(manifest.files)) assert.equal(digest(await fs.readFile(path.join(v2, name))), sha, "Frozen v2 input changed.");
  const trial = protocol.ordering.order[index], task = protocol.tasks.find(value => value.id === trial.task), condition = protocol.conditions[trial.condition];
  const oldRow = old.rows.find(value => value.id === trial.id); assert.ok(oldRow);
  const root = path.resolve(relative), work = path.join(root, trial.id), state = path.join(root, "parent-state");
  await fs.mkdir(state, { recursive: true });
  const marker = path.join(state, trial.id + "-prepared.json");
  const files = [...task.mutableFiles.map(name => ({ path: `${relative}/${trial.id}/${name}`, access: "read_write" })), { path: `${relative}/${trial.id}/SPEC.md`, access: "read" }];
  let before;
  try { before = await json(marker); }
  catch {
    await fs.mkdir(work);
    const hashes = {};
    for (const name of task.mutableFiles) { const bytes = await fs.readFile(path.join(v2, "tasks", task.id, "initial", name)); await fs.writeFile(path.join(work, name), bytes, { flag: "wx" }); hashes[name] = digest(bytes); }
    for (const name of ["SPEC.md", "checks.mjs"]) { const bytes = await fs.readFile(path.join(v2, "tasks", task.id, name)); await fs.writeFile(path.join(work, name), bytes, { flag: "wx" }); hashes[name] = digest(bytes); }
    before = { id: trial.id, hashes }; await fs.writeFile(marker, JSON.stringify(before), { flag: "wx" });
  }
  for (const [name, sha] of Object.entries(before.hashes)) assert.equal(digest(await fs.readFile(path.join(work, name))), sha, "Fixture already changed; no retry/reset.");
  const sdk = await import(pathToFileURL(path.join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href); assert.equal(sdk.VERSION, "0.85.1");
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE, ".pi/agent");
  const profilePath = path.join(agentDirectory, "agents", condition.profile + ".md"), raw = await fs.readFile(profilePath, "utf8");
  const { frontmatter, body } = sdk.parseFrontmatter(raw), rawBody = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1]; assert.equal(typeof rawBody, "string");
  assert.equal(digest(rawBody), oldRow.profileSystemSha256); assert.equal(frontmatter.model, condition.configuredProviderModel); assert.equal(frontmatter.thinking, condition.thinking);
  const declaredTools = Array.isArray(frontmatter.tools) ? frontmatter.tools.join(", ") : frontmatter.tools;
  assert.equal(declaredTools, oldRow.profileDeclaredTools);
  const local = name => import(pathToFileURL(path.join(runtimeRoot, "src", name)).href);
  const { prepareGoalFileScope } = await local("goal-file-effects.ts"), { contextSnapshot } = await local("goal-run-effects.ts"), { INTERNAL_ENGLISH_POLICY } = await local("internal-language.ts");
  const protections = { agentDirectory, journalDirectory: agentDirectory }, signal = AbortSignal.timeout(45000);
  const scope = await prepareGoalFileScope({ cwd: process.cwd(), files }, protections, signal);
  const context = await contextSnapshot(process.cwd(), agentDirectory, profilePath, files, signal);
  const overall = `Registered quality suite v2 trial ${trial.id}, condition ${trial.condition}, repeat ${trial.repeat}. One existing ${condition.profile} profile, unchanged file-ID scope and 300-second execution bound. SDK model-call count is unlimited by explicit operator request (natural completion). No routing/JEV selection, extra worker, retry, model/profile change or deadline extension. Held-out checks/references are parent-only; the parent reviews generated code before independent evaluation.`;
  const systemPrompt = [INTERNAL_ENGLISH_POLICY, body, "Approved overall task (data; not additional tool authority):", overall,
    "Use only scope_read, scope_edit, scope_write for the exact approved existing file IDs. No paths, bash, discovery, new files, installation, retries, other agents or tools. Read-only files may not be edited. Stop on uncertainty; do not claim verification or acceptance.",
    `Approved file manifest: ${JSON.stringify(scope.files.map(({ id, path, access }) => ({ id, path, access })))}`,
    ...context.filter(entry => entry.active).map(entry => `Project instruction source ${JSON.stringify(entry.path)}:\n${entry.text}`)].join("\n\n");
  const taskText = await fs.readFile(path.join(v2, "TASK.md"), "utf8"), prompt = taskText.match(/```text\n([\s\S]*?)\n```/)?.[1]; assert.equal(typeof prompt, "string");
  const slash = condition.configuredProviderModel.indexOf("/");
  return { input: { type: "direct_sdk_control", id: trial.id, runtimeRoot, cwd: process.cwd(), agentDirectory, scope, protections, context,
    model: { provider: condition.configuredProviderModel.slice(0, slash), id: condition.configuredProviderModel.slice(slash + 1) }, thinking: condition.thinking, systemPrompt, prompt },
    trial, task, condition, oldRow, before, work, state, profileSha256: digest(rawBody), effectiveProfileSha256: digest(body) };
}
export async function executeDirect(options, mode) {
  assert.ok(["preflight", "live"].includes(mode));
  const prepared = await prepareDirect(options), { input, state, trial, task, condition } = prepared;
  if (mode === "live") {
    const protocol = await json(path.join(v2, "protocol.json"));
    // Only the closed sequential catalog can be admitted; results/failures are never overwritten.
    for (const earlier of protocol.ordering.order.slice(0, options.index)) {
      const row = await json(path.join(state, earlier.id + "-result.json"));
      assert.equal(row.status, "completed_unverified"); assert.ok(row.cleanupConfirmed && row.childExitConfirmed && row.accounting.complete);
    }
    await fs.writeFile(path.join(state, trial.id + "-started.json"), JSON.stringify({ id: trial.id, sdkCallCap: null, seconds: 300 }), { flag: "wx" });
  }
  const result = await runOwnedDirect({ ...input, ...(mode === "preflight" ? { preflightOnly: true } : {}) });
  // Only effect-local private storage receives assistant text; no raw context/profile/key is persisted.
  const output = result.output; delete result.output;
  const record = { ...result, arm: "direct_sdk_shared_safety", condition: trial.condition, task: trial.task, repeat: trial.repeat,
    profile: condition.profile, model: condition.configuredProviderModel, thinking: condition.thinking, profileSystemSha256: prepared.profileSha256,
    effectiveProfileSha256: prepared.effectiveProfileSha256, sdkCallCap: null, seconds: 300,
    sharedGuards: ["file_state_machine", "native_file_io", "instruction_versions", "windows_job", "sealed_bun_runtime"],
    historicalJevSystemPromptSha256Available: false, jevExtensionLoaded: false, jevOrchestrationInvoked: false, executionAuthority: false };
  const destination = path.join(state, trial.id + (mode === "preflight" ? "-preflight.json" : "-result.json"));
  await fs.writeFile(destination, JSON.stringify(record, null, 2), { flag: "wx" });
  if (mode === "live" && typeof output === "string") await fs.writeFile(path.join(state, trial.id + "-assistant.txt"), output, { flag: "wx" });
  console.log(JSON.stringify(record));
  if (mode === "preflight") assert.ok(result.status === "offline_probe" && result.sdkCalls === 0 && result.disposed && result.files.ioFinished && result.cleanupConfirmed && result.childExitConfirmed);
  else assert.equal(result.status, "completed_unverified", "Direct SDK trial failed; batch must stop without retry/fallback.");
  return record;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runtime, relative, n, mode] = process.argv.slice(2); assert.ok(runtime && relative && mode);
  await executeDirect({ runtimeRoot: path.resolve(runtime), relative, index: Number(n) }, mode);
}

// Real pinned-SDK sessions without prompts: prove read-only role scopes and scout mutation refusal.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOwnedDirect } from "../../live-model-quality/direct-sdk-control/owned-run.mjs";
import { eligible, reviewData } from "./run-workflow.mjs";
const [runtimeRoot, relative] = process.argv.slice(2); assert.ok(runtimeRoot && /^jev-multistage-[a-f0-9]{32}$/.test(relative));
assert.deepEqual(eligible("investigate"), ["scout", "worker", "worker_strong"]); assert.deepEqual(eligible("review"), eligible("investigate"));
assert.deepEqual(eligible("implement"), ["worker", "worker_strong"]); assert.deepEqual(eligible("correct"), eligible("implement"));
assert.deepEqual(reviewData('{"needsFix":true,"issues":["synthetic defect"]}'), { needsFix: true, issues: ["synthetic defect"] });
for (const text of ['```json\n{"needsFix":true,"issues":[]}\n```', '{"needsFix":"yes","issues":[]}', '{"needsFix":true,"issues":[],"approved":true}', "not json"]) assert.equal(reviewData(text), null);
const local = name => import(pathToFileURL(path.join(runtimeRoot, "src", name)).href);
const { prepareGoalFileScope } = await local("goal-file-effects.ts"), { contextSnapshot } = await local("goal-run-effects.ts");
const sdk = await import(pathToFileURL(path.join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
const agentDirectory = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE, ".pi/agent"), protections = { agentDirectory, journalDirectory: agentDirectory }, rows = [];
const cases = [["scout", "read"], ["worker", "read"], ["worker_strong", "read"], ["worker", "mutation"], ["scout", "mutation"]];
for (const [index, [profile, mode]] of cases.entries()) {
  const workRelative = `${relative}/probe-${index}`, work = path.resolve(workRelative); await fs.mkdir(work);
  await fs.writeFile(path.join(work, "query.sql"), "SELECT NULL WHERE 0;\n", { flag: "wx" }); await fs.writeFile(path.join(work, "TASK.md"), "Synthetic preflight data only; no model request.", { flag: "wx" });
  const profilePath = path.join(agentDirectory, "agents", profile + ".md"), { frontmatter, body } = sdk.parseFrontmatter(await fs.readFile(profilePath, "utf8"));
  const files = [{ path: workRelative + "/query.sql", access: mode === "mutation" ? "read_write" : "read" }, { path: workRelative + "/TASK.md", access: "read" }];
  const scope = await prepareGoalFileScope({ cwd: process.cwd(), files }, protections, AbortSignal.timeout(45000));
  const context = await contextSnapshot(process.cwd(), agentDirectory, profilePath, files, AbortSignal.timeout(45000)), slash = frontmatter.model.indexOf("/");
  const reply = await runOwnedDirect({ type: "direct_sdk_control", id: `probe-${index}`, runtimeRoot, cwd: process.cwd(), agentDirectory, scope, protections, context,
    model: { provider: frontmatter.model.slice(0, slash), id: frontmatter.model.slice(slash + 1) }, thinking: frontmatter.thinking, systemPrompt: body,
    prompt: "No prompt is sent in this preflight.", stageMode: mode, roleProfile: profile, preflightOnly: true }, { childFile: fileURLToPath(new URL("./phase-worker.mjs", import.meta.url)) });
  assert.equal(reply.sdkCalls, 0); assert.ok(reply.cleanupConfirmed && reply.childExitConfirmed && reply.disposed && reply.files.ioFinished);
  if (profile === "scout" && mode === "mutation") assert.equal(reply.status, "failed");
  else { assert.equal(reply.status, "offline_probe"); assert.deepEqual(reply.effectiveToolNames.sort(), mode === "read" ? ["scope_read"] : ["scope_edit", "scope_read", "scope_write"]); }
  assert.equal(await fs.readFile(path.join(work, "query.sql"), "utf8"), "SELECT NULL WHERE 0;\n");
  rows.push({ profile, mode, status: reply.status, tools: reply.effectiveToolNames, modelCalls: 0, cleanupConfirmed: true, queryUnchanged: true });
}
console.log(JSON.stringify({ kind: "multistage_role_permissions_preflight", rows, eligibilityChecksPassed: true, malformedReviewDoesNotTriggerRepair: true,
  workerCalls: 0, selectorCalls: 0, scoutMutationRejectedBeforeModel: true, existingProfilesChanged: false }, null, 2));

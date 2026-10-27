import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { prepareAutomatic } from "../src/automatic-effects.ts";

test("automatic preparation reads current approved code/state and ignores fixed profile model headers", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-auto-prepare-"))), cwd = path.join(root, "project"), agent = path.join(root, "agent");
  await mkdir(cwd); await mkdir(path.join(agent, "agents"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); });
  const content = 'export const input = "한글";\n'; await writeFile(path.join(cwd, "parser.ts"), content);
  await writeFile(path.join(agent, "agents", "worker.md"), "---\nname: worker\ndescription: Repair approved source.\ntools: read, edit\nmodel: unavailable/fixed-role-model\nthinking: max\n---\nPreserve the approved interface.\n");
  const available: Model<Api> = { provider: "available-provider", id: "actual-usable-model", name: "Usable fixture", api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => {
    assert.equal(options?.allowModelNetwork, false); assert.equal(options?.authPath, path.join(agent, "auth.json"));
    return { getAvailableSnapshot: () => [available] } as unknown as ModelRuntime;
  });
  const prepared = await prepareAutomatic({ task: "Repair the current parser.", files: [{ path: "parser.ts", access: "read_write" }],
    constraints: ["Preserve the interface."], observations: ["The current empty-token test fails."] }, { cwd } as ExtensionContext, t.signal);
  assert.deepEqual(prepared.role.tools, ["read", "edit"]); assert.equal("model" in prepared.role, false);
  assert.deepEqual(prepared.choices.map(choice => [choice.model.provider, choice.model.id, choice.thinking]), [["available-provider", "actual-usable-model", "off"]]);
  assert.deepEqual(prepared.routing.sources, [{ path: "parser.ts", content }]);
  assert.deepEqual(prepared.routing.observations, ["The current empty-token test fails."]);
  assert.equal(prepared.context.some(item => item.path === path.join(agent, "agents", "worker.md")), true);
});

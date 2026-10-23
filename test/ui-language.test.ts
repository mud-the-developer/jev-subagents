import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("shipped source, comments and installer messages contain no fixed Hangul UI text", async () => {
  const files = [path.join(root, "scripts", "setup.ts"), path.join(root, "install.sh")];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile() && /\.(?:ts|js|py)$/.test(entry.name)) files.push(file);
    }
  }
  await collect(path.join(root, "src"));
  assert.ok(files.length > 40, "Check the actual shipped source, not an empty sample");
  for (const file of files) assert.doesNotMatch(await readFile(file, "utf8"), /\p{Script=Hangul}/u, path.relative(root, file));
});

test("browser source views preserve original data and retain English review predicates", async () => {
  const setup = await readFile(path.join(root, "src", "setup-desktop", "frontend.js"), "utf8");
  const review = await readFile(path.join(root, "src", "setup-desktop", "task-review.js"), "utf8");
  assert.match(setup, /el\('pre', profile\.content, 'source'\)/);
  assert.match(review, /el\('pre', section\.text, 'source'\)/);
  assert.match(review, /name === 'Permissions · limits'/);
  assert.match(review, /s\.verification\.startsWith\('Exact verification command'\)/);
  assert.match(review, /reviewed\.size !== 3 \|\| !riskCheck\?\.checked/);
});

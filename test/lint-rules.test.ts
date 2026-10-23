import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ESLint } from 'eslint';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const lint = new ESLint({ cwd });
async function rules(code: string, filePath: string) {
  const [result] = await lint.lintText(code, { filePath });
  assert.ok(result && !result.messages.some(message => message.fatal), 'Lint rule sample must parse and use project config');
  return result.messages.map(message => message.ruleId);
}

test('lint rejects dynamic execution and literal/computed HTML insertion, but permits parsed DOM node insertion', async () => {
  assert.ok((await rules('eval("1");', 'scripts/lint-sample.mjs')).includes('no-eval'));
  assert.ok((await rules('new Function("return 1");', 'scripts/lint-sample.mjs')).includes('no-new-func'));
  for (const source of ['window.innerHTML = "text";', 'window["outerHTML"] = "text";', 'document.write("text");']) {
    assert.ok((await rules(source, 'scripts/lint-sample.mjs')).includes('no-restricted-syntax'));
  }
  assert.deepEqual(await rules('document.body.replaceChildren(document.createElement("div"));', 'scripts/lint-sample.mjs'), []);
});

test('lint pure model guards reject clock/randomness/environment/runtime I/O, but not type imports or effect-owned time', async () => {
  for (const source of ['export function reduceSample(){ return Date.now(); }', 'export function reduceSample(){ return Math.random(); }',
    'export const value = process.env.HOME;', 'import { open } from "node:fs/promises"; export const value = open;']) {
    assert.ok((await rules(source, 'src/machine.ts')).includes('no-restricted-syntax'));
  }
  assert.deepEqual(await rules('import type { BigIntStats } from "node:fs"; export type Stats = BigIntStats;', 'src/machine.ts'), []);
  assert.deepEqual(await rules('export function timestamp(){ return Date.now(); }', 'src/goal-run-effects.ts'), []);
});

test('lint keeps typed floating-promise enforcement while allowing Node test registration and explicitly observed application work', async () => {
  assert.ok((await rules('Promise.resolve(1);', 'src/goal-run-effects.ts')).includes('@typescript-eslint/no-floating-promises'));
  assert.deepEqual(await rules('void Promise.resolve(1);', 'src/goal-run-effects.ts'), []);
  assert.deepEqual(await rules('import { test } from "node:test"; test("sample", () => {});', 'test/lint-rules.test.ts'), []);
  assert.ok((await rules('export async function task(){ return 1; } task();', 'test/lint-rules.test.ts')).includes('@typescript-eslint/no-floating-promises'));
});

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const domGuards = [
  { selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]", message: 'Parse/sanitize markup and insert DOM nodes; do not assign innerHTML/outerHTML.' },
  { selector: "AssignmentExpression[left.type='MemberExpression'][left.property.value=/^(innerHTML|outerHTML)$/]", message: 'Computed HTML assignment is also unsafe.' },
  { selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]", message: 'Do not execute HTML through document.write.' },
];
const pureGuards = [
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Pure model: inject time through reducer events.' },
  { selector: "NewExpression[callee.name='Date']", message: 'Pure model: do not read the clock.' },
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']", message: 'Pure model: inject random IDs through effects/events.' },
  { selector: "CallExpression[callee.name=/^(fetch|randomUUID|setTimeout|setInterval)$/]", message: 'Pure model: network/randomness/timers belong to effects.' },
  { selector: "MemberExpression[object.name='process'][property.name='env']", message: 'Pure model: inject environment-derived data.' },
  { selector: "ImportDeclaration[source.value=/^node:(fs|fs\\/promises|child_process|http|https|net|timers)$/]:not([importKind='type'])", message: 'Pure model: runtime I/O imports belong in effect modules; type-only imports are allowed.' },
];
export default [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'test/fixtures/**', 'benchmarks/**', 'docs/figures/**'] },
  { ...js.configs.recommended, files: ['**/*.ts', '**/*.mjs'], languageOptions: { ecmaVersion: 2023, sourceType: 'module',
    globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', fetch: 'readonly', URL: 'readonly', AbortController: 'readonly',
      setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
      document: 'readonly', window: 'readonly', DOMParser: 'readonly', XMLSerializer: 'readonly' } },
    rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error', 'no-script-url': 'error',
      'eqeqeq': ['error', 'smart'], 'no-restricted-syntax': ['error', ...domGuards] } },
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { '@typescript-eslint': tseslint.plugin }, rules: {
      // TypeScript strict checking owns unresolved identifiers; base rules cannot interpret type scopes.
      'no-undef': 'off', 'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true, ignoreIIFE: false,
        // node:test owns registration Promises; application Promises still require observation.
        allowForKnownSafeCalls: [{ from: 'file', name: 'test', path: 'node_modules/@types/node/test.d.ts' }],
      }],
    } },
  { files: ['src/task-tree.ts', 'src/task-tree-protocol.ts', 'src/task-tree-view.ts', 'src/worker-budget.ts', 'src/worker-rounds.ts', 'src/doctor.ts', 'src/basic-execution.ts', 'src/approval-ui-diagnostics.ts', 'src/ui-probe.ts', 'src/internal-language.ts', 'src/skill-suggestion.ts', 'src/gpu-laya.ts', 'src/jev-backend.ts', 'src/session-setup.ts', 'src/machine.ts', 'src/decision.ts', 'src/goal-machine.ts', 'src/goal-run.ts', 'src/goal-files.ts', 'src/goal-sequence.ts',
      'src/context-control.ts', 'src/context-memory.ts'],
    rules: { 'no-restricted-syntax': ['error', ...domGuards, ...pureGuards] } },
];

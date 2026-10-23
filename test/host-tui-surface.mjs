// Explicit installed-host probe: node test/host-tui-surface.mjs /absolute/path/to/host-sdk [receipt.json]
// Real loader, renderer and native dialog methods; synthetic terminal input is NOT physical user acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

const hostRoot = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'An explicit installed host SDK path is required');
const repo = fileURLToPath(new URL('../', import.meta.url));
const receiptPath = process.argv[3] && path.resolve(process.argv[3]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-tui-surface-'));
const agentDir = path.join(root, 'account');
const keep = new Set(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, { HOME: agentDir, USERPROFILE: agentDir, PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NODE_DISABLE_COMPILE_CACHE: '1' });
let fetches = 0, loaded, screen;
globalThis.fetch = async () => { fetches++; throw new Error('Network is forbidden in this probe'); };
const originalNow = Date.now;
try {
  await fs.mkdir(agentDir);
  const standalone = path.join(root, 'standalone');
  await fs.cp(path.join(repo, 'test/fixtures/sol-pi/src/sol-pi'), path.join(standalone, 'src/sol-pi'), { recursive: true });
  const modules = path.dirname(path.dirname(hostRoot));
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox']) {
    const destination = path.join(standalone, 'node_modules', name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.symlink(path.join(modules, name), destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await fs.writeFile(path.join(agentDir, 'sol-pi.json'), JSON.stringify({ version: 1, actionFusion: true }));
  const configBefore = await fs.readFile(path.join(agentDir, 'sol-pi.json'), 'utf8');
  const sdk = await import(pathToFileURL(path.join(hostRoot, 'dist/index.js')).href);
  const tui = await import(pathToFileURL(path.join(modules, '@earendil-works/pi-tui/dist/index.js')).href);
  const { InteractiveMode } = await import(pathToFileURL(path.join(hostRoot, 'dist/modes/interactive/interactive-mode.js')).href);
  const { ProgramStatusReporter } = await import(pathToFileURL(path.join(hostRoot, 'dist/modes/interactive/program-status-reporter.js')).href);
  const { KeybindingsManager } = await import(pathToFileURL(path.join(hostRoot, 'dist/core/keybindings.js')).href);
  const theme = await import(pathToFileURL(path.join(hostRoot, 'dist/modes/interactive/theme/theme.js')).href);
  const { CustomEditor } = await import(pathToFileURL(path.join(hostRoot, 'dist/modes/interactive/components/custom-editor.js')).href);
  const pinned = await import(pathToFileURL(path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
  assert.equal(sdk.VERSION, '1.2.0'); assert.equal(pinned.VERSION, '0.85.1');
  pinned.initTheme('dark', false);
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [path.join(repo, 'src/index.ts'), path.join(standalone, 'src/sol-pi/index.ts')] });
  await loader.reload(); loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 2);
  const jev = loaded.extensions.find(entry => entry.path === path.join(repo, 'src/index.ts')) ?? loaded.extensions[0];
  const sol = loaded.extensions.find(entry => entry !== jev);
  const ctx = { cwd: root, mode: 'tui', hasUI: false, isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => 'synthetic-tui-surface' } };
  for (const handler of sol.handlers.get('session_start') ?? []) { await handler({ type: 'session_start' }, ctx); await handler({ type: 'session_start' }, ctx); }
  assert.deepEqual([...jev.tools.keys()], ['jev_route', 'jev_decide', 'jev_delegate', 'jev_memory']);
  assert.deepEqual([...sol.tools.keys()].sort(), ['edit', 'write']);
  const names = loaded.extensions.flatMap(entry => [...entry.tools.keys()]); assert.equal(new Set(names).size, names.length);
  const delegate = jev.tools.get('jev_delegate').definition;
  await assert.rejects(delegate.execute('removed', { task: 'Synthetic only.', agents: ['scout'], solPi: {} }, undefined, undefined, ctx), /not available/);
  assert.equal(await fs.readFile(path.join(agentDir, 'sol-pi.json'), 'utf8'), configBefore);
  const metadataBytes = Object.fromEntries([...jev.tools.values()].map(({ definition: { name, description, promptSnippet, promptGuidelines } }) =>
    [name, Buffer.byteLength(JSON.stringify({ name, description, promptSnippet, promptGuidelines }))]));
  for (const [name, bytes] of Object.entries(metadataBytes)) assert.ok(bytes <= ({ jev_route: 450, jev_decide: 1300, jev_delegate: 2300, jev_memory: 700 }[name]));
  let input = () => {}, frames = '', columns = 80;
  const terminal = { get columns() { return columns; }, rows: 30, kittyProtocolActive: false,
    start(handler) { input = handler; }, stop() {}, drainInput: async () => {}, write(value) { frames += value; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
  screen = new tui.TuiMainScreen(terminal, false, agentDir);
  const keys = KeybindingsManager.create(); tui.setKeybindings(keys);
  const mode = Object.create(InteractiveMode.prototype);
  const editor = new CustomEditor(screen, theme.getEditorTheme(), keys, { paddingX: 0, autocompleteMaxVisible: 5 });
  Object.assign(mode, { ui: screen, editor, editorContainer: new tui.Container(), keybindings: keys,
    programStatus: new ProgramStatusReporter(() => terminal, () => 'Synthetic only') });
  mode.editorContainer.addChild(editor); screen.addChild(mode.editorContainer); screen.start();
  const { confirmNativeTaskReview } = await import(new URL('../src/native-task-review.ts', import.meta.url));
  const controller = new AbortController(), diagnostics = [];
  const reviewCtx = { ...ctx, hasUI: true, ui: {
    select: mode.showExtensionSelector.bind(mode), confirm: mode.showExtensionConfirm.bind(mode), custom: mode.showExtensionCustom.bind(mode),
  } };
  const content = { summary: { task: 'Synthetic review only; no execution.', role: 'diagnostic', model: 'offline/none', thinking: 'off',
    cwd: root, tools: ['read'], maxModelCalls: 1, seconds: 86_400, verification: 'No model or worker execution.' }, risks: ['Synthetic input is not human execution authorization.'],
    sections: ['task', 'profile', 'snapshot'].map(id => ({ id, title: id, text: `SYNTHETIC ${id}: no secrets, tools or execution.\nExact second line: "two words".` })), packet: '{"diagnosticOnly":true}' };
  let settled = false;
  const work = confirmNativeTaskReview(content, reviewCtx, controller.signal, value => { diagnostics.push(value); }).then(value => { settled = true; return value; });
  const ready = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await nextTurn(); } assert.fail('Native view did not become ready'); };
  await ready(() => !!mode.extensionSelector); assert.equal(mode.extensionSelector.countdown, undefined);
  assert.ok(mode.extensionSelector.render(80).join('\n').includes('24h (86400s)'));
  const later = originalNow() + 86400000; Date.now = () => later;
  await nextTurn(); assert.equal(settled, false); input('\r');
  await ready(() => !mode.extensionSelector && mode.editorContainer.children[0] !== editor);
  for (const width of [48, 80, 120]) { columns = width; assert.ok(mode.editorContainer.render(width).length); screen.requestRender(true); await nextTurn(); }
  input('\r'); await ready(() => !!mode.extensionSelector); assert.equal(mode.extensionSelector.countdown, undefined);
  input('\r'); await ready(() => mode.extensionSelector?.options?.[0] === 'Yes'); assert.equal(mode.extensionSelector.countdown, undefined);
  input('\r'); assert.equal(await work, true);
  const cancel = new AbortController(), denied = confirmNativeTaskReview(content, reviewCtx, cancel.signal);
  await ready(() => !!mode.extensionSelector); cancel.abort(); assert.equal(await denied, false);
  const { executeProjectMemory, projectMemoryIO } = await import(new URL('../src/project-memory-effects.ts', import.meta.url));
  const { memoryProjectKey, memoryDigest } = await import(new URL('../src/project-memory.ts', import.meta.url));
  const memoryState = { version: 1, projectKey: memoryProjectKey(root), revision: 1, facts: [{ id: 'fact_a', kind: 'decision', title: 'Synthetic public title', content: 'SYNTHETIC_READONLY_MEMORY', provenance: 'Fixture parent review only.', createdRevision: 1 }], edges: [] };
  const memoryDirectory = path.join(path.dirname(root), path.basename(root) + '-memory-not-created');
  const memoryIO = { ...projectMemoryIO, canonical: async () => root, identity: async () => 'fixture-project-identity',
    read: async () => ({ state: structuredClone(memoryState), directory: memoryDirectory, token: memoryDigest(memoryState) }) };
  const memoryWork = executeProjectMemory({ operation: 'snapshot', directory: memoryDirectory, expectedRevision: 1, ids: ['fact_a'] }, reviewCtx, controller.signal, memoryIO);
  await ready(() => mode.editorContainer.children[0] !== editor);
  const findSource = component => typeof component.getExpandedText === 'function' ? component : (component.children ?? []).map(findSource).find(Boolean);
  assert.ok(findSource(mode.editorContainer)?.getExpandedText().includes('SYNTHETIC_READONLY_MEMORY'));
  input('\r'); const memoryResult = await memoryWork;
  assert.equal(memoryResult.status, 'snapshot'); assert.equal(memoryResult.snapshot.records[0].content, 'SYNTHETIC_READONLY_MEMORY');
  const { renderPlan } = await import(new URL('../src/plan-presentation.ts', import.meta.url));
  const plan = { phase: 'running', elapsedMs: 72000, seconds: 86400, modelCalls: 8, currentTool: 'scope_edit', nodes: [
    { id: 'inspect', title: 'Inspect the approved source', after: [], state: 'completed', agent: 'scout', model: 'offline/scout', thinking: 'low' },
    { id: 'implement', title: 'Implement one reviewed alternative', after: ['inspect'], state: 'running', agent: 'worker', model: 'offline/worker', thinking: 'low',
      alternatives: [{ id: 'keep_api', title: 'Keep the public API', selected: false }, { id: 'replace_parser', title: 'Use the bounded parser', selected: true }] },
    { id: 'review', title: 'Review the approved edit', after: ['implement'], state: 'waiting' } ] };
  const card = { render: width => renderPlan(plan, width, theme.theme, true), invalidate() {} };
  screen.addChild(card);
  for (const width of [48, 80, 120]) { columns = width; assert.ok(card.render(width).length); screen.requestRender(true); await nextTurn(); }
  assert.ok(frames.includes('JEV / EXECUTION PLAN')); assert.ok(frames.includes('SELECTED'));
  const dag = { version: 2, entry: 'route', phase: 'running', elapsedMs: 72000, seconds: 86400, modelCalls: 8, currentTool: 'scope_edit', nodes: [
    { id: 'review', kind: 'task', title: 'Review the edit', after: ['merge'], state: 'waiting' },
    { id: 'merge', kind: 'join', title: 'Merge the selected path', after: ['a2', 'b1'], state: 'waiting' },
    { id: 'route', kind: 'choice', title: 'Choose the reviewed route', after: [], state: 'chosen', chosenChoiceId: 'b', alternatives: [{ id: 'a', title: 'Long route', selected: false }, { id: 'b', title: 'Short route', selected: true }] },
    { id: 'a2', kind: 'task', title: 'Second long-path task', after: ['a1'], state: 'skipped' },
    { id: 'a1', kind: 'task', title: 'First long-path task', after: ['route'], state: 'skipped' },
    { id: 'b1', kind: 'task', title: 'Selected edit', after: ['route'], state: 'running', agent: 'worker', model: 'offline/worker', thinking: 'low' } ],
    edges: [{ from: 'route', to: 'a1', when: 'a', status: 'inactive' }, { from: 'route', to: 'b1', when: 'b', status: 'active' },
      { from: 'a1', to: 'a2', status: 'inactive' }, { from: 'a2', to: 'merge', status: 'inactive' }, { from: 'b1', to: 'merge', status: 'active' }, { from: 'merge', to: 'review', status: 'active' }] };
  const graphCard = { render: width => renderPlan(dag, width, theme.theme, true), invalidate() {} };
  screen.addChild(graphCard);
  for (const width of [48, 80, 120]) { columns = width; assert.ok(graphCard.render(width).length); screen.requestRender(true); await nextTurn(); }
  assert.ok(frames.includes('DAG v2')); assert.ok(frames.includes('SKIPPED')); assert.ok(frames.includes('JOIN'));
  assert.ok(frames.length > 0); assert.equal(fetches, 0);
  const receipt = { kind: 'fresh_installed_host_ordinary_surface_and_standalone_sol_pi', hostSdk: sdk.VERSION, workerSdk: pinned.VERSION,
    jevTools: [...jev.tools.keys()], standaloneTools: [...sol.tools.keys()], duplicateTools: false, standaloneConfigUnchanged: true,
    retiredSolPiInputRejected: true, metadataBytes, nativeUi: { methods: 'InteractiveMode', renderer: 'TuiMainScreen', syntheticTerminal: true,
      delayedReviewApproved: true, readableApprovedSeconds: 86_400, literalMultilineSources: true,
      planCard: { language: 'English', stages: 3, selectedBranch: 'replace_parser', observedSdkCalls: 8, syntheticOnly: true },
      graphCard: { version: 2, nodes: 6, links: 6, selectedChoice: 'b', skippedNodes: 2, conditionalLinksAndJoinVisible: true, syntheticOnly: true },
      memorySnapshot: { exactNativeSourceApproved: true, originalDataPreserved: true, sqliteFilesOpened: 0, jevRequests: 0, syntheticOnly: true }, countdownTimersAbsent: true, resizeWidths: [48, 80, 120], abortDenied: true, frameBytes: Buffer.byteLength(frames),
      remainingMs: diagnostics.at(-1)?.remainingMs }, networkRequests: fetches, workerInvocations: 0,
    limitations: ['Not the running cached extension or physical terminal', 'Standalone fixture only; no live provider or compaction inference'] };
  if (receiptPath) await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  Date.now = originalNow; screen?.stop(); loaded?.runtime.invalidate(); await fs.rm(root, { recursive: true, force: true });
}

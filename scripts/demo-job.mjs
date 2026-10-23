// One isolated OFFLINE scope job, not three candidates for a single worker and not a live-provider approval.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import childProcess from 'node:child_process';

const output = process.argv[2] && path.resolve(process.argv[2]);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jev-three-role-demo-')));
const cwd = path.join(root, 'project'), agentDir = path.join(root, 'agent'), sample = path.join(cwd, 'sample.txt');
const keep = new Set(['PATH', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
Object.assign(process.env, { HOME: agentDir, USERPROFILE: agentDir, PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NODE_DISABLE_COMPILE_CACHE: '1' });
const agents = ['scout', 'worker', 'worker_strong'];
const models = agents.map(name => `demo-${name}`);
const tasks = [
  { id: 'inspect', agent: 'scout', summary: 'Read file-1 once with scope_read and report whether it contains BEFORE. Do not edit.' },
  { id: 'change', agent: 'worker', summary: 'Change BEFORE to AFTER in file-1 with scope_edit, then report the exact edit. Do not touch other files.' },
  { id: 'review', agent: 'worker_strong', summary: 'Read file-1 once with scope_read, verify AFTER is present, and report the remaining uncertainty. Do not edit.' },
];
const messages = ['Observed BEFORE in the approved sample. No edits or tests.', 'Changed BEFORE to AFTER in file-1. No other files changed.',
  'Reviewed AFTER in the approved sample. No edits; general task acceptance and real-provider behavior remain unverified.'];
const counts = new Map(models.map(model => [model, 0])), order = [], feedback = [], launchOrder = [], packets = [];
let approvals = 0, inFlight = 0, peak = 0, cleanupConfirmed = false, result;
const before = 'BEFORE\n', after = 'AFTER\n', sentinel = 'UNAPPROVED_SIBLING_UNCHANGED\n';
const controller = new AbortController();
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), index = models.indexOf(body.model);
    assert.ok(index >= 0, 'Only the three declared fixture models may run');
    const turn = counts.get(body.model) + 1; counts.set(body.model, turn); order.push(agents[index]);
    assert.ok(turn <= 2, 'No retry or extra model turn');
    const tools = body.tools.map(tool => tool.function.name).sort();
    assert.deepEqual(tools, index === 1 ? ['scope_edit', 'scope_read'] : ['scope_read']);
    const expectedText = index === 2 ? after : before;
    if (turn === 1) assert.equal(await fs.readFile(sample, 'utf8'), expectedText, 'Each task sees the previous settled file version');
    if (turn === 2 && index !== 1) {
      const replies = body.messages.filter(message => message.role === 'tool');
      assert.ok(replies.some(message => JSON.stringify(message.content).includes(expectedText.trim())), 'Read feedback reaches the correct model');
      feedback.push(agents[index]);
    }
    const tool = index === 1 ? 'scope_edit' : 'scope_read';
    const args = index === 1 ? { fileId: 'file-1', oldText: 'BEFORE', newText: 'AFTER' } : { fileId: 'file-1' };
    const delta = turn === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: `demo-${index}`, type: 'function',
      function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: messages[index] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: `demo-${index}-${turn}`, object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) { res.destroy(error); controller.abort(); }
});
const fork = childProcess.fork, workerExecutables = [];
childProcess.fork = (...args) => {
  assert.match(path.basename(args[2]?.execPath ?? '').toLowerCase(), /^bun(?:\.exe)?$/);
  assert.equal(args[2]?.serialization, 'json'); assert.ok(args[2]?.execArgv?.some(arg => arg.startsWith('--config=')));
  workerExecutables.push(path.basename(args[2].execPath));
  const child = fork(...args); inFlight++; peak = Math.max(peak, inFlight);
  child.once('close', () => { inFlight--; });
  const send = child.send.bind(child);
  child.send = (message, ...rest) => {
    if (message?.run) {
      launchOrder.push(message.run.agent.name); packets.push(message);
      assert.equal(approvals, 1, 'No task starts before the sole scope approval');
      assert.equal(message.run.model.id, models[agents.indexOf(message.run.agent.name)]);
      assert.deepEqual(message.scope.input.tasks, tasks); assert.equal(message.scope.approvalDeadline, null);
      assert.equal(message.run.seconds, 600); assert.equal(message.deadline - message.approvedAt, 600000);
      assert.equal(message.run.maxModelCalls, null, 'SDK-native mode must not inject a predicted or default count limit');
    }
    return send(message, ...rest);
  };
  return child;
};
try {
  await fs.mkdir(cwd); await fs.mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await fs.writeFile(sample, before); await fs.writeFile(path.join(cwd, 'unapproved.txt'), sentinel);
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Only use declared file IDs. Do not read or modify unapproved siblings. Report in English.\n');
  for (const [index, name] of agents.entries()) await fs.writeFile(path.join(agentDir, 'agents', `${name}.md`),
    `---\nname: ${name}\ndescription: ${index === 1 ? 'Edit the single approved sample.' : 'Read and inspect the single approved sample.'}\nmodel: demo/${models[index]}\ntools: ${index === 1 ? 'read, edit' : 'read'}\n---\nPerform only the approved task with supplied file-ID tools. Do not claim independent verification.\n`);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { demo: {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'anonymous-loopback-fixture',
    models: models.map(id => ({ id, reasoning: false, contextWindow: 65536, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  const { registerJevTools } = await import('../src/index.ts');
  const tools = [];
  registerJevTools({ on() {}, registerTool(tool) { tools.push(tool); } });
  assert.deepEqual(tools.map(tool => tool.name), ['jev_route', 'jev_decide', 'jev_delegate', 'jev_memory']);
  const delegate = tools.find(tool => tool.name === 'jev_delegate');
  const scope = { task: 'Inspect, edit and review only the approved demonstration sample.', agents,
    files: [{ path: 'sample.txt', access: 'read_write' }], tasks, selection: 'parent_only',
    limits: { workerRuns: 3, seconds: 600 } };
  const ctx = { cwd, mode: 'rpc', hasUI: true, sessionManager: { getSessionId: () => 'offline-three-role-demo', getBranch: () => [] }, ui: {
    confirm: async (_title, packet, options) => {
      approvals++; assert.equal(approvals, 1); assert.equal(order.length, 0); assert.equal(launchOrder.length, 0);
      assert.ok(packet.includes('Exact plan execution approval')); assert.ok(packet.includes('file-1 · sample.txt'));
      for (const task of tasks) assert.ok(packet.includes(task.summary));
      for (const model of models) assert.ok(packet.includes(model));
      assert.ok(packet.includes('10m (600s)')); assert.ok(!packet.trimStart().startsWith('{'));
      assert.equal(options?.timeout, undefined);
      assert.equal(packet.includes('anonymous-loopback-fixture'), false);
      console.log('[demo] One synthetic exact scope confirmation; this is not live human execution authorization.');
      return true;
    },
  } };
  console.log('[demo] Isolated disposable workspace; real owned SDK workers; anonymous loopback model fixture.');
  const started = Date.now();
  const response = await delegate.execute('offline-three-role-demo', { scope }, controller.signal,
    update => { if (update.details?.phase) console.log(`[demo] ${update.details.phase}`); }, ctx);
  result = response.details;
  cleanupConfirmed = result.cleanupConfirmed && !result.lockRetained;
  assert.equal(result.status, 'completed_unverified', JSON.stringify({ reason: result.reason, diagnostic: result.diagnostic }));
  assert.equal(cleanupConfirmed, true); assert.equal(approvals, 1); assert.equal(result.workersStarted, 3);
  assert.equal(result.modelCalls, 6); assert.equal(result.reservedModelCalls, 0); assert.equal(result.jevRequests, 0);
  assert.deepEqual(launchOrder, agents); assert.deepEqual(order, agents.flatMap(name => [name, name]));
  assert.deepEqual(feedback, ['scout', 'worker_strong']); assert.deepEqual(result.reports.map(report => report.agent), agents);
  assert.deepEqual(result.reports.map(report => report.text), messages);
  assert.equal(new Set(packets.map(packet => packet.scope.id)).size, 1); assert.equal(new Set(packets.map(packet => packet.digest)).size, 1);
  assert.equal(new Set(packets.map(packet => packet.deadline)).size, 1); assert.equal(new Set(packets.map(packet => packet.approvedAt)).size, 1);
  assert.equal(await fs.readFile(sample, 'utf8'), after); assert.equal(await fs.readFile(path.join(cwd, 'unapproved.txt'), 'utf8'), sentinel);
  assert.equal(inFlight, 0); assert.equal(peak, 1); await assert.rejects(fs.access(path.join(cwd, '.jev-goal.lock')), { code: 'ENOENT' });
  const receipt = { kind: 'offline_three_profile_single_scope_demo', parentRuntime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`,
    workerExecutables, modelBackend: 'anonymous literal loopback HTTP/SSE fixture',
    liveProviders: false, syntheticApproval: true, humanApprovalFormat: 'readable_exact_sources', approvedSeconds: scope.limits.seconds, approvals, declaredTasks: tasks.map(({ id, agent }) => ({ id, agent })),
    launchedAgents: launchOrder, resolvedModels: packets.map(packet => packet.run.model), workerProcesses: result.workersStarted,
    peakConcurrentWorkers: peak, modelCalls: result.modelCalls, modelCallPolicy: 'sdk_native', maxSharedModelCalls: null,
    reservedModelCalls: result.reservedModelCalls, jevRequests: result.jevRequests, oneScopeAndDeadline: true,
    fileAfter: after.trim(), unapprovedSiblingUnchanged: true, reports: result.reports, taskAcceptance: result.taskAcceptance,
    cleanupConfirmed, lockRetained: result.lockRetained, allChildrenClosed: inFlight === 0, elapsedMs: Date.now() - started,
    userSourceProfilesPermissionsOrSettingsChanged: false,
    limitations: ['Fixture models and synthetic confirmation, not actual Luna/Astra inference or physical TUI', 'Pinned tasks demonstrate sequential execution, not model ranking or parallel work'] };
  if (output) await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  childProcess.fork = fork; controller.abort(); server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  if (cleanupConfirmed || launchOrder.length === 0) await fs.rm(root, { recursive: true, force: true });
  else console.error(`[demo] Unconfirmed work retained for inspection; no rollback/retry: ${root}`);
}

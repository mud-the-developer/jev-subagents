import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { beforeEach, test, type TestContext } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveJevConnection, readJevConnection, describeJevTarget, stripJevEnvironment, validateJevEndpoint } from '../src/jev-config.ts';
import { route, requestJev } from '../src/effects.ts';
import { decide } from '../src/decision.ts';
import { executeEffect as delegateEffect } from '../src/delegate-effects.ts';
import { estimateCost, initialState } from '../src/delegate-machine.ts';
import { estimateJevUsd } from '../src/choice.ts';
import { JEV_MODEL } from '../src/machine.ts';

const nativeFetch = globalThis.fetch;
const envKeys = ['JEV_BACKEND', 'OPENJEV_BASE_URL', 'OPENJEV_MODEL', 'OPENJEV_API_KEY', 'TYPESAFE_API_KEY'] as const;
const request = { task: 'Explicit non-sensitive offline task', agents: [{ name: 'a', description: 'First supplied role' }, { name: 'b', description: 'Second supplied role' }] };
const choice = { type: 'choice', choice: 'a', confidence: 0.19, probabilities: { a: 0.75, b: 0.25 } };
const response = (key = 'agent') => ({ model: 'openjev-0.1', usage: { input_tokens: 31, output_tokens: 0 }, answers: { [key]: choice } });

beforeEach(t => {
  assert.ok('mock' in t);
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  process.env.TYPESAFE_API_KEY = 'offline-typesafe-key';
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('External HTTP is forbidden in offline tests'); });
  t.after(() => { for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
});
async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  process.env.JEV_BACKEND = 'openjev'; process.env.OPENJEV_BASE_URL = base;
  let receivedHeaders: () => void = () => {};
  const headers = new Promise<void>(resolve => { receivedHeaders = resolve; });
  const http = t.mock.method(globalThis, 'fetch', async (...[url, init]: Parameters<typeof fetch>) => {
    assert.equal(url, `${base}/v1/systemone`); assert.equal(init?.redirect, 'error');
    const reply = await nativeFetch(url, init); receivedHeaders(); return reply;
  });
  return { base, http, headers };
}

test('backend selection preserves pinned TypeSafe default and never reuses its credential for remote OpenJEV', () => {
  const legacy = resolveJevConnection({ TYPESAFE_API_KEY: 'fixture-legacy', OPENJEV_BASE_URL: 'https://evil.invalid' });
  assert.ok(legacy.ok); assert.equal(legacy.connection.model, JEV_MODEL); assert.equal(legacy.connection.endpoint, 'https://api.typesafe.ai/v1/systemone');
  const missing = resolveJevConnection({ JEV_BACKEND: 'openjev', OPENJEV_BASE_URL: 'https://api.codiv.ai', TYPESAFE_API_KEY: 'fixture-legacy' });
  assert.equal(missing.ok, false);
  const open = resolveJevConnection({ JEV_BACKEND: 'openjev', OPENJEV_BASE_URL: 'https://api.codiv.ai', OPENJEV_API_KEY: 'fixture-open-key' });
  assert.ok(open.ok); assert.equal(open.connection.model, 'openjev-0.1'); assert.equal(open.connection.apiKey, 'fixture-open-key');
  assert.ok(!describeJevTarget(open.connection).includes('fixture-open-key'));
});

test('origin allowlist rejects unsafe destination shapes, unknown backends, header injection and unsupported pinned model without echo', async t => {
  for (const base of ['http://evil.invalid', 'https://evil.invalid', 'http://localhost:8080', 'http://169.254.169.254', 'ftp://127.0.0.1',
    'https://private-name:private-password@api.codiv.ai', 'https://api.codiv.ai/?private-token=1', 'https://api.codiv.ai/#private-fragment', 'https://api.codiv.ai/v1']) {
    const result = resolveJevConnection({ JEV_BACKEND: 'openjev', OPENJEV_BASE_URL: base, OPENJEV_API_KEY: 'fixture-open-key' });
    assert.equal(result.ok, false, base); assert.ok(!JSON.stringify(result).includes('private-'));
  }
  for (const env of [{ JEV_BACKEND: 'unknown' }, { JEV_BACKEND: 'openjev', OPENJEV_BASE_URL: 'http://127.0.0.1:8080', OPENJEV_MODEL: JEV_MODEL },
    { JEV_BACKEND: 'openjev', OPENJEV_BASE_URL: 'http://127.0.0.1:8080', OPENJEV_API_KEY: 'private\r\ncredential' }]) assert.equal(resolveJevConnection(env).ok, false);
  assert.throws(() => validateJevEndpoint({ backend: 'openjev', endpoint: 'https://evil.invalid/v1/systemone', model: 'openjev-0.1' }), /not allowlisted/);
  process.env.JEV_BACKEND = 'invalid'; const http = t.mock.method(globalThis, 'fetch');
  assert.equal((await route(request)).status, 'failed'); assert.equal(http.mock.callCount(), 0);
});

test('native OpenJEV loopback sends the exact compatible packet anonymously and preserves canonical model, usage and provenance', { timeout: 5000 }, async t => {
  let packet: unknown, authorization: string | undefined;
  const { http } = await fixture(t, (req, res) => {
    assert.equal(req.url, '/v1/systemone'); authorization = req.headers.authorization;
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { packet = JSON.parse(Buffer.concat(chunks).toString('utf8')); res.end(JSON.stringify(response())); });
  });
  const state = await route(request); assert.equal(state.status, 'succeeded');
  if (state.status !== 'succeeded' || state.decision.source === 'baseline') return assert.fail('Expected validated OpenJEV result');
  assert.equal(state.decision.provider, 'openjev'); assert.equal(state.decision.model, 'openjev-0.1'); assert.equal(state.decision.requestedModel, 'openjev-0.1');
  assert.deepEqual(state.decision.usage, { inputTokens: 31, outputTokens: 0 }); assert.equal(authorization, undefined);
  assert.equal(http.mock.callCount(), 1); assert.ok(!JSON.stringify(packet).includes('fixture-legacy'));
  assert.ok(packet && typeof packet === 'object'); assert.deepEqual(Object.keys(packet).sort(), ['model', 'questions', 'state']);
});

test('OpenJEV named model and own Bearer key are honored, returned model is not replaced with the request alias', { timeout: 5000 }, async t => {
  let authorization: string | undefined, packet: { model: string } | undefined;
  const { http } = await fixture(t, (req, res) => {
    authorization = req.headers.authorization; const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      packet = JSON.parse(Buffer.concat(chunks).toString('utf8')); res.end(JSON.stringify(response()));
    });
  });
  process.env.OPENJEV_MODEL = 'openjev-latest'; process.env.OPENJEV_API_KEY = 'offline-openjev-key';
  const state = await route(request); assert.equal(state.status, 'succeeded');
  if (state.status !== 'succeeded' || state.decision.source === 'baseline') return assert.fail();
  assert.equal(packet?.model, 'openjev-latest'); assert.equal(state.decision.model, 'openjev-0.1'); assert.equal(state.decision.requestedModel, 'openjev-latest');
  assert.equal(authorization, 'Bearer offline-openjev-key'); assert.equal(http.mock.callCount(), 1);
  assert.ok(!JSON.stringify(state).includes('offline-openjev-key'));
});

test('ordinary option advice uses OpenJEV without relaxing mandatory human approval or probability threshold', { timeout: 5000 }, async t => {
  const { http } = await fixture(t, (_req, res) => res.end(JSON.stringify(response('option'))));
  const input = { question: 'Select an ordinary option', context: 'Only the supplied fixture facts', options: request.agents.map(a => ({ id: a.name, title: a.name, description: a.description })), requiresHuman: false };
  const state = await decide(input); assert.equal(state.status, 'recommended');
  if (state.status === 'recommended') { assert.equal(state.reply.provider, 'openjev'); assert.equal(state.reply.choice, 'a'); }
  const human = await decide({ ...input, requiresHuman: true }); assert.equal(human.status, 'needs_user'); assert.equal(http.mock.callCount(), 1);
});

test('OpenJEV retains redirects, body size, malformed probability and overload rejection with no retries or TypeSafe fallback', { timeout: 5000 }, async t => {
  for (const mode of ['redirect', 'oversized', 'bad-probabilities', 'overloaded', 'model-mismatch'] as const) {
    const { http } = await fixture(t, (_req, res) => {
      if (mode === 'redirect') { res.writeHead(307, { Location: 'https://api.typesafe.ai/v1/systemone' }); res.end(); }
      else if (mode === 'overloaded') { res.writeHead(529); res.end('private-body offline-openjev-key'); }
      else if (mode === 'oversized') res.end(JSON.stringify(response()) + ' '.repeat(65537));
      else if (mode === 'model-mismatch') res.end(JSON.stringify({ ...response(), model: 'verdict-1.4' }));
      else res.end(JSON.stringify({ ...response(), answers: { agent: { ...choice, probabilities: { a: 0.75, b: 0.4 } } } }));
    });
    const state = await route({ ...request, softRouting: { baseline: 'b' } }); assert.equal(state.status, 'failed', mode);
    assert.equal(http.mock.callCount(), 1); assert.ok(!JSON.stringify(state).includes('private-body')); assert.ok(!JSON.stringify(state).includes('offline-openjev-key'));
    http.mock.restore();
  }
});

test('OpenJEV cancellation and the same ten-second deadline abort stalled bodies without extra requests', { timeout: 5000 }, async t => {
  const pre = new AbortController(); pre.abort(); assert.deepEqual(await requestJev('fixture', {}, pre.signal), { type: 'cancel' });
  for (const timedOut of [false, true]) {
    const controller = new AbortController();
    const timer = timedOut ? t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 10000); return controller.signal; }) : undefined;
    const { http, headers } = await fixture(t, (_req, res) => { res.writeHead(200); res.write('{"model":"private-response-marker'); });
    const pending = route(request, timedOut ? undefined : controller.signal); await headers; controller.abort();
    const state = await pending; assert.equal(state.status, timedOut ? 'failed' : 'cancelled');
    assert.equal(http.mock.callCount(), 1); assert.ok(!JSON.stringify(state).includes('private-response-marker'));
    http.mock.restore(); timer?.mock.restore();
  }
});

test('completion approval names the selected OpenJEV destination and a changed provider or key stops transmission', { timeout: 5000 }, async t => {
  const { http } = await fixture(t, (_req, res) => res.end(JSON.stringify({ model: 'openjev-0.1', usage: { input_tokens: 22, output_tokens: 0 },
    answers: { criterion_0: { type: 'choice', choice: 'met', confidence: 0.4, probabilities: { met: 0.8, unmet: 0.1, unknown: 0.1 } } } })));
  const config = readJevConnection(); assert.ok(config.ok);
  const packet = { task: 'Approved fixture task', criteria: ['Fixture criterion'], workerClaim: 'Bounded fixture claim', verification: { description: 'Offline declared fixture check', status: 'passed' as const } };
  let title = '', prompt = '';
  const ctx = { hasUI: true, ui: { confirm: async (heading: string, text: string) => { title = heading; prompt = text; return true; } } } as unknown as ExtensionContext;
  const approved = await delegateEffect({ type: 'confirm_assessment', packet }, ctx, undefined, undefined, config.connection);
  assert.equal(approved.type, 'assessment_approval'); assert.match(title, /OpenJEV/); assert.ok(prompt.includes(config.connection.endpoint)); assert.ok(!prompt.includes('offline-typesafe-key'));
  const assessed = await delegateEffect({ type: 'assess', packet }, ctx, undefined, undefined, config.connection);
  assert.equal(assessed.type, 'assessed');
  if (assessed.type === 'assessed') { assert.equal(assessed.reply.provider, 'openjev'); assert.equal(assessed.reply.requestedModel, 'openjev-0.1'); assert.equal(assessed.reply.judgments[0]?.verdict, 'met'); }
  process.env.OPENJEV_API_KEY = 'changed-openjev-key';
  const stopped = await delegateEffect({ type: 'assess', packet }, ctx, undefined, undefined, config.connection);
  assert.equal(stopped.type, 'assessment_failed'); assert.equal(http.mock.callCount(), 1); assert.ok(!JSON.stringify(stopped).includes('changed-openjev-key'));
});

test('OpenJEV reported usage has unknown USD pricing and credentials/provider configuration are removed from child environments', () => {
  const usage = { inputTokens: 1000000, outputTokens: 0 };
  assert.equal(estimateJevUsd(usage), 0.042); assert.equal(estimateJevUsd(usage, 'openjev'), null);
  const cost = estimateCost({ ...initialState().metrics, jev: { status: 'reported', provider: 'openjev', model: 'openjev-0.1', requestedModel: 'openjev-0.1', usage } });
  assert.equal(cost.jevUsd, null); assert.equal(cost.delegationTotalUsd, null);
  const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: 'fixture-typesafe', OPENJEV_API_KEY: 'fixture-open', JEV_BACKEND: 'openjev', OPENJEV_BASE_URL: 'http://127.0.0.1:8080', OPENJEV_MODEL: 'openjev-0.1', PATH: 'fixture-path' };
  stripJevEnvironment(env); assert.deepEqual(env, { PATH: 'fixture-path' });
});

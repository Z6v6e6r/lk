import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const register = require('../../node-red/max-outbox-adapter/max-outbox-receipt.js');
const { persistReceipt } = register;
const receipt = () => ({ id: 'synthetic-command', leaseToken: randomUUID(), kind: 'ack' });
function clock() { let wall = 10000, mono = 0; return { now: () => wall, monotonicNow: () => mono,
  sleep: async ms => { wall += ms; mono += ms; }, advance: ms => { wall += ms; mono += ms; }, rewind: ms => { wall -= ms; } }; }
const env = () => ({ baseUrl: 'http://127.0.0.1:3000/api', integrationToken: 'synthetic-only' });
const accepted = r => new Response(JSON.stringify({ id: r.id, status: r.kind === 'ack' ? 'SENT' : 'FAILED',
  lastReceipt: { token: r.leaseToken, kind: r.kind }, text: 'private response', targetPhone: 'private recipient' }), { status: 200 });

test('CUP restart/committed ACK lost retries identical receipt, never a provider send', async () => {
  const r = receipt(), c = clock(), requests = []; let calls = 0;
  const result = await persistReceipt(r, new Date(c.now() + 120000).toISOString(), { ...env(), ...c,
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, 'http://127.0.0.1:3000'); assert.equal(url.pathname, '/api/support/outbox/synthetic-command/ack');
      assert.equal(options.redirect, 'error'); requests.push(options.body); calls++;
      if (calls === 1) throw Error('synthetic committed ACK then socket lost');
      if (calls === 2) return new Response('', { status: 503 });
      return accepted(r);
    } });
  assert.deepEqual(result, { state: 'CONFIRMED', code: 'DB_RECEIPT_CONFIRMED', attempts: 3 });
  assert.equal(new Set(requests).size, 1); assert.equal(JSON.parse(requests[0]).leaseToken, r.leaseToken);
  assert(!JSON.stringify(result).includes('private'));
});
test('only exact id/kind/token and durable status confirm success', async () => {
  for (const body of [{}, { id: 'wrong', status: 'SENT' }, { id: 'synthetic-command', status: 'SENT', lastReceipt: { token: 'wrong', kind: 'ack' } }]) {
    const r = receipt(), c = clock(); let calls = 0;
    const result = await persistReceipt(r, new Date(c.now() + 120000).toISOString(), { ...env(), ...c,
      fetchImpl: async () => { calls++; return new Response(JSON.stringify(body)); } });
    assert.equal(result.code, 'PROTOCOL_REJECTED'); assert.equal(calls, 1);
  }
});
test('auth, stale lease and unrelated 4xx stop immediately without storms', async () => {
  for (const status of [400, 401, 403, 404, 409]) { const c = clock(); let calls = 0;
    const result = await persistReceipt(receipt(), new Date(c.now() + 120000).toISOString(), { ...env(), ...c,
      fetchImpl: async () => { calls++; return new Response('private body', { status }); } });
    assert.equal(result.state, 'UNCONFIRMED'); assert.equal(calls, 1); assert(!JSON.stringify(result).includes('private'));
  }
});
test('lease deadline, attempts and backward wall-clock are bounded monotonically', async () => {
  const c = clock(); let calls = 0;
  const result = await persistReceipt(receipt(), new Date(c.now() + 1000).toISOString(), { ...env(), ...c,
    fetchImpl: async () => { calls++; c.advance(600); c.rewind(3600000); return new Response('', { status: 503 }); } });
  assert.equal(result.state, 'UNCONFIRMED'); assert(calls <= 2);
  const d = clock(); calls = 0;
  const limited = await persistReceipt(receipt(), new Date(d.now() + 120000).toISOString(), { ...env(), ...d, maximumAttempts: 2,
    fetchImpl: async () => { calls++; throw Error('private network error'); } });
  assert.equal(limited.attempts, 2); assert.equal(calls, 2);
});
test('invalid input, absent token and untrusted URL syntax fail without HTTP', async () => {
  const c = clock();
  const invalidAuth = new URL('https://invalid.test');
  invalidAuth.username = 'synthetic-user'; invalidAuth.password = 'synthetic-password';
  for (const changes of [{ integrationToken: '' }, { baseUrl: invalidAuth.href }, { baseUrl: 'file:///tmp' }, { baseUrl: 'http://127.0.0.1/?token=private' }]) {
    const result = await persistReceipt(receipt(), new Date(c.now() + 120000).toISOString(), { ...env(), ...c, ...changes,
      fetchImpl: () => assert.fail('No HTTP') }); assert.equal(result.code, 'CONFIGURATION_ERROR');
  }
});
test('close aborts in-flight receipt and no further attempt or private output escapes', async () => {
  const controller = new AbortController(); let calls = 0;
  const promise = persistReceipt(receipt(), new Date(Date.now() + 120000).toISOString(), { ...env(), signal: controller.signal,
    fetchImpl: async (_url, options) => { calls++; return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('private abort')), { once: true });
      controller.abort();
    }); } });
  const result = await promise; assert.equal(result.code, 'CLOSED'); assert.equal(calls, 1);
});
test('runtime resolves scoped env, ignores message URL/headers, deduplicates receipt and strips all context', async () => {
  let Type; const handlers = {}, outputs = [], warnings = [], reads = [];
  const r = receipt(), until = new Date(Date.now() + 120000).toISOString();
  const RED = { nodes: { registerType: (_t, ctor) => { Type = ctor; }, createNode: node => {
    node.on = (event, fn) => { handlers[event] = fn; }; node.warn = value => warnings.push(value);
  } }, util: { evaluateNodeProperty: (name, type, node) => {
    assert.equal(type, 'env'); assert(node instanceof Type); reads.push(name);
    return name === 'SUPPORT_API_BASE_URL' ? 'http://127.0.0.1:3000/api' : 'synthetic-scoped-token';
  } } };
  register(RED); new Type({}); const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => { calls++; assert.equal(url.origin, 'http://127.0.0.1:3000');
    assert.equal(options.headers['x-integration-token'], 'synthetic-scoped-token'); return accepted(r); };
  try {
    const msg = { maxOutboxReceipt: r, maxOutboxLeaseUntil: until, url: 'https://invalid.test',
      headers: { token: 'private override' }, payload: 'private original text' };
    await Promise.all([handlers.input(msg, v => outputs.push(v), () => {}), handlers.input(msg, v => outputs.push(v), () => {})]);
    assert.equal(calls, 1); assert.deepEqual(reads, ['SUPPORT_API_BASE_URL', 'SUPPORT_INTEGRATION_TOKEN']);
    assert.equal(outputs.length, 2); assert.deepEqual(Object.keys(outputs[0]), ['maxOutboxReceiptResult']);
    assert(!JSON.stringify(outputs).includes(r.leaseToken)); assert(!JSON.stringify(outputs).includes('private'));
    assert.deepEqual(warnings, []); handlers.close();
  } finally { globalThis.fetch = saved; }
});
test('fail receipt output contains only allowlisted provider category, not raw body', async () => {
  const r = { ...receipt(), kind: 'fail', failure: { status: 429, code: 'private body', message: 'private secret' }, retryAfterSeconds: 1e30 };
  const c = clock();
  const result = await persistReceipt(r, new Date(c.now() + 120000).toISOString(), { ...env(), ...c, fetchImpl: async (_url, o) => {
    const b = JSON.parse(o.body); assert.equal(b.failure.code, 'unclassified'); assert.equal(b.retryAfterSeconds, 300);
    assert(!o.body.includes('private')); return accepted(r);
  } });
  assert.equal(result.state, 'CONFIRMED');
});


test('oversized receipt response is rejected before success and never exposes its body', async () => {
  const r = receipt(), c = clock(); let calls = 0;
  const result = await persistReceipt(r, new Date(c.now() + 120000).toISOString(), { ...env(), ...c,
    fetchImpl: async () => { calls++; return new Response('private-' + 'x'.repeat(70000)); } });
  assert.equal(result.code, 'PROTOCOL_REJECTED'); assert.equal(calls, 1);
  assert(!JSON.stringify(result).includes('private'));
});
test('request timeout aborts stalled CUP transport and 429 obeys retry-after within lease', async () => {
  let calls = 0;
  const result = await persistReceipt(receipt(), new Date(Date.now() + 120000).toISOString(), {
    ...env(), requestTimeoutMs: 5, maximumAttempts: 1,
    fetchImpl: async (_url, options) => { calls++; return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Error('synthetic timeout')), { once: true });
    }); }
  });
  assert.equal(result.code, 'RECEIPT_UNAVAILABLE'); assert.equal(calls, 1);
  const c = clock(), r = receipt(), start = c.now(); calls = 0;
  const recovered = await persistReceipt(r, new Date(start + 120000).toISOString(), { ...env(), ...c,
    fetchImpl: async () => { calls++; return calls === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : accepted(r); } });
  assert.equal(recovered.state, 'CONFIRMED'); assert.equal(c.now() - start, 2000);
});
test('completed receipt cache evicts safely at capacity without stranding future receipts', async () => {
  let Type; const handlers = {}, outputs = [];
  const RED = { nodes: { registerType: (_name, fn) => { Type = fn; }, createNode: node => {
    node.on = (event, fn) => { handlers[event] = fn; }; node.warn = () => assert.fail('No capacity refusal after completed work');
  } }, util: { evaluateNodeProperty: name => name === 'SUPPORT_API_BASE_URL' ? env().baseUrl : env().integrationToken } };
  register(RED); new Type({}); const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (url, options) => { calls++; return accepted({ id: url.pathname.split('/').at(-2),
    leaseToken: JSON.parse(options.body).leaseToken, kind: 'ack' }); };
  try {
    for (let i = 0; i < 1002; i++) await handlers.input({ maxOutboxReceipt: { ...receipt(), id: 'synthetic-' + i },
      maxOutboxLeaseUntil: new Date(Date.now() + 120000).toISOString() }, v => outputs.push(v), () => {});
    assert.equal(calls, 1002); assert.equal(outputs.length, 1002);
    assert(outputs.every(x => x.maxOutboxReceiptResult.state === 'CONFIRMED')); handlers.close();
  } finally { globalThis.fetch = saved; }
});

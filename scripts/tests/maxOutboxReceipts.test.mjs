import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { preparePatch } from '../prepare_max_outbox_receipts.mjs';
const require = createRequire(import.meta.url);
const register = require('../../node-red/max-outbox-adapter/max-outbox-send.js');
const { deliver } = register;
const command = () => ({ id: 'synthetic-command', leaseToken: randomUUID(), text: 'synthetic text',
  targetExternalChatId: 'chat-fixture', leasedUntil: new Date(Date.now() + 60000).toISOString() });
const provider = (status, body, headers) => new Response(JSON.stringify(body), { status, headers });
const run = (file, msg) => new Function('msg', 'env', fs.readFileSync(file, 'utf8'))(msg, { get: () => null });

test('adapter package maps a CommonJS .js runtime to its sibling editor template', () => {
  const root = new URL('../../node-red/max-outbox-adapter/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  const runtime = manifest['node-red'].nodes['max-outbox-send'];
  assert.equal(manifest.type, 'commonjs');
  assert.equal(runtime, 'max-outbox-send.js');
  assert.equal(typeof register, 'function');
  const template = fs.readFileSync(new URL(runtime.replace(/\.js$/, '.html'), root), 'utf8');
  assert.match(template, /data-template-name=["']max-outbox-send/);
  assert.equal(fs.existsSync(new URL('max-outbox-send.cjs', root)), false);
});

test('one provider accepted response produces only ACK receipt; no body/target/token export', async () => {
  const c = command(); let calls = 0;
  const result = await deliver(c, 'synthetic-private-token', { fetchImpl: async (url, options) => {
    calls++; assert.equal(url.origin, 'https://platform-api2.max.ru');
    assert.equal(url.pathname, '/messages'); assert.equal(url.searchParams.get('chat_id'), 'chat-fixture');
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'synthetic-private-token');
    return provider(200, { message: { body: { mid: 'private-provider-id', text: c.text } } });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { id: c.id, leaseToken: c.leaseToken, kind: 'ack' });
});

test('403 preserves status and allowlisted code without provider message/body/headers', async () => {
  let calls = 0; const c = command();
  const result = await deliver(c, 'token', { fetchImpl: async () => { calls++; return provider(403, { code: 'bot.blocked', message: 'private-description', recipient: 'private-recipient' }); } });
  assert.equal(calls, 1); assert.deepEqual(result.failure, { status: 403, code: 'bot.blocked' });
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.equal(result.kind, 'fail');
});

test('unallowlisted provider code and broken body never escape; status is retained', async () => {
  const unknown = await deliver(command(), 'token', { fetchImpl: async () => provider(403, { code: 'private description' }) });
  assert.equal(unknown.failure.code, 'unclassified');
  const broken = await deliver(command(), 'token', { fetchImpl: async () => new Response('not json', { status: 403 }) });
  assert.equal(broken.failure.status, 403);
  const large = await deliver(command(), 'token', { fetchImpl: async () => new Response('x'.repeat(65537), { status: 200 }) });
  assert.equal(large.kind, 'fail'); assert.equal(large.failure.status, null);
  const invalid = await deliver(command(), 'token', { fetchImpl: async () => provider(200, {}) });
  assert.equal(invalid.kind, 'fail');
});

test('429 has bounded Retry-After; transport error/5xx create failure only once', async () => {
  const result = await deliver(command(), 'token', { fetchImpl: async () => provider(429, {}, { 'retry-after': '99999999999999999999' }) });
  assert.equal(result.retryAfterSeconds, 300);
  for (const fetchImpl of [async () => { throw Error('private stack'); }, async () => provider(503, {})]) {
    const failed = await deliver(command(), 'token', { fetchImpl });
    assert.equal(failed.kind, 'fail'); assert.ok(!JSON.stringify(failed).includes('private'));
  }
});

test('timeout aborts transport and late provider completion cannot emit ACK', async () => {
  let calls = 0;
  const failed = await deliver(command(), 'token', { timeoutMs: 5, fetchImpl: async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('synthetic abort')), { once: true }));
  } });
  assert.equal(calls, 1); assert.equal(failed.kind, 'fail'); assert.equal(failed.failure.status, null);
  const late = await deliver(command(), 'token', { timeoutMs: 1, fetchImpl: async () => {
    await new Promise(r => setTimeout(r, 10)); return provider(200, { message: { body: { mid: 'late' } } });
  } });
  assert.equal(late.kind, 'fail');
});

test('invalid text/target/attachment/near-expiry and legacy lease make no provider call', async () => {
  for (const changed of [{ text: '' }, { targetExternalChatId: null }, { attachments: [{}] },
    { leasedUntil: new Date(0).toISOString() }, { leaseToken: undefined }]) {
    const result = await deliver({ ...command(), ...changed }, 'token', { fetchImpl: async () => { assert.fail('No external call allowed'); } });
    assert.ok(result === null || result.kind === 'fail');
  }
});

test('user fallback uses user_id, never chat_id', async () => {
  await deliver({ ...command(), targetExternalChatId: undefined, targetExternalUserId: 'user-fixture' }, 'token', { fetchImpl: async url => {
    assert.equal(url.searchParams.get('user_id'), 'user-fixture'); assert.equal(url.searchParams.has('chat_id'), false);
    return provider(200, { message: { body: { mid: 'ok' } } });
  } });
});

test('dispatch and receipt preparation preserve fencing and drop private send context', async () => {
  const c = command();
  const dispatched = run('scripts/nodered_max_nodes/fn_max_outbox_dispatch_prepare.js', { payload: c });
  assert.deepEqual(dispatched[0], { supportOutbox: c });
  for (const receipt of [{ id: c.id, leaseToken: c.leaseToken, kind: 'ack' },
    { id: c.id, leaseToken: c.leaseToken, kind: 'fail', failure: { status: 403, code: 'unclassified' } }]) {
    const result = run('scripts/nodered_max_nodes/fn_max_outbox_receipt_prepare.js', { maxOutboxReceipt: receipt, chatId: 'private-chat', payload: 'private-text' });
    assert.equal(result.payload.leaseToken, c.leaseToken);
    assert.equal(result.requestTimeout, 7000);
    assert.equal(result.followRedirects, false);
    assert.ok(result.url.endsWith('/' + receipt.kind)); assert.equal(result.chatId, undefined);
    assert.ok(!JSON.stringify(result).includes('private-'));
  }
  const pull = run('scripts/nodered_max_nodes/fn_max_outbox_pull_prepare.js', {});
  assert.equal(new URL(pull.url).searchParams.get('receiptProtocol'), 'max-lease-v1');
});

function fixture(dispatchFixture = 'dispatch-before.function.txt') {
  const dispatch = fs.readFileSync('scripts/tests/fixtures/max-outbox/' + dispatchFixture, 'utf8');
  const pull = fs.readFileSync('scripts/tests/fixtures/max-outbox/pull-before.function.txt', 'utf8');
  return [
    ['47c460de0db646e6','f64e5818bc8d7aa6','41be3d2c95b57295'],
    ['0006d5707259bc5b','466e8a3ac76c2fab','2e547e998eee631f']
  ].flatMap(([a,b,c]) => [{ id:a,type:'function',z:'tab',func:dispatch,wires:[[b],['diagnostic']] },
    { id:b,type:'maxbot-send',z:'tab',bot:'synthetic-config',x:0,y:0,wires:[['legacy-ack']] },
    { id:c,type:'function',z:'tab',func:pull,wires:[['unchanged']] }]).concat([
    { id:'synthetic-config',type:'maxbot-config' }
  ]);
}
test('scoped patch builds both connector chains, changes no legacy sender and fails closed on drift', () => {
  const original = fixture(), before = structuredClone(original);
  const patch = preparePatch(original);
  assert.deepEqual(original, before);
  assert.equal(patch.length, 12);
  assert.equal(patch.some(n => n.type === 'maxbot-send'), false);
  assert.equal(patch.filter(n => n.type === 'max-outbox-send').length, 2);
  assert.match(patch.find(n => n.id === '2e547e998eee631f').func, /connector=MAX_ACADEMY_BOT/);
  assert.ok(patch.filter(n => n.type === 'http request').every(n => n.wires[0][0].startsWith('max_outbox_fenced_result_')));
  const drift = fixture(); drift[0].func += '\n// unexpected drift';
  assert.throws(() => preparePatch(drift), /PREIMAGE/);
  const wired = fixture(); wired[0].wires[0] = ['other-sender'];
  assert.throws(() => preparePatch(wired), /PREIMAGE/);
  const extra = fixture(); extra[0].wires[0].push('legacy-second-sender');
  assert.throws(() => preparePatch(extra), /PREIMAGE/);
  const missingBot = fixture().filter(n => n.id !== 'synthetic-config');
  assert.throws(() => preparePatch(missingBot), /PREIMAGE/);
  const wrongBot = fixture(); wrongBot.find(n => n.id === 'synthetic-config').type = 'unrelated-config';
  assert.throws(() => preparePatch(wrongBot), /PREIMAGE/);
  assert.throws(() => preparePatch([...original, original[0]]), /IDS/);
  assert.throws(() => preparePatch([...original, ...patch.filter(n => !original.some(o => o.id === n.id))]), /ALREADY_PATCHED/);
});

test('scoped patch accepts the exact diagnostic preimage and rejects changed observed code', () => {
  const original = fixture('dispatch-observed-before.function.txt');
  const before = structuredClone(original);
  const patch = preparePatch(original);
  assert.equal(patch.length, 12);
  assert.deepEqual(original, before);
  original[0].func += '\n// unknown observer drift';
  assert.throws(() => preparePatch(original), /PREIMAGE/);
});

test('fenced dispatch preserves safe diagnostics without exporting send fields or depending on the observer', () => {
  const c = { ...command(), connector: 'MAX_BOT', attempts: 1 };
  const fields = [];
  const source = fs.readFileSync('scripts/nodered_max_nodes/fn_max_outbox_dispatch_prepare.js', 'utf8');
  const execute = global => new Function('msg', 'env', 'global', source)({ payload: c }, {}, global);
  assert.deepEqual(execute({ get: () => ({ bindMax() {}, observe(_msg, _stage, safe) { fields.push(safe); } }) }), [{ supportOutbox: c }, null]);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].executionObserved, false);
  assert.equal(fields[0].leasePresent, true);
  assert.ok(!JSON.stringify(fields).includes(c.text));
  assert.ok(!JSON.stringify(fields).includes(c.targetExternalChatId));
  assert.deepEqual(execute({ get() { throw Error('synthetic observer failure'); } }), [{ supportOutbox: c }, null]);
});

test('registered runtime node emits receipt only and completes handler on failure', async () => {
  let Type, handler, complete = 0, sent;
  const RED = { nodes: { registerType: (_type, fn) => { Type = fn; }, getNode: () => null,
    createNode: node => { node.on = (event, fn) => { if (event === 'input') handler = fn; }; node.warn = () => {}; } } };
  register(RED); new Type({ bot: 'synthetic' });
  await handler({ supportOutbox: command(), payload: 'private' }, value => { sent = value; }, () => { complete++; });
  assert.equal(complete, 1); assert.equal(sent.maxOutboxReceipt.kind, 'fail');
  assert.deepEqual(Object.keys(sent), ['maxOutboxReceipt']);
});


test('node lifecycle deduplicates same lease and close aborts without success receipt', async () => {
  const original = globalThis.fetch;
  let calls = 0, Type; const handlers = new Map(); const warnings = [];
  const RED = { nodes: { registerType: (_t, fn) => { Type = fn; }, getNode: () => ({ token: 'synthetic-token' }),
    createNode: node => { node.on = (event, fn) => handlers.set(event, fn); node.warn = x => warnings.push(x); } } };
  try {
    globalThis.fetch = async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('abort')), { once: true }));
    };
    register(RED); new Type({ bot: 'synthetic' });
    const msg = { supportOutbox: command() }, outputs = []; let completed = 0;
    const one = handlers.get('input')(msg, x => outputs.push(x), () => completed++);
    const duplicate = handlers.get('input')(msg, x => outputs.push(x), () => completed++);
    handlers.get('close')();
    await Promise.all([one, duplicate]);
    assert.equal(calls, 1); assert.equal(completed, 2);
    assert.ok(outputs.every(x => x.maxOutboxReceipt.kind === 'fail'));
    assert.ok(outputs.every(x => !JSON.stringify(x).includes('synthetic-token')));
    await handlers.get('input')(msg, () => assert.fail('No send after close'), () => completed++);
    assert.equal(calls, 1); assert.equal(completed, 3);
  } finally { globalThis.fetch = original; }
});

test('receipt output failure completes handler without repeating provider send', async () => {
  const original = globalThis.fetch;
  let Type, input, calls = 0, completed = 0; const warnings = [];
  const RED = { nodes: { registerType: (_t, fn) => { Type = fn; }, getNode: () => ({ token: 'synthetic' }),
    createNode: node => { node.on = (event, fn) => { if (event === 'input') input = fn; }; node.warn = x => warnings.push(x); } } };
  try {
    globalThis.fetch = async () => { calls++; return provider(200, { message: { body: { mid: 'accepted' } } }); };
    register(RED); new Type({ bot: 'synthetic' });
    const msg = { supportOutbox: command() };
    await input(msg, () => { throw Error('private output failure'); }, () => completed++);
    const outputs = [];
    await input(msg, x => outputs.push(x), () => completed++);
    assert.equal(calls, 1); assert.equal(completed, 2);
    assert.equal(outputs[0].maxOutboxReceipt.kind, 'ack');
    assert.deepEqual(warnings, ['MAX_OUTBOX_RECEIPT_OUTPUT_FAILED']);
  } finally { globalThis.fetch = original; }
});

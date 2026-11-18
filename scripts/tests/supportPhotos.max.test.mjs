import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const adapter = require('../../node-red/max-outbox-adapter/max-outbox-send.js');
const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCTAKkOP//Z', 'base64');
const sha = createHash('sha256').update(jpeg).digest('hex');
const image = i => ({ id: `synthetic-${i}`, type: 'IMAGE', url: `https://synthetic-storage.invalid/cup-support/v1/${'a'.repeat(64)}/${sha}.jpg?X-Amz-Signature=synthetic-${i}` });
const command = (n = 1) => ({ id: randomUUID(), connector: 'MAX_BOT', status: 'LEASED', attempts: 1,
  leaseToken: randomUUID(), leasedUntil: new Date(Date.now() + 60000).toISOString(), targetExternalChatId: 'synthetic-chat',
  text: '', meta: { maxOutboxProtocol: 'max-lease-v1' }, attachments: Array.from({ length: n }, (_, i) => image(i)) });
const response = (status, value) => new Response(JSON.stringify(value), { status });
function transport({ failedUpload = -1, sendFailure, corruptBytes = false } = {}) {
  const calls = []; let upload = 0;
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ host: url.hostname, path: url.pathname, method: options.method });
    assert.equal(options.redirect, 'error');
    if (url.hostname === 'synthetic-storage.invalid') { assert(!options.headers?.Authorization); return new Response(corruptBytes ? Buffer.from('not image') : jpeg); }
    if (url.pathname === '/uploads') { assert.equal(options.headers.Authorization, 'synthetic-bot-token'); return response(200, { url: `https://iu.oneme.ru/upload?synthetic=${upload}` }); }
    if (url.hostname === 'iu.oneme.ru') {
      assert(!options.headers?.Authorization, 'Bot token cannot reach upload/object host'); assert(options.body instanceof FormData);
      if (upload++ === failedUpload) throw Error('synthetic upload ACK lost');
      return response(200, { photos: { syntheticPhoto: { token: `synthetic-upload-${upload}` } } });
    }
    assert.equal(url.pathname, '/messages');
    if (sendFailure) return sendFailure(options);
    const body = JSON.parse(options.body); assert.equal(body.attachments.length, upload);
    assert.deepEqual(body.attachments.map(a => a.payload.token), Array.from({ length: upload }, (_, i) => `synthetic-upload-${i + 1}`));
    assert(body.attachments.every(a => a.type === 'image' && !a.payload.url));
    return response(200, { message: { body: { mid: 'synthetic-provider-mid' } } });
  } };
}
const options = mock => ({ ...mock, mediaOptions: { sourceHosts: ['synthetic-storage.invalid'] }, scheduler: adapter.createRateScheduler({ intervalMs: 0 }) });

test('photo-only and ten ordered photos upload before exactly one message; caption stays intact', async () => {
  for (const count of [1, 10]) {
    const mock = transport(), c = command(count); if (count === 10) c.text = 'synthetic caption';
    const fetch = mock.fetchImpl;
    mock.fetchImpl = async (url, opts) => { if (url.pathname === '/messages') assert.equal(JSON.parse(opts.body).text, count === 10 ? c.text : undefined); return fetch(url, opts); };
    const result = await adapter.deliver(c, 'synthetic-bot-token', options(mock));
    assert.equal(result.kind, 'ack');
    assert.equal(mock.calls.filter(c => c.path === '/messages').length, 1);
    assert.equal(mock.calls.filter(c => c.host === 'iu.oneme.ru').length, count);
    assert(!JSON.stringify(result).includes('synthetic-upload'));
  }
});
test('failed second upload, changed object bytes, arbitrary URL or inline legacy photo cannot send partial text/photos', async () => {
  for (const setup of [{ failedUpload: 1 }, { corruptBytes: true }]) {
    const mock = transport(setup), c = command(2); c.text = 'must not escape without both images';
    const result = await adapter.deliver(c, 'synthetic-bot-token', options(mock));
    assert.equal(result.failure.code, 'local_deferred'); assert.equal(mock.calls.filter(c => c.path === '/messages').length, 0);
  }
  for (const url of ['data:image/jpeg;base64,' + jpeg.toString('base64'), 'https://127.0.0.1/private', 'https://synthetic-storage.invalid/other-prefix/image.jpg']) {
    const c = command(); c.attachments[0].url = url;
    const result = await adapter.deliver(c, 'synthetic-bot-token', { ...options({}), fetchImpl: () => assert.fail('Invalid photo cannot trigger any transport') });
    assert.equal(result.failure.code, 'invalid_input');
  }
});
test('unknown message result and late success are never retried or ACKed', async () => {
  for (const sendFailure of [async () => { throw Error('synthetic timeout'); }, async () => response(503, {})]) {
    const mock = transport({ sendFailure }), result = await adapter.deliver(command(), 'synthetic-bot-token', options(mock));
    assert.equal(result.kind, 'fail'); assert.equal(mock.calls.filter(c => c.path === '/messages').length, 1);
  }
  const mock = transport({ sendFailure: async () => { await new Promise(r => setTimeout(r, 10)); return response(200, { message: { body: { mid: 'late' } } }); } });
  const result = await adapter.deliver(command(), 'synthetic-bot-token', { ...options(mock), timeoutMs: 1 });
  assert.equal(result.kind, 'fail');
});
test('legacy claim reuses transport without exposing a synthetic receipt; excludes old/expired claims', async () => {
  const c = command(); c.meta = { legacyMaxLeaseId: c.leaseToken }; delete c.leaseToken;
  const mock = transport(), result = await adapter.deliverLegacy(c, 'synthetic-bot-token', options(mock));
  assert.equal(result.message.body.mid, 'synthetic-provider-mid'); assert(!('leaseToken' in result));
  for (const changed of [{ attempts: 2 }, { leasedUntil: new Date(0).toISOString() }, { meta: { ...c.meta, legacyMaxArchive: null } }]) {
    assert.equal(await adapter.deliverLegacy({ ...c, ...changed }, 'synthetic-bot-token', { fetchImpl: () => assert.fail('No old claim send') }), null);
  }
});

test('slow media preparation preserves 500ms between actual message starts, including following text', async () => {
  let clock = Date.now(); const starts = [];
  const scheduler = adapter.createRateScheduler({ now: () => clock, monotonicNow: () => clock,
    wait: async ms => { clock += ms; } });
  const mock = transport(), original = mock.fetchImpl;
  const fetchImpl = async (url, opts) => {
    if (url.hostname === 'synthetic-storage.invalid') clock += 10000;
    if (url.pathname === '/messages') {
      starts.push(clock);
      if (!JSON.parse(opts.body).attachments) return response(200, { message: { body: { mid: 'synthetic-text' } } });
    }
    return original(url, opts);
  };
  for (let i = 0; i < 3; i++) {
    const c = command(i === 0 ? 1 : 0); c.text = i ? 'text' : ''; c.leasedUntil = new Date(clock + 60000).toISOString();
    assert.equal((await adapter.deliver(c, 'synthetic-bot-token', { ...options(mock), fetchImpl,
      scheduler, now: () => clock, mediaOptions: { sourceHosts: ['synthetic-storage.invalid'], admitUpload: op => op() } })).kind, 'ack');
  }
  assert.deepEqual(starts.map(x => x - starts[0]), [0, 500, 1000]);
});

test('legacy node deduplicates a claim, refuses changed payload and aborts transport on close', async () => {
  const handlers = {}, types = new Map(), outputs = [], warnings = [];
  const RED = { nodes: { registerType: (name, type) => types.set(name, type), getNode: () => ({ token: 'synthetic-bot-token' }),
    createNode: node => { node.on = (name, fn) => { handlers[name] = fn; }; node.warn = x => warnings.push(x); } } };
  const originalFetch = globalThis.fetch, mock = transport();
  try {
    globalThis.fetch = mock.fetchImpl; adapter(RED); const Type = types.get('max-legacy-outbox-send'); new Type({});
    const c = command(0); c.text = 'synthetic text'; c.meta = { legacyMaxLeaseId: c.leaseToken }; delete c.leaseToken;
    globalThis.fetch = async (url) => {
      mock.calls.push({ path: url.pathname }); return response(200, { message: { body: { mid: 'synthetic-once' } } });
    };
    await Promise.all([1, 2].map(() => handlers.input({ supportOutbox: c }, x => outputs.push(x), () => {})));
    assert.equal(mock.calls.length, 1); assert.equal(outputs.length, 2);
    await handlers.input({ supportOutbox: { ...c, text: 'changed' } }, x => outputs.push(x), () => {});
    assert.equal(mock.calls.length, 1); assert(warnings.includes('MAX_LEGACY_CHANGED_CLAIM'));
    let began; const started = new Promise(resolve => { began = resolve; });
    globalThis.fetch = async (_url, opts) => { began(); return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(Error('closed')), { once: true })); };
    const pending = handlers.input({ supportOutbox: { ...c, id: randomUUID(), targetExternalChatId: 'another-synthetic-chat' } }, x => outputs.push(x), () => {});
    await started; handlers.close(); await pending; assert.equal(outputs.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
test('only documented HTTP400 not-ready refusal permits bounded same-claim retries with the exact uploaded tokens', async () => {
  for (const permanent of [false, true]) {
    let sends = 0; const waits = [], bodies = [];
    const mock = transport({ sendFailure: async opts => {
      bodies.push(opts.body);
      return ++sends < 3 || permanent ? response(400, { code: 'attachment.not.ready', message: 'Key: errors.process.attachment.file.not.processed' })
        : response(200, { message: { body: { mid: 'ready-after-processing' } } });
    } });
    const result = await adapter.deliver(command(), 'synthetic-bot-token', { ...options(mock), waitForReady: async ms => { waits.push(ms); } });
    assert.equal(result.kind, permanent ? 'fail' : 'ack');
    assert.equal(sends, permanent ? 5 : 3); assert.deepEqual(waits, permanent ? [1000, 2000, 4000, 8000] : [1000, 2000]);
    assert.equal(new Set(bodies).size, 1, 'No reupload, caption/recipient mutation or new command');
    assert.equal(mock.calls.filter(c => c.host === 'iu.oneme.ru').length, 1);
  }
  for (const status of [200, 409, 429, 500, 503]) {
    const mock = transport({ sendFailure: async () => response(status, { code: 'attachment.not.ready' }) });
    await adapter.deliver(command(), 'synthetic-bot-token', { ...options(mock), waitForReady: () => assert.fail('Only proven HTTP400 refusal may retry') });
    assert.equal(mock.calls.filter(c => c.path === '/messages').length, 1);
  }
});

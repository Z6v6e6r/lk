import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import nodeUrl from 'node:url';
import { buildMaxRestartIngressHold, restoreMaxRestartHoldPreimage, readMaxRestartHoldSources,
  HOLD_COLLECTION } from '../prepare_max_restart_ingress_hold.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const now = Date.parse('2026-11-05T10:00:00.000Z');
const windowId = '0123456789abcdef0123456789abcdef';
const cfg = { windowId, connector: 'MAX_BOT', acceptUntil: '2026-11-05T12:00:00.000Z' };
const sources = readMaxRestartHoldSources();
const original = name => fs.readFileSync(new URL(`../nodered_max_nodes/${name}`, import.meta.url), 'utf8');
const runCode = (code, msg, env = { get: () => null }) => {
  class Clock extends Date { constructor(value) { super(value ?? now); } static now() { return now; } }
  const sandbox = { msg, env, nodeCrypto: crypto, nodeUrl, Buffer, Date: Clock, global: { get: () => undefined },
    node: {}, context: {}, flow: {} };
  return new vm.Script(`(function(){${code}\n})()`).runInNewContext(sandbox);
};
const run = (key, msg, config = cfg) => runCode(sources[key].replace('/* __MAX_HOLD_CONFIG__ */', JSON.stringify(config)), msg);
const plain = value => JSON.parse(JSON.stringify(value));
const update = overrides => ({ provider: 'max', updateType: 'message_created', timestamp: now, messageId: 'external-1',
  messageTimestamp: now, text: 'Hello', command: null, buttonValue: null, messageKind: 'text', contact: null, station: null,
  sender: { userId: 'user-1', username: null, name: 'Example', isBot: false },
  recipient: { chatId: 'chat-1', userId: null, chatType: 'dialog' }, attachments: [], ...overrides });
const message = maxUpdate => ({ req: { headers: { authorization: 'DO_NOT_PERSIST', cookie: 'PRIVATE' } },
  res: { private: 'DO_NOT_PERSIST' }, maxRaw: { token: 'SECRET' }, maxUpdate });
const prepared = overrides => plain(run('restart_hold_prepare', message(update(overrides))));
class Store {
  rows = new Map();
  update(args) {
    const [filter, change, options] = args;
    assert.deepEqual(options.writeConcern, { w: 'majority', j: true, wtimeoutMS: 5000 });
    const row = this.rows.get(filter._id);
    const match = row && Object.entries(filter).every(([k,v]) => row[k] === v);
    if (match) {
      if (change.$set) Object.assign(row, change.$set);
      return { acknowledged: true, matchedCount: 1, modifiedCount: change.$set ? 1 : 0, upsertedCount: 0, upsertedId: null };
    }
    if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    if (row) throw Error('DUPLICATE_KEY');
    this.rows.set(filter._id, structuredClone(change.$setOnInsert));
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: filter._id };
  }
  claim(args) {
    const [filter, change, options] = args;
    assert.deepEqual(options.sort, { receivedAt: 1, _id: 1 });
    assert.equal(options.upsert, false); assert.equal(options.returnDocument, 'after'); assert.equal(options.includeResultMetadata, false);
    const rows = [...this.rows.values()].filter(row => Object.entries(filter).every(([k,v]) => row[k] === v))
      .sort((a,b) => a.receivedAt.localeCompare(b.receivedAt) || a._id.localeCompare(b._id));
    if (!rows.length) return null;
    Object.assign(rows[0], change.$set); rows[0].attempts += change.$inc.attempts;
    return structuredClone(rows[0]);
  }
}
const claimMessage = () => plain(run('restart_hold_claim', { payload: { windowId, connector: cfg.connector, confirmation: 'DRAIN_ONE_HELD_MAX_EVENT' } }));

function fixture() {
  const flow = [{ id: 'mongo', type: 'mongodb4-client', name: 'synthetic', database: 'games' }];
  const branches = [];
  for (const [index, connector] of ['MAX_BOT', 'MAX_ACADEMY_BOT'].entries()) {
    const id = name => `synthetic-${index}-${name}`;
    const fn = (name, file, outputs, wires) => ({ id: id(name), z: id('tab'), type: 'function',
      func: original(file).replaceAll('"MAX_BOT"', `"${connector}"`), outputs, wires,
      initialize: '', finalize: '', libs: [] });
    flow.push({ id: id('tab'), type: 'tab', label: connector, disabled: false }, { id: id('bot'), type: 'maxbot-config', name: 'synthetic' },
      { id: id('in'), z: id('tab'), type: 'http in', method: 'post', url: `/synthetic/max/${index}`, wires: [[id('normalize')]] },
      fn('normalize', 'fn_max_webhook_prepare.js', 3, [[id('lookup')], [id('response')], [id('debug')]]),
      fn('lookup', 'fn_max_client_lookup_prepare.js', 1, [[id('lookup-http')]]),
      { id: id('lookup-http'), z: id('tab'), type: 'http request', method: 'use', ret: 'obj', senderr: false, wires: [[id('route')]] },
      fn('route', 'fn_max_support_route.js', 3, [[id('event-http')], [id('send')], [id('debug')]]),
      { id: id('event-http'), z: id('tab'), type: 'http request', method: 'use', ret: 'obj', senderr: false, wires: [[id('debug')]] },
      { id: id('response'), z: id('tab'), type: 'http response', wires: [] },
      { id: id('send'), z: id('tab'), type: 'maxbot-send', bot: id('bot'), wires: [['unrelated-outbox-ack']] },
      { id: id('debug'), z: id('tab'), type: 'debug', wires: [] });
    branches.push({ connector, tabId: id('tab'), botConfigId: id('bot'), normalizerId: id('normalize'),
      lookupPrepareId: id('lookup'), lookupHttpId: id('lookup-http'), routerId: id('route'), eventHttpId: id('event-http'),
      responseId: id('response'), ingressIds: [id('in')] });
  }
  flow.push({ id: 'unrelated-outbox-ack', type: 'function', func: 'return msg;', outputs: 1, wires: [[]] },
    { id: 'unrelated-lk1-rest', type: 'http in', method: 'post', url: '/lk/support/events', wires: [['unrelated-outbox-ack']] });
  const refresh = () => {
    const liveBytes = Buffer.from(JSON.stringify(flow));
    for (const branch of branches) {
      const ids = [branch.tabId, branch.botConfigId, branch.normalizerId, branch.lookupPrepareId, branch.lookupHttpId,
        branch.routerId, branch.eventHttpId, branch.responseId, ...branch.ingressIds];
      branch.nodeSha256 = Object.fromEntries(ids.map(id => [id, sha(JSON.stringify(flow.find(n => n.id === id)))]));
    }
    const evidence = { schema: 'PHUB_MAX_HOLD_MONGO_ADMISSION_V1', status: 'VERIFIED', observedAt: new Date(now).toISOString(),
      sourceSha256: sha(liveBytes), windowId, clientNodeId: 'mongo', clientNodeSha256: sha(JSON.stringify(flow[0])),
      database: 'games', collection: HOLD_COLLECTION, connected: true, majorityJournaledWriteAcknowledged: true,
      driverContract: 'MONGODB4_FLAT_UPDATE_DOCUMENT_AFTER_V1', cryptoModuleVerified: true, urlModuleVerified: true, httpRedirectSuppressionVerified: true, writeConcern: { w: 'majority', j: true } };
    const mongoEvidenceBytes = Buffer.from(JSON.stringify(evidence));
    return { liveBytes, mongoEvidenceBytes, evidence, admission: { schema: 'PHUB_MAX_RESTART_HOLD_ADMISSION_V1', windowId,
      sourceSha256: sha(liveBytes), capturedAt: new Date(now).toISOString(), acceptUntil: cfg.acceptUntil,
      mongoEvidenceSha256: sha(mongoEvidenceBytes), branches }, nowMs: now };
  };
  return { flow, branches, refresh };
}

// Real source functions over disposable synthetic messages and collection semantics only.
test('normalizer success cannot ACK before a durable write, and auth failures remain non2xx', () => {
  const packet = fixture().refresh(); const built = buildMaxRestartIngressHold(packet);
  const code = JSON.parse(built.candidateBytes).find(n => n.id === 'synthetic-0-normalize').func;
  const input = { req: { headers: { 'x-max-bot-api-secret': 'fixture' } }, res: {},
    payload: { message: { mid: 'm', sender: { user_id: 'u' }, recipient: { chat_id: 'c' }, body: { text: 'hello' } } } };
  const valid = runCode(code, input, { get: () => 'fixture' }); assert.ok(valid[0].maxUpdate); assert.equal(valid[1], null);
  const denied = runCode(code, input, { get: () => 'different' }); assert.equal(denied[0], null); assert.equal(denied[1].statusCode, 401);
  const unconfigured = runCode(code, input, { get: () => null }); assert.equal(unconfigured[1].statusCode, 503);
});
test('persist fixed projection, majority+j arguments, ACK only strict driver acknowledgement', () => {
  const store = new Store(); const [pending, early] = prepared({ raw: { access_token: 'BAD' }, contact: { phone: '70000000000', raw: { headers: 'BAD' } } });
  assert.equal(early, null); const serialized = JSON.stringify(pending.payload);
  for (const secret of ['DO_NOT_PERSIST', 'SECRET', 'access_token', 'headers', 'BAD']) assert.ok(!serialized.includes(secret));
  const result = store.update(pending.payload); assert.equal(run('restart_hold_write_result', { ...pending, payload: result }).statusCode, 200);
  for (const payload of [{}, { acknowledged: false }, { result: { ok: 1 } }, { ...result, upsertedId: 'other' }]) {
    assert.equal(run('restart_hold_write_result', { ...pending, payload }).statusCode, 503);
  }
  assert.equal(run('restart_hold_write_result', { ...pending, payload: result, error: { token: 'PRIVATE' } }).statusCode, 503);
});
test('setOnInsert deduplicates same connector/id while preserving first content, timestamps and attempt state', () => {
  const store = new Store(), [first] = prepared(); store.update(first.payload);
  const [retry] = prepared({ timestamp: now + 50, messageTimestamp: now + 50 }); const before = structuredClone(store.rows.get(first.payload[0]._id));
  assert.equal(store.update(retry.payload).matchedCount, 1); assert.deepEqual(store.rows.get(first.payload[0]._id), before);
  const [conflict] = prepared({ text: 'changed' }); assert.throws(() => store.update(conflict.payload), /DUPLICATE_KEY/);
});
test('connector/window IDs isolate dedup; absent external ID creates distinct receipts', () => {
  const [main] = prepared(); const [academy] = plain(run('restart_hold_prepare', message(update()), { ...cfg, connector: 'MAX_ACADEMY_BOT' }));
  const [next] = plain(run('restart_hold_prepare', message(update()), { ...cfg, windowId: 'f'.repeat(32) }));
  assert.equal(new Set([main, academy, next].map(m => m.payload[0]._id)).size, 3);
  assert.notEqual(prepared({ messageId: null })[0].payload[0]._id, prepared({ messageId: null })[0].payload[0]._id);
});
test('bounded payload/private attachment fields rejected without ACK or Mongo command', () => {
  for (const change of [{ text: 'x'.repeat(65537) }, { attachments: [{ payload: { access_token: 'PRIVATE' } }] },
    { attachments: [{ payload: { url: 'https://example.invalid/file?token=PRIVATE' } }] },
    { attachments: [{ req: { headers: {} } }] }, { attachments: Array(2049).fill('x') }]) {
    const [command, response] = prepared(change); assert.equal(command, null); assert.ok(response.statusCode >= 400);
  }
  const huge = prepared({ attachments: Array(40).fill('x'.repeat(8192)) }); assert.equal(huge[0], null); assert.equal(huge[1].statusCode, 413);
});
test('expired hold refuses incoming and manual drain; no fallback routes to CUP', () => {
  const expired = { ...cfg, acceptUntil: '2026-11-05T09:59:59Z' };
  assert.equal(run('restart_hold_prepare', message(update()), expired)[1].statusCode, 503);
  assert.equal(run('restart_hold_claim', { payload: { ...cfg, confirmation: 'DRAIN_ONE_HELD_MAX_EVENT' } }, expired), null);
});
test('atomic claim consumes each HELD record once in deterministic order, no unknown replay', () => {
  const store = new Store(); for (const messageId of ['two', 'one']) store.update(prepared({ messageId })[0].payload);
  const expected = [...store.rows.keys()].sort();
  for (const id of expected) {
    const claim = claimMessage(), saved = store.claim(claim.payload); assert.equal(saved._id, id);
    const reinjected = run('restart_hold_reinject', { ...claim, payload: saved }); assert.equal(reinjected._maxRestartHold.receiptId, id);
    assert.equal(reinjected.requestTimeout, 10000); assert.equal(reinjected.req, undefined); assert.equal(reinjected.headers, undefined);
    assert.equal(saved.attempts, 1); assert.equal(saved.state, 'DELIVERING');
  }
  assert.equal(store.claim(claimMessage().payload), null);
  for (const row of store.rows.values()) row.state = 'UNKNOWN';
  assert.equal(store.claim(claimMessage().payload), null);
});
test('failed or mismatched claim never emits reinjection, even after ambiguous actual DB claim', () => {
  const store = new Store(); store.update(prepared()[0].payload); const claim = claimMessage(), saved = store.claim(claim.payload);
  for (const input of [{ ...claim, payload: null }, { ...claim, payload: saved, error: {} },
    { ...claim, payload: { ...saved, claimToken: 'wrong' } }, { ...claim, payload: { ...saved, state: 'HELD' } },
    { ...claim, payload: { ...saved, payloadSha256: 'f'.repeat(64) } }, { ...claim, payload: { ...saved, connector: 'MAX_ACADEMY_BOT' } }]) {
    assert.equal(run('restart_hold_reinject', input), null);
  }
  assert.equal(store.claim(claimMessage().payload), null); // Crash after DB claim cannot retry the record.
});
test('lookup failure stops router/autoreply and finalizes UNKNOWN, never definitive CUP refusal', () => {
  const claim = { windowId, connector: cfg.connector, receiptId: 'a'.repeat(64), claimToken: crypto.randomUUID() };
  for (const statusCode of [undefined, 0, 400, 503]) {
    const [routed, failure] = run('restart_hold_lookup_result', { _maxRestartHold: claim, statusCode, payload: {} });
    assert.equal(routed, null); assert.equal(run('restart_hold_finalize', failure).payload[1].$set.state, 'UNKNOWN');
  }
  assert.ok(run('restart_hold_lookup_result', { _maxRestartHold: claim, statusCode: 200, payload: { client: null } })[0]);
});
for (const [name, statusCode, payload, error, state] of [
  ['accepted', 200, { ok: true }, null, 'DELIVERED'], ['accepted202', 202, { ok: true }, null, 'DELIVERED'],
  ['refused400', 400, { error: 'bad' }, null, 'REFUSED'], ['refused403', 403, {}, null, 'REFUSED'],
  ['refused422', 422, {}, null, 'REFUSED'], ['timeout408', 408, {}, null, 'UNKNOWN'],
  ['conflict409', 409, {}, null, 'UNKNOWN'], ['rate429', 429, {}, null, 'UNKNOWN'],
  ['server500', 500, {}, null, 'UNKNOWN'], ['server503', 503, {}, null, 'UNKNOWN'],
  ['redirect', 302, {}, null, 'UNKNOWN'], ['malformed', 200, 'html', null, 'UNKNOWN'],
  ['malformedArray', 200, [], null, 'UNKNOWN'], ['falseSuccess', 200, { ok: false }, null, 'UNKNOWN'],
  ['connectionLoss', undefined, null, { code: 'ECONNRESET', token: 'PRIVATE' }, 'UNKNOWN'],
]) test(`CUP result ${name}: ${state} is HTTP custody classification only`, () => {
  const msg = { _maxRestartHold: { windowId, connector: cfg.connector, receiptId: 'a'.repeat(64), claimToken: crypto.randomUUID() },
    statusCode, payload, error, headers: { authorization: 'PRIVATE' } };
  const final = plain(run('restart_hold_finalize', msg)); assert.equal(final.payload[1].$set.state, state);
  assert.equal(final.payload[0].state, 'DELIVERING'); assert.equal(final.payload[0].attempts, 1);
  assert.ok(!JSON.stringify(final).includes('PRIVATE')); assert.equal(final.payload[2].upsert, false);
});
test('crash-after-claim manual UNKNOWN is exact-token CAS, with no dispatch output', () => {
  const store = new Store(); store.update(prepared()[0].payload); const claim = claimMessage(), saved = store.claim(claim.payload);
  const input = { windowId, connector: cfg.connector, confirmation: 'MARK_EXACT_INTERRUPTED_CLAIM_UNKNOWN_NO_REPLAY',
    receiptId: saved._id, claimToken: saved.claimToken };
  const pending = plain(run('restart_hold_mark_unknown', { payload: input })); assert.equal(store.update(pending.payload).matchedCount, 1);
  assert.equal(store.rows.get(saved._id).state, 'UNKNOWN'); assert.equal(store.claim(claimMessage().payload), null);
  assert.equal(store.update(pending.payload).matchedCount, 0);
  assert.equal(run('restart_hold_mark_unknown', { payload: { ...input, connector: 'OTHER' } }), null);
});
test('final write failure emits only sanitized UNCONFIRMED status and never queues retry', () => {
  const result = plain(run('restart_hold_finalize_result', { payload: { acknowledged: false }, error: { token: 'PRIVATE' },
    _maxRestartHoldFinal: { receiptId: 'a'.repeat(64), state: 'DELIVERED' }, maxUpdate: update() }));
  assert.deepEqual(result, { payload: { code: 'MAX_HOLD_TERMINAL_UNCONFIRMED', state: 'UNKNOWN', durableCupCompletion: false } });
});
test('exact candidate patches only five nodes per branch; senders/outbox/LK1 unchanged; rollback exact', () => {
  const f = fixture(), input = f.refresh(), output = buildMaxRestartIngressHold(input);
  const after = JSON.parse(output.candidateBytes), changed = new Set(output.report.changedNodeIds);
  assert.equal(changed.size, 10);
  for (const before of f.flow) if (!changed.has(before.id)) assert.deepEqual(after.find(n => n.id === before.id), before);
  for (const n of after.filter(n => n.type === 'inject')) { assert.equal(n.once, false); assert.equal(n.repeat, ''); assert.equal(n.crontab, ''); }
  for (const n of after.filter(n => n.type === 'mongodb4')) assert.equal(n.collection, HOLD_COLLECTION);
  assert.deepEqual(restoreMaxRestartHoldPreimage({ candidateBytes: output.candidateBytes, originalBytes: input.liveBytes, contract: output.contract }), input.liveBytes);
  assert.throws(() => restoreMaxRestartHoldPreimage({ candidateBytes: Buffer.concat([output.candidateBytes, Buffer.from(' ')]), originalBytes: input.liveBytes, contract: output.contract }));
  assert.equal(output.report.databaseWritesPerformed, false); assert.equal(output.report.durableCupCompletion, false);
  assert.equal(output.report.authenticationVerified, false); assert.equal(output.report.independentExactAuthReviewRequired, true);
});
for (const [name, mutate] of [
  ['missing academy', x => x.admission.branches.pop()], ['wrong flow', x => { x.admission.branches[1].tabId = x.admission.branches[0].tabId; }],
  ['missing actual pins', x => { delete x.admission.branches[1].nodeSha256; }], ['wrong source', x => { x.admission.sourceSha256 = '0'.repeat(64); }],
  ['stale capture', x => { x.admission.capturedAt = '2026-11-04T00:00:00Z'; }], ['unbounded window', x => { x.admission.acceptUntil = '2026-11-06T00:00:00Z'; }],
  ['bot reuse', x => { x.admission.branches[1].botConfigId = x.admission.branches[0].botConfigId; }],
  ['no evidence', x => { x.mongoEvidenceBytes = null; }],
]) test(`candidate refuses ${name}`, () => { const x = fixture().refresh(); mutate(x); assert.throws(() => buildMaxRestartIngressHold(x)); });
for (const [name, mutate] of [
  ['HTTP redirect contract unknown', e => { e.httpRedirectSuppressionVerified = false; }],
  ['URL module unknown', e => { e.urlModuleVerified = false; }],
  ['unknown durability', e => { e.majorityJournaledWriteAcknowledged = false; }],
  ['unacknowledged write concern', e => { e.writeConcern.w = 0; }], ['stale Mongo', e => { e.observedAt = '2026-11-04T00:00:00Z'; }],
  ['wrong database', e => { e.database = 'other'; }], ['driver unknown', e => { e.driverContract = 'unknown'; }],
  ['wrong client', e => { e.clientNodeSha256 = 'f'.repeat(64); }], ['wrong window', e => { e.windowId = 'f'.repeat(32); }],
]) test(`candidate refuses ${name} even with a matching evidence-file hash`, () => {
  const x = fixture().refresh(); mutate(x.evidence); x.mongoEvidenceBytes = Buffer.from(JSON.stringify(x.evidence));
  x.admission.mongoEvidenceSha256 = sha(x.mongoEvidenceBytes); assert.throws(() => buildMaxRestartIngressHold(x));
});
for (const [name, mutate] of [
  ['duplicate IDs', f => { f.flow.push({ ...f.flow[1] }); }],
  ['polling ingress', f => { f.flow.find(n => n.id === 'synthetic-0-in').type = 'maxbot-receive'; }],
  ['parallel polling ingress', f => { f.flow.push({ id: 'parallel-poll', type: 'maxbot-receive', z: 'synthetic-0-tab', bot: 'synthetic-0-bot', wires: [['unrelated-outbox-ack']] }); }],
  ['shared lookup', f => { f.flow.find(n => n.id === 'unrelated-outbox-ack').wires = [['synthetic-0-lookup']]; }],
  ['wrong sender bot', f => { f.flow.find(n => n.id === 'synthetic-1-send').bot = 'synthetic-0-bot'; }],
  ['normalizer wire drift', f => { f.flow.find(n => n.id === 'synthetic-0-normalize').wires[0].push('unrelated-outbox-ack'); }],
  ['wrong connector source', f => { f.flow.find(n => n.id === 'synthetic-1-route').func = original('fn_max_support_route.js'); }],
]) test(`candidate refuses ${name} even with refreshed preimage hashes`, () => {
  const f = fixture(); mutate(f); assert.throws(() => buildMaxRestartIngressHold(f.refresh()));
});

test('attachment URLs use explicit built-in URL module without ambient sandbox URL', () => {
  assert.ok(prepared({ attachments: [{ type: 'image', url: 'https://example.invalid/photo' }] })[0]);
  assert.equal(prepared({ attachments: [{ url: 'https://example.invalid/photo?token=PRIVATE' }] })[1].statusCode, 400);
});

test('manual drain preserves claim through existing lookup/router and finalizes only its receipt', () => {
  const store = new Store(), held = prepared()[0]; store.update(held.payload);
  const claim = claimMessage(), record = store.claim(claim.payload);
  const reinjected = plain(run('restart_hold_reinject', { ...claim, payload: record }));
  const lookup = runCode(original('fn_max_client_lookup_prepare.js'), reinjected);
  assert.equal(lookup.method, 'GET'); assert.equal(lookup.requestTimeout, 10000);
  const lookupResult = run('restart_hold_lookup_result', { ...lookup, statusCode: 200,
    payload: { client: { authStatus: 'AUTHORIZED', lastStationId: 'synthetic-station', lastStationName: 'Synthetic' } } });
  const routed = runCode(original('fn_max_support_route.js'), lookupResult[0]);
  assert.equal(routed[0].method, 'POST');
  assert.equal(routed[0]._maxRestartHold.receiptId, held._maxRestartHold.receiptId);
  assert.equal(routed[0].requestTimeout, 10000); assert.equal(routed[0].req, undefined);
  const final = plain(run('restart_hold_finalize', { ...routed[0], statusCode: 200, payload: { ok: true } }));
  assert.equal(store.update(final.payload).matchedCount, 1);
  assert.equal(store.rows.get(held._maxRestartHold.receiptId).state, 'DELIVERED');
  assert.equal(store.claim(claimMessage().payload), null);
});

for (const [name, value] of [['followRedirects', true], ['followRedirects', 'false'], ['maxRedirects', 1]])
  test(`constructor refuses ambiguous/enabled ${name}=${value} on either HTTP hop`, () => {
    for (const hop of ['lookup-http', 'event-http']) {
      const f = fixture(); f.flow.find(n => n.id === `synthetic-0-${hop}`)[name] = value;
      assert.throws(() => buildMaxRestartIngressHold(f.refresh()), /HTTP_REDIRECT_CONFIGURATION/);
    }
  });
test('both authenticated HTTP nodes have a last-hop redirect fence and explicit disabled settings', () => {
  const f = fixture(), input = f.refresh(), output = buildMaxRestartIngressHold(input), graph = JSON.parse(output.candidateBytes);
  for (const b of f.branches) for (const httpId of [b.lookupHttpId, b.eventHttpId]) {
    const http = graph.find(n => n.id === httpId);
    assert.equal(http.followRedirects, false); assert.equal(http.maxRedirects, 0);
    const predecessors = graph.filter(n => (n.wires || []).some(w => w.includes(httpId)));
    assert.equal(predecessors.length, 1);
    assert.ok(predecessors[0].func.includes('msg.followRedirects = false;'));
    assert.ok(predecessors[0].func.includes('msg.maxRedirects = 0;'));
  }
  assert.deepEqual(output.report.authReviewInputs.map(r => r.normalizerFuncSha256),
    f.branches.map(b => sha(f.flow.find(n => n.id === b.normalizerId).func)));
  assert.equal(output.report.authenticationVerified, false);
});
test('redirect settings cannot survive reinjection or successful lookup output', () => {
  const store = new Store(); store.update(prepared()[0].payload); const claim = claimMessage();
  const reinjected = run('restart_hold_reinject', { ...claim, payload: store.claim(claim.payload), followRedirects: true, maxRedirects: 5 });
  assert.equal(reinjected.followRedirects, false); assert.equal(reinjected.maxRedirects, 0);
  const result = run('restart_hold_lookup_result', { ...reinjected, statusCode: 200, payload: {}, followRedirects: true, maxRedirects: 5 });
  assert.equal(result[0].followRedirects, false); assert.equal(result[0].maxRedirects, 0);
  assert.equal(run('restart_hold_no_redirects', { followRedirects: true }), null);
});
for (const hop of ['lookup', 'event']) test(`${hop} 3xx is UNKNOWN with no redirected request`, () => {
  const claim = { windowId, connector: cfg.connector, receiptId: 'a'.repeat(64), claimToken: crypto.randomUUID() };
  // Synthetic transport records exactly what the final fence sends; this is not installed Node-RED proof.
  const outgoing = run('restart_hold_no_redirects', { _maxRestartHold: claim, method: hop === 'lookup' ? 'GET' : 'POST',
    headers: { 'x-integration-token': 'SYNTHETIC_PRIVATE' }, followRedirects: true, maxRedirects: 5 });
  let requests = 1;
  if (outgoing.followRedirects !== false && outgoing.maxRedirects !== 0) requests++;
  const response = { ...outgoing, statusCode: 302, payload: {}, headers: { location: 'https://foreign.invalid/' } };
  const finalInput = hop === 'lookup' ? run('restart_hold_lookup_result', response) : [null, response];
  assert.equal(finalInput[0], null);
  const final = run('restart_hold_finalize', finalInput[1]);
  assert.equal(final.payload[1].$set.state, 'UNKNOWN'); assert.equal(requests, 1);
  assert.ok(!JSON.stringify(final).includes('SYNTHETIC_PRIVATE'));
});

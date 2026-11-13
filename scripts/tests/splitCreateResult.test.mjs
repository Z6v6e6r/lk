import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createSplitCreateResultProtocol } from '../lib/splitCreateResult.mjs';
import { composeSplitCreateResultFlow, splitCreateResultNode, SPLIT_CREATE_RESULT_IDS } from '../lib/splitCreateResultFlow.mjs';
import { splitCreateTiming, SPLIT_CREATE_TIMING_TARGETS, SPLIT_CREATE_RECEIPT_ANCHOR, SPLIT_CREATE_RECEIPT_FIELD } from '../lib/splitCreateTiming.mjs';

const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const now = Date.parse('2035-01-01T09:00:00Z');
function fixture(amount = 0) {
  const binding = { operationId: 'lk-split-create-synthetic', paymentRef: 'synthetic-ref',
    clientSubscriptionId: id(2), studioId: id(3), roomId: id(4),
    fromTime: '2035-01-02T07:00:00+03:00', toTime: '2035-01-02T08:00:00+03:00' };
  const target = { eventId: id(5), category: 'GAME', stationId: id(3), roomId: id(4),
    startsAt: binding.fromTime, durationMinutes: 60, basePriceMinor: 75000 };
  const createPayload = { directionId: 4588, typeId: 1613, timeFrom: binding.fromTime,
    timeTo: binding.toTime, roomId: id(4), maxClientsCount: 4, trainers: [], requirements: '' };
  const quote = { rule: { planKey: 'synthetic-plan' }, purchaseDate: '2035-01-01', target, createPayload,
    decision: { eligible: true, subscriptionVisitCount: amount ? 0 : 1, benefit: { finalPriceMinor: amount } } };
  quote.fingerprint = JSON.stringify({ tenantKey: 'iSkq6G', actorClientId: id(1), clientSubscriptionId: id(2),
    action: 'CREATE_GAME', rule: quote.rule, purchaseDate: quote.purchaseDate, createPayload,
    target: { ...target, eventId: `preflight:${binding.operationId}` } });
  if (amount) Object.assign(quote, { transactionId: id(7), transactionAttemptedAt: new Date(now).toISOString(),
    transactionIntent: { bookingId: id(6), actorClientId: id(1), studioId: id(3), chargeMinor: amount },
    checkout: { transactionId: id(7), toPayMinor: amount, paymentUrl: 'https://payments.example.test/synthetic' } });
  const op = { _id: `lk1-product:${JSON.stringify(['iSkq6G', id(1), binding.operationId])}`,
    tenantKey: 'iSkq6G', actorClientId: id(1), operationId: binding.operationId, clientSubscriptionId: id(2),
    category: 'open_game', state: 'CONFIRMED', exerciseId: id(5), bookingId: id(6),
    createReceipt: { schemaVersion: 1, paymentRef: binding.paymentRef, deadlineAt: new Date(now + 25 * 60000).toISOString(),
      assembleDeadlineAt: new Date(Date.parse(binding.fromTime) - 24 * 60 * 60000).toISOString() },
    confirmedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), lk1: quote };
  const exercise = { id: id(5), studio: { id: id(3) }, room: { id: id(4) },
    timeFrom: binding.fromTime, timeTo: binding.toTime, canceled: false };
  const booking = { id: id(6), client: { id: id(1), phone: 'PRIVATE_PHONE' }, isCancelled: false,
    paymentType: amount ? 'ON_PLACE' : 'SUBSCRIPTION', ...(amount ? {} : { clientSubscriptionId: id(2) }), spot: 1 };
  return { binding, op, exercise, booking };
}
function run(f, mutate = () => {}) {
  const p = createSplitCreateResultProtocol(), effects = [];
  let next = p.begin({ operationId: f.binding.operationId }, now);
  for (let count = 0; count < 15; count++) {
    effects.push(next.effect);
    if (next.effect.kind === 'reply') return { ...next.effect, effects };
    const stage = next.state.stage;
    let body = stage === 'profile' ? { id: id(1) } : ['operation', 'operation_recheck'].includes(stage)
      ? [structuredClone(f.op)] : stage === 'exercise' ? structuredClone(f.exercise)
        : { content: [structuredClone(f.booking)], last: true, number: 0, totalElements: 1 };
    const event = { status: 200, body };
    mutate(stage, event, next.state);
    next = p.step(next.state, event, now + count);
  }
  assert.fail('unbounded protocol');
}
test('late confirmed free create: only profile/exercise/bookings GETs and majority reads, whitelisted result', () => {
  const r = run(fixture());
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'CONFIRMED');
  assert.equal(r.body.toPayMinor, 0);
  assert.equal(r.body.paymentRef, 'synthetic-ref');
  assert.equal(r.body.shareAmount, 750);
  assert.equal(r.body.shareAmountMinor, 75000);
  assert.equal(r.body.deadlineAt, fixture().op.createReceipt.deadlineAt);
  for (const e of r.effects) {
    assert.ok(['http', 'find', 'reply'].includes(e.kind));
    if (e.kind === 'http') assert.equal(e.method, 'GET');
    if (e.kind === 'find') { assert.equal(e.options.readConcern.level, 'majority'); assert.equal(e.options.limit, 2); }
  }
  assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE_PHONE|fingerprint|purchaseDate|actorClientId|Bearer/);
});
test('paid overage returns only the persisted bound checkout', () => {
  const r = run(fixture(75000));
  assert.equal(r.status, 200);
  assert.equal(r.body.toPayMinor, 75000);
  assert.equal(r.body.settlementState, 'PAYMENT_REQUIRED');
});
for (const [name, change] of Object.entries({
  'foreign actor': f => { f.op.actorClientId = id(9); },
  'foreign tenant': f => { f.op.tenantKey = 'foreign'; },
  'changed operation': f => { f.op.operationId += 'x'; },
  'changed subscription': f => { f.op.clientSubscriptionId = id(9); },
  'changed room': f => { f.op.lk1.target.roomId = id(9); },
  'changed date': f => { f.op.lk1.target.startsAt = '2035-01-03T07:00:00+03:00'; },
  'changed duration': f => { f.op.lk1.target.durationMinutes = 90; },
  'changed payload': f => { f.op.lk1.createPayload.maxClientsCount = 6; },
  'tampered fingerprint': f => { f.op.lk1.fingerprint = 'untrusted'; },
  'unconfirmed operation': f => { f.op.state = 'PENDING_CONFIRMATION'; },
  'released operation': f => { f.op.state = 'RELEASED'; },
  'missing booking': f => { delete f.op.bookingId; },
  'cancellation in progress': f => { f.op.lk1.unpaidCancellation = { phase: 'INTENT' }; },
  'receipt schema': f => { f.op.createReceipt.schemaVersion = 99; },
  'receipt invalid deadline': f => { f.op.createReceipt.deadlineAt = 'bad'; },
  'receipt changed assembly deadline': f => { f.op.createReceipt.assembleDeadlineAt = '2035-01-03T04:00:00Z'; },
  'cancelled exercise': f => { f.exercise.canceled = true; },
  'exercise conflicting studio': f => { f.exercise.studioId = id(9); },
  'cancelled booking': f => { f.booking.isCancelled = true; },
  'foreign booking owner': f => { f.booking.clientId = id(9); },
  'foreign provider subscription': f => { f.booking.clientSubscriptionId = id(9); },
})) test(`${name} never becomes success`, () => {
  const f = fixture(); change(f);
  assert.equal(run(f).status, 202);
});
for (const [name, change] of Object.entries({
  'checkout amount': f => { f.op.lk1.checkout.toPayMinor++; },
  'checkout URL': f => { f.op.lk1.checkout.paymentUrl = 'javascript:alert(1)'; },
  'checkout transaction': f => { f.op.lk1.checkout.transactionId = id(9); },
  'checkout booking': f => { f.op.lk1.transactionIntent.bookingId = id(9); },
  'checkout actor': f => { f.op.lk1.transactionIntent.actorClientId = id(9); },
})) test(`paid ${name} mismatch cannot replay`, () => {
  const f = fixture(10000); change(f);
  assert.equal(run(f).status, 202);
});
test('missing operation, incomplete/duplicate provider list, concurrent release, read failure and deadline stay unknown', () => {
  for (const mutate of [
    (stage, e) => { if (stage === 'operation') e.body = []; },
    (stage, e) => { if (stage === 'bookings') e.body.last = false; },
    (stage, e) => { if (stage === 'bookings') { e.body.content.push(e.body.content[0]); e.body.totalElements++; } },
    (stage, e) => { if (stage === 'operation_recheck') e.body[0].state = 'RELEASED'; },
    (stage, e) => { if (stage === 'operation_recheck') e.body[0].updatedAt += 'x'; },
    (stage, e) => { if (stage === 'bookings') e.error = true; },
  ]) assert.equal(run(fixture(), mutate).status, 202);
  const p = createSplitCreateResultProtocol();
  assert.equal(p.step(p.begin({ operationId: fixture().binding.operationId }, now).state, {}, now + 8000).effect.status, 202);
});
test('bad input and unverified actor cannot reach database', () => {
  const p = createSplitCreateResultProtocol();
  assert.equal(p.begin({ ...fixture().binding, actorClientId: id(1) }, now).effect.status, 400);
  for (const status of [401, 403, 503]) {
    const r = p.step(p.begin({ operationId: fixture().binding.operationId }, now).state, { status, body: { id: id(1) } }, now);
    assert.equal(r.effect.kind, 'reply');
    assert.notEqual(r.effect.status, 200);
  }
});
test('adapter permits no caller-supplied effects, clears credentials on reply, handles OPTIONS and catches reads', () => {
  const p = createSplitCreateResultProtocol(), global = { get: () => null };
  const msg = { req: { method: 'GET', url: '/lk/games/split/create-result', headers: { authorization: 'Bearer synthetic-user' }, query: { operationId: fixture().binding.operationId } } };
  assert.equal(splitCreateResultNode(msg, global, p)[0], msg);
  assert.equal(msg.method, 'GET');
  msg.error = { message: 'PRIVATE_BODY' };
  const r = splitCreateResultNode(msg, global, p)[2];
  assert.equal(r.statusCode, 202);
  assert.equal(r.headers.Authorization, undefined);
  assert.equal(r._splitCreateResult, undefined);
  assert.doesNotMatch(JSON.stringify(r.payload), /synthetic-user|PRIVATE_BODY/);
  assert.equal(splitCreateResultNode({ req: { method: 'OPTIONS' } }, global, p)[2].statusCode, 204);
});
test('timing logger records only a fresh server trace, stage and elapsed time and cannot throw', () => {
  const rows = [], trace = '11111111-1111-4111-8111-111111111111';
  const msg = { req: { method: 'POST', url: '/lk/games/split/create', body: { token: 'PRIVATE_BODY' } },
    _splitCtx: { action: 'create', step: 'pricing_policy', token: 'PRIVATE_TOKEN' } };
  const global = { get: () => ({ randomUUID: () => trace }) };
  splitCreateTiming(msg, global, { warn: x => rows.push(x) }, true, ['split:pricing_policy'], { randomUUID: () => trace });
  splitCreateTiming(msg, global, { warn: x => rows.push(x) }, false, ['split:pricing_policy']);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).trace, trace);
  assert.doesNotMatch(rows[0], /PRIVATE|token|url|body/);
  assert.doesNotThrow(() => splitCreateTiming(msg, { get: () => { throw Error('bad'); } }, {}, true, []));
});
test('candidate adds isolated GET reader and timing wrappers while preserving original business sources', () => {
  const flow = [{ id: 'tab', type: 'tab', label: 'Games' },
    { id: 'create', type: 'http in', z: 'tab', method: 'post', url: '/lk/games/split/create', wires: [[SPLIT_CREATE_TIMING_TARGETS[0]]] },
    { id: 'lk_subscription_booking_find_20260804', type: 'mongodb4', clientNode: 'db', wires: [[]] },
    { id: 'db', type: 'mongodb4-client', dbName: 'games' },
    ...SPLIT_CREATE_TIMING_TARGETS.map(id => ({ id, type: 'function', z: 'tab',
      func: (id === 'lk_subscription_booking_router_20260804' ? `if (false) { const record = {\n${SPLIT_CREATE_RECEIPT_ANCHOR}\n}; }\n` : '')
        + 'msg.payload = { business: true }; return msg;', outputs: 1, wires: [[]] }))];
  const bytes = Buffer.from(JSON.stringify(flow)), sha = createHash('sha256').update(bytes).digest('hex');
  const r = composeSplitCreateResultFlow(bytes, sha), result = JSON.parse(r.candidateBytes);
  assert.equal(r.nodes.length, 6);
  for (const n of flow) {
    const next = result.find(x => x.id === n.id);
    if (SPLIT_CREATE_TIMING_TARGETS.includes(n.id)) {
      assert.ok(next.func.replace(SPLIT_CREATE_RECEIPT_FIELD, '').includes(n.func));
      assert.deepEqual(new Function('msg', 'global', 'node', next.func)({}, {}, {}), { payload: { business: true } });
    } else assert.deepEqual(next, n);
  }
  assert.throws(() => composeSplitCreateResultFlow(bytes, '0'.repeat(64)), /preimage/);
  assert.throws(() => composeSplitCreateResultFlow(r.candidateBytes, createHash('sha256').update(r.candidateBytes).digest('hex')), /collision/);
  const reader = result.find(n => n.id === SPLIT_CREATE_RESULT_IDS.handler);
  assert.equal(new Function('msg', 'global', reader.func)({ req: { method: 'OPTIONS' } }, {})[2].statusCode, 204);
});

test('legacy free rows keep no invented payment deadline; legacy paid rows remain unresolved', () => {
  const free = fixture(); delete free.op.createReceipt;
  const r = run(free);
  assert.equal(r.status, 200); assert.equal(r.body.paymentRef, null);
  assert.equal(r.body.referenceSource, 'LEGACY_OPERATION'); assert.equal(r.body.deadlineAt, null);
  const paid = fixture(10000); delete paid.op.createReceipt;
  assert.equal(run(paid).status, 202);
});

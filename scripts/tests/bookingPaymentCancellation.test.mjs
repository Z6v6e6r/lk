import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as lifecycle from '../lib/bookingPaymentAttempt.mjs';
import { splitAttemptTransaction } from '../lib/splitBookingPaymentAttempt.mjs';
import { createBookingPaymentCancellationProtocol } from '../lib/bookingPaymentCancellation.mjs';
import { bookingPaymentCancellationSource, bookingPaymentCancellationNode } from '../lib/bookingPaymentCancellationFlow.mjs';
import { fixture, at, cfg, createdAt } from './fixtures/bookingPaymentCancellationFixtures.mjs';
const get = (v, path) => path.split('.').reduce((x, k) => x?.[k], v);
const matches = (v, q) => Object.entries(q).every(([k, val]) => k === '$expr'
  ? JSON.stringify(v) === JSON.stringify(val.$eq[1].$literal)
  : val && typeof val === 'object' && '$exists' in val ? (get(v, k) !== undefined) === val.$exists : get(v, k) === val);
function run(f, { post = true, mutate = () => {}, config = cfg, input = f.input, profile = { id: 'actor' }, lostAck = false } = {}) {
  const p = createBookingPaymentCancellationProtocol({ ...lifecycle, ordinaryTransaction: splitAttemptTransaction }), effects = [];
  let next = p.begin(input, { ...config, method: post ? 'POST' : 'GET' }, at);
  for (let i = 0; i < 40; i++) {
    effects.push(next.effect); const e = next.effect;
    if (['reply', 'cleanup'].includes(e.kind)) return { ...e, effects, state: next.state };
    let event = { status: 200 };
    if (e.kind === 'http') event.body = e.auth === 'service' ? f.transaction : profile;
    if (e.kind === 'find') event.body = e.collection === 'games' ? [f.game].filter(g => matches(g, e.query))
      : [...f.docs.values()].filter(d => matches(d, e.query)).map(d => structuredClone(d));
    if (e.kind === 'update') {
      let d = [...f.docs.values()].find(d => matches(d, e.query));
      if (!d && e.options.upsert) { d = structuredClone(e.change.$setOnInsert); f.docs.set(d._id, d); }
      else if (d && e.change.$set) for (const [path, v] of Object.entries(e.change.$set)) {
        const keys = path.split('.'); let target = d;
        for (const k of keys.slice(0, -1)) target = target[k] ||= {};
        target[keys.at(-1)] = structuredClone(v);
      }
      event = { status: 200, body: { acknowledged: true, matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 }, error: lostAck };
      assert.deepEqual(e.options.writeConcern, { w: 'majority', j: true });
    }
    mutate(next.state.stage, event, f, effects);
    next = p.step(next.state, event, at + i);
  }
  assert.fail('unbounded cancellation protocol');
}
test('native explicit cancel before15m persists request and schedules the sole financial owner', () => {
  const f = fixture(), r = run(f);
  assert.equal(r.status, 202); assert.equal(r.body.state, 'CLOSING'); assert.equal(r.body.accepted, true);
  assert.equal(r.body.cancelled, false); assert.equal(r.body.limitReleased, false); assert.equal(r.body.paymentUrl, null);
  const op = f.docs.get(f.op._id); assert.ok(lifecycle.paymentAttemptCancelRequested(op));
  assert.equal(op.state, 'CONFIRMED'); assert.deepEqual(op.lk1.checkout, f.op.lk1.checkout);
  assert.equal(r.effects.some(e => e.kind === 'http' && e.method !== 'GET'), false);
  const jobs = [...f.docs.values()].filter(d => d.kind === 'BOOKING_PAYMENT_CANCEL_REQUEST_V1'); assert.equal(jobs.length, 1);
  assert.equal(jobs[0].operationKey, f.op._id);
});
test('native double click/lost ACK use same request and same queue item; GET never writes', () => {
  const f = fixture(); run(f, { lostAck: true }); const before = structuredClone([...f.docs]);
  const r = run(f, { lostAck: true }); assert.equal(r.body.state, 'CLOSING');
  assert.deepEqual([...f.docs], before);
  const status = run(f, { post: false }); assert.equal(status.body.state, 'CLOSING');
  assert.equal(status.effects.some(e => e.kind === 'update' || e.kind === 'cleanup'), false);
});
test('native PAID wins before request and during request readback without releasing capacity', () => {
  for (const late of [false, true]) {
    const f = fixture();
    if (!late) f.docs.get(f.op._id).lk1.paymentAttempt = { phase: 'PAID' };
    const r = run(f, { mutate(stage, _e, f) {
      if (late && stage === 'native_requested') f.docs.get(f.op._id).lk1.paymentAttempt.phase = 'PAID';
    } });
    assert.equal(r.body.state, 'PAID'); assert.equal(r.body.cancelled, false); assert.equal(r.body.limitReleased, false);
    assert.equal([...f.docs.values()].some(d => d.kind === 'BOOKING_PAYMENT_CANCEL_REQUEST_V1'), false);
  }
});
test('native CLOSED requires full release proof, including completed resource job', () => {
  const f = fixture(), op = f.docs.get(f.op._id); op.state = 'RELEASED';
  op.lk1.paymentAttempt = { phase: 'CLOSED', closedAt: createdAt };
  f.game.metadata.splitPayment.payments[0].status = 'EXPIRED';
  op.lk1.paymentAttemptRelease = { schemaVersion: 1, binding: lifecycle.paymentAttemptBinding(op),
    bookingState: 'CANCELLED', transactionState: 'UNPAID_CLOSED', creditState: 'NOT_CONSUMED', creditProof: null, verifiedAt: createdAt };
  assert.equal(run(f, { post: false }).body.limitReleased, true);
  op.lk1.paymentAttempt.resourceJobKey = 'resource'; op.lk1.paymentAttempt.resourceJobCompleted = false;
  assert.equal(run(f, { post: false }).body.limitReleased, false);
});
for (const [name, mutate] of Object.entries({
  'wrong bill': f => { f.input.transactionId = 'other'; },
  'wrong amount': f => { f.docs.get(f.op._id).lk1.checkout.toPayMinor++; },
  'before cohort': f => { f.docs.get(f.op._id).createdAt = '2034-12-31T12:00:00Z'; },
  'ambiguous owner': f => { f.docs.set('extra', { ...f.op, _id: 'extra' }); },
})) test('native owner mismatch never falls through to ordinary or queues cancellation: ' + name, () => {
  const f = fixture(); mutate(f); const r = run(f); assert.equal(r.status, 503);
  assert.equal(r.effects.some(e => e.kind === 'update'), false); assert.equal(r.body.limitReleased, false);
});
test('unverified/foreign actor, extra authority fields and OFF mode cannot mutate', () => {
  for (const options of [{ profile: {} }, { profile: { id: 'other' } }, { config: { ...cfg, enabled: false } },
    { input: { bookingId: 'booking', transactionId: 'transaction', actorClientId: 'actor' } }]) {
    const r = run(fixture(), options); assert.ok(r.status >= 400); assert.equal(r.effects.some(e => e.kind === 'update'), false);
  }
});
test('ordinary request binds current head and game, then delegates only the exact trusted cleanup', () => {
  const f = fixture(false), r = run(f); assert.equal(r.kind, 'cleanup');
  assert.equal(r.request.intent, 'cancel_payment'); assert.equal(r.request.paymentCancellation.authorized, true);
  assert.equal(r.request.paymentCancellation.headKey, f.head._id); assert.equal(r.request.actorClientId, 'actor');
  assert.equal(r.request.force, false); assert.equal(r.effects.filter(e => e.kind === 'http').length, 1);
  const source = fs.readFileSync('scripts/nodered_games_nodes/fn_split_cleanup_prepare.js', 'utf8');
  const out = new Function('msg', 'env', source)({ payload: [r.game], _splitCleanupRequest: r.request }, { get() {} });
  const tasks = out[0].payload; assert.equal(tasks.length, 1); assert.equal(tasks[0].mode, 'PARTICIPANT_TIMEOUT');
  assert.deepEqual(tasks[0].bookingIds, ['booking']);
  const status = run(f, { post: false }); assert.equal(status.body.state, 'CLOSING'); assert.equal(status.body.accepted, true);
});
test('ordinary paid race reports PAID, never successful cancellation or quota release', () => {
  const f = fixture(false); f.game.metadata.splitPayment.payments[0].status = 'PAID';
  f.transaction = { id: 'transaction', clientId: 'actor', exerciseId: 'exercise', status: 'PAID', toPay: 100000,
    products: [{ id: 'product', paymentBookingIds: ['booking'] }] };
  const r = run(f); assert.equal(r.body.state, 'PAID'); assert.equal(r.body.limitReleased, false);
  assert.equal(r.effects.some(e => e.kind === 'cleanup'), false);
});
test('ordinary missing game retains accepted cancellation with REVIEW, never fake CLOSED', () => {
  const f = fixture(false); f.game.id = 'missing'; const r = run(f);
  assert.equal(r.status, 503); assert.equal(r.body.state, 'REVIEW'); assert.equal(r.body.accepted, true);
  assert.equal(r.body.cancelled, false); assert.equal(r.body.limitReleased, false);
});
for (const variation of ['actor', 'bill', 'game', 'cohort']) test('ordinary mismatch cannot cancel another attempt: ' + variation, () => {
  const f = fixture(false), h = f.docs.get(f.head._id);
  if (variation === 'actor') h.payment.clientId = 'other';
  if (variation === 'bill') f.input.transactionId = 'other';
  if (variation === 'game') f.input.gameId = 'other';
  if (variation === 'cohort') h.createdAt = '2034-12-31T12:00:00Z';
  const r = run(f); assert.equal(r.status, 503); assert.equal(r.effects.some(e => e.kind === 'update'), false);
});
test('compiled Node-RED controller is self-contained, authenticated and GET-profile only', () => {
  const compiled = new Function('msg', 'global', 'env', bookingPaymentCancellationSource());
  const env = { get: k => ({ PADLHUB_PLATFORM_TENANT_KEY: 'tenant', LK1_UNPAID_CANCEL_MODE: 'ENFORCE_NEW',
    LK1_UNPAID_CANCEL_COHORT_FROM: cfg.cohortFrom })[k] };
  const missing = compiled({ req: { method: 'POST', url: '/lk/games/payment-attempts/cancel', headers: {} }, payload: {} }, {}, env);
  assert.equal(missing[5].statusCode, 401);
  const msg = { req: { method: 'POST', url: '/lk/games/payment-attempts/cancel', headers: { authorization: 'Bearer synthetic-session' } }, payload: fixture().input };
  const out = compiled(msg, {}, env); assert.equal(out[0].method, 'GET'); assert.match(out[0].url, /\/profile$/);
  const rejected = compiled({ ...out[0], method: 'POST', responseUrl: msg.url, statusCode: 200, payload: { id: 'actor' } }, {}, env);
  assert.equal(rejected[5].statusCode, 401);
  assert.equal(bookingPaymentCancellationNode.length, 4);
});

test('ordinary CLOSED requires server-only receipt and exact roster revision proof', () => {
  const f = fixture(false), h = f.docs.get(f.head._id);
  const p = { tenantKey: 'tenant', gameId: 'game', clientId: 'actor', bookingId: 'booking', transactionId: 'transaction',
    headKey: h._id, amountMinor: 100000, sourceRevision: 1, transactionState: 'UNPAID_CLOSED', bookingState: 'CANCELLED' };
  p.receiptKey = 'split-booking-payment-closure:' + JSON.stringify(['tenant', 'game', 'actor', 'booking', 'transaction']);
  h.phase = 'CLOSED'; h.closure = { ...p, rosterRevision: 2 };
  assert.equal(run(f, { post: false }).body.limitReleased, false);
  f.docs.set(p.receiptKey, { _id: p.receiptKey, kind: 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1', proposal: p });
  assert.equal(run(f, { post: false }).body.limitReleased, true);
  h.closure.transactionId = 'other'; assert.equal(run(f, { post: false }).body.limitReleased, false);
});
test('durable request alone never reports CLOSED if queue acknowledgement is unknown', () => {
  const f = fixture(), r = run(f, { mutate(stage, event) {
    if (stage === 'job_verified') event.body = [];
  } });
  assert.equal(r.status, 503); assert.equal(r.body.accepted, true); assert.equal(r.body.limitReleased, false);
  assert.equal(r.body.cancelled, false); assert.equal(r.body.state, 'REVIEW');
});


test('client-patchable PAID projection cannot replace fresh bound provider payment proof', () => {
  const f = fixture(false); f.game.metadata.splitPayment.payments[0].status = 'PAID';
  f.transaction = { id: 'transaction', clientId: 'other', status: 'PAID', toPay: 100000,
    products: [{ id: 'product', paymentBookingIds: ['booking'] }] };
  const r = run(f); assert.equal(r.body.state, 'REVIEW'); assert.equal(r.body.paid, false);
  assert.equal(r.body.limitReleased, false); assert.equal(r.body.accepted, true);
  assert.equal(r.effects.filter(e => e.kind === 'http' && e.auth === 'service').length, 1);
});


for (const field of ['roster', 'status']) test('native game finalization rejects malformed canonical ' + field, () => {
  const f = fixture(), op = f.docs.get(f.op._id); op.state = 'RELEASED';
  op.lk1.paymentAttempt = { phase: 'CLOSED', closedAt: createdAt };
  op.lk1.paymentAttemptRelease = { schemaVersion: 1, binding: lifecycle.paymentAttemptBinding(op),
    bookingState: 'CANCELLED', transactionState: 'UNPAID_CLOSED', creditState: 'NOT_CONSUMED', creditProof: null, verifiedAt: createdAt };
  if (field === 'roster') f.game.participants = {};
  else f.game.metadata.splitPayment.payments[0].status = 'UNKNOWN';
  const r = run(f, { post: false });
  assert.equal(r.status, 503); assert.equal(r.body.limitReleased, false); assert.equal(r.body.state, 'REVIEW');
});

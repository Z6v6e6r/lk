import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOKING_PAYMENT_WINDOW_MS, paymentAttemptCheckout, paymentAttemptDeadline,
  paymentAttemptReleased, paymentAttemptBinding } from '../lib/bookingPaymentAttempt.mjs';
import { eligiblePaymentAttempt, reconcileBookingPaymentAttempt } from '../lib/bookingPaymentAttemptWorker.mjs';

const start = '2099-01-01T12:00:00.000Z';
const due = '2099-01-01T12:15:00.000Z';
function fixture({ category = 'open_game', count = 0, cancelled = false } = {}) {
  const op = { _id: 'lk1-product:["fixture","actor","lk-split-join-fixture"]', tenantKey: 'fixture',
    actorClientId: 'actor', operationId: 'lk-split-join-fixture', clientSubscriptionId: 'subscription',
    exerciseId: 'exercise', bookingId: 'booking', upstreamBookingId: 'booking', category, state: 'CONFIRMED',
    createdAt: start, updatedAt: start, lk1: { fingerprint: 'fixture', rule: { productId: 'plan' },
      target: { category: { open_game: 'GAME', group_training: 'GROUP_TRAINING', tournament: 'TOURNAMENT' }[category],
        eventId: 'exercise', stationId: 'station', startsAt: '2099-01-01T14:00:00.000Z' },
      decision: { subscriptionVisitCount: count, benefit: { finalPriceMinor: 100000 } },
      transactionAttemptedAt: start, transactionId: 'transaction',
      transactionIntent: { productId: 'service', bookingId: 'booking', actorClientId: 'actor', studioId: 'station', chargeMinor: 100000, discountMinor: 0 },
      checkout: { transactionId: 'transaction', paymentUrl: 'https://pay.example.test/fixture', toPayMinor: 100000,
        ...paymentAttemptCheckout({ createDate: start, paymentDueDate: '2099-01-01T12:25:00.000Z' }, start) } } };
  const tx = { id: 'transaction', client: { id: 'actor' }, status: 'UNPAID', toPay: 100000,
    products: [{ id: 'service', discount: 0, paymentBookingIds: ['booking'] }],
    cardPaymentInfo: { status: 'NEW' }, receipts: [], transactionRefunds: [], deposit: 0 };
  const booking = { id: 'booking', client: { id: 'actor' }, exerciseId: 'exercise', isCancelled: cancelled,
    paymentType: count ? 'SUBSCRIPTION' : 'ON_PLACE', ...(count ? { clientSubscriptionId: 'subscription' } : {}),
    visitConfirmed: false, receipts: [] };
  const subscriptions = { content: [{ subscriptionId: 'subscription', product: { id: 'plan' }, visitsTotal: 2,
    visitsLeft: 1, bookings: [{ id: 'booking', exerciseId: 'exercise', paymentType: 'SUBSCRIPTION' }] }], last: true, totalElements: 1 };
  const db = { row: structuredClone(op), docs: new Map(), calls: [], failAck: false,
    async findOne(q) { return structuredClone(q._id === this.row._id ? this.row : this.docs.get(q._id) || null); },
    async updateOne(q, u, opts) {
      this.calls.push({ q: structuredClone(q), u: structuredClone(u), opts });
      let target = q._id === this.row._id ? this.row : this.docs.get(q._id);
      if (u.$setOnInsert) {
        if (target) return { acknowledged: true, matchedCount: 1, modifiedCount: 0 };
        this.docs.set(q._id, structuredClone(u.$setOnInsert));
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      if (!target || JSON.stringify(q.$expr.$eq[1].$literal) !== JSON.stringify(target)) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      for (const [path, value] of Object.entries(u.$set)) {
        const keys = path.split('.'); let row = target;
        for (const key of keys.slice(0, -1)) row = row[key] ||= {};
        row[keys.at(-1)] = structuredClone(value);
      }
      if (this.failAck) { this.failAck = false; throw Error('LOST_ACK'); }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    } };
  const provider = { tx, booking, subscriptions, calls: [], expireUnknown: false, cancelUnknown: false,
    async readTransaction() { this.calls.push('GET_TX'); return structuredClone(this.tx); },
    async readBooking() { this.calls.push('GET_BOOKING'); return structuredClone(this.booking); },
    async readSubscriptions() { return structuredClone(this.subscriptions); },
    async readCancelOptions() { return { bookingId: 'booking', cancellationOptions: { cancellationOnly: { available: true }, subscription: { available: true } } }; },
    async expireTransaction() { this.calls.push('EXPIRE'); if (!this.expireUnknown) this.tx.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' }; },
    async cancelBooking(_, __, method) {
      this.calls.push('CANCEL_' + method); if (this.cancelUnknown) return;
      this.booking.isCancelled = true;
      if (method === 'SERVICE') { this.subscriptions.content[0].visitsLeft = 2; this.subscriptions.content[0].bookings = []; }
    } };
  const run = (at = due, extra = {}) => reconcileBookingPaymentAttempt({ op: structuredClone(db.row), operations: db,
    provider, mode: 'ENFORCE_NEW', now: () => at, ...extra });
  return { op, tx, booking, db, provider, run };
}

test('one anchored15-minute deadline, including an earlier provider expiry', () => {
  assert.equal(BOOKING_PAYMENT_WINDOW_MS, 900000);
  const c = paymentAttemptCheckout({ createDate: start, paymentDueDate: '2099-01-01T12:25:00Z' }, start);
  assert.equal(c.expiresAt, due);
  assert.equal(paymentAttemptDeadline(c, '2099-01-01T12:10:00Z'), Date.parse(due));
  assert.equal(paymentAttemptCheckout({ createDate: start, paymentDueDate: '2099-01-01T12:10:00Z' }, start).expiresAt, '2099-01-01T12:10:00.000Z');
  assert.equal(paymentAttemptCheckout({}, 'unproven'), null);
});
for (const category of ['open_game', 'group_training', 'tournament']) {
  test(category + ':14:59 retains one checkout;15:00 closes once and proves release', async () => {
    const f = fixture({ category });
    assert.equal(eligiblePaymentAttempt(f.op), true);
    assert.deepEqual(await f.run('2099-01-01T12:14:59Z'), { state: 'PAYMENT_REQUIRED' });
    assert.equal(f.db.calls.length, 0);
    assert.deepEqual(await f.run(), { state: 'CLOSED' });
    assert.deepEqual(f.provider.calls.filter(c => ['EXPIRE', 'CANCEL_NONE'].includes(c)), ['EXPIRE', 'CANCEL_NONE']);
    assert.equal(paymentAttemptReleased(f.db.row), true);
    assert.deepEqual(f.db.row.lk1.checkout, f.op.lk1.checkout);
    assert.deepEqual(f.db.row.lk1.transactionIntent, f.op.lk1.transactionIntent);
    assert.deepEqual(await f.run(), { state: 'CLOSED' });
    assert.equal(f.provider.calls.filter(c => c === 'EXPIRE').length, 1);
  });
}
test('terminal unpaid checkout and cancelled RELEASED game recover without provider writes', async () => {
  const f = fixture({ cancelled: true });
  f.db.row.state = 'RELEASED'; f.db.row.releasedAt = start; f.db.row.releaseSource = 'GAME_LEAVE';
  f.provider.tx.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' };
  assert.deepEqual(await f.run(), { state: 'CLOSED' });
  assert.equal(f.db.row.releasedAt, start);
  assert.equal(f.db.row.releaseSource, 'GAME_LEAVE');
  assert.ok(f.provider.calls.every(c => c.startsWith('GET')));
});
test('lost expiry response remains readback-only across restarts', async () => {
  const f = fixture(); f.provider.expireUnknown = true;
  assert.equal((await f.run()).reason, 'EXPIRE_OUTCOME_UNKNOWN');
  assert.equal((await f.run()).reason, 'EXPIRE_OUTCOME_UNKNOWN');
  assert.equal(f.provider.calls.filter(c => c === 'EXPIRE').length, 1);
  assert.ok(!f.provider.calls.includes('CANCEL_NONE'));
  f.provider.tx.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' };
  assert.deepEqual(await f.run(), { state: 'CLOSED' });
});
test('lost cancellation response never repeats cancellation', async () => {
  const f = fixture(); f.provider.cancelUnknown = true;
  assert.equal((await f.run()).reason, 'CANCEL_OUTCOME_UNKNOWN');
  assert.equal((await f.run()).reason, 'CANCEL_OUTCOME_UNKNOWN');
  assert.equal(f.provider.calls.filter(c => c === 'CANCEL_NONE').length, 1);
  f.provider.booking.isCancelled = true;
  assert.deepEqual(await f.run(), { state: 'CLOSED' });
});
test('lost intent ACK forbids dispatch; resumed intent only reconciles', async () => {
  const f = fixture(); f.db.failAck = true;
  await assert.rejects(f.run(), /LOST_ACK/);
  assert.ok(!f.provider.calls.includes('EXPIRE'));
  assert.equal((await f.run()).reason, 'EXPIRE_OUTCOME_UNKNOWN');
});
test('two concurrent closers cannot issue two expiry/cancellation commands', async () => {
  const f = fixture();
  const result = await Promise.all([f.run(), f.run()]);
  assert.ok(result.some(r => r.state === 'CLOSED'));
  assert.equal(f.provider.calls.filter(c => c === 'EXPIRE').length, 1);
  assert.equal(f.provider.calls.filter(c => c === 'CANCEL_NONE').length, 1);
});
test('payment at either expiry boundary wins without cancellation or successor', async () => {
  for (const boundary of [1, 2, 3]) {
    const f = fixture(); let reads = 0;
    const get = f.provider.readTransaction.bind(f.provider);
    f.provider.readTransaction = async () => { if (++reads === boundary) f.provider.tx.status = 'PAID'; return get(); };
    assert.equal((await f.run()).state, 'PAID');
    assert.ok(!f.provider.calls.some(c => c.startsWith('CANCEL_')));
    assert.equal(paymentAttemptReleased(f.db.row), false);
  }
});

for (const phase of ['EXPIRE_INTENT', 'CANCEL_INTENT']) {
  test('a concurrent PAID journal winning ' + phase + ' readback forbids provider dispatch', async () => {
    const f = fixture(); const read = f.db.findOne.bind(f.db); let raced = false;
    f.db.findOne = async q => {
      if (!raced && q._id === f.db.row._id && f.db.row.lk1.paymentAttempt?.phase === phase) {
        raced = true;
        f.db.row.lk1.paymentAttempt = { ...f.db.row.lk1.paymentAttempt, phase: 'PAID', verifiedAt: due };
        // Even if the next provider response is stale OPEN, the durable PAID
        // readback cannot authorize either kind of monetary mutation.
        f.provider.tx.cardPaymentInfo = { status: 'NEW' };
      }
      return read(q);
    };
    assert.equal((await f.run()).state, 'RETRY_STORE');
    assert.equal(raced, true);
    assert.equal(f.db.row.lk1.paymentAttempt.phase, 'PAID');
    assert.equal(f.provider.calls.filter(c => c === 'EXPIRE').length, phase === 'EXPIRE_INTENT' ? 0 : 1);
    assert.ok(!f.provider.calls.some(c => c.startsWith('CANCEL_')));
  });
}
test('late paid cancelled booking needs review and never authorizes a fresh charge', async () => {
  const f = fixture({ cancelled: true }); f.provider.tx.status = 'PAID';
  assert.equal((await f.run()).reason, 'PAYMENT_AFTER_CANCELLATION_REQUIRES_REVIEW');
  assert.equal(paymentAttemptReleased(f.db.row), false);
});
test('native partial CREATE returns SERVICE exactly once and verifies the credit', async () => {
  const f = fixture({ count: 1 });
  assert.deepEqual(await f.run(), { state: 'CLOSED' });
  assert.equal(f.provider.calls.filter(c => c === 'CANCEL_SERVICE').length, 1);
  assert.equal(f.db.row.lk1.paymentAttemptRelease.creditProof.after.left, 2);
  assert.equal(paymentAttemptReleased(f.db.row), true);
  assert.equal(f.db.docs.get(f.db.row.lk1.paymentAttempt.resourceJobKey).phase, 'DONE');
  assert.equal(f.db.row.lk1.paymentAttempt.resourceJobCompleted, true);
});
test('SERVICE waits for a nonterminal native per-subscription return owner', async () => {
  const f = fixture({ count: 1 });
  f.db.docs.set('lk1-free-cancel-lock:["fixture","subscription"]', {
    _id: 'lk1-free-cancel-lock:["fixture","subscription"]', kind: 'LK1_FREE_CANCEL_LOCK_V1', ownerJobKey: 'other-job' });
  f.db.docs.set('other-job', { _id: 'other-job', phase: 'CANCEL_INTENT' });
  assert.equal((await f.run()).reason, 'SUBSCRIPTION_RETURN_BUSY');
  assert.ok(!f.provider.calls.includes('CANCEL_SERVICE'));
  f.db.docs.get('other-job').phase = 'DONE';
  assert.deepEqual(await f.run(), { state: 'CLOSED' });
});
test('missing SERVICE credit never releases partial attempt', async () => {
  const f = fixture({ count: 1 });
  f.provider.cancelBooking = async () => { f.provider.booking.isCancelled = true; };
  assert.equal((await f.run()).reason, 'CREDIT_RETURN_UNVERIFIED');
  assert.equal(paymentAttemptReleased(f.db.row), false);
});

test('PAID before cancellation completes its previously claimed SERVICE resource', async () => {
  const f = fixture({ count: 1 });
  f.provider.readSubscriptions = async () => ({});
  assert.equal((await f.run()).reason, 'VISIT_BASELINE_UNVERIFIED');
  const key = f.db.row.lk1.paymentAttempt.resourceJobKey;
  assert.equal(f.db.docs.get(key).phase, 'QUEUED');
  f.provider.tx.status = 'PAID';
  assert.equal((await f.run()).state, 'PAID');
  assert.equal(f.db.docs.get(key).phase, 'DONE');
  assert.equal(f.db.row.lk1.paymentAttempt.resourceJobCompleted, true);
  assert.ok(!f.provider.calls.some(c => c.startsWith('CANCEL_')));
});

test('PAID resource completion resumes after a stop following the PAID CAS', async () => {
  const f = fixture({ count: 1 });
  f.provider.readSubscriptions = async () => ({});
  await f.run(); f.provider.tx.status = 'PAID';
  const write = f.db.updateOne.bind(f.db); let stopped = false;
  f.db.updateOne = async (q, u, options) => {
    const ack = await write(q, u, options);
    if (u.$set?.['lk1.paymentAttempt']?.phase === 'PAID') stopped = true;
    return ack;
  };
  assert.equal((await f.run(due, { shouldStop: () => stopped })).state, 'RETRY_STORE');
  const key = f.db.row.lk1.paymentAttempt.resourceJobKey;
  assert.equal(f.db.row.lk1.paymentAttempt.phase, 'PAID');
  assert.equal(f.db.row.lk1.paymentAttempt.resourceJobCompleted, false);
  assert.equal(f.db.docs.get(key).phase, 'QUEUED');
  f.db.updateOne = write;
  assert.equal((await f.run()).state, 'PAID');
  assert.equal(f.db.docs.get(key).phase, 'DONE');
  assert.equal(f.db.row.lk1.paymentAttempt.resourceJobCompleted, true);
});

test('PAID winning before a delayed SERVICE job insert fences cancellation and QUEUED resurrection', async () => {
  const f = fixture({ count: 1 }); const write = f.db.updateOne.bind(f.db);
  let raced = false;
  f.db.updateOne = async (q, u, options) => {
    if (!raced && u.$setOnInsert?.kind === 'BOOKING_PAYMENT_CLOSE_JOB_V1') {
      raced = true; f.provider.tx.status = 'PAID';
      assert.equal((await f.run()).state, 'PAID');
    }
    return write(q, u, options);
  };
  await f.run();
  assert.equal(f.db.row.lk1.paymentAttempt.phase, 'PAID');
  assert.equal(f.db.row.lk1.paymentAttempt.resourceJobCompleted, true);
  assert.equal(f.db.docs.get(f.db.row.lk1.paymentAttempt.resourceJobKey).phase, 'DONE');
  assert.ok(!f.provider.calls.some(c => c.startsWith('CANCEL_')));
  assert.equal(paymentAttemptReleased(f.db.row), false);
});
test('separate visit debit stays CONFIRMED and waits for its existing return worker', async () => {
  const f = fixture({ count: 1 });
  f.db.row.lk1.visitJob = { phase: 'DEBIT_UNKNOWN' };
  f.provider.booking.paymentType = 'ON_PLACE'; delete f.provider.booking.clientSubscriptionId;
  assert.equal((await f.run()).reason, 'CREDIT_RETURN_PENDING');
  assert.equal(f.db.row.state, 'CONFIRMED');
  assert.equal(f.provider.calls.filter(c => c === 'CANCEL_SERVICE').length, 0);
});
for (const [name, mutate] of [
  ['wrong owner', f => f.provider.tx.client.id = 'other'],
  ['wrong amount', f => f.provider.tx.toPay = 1],
  ['wrong product', f => f.provider.tx.products[0].id = 'other'],
  ['wrong booking', f => f.provider.tx.products[0].paymentBookingIds = ['other']],
  ['conflicting alias', f => f.provider.tx.state = 'PAID'],
  ['refund', f => f.provider.tx.refundSum = 1],
  ['paid receipt', f => f.provider.tx.receipts = [{ status: 'paid' }]],
  ['double payment', f => f.provider.tx.possibleDoublePayment = true],
  ['offline payment', f => f.provider.booking.amountDue = { paidKopecks: 1 }],
  ['offline payment leg', f => f.provider.tx.paymentLegs = [{ source: 'CASH', amountKopecks: 100000 }]],
  ['paid payment leg', f => f.provider.tx.paymentLegs = [{ source: 'CARD_ONLINE', amountKopecks: 100000, status: 'PAID' }]],
  ['partial payment leg', f => f.provider.tx.paymentLegs = [{ source: 'CARD_ONLINE', amountKopecks: 1 }]],
  ['processing status', f => f.provider.tx.processingStatus = 'PROCESSING'],
  ...['fnNumber', 'fiscalReceiptNumber', 'fiscalDocumentNumber', 'paymentDate', 'paidAt'].map(key => [
    'fiscal receipt ' + key, f => f.provider.tx.receipts = [{ status: 'new', [key]: 'proof' }],
  ]),
]) test(name + ' blocks close/rejoin', async () => {
  const f = fixture(); mutate(f); await f.run();
  assert.equal(paymentAttemptReleased(f.db.row), false);
  assert.ok(!f.provider.calls.some(c => c.startsWith('CANCEL_')));
});
test('shadow and stop signals have no store/provider mutation', async () => {
  const f = fixture(); assert.equal((await f.run(due, { mode: 'SHADOW' })).state, 'WOULD_CLOSE');
  assert.equal((await f.run(due, { shouldStop: () => true })).state, 'STOPPED');
  assert.equal(f.db.calls.length, 0);
});
test('release proof requires exact binding, closed journal and returned-credit evidence', async () => {
  const f = fixture(); await f.run(); const good = f.db.row;
  assert.deepEqual(good.lk1.paymentAttemptRelease.binding, paymentAttemptBinding(good));
  for (const mutate of [r => r.lk1.paymentAttempt.phase = 'EXPIRE_INTENT', r => r.bookingId = 'other',
    r => r.lk1.checkout.transactionId = 'other', r => r.lk1.paymentAttemptRelease.creditState = 'RETURN_VERIFIED',
    r => r.lk1.paymentAttemptRelease.verifiedAt = start]) {
    const r = structuredClone(good); mutate(r); assert.equal(paymentAttemptReleased(r), false);
  }
});


test('older cancellation ownership is never taken over by a new lifecycle worker', async () => {
  assert.equal(eligiblePaymentAttempt({ category: 'open_game', state: 'CONFIRMED' }), false);
  for (const key of ['unpaidCancellation', 'cancelledAllowanceRelease']) {
    const f = fixture({ category: 'group_training' });
    f.db.row.lk1[key] = { phase: 'INTENT' };
    assert.equal(eligiblePaymentAttempt(f.db.row), false);
    assert.equal((await f.run()).reason, 'PAYMENT_ATTEMPT_OUT_OF_SCOPE');
    assert.equal(f.provider.calls.length, 0); assert.equal(f.db.calls.length, 0);
  }
});

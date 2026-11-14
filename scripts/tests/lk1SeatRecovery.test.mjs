import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, drive, instant } from './fixtures/lk1FreeCancellationFixtures.mjs';
import { lk1FreeBegin, lk1FreeReturnedOperation, lk1SeatReleasedOperation, lk1SeatCandidate } from '../lib/lk1FreeCancellation.mjs';
import { runLk1FreeCancellationJob } from '../lib/lk1FreeCancellationWorker.mjs';
import { moneyFixture } from './fixtures/lk1ReconciledCancellationFixtures.mjs';
import { lk1ReconciledCandidate } from '../lib/lk1ReconciledCancellation.mjs';

function cancelled({ gap = 0 } = {}) {
  const f = fixture();
  f.b.isCancelled = f.b.cancelled = true;
  f.sub.bookings = f.sub.bookings.filter(b => b.id !== f.b.id);
  f.sub.visitsLeft = f.sub.visitsTotal - f.sub.bookings.length - gap;
  Object.assign(f.sub, { status: 'ACTIVE', variant: 'BY_VISITS' });
  for (const b of f.sub.bookings) b.exerciseDate = '2099-11-10T09:00:00Z';
  return f;
}
const begin = f => lk1FreeBegin({ tenantKey: f.op.tenantKey, actorClientId: f.op.actorClientId,
  bookingId: f.op.bookingId || null, requestId: 'seat-recovery-fixture', seatOnly: true, operationKey: f.op._id });
const noRefund = f => assert.equal(f.provider.calls.filter(c => c.method !== 'GET').length, 0);

for (const gap of [0, 1, 3]) test(`cancelled seat is recoverable with missing-credit gap ${gap}, without refund`, async () => {
  const f = cancelled({ gap }), before = structuredClone(f.sub);
  const r = await drive(f, begin(f));
  assert.equal(r.payload.state, 'SEAT_RELEASED');
  const op = f.db.rows.get(f.op._id);
  assert.ok(lk1SeatReleasedOperation(op));
  assert.equal(lk1FreeReturnedOperation(op), false);
  assert.equal(op.lk1.seatRelease.creditRecoveryRequired, gap > 0);
  assert.deepEqual(f.sub, before); noRefund(f);
});
test('another real use of the same day is retained', async () => {
  const f = cancelled(); f.sub.bookings[0].exerciseDate = f.op.lk1.target.startsAt;
  const r = await drive(f, begin(f)); assert.notEqual(r.payload.state, 'SEAT_RELEASED');
  assert.equal(f.db.rows.get(f.op._id).state, 'CONFIRMED'); noRefund(f);
});
test('an active or contradictory provider booking is never released', async () => {
  for (const flags of [{ isCancelled: false, cancelled: false }, { isCancelled: true, cancelled: false }]) {
    const f = cancelled(); Object.assign(f.b, flags);
    assert.notEqual((await drive(f, begin(f))).payload.state, 'SEAT_RELEASED'); noRefund(f);
  }
});
test('foreign provider identity, partial subscription or fabricated balance stays held', async () => {
  for (const change of [f => f.b.clientId = 'foreign', f => f.sub.visitsLeft = f.sub.visitsTotal,
    f => f.sub.product.id = 'foreign', f => f.sub.bookings[0].exerciseDate = undefined]) {
    const f = cancelled(); change(f);
    assert.notEqual((await drive(f, begin(f))).payload.state, 'SEAT_RELEASED'); noRefund(f);
  }
});
test('a return with unknown SERVICE outcome owns the common lock', async () => {
  const f = cancelled(); const b = f.op;
  f.db.rows.set('foreign-return', { _id: 'foreign-return', phase: 'CANCEL_INTENT' });
  f.db.rows.set(`lk1-free-cancel-lock:${JSON.stringify([b.tenantKey, b.clientSubscriptionId])}`,
    { _id: `lk1-free-cancel-lock:${JSON.stringify([b.tenantKey, b.clientSubscriptionId])}`,
      kind: 'LK1_FREE_CANCEL_LOCK_V1', ownerJobKey: 'foreign-return' });
  assert.notEqual((await drive(f, begin(f))).payload.state, 'SEAT_RELEASED'); noRefund(f);
});
test('owner CAS fences a concurrent deterministic retry', async () => {
  const f = cancelled(); const update = f.db.updateOne.bind(f.db);
  f.db.updateOne = async (q, u, opts) => {
    if (u.$set?.releaseReason === 'LK1_CANCELLED_SEAT_VERIFIED') f.db.rows.get(f.op._id).state = 'PENDING_CONFIRMATION';
    return update(q, u, opts);
  };
  assert.notEqual((await drive(f, begin(f))).payload.state, 'SEAT_RELEASED'); noRefund(f);
});
test('worker resumes an interrupted seat intent without ever dispatching SERVICE', async () => {
  const f = cancelled(); const update = f.db.updateOne.bind(f.db); let interrupted = false;
  f.db.updateOne = async (q, u, opts) => {
    if (u.$set?.releaseReason && !interrupted) { interrupted = true; throw Error('ACK_UNKNOWN'); }
    return update(q, u, opts);
  };
  await drive(f, begin(f));
  const job = [...f.db.rows.values()].find(r => r.mode === 'SEAT_ONLY');
  assert.equal(job.phase, 'SEAT_INTENT');
  const r = await runLk1FreeCancellationJob({ job, operations: f.db, provider: f.provider, now: () => instant });
  assert.equal(r.state, 'SEAT_RELEASED'); noRefund(f);
});
test('failed provider refusal needs absence proof and cannot admit money/unknown writes', () => {
  const f = fixture(); f.op.state = 'FAILED'; delete f.op.bookingId;
  f.op.failure = { statusCode: 400 };
  assert.equal(lk1SeatCandidate(f.op), true);
  f.op.failure.statusCode = 503; assert.equal(lk1SeatCandidate(f.op), false);
  f.op.failure.statusCode = 400; f.op.lk1.transactionAttemptedAt = instant;
  assert.equal(lk1SeatCandidate(f.op), false);
});
test('terminal declined attempts cannot be resurrected under a stale common-lock read', async () => {
  const f = cancelled(); f.sub.bookings[0].exerciseDate = f.op.lk1.target.startsAt;
  await drive(f, begin(f));
  const old = structuredClone([...f.db.rows.values()].find(j => j.mode === 'SEAT_ONLY'));
  assert.equal(old.phase, 'DECLINED'); f.sub.bookings[0].exerciseDate = '2099-11-10T09:00:00Z';
  assert.equal((await drive(f, begin(f))).payload.state, 'DECLINED');
  assert.deepEqual({ ...f.db.rows.get(old._id), durableReadbacks: old.durableReadbacks }, old);
  const next = begin(f); next.state.requestId = 'fresh-seat-attempt';
  assert.equal((await drive(f, next)).payload.state, 'SEAT_RELEASED');
  assert.deepEqual({ ...f.db.rows.get(old._id), durableReadbacks: old.durableReadbacks }, old);
  const key = `lk1-free-cancel-lock:${JSON.stringify([f.op.tenantKey, f.op.clientSubscriptionId])}`;
  const stale = await f.db.updateOne({ _id: key, ownerJobKey: old._id }, { $set: { ownerJobKey: 'native-contender' } },
    { writeConcern: { w: 'majority', j: true } });
  assert.equal(stale.matchedCount, 0); noRefund(f);
});
test('an unattributable active row prevents unbound refusal recovery', async () => {
  const f = cancelled(); f.op.state = 'FAILED'; f.op.failure = { statusCode: 400 };
  delete f.op.bookingId; f.db.rows.set(f.op._id, structuredClone(f.op));
  f.b.clientId = undefined; f.b.client = undefined; f.b.isCancelled = false;
  const r = await drive(f, begin(f)); assert.notEqual(r.payload.state, 'SEAT_RELEASED'); noRefund(f);
});
for (const patch of [ { clientId: 'foreign', client: { id: 'actor' } },
  { clientId: 'actor', bookingStatus: 'ACTIVE' }, { clientId: 'actor', exerciseId: 'foreign' } ]) {
  test('ambiguous aliases in absence evidence cannot free an unbound seat', async () => {
    const f = cancelled(); Object.assign(f.op, { state: 'FAILED', failure: { statusCode: 400 } });
    delete f.op.bookingId; f.db.rows.set(f.op._id, structuredClone(f.op)); Object.assign(f.b, patch);
    assert.notEqual((await drive(f, begin(f))).payload.state, 'SEAT_RELEASED'); noRefund(f);
  });
}
test('unknown top-level provider/managed markers never enter refusal recovery', () => {
  for (const patch of [{ createAttemptedAt: instant }, { bookingAttemptedAt: instant }, { transactionAttemptedAt: instant },
    { managedSubscriptionInstanceId: 'managed' }, { activationState: 'PENDING' }]) {
    const f = fixture(); delete f.op.bookingId; Object.assign(f.op, { state: 'FAILED', failure: { statusCode: 400 } }, patch);
    assert.equal(lk1SeatCandidate(f.op), false);
  }
});
test('full owner preimage protects top-level bindings even if a writer omitted updatedAt', async () => {
  const f = cancelled(), update = f.db.updateOne.bind(f.db);
  f.db.updateOne = async (q, u, opts) => {
    if (u.$set?.['lk1.seatRelease']) f.db.rows.get(f.op._id).actorClientId = 'foreign';
    return update(q, u, opts);
  };
  assert.notEqual((await drive(f, begin(f))).payload.state, 'SEAT_RELEASED');
  assert.equal(f.db.rows.get(f.op._id).state, 'CONFIRMED'); noRefund(f);
});
for (const status of ['UNPAID', 'PAID', 'REFUND']) test(`historical ${status} money seat retains financial recovery identity`, async () => {
  const m = moneyFixture(), f = cancelled({ gap: 1 });
  f.op = m.op; f.b = m.b; f.sub = m.sub; f.sub.visitsLeft--;
  f.db.rows.clear(); f.db.rows.set(f.op._id, structuredClone(f.op));
  const request = f.provider.request.bind(f.provider);
  f.provider.request = async effect => {
    if (effect.path.includes('/transactions/')) return { status: 200, payload: { ...m.tx, status,
      ...(status === 'PAID' ? { paymentDate: instant } : {}),
      ...(status === 'REFUND' ? { refundSum: m.tx.toPay, refundedAt: instant } : {}) } };
    if (effect.path.includes('/subscriptions?')) return { status: 200, payload: { content: [f.sub], last: true, totalElements: 1 } };
    if (effect.path.includes('/bookings/')) return { status: 200, payload: f.b };
    return request(effect);
  };
  const r = await drive(f, begin(f)); assert.equal(r.payload.state, 'SEAT_RELEASED');
  const op = f.db.rows.get(f.op._id); assert.equal(op.releaseReason, m.op.releaseReason);
  assert.ok(lk1ReconciledCandidate(op), 'the original credit repair remains diagnosable');
  assert.equal(op.lk1.seatRelease.financialRecoveryRequired, status === 'PAID');
  noRefund(f);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionVisitJob, initialVisitJobUpdate, visitJobCas, pendingVisitTask,
  claimVisitMutation, visitMutationAfterAck, requestVisitReturn, recordVisitOutcome,
  visitAllowanceRelease, releaseVisitAllowanceUpdate } from '../lib/subscriptionVisitLifecycle.mjs';
const now = '2026-09-09T12:00:00.000Z';
const adapter = { contractVerified: true, contractId: 'fixture-only', operationLinkedReadback: true, idempotencySupported: true };
const operation = () => ({ _id: 'fixture:operation', operationId: 'fixture:join', action: 'JOIN_GAME', bookingPaymentType: 'ON_PLACE', state: 'CONFIRMED', tenantKey: 'fixture',
  actorClientId: 'fixture:actor', clientSubscriptionId: 'fixture:selected-instance', exerciseId: 'fixture:exercise',
  bookingId: 'fixture:booking', serviceDate: '2026-09-23', lk1: { target: { eventId: 'fixture:exercise', category: 'GAME' },
    decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 26250 },
      gameMinutes: { localDate: '2026-09-23', freeMinutes: 60, paidMinutes: 30 } } } });
const job = () => createSubscriptionVisitJob(operation(), now);
const binding = j => Object.fromEntries(['tenantKey', 'actorClientId', 'clientSubscriptionId', 'exerciseId', 'bookingId'].map(key => [key, j[key]]));
const cancellation = j => ({ source: 'VIVA_BOOKING_READBACK', operationId: 'fixture:cancel', ...binding(j),
  bookingCancelled: true, verifiedAt: now, moneyRefundState: 'REQUEST_ACCEPTED' });
const receipt = (j, action, outcome = 'APPLIED') => ({ source: 'VIVA_OPERATION_READBACK', ...binding(j), action,
  idempotencyKey: `${j.id}:${action.toLowerCase()}`, adapterContractId: 'fixture-only', providerOperationId: `fixture:${action}`,
  count: 1, outcome, verifiedAt: now, ...(action === 'RETURN' ? { reversesProviderOperationId: j.debitReceipt.providerOperationId } : {}) });
const debit = j => recordVisitOutcome(claimVisitMutation(j, adapter, now).after, 'DEBIT', receipt(j, 'DEBIT'), now);
const at = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);
function apply(document, command) {
  const matches = Object.entries(command.query).every(([key, value]) =>
    value && typeof value === 'object' && '$exists' in value ? (at(document, key) !== undefined) === value.$exists : at(document, key) === value);
  if (matches) for (const [path, value] of Object.entries(command.update.$set)) {
    const parts = path.split('.'); const field = parts.pop(); let target = document;
    for (const part of parts) target = target[part] ||= {};
    target[field] = structuredClone(value);
  }
  return { acknowledged: true, matchedCount: matches ? 1 : 0, modifiedCount: matches ? 1 : 0, upsertedCount: 0, upsertedId: null };
}

test('the journal enqueue and exact booking confirmation use one durable CAS', () => {
  const op = operation(); const insert = initialVisitJobUpdate(op, now);
  const doc = { ...op, state: 'PENDING_CONFIRMATION', upstreamBookingId: op.bookingId };
  delete doc.bookingId;
  assert.deepEqual(insert.options, { writeConcern: { w: 'majority', j: true } });
  assert.equal(apply(doc, insert).matchedCount, 1);
  assert.equal(doc.state, 'CONFIRMED'); assert.equal(doc.lk1.visitJob.count, 1);
  assert.equal(doc.lk1.visitJob.clientSubscriptionId, op.clientSubscriptionId);
  assert.equal(apply(doc, insert).matchedCount, 0);
  assert.equal(initialVisitJobUpdate(doc, now), null);
});
test('positive mixed quote requires exact selected subscription and one free visit', () => {
  for (const mutate of [o => { o.action = 'CREATE_GAME'; }, o => { o.bookingPaymentType = 'SUBSCRIPTION'; }, o => { o.clientSubscriptionId = ''; }, o => { o.lk1.decision.subscriptionVisitCount = 0; },
    o => { o.lk1.decision.benefit.finalPriceMinor = 0; }, o => { o.lk1.decision.gameMinutes.freeMinutes = 0; },
    o => { o.lk1.target.eventId = 'fixture:other'; }, o => { o.lk1.decision.gameMinutes.localDate = '2026-09-24'; }]) {
    const op = operation(); mutate(op); assert.throws(() => createSubscriptionVisitJob(op, now));
  }
});
test('one claim wins; only acknowledged claim may dispatch', () => {
  const original = job(); const op = { ...operation(), lk1: { ...operation().lk1, visitJob: original } };
  const claimA = claimVisitMutation(original, adapter, now); const claimB = claimVisitMutation(original, adapter, now);
  assert.equal(visitMutationAfterAck(claimA, apply(op, claimA)).action, 'DEBIT');
  assert.equal(visitMutationAfterAck(claimB, apply(op, claimB)), null);
  for (const ack of [{}, { acknowledged: false, matchedCount: 1, modifiedCount: 1 },
    { acknowledged: true, matchedCount: 1, modifiedCount: 0 }, { acknowledged: true, matchedCount: 2, modifiedCount: 1 }]) {
    assert.equal(visitMutationAfterAck(claimA, ack), null);
  }
});
test('provider dispatch is unavailable without verified idempotency and operation-linked readback', () => {
  for (const config of [null, {}, { ...adapter, contractVerified: false }, { ...adapter, idempotencySupported: false },
    { ...adapter, operationLinkedReadback: false }]) assert.throws(() => claimVisitMutation(job(), config, now), /CONTRACT_UNVERIFIED/);
});
test('crash after claim or timeout permits only verification, never another debit', () => {
  const sent = claimVisitMutation(job(), adapter, now).after;
  assert.equal(pendingVisitTask(structuredClone(sent)).action, 'VERIFY_DEBIT');
  assert.throws(() => claimVisitMutation(sent, adapter, now), /VERIFY_ONLY/);
  const unknown = recordVisitOutcome(sent, 'DEBIT', receipt(sent, 'DEBIT', 'UNKNOWN'), now);
  assert.equal(pendingVisitTask(unknown).action, 'VERIFY_DEBIT');
  assert.throws(() => claimVisitMutation(unknown, adapter, now), /VERIFY_ONLY/);
});
test('debit, money cancellation, exact visit return and allowance release form the complete local sequence', () => {
  let current = debit(job());
  assert.equal(current.phase, 'DEBIT_CONFIRMED'); assert.equal(visitAllowanceRelease(current), false);
  current = requestVisitReturn(current, cancellation(current), now);
  assert.equal(current.phase, 'RETURN_PENDING'); assert.equal(visitAllowanceRelease(current), false);
  const claim = claimVisitMutation(current, adapter, now);
  assert.equal(claim.task.clientSubscriptionId, 'fixture:selected-instance');
  assert.equal(claim.task.reversesProviderOperationId, 'fixture:DEBIT');
  current = recordVisitOutcome(claim.after, 'RETURN', receipt(claim.after, 'RETURN'), now);
  assert.equal(visitAllowanceRelease(current), true);
  const release = releaseVisitAllowanceUpdate(current, now);
  const op = { ...operation(), lk1: { ...operation().lk1, visitJob: current } };
  assert.equal(apply(op, release).matchedCount, 1); assert.equal(op.state, 'RELEASED');
  assert.equal(apply(op, release).matchedCount, 0);
  // Existing quote calculation excludes RELEASED operations, restoring 60 free minutes.
  assert.equal(op.lk1.visitJob.freeMinutes, 60);
});
test('cancel before debit prevents later debit and does not invent a visit return', () => {
  const current = requestVisitReturn(job(), cancellation(job()), now);
  assert.equal(current.phase, 'CANCELLED_BEFORE_DEBIT'); assert.equal(pendingVisitTask(current), null);
  assert.equal(visitAllowanceRelease(current), true);
  assert.throws(() => claimVisitMutation(current, adapter, now), /VERIFY_ONLY/);
});
test('cancel racing with debit preserves cancellation and requests reverse only after debit proof', () => {
  const sent = claimVisitMutation(job(), adapter, now).after;
  const cancelled = requestVisitReturn(sent, cancellation(sent), now);
  assert.equal(cancelled.phase, 'DEBIT_SENT'); assert.equal(visitAllowanceRelease(cancelled), false);
  const doc = { ...operation(), lk1: { ...operation().lk1, visitJob: cancelled } };
  const staleDone = recordVisitOutcome(sent, 'DEBIT', receipt(sent, 'DEBIT'), now);
  assert.equal(apply(doc, visitJobCas(sent, staleDone)).matchedCount, 0, 'stale worker cannot overwrite cancellation');
  const current = recordVisitOutcome(cancelled, 'DEBIT', receipt(cancelled, 'DEBIT'), now);
  assert.equal(current.phase, 'RETURN_PENDING'); assert.equal(pendingVisitTask(current).action, 'RETURN');
});
test('definitively rejected debit needs no reverse; unknown debit never frees minutes', () => {
  const sent = claimVisitMutation(job(), adapter, now).after;
  const cancelled = requestVisitReturn(sent, cancellation(sent), now);
  assert.equal(visitAllowanceRelease(recordVisitOutcome(cancelled, 'DEBIT', receipt(cancelled, 'DEBIT', 'NOT_APPLIED'), now)), true);
  assert.equal(visitAllowanceRelease(recordVisitOutcome(cancelled, 'DEBIT', receipt(cancelled, 'DEBIT', 'UNKNOWN'), now)), false);
});
test('wrong instance, actor, booking, operation, count, balance-only or unrelated return receipts fail closed', () => {
  const sent = claimVisitMutation(job(), adapter, now).after;
  for (const patch of [{ clientSubscriptionId: 'fixture:other' }, { actorClientId: 'fixture:other' },
    { bookingId: 'fixture:other' }, { idempotencyKey: 'fixture:other' }, { count: 2 },
    { source: 'BALANCE_DELTA', balanceDelta: -1 }, { adapterContractId: 'fixture:other' }]) {
    assert.throws(() => recordVisitOutcome(sent, 'DEBIT', { ...receipt(sent, 'DEBIT'), ...patch }, now), /RECEIPT_INVALID/);
  }
  const pending = requestVisitReturn(debit(job()), cancellation(job()), now);
  const returning = claimVisitMutation(pending, adapter, now).after;
  assert.throws(() => recordVisitOutcome(returning, 'RETURN', { ...receipt(returning, 'RETURN'), reversesProviderOperationId: 'fixture:other' }, now));
});
test('refund alone, requested cancellation and another booking cannot release minutes', () => {
  for (const patch of [{ bookingCancelled: false }, { moneyRefundState: 'UNKNOWN' }, { bookingId: 'fixture:other' },
    { clientSubscriptionId: 'fixture:other' }]) assert.throws(() => requestVisitReturn(job(), { ...cancellation(job()), ...patch }, now));
  assert.throws(() => releaseVisitAllowanceUpdate(debit(job()), now), /RETURN_NOT_CONFIRMED/);
});
test('replayed receipt and repeated cancel are no-ops; divergent receipts and IDs stop', () => {
  const sent = claimVisitMutation(job(), adapter, now).after; const proof = receipt(sent, 'DEBIT');
  const done = recordVisitOutcome(sent, 'DEBIT', proof, now);
  assert.deepEqual(recordVisitOutcome(done, 'DEBIT', proof, now), done);
  const reread = Object.fromEntries(Object.entries({ ...proof, verifiedAt: '2026-09-09T12:05:00.000Z' }).reverse());
  assert.deepEqual(recordVisitOutcome(done, 'DEBIT', reread, '2026-09-09T12:05:00.000Z'), done);
  assert.throws(() => recordVisitOutcome(done, 'DEBIT', { ...proof, providerOperationId: 'fixture:other' }, now));
  const cancelled = requestVisitReturn(done, cancellation(done), now);
  assert.deepEqual(requestVisitReturn(cancelled, cancellation(done), now), cancelled);
  assert.throws(() => requestVisitReturn(cancelled, { ...cancellation(done), operationId: 'fixture:other' }, now));
});
test('return timeout stays reserved and cannot issue another refund/return command', () => {
  const pending = requestVisitReturn(debit(job()), cancellation(job()), now);
  const sent = claimVisitMutation(pending, adapter, now).after;
  const unknown = recordVisitOutcome(sent, 'RETURN', receipt(sent, 'RETURN', 'UNKNOWN'), now);
  assert.equal(pendingVisitTask(unknown).action, 'VERIFY_RETURN'); assert.equal(visitAllowanceRelease(unknown), false);
  assert.throws(() => claimVisitMutation(unknown, adapter, now));
});
test('old cancellation release cannot affect a rejoined booking or another job revision', () => {
  const current = requestVisitReturn(job(), cancellation(job()), now);
  const command = releaseVisitAllowanceUpdate(current, now);
  for (const patch of [{ bookingId: 'fixture:new-booking' }, { clientSubscriptionId: 'fixture:other-instance' }, { operationId: 'fixture:new-join' }]) {
    assert.equal(apply({ ...operation(), ...patch, lk1: { ...operation().lk1, visitJob: current } }, command).matchedCount, 0);
  }
});

test('truncated restart state cannot fabricate a return or free allowance', () => {
  for (const broken of [
    { ...job(), phase: 'RETURN_CONFIRMED', cancellation: {} },
    { ...job(), phase: 'RETURN_PENDING', cancellation: cancellation(job()), debitReceipt: { providerOperationId: 'forged' } },
    { ...job(), phase: 'CANCELLED_BEFORE_DEBIT', cancellation: cancellation(job()), debitAttempt: { id: 'unknown' } },
    { ...job(), serviceDate: '2026-02-31' },
  ]) {
    assert.throws(() => visitAllowanceRelease(broken));
    assert.throws(() => pendingVisitTask(broken));
    assert.throws(() => releaseVisitAllowanceUpdate(broken, now));
  }
});

test('confirmed return makes the same-day 60 minutes available again in the real quote calculation', async () => {
  const fs = await import('node:fs');
  const { extractSubscriptionPricePreviewSource } = await import('../lib/subscriptionPricePreviewSources.mjs');
  const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const router = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const helper = extractSubscriptionPricePreviewSource({ source: router, label: 'booking',
    roots: ['isObj', 'isValidDateKey', 'normalizeId', 'isInactiveBooking', 'eventDate', 'bookingSubscriptionId', 'bookingId', 'resolveCategory', 'eventDurationMinutes'] }).source;
  const usage = source.slice(source.indexOf('if (ctx.step === "lk1_usage_operations") {'), source.indexOf('if (ctx.step === "lk1_policy_decision") {'));
  const evaluateUsage = new Function('msg', `${helper}\nconst ctx=msg._subscriptionBooking;
    const lk1Fields=['maxActiveBookings','freeGameMinutesPerDay','gameOverageDiscountPercent','groupTrainingDiscountPercent','tournamentDiscountPercent'];
    const OUTPUT_MANAGED_POLICY=6; const emit=()=>msg;
    const lk1Stop=(_ctx,code)=>{throw new Error(code);}; ${usage}`);
  const op = operation();
  const rule = { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4,
    freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const consumed = doc => evaluateUsage({ payload: [doc], _subscriptionBooking: { ...binding(job()),
    step: 'lk1_usage_operations', serviceDate: op.serviceDate, managedAction: 'JOIN_GAME',
    lk1: { rule, target: op.lk1.target, bookings: [], activeBookings: [] } } })._managedSubscriptionPolicyInput.usage.usedOrReservedFreeMinutesToday;
  const cancelled = requestVisitReturn(debit(job()), cancellation(job()), now);
  const pending = { ...op, lk1: { ...op.lk1, visitJob: cancelled } };
  assert.equal(consumed(pending), 60, 'cancelled roster alone does not release free minutes');
  const sent = claimVisitMutation(cancelled, adapter, now).after;
  const returned = recordVisitOutcome(sent, 'RETURN', receipt(sent, 'RETURN'), now);
  pending.lk1.visitJob = returned;
  assert.equal(consumed(pending), 60, 'provider receipt still requires durable release ACK');
  assert.equal(apply(pending, releaseVisitAllowanceUpdate(returned, now)).matchedCount, 1);
  assert.equal(consumed(pending), 0, 'same-day free 60 restored after durable release');
  const rejoin = createSubscriptionVisitJob({ ...op, _id: 'fixture:new-operation', operationId: 'fixture:new-join', bookingId: 'fixture:new-booking' }, now);
  assert.notEqual(rejoin.id, returned.id); assert.equal(rejoin.phase, 'DEBIT_PENDING');
});

import { fixture } from './lk1FreeCancellationFixtures.mjs';
export function moneyFixture() {
  const f = fixture(), l = f.op.lk1;
  Object.assign(f.op, { state: 'RELEASED', category: 'open_game', releaseReason: 'RECONCILE_HUNG_DAILY_CLAIM',
    releasedAt: '2099-11-12T10:00:00Z', reconciliation: { source: 'hung_claim_reconciler', decision: 'SAFE_TO_RELEASE', observedState: 'CONFIRMED' } });
  Object.assign(l.target, { category: 'GAME', stationId: 'station' });
  l.decision.benefit.finalPriceMinor = 70000;
  Object.assign(l, { transactionId: 'transaction', transactionAttemptedAt: '2099-11-12T09:00:00Z',
    transactionIntent: { productId: 'service', bookingId: f.b.id, actorClientId: f.op.actorClientId,
      studioId: 'station', chargeMinor: 70000, discountMinor: 30000 },
    checkout: { transactionId: 'transaction', toPayMinor: 70000 } });
  Object.assign(f.b, { cancelled: true, isCancelled: true, visitConfirmed: false });
  Object.assign(f.sub, { status: 'ACTIVE', variant: 'BY_VISITS', visitsLeft: 29,
    bookings: [{ ...f.sub.bookings[1], exerciseDate: '2099-11-10T12:00:00Z' }] });
  f.subscriptions = { content: [f.sub], last: true, totalElements: 1 };
  f.tx = { id: 'transaction', client: { id: f.op.actorClientId }, status: 'UNPAID', toPay: 70000,
    createDate: '2099-11-12T09:00:00Z', paymentDueDate: '2099-11-12T09:25:00Z',
    products: [{ id: 'service', discount: 30000, paymentBookingIds: [f.b.id] }],
    cardPaymentInfo: { status: 'REJECTED', declineOutcome: 'EXPIRED' } };
  return f;
}

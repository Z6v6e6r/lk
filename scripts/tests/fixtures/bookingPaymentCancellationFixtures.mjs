import * as lifecycle from '../../lib/bookingPaymentAttempt.mjs';
export const at = Date.parse('2035-01-01T12:01:00Z'), createdAt = '2035-01-01T12:00:00Z';
export const cfg = { tenantKey: 'tenant', enabled: true, cohortFrom: '2035-01-01T00:00:00Z' };
export function fixture(native = true) {
  const input = { bookingId: 'booking', transactionId: 'transaction', gameId: 'game' };
  const payment = { ...input, clientId: 'actor', exerciseId: 'exercise', productId: 'product',
    operationId: 'ordinary-operation', paymentRef: 'ordinary-operation', amountMinor: 100000,
    paymentUrl: 'https://pay.example.test/checkout', status: 'PAYMENT_PENDING', createdAt };
  const headKey = 'booking-payment-head:' + JSON.stringify(['tenant', 'actor', ['EVENT', 'exercise']]);
  payment.paymentAttemptHeadKey = headKey;
  const op = { _id: 'lk1-product:' + JSON.stringify(['tenant', 'actor', 'native-operation']),
    tenantKey: 'tenant', actorClientId: 'actor', operationId: 'native-operation', bookingId: 'booking',
    clientSubscriptionId: 'subscription', state: 'CONFIRMED', exerciseId: 'exercise', category: 'open_game', createdAt,
    lk1: { rule: { productId: 'plan' }, fingerprint: 'fingerprint', transactionId: 'transaction',
      transactionAttemptedAt: createdAt, decision: { subscriptionVisitCount: 0, benefit: { finalPriceMinor: 100000 } },
      target: { eventId: 'exercise', category: 'GAME', stationId: 'station' },
      checkout: { transactionId: 'transaction', toPayMinor: 100000, paymentUrl: payment.paymentUrl,
        ...lifecycle.paymentAttemptCheckout({ createDate: createdAt }, createdAt) },
      transactionIntent: { bookingId: 'booking', actorClientId: 'actor', productId: 'product', studioId: 'station', chargeMinor: 100000 } } };
  const head = { _id: headKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: 'tenant', actorClientId: 'actor',
    phase: 'PAYMENT_REQUIRED', operationId: payment.operationId, createdAt, payment };
  const game = { _id: 'mongo-game', id: 'game', tenantKey: 'tenant', revision: 1, status: 'CREATED',
    settings: { payMode: 'split' }, booking: { exerciseId: 'exercise' },
    metadata: { splitPayment: { enabled: true, vivaExerciseId: 'exercise', payments: [payment] } }, participants: [], waitlist: [] };
  return { input, op, head, game, docs: new Map((native ? [op] : [head]).map(d => [d._id, structuredClone(d)])) };
}

export const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
export const now = Date.parse('2035-01-01T09:00:00Z');
export function fixture(amount = 0) {
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

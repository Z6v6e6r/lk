import { lk1FreeNativeOperation, lk1FreeBinding, lk1FreeBooking, lk1FreeSubscription } from './lk1FreeCancellation.mjs';

// A compatibility readback proves current non-consumption, never a historical
// SERVICE refund. It is request-local and cannot authorize any provider write.
export function lk1LegacyCancellationCandidate(op) {
  return lk1FreeNativeOperation(op) && op.state === 'RELEASED'
    && typeof op.releasedAt === 'string' && Number.isFinite(Date.parse(op.releasedAt))
    && typeof op.updatedAt === 'string' && Number.isFinite(Date.parse(op.updatedAt))
    && op.releaseBookingId === op.bookingId && Array.isArray(op.releasedBookingIds)
    && op.releasedBookingIds.includes(op.bookingId)
    && op.releaseReason === undefined && op.releaseSource === undefined
    && op.releaseOperationId === undefined && op.reconciliation === undefined
    && op.lk1.freeCancellationReturn === undefined && op.lk1.unpaidCancellation === undefined;
}
export function lk1LegacyCancellationSnapshot(op) {
  // Include all stored fields: an intervening change invalidates the readback.
  return JSON.stringify(op);
}
export function lk1LegacyCancellationReadback(op, booking, subscriptions) {
  if (!lk1LegacyCancellationCandidate(op)) return null;
  const binding = lk1FreeBinding(op);
  if (lk1FreeBooking(booking, binding)?.cancelled !== true) return null;
  const snapshot = lk1FreeSubscription(subscriptions, binding, op.lk1.rule.productId);
  if (!snapshot || snapshot.left < 1 || snapshot.targetPresent !== false) return null;
  const rows = Array.isArray(subscriptions) ? subscriptions : subscriptions.content;
  const sub = rows.find(row => row.subscriptionId === binding.clientSubscriptionId);
  // Scoped DTOs may omit identity fields, but present aliases must agree.
  const agrees = (values, expected) => values.every(v => v == null || v === expected);
  if (!agrees([sub.id, sub.clientSubscriptionId], binding.clientSubscriptionId)
    || !agrees([sub.clientId, sub.client?.id, sub.client?.clientId], binding.actorClientId)
    || sub.bookings.some(row => !agrees([row.clientId, row.client?.id, row.client?.clientId], binding.actorClientId)
      || !agrees([row.clientSubscriptionId, row.clientSubscription?.id], binding.clientSubscriptionId)
      || (row.exerciseId && row.exercise?.id && row.exerciseId !== row.exercise.id))) return null;
  return snapshot;
}

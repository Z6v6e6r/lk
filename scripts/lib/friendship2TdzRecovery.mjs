import crypto from 'node:crypto';

export const FRIENDSHIP2_PRODUCT = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
export const TDZ_INCIDENT_START = '2026-11-11T21:48:29.000Z';
export const TDZ_RECOVERY_SOURCE = 'friendship2_tdz_recovery_20261112';
export const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const instant = value => typeof value === 'string' ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + '+03:00') : NaN;
const localDay = value => Number.isFinite(instant(value)) ? new Date(instant(value) + 180 * 60000).toISOString().slice(0, 10) : null;
const id = value => value?.id ?? value;
const present = (value, key) => Object.hasOwn(value || {}, key);
const rootEffects = ['bookingId', 'upstreamBookingId', 'upstreamAttemptedAt', 'acceptedAt', 'correlationId',
  'transactionId', 'visitJob', 'createAttemptedAt', 'managedEntitlementOperationId', 'managedSubscriptionInstanceId',
  'activationState', 'managedJoinV2', 'lk2LegacyJoin'];
const quoteEffects = ['createAttemptedAt', 'bookingAttemptedAt', 'transactionAttemptedAt',
  'transactionId', 'transactionIntent', 'checkout', 'visitJob', 'freeCancellationReturn', 'unpaidCancellation'];
export const hasTdzRecoveryEffects = operation => rootEffects.some(key => present(operation, key))
  || quoteEffects.some(key => present(operation?.lk1, key));
export const dailyGuardKey = operation => `lk1-daily-visit:${JSON.stringify([
  operation.tenantKey, operation.clientSubscriptionId.toLowerCase(), operation.serviceDate,
])}`;

function complete(evidence, scope, now) {
  return record(evidence) && evidence.complete === true && evidence.scope === scope
    && Array.isArray(evidence.rows) && evidence.rows.length < 10000
    && Number.isFinite(instant(evidence.observedAt)) && instant(evidence.observedAt) <= now
    && now - instant(evidence.observedAt) <= 60_000;
}
function cancelled(value) {
  const flags = [value.isCancelled, value.cancelled, value.canceled].filter(v => v !== undefined);
  if (!flags.length || flags.some(v => typeof v !== 'boolean') || new Set(flags).size !== 1) return null;
  return flags[0];
}
const money = booking => booking.amountDue?.paidKopecks === 0 && booking.amountDue?.dueKopecks === 0
  && booking.amountDue?.surchargeKopecks === 0 && Array.isArray(booking.receipts) && booking.receipts.length === 0;

// This rejects an obsolete local quote; it never creates/confirms a provider
// booking, debits a visit, invents an upstream attempt, or fabricates a return.
// The existing daily-visit retry protocol rechecks identity, subscription,
// target, usage and price on the next authenticated request of the SAME id.
export function planFriendship2TdzRecovery({ operation: op, subscription, target, guard, now, incidentEnd }) {
  const hold = reason => ({ recoverable: false, reason });
  const at = instant(now), end = instant(incidentEnd);
  if (!Number.isFinite(at) || !Number.isFinite(end) || end > at || end < Date.parse(TDZ_INCIDENT_START)) return hold('INCIDENT_WINDOW_INVALID');
  if (!record(op) || !record(op.lk1) || !record(op.lk1.rule) || !record(op.lk1.target)
    || op.tenantKey !== 'iSkq6G' || op.lk1.rule.productId !== FRIENDSHIP2_PRODUCT
    || ![op._id, op.actorClientId, op.clientSubscriptionId, op.operationId, op.exerciseId, op.serviceDate, op.lk1.fingerprint].every(text)
    || op._id !== `lk1-product:${JSON.stringify([op.tenantKey, op.actorClientId, op.operationId])}`
    || !['open_game', 'tournament', 'group_training'].includes(op.category)
    || !['PREPARED', 'RELEASED'].includes(op.state)
    || op.state === 'RELEASED' && op.releaseReason !== 'RECONCILE_HUNG_DAILY_CLAIM') return hold('OPERATION_OUTSIDE_SCOPE');
  if (!(Date.parse(op.createdAt) >= Date.parse(TDZ_INCIDENT_START) && Date.parse(op.createdAt) <= end)
    || !Number.isFinite(Date.parse(op.updatedAt)) || Date.parse(op.updatedAt) > at || at - Date.parse(op.updatedAt) < 60_000) return hold('OPERATION_WINDOW_OR_INFLIGHT');
  if (hasTdzRecoveryEffects(op)) return hold('RECORDED_EFFECT_REQUIRES_RECONCILIATION');
  if (op.incidentRecovery !== undefined) return hold('ALREADY_RECOVERED');
  if (op.lk1.decision?.eligible !== true || op.lk1.decision.subscriptionVisitCount !== 1
    || op.lk1.decision.benefit?.finalPriceMinor !== 0 || op.lk1.dailyVisitPolicyVersion !== 1
    || op.serviceDate !== localDay(op.lk1.target.startsAt)) return hold('QUOTE_INVALID');
  if (!record(guard) || guard.complete !== true || guard.scope !== dailyGuardKey(op)
    || !Number.isFinite(instant(guard.observedAt)) || at - instant(guard.observedAt) < 0
    || at - instant(guard.observedAt) > 60_000 || !Array.isArray(guard.rows)) return hold('GUARD_EVIDENCE_UNAVAILABLE');
  if (guard.rows.length > 1 || guard.rows.some(row => row.ownerOperationKey === op._id)) return hold('DAILY_GUARD_OWNED_OR_AMBIGUOUS');
  if (!complete(subscription, op.actorClientId, at)) return hold('SUBSCRIPTION_EVIDENCE_UNAVAILABLE');
  const instances = subscription.rows.filter(row => row.subscriptionId === op.clientSubscriptionId);
  if (instances.length !== 1) return hold('SUBSCRIPTION_IDENTITY');
  const sub = instances[0];
  if (sub.product?.id !== FRIENDSHIP2_PRODUCT || sub.status !== 'ACTIVE'
    || !Number.isSafeInteger(sub.visitsLeft) || !Number.isSafeInteger(sub.visitsTotal)
    || sub.visitsLeft < 0 || sub.visitsLeft > sub.visitsTotal || !Array.isArray(sub.bookings)
    || sub.bookings.length !== sub.visitsTotal - sub.visitsLeft
    || new Set(sub.bookings.map(row => row.id)).size !== sub.bookings.length
    || sub.bookings.some(row => !text(row.id) || row.clientSubscriptionId !== op.clientSubscriptionId
      || row.client?.id !== op.actorClientId || row.paymentType !== 'SUBSCRIPTION')) return hold('SUBSCRIPTION_CONSUMPTION_UNRESOLVED');
  const creating = record(op.lk1.createPayload), expectedScope = creating ? op.serviceDate : op.exerciseId;
  if (!complete(target, expectedScope, at)) return hold('TARGET_EVIDENCE_UNAVAILABLE');
  const outcome = 'RETRY_REQUIRES_FRESH_QUOTE';
  if (creating) {
    const t = op.lk1.target, start = instant(t.startsAt), endAt = start + t.durationMinutes * 60000;
    if (op.exerciseId !== `preflight:${op.operationId}` || !Number.isFinite(endAt)
      || !(Number.isSafeInteger(t.durationMinutes) && t.durationMinutes > 0)
      || op.lk1.createPayload.roomId !== t.roomId
      || instant(op.lk1.createPayload.timeFrom) !== start || instant(op.lk1.createPayload.timeTo) !== endAt) return hold('CREATE_INTENT_UNRESOLVED');
    const relevant = target.rows.filter(row => id(row.room) === t.roomId && id(row.studio) === t.stationId);
    if (relevant.some(row => cancelled(row) === null || !Number.isFinite(instant(row.timeFrom)) || !Number.isFinite(instant(row.timeTo)))) return hold('CALENDAR_ROW_UNRESOLVED');
    if (relevant.some(row => !cancelled(row) && instant(row.timeFrom) < endAt && instant(row.timeTo) > start)) return hold('CREATE_SLOT_OCCUPIED');
    if (sub.bookings.some(row => !cancelled(row) && id(row.room) === t.roomId
      && instant(row.exerciseDate) < endAt && instant(row.exerciseDateTo) > start)) return hold('CREATE_CONSUMPTION_OVERLAP');
  } else {
    if (op.lk1.target.eventId !== op.exerciseId) return hold('TARGET_IDENTITY');
    const matches = target.rows.filter(row => row.client?.id === op.actorClientId || row.clientId === op.actorClientId);
    if (matches.some(row => cancelled(row) === null) || matches.filter(row => !cancelled(row)).length > 1) return hold('BOOKING_AMBIGUOUS');
    const existing = matches.find(row => !cancelled(row));
    if (existing) {
      if (existing.clientSubscriptionId !== op.clientSubscriptionId || existing.paymentType !== 'SUBSCRIPTION'
        || !money(existing) || sub.bookings.filter(row => row.id === existing.id && row.exerciseId === op.exerciseId).length !== 1) return hold('EXISTING_BOOKING_REQUIRES_RECONCILIATION');
      // The goal is already satisfied, but this does not prove which request
      // owns that booking. Do not reopen a stale id into a possible money leg.
      return hold('ALREADY_BOOKED_IN_VIVA_NO_REPLAY');
    } else if (sub.bookings.some(row => row.exerciseId === op.exerciseId && !cancelled(row))) return hold('CONSUMPTION_WITHOUT_TARGET_BINDING');
  }
  const proof = { schemaVersion: 1, source: TDZ_RECOVERY_SOURCE, decision: 'OBSOLETE_LOCAL_QUOTE_REJECTED',
    cause: 'LK1_PREWRITE_RUNTIME_INTERRUPTED', outcome, verifiedAt: now,
    incidentEnd, operationDigest: digest(op), previousState: op.state, previousAttempts: op.attempts,
    previousRelease: op.state === 'RELEASED' ? { releasedAt: op.releasedAt, releaseReason: op.releaseReason, reconciliation: op.reconciliation } : null,
    evidenceDigest: digest({ subscription, target, guard }), providerWrites: 0 };
  const query = Object.fromEntries(Object.entries(op).map(([key, value]) => [key, { $eq: value }]));
  // Also fence new fields added by a concurrent continuation that did not bump
  // updatedAt. Every existing root field above is compared including all lk1.
  query.$expr = { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, Object.keys(op).length] };
  return { recoverable: true, outcome, command: { query, update: { $set: {
    state: 'FAILED', failedAt: now, updatedAt: now,
    failure: { statusCode: 409, rawCode: 'LK1_DAILY_VISIT_CHANGED', cause: proof.cause,
      message: 'Старая попытка прервана до записи. Требуется заново проверить стоимость и дневное посещение.' },
    incidentRecovery: proof,
  }, $unset: { leaseUntil: '', pendingUntil: '', precreateLeaseUntil: '', releasedAt: '', releaseReason: '', reconciliation: '' } },
  options: { writeConcern: { w: 'majority', j: true } } }, proof };
}

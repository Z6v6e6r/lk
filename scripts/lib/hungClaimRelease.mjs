// Guarded release of hung subscription booking claims.
//
// A claim in `lk_subscription_daily_booking_ops` is the reservation of one daily
// subscription seat: while it is not terminal it counts as consumed free minutes
// and, once bound to a provider booking, as an active service. The runtime
// releases a claim when the request path observes the exact cancellation or an
// expired pending claim with no active provider booking — but only for a request
// that is being made for that same subscription instance. A claim whose request
// ended before the provider readback, or that was written without a deadline,
// therefore stays non-terminal and keeps consuming the limit indefinitely.
//
// This module provides the decision and the command builder for an out-of-band
// reconciler that closes that window after a bounded time. It is pure: no I/O, no
// provider client, no clock of its own. Every guard has its own reason code so an
// operator can distinguish a claim that is still inside its window from one that
// is already terminal or provider-bound.

export const RELEASE_REASON = 'RECONCILE_HUNG_DAILY_CLAIM';

/** Claim states the reconciler may release once the provider proves nothing is live. */
export const HUNG_CLAIM_STATES = Object.freeze([
  'PREPARED',
  'PENDING_CONFIRMATION',
]);

/**
 * States the runtime deliberately keeps blocked beyond their lease: an accepted
 * PRECREATE may already have created the game, so only a manual, game-side
 * reconciliation may release them. The scan reports them and never writes.
 */
export const AUDIT_ONLY_CLAIM_STATES = Object.freeze([
  'PRECREATE_RESERVING',
  'PRECREATE_RESERVED',
  'PRECREATE_ATTEMPTING',
  'PRECREATE_RECONCILIATION_REQUIRED',
]);

/** Terminal states that never consume a limit (mirrors the runtime usage reader). */
export const TERMINAL_CLAIM_STATES = Object.freeze(['CONFIRMED', 'FAILED', 'RELEASED']);

export const DEFAULT_HUNG_CLAIM_TTL_MS = 30 * 60 * 1000;
export const WRITE_OPTIONS = Object.freeze({ writeConcern: { w: 'majority', j: true } });

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const parseTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};
export const normalizeId = (value) => (toStr(value) || '').toLowerCase();

/** Provider booking id carried by a claim, if the claim is bound to a real booking. */
export const claimBookingId = (operation) => toStr(operation?.bookingId) || toStr(operation?.upstreamBookingId);

/**
 * Latest deadline a claim declares for itself, else the observed write time plus the
 * configured TTL. `pendingUntil` is written by the daily gateway; HUB claims carry
 * `leaseUntil` while they are still PREPARED. Returns null when the record has no
 * usable evidence at all — such a claim is never released automatically.
 */
export function hungClaimDeadlineTs(operation, { ttlMs = DEFAULT_HUNG_CLAIM_TTL_MS } = {}) {
  for (const field of ['pendingUntil', 'leaseUntil', 'precreateLeaseUntil']) {
    const explicit = parseTs(operation?.[field]);
    if (explicit !== null) return explicit;
  }
  const observed = parseTs(operation?.updatedAt) ?? parseTs(operation?.createdAt);
  return observed === null ? null : observed + ttlMs;
}

/** Provider client id of a Viva booking row. */
export const bookingClientId = (booking) => toStr(
  booking?.clientId || booking?.client?.id || booking?.client?.clientId
  || booking?.playerId || booking?.userId,
);

/** Provider subscription id of a Viva booking row. */
export const bookingSubscriptionId = (booking) => {
  const nested = booking?.subscription || booking?.clientSubscription;
  return toStr(
    booking?.clientSubscriptionId || booking?.subscriptionId || booking?.clientSubId
    || nested?.clientSubscriptionId || nested?.subscriptionId || nested?.id || nested?.uuid,
  );
};

/** Booking id of a Viva booking row. */
export const bookingId = (value) => toStr(value?.id || value?.bookingId || value?.uuid);

/** A booking row the provider still reports as live. */
export function isActiveBooking(value) {
  if (!value || typeof value !== 'object') return false;
  const nested = value?.exercise;
  if (value.isCancelled === true || value.cancelled === true || value.canceled === true
    || value.archived === true || toStr(value.cancellationDate) || toStr(value.cancelledAt)
    || nested?.isCancelled === true || nested?.cancelled === true || nested?.canceled === true
    || nested?.archived === true) return false;
  return ![value.status, value.state, value.bookingStatus, value.transactionStatus?.transactionStatus,
    nested?.status, nested?.state]
    .some((status) => /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|ARCHIVE|REMOV/i.test(String(status || '')));
}

/** Provider rows of one exercise readback, whatever envelope the admin API returned. */
export function extractBookingRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['content', 'items', 'records', 'bookings', 'data']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return null;
}

/** Page size this reconciler requests from the provider, and therefore its truncation bound. */
export const PROVIDER_PAGE_SIZE = 200;

/**
 * Rows of one exercise readback only when the payload proves the list is complete.
 * Mirrors the runtime's own completeness rule and additionally refuses a bare array
 * that fills the requested page, because a truncated list could hide the very booking
 * this decision has to see. Returns null when completeness cannot be proven.
 */
export function readCompleteBookingRows(value, { pageSize = PROVIDER_PAGE_SIZE } = {}) {
  if (Array.isArray(value)) return value.length >= pageSize ? null : value;
  if (!value || typeof value !== 'object') return null;
  const rows = extractBookingRows(value);
  if (!rows) return null;
  const total = Number(value.totalElements ?? value.totalCount);
  const page = Number(value.number ?? value.page);
  const totalPages = Number(value.totalPages);
  if (Number.isFinite(total) && total > rows.length) return null;
  if (value.last === false || value.hasNext === true) return null;
  if (Number.isFinite(page) && Number.isFinite(totalPages) && page + 1 < totalPages) return null;
  if (rows.length >= pageSize) return null;
  return rows;
}

/**
 * Marks of a claim that already attempted a provider CREATE. An accepted CREATE may
 * have created the game even when no booking id was recorded, so the runtime never
 * resolves such a claim by TTL alone; the reconciler keeps the same rule and lists
 * these claims for a game-side manual reconciliation instead.
 */
export const CREATE_ATTEMPT_FIELDS = Object.freeze([
  'lk1.createAttemptedAt',
  'lk1.bookingAttemptedAt',
  'createAttemptedAt',
]);

/** True when the claim carries any recorded create attempt. */
export function hasCreateAttempt(operation) {
  return CREATE_ATTEMPT_FIELDS.some((field) => {
    const [head, tail] = field.split('.');
    return tail ? toStr(operation?.[head]?.[tail]) : toStr(operation?.[head]);
  });
}

/**
 * Decide one claim. `bookings` is the provider readback for the claim's exercise:
 * pass the parsed admin payload (array or `content`/`items` envelope), or null when
 * the provider could not be read — a missing readback never releases.
 *
 * Returns { releasable, reason, deadline, actorClientId, clientSubscriptionId }.
 */
export function planHungClaimRelease({ operation, bookings, now, ttlMs = DEFAULT_HUNG_CLAIM_TTL_MS }) {
  const nowTs = parseTs(now);
  const base = {
    operationKey: toStr(operation?._id),
    operationId: toStr(operation?.operationId),
    state: toStr(operation?.state),
    serviceDate: toStr(operation?.serviceDate),
    actorClientId: toStr(operation?.actorClientId),
    clientSubscriptionId: toStr(operation?.clientSubscriptionId),
    exerciseId: toStr(operation?.exerciseId),
    deadline: null,
    reason: null,
  };
  const deny = (reason, deadline = null) => ({ ...base, deadline, releasable: false, reason });
  if (!nowTs) return deny('NOW_UNRESOLVED');
  if (!operation || typeof operation !== 'object') return deny('OPERATION_INVALID');
  if (AUDIT_ONLY_CLAIM_STATES.includes(base.state)) return deny('STATE_REQUIRES_MANUAL_RECONCILIATION');
  if (!HUNG_CLAIM_STATES.includes(base.state)) {
    return deny(TERMINAL_CLAIM_STATES.includes(base.state) ? 'STATE_TERMINAL' : 'STATE_NOT_HUNG');
  }
  if (claimBookingId(operation)) return deny('PROVIDER_BOOKING_BOUND');
  if (hasCreateAttempt(operation)) return deny('CREATE_ATTEMPT_REQUIRES_MANUAL_RECONCILIATION');
  if (!base.actorClientId || !base.clientSubscriptionId) return deny('IDENTITY_UNRESOLVED');
  const deadlineTs = hungClaimDeadlineTs(operation, { ttlMs });
  const deadline = deadlineTs === null ? null : new Date(deadlineTs).toISOString();
  if (deadlineTs === null) return deny('DEADLINE_MISSING');
  if (deadlineTs > nowTs) return deny('DEADLINE_NOT_REACHED', deadline);
  const rows = readCompleteBookingRows(bookings);
  if (!rows) {
    return deny(Array.isArray(bookings) || bookings ? 'PROVIDER_EVIDENCE_INCOMPLETE' : 'PROVIDER_EVIDENCE_MISSING', deadline);
  }
  if (!base.exerciseId) return deny('EXERCISE_ID_MISSING', deadline);
  const actor = normalizeId(base.actorClientId);
  const subscription = normalizeId(base.clientSubscriptionId);
  const actorRows = rows.filter((row) => row && typeof row === 'object'
    && normalizeId(bookingClientId(row)) === actor);
  // A live row of this actor whose subscription cannot be resolved proves neither
  // ownership nor absence: the runtime holds such a claim too, so it is never
  // released by the reconciler.
  if (actorRows.some((row) => isActiveBooking(row) && !bookingSubscriptionId(row))) {
    return deny('PROVIDER_SUBSCRIPTION_ID_UNRESOLVED', deadline);
  }
  if (actorRows.some((row) => isActiveBooking(row)
    && normalizeId(bookingSubscriptionId(row)) === subscription)) {
    return deny('PROVIDER_BOOKING_ACTIVE', deadline);
  }
  return { ...base, deadline, releasable: true, reason: null };
}

/**
 * Compare-and-swap that moves one hung claim to RELEASED. The query repeats the
 * observed state and write time, so a concurrent request path or another reconciler
 * can never have its own transition overwritten.
 */
export function buildHungClaimReleaseCommand({ operation, now }) {
  const nowIso = new Date(parseTs(now)).toISOString();
  return {
    query: {
      _id: operation._id,
      operationId: operation.operationId,
      state: operation.state,
      updatedAt: operation.updatedAt,
    },
    update: {
      $set: {
        state: 'RELEASED',
        releasedAt: nowIso,
        releaseReason: RELEASE_REASON,
        reconciliation: {
          source: 'hung_claim_reconciler',
          decision: 'SAFE_TO_RELEASE',
          reconciledAt: nowIso,
          observedState: operation.state,
          observedUpdatedAt: operation.updatedAt ?? null,
        },
        updatedAt: nowIso,
      },
      $unset: { pendingUntil: '', leaseUntil: '', precreateLeaseUntil: '' },
    },
    options: WRITE_OPTIONS,
  };
}

/** Audit-only view: every claim of a scan with the reason it was or was not released. */
export function summarizeHungClaims({ operations, bookingsByExercise, now, ttlMs = DEFAULT_HUNG_CLAIM_TTL_MS }) {
  const decisions = (Array.isArray(operations) ? operations : []).map((operation) => {
    const exerciseId = toStr(operation?.exerciseId);
    const key = exerciseId ? normalizeId(exerciseId) : '';
    const bookings = bookingsByExercise instanceof Map ? bookingsByExercise.get(key) : null;
    return planHungClaimRelease({ operation, bookings, now, ttlMs });
  });
  const byReason = {};
  for (const decision of decisions) {
    const reason = decision.reason ?? 'RELEASABLE';
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return { total: decisions.length, releasable: decisions.filter((item) => item.releasable), byReason, decisions };
}

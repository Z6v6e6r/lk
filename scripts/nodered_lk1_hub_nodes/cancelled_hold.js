// Executed inside the shared booking/preview usage step, after the zero-visit rule
// (ADR 0004). A CONFIRMED operation without money side effects stops holding the
// daily visit and free minutes once the same fresh (<= 60 s) self-API receipt proves
// its bound booking explicitly cancelled, whoever cancelled it. The receipt check is
// the zero-visit implementation itself, applied without its category/visit gate, so
// the provider proof has one implementation. Missing or stale evidence keeps the hold.
const lk1CancelledProviderHold = (operation) => {
  const lk1 = operation?.lk1, decision = lk1?.decision;
  if (operation?.state !== "CONFIRMED" || !isObj(lk1) || !isObj(decision)
    || ![0, 1].includes(decision.subscriptionVisitCount)
    || decision.benefit?.finalPriceMinor !== 0
    || ![undefined, null, 0].includes(decision.gameMinutes?.paidOverageMinutes)
    || ![undefined, null, 0].includes(decision.courtMinutes?.paidOverageMinutes)
    || operation.serviceDate !== ctx.serviceDate || lk1ReplacementBookingToday(operation)
    || lk1.visitJob || operation.visitJob || operation.transactionId
    || ["transactionAttemptedAt", "transactionId", "transactionIntent", "checkout"].some(key => lk1[key] != null)
    || operation.managedEntitlementOperationId || operation.managedSubscriptionInstanceId
    || operation.activationState === "PENDING") return false;
  return lk1CancelledZeroVisitOperation({ ...operation, category: "group_training",
    lk1: { ...lk1, decision: { ...decision, subscriptionVisitCount: 0, gameMinutes: undefined, courtMinutes: undefined } } });
};
// A Viva booking on the same day that no LK operation of this list owns (an admin moved
// the client to another session, say) may be the real visit. Without exact proof that it
// belongs to another subscription, the cancelled operation keeps holding the day.
const lk1ReplacementBookingToday = (operation) => {
  const owned = new Set(msg.payload.filter(item => isObj(item) && !["FAILED", "RELEASED"].includes(item.state))
    .flatMap(item => [item.bookingId, item.upstreamBookingId])
    .filter(value => typeof value === "string").map(normalizeId).filter(Boolean));
  return relevantBookings.some(booking => {
    if (!isObj(booking)) return true;
    if (isInactiveBooking(booking) || (eventDate(booking) && eventDate(booking) !== operation.serviceDate)) return false;
    const ids = [booking.id, booking.bookingId, booking.clientBookingId, bookingId(booking)]
      .filter(value => typeof value === "string").map(normalizeId).filter(Boolean);
    if (ids.some(id => owned.has(id))) return false;
    const sub = normalizeId(bookingSubscriptionId(booking));
    return !sub || sub === normalizeId(ctx.clientSubscriptionId);
  });
};
// The guard step runs after the receipt is gone: remember the exact owner documents
// this request proved cancelled, for the daily-visit takeover only.
const lk1RememberCancelledHold = (operation) => {
  ctx.lk1CancelledHolds = { ...(isObj(ctx.lk1CancelledHolds) ? ctx.lk1CancelledHolds : {}),
    // Proof age is the receipt's own observation time, so the takeover stays within 60 s of it.
    [operation._id]: { owner: JSON.stringify(operation), observedAt: Date.parse(ctx.lk1.cancellationSnapshot?.observedAt) } };
};

// Executed inside the shared booking/preview usage step. A missing or stale
// receipt preserves the reservation; absence and payment failure prove nothing.
const lk1CancelledZeroVisitOperation = (operation) => {
  const visitsLeft = ctx.lk1ProductIdentity?.subscription?.visitsLeft
    ?? ctx.lk1MoneyOwnership?.subscription?.visitsLeft;
  const cancelledSeat = operation.lk1?.decision?.subscriptionVisitCount === 1
    && operation.lk1?.decision?.benefit?.finalPriceMinor === 0
    && Number.isSafeInteger(visitsLeft) && visitsLeft >= 1;
  const snapshot = ctx.lk1.cancellationSnapshot;
  const observed = Date.parse(snapshot?.observedAt);
  const updated = Date.parse(operation.updatedAt);
  if (operation.state !== "CONFIRMED" || !(cancelledSeat
    ? ["group_training", "tournament", "open_game"].includes(operation.category)
    : ["group_training", "tournament"].includes(operation.category))
    || (operation.lk1?.decision?.subscriptionVisitCount !== 0 && !cancelledSeat) || operation.lk1?.visitJob
    || [operation.lk1?.decision?.gameMinutes, operation.lk1?.decision?.courtMinutes]
      .some(value => value && value.freeMinutes !== 0)
    || !Number.isFinite(observed) || !Number.isFinite(updated) || updated > observed
    || observed > Date.now() || Date.now() - observed > 60_000
    || !Array.isArray(snapshot.active) || !Array.isArray(snapshot.history)
    || typeof operation.bookingId !== "string" || !normalizeId(operation.bookingId)
    || !normalizeId(operation.exerciseId)) return false;
  const id = normalizeId(operation.bookingId);
  const rows = snapshot.active.concat(snapshot.history).filter(row =>
    [row?.id, row?.bookingId, row?.clientBookingId].some(value => normalizeId(value) === id));
  if (!rows.length) return false;
  return rows.every(row => {
    if (!isObj(row)) return false;
    const ids = [row.id, row.bookingId, row.clientBookingId];
    const owners = [row.clientId, row.actorClientId, row.profileId, row.client?.id];
    const exercises = [row.exerciseId, row.exercise?.id, row.exercise?.exerciseId];
    const subscriptions = [row.clientSubscriptionId, row.subscriptionId, row.clientSubId,
      row.subscription?.id, row.clientSubscription?.id];
    const present = values => values.filter(value => value !== undefined && value !== null && value !== "");
    const agrees = (values, expected) => present(values).every(value =>
      typeof value === "string" && normalizeId(value) === normalizeId(expected));
    if (!agrees(ids, operation.bookingId) || !agrees(owners, ctx.actorClientId)
      || !present(exercises).length || !agrees(exercises, operation.exerciseId)
      || !agrees(subscriptions, operation.clientSubscriptionId)
      || eventDate(row) !== operation.serviceDate) return false;
    // Self-API receipts already bind the actor even when the provider omits it
    // on individual rows. Every present alias still has to agree.
    const flags = present([row.isCancelled, row.cancelled, row.canceled]);
    const statuses = present([row.status, row.bookingStatus, row.state]);
    return (flags.length > 0 || statuses.length > 0)
      && flags.every(value => value === true)
      && statuses.every(value => typeof value === "string"
        && ["CANCELLED", "CANCELED"].includes(value.trim().toUpperCase()));
  });
};

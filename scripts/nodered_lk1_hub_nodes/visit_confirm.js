const lk1NeedsVisitJob = (ctx) => ctx.managedAction === "JOIN_GAME"
  && ctx.lk1?.decision?.subscriptionVisitCount === 1
  && ctx.lk1.decision.benefit.finalPriceMinor > 0;
const prepareVisitConfirmedUpdate = (ctx, booking) => {
  const now = new Date().toISOString();
  ctx.confirmedBookingId = bookingId(booking);
  ctx.confirmedSpot = Number(booking?.spot) || ctx.spot || null;
  try {
    const projected = { _id: ctx.operationKey, operationId: ctx.operationId,
      tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
      clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId,
      bookingId: ctx.confirmedBookingId, serviceDate: ctx.serviceDate,
      action: "JOIN_GAME", bookingPaymentType: "ON_PLACE", state: "CONFIRMED", lk1: ctx.lk1 };
    const command = __subscriptionVisitLifecycle.initialVisitJobUpdate(projected, now);
    if (!command) return lk1Stop(ctx, "LK1_VISIT_JOB_ALREADY_BOUND");
    command.update.$set.action = "JOIN_GAME";
    command.update.$set.bookingPaymentType = "ON_PLACE";
    ctx.lk1.visitJob = command.update.$set["lk1.visitJob"];
    return prepareMongoUpdate(ctx, "operation_confirm", command.query, command.update);
  } catch (_) { return lk1Stop(ctx, "LK1_VISIT_JOB_BINDING_INVALID"); }
};

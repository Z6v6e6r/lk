if (ctx?.step === "lk1_tariff_required" && responseStatus === 200 && payload.state === "LK1_TARIFF_REQUIRED"
  && ["split", "split_create_readonly_preflight"].includes(ctx.caller)) {
  msg._splitCtx = { ...msg._splitCtx, step: "lk1_tariff_required", userAuthHeader: ctx.authHeader };
  delete msg._subscriptionBooking;
  return [msg, null];
}
if (ctx?.lk1) {
  const split = msg._splitCtx;
  const ack = ctx.lk1CreateAck;
  if (ctx.caller === "split" && ctx.lk1BeforeCreate === true && ctx.step === "lk1_create_attempt_saved"
    && responseStatus === 200 && payload.state === "LK1_CREATE_ATTEMPT_BOUND"
    && ack?.operationId === ctx.operationId && ack.operationKey === ctx.operationKey
    && ack.fingerprint === ctx.lk1.fingerprint && ack.actorClientId === ctx.actorClientId
    && ack.createAttemptedAt === ctx.lk1.createAttemptedAt
    && split?.subscriptionCreatePreflightDone === true && !split.exerciseId
    && split.lk1ReadOnlyApproval?.actorClientId === ctx.actorClientId
    && split.operationId === ctx.operationId && payload.operationId === ctx.operationId
    && split.clientSubscriptionId === ctx.clientSubscriptionId
    && JSON.stringify(split.lk1ReadOnlyApproval.createPayload) === JSON.stringify(ack.createPayload)) {
    msg._splitCtx = { ...split, step: "subscription_create_preflight_complete",
      lk1CreateBinding: { operationKey: ctx.operationKey, fingerprint: ctx.lk1.fingerprint } };
    // Keep the exact successful CAS continuation until split consumes it once.
    return [msg, null];
  }
  if (ctx.step === "lk1_payment_products" && responseStatus === 200) {
    const splitCtx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : {};
    Object.assign(splitCtx, { step: "available_products", clientId: ctx.actorClientId,
      clientPhone: ctx.actorPhone, studioId: ctx.studioId, bookingId: ctx.confirmedBookingId,
      exerciseId: ctx.exerciseId, selectedPaymentMode: "one_time", paymentMode: "one_time",
      paymentMethod: "SMS", oneTimeBaseAmount: 10000, durationMinutes: ctx.lk1.target.durationMinutes,
      lk1Checkout: { fingerprint: ctx.lk1.fingerprint,
        finalPriceMinor: ctx.lk1.decision.benefit.finalPriceMinor } });
    msg._splitCtx = splitCtx;
    // Retain the request context: split only serializes the money leg; the
    // existing gateway persists the one-shot attempt before the provider POST.
    return [msg, null];
  }
  if (payload.state === "CONFIRMED" && ctx.caller === "split") {
    msg._splitCtx = { ...msg._splitCtx, step: "lk1_checkout_complete" };
    return [msg, null];
  }
  if (responseStatus >= 400 || payload.state !== "CONFIRMED") {
    msg.statusCode = 202;
    msg.payload = { ok: true, state: "PENDING_CONFIRMATION", operationId: ctx.operationId,
      details: payload.details || { code: "LK1_BOOKING_PAYMENT_RECONCILIATION_REQUIRED" } };
  }
  return [null, msg];
}

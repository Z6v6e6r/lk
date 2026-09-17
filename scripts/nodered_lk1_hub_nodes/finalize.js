if (ctx?.lk1IngressReplay === true) {
  // An ingress retry ends here, including readonly CREATE. Never re-enter
  // preflight success or split's write-capable CREATE/checkout path.
  if (responseStatus === 200 && payload.state === "CONFIRMED" && ctx.lk1) {
    const split = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : {};
    const checkout = ctx.lk1 && typeof ctx.lk1 === "object"
      && ctx.lk1.checkout && typeof ctx.lk1.checkout === "object" ? ctx.lk1.checkout : null;
    // The widget accepts a confirmed replay only with consistent money evidence that
    // names the same intent. Without `mode`/`paymentRef`/`gameId` a paid replay is
    // rejected as an unknown state, so the player cannot resume the stored checkout.
    const toPayMinor = Number.isSafeInteger(payload.toPayMinor) ? payload.toPayMinor
      : Number.isSafeInteger(checkout?.toPayMinor) ? checkout.toPayMinor : 0;
    const action = split.action === "create" || split.action === "join" ? split.action
      : ctx.managedAction === "CREATE_GAME" ? "create"
        : ctx.managedAction === "JOIN_GAME" ? "join" : null;
    msg.payload = { ...payload,
      toPayMinor,
      toPay: toPayMinor / 100,
      transactionId: payload.transactionId || checkout?.transactionId || null,
      paymentUrl: payload.paymentUrl || checkout?.paymentUrl || null,
      settlementState: toPayMinor > 0 ? "PAYMENT_REQUIRED" : "CONFIRMED",
      selectedPaymentMode: toPayMinor > 0 ? "one_time" : "subscription",
      mode: action,
      paymentRef: split.paymentRef || payload.paymentRef || null,
      gameId: split.gameId || payload.gameId || null,
      exerciseId: payload.exerciseId || ctx.exerciseId || null };
  }
  return [null, msg];
}
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
    if (ctx.caller !== "split" || !["JOIN_GAME", "CREATE_GAME"].includes(ctx.managedAction)
      || ctx.lk1.target?.category !== "GAME") {
      msg.statusCode = 202;
      msg.payload = { ok: true, state: "PENDING_CONFIRMATION", operationId: ctx.operationId,
        details: { code: "LK1_PAYMENT_ROUTE_INVALID" } };
      return [null, msg];
    }
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

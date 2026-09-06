// HUB_FAIL
if ((msg._subscriptionBooking?.lk1 && msg._splitCtx?.lk1Checkout) || msg._splitCtx?.lk1CreateBinding) {
    // The subscription visit may already be consumed. A serializer failure is
    // not permission to retry the booking or run legacy compensation.
    msg.statusCode = 202;
    msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    msg.payload = { ok: true, state: "PENDING_CONFIRMATION",
      operationId: msg._subscriptionBooking?.operationId || msg._splitCtx?.operationId,
      details: { code: msg._splitCtx?.lk1CreateBinding
        ? "LK1_CREATE_RECONCILIATION_REQUIRED" : "LK1_PAYMENT_CARRIER_UNAVAILABLE" } };
    return [null, msg, null];
  }

// HUB_CHECKOUT
if (ctx.step === "lk1_checkout_complete") {
  const subscription = msg._subscriptionBooking;
  if (!subscription?.lk1 || msg.payload?.state !== "CONFIRMED"
    || msg.payload.operationId !== subscription.operationId
    || msg.payload.bookingId !== subscription.confirmedBookingId) {
    return fail(409, "Подтверждение составной оплаты не совпало", { code: "LK1_CHECKOUT_IDENTITY_INVALID" });
  }
  msg.payload = { ...msg.payload, mode: ctx.action, paymentRef: ctx.paymentRef,
    exerciseId: subscription.exerciseId, selectedPaymentMode: msg.payload.toPayMinor > 0 ? "one_time" : "subscription",
    gameId: ctx.gameId || null,
    settlementState: msg.payload.toPayMinor > 0 ? "PAYMENT_REQUIRED" : "CONFIRMED",
    pricingPolicy: ctx.pricingPolicy || null, deadlineAt: ctx.deadlineAt,
    assembleDeadlineAt: ctx.assembleDeadlineAt || null, spot: subscription.confirmedSpot || ctx.spot || null };
  delete msg._subscriptionBooking;
  return [null, msg, msg];
}

// HUB_PRODUCTS
const lk1 = ctx.lk1Checkout;
if (lk1 && (!msg._subscriptionBooking?.lk1
    || msg._subscriptionBooking.step !== "lk1_payment_products"
    || msg._subscriptionBooking.lk1.fingerprint !== lk1.fingerprint
    || msg._subscriptionBooking.confirmedBookingId !== ctx.bookingId
    || !Number.isSafeInteger(lk1.finalPriceMinor) || lk1.finalPriceMinor <= 0)) {
    return fail(409, "Контекст доплаты не подтверждён", { code: "LK1_CHECKOUT_IDENTITY_INVALID" });
  }

// HUB_PAYMENT
if (lk1) {
    // Existing fourth output goes to the subscription HTTP/readback node.
    // Re-authenticate the same actor, then CAS the persisted request attempt.
    // Never send a second SUBSCRIPTION product or a provider POST from here.
    msg._splitCtx = ctx;
    msg._subscriptionBooking.step = "lk1_payment_profile_recheck";
    msg.method = "GET";
    msg.url = `${END_USER_API}/profile`;
    msg.headers = { Authorization: msg._subscriptionBooking.authHeader, Accept: "application/json" };
    msg.payload = undefined;
    msg.requestTimeout = ADMIN_REQUEST_TIMEOUT_MS;
    msg.followRedirects = false;
    msg.maxRedirects = 0;
    return [null, null, null, msg];
  }

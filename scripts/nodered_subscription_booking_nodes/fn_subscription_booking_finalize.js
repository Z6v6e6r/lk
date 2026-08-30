const ctx = msg._subscriptionBooking && typeof msg._subscriptionBooking === "object"
  ? msg._subscriptionBooking
  : null;
const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};

msg.headers = {
  ...(msg.headers && typeof msg.headers === "object" ? msg.headers : {}),
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

if (ctx?.caller === "split" && payload.state === "FULL_PRICE_WITHOUT_SUBSCRIPTION") {
  const splitCtx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : {};
  splitCtx.subscriptionGuardDone = true;
  splitCtx.paymentMode = "one_time";
  splitCtx.selectedPaymentMode = "one_time";
  splitCtx.bookingPaymentType = "ON_PLACE";
  splitCtx.fullPriceFallback = {
    source: "ACTIVE_SERVICES_LIMIT_REACHED",
    blockers: Array.isArray(payload.blockers) ? payload.blockers : [],
  };
  splitCtx.step = "subscription_full_price_fallback";
  msg._splitCtx = splitCtx;
  msg.statusCode = 200;
  msg.payload = {
    ok: true,
    state: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
    blockers: splitCtx.fullPriceFallback.blockers,
  };
  delete msg._subscriptionBooking;
  return [msg, null];
}

if (ctx?.caller === "split" && payload.state === "CONFIRMED" && payload.bookingId) {
  const splitCtx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : {};
  splitCtx.subscriptionGuardDone = true;
  splitCtx.step = "create_booking";
  splitCtx.clientId = ctx.actorClientId || splitCtx.clientId || null;
  splitCtx.clientPhone = ctx.actorPhone || splitCtx.clientPhone || null;
  splitCtx.studioId = ctx.studioId || splitCtx.studioId || null;
  splitCtx.spot = ctx.confirmedSpot || splitCtx.spot || null;
  msg._splitCtx = splitCtx;
  msg.statusCode = 201;
  msg.payload = {
    id: payload.bookingId,
    bookingId: payload.bookingId,
    exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    paymentType: "SUBSCRIPTION",
    spot: splitCtx.spot,
    client: {
      id: splitCtx.clientId,
      phone: splitCtx.clientPhone,
    },
    studio: {
      id: splitCtx.studioId,
    },
  };
  delete msg._subscriptionBooking;
  return [msg, null];
}

if (ctx?.caller === "split") {
  const splitCtx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : {};
  const responseStatus = Number(msg.statusCode) || 0;
  const ambiguousOrAcceptedSteps = new Set([
    "booking_create",
    "operation_accept",
    "confirmation_bookings",
    "operation_confirm",
    "managed_entitlement_confirm",
    "managed_first_use_activation",
    "operation_activation_confirm",
  ]);
  const terminalFailure = responseStatus >= 400
    && typeof payload.error === "string"
    && (ctx.step === "operation_fail" || !ambiguousOrAcceptedSteps.has(ctx.step));
  const ownsCreatedExercise = splitCtx.action === "create"
    && splitCtx.ownsExercise === true
    && Boolean(String(splitCtx.exerciseId || ctx.exerciseId || "").trim());
  if (terminalFailure && ownsCreatedExercise) {
    splitCtx.exerciseId = String(splitCtx.exerciseId || ctx.exerciseId).trim();
    splitCtx.bookingFailure = {
      statusCode: responseStatus,
      payload: {
        error: typeof payload.error === "string"
          ? payload.error
          : "Правила подписки не разрешили создание игры",
        details: payload.details && typeof payload.details === "object"
          ? payload.details
          : null,
      },
      source: "MANAGED_SUBSCRIPTION_GATEWAY",
    };
    splitCtx.step = "subscription_gateway_rejected";
    msg._splitCtx = splitCtx;
    msg.statusCode = 200;
    msg.payload = { reconciliationRequired: true };
    delete msg._subscriptionBooking;
    return [msg, null];
  }
}

return [null, msg];

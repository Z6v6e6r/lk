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

return [null, msg];

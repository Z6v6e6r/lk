// Only monetary group bookings use the synchronous Admin v1 create contract.
const lk1GroupMoneyBooking = (ctx) => ctx.caller === "http"
  && ctx.managedAction === "BOOK_GROUP_TRAINING" && ctx.category === "group_training"
  && ctx.lk1?.decision?.subscriptionVisitCount === 0
  && ctx.lk1.decision.benefit?.kind === "PERCENT_DISCOUNT"
  && Number.isSafeInteger(ctx.lk1.decision.benefit.finalPriceMinor)
  && ctx.lk1.decision.benefit.finalPriceMinor > 0;
const lk1GroupSelfReadback = (ctx) => {
  const proof = ctx.lk1GroupConfirmationRead;
  delete ctx.lk1GroupConfirmationRead;
  const url = `${VIVA_API_BASE}/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`;
  return Boolean(proof && proof.url === url && proof.actorClientId === ctx.actorClientId
    && proof.operationId === ctx.operationId && proof.operationKey === ctx.operationKey
    && typeof ctx.authHeader === "string" && /^Bearer\s+\S+$/i.test(ctx.authHeader)
    && proof.authHeader === ctx.authHeader && msg.method === "GET" && msg.url === url
    && (msg.responseUrl === undefined || msg.responseUrl === url)
    && msg.followRedirects === false && msg.maxRedirects === 0);
};
const lk1GroupOwnerMatches = (booking, actorClientId) => {
  if (typeof actorClientId !== "string" || !actorClientId.trim()) return false;
  const aliases = [];
  for (const key of ["clientId", "playerId", "userId"]) {
    if (Object.prototype.hasOwnProperty.call(booking, key)) aliases.push(booking[key]);
  }
  if (Object.prototype.hasOwnProperty.call(booking, "client")) {
    if (!isObj(booking.client)) return false;
    for (const key of ["id", "clientId"]) {
      if (Object.prototype.hasOwnProperty.call(booking.client, key)) aliases.push(booking.client[key]);
    }
  }
  // The authenticated self-list omits owner fields; explicit invalid/conflicting echoes fail.
  return aliases.every(value => typeof value === "string" && value.trim()
    && normalizeId(value) === normalizeId(actorClientId));
};
const lk1GroupUnpaidOnPlace = (booking) => booking.paymentType === "ON_PLACE"
  && (booking.paymentMethod === undefined || booking.paymentMethod === "ON_PLACE")
  && !isSubscriptionBooking(booking)
  && (booking.transactionStatus === undefined || booking.transactionStatus === null)
  && (booking.pendingPayments === undefined || (Array.isArray(booking.pendingPayments) && booking.pendingPayments.length === 0));

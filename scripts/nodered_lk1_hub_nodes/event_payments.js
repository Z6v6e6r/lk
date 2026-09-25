// Routes are selected from the authenticated, server-resolved event category.
// Each event route owns its tariff; only open games enter the split carrier.
const lk1EventPaymentRoutes = Object.freeze({
  BOOK_GROUP_TRAINING: Object.freeze({ category: "GROUP_TRAINING", sourceCategory: "group_training",
    discountField: "groupTrainingDiscountPercent", productsStep: "lk1_group_payment_products",
    profileStep: "lk1_group_payment_profile", code: "LK1_GROUP_PAYMENT",
    discountReason: "Скидка по правилам подписки на групповое занятие" }),
  BOOK_TOURNAMENT: Object.freeze({ category: "TOURNAMENT", sourceCategory: "tournament",
    discountField: "tournamentDiscountPercent", productsStep: "lk1_tournament_payment_products",
    profileStep: "lk1_tournament_payment_profile", code: "LK1_TOURNAMENT_PAYMENT",
    discountReason: "Скидка по правилам подписки на турнир" }),
});
const lk1EventPaymentRoute = (ctx) => Object.hasOwn(lk1EventPaymentRoutes, ctx.managedAction)
  ? lk1EventPaymentRoutes[ctx.managedAction] : null;
const lk1EventPaymentBinding = (ctx, quote = ctx.lk1) => {
  const route = lk1EventPaymentRoute(ctx);
  const target = quote?.target;
  const decision = quote?.decision;
  const percent = route && quote?.rule?.[route.discountField];
  const base = target?.basePriceMinor;
  if (!route || ctx.caller !== "http" || ctx.category !== route.sourceCategory
    || target?.category !== route.category || target.eventId !== ctx.exerciseId
    || target.stationId !== ctx.studioId
    || typeof target.priceProductId !== "string" || !target.priceProductId.trim()
    || !Number.isSafeInteger(base) || base <= 0 || base > 1_000_000
    || !Number.isSafeInteger(percent) || percent < 0 || percent > 100
    || decision?.eligible !== true) return null;
  // The visit-covered first event of the day costs nothing. It has no payment product to look
  // up, but it is still carried by this binding, so neither the confirm step nor the replay of
  // the durable operation demands a charge the client never owes.
  if (decision.subscriptionVisitCount === 1 && decision.benefit?.kind === "FREE_ENTITLEMENT"
    && decision.benefit.finalPriceMinor === 0) {
    return { productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
      chargeMinor: 0, discountMinor: base };
  }
  if (decision.subscriptionVisitCount !== 0
    || decision.benefit?.finalPriceMinor !== base - Math.floor(base * percent / 100)) return null;
  return { productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
    chargeMinor: decision.benefit.finalPriceMinor,
    discountMinor: base - decision.benefit.finalPriceMinor };
};

// The club training («Дружба Топократы», direction 6233) spends the free hour and bills the
// minutes above it, and without a free hour it bills the whole event. Both shapes differ from
// the configured event percent the reviewed binding proves, so they are resolved here: the
// visit-covered share is priced by its own fraction and the decision's own percent, and the
// whole-event shape by the decision's percent. Everything else falls through to the reviewed
// binding, which keeps its exact contract.
const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {
  const route = lk1EventPaymentRoute(ctx);
  const target = quote?.target;
  const decision = quote?.decision;
  const base = target?.basePriceMinor;
  if (!route || ctx.caller !== "http" || ctx.category !== route.sourceCategory
    || target?.category !== route.category || target.eventId !== ctx.exerciseId
    || target.stationId !== ctx.studioId
    || typeof target.priceProductId !== "string" || !target.priceProductId.trim()
    || !Number.isSafeInteger(base) || base <= 0 || base > 1_000_000
    || decision?.eligible !== true
    || !Number.isInteger(decision.eventDiscountPercent)
    || decision.eventDiscountPercent < 0 || decision.eventDiscountPercent > 100) return null;
  const percent = decision.eventDiscountPercent;
  const share = decision.benefit?.kind === "PARTIAL_PRICE_PERCENT_DISCOUNT"
    && decision.subscriptionVisitCount === 1 ? decision.gameMinutes : null;
  let chargeMinor = null;
  if (share
    && Number.isSafeInteger(share.freeMinutes) && share.freeMinutes > 0
    && Number.isSafeInteger(share.paidOverageMinutes) && share.paidOverageMinutes > 0) {
    const totalMinutes = share.freeMinutes + share.paidOverageMinutes;
    const chargedMinor = Math.floor(base * share.paidOverageMinutes / totalMinutes);
    chargeMinor = chargedMinor - Math.floor(chargedMinor * percent / 100);
  } else if (!share && decision.subscriptionVisitCount === 0
    && decision.benefit?.kind === "PERCENT_DISCOUNT") {
    chargeMinor = base - Math.floor(base * percent / 100);
  }
  if (chargeMinor === null || decision.benefit.finalPriceMinor !== chargeMinor) return null;
  return { productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
    chargeMinor, discountMinor: base - chargeMinor };
};
// Every event-payment decision goes through this resolver: the club shapes above first, then
// the reviewed binding, which still prices every other event and refuses a shape it cannot
// prove (a visit with a charge the club branch did not resolve).
const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>
  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);
// Payment products use Viva's services/subServices envelopes as well as lists.
const lk1PaymentProductRows = (value, seen = new Set()) => {
  if (Array.isArray(value)) return value;
  if (!isObj(value) || seen.has(value) || value.last === false || value.hasNext === true) return null;
  seen.add(value);
  const keys = ["content", "items", "records", "data", "payload", "result", "services", "subServices"]
    .filter(key => value[key] !== undefined);
  if (!keys.length) return null;
  const lists = keys.map(key => lk1PaymentProductRows(value[key], seen));
  if (lists.some(rows => rows === null)) return null;
  const rows = lists.flat();
  const total = Number(value.totalElements ?? value.totalCount);
  const page = Number(value.number ?? value.page);
  const pages = Number(value.totalPages);
  if ((Number.isFinite(total) && total > rows.length)
    || (Number.isFinite(page) && Number.isFinite(pages) && page + 1 < pages)) return null;
  return rows;
};

const lk1PrepareEventPayment = (ctx, route) => {
  const binding = lk1EventPaymentQuoteBinding(ctx);
  const products = lk1PaymentProductRows(msg.payload);
  if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, route.code + "_PRODUCT_UNAVAILABLE");
  if (!binding || !products) return lk1Stop(ctx, route.code + "_BINDING_INVALID");
  const rows = products.filter(row => isObj(row) && [row.id, row.productId].includes(binding.productId));
  if (rows.length !== 1) return lk1Stop(ctx, route.code + "_PRODUCT_UNAVAILABLE");
  const row = rows[0];
  const exact = (values, expected) => {
    const present = values.filter(value => value !== undefined);
    return present.length > 0 && present.every(value => value === expected);
  };
  if (!exact([row.id, row.productId], binding.productId)
    || !exact([row.type, row.productType], binding.productType)
    || !exact([row.cost, row.price, row.amount], binding.baseMinor)) {
    return lk1Stop(ctx, route.code + "_PRODUCT_CHANGED");
  }
  // This context never enters the open-game split serializer.
  ctx.lk1EventPayment = { category: route.category, productId: binding.productId, transactionPayload: {
    clientPhone: ctx.actorPhone, paymentMethod: "SMS", studioId: ctx.studioId,
    products: [{ id: binding.productId, type: binding.productType, count: 1,
      bookingIds: [ctx.confirmedBookingId], customAmount: null, discount: binding.discountMinor }],
    discountReason: route.discountReason,
  } };
  return prepareUserGet(ctx, route.profileStep, `/end-user/api/v1/${ctx.tenantKey}/profile`);
};

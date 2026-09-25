function isNodeRedHttpsCheckout(paymentUrl) {
  return typeof paymentUrl === 'string' && paymentUrl.length <= 4096
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::443)?(?:[/?#][^\s\\]*)?$/i.test(paymentUrl)
    && !Array.from(paymentUrl).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);
}
const LK1_OVERLAY_HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const LK1_PRODUCT_POLICY_GLOBAL = "subscriptions_lk1_product_policy";
// An ingress replay of a confirmed claim re-reads the provider before it replays the
// stored checkout: the split payment-timeout cleanup cancels the booking without
// releasing the claim, and a replay must not send the player to pay for a booking the
// provider no longer holds.
const LK1_CONFIRMED_BOOKING_RECHECK = "lk1_ingress_confirmed_booking_recheck";
const LK1_CONFIRMED_ORPHAN_RELEASE = "lk1_confirmed_orphan_release";
// The free-first-event cohort of the rollout contract: for these plan products the first
// event of the subscription's local service day in the listed categories is carried by the
// subscription itself (one visit is consumed and nothing is charged); every later event that
// day, and any event once the visits are used up, keeps the configured discount and consumes
// no visit. The day bucket is proved here and travels to the evaluator in the policy input.
const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({
  // РА and Академия, including their promo variants (owner decision 2026-09-16).
  "b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),
  "3b4806f1-6f9a-46df-a7d7-45075b4e7274": Object.freeze(["group_training", "tournament"]),
  "9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]),
  "6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),
});
const lk1Fields = ["maxActiveBookings", "freeGameMinutesPerDay", "gameOverageDiscountPercent",
  "groupTrainingDiscountPercent", "tournamentDiscountPercent"];
const lk1Config = (owned, stationId) => {
  // The resolver (scripts/lib/lk1PlanRules.mjs) is embedded into this function
  // body by the release composition, together with its readers. The booking target's
  // station is what keeps a named station on the product's pre-rollout behaviour
  // (`subscriptions_lk1_station_exclusions`), so every call site passes it.
  const configured = resolveLk1Rule({ owned, planRules: lk1ReadPlanRules(), stationId,
    stationExclusions: lk1ReadStationExclusions() });
  if (configured.matched !== true) return { matched: false };
  if (configured.legacy === true) return { matched: true, legacy: true };
  if (configured.code) return { matched: true, code: configured.code };
  // Only the five rule numbers travel further; the product id comes from the rule
  // the resolver selected, never from a hardcoded HUB constant.
  const rule = { productId: configured.productId };
  for (const field of lk1Fields) rule[field] = configured.rule[field];
  if (typeof rule.productId !== "string" || !rule.productId
    || lk1Fields.some((field) => !Number.isSafeInteger(rule[field]) || rule[field] < 0)
    || rule.maxActiveBookings < 1 || lk1Fields.slice(2).some((field) => rule[field] > 100)) {
    return { matched: true, code: "LK1_PRODUCT_RULE_INVALID" };
  }
  // The enforced verdict is the absence of `legacy`, exactly as before the
  // rollout: the durable quote and its recheck compare the five-field rule.
  return { matched: true, rule };
};
// `observed` is additive: it carries the named sub-condition of a refusal (counts,
// booleans and enum values only) so a production refusal can be diagnosed from the
// response instead of reproduced. Callers that pass nothing keep the previous body.
const lk1Stop = (ctx, code, observed) => finishPending(ctx, "Запись или доплата требуют безопасной сверки",
  observed === undefined ? { code } : { code, observed });
const lk1ReadonlyLookup = (value) => {
  const ctx = value._subscriptionBooking;
  return ctx?.step === "lk1_ingress_operation_find" && ctx.lk1IngressReplay === true
    && typeof ctx.actorClientId === "string" && Boolean(ctx.actorClientId)
    && typeof ctx.tenantKey === "string" && /^[A-Za-z0-9_-]+$/.test(ctx.tenantKey)
    && /^[A-Za-z0-9._:-]{8,200}$/.test(ctx.operationId || "")
    && isObj(value.payload) && Object.keys(value.payload).length === 1
    && value.payload._id === `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;
};
const lk1Find = (ctx, step, query) => {
  ctx.step = step;
  msg._subscriptionBooking = ctx;
  msg.payload = query;
  delete msg.error;
  return emit(OUTPUT_MONGO_FIND);
};
const lk1Fingerprint = (ctx, quote) => JSON.stringify({ tenantKey: ctx.tenantKey,
  actorClientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId,
  action: ctx.managedAction, rule: quote.rule, purchaseDate: quote.purchaseDate,
  createPayload: ctx.managedAction === "CREATE_GAME" ? ctx.lk1CreatePayload : undefined,
  target: { ...quote.target, eventId: ctx.managedAction === "CREATE_GAME"
    ? `preflight:${ctx.operationId}` : quote.target.eventId } });
const lk1DiscountOwned = (ctx, exercise) => {
  const evidence = ctx.lk1MoneyOwnership;
  if (ctx.caller !== "http" || !["group_training", "tournament"].includes(resolveCategory(exercise))
    || !isObj(evidence) || evidence.exerciseId !== ctx.exerciseId
    || evidence.actorClientId !== ctx.actorClientId || !Number.isFinite(evidence.observedAt)
    || Date.now() - evidence.observedAt < 0 || Date.now() - evidence.observedAt > 30_000) return [];
  return [evidence.subscription];
};
const lk1QuoteOwned = (ctx, exercise) => {
  const moneyOwned = lk1DiscountOwned(ctx, exercise);
  return moneyOwned.length ? moneyOwned : findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
};
const lk1LifecycleInstant = (value, endOfDay = false) => {
  if (typeof value !== "string" || !isValidDateKey(value.slice(0, 10))) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`);
  }
  const timestamp = /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.(\d{1,6}))?)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!timestamp) return null;
  const milliseconds = value.replace(/(\.\d{3})\d+/, "$1");
  const instant = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(milliseconds) ? milliseconds : `${milliseconds}+03:00`);
  // Viva carries microseconds; never widen validity when reducing to milliseconds.
  const activationCeiling = !endOfDay && /[1-9]/.test((timestamp[1] || "").slice(3)) ? 1 : 0;
  return Number.isFinite(instant) ? instant + activationCeiling : null;
};
// The Viva direction of the resolved exercise, read through the same aliases
// `resolveCategory` accepts. The booking target carries it so the managed-policy evaluator
// can tell the club's training direction from another club's corporate event of the same
// type (2349 is shared by «Атланты» and «Топократы»).
const exerciseDirectionId = (exercise) => {
  const rawDirection = exercise?.direction ?? exercise?.exerciseDirection;
  const nested = isObj(rawDirection) ? rawDirection : null;
  const value = nested ? (nested.id ?? nested.directionId) : rawDirection;
  const numeric = Number(value ?? exercise?.directionId ?? exercise?.exerciseDirectionId);
  return Number.isInteger(numeric) ? numeric : null;
};
const lk1Quote = (ctx, exercise, owned) => {
  // The station of the resolved booking target is part of the contour decision: an
  // excluded station keeps the product's legacy path for this quote as well.
  const configured = lk1Config(owned, exercise?.studio?.id || exercise?.studioId || null);
  if (!configured.matched || configured.code) return { code: configured.code || "LK1_PRODUCT_RULE_CHANGED" };
  if (configured.legacy) return { legacy: true };
  // The sale-date cohort is decided by the rule: the selected instance for a plan
  // product, never a date gate for HUB. The date still travels in the quote.
  const dates = collectSubscriptionPurchaseDateEvidence(owned);
  if (dates.invalid || dates.dates.length !== 1) return { code: "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED" };
  if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && lk1DiscountOwned(ctx, exercise).length !== 1) {
    return { code: "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN" };
  }
  const target = {
    resolutionSource: "SERVER", eventId: toStr(exercise.id || exercise.exerciseId),
    category: managedTargetCategory(resolveCategory(exercise)),
    externalEventTypeId: managedExternalEventTypeId(exercise), productTypeId: null,
    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),
    directionId: exerciseDirectionId(exercise),
    durationMinutes: eventDurationMinutes(exercise), startsAt: eventStartsAt(exercise),
    basePriceMinor: null, currency: "RUB", priceSource: "VIVA_EXISTING_TARIFF",
  };
  if (!target.category || !target.stationId || !target.roomId || !target.externalEventTypeId
    || target.eventId !== ctx.exerciseId || !target.durationMinutes
    || !finiteDate(target.startsAt) || finiteDate(target.startsAt).getTime() <= Date.now()) {
    return { code: "LK1_TARGET_UNRESOLVED" };
  }
  target.startsAt = finiteDate(target.startsAt).toISOString();
  const proof = ctx.lk1TariffProof;
  if (!isObj(proof) || proof.source !== "VIVA_EXISTING_TARIFF"
    || !Number.isSafeInteger(proof.amountMinor) || proof.amountMinor < 0
    || proof.stationId !== target.stationId || proof.roomId !== target.roomId
    || proof.durationMinutes !== target.durationMinutes
    || finiteDate(proof.startsAt)?.getTime() !== finiteDate(target.startsAt).getTime()
    || !Number.isFinite(proof.observedAt) || Date.now() - proof.observedAt < 0
    || Date.now() - proof.observedAt > 30_000) return { code: "LK1_EVENT_TARIFF_UNVERIFIED" };
  target.basePriceMinor = proof.amountMinor;
  if (proof.kind === "EVENT_ONE_TIME") target.priceProductId = proof.productId;
  if (lk1DiscountOwned(ctx, exercise).length) {
    const subscription = ctx.lk1MoneyOwnership.subscription;
    target.subscriptionValidity = { status: subscription.status,
      activationDate: subscription.activationDate, expirationDate: subscription.expirationDate };
  }
  const quote = { rule: configured.rule, purchaseDate: dates.dates[0], target,
    createPayload: ctx.managedAction === "CREATE_GAME" ? ctx.lk1CreatePayload : undefined };
  return { ...quote, fingerprint: lk1Fingerprint(ctx, quote) };
};
const lk1Finish = (ctx) => {
  const payment = ctx.lk1?.checkout;
  if (!ctx.confirmedBookingId || (ctx.lk1.decision.benefit.finalPriceMinor > 0 && !payment)) {
    return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");
  }
  finishConfirmed(ctx, ctx.confirmedBookingId);
  msg.payload = { ...msg.payload, paymentUrl: payment?.paymentUrl || null,
    transactionId: payment?.transactionId || null, toPayMinor: payment?.toPayMinor || 0,
    toPay: (payment?.toPayMinor || 0) / 100, paid: !payment || payment.toPayMinor === 0,
    subscriptionVisitCount: ctx.lk1.decision.subscriptionVisitCount,
    gameMinutes: ctx.lk1.decision.gameMinutes || null };
  return emit(OUTPUT_FINAL);
};
// EVENT_PAYMENT_ROUTES
const lk1Checkout = (ctx) => {
  const route = lk1EventPaymentRoute(ctx);
  if (route && !lk1EventPaymentQuoteBinding(ctx)) return lk1Stop(ctx, route.code + "_BINDING_INVALID");
  if (!route && (!['JOIN_GAME', 'CREATE_GAME'].includes(ctx.managedAction)
    || ctx.caller !== 'split' || ctx.lk1.target?.category !== 'GAME')) return lk1Stop(ctx, "LK1_PAYMENT_ROUTE_INVALID");
  if (lk1NeedsVisitJob(ctx) && !ctx.lk1.visitJob) return lk1Stop(ctx, "LK1_VISIT_JOB_MISSING");
  if (ctx.lk1.decision.benefit.finalPriceMinor === 0) return lk1Finish(ctx);
  if (ctx.lk1.checkout) return lk1Finish(ctx);
  if (ctx.lk1.transactionAttemptedAt) {
    if (!ctx.lk1.transactionId) return lk1Stop(ctx, "LK1_TRANSACTION_OUTCOME_UNKNOWN");
    return prepareAdminGet(ctx, "lk1_transaction_readback", `/api/v1/transactions/${encodeURIComponent(ctx.lk1.transactionId)}`);
  }
  const token = readGlobal("vivacrm_access_token");
  if (!token) return lk1Stop(ctx, "LK1_SERVICE_TOKEN_UNAVAILABLE");
  return prepareHttp(ctx, route ? route.productsStep : "lk1_payment_products", "POST", `${VIVA_API_BASE}/api/v1/products/available/by-booking`, {
    bookingIds: [ctx.confirmedBookingId], clientId: ctx.actorClientId, studioId: ctx.studioId,
  }, { Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
};


// REJOIN_HELPERS_START
const lk1FenceOperationUpdate = (ctx, step, query) => {
  if (!ctx.lk1) return query;
  if (step === "operation_fail") {
    return { ...query, state: { $in: ["PREPARED", "PENDING_CONFIRMATION"] } };
  }
  if (step === "operation_accept" || step === "operation_confirm") {
    return { ...query, state: "PENDING_CONFIRMATION",
      ...(step === "operation_confirm" ? {
        // A bound booking must match. Missing evidence remains admissible for
        // the existing read-only recovery of an expired, unbound claim.
        upstreamBookingId: { $in: [ctx.confirmedBookingId, null, ""] },
      } : {}),
    };
  }
  return query;
};

const lk1RejoinIdentity = (id) => {
  const match = typeof id === "string" && /^(lk-split-join-[a-z0-9]+)(?::rejoin:([1-9]\d{0,3}))?$/.exec(id);
  if (!match || Number(match[2] || 0) > 1000) return null;
  return { base: match[1], generation: Number(match[2] || 0) };
};
const lk1RejoinNextId = (id) => {
  const value = lk1RejoinIdentity(id);
  return value && value.generation < 1000 ? `${value.base}:rejoin:${value.generation + 1}` : null;
};
const lk1RejoinPreviousId = (id) => {
  const value = lk1RejoinIdentity(id);
  return value?.generation > 0
    ? (value.generation === 1 ? value.base : `${value.base}:rejoin:${value.generation - 1}`) : null;
};
const lk1ReleasedWithoutPayment = (operation) => {
  const presentId = value => typeof value === "string" && value.trim().length > 0;
  const bookingIds = [operation.bookingId, operation.upstreamBookingId].filter(value => value != null);
  return operation.state === "RELEASED" && operation.releaseSource === "GAME_LEAVE"
    && presentId(operation.releaseOperationId) && presentId(operation.releaseBookingId)
    && typeof operation.releasedAt === "string" && Number.isFinite(Date.parse(operation.releasedAt))
    && bookingIds.length > 0 && bookingIds.every(id => presentId(id) && id === operation.releaseBookingId)
    && Array.isArray(operation.releasedBookingIds) && operation.releasedBookingIds.includes(operation.releaseBookingId)
    // An attempted charge or visit adjustment needs its own recovery, even if
    // the booking has been cancelled. Never infer a refund from RELEASED.
    && ["transactionAttemptedAt", "transactionId", "transactionIntent", "checkout", "visitJob"]
      .every(key => operation.lk1?.[key] === undefined);
};
const lk1ReplayIdentityMatches = (ctx, operation, operationId = ctx.operationId) => {
    const quote = operation?.lk1;
    const isCreate = ctx.caller === "split_create_readonly_preflight";
    const action = isCreate ? "CREATE_GAME" : managedActionForTarget({ ...ctx, category: operation?.category });
    const identity = { ...ctx, managedAction: action };
    return !(!isObj(operation) || operation._id !== `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, operationId])}`
      || operation.tenantKey !== ctx.tenantKey || operation.actorClientId !== ctx.actorClientId
      || operation.operationId !== operationId || operation.clientSubscriptionId !== ctx.clientSubscriptionId
      // The stored quote only has to be internally consistent, not HUB-specific: `lk1Fingerprint`
      // already binds the rule, the sale date and the target, and since the plan-rules rollout
      // any product the resolver names can be the enforced one.
      || !isObj(quote) || !isObj(quote.rule) || !isObj(quote.target)
      || !action || quote.fingerprint !== lk1Fingerprint(identity, quote)
      || (isCreate ? JSON.stringify(quote.createPayload) !== JSON.stringify(ctx.lk1CreatePayload)
        || quote.target.stationId !== ctx.prospectiveTarget?.studioId
        || quote.target.roomId !== ctx.prospectiveTarget?.roomId
        || !Number.isFinite(Date.parse(ctx.prospectiveTarget?.timeFrom))
        || Date.parse(quote.target.startsAt) !== Date.parse(ctx.prospectiveTarget?.timeFrom)
        || quote.target.durationMinutes !== (Date.parse(ctx.prospectiveTarget?.timeTo) - Date.parse(ctx.prospectiveTarget?.timeFrom)) / 60_000
        : operation.exerciseId !== ctx.exerciseId || quote.target.eventId !== ctx.exerciseId)
      || quote.decision?.eligible !== true || ![0, 1].includes(quote.decision.subscriptionVisitCount)
      || !Number.isSafeInteger(quote.decision?.benefit?.finalPriceMinor)
      || quote.decision.benefit.finalPriceMinor < 0 || quote.decision.benefit.finalPriceMinor > 1_000_000);
};
// REJOIN_HELPERS_END

// HUB_STEPS
if (ctx.step === "lk1_ingress_operation_find") {
  // Existing operations are only read. A new explicit successor must prove
  // its predecessor below before entering ordinary fresh validation.
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) {
    return lk1Stop(ctx, "LK1_OPERATION_READ_FAILED");
  }
  const operation = msg.payload[0];
  if (!operation && msg.payload.length === 0) {
    const previousId = lk1RejoinPreviousId(ctx.operationId);
    if (String(ctx.operationId).includes(":rejoin:") && !previousId) {
      return finishError(ctx, 409, "Не удалось проверить предыдущую запись", { code: "SUBSCRIPTION_REJOIN_INVALID" });
    }
    if (previousId) {
      if (ctx.caller !== "split" || ctx.managedAction !== "JOIN_GAME") {
        return finishError(ctx, 409, "Повторная запись недоступна", { code: "SUBSCRIPTION_REJOIN_INVALID" });
      }
      return lk1Find(ctx, "lk1_rejoin_predecessor_find", {
        _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, previousId])}`,
      });
    }
    delete ctx.lk1IngressReplay;
    ctx.step = "lk1_profile_continue";
  } else {
    if (!lk1ReplayIdentityMatches(ctx, operation)) {
      return lk1Stop(ctx, "LK1_REQUEST_IDENTITY_CHANGED");
    }
    const quote = operation.lk1;
    if (operation.state === "RELEASED" && ctx.caller === "split" && ctx.managedAction === "JOIN_GAME") {
      const nextOperationId = lk1RejoinNextId(ctx.operationId);
      if (!nextOperationId || !lk1ReleasedWithoutPayment(operation)) {
        return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");
      }
      return finishError(ctx, 409, "Предыдущая запись отменена. Для новой записи нажмите «Присоединиться снова».", {
        code: "SUBSCRIPTION_BOOKING_RELEASED", operationId: ctx.operationId, nextOperationId,
      });
    }
    if (operation.state !== "CONFIRMED" || typeof operation.bookingId !== "string" || !operation.bookingId.trim()
      || typeof operation.exerciseId !== "string" || !operation.exerciseId.trim()
      || operation.exerciseId.startsWith("preflight:") || quote.target.eventId !== operation.exerciseId) {
      return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    }
    const amount = quote.decision.benefit.finalPriceMinor;
    if (["BOOK_GROUP_TRAINING", "BOOK_TOURNAMENT"].includes(managedActionForTarget({ ...ctx, category: operation.category }))) {
      const binding = lk1EventPaymentQuoteBinding({ ...ctx, category: operation.category,
        managedAction: managedActionForTarget({ ...ctx, category: operation.category }),
        studioId: quote.target.stationId, exerciseId: operation.exerciseId }, quote);
      const intent = quote.transactionIntent;
      // A previously verified legacy game-carrier checkout remains replayable.
      // It never re-enters the write path; missing checkout still fails below.
      const legacy = isObj(intent) && !Object.prototype.hasOwnProperty.call(intent, "productType")
        && !Object.prototype.hasOwnProperty.call(intent, "baseMinor");
      const validIntent = legacy
        ? typeof intent.productId === "string" && Boolean(intent.productId.trim()) && intent.discountMinor === 1_000_000 - amount
        : binding && isObj(intent) && intent.productId === binding.productId && intent.productType === binding.productType
          && intent.baseMinor === binding.baseMinor && intent.discountMinor === binding.discountMinor;
      if (!binding || (amount > 0 && !validIntent)) return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");
    }
    if (amount > 0) {
      const checkout = quote.checkout;
      const intent = quote.transactionIntent;
      const safeUrl = isNodeRedHttpsCheckout(checkout?.paymentUrl);
      if (!isObj(checkout) || !isObj(intent) || !safeUrl || checkout.toPayMinor !== amount
        || typeof checkout.transactionId !== "string" || !checkout.transactionId.trim()
        || checkout.transactionId !== quote.transactionId || !quote.transactionAttemptedAt
        || intent.bookingId !== operation.bookingId || intent.actorClientId !== ctx.actorClientId
        || intent.studioId !== quote.target.stationId || intent.chargeMinor !== amount) {
        return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");
      }
    } else if (quote.checkout || quote.transactionAttemptedAt || quote.transactionId) {
      return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");
    }
    ctx.lk1 = JSON.parse(JSON.stringify(quote));
    ctx.exerciseId = operation.exerciseId;
    ctx.confirmedBookingId = operation.bookingId;
    // Split join/create only: the payment-timeout cleanup that orphans a confirmed
    // booking is split-specific and the group/tournament replay contract is pinned
    // separately. A split replay re-reads the provider before it replays the stored
    // checkout, because a replay must not send the player to pay for a booking the
    // provider no longer holds.
    if (ctx.caller !== "split") return lk1Finish(ctx);
    ctx.lk1ConfirmedReplay = {
      operationKey: operation._id,
      operationId: operation.operationId,
      bookingId: operation.bookingId,
      fingerprint: quote.fingerprint,
      updatedAt: operation.updatedAt ?? null,
    };
    return prepareAdminGet(ctx, LK1_CONFIRMED_BOOKING_RECHECK,
      `/api/v1/exercises/${encodeURIComponent(operation.exerciseId)}/bookings?showCancelled=true&size=200`);
  }
}

const releaseConfirmedOrphan = (ctx, bound) => {
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, LK1_CONFIRMED_ORPHAN_RELEASE, {
    _id: bound.operationKey,
    operationId: bound.operationId,
    state: "CONFIRMED",
    bookingId: bound.bookingId,
    "lk1.fingerprint": bound.fingerprint,
    updatedAt: bound.updatedAt,
  }, {
    $set: {
      state: "RELEASED",
      releasedAt: nowIso,
      updatedAt: nowIso,
      releaseReason: "CONFIRMED_BOOKING_GONE",
      reconciliation: {
        source: "hub_confirmed_replay_provider_readback",
        decision: "SAFE_TO_RELEASE",
        reconciledAt: nowIso,
        observedBookingId: bound.bookingId,
        observedUpdatedAt: bound.updatedAt,
      },
    },
  });
};

if (ctx.step === LK1_CONFIRMED_BOOKING_RECHECK) {
  // Portable helpers: this body is composed both with and without the booking-readback
  // layer, so the recheck must not depend on helpers a partial composition omits.
  const recheckKey = (value) => (value === null || value === undefined
    ? null : String(value).trim().toLowerCase() || null);
  const recheckRowBookingId = (row) => (isObj(row) ? row.id || row.bookingId || row.uuid || null : null);
  const recheckRowClientId = (row) => (isObj(row)
    ? row.clientId || (isObj(row.client) ? row.client.id : null) || row.playerId || row.userId || null
    : null);
  const recheckRowSubscriptionId = (row) => {
    if (!isObj(row)) return null;
    const nested = isObj(row.subscription) ? row.subscription
      : isObj(row.clientSubscription) ? row.clientSubscription : {};
    return row.clientSubscriptionId || row.subscriptionId || row.clientSubId
      || nested.clientSubscriptionId || nested.subscriptionId || nested.id || nested.uuid || null;
  };
  const recheckRowCancelled = (row) => {
    if (!isObj(row)) return false;
    if (row.isCancelled === true || row.cancelled === true || row.canceled === true) return true;
    if ([row.isCancelled, row.cancelled, row.canceled].some((flag) => flag === false)) return false;
    if (row.cancelledAt || row.cancellationDate) return true;
    return /cancel/i.test(String(row.bookingStatus || row.status || row.state || ""));
  };
  const bound = isObj(ctx.lk1ConfirmedReplay) ? ctx.lk1ConfirmedReplay : null;
  if (!bound || !bound.operationKey || !bound.operationId || !bound.bookingId || !bound.fingerprint) {
    return lk1Stop(ctx, "LK1_CONFIRMED_RECHECK_CONTEXT_INVALID");
  }
  // "Cannot verify" always means "keep the claim and answer pending": only a complete
  // provider page may release the seat.
  if (!isHttpOk(msg.statusCode) || !hasCompleteBookingList(msg.payload)) {
    return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_EVIDENCE_UNAVAILABLE");
  }
  const rows = extractItems(msg.payload).filter((row) => isObj(row));
  const actor = recheckKey(ctx.actorClientId);
  const subscription = recheckKey(ctx.clientSubscriptionId);
  const boundId = recheckKey(bound.bookingId);
  const matches = rows.filter((row) => recheckKey(recheckRowBookingId(row)) === boundId);
  if (matches.length > 1) return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_AMBIGUOUS");
  if (matches.length === 1) {
    // The provider still lists the row: a live one is the ordinary replay, a cancelled
    // one is the orphaned claim this guard has to return.
    if (!recheckRowCancelled(matches[0])) {
      delete ctx.lk1ConfirmedReplay;
      return lk1Finish(ctx);
    }
    return releaseConfirmedOrphan(ctx, bound);
  }
  for (const row of rows) {
    if (recheckRowCancelled(row)) continue;
    if (recheckKey(recheckRowClientId(row)) !== actor) continue;
    const sub = recheckKey(recheckRowSubscriptionId(row));
    if (!sub) return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_SUBSCRIPTION_UNRESOLVED");
    if (sub === subscription) return lk1Stop(ctx, "LK1_CONFIRMED_BOOKING_STILL_ACTIVE");
  }
  // The complete page neither lists the bound booking nor holds a live booking of this
  // actor and subscription: the provider deleted it (exactly what the payment-timeout
  // cleanup does). The claim still holds the seat, so it is the one to return.
  return releaseConfirmedOrphan(ctx, bound);
}

if (ctx.step === LK1_CONFIRMED_ORPHAN_RELEASE) {
  const bound = isObj(ctx.lk1ConfirmedReplay) ? ctx.lk1ConfirmedReplay : {};
  const ackResults = isObj(msg.payload) ? [msg.payload, msg.payload.result] : [];
  let matched = 0;
  for (const result of ackResults) {
    if (!isObj(result)) continue;
    for (const value of [result.matchedCount, result.modifiedCount, result.upsertedCount,
      result.n, result.nModified]) {
      if (Number.isFinite(Number(value))) { matched = Number(value); break; }
    }
    if (matched > 0) break;
  }
  if (msg.error || matched < 1) {
    return lk1Stop(ctx, "LK1_CONFIRMED_ORPHAN_RELEASE_CONFLICT");
  }
  delete ctx.lk1ConfirmedReplay;
  const released = {
    code: "SUBSCRIPTION_BOOKING_CONFIRMED_ORPHAN_RELEASED",
    operationId: bound.operationId || null,
    releasedBookingId: bound.bookingId || null,
  };
  // `finishError` belongs to the booking router this body is embedded into; a partial
  // harness that only carries `finishPending` still gets the same pending contract.
  return typeof finishError === "function"
    ? finishError(ctx, 409, "Подтверждённая ранее запись отменена, место освобождено — присоединитесь заново", released)
    : finishPending(ctx, "Подтверждённая ранее запись отменена, место освобождено — присоединитесь заново", released);
}

if (ctx.step === "lk1_rejoin_predecessor_find") {
  const previousId = lk1RejoinPreviousId(ctx.operationId);
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
    || ctx.caller !== "split" || ctx.managedAction !== "JOIN_GAME" || !previousId
    || !lk1ReplayIdentityMatches(ctx, msg.payload[0], previousId)
    || !lk1ReleasedWithoutPayment(msg.payload[0])) {
    return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");
  }
  const previous = msg.payload[0];
  ctx.lk1Rejoin = { operationId: previousId, releaseOperationId: previous.releaseOperationId,
    bookingId: previous.releaseBookingId, releasedAt: previous.releasedAt };
  delete ctx.lk1IngressReplay;
  ctx.step = "lk1_profile_continue";
}

if (ctx.step === "lk1_money_owned_subscriptions") {
  const exercise = ctx.lk1MoneyExercise;
  const phase = ctx.lk1MoneyReturnStep;
  delete ctx.lk1MoneyExercise;
  delete ctx.lk1MoneyReturnStep;
  if (!isHttpOk(msg.statusCode) || !isObj(exercise) || !hasCompleteBookingList(msg.payload)) {
    return lk1Stop(ctx, "LK1_MONEY_OWNERSHIP_UNAVAILABLE");
  }
  const rows = extractItems(msg.payload);
  const validIdentityShape = (record) => {
    if (!isObj(record)) return false;
    for (const key of ["clientSubscriptionId", "subscriptionId", "clientSubId", "id", "uuid", "clientId",
      "productId", "subscriptionProductId", "templateId", "status", "purchaseDate", "purchaseAt", "activationDate", "expirationDate"]) {
      if (record[key] !== undefined && record[key] !== null
        && (typeof record[key] !== "string" || !record[key].trim())) return false;
    }
    for (const key of ["client", "clientSubscription", "clientSub", "product", "subscription", "template"]) {
      if (record[key] !== undefined && record[key] !== null && !validIdentityShape(record[key])) return false;
    }
    return true;
  };
  if (!rows.every(validIdentityShape)) return lk1Stop(ctx, "LK1_MONEY_OWNERSHIP_DTO_INVALID");
  const selected = findOwnedSubscriptions({ ...exercise, availableClientSubscriptions: rows }, ctx.clientSubscriptionId);
  const configured = lk1Config(selected, exercise?.studio?.id || exercise?.studioId || null);
  if (configured.code) return lk1Stop(ctx, configured.code);
  // The resolver alone decides the enforced cohort: the annual HUB rule carries no
  // sale-date gate, while every plan rule enters the contour only from its own
  // `enforceFrom`. The money mandate has to cover exactly that cohort. Re-applying the
  // pre-plan-rules sale date here kept the proof unsatisfiable for instances the resolver
  // had just marked enforced (an annual HUB sold before 2026-09-01: the quote requires the
  // readback evidence, this branch refused to produce it), so create/join on the event
  // route was refused with LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN for that whole cohort.
  const enforced = configured.matched && !configured.legacy;
  const dates = enforced ? collectSubscriptionPurchaseDateEvidence(selected) : { invalid: true, dates: [] };
  if (enforced && (dates.invalid || dates.dates.length !== 1)) {
    return lk1Stop(ctx, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  }
  delete ctx.lk1MoneyOwnership;
  if (enforced) {
    const subscription = selected[0];
    const instanceIds = [subscription?.clientSubscriptionId, subscription?.subscriptionId, subscription?.id]
      .filter((id) => id !== undefined);
    const owners = [subscription?.clientId, subscription?.client?.id].filter((id) => id !== undefined);
    const activation = lk1LifecycleInstant(subscription?.activationDate);
    const expiry = lk1LifecycleInstant(subscription?.expirationDate, true);
    const targetStart = finiteDate(eventStartsAt(exercise))?.getTime();
    const duration = eventDurationMinutes(exercise);
    const targetEnd = targetStart + duration * 60_000 - 1;
    // A `NEW` instance without an activation date is the first-use state: Viva writes the
    // activation and expiry with the very booking this mandate authorises, so those two
    // fields cannot be required before that write. The composed production layer computes
    // the identical verdict through its split-lifecycle helper; this reviewed source stays
    // free of that host library, so it names the state directly.
    const firstUse = String(subscription?.status || "").trim().toUpperCase() === "NEW"
      && !String(subscription?.activationDate || "").trim();
    const now = Date.now();
    // The verdict is the same conjunction as before, split into named violations so the
    // refusal reports which condition failed. Every branch below maps 1:1 to the previous
    // operand order and short-circuiting: a missing activation/expiry or an unresolved
    // target window still refuses before any instant comparison is evaluated.
    // Identity, hold/freeze and a resolvable event window stay unconditional; a first-use
    // instance is released from the lifecycle checks Viva can only answer after the write.
    const violations = [];
    if (selected.length !== 1) violations.push("instance_count");
    if (!instanceIds.length) violations.push("instance_id_missing");
    if (instanceIds.some((id) => normalizeId(id) !== normalizeId(ctx.clientSubscriptionId))) {
      violations.push("instance_id_mismatch");
    }
    if (owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))) violations.push("owner_mismatch");
    if (!firstUse) {
      if (subscription.status !== "ACTIVE") {
        violations.push(`status_${String(subscription.status || "missing").toLowerCase().slice(0, 24)}`);
      }
      if (activation === null) violations.push("activation_unparsed");
      if (expiry === null) violations.push("expiry_unparsed");
    }
    if (!Number.isFinite(targetStart) || !duration || !Number.isFinite(targetEnd)) {
      violations.push("target_window_unresolved");
    } else if (!firstUse) {
      if (activation !== null) {
        if (activation > now) violations.push("activation_in_future");
        if (activation > targetStart) violations.push("activation_after_target_start");
      }
      if (expiry !== null) {
        if (expiry < now) violations.push("expired");
        if (expiry < targetEnd) violations.push("expiry_before_target_end");
      }
    }
    if (subscription.holdUntil) violations.push("hold");
    if (subscription.frozenUntil) violations.push("frozen_until");
    if (subscription.isFrozen === true) violations.push("frozen");
    if (violations.length) {
      return lk1Stop(ctx, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN",
        { stage: "money_validity", violations, targetWindowKnown: Number.isFinite(targetStart) && Boolean(duration) });
    }
    ctx.lk1MoneyOwnership = { exerciseId: ctx.exerciseId, actorClientId: ctx.actorClientId,
      observedAt: Date.now(), subscription };
  }
  ctx.lk1MoneyReadbackPhase = phase;
  ctx.step = phase;
  msg.payload = exercise;
}

if (ctx.step === "lk1_event_tariff") {
  const exercise = ctx.lk1TariffExercise;
  const recheck = ctx.lk1TariffRecheck === true;
  delete ctx.lk1TariffExercise;
  delete ctx.lk1TariffRecheck;
  if (!isHttpOk(msg.statusCode) || !isObj(exercise) || !hasCompleteBookingList(msg.payload)) {
    return lk1Stop(ctx, "LK1_EVENT_TARIFF_UNAVAILABLE");
  }
  // Both event one-times are scoped by the server GET; Viva may omit exerciseId.
  const eventTariff = ["group_training", "tournament"].includes(resolveCategory(exercise));
  const tariffUrl = `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`;
  if (eventTariff && (msg.method !== "GET" || msg.url !== tariffUrl
    || (msg.responseUrl !== undefined && msg.responseUrl !== tariffUrl))) return lk1Stop(ctx, "LK1_EVENT_TARIFF_UNVERIFIED");
  const rows = extractItems(msg.payload);
  if (rows.length !== 1 || !isObj(rows[0])) return lk1Stop(ctx, "LK1_EVENT_TARIFF_AMBIGUOUS");
  const product = rows[0];
  const productIds = [product.id, product.productId].filter((id) => id !== undefined);
  const eventIds = [product.exerciseId, product.exercise?.id].filter((id) => id !== undefined);
  const paidAmounts = [product.cost, product.price, product.amount].filter((amount) => amount !== undefined);
  // The DTO carries two kinds of money: the paid price (`cost`/`price`/`amount` are
  // aliases of one number and must agree) and the trial price (`trialCost`), which
  // describes a different offer and only has to be a non-negative integer. Requiring the
  // trial price to equal the paid one refused every exercise whose trial tariff differs
  // (live evidence 2026-09-15: both fields present, two distinct non-zero integers).
  const trialAmountPresent = product.trialCost !== undefined;
  const trialAmount = trialAmountPresent ? product.trialCost : null;
  const types = [product.productType, product.type].filter((type) => type !== undefined);
  if (!productIds.length || !productIds.every((id) => typeof id === "string" && id.trim())
    || new Set(productIds).size !== 1 || (!eventTariff && !eventIds.length) || eventIds.some((id) => id !== ctx.exerciseId)
    || !types.length || types.some((type) => !["SERVICE", "ONE_TIME", "INSTANT_SUB_SERVICE", "ADVANCE_SUB_SERVICE"].includes(type))
    || !paidAmounts.length || paidAmounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || new Set(paidAmounts).size !== 1
    || (trialAmountPresent && (!Number.isSafeInteger(trialAmount) || trialAmount < 0))) return lk1Stop(ctx, "LK1_EVENT_TARIFF_UNVERIFIED");
  ctx.lk1TariffProof = { source: "VIVA_EXISTING_TARIFF", kind: "EVENT_ONE_TIME",
    productId: productIds[0], amountMinor: paidAmounts[0], stationId: toStr(exercise.studio?.id || exercise.studioId),
    roomId: exerciseRoomId(exercise), durationMinutes: eventDurationMinutes(exercise),
    startsAt: eventStartsAt(exercise), observedAt: Date.now() };
  if (recheck) {
    const quote = lk1Quote(ctx, exercise, lk1QuoteOwned(ctx, exercise));
    if (quote.code || quote.fingerprint !== ctx.lk1?.fingerprint) {
      return lk1Stop(ctx, "LK1_RULE_PRICE_OR_TARGET_CHANGED_BEFORE_WRITE");
    }
    return prepareBookingCreate(ctx);
  }
  ctx.step = "exercise";
  msg.payload = exercise;
}

if (ctx.step === "lk1_operation_find") {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return lk1Stop(ctx, "LK1_OPERATION_READ_FAILED");
  const operation = msg.payload[0];
  if (operation) {
    if (operation.operationId !== ctx.operationId || operation.actorClientId !== ctx.actorClientId
      || operation.tenantKey !== ctx.tenantKey || operation._id !== ctx.operationKey
      || operation.clientSubscriptionId !== ctx.clientSubscriptionId
      || operation.lk1?.fingerprint !== ctx.lk1.fingerprint
      || JSON.stringify(operation.lk1.createPayload) !== JSON.stringify(ctx.lk1CreatePayload)
      || !isObj(operation.lk1?.target) || lk1Fingerprint(ctx, operation.lk1) !== ctx.lk1.fingerprint
      || operation.lk1?.decision?.eligible !== true
      || !Number.isSafeInteger(operation.lk1?.decision?.benefit?.finalPriceMinor)
      || operation.lk1.decision.benefit.finalPriceMinor < 0
      || operation.lk1.decision.benefit.finalPriceMinor > 1_000_000
      || ![0, 1].includes(operation.lk1?.decision?.subscriptionVisitCount)) {
      return lk1Stop(ctx, "LK1_REQUEST_IDENTITY_CHANGED");
    }
    const actualTarget = ctx.lk1.target;
    ctx.lk1 = JSON.parse(JSON.stringify(operation.lk1));
    ctx.subscriptionVisitCount = ctx.lk1.decision.subscriptionVisitCount;
    ctx.confirmedBookingId = operation.bookingId || null;
    ctx.immediateBookingId = operation.upstreamBookingId || operation.bookingId || null;
    if (operation.state === "CONFIRMED" && ctx.confirmedBookingId) {
      if (ctx.lk1BeforeCreate === true) ctx.exerciseId = operation.exerciseId;
      return lk1Checkout(ctx);
    }
    if (operation.state === "PREPARED") return preparePreaccept(ctx);
    if (operation.state === "PENDING_CONFIRMATION" && ctx.managedAction === "CREATE_GAME"
      && ctx.caller === "split" && ctx.lk1.createAttemptedAt && !ctx.lk1.bookingAttemptedAt
      && operation.exerciseId === `preflight:${ctx.operationId}`
      && ctx.lk1CreateBinding?.operationKey === ctx.operationKey
      && ctx.lk1CreateBinding?.fingerprint === ctx.lk1.fingerprint) {
      ctx.lk1.target = actualTarget;
      ctx.lk1.bookingAttemptedAt = new Date().toISOString();
      return prepareMongoUpdate(ctx, "lk1_create_booking_bound", {
        _id: ctx.operationKey, operationId: ctx.operationId, state: "PENDING_CONFIRMATION",
        exerciseId: operation.exerciseId, "lk1.fingerprint": ctx.lk1.fingerprint,
        "lk1.createAttemptedAt": ctx.lk1.createAttemptedAt, "lk1.bookingAttemptedAt": { $exists: false },
      }, { $set: { exerciseId: ctx.exerciseId, "lk1.target": actualTarget,
        "lk1.bookingAttemptedAt": ctx.lk1.bookingAttemptedAt } });
    }
    // Never reclaim/overwrite an LK1 request or repeat an ambiguous Viva write.
    if (operation.state !== "PENDING_CONFIRMATION" || !ctx.immediateBookingId) {
      return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    }
    if (ctx.lk1BeforeCreate === true) ctx.exerciseId = operation.exerciseId;
    return prepareUserGet(ctx, "confirmation_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
  }
  if (ctx.managedAction === "CREATE_GAME" && ctx.lk1BeforeCreate !== true) {
    return lk1Stop(ctx, "LK1_CREATE_PREWRITE_BINDING_UNBOUND");
  }
  return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "lk1_create_attempt_saved") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    return lk1Stop(ctx, "LK1_CREATE_ATTEMPT_NOT_OWNED");
  }
  ctx.lk1CreateAck = { operationKey: ctx.operationKey, operationId: ctx.operationId,
    actorClientId: ctx.actorClientId, fingerprint: ctx.lk1.fingerprint,
    createAttemptedAt: ctx.lk1.createAttemptedAt, createPayload: ctx.lk1CreatePayload };
  msg.statusCode = 200;
  msg.payload = { ok: true, state: "LK1_CREATE_ATTEMPT_BOUND", operationId: ctx.operationId };
  return emit(OUTPUT_FINAL);
}

if (ctx.step === "lk1_create_booking_bound") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    return lk1Stop(ctx, "LK1_CREATE_BOOKING_ATTEMPT_NOT_OWNED");
  }
  return prepareUserGet(ctx, "exercise_recheck", `/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`);
}

// The category of a stored operation, for the day bucket of the free-first-event rule.
const lk1OperationCategory = (operation) => {
  const direct = normalizeId(operation?.category);
  if (direct) return direct;
  const managed = normalizeId(operation?.lk1?.target?.category);
  return managed === "group_training" || managed === "tournament" ? managed
    : managed === "game" ? "open_game" : null;
};

if (ctx.step === "lk1_usage_operations") {
  if (msg.error || !Array.isArray(msg.payload)) return lk1Stop(ctx, "LK1_ALLOWANCE_READ_FAILED");
  // Resolve membership before filtering: an incomplete/conflicting provider row
  // cannot prove that the selected subscription still has unused allowance.
  const relevantBookings = ctx.lk1.activeBookings.concat(ctx.lk1.bookings.filter((booking) =>
    !isInactiveBooking(booking) && (!eventDate(booking) || eventDate(booking) === ctx.serviceDate)));
  for (const booking of relevantBookings) {
    const aliases = [booking.clientSubscriptionId, booking.subscriptionId, booking.clientSubId];
    for (const nested of [booking.subscription, booking.clientSubscription]) {
      if (isObj(nested)) aliases.push(nested.clientSubscriptionId, nested.subscriptionId, nested.id, nested.uuid);
    }
    const present = aliases.filter((value) => value !== undefined && value !== null && value !== "");
    const ids = new Set(present.map(normalizeId).filter(Boolean));
    const paidBySubscription = [booking.paymentType, booking.paymentMethod]
      .some((value) => String(value || "").trim().toUpperCase() === "SUBSCRIPTION");
    if (present.some((value) => typeof value !== "string") || ids.size > 1
      || (paidBySubscription && ids.size !== 1)) return lk1Stop(ctx, "LK1_BOOKING_SUBSCRIPTION_ID_UNRESOLVED");
    if (ids.has(normalizeId(ctx.clientSubscriptionId)) && !eventDate(booking)) {
      return lk1Stop(ctx, "LK1_BOOKING_DATE_UNRESOLVED");
    }
  }
  let used = 0;
  const coveredBookings = new Set();
  const benefitBookings = new Set();
  // Free-first-event accounting: the covered cohort counts this subscription's events on the
  // target day from the same two sources the allowance already trusts (reserved operations
  // and provider bookings), deduplicated by booking identity. The cohort table lives at the
  // top of this node body; a harness that runs this step on its own simply has no cohort.
  const freeFirstProducts = typeof LK1_FREE_FIRST_EVENT_PRODUCTS === "object" && LK1_FREE_FIRST_EVENT_PRODUCTS
    ? LK1_FREE_FIRST_EVENT_PRODUCTS : null;
  const freeFirstCategories = freeFirstProducts
    ? freeFirstProducts[normalizeId(ctx.lk1.rule.productId)] || null : null;
  const freeFirstCovered = Boolean(freeFirstCategories && freeFirstCategories.includes(ctx.category));
  let freeFirstEventsToday = 0;
  for (const operation of msg.payload) {
    if (!isObj(operation) || operation.actorClientId !== ctx.actorClientId
      || operation.tenantKey !== ctx.tenantKey || !isValidDateKey(operation.serviceDate)
      || !isObj(operation.lk1?.decision)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
    if (!normalizeId(operation.clientSubscriptionId)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
    if (normalizeId(operation.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)) continue;
    if (["FAILED", "RELEASED"].includes(operation.state)) continue;
    // AUDIT_BINDING_START
    const aliases = [operation.bookingId, operation.upstreamBookingId]
      .filter(value => value !== undefined && value !== null && value !== "");
    if (aliases.some(value => typeof value !== "string" || !normalizeId(value))
      || new Set(aliases.map(normalizeId)).size > 1) return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
    let coveredId = normalizeId(operation.bookingId);
    if (!coveredId && normalizeId(operation.upstreamBookingId)) {
      const upstreamId = normalizeId(operation.upstreamBookingId);
      const matches = ctx.lk1.bookings.filter(booking => !isInactiveBooking(booking)
        && normalizeId(bookingId(booking)) === upstreamId);
      if (matches.length > 1) return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_AMBIGUOUS");
      if (matches.length === 1) {
        const booking = matches[0];
        const owners = [booking.clientId, booking.actorClientId, booking.profileId, booking.client?.id]
          .filter(value => value !== undefined && value !== null && value !== "");
        const exerciseIds = [booking.exerciseId, booking.exercise?.id, booking.exercise?.exerciseId]
          .filter(value => value !== undefined && value !== null && value !== "");
        if (owners.some(value => typeof value !== "string" || normalizeId(value) !== normalizeId(ctx.actorClientId))
          || !normalizeId(operation.exerciseId) || !exerciseIds.length
          || exerciseIds.some(value => typeof value !== "string" || normalizeId(value) !== normalizeId(operation.exerciseId))
          || eventDate(booking) !== operation.serviceDate
          || normalizeId(bookingSubscriptionId(booking)) !== normalizeId(operation.clientSubscriptionId)) {
          return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
        }
        const decision = operation.lk1.decision;
        if (decision.benefit?.finalPriceMinor === 0 && decision.subscriptionVisitCount === 1
          && decision.gameMinutes?.paidOverageMinutes === 0
          && decision.gameMinutes?.freeMinutes > 0
          && String(booking.paymentType || booking.paymentMethod || "").toUpperCase() === "SUBSCRIPTION") {
          const duration = eventDurationMinutes(booking.exercise || booking);
          const free = decision.gameMinutes.freeMinutes;
          if (!Number.isSafeInteger(free) || free !== duration || free > ctx.lk1.rule.freeGameMinutesPerDay
            || (operation.lk1.target?.durationMinutes !== undefined && operation.lk1.target.durationMinutes !== duration)) {
            return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
          }
          coveredId = upstreamId;
        }
      }
    }
    // AUDIT_BINDING_END
    if (coveredId) benefitBookings.add(coveredId);
    if (operation.serviceDate !== ctx.serviceDate) continue;
    if (freeFirstCovered && freeFirstCategories.includes(lk1OperationCategory(operation))) {
      freeFirstEventsToday += 1;
    }
    const minutes = operation.lk1.decision.gameMinutes;
    if (minutes) {
      if (minutes.localDate !== ctx.serviceDate || !Number.isSafeInteger(minutes.freeMinutes)
        || minutes.freeMinutes < 0) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
      used += minutes.freeMinutes;
    }
    if (coveredId) coveredBookings.add(coveredId);
  }
  for (const booking of ctx.lk1.bookings) {
    if (isInactiveBooking(booking) || eventDate(booking) !== ctx.serviceDate
      || normalizeId(bookingSubscriptionId(booking)) !== normalizeId(ctx.clientSubscriptionId)
      || coveredBookings.has(normalizeId(bookingId(booking)))) continue;
    const category = resolveCategory(booking);
    if (!category) return lk1Stop(ctx, "LK1_BOOKING_CATEGORY_UNRESOLVED");
    if (freeFirstCovered && freeFirstCategories.includes(category)) freeFirstEventsToday += 1;
    if (category !== "open_game") continue;
    const minutes = eventDurationMinutes(booking.exercise || booking);
    if (!minutes) return lk1Stop(ctx, "LK1_ALLOWANCE_PROVIDER_DURATION_UNRESOLVED");
    used += Math.min(ctx.lk1.rule.freeGameMinutesPerDay, minutes);
  }
  const active = ctx.lk1.activeBookings.filter((booking) =>
    normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId)
    || benefitBookings.has(normalizeId(bookingId(booking))));
  if (!Number.isSafeInteger(used)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
  if (!Number.isSafeInteger(freeFirstEventsToday)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
  // The visit balance of the selected instance: without a proved balance the evaluator keeps
  // the discount instead of granting a free event (the rollout contract keeps the booking
  // available either way).
  const identityVisitsLeft = ctx.lk1ProductIdentity?.subscription?.visitsLeft;
  const ownershipVisitsLeft = ctx.lk1MoneyOwnership?.subscription?.visitsLeft;
  const freeFirstVisitsLeft = Number.isSafeInteger(identityVisitsLeft) ? identityVisitsLeft
    : Number.isSafeInteger(ownershipVisitsLeft) ? ownershipVisitsLeft : null;
  const policy = {};
  for (const field of lk1Fields) policy[field] = ctx.lk1.rule[field];
  ctx.step = "lk1_policy_decision";
  msg._subscriptionBooking = ctx;
  msg._managedSubscriptionPolicyInput = { evaluatedAt: new Date().toISOString(),
    action: ctx.managedAction, lk1Policy: policy,
    lk1ProductBinding: { policyProductId: ctx.lk1.rule.productId,
      ownedProductId: ctx.lk1.rule.productId, clientSubscriptionId: ctx.clientSubscriptionId },
    target: ctx.lk1.target, usage: { activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY",
      dailyBucketLocalDate: ctx.serviceDate, activeServices: new Set(active.map(booking => normalizeId(bookingId(booking)))).size,
      usedOrReservedFreeMinutesToday: used,
      freeFirstEvent: freeFirstCovered
        ? { covered: true, usedEventsToday: freeFirstEventsToday, visitsLeft: freeFirstVisitsLeft }
        : { covered: false } } };
  delete ctx.lk1.bookings;
  delete ctx.lk1.activeBookings;
  return emit(OUTPUT_MANAGED_POLICY);
}

if (ctx.step === "lk1_policy_decision") {
  const decision = msg._managedSubscriptionPolicyDecision;
  // A visit-covered first event of the day is carried by the plan itself, and the widget quotes it
  // as the full benefit at zero (100% of the base). The reviewed comparison below verifies the
  // configured percentage of a charged quote, so that one shape is normalized to the reviewed
  // shape here. The amount still has to equal the authoritative decision — zero — and no charged
  // expectation is touched, so this cannot raise or lower what the decision already fixed.
  if (isObj(decision) && decision.subscriptionVisitCount === 1
    && decision.benefit?.kind === "FREE_ENTITLEMENT" && decision.benefit.finalPriceMinor === 0) {
    for (const [key, discountField] of [["expectedGroupDiscount", "groupTrainingDiscountPercent"],
      ["expectedTournamentDiscount", "tournamentDiscountPercent"]]) {
      const quote = ctx[key];
      if (isObj(quote) && quote.discountPercent === 100 && quote.amountMinor === 0) {
        ctx[key] = { ...quote, discountPercent: ctx.lk1.rule[discountField] };
      }
    }
  }
  if (!isObj(decision) || decision.eligible !== true || !isObj(decision.benefit)
    || !Number.isSafeInteger(decision.benefit.finalPriceMinor) || decision.benefit.finalPriceMinor < 0
    || decision.benefit.finalPriceMinor > 1_000_000
    || ![0, 1].includes(decision.subscriptionVisitCount)) return lk1Stop(ctx, "LK1_DECISION_INVALID");
  // Client quotes only constrain the server decision; neither category nor price is trusted.
  const expectedGroup = ctx.expectedGroupDiscount;
  const expectedTournament = ctx.expectedTournamentDiscount;
  if (expectedGroup !== undefined || expectedTournament !== undefined) {
    const route = lk1EventPaymentRoute(ctx);
    const expected = expectedGroup !== undefined ? expectedGroup : expectedTournament;
    const expectedAction = expectedGroup !== undefined ? "BOOK_GROUP_TRAINING" : "BOOK_TOURNAMENT";
    const target = ctx.lk1.target;
    // The percent the advisory preview quotes for a charged event. It is the percent the
    // decision itself fixed — the club training may charge the full price (0 %), a share of
    // the price (the quarter-of-court co-pay) or the configured event discount — while a
    // visit-covered first event keeps the reviewed normalization above, where the widget's
    // 100 % at zero is rewritten to the configured percent.
    const lk1ExpectedEventDiscountPercent = (decision, route) => (
      isObj(decision) && decision.benefit?.kind !== "FREE_ENTITLEMENT"
        && Number.isInteger(decision.eventDiscountPercent)
        ? decision.eventDiscountPercent
        : ctx.lk1.rule[route.discountField]);
    if ((expectedGroup !== undefined && expectedTournament !== undefined)
      || !route || ctx.managedAction !== expectedAction || ctx.caller !== "http"
      || ctx.category !== route.sourceCategory || target.category !== route.category || !isObj(expected)
      || Object.keys(expected).sort().join() !== ["basePriceMinor", "amountMinor", "productId", "startsAt", "durationMinutes", "discountPercent"].sort().join()
      || !Number.isSafeInteger(expected.basePriceMinor) || !Number.isSafeInteger(expected.amountMinor)
      || expected.basePriceMinor !== target.basePriceMinor || expected.amountMinor !== decision.benefit.finalPriceMinor
      || expected.productId !== target.priceProductId
      || expected.discountPercent !== lk1ExpectedEventDiscountPercent(decision, route)
      || expected.durationMinutes !== target.durationMinutes || typeof expected.startsAt !== "string"
      || Date.parse(expected.startsAt) !== Date.parse(target.startsAt)) {
      return finishError(ctx, 409, "Стоимость или условия подписки изменились. Обновите варианты записи.", {
        code: expectedAction === "BOOK_GROUP_TRAINING" ? "GROUP_DISCOUNT_QUOTE_CHANGED" : "TOURNAMENT_DISCOUNT_QUOTE_CHANGED" });
    }
  }
  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));
  ctx.subscriptionVisitCount = decision.subscriptionVisitCount;
  ctx.step = "operation_insert";
  msg._subscriptionBooking = ctx;
  const now = new Date().toISOString();
  const record = { _id: ctx.operationKey, tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    clientSubscriptionId: ctx.clientSubscriptionId, operationId: ctx.operationId,
    exerciseId: ctx.exerciseId, serviceDate: ctx.serviceDate, category: ctx.category,
    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),
    ...(ctx.lk1Rejoin ? { rejoinPredecessor: ctx.lk1Rejoin } : {}),
    createdAt: now, updatedAt: now, leaseUntil: new Date(Date.now() + PREPARED_LEASE_MS).toISOString() };
  msg.payload = [record, { writeConcern: { w: "majority", j: true } }];
  return emit(OUTPUT_MONGO_INSERT);
}

const paymentRoute = lk1EventPaymentRoute(ctx);
if (paymentRoute && ctx.step === paymentRoute.productsStep) return lk1PrepareEventPayment(ctx, paymentRoute);
if (ctx.step === "lk1_payment_products") {
  if (paymentRoute || !["JOIN_GAME", "CREATE_GAME"].includes(ctx.managedAction)
    || ctx.caller !== "split" || ctx.lk1?.target?.category !== "GAME") return lk1Stop(ctx, "LK1_PAYMENT_ROUTE_INVALID");
  if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, "LK1_PAYMENT_CARRIER_UNAVAILABLE");
  msg.statusCode = 200;
  msg._subscriptionBooking = ctx;
  return emit(OUTPUT_FINAL);
}

if (ctx.step === "lk1_payment_profile_recheck" || (paymentRoute && ctx.step === paymentRoute.profileStep)) {
  const profile = unwrapRecord(msg.payload);
  const eventPayment = Boolean(paymentRoute);
  if (eventPayment && (ctx.step !== paymentRoute.profileStep
    || ctx.lk1EventPayment?.category !== paymentRoute.category)) return lk1Stop(ctx, "LK1_PAYMENT_ROUTE_INVALID");
  const paymentContext = eventPayment ? ctx.lk1EventPayment : msg._splitCtx;
  const payload = paymentContext?.transactionPayload;
  const product = payload?.products?.[0];
  const binding = eventPayment ? lk1EventPaymentQuoteBinding(ctx) : null;
  if (eventPayment && (!binding || product?.id !== binding.productId)) return lk1Stop(ctx, paymentRoute.code + "_BINDING_INVALID");
  if (!eventPayment && (!["JOIN_GAME", "CREATE_GAME"].includes(ctx.managedAction)
    || ctx.caller !== "split" || ctx.lk1?.target?.category !== "GAME")) return lk1Stop(ctx, "LK1_PAYMENT_ROUTE_INVALID");
  if (!isHttpOk(msg.statusCode) || normalizeId(profile?.id || profile?.clientId) !== normalizeId(ctx.actorClientId)
    || normalizePhone(profile?.phone || profile?.phoneNumber) !== normalizePhone(ctx.actorPhone)
    || !isObj(payload) || !Array.isArray(payload.products) || payload.products.length !== 1
    || !isObj(product) || product.type !== "SERVICE" || product.count !== 1 || product.customAmount !== null
    || !Array.isArray(product.bookingIds) || product.bookingIds.length !== 1
    || product.bookingIds[0] !== ctx.confirmedBookingId
    || payload.studioId !== ctx.studioId || payload.paymentMethod !== "SMS"
    || normalizePhone(payload.clientPhone) !== normalizePhone(ctx.actorPhone)
    || typeof product.id !== "string" || product.id !== paymentContext.productId
    || !Number.isSafeInteger(product.discount)
    || product.discount !== (eventPayment ? binding.baseMinor : 1_000_000) - ctx.lk1.decision.benefit.finalPriceMinor) {
    return lk1Stop(ctx, "LK1_PAYMENT_INTENT_INVALID");
  }
  // The rule is re-resolved to prove it did not change, so the sale date of the stored quote
  // has to travel with it: a plan rule selects its cohort from that date, and without it the
  // resolver answers with a code instead of the rule and every plan-product checkout is
  // refused after the booking was already written. The station travels with it for the same
  // reason: it is part of the contour decision the stored quote was priced with.
  const configured = lk1Config([{ productId: ctx.lk1.rule.productId, purchaseDate: ctx.lk1.purchaseDate }],
    ctx.lk1.target?.stationId || ctx.studioId || null);
  if (!isObj(configured.rule) || JSON.stringify(configured.rule) !== JSON.stringify(ctx.lk1.rule)) {
    return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");
  }
  const attemptedAt = new Date().toISOString();
  ctx.lk1.transactionAttemptedAt = attemptedAt;
  ctx.lk1.transactionIntent = { productId: product.id, bookingId: ctx.confirmedBookingId,
    actorClientId: ctx.actorClientId, studioId: ctx.studioId,
    chargeMinor: ctx.lk1.decision.benefit.finalPriceMinor, discountMinor: product.discount,
    ...(eventPayment ? { productType: binding.productType, baseMinor: binding.baseMinor } : {}) };
  // No credentials, phone or caller redirects in the durable price/minute record.
  ctx.lk1TransactionPayload = { clientPhone: payload.clientPhone, paymentMethod: "SMS",
    products: [product], studioId: ctx.studioId, discountReason: payload.discountReason,
    offlineTillId: null, deposit: 0 };
  return prepareMongoUpdate(ctx, "lk1_payment_attempt_saved", {
    _id: ctx.operationKey, operationId: ctx.operationId, state: "CONFIRMED", bookingId: ctx.confirmedBookingId,
    "lk1.fingerprint": ctx.lk1.fingerprint, "lk1.transactionAttemptedAt": { $exists: false },
  }, { $set: { "lk1.transactionAttemptedAt": attemptedAt,
    "lk1.transactionIntent": ctx.lk1.transactionIntent } });
}

if (ctx.step === "lk1_payment_attempt_saved") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    return lk1Stop(ctx, "LK1_PAYMENT_ATTEMPT_NOT_OWNED");
  }
  const payload = ctx.lk1TransactionPayload;
  delete ctx.lk1TransactionPayload;
  const token = readGlobal("vivacrm_access_token");
  if (!token) return lk1Stop(ctx, "LK1_SERVICE_TOKEN_UNAVAILABLE");
  return prepareHttp(ctx, "lk1_transaction_create", "POST", `${VIVA_API_BASE}/api/v1/transactions`, payload,
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
}

if (ctx.step === "lk1_transaction_create") {
  const result = unwrapRecord(msg.payload);
  const ids = [...new Set([result?.id, result?.transactionId].filter((value) => value !== undefined && value !== null))];
  if (!isHttpOk(msg.statusCode) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0].trim()) {
    return lk1Stop(ctx, "LK1_TRANSACTION_OUTCOME_UNKNOWN");
  }
  ctx.lk1.transactionId = ids[0];
  return prepareMongoUpdate(ctx, "lk1_transaction_id_saved", {
    _id: ctx.operationKey, operationId: ctx.operationId, bookingId: ctx.confirmedBookingId,
    "lk1.transactionAttemptedAt": ctx.lk1.transactionAttemptedAt,
    "lk1.transactionId": { $exists: false },
  }, { $set: { "lk1.transactionId": ids[0] } });
}

if (ctx.step === "lk1_transaction_id_saved") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1) return lk1Stop(ctx, "LK1_TRANSACTION_ID_NOT_PERSISTED");
  return prepareAdminGet(ctx, "lk1_transaction_readback", `/api/v1/transactions/${encodeURIComponent(ctx.lk1.transactionId)}`);
}

if (ctx.step === "lk1_transaction_readback") {
  const transaction = unwrapRecord(msg.payload);
  const intent = ctx.lk1.transactionIntent;
  if (paymentRoute) {
    const binding = lk1EventPaymentQuoteBinding(ctx);
    if (!binding || !isObj(intent) || intent.productId !== binding.productId
      || intent.productType !== binding.productType || intent.baseMinor !== binding.baseMinor
      || intent.chargeMinor !== binding.chargeMinor || intent.discountMinor !== binding.discountMinor) {
      return lk1Stop(ctx, paymentRoute.code + "_BINDING_INVALID");
    }
  }
  // All supplied aliases are evidence, not alternatives from which to pick a
  // convenient value. Conflicting or malformed evidence cannot prove a bill.
  const one = (values, valid) => {
    const present = values.filter((value) => value !== undefined);
    return present.length && present.every(valid) && new Set(present).size === 1
      ? present[0] : undefined;
  };
  const stringId = (value) => typeof value === "string" && value.trim().length > 0;
  // Viva echoes the same identity flat or inside a referenced record, so every
  // alias family is collected before it is judged.
  const collectIds = (value, keys) => {
    const bucket = [];
    const visit = (candidate) => {
      if (candidate === undefined || candidate === null || candidate === "") return;
      if (Array.isArray(candidate)) { candidate.forEach(visit); return; }
      if (typeof candidate === "object") { keys.forEach((key) => visit(candidate[key])); return; }
      if (stringId(candidate)) bucket.push(candidate.trim());
    };
    visit(value);
    return bucket;
  };
  const id = one([transaction?.id, transaction?.transactionId], stringId);
  const amount = one([transaction?.toPayMinor, transaction?.toPay], Number.isSafeInteger);
  // Viva carries the checkout link inside cardPaymentInfo/cardPaymentStatus; the
  // flat fields are only the older shape of the same bill.
  const paymentUrl = one([transaction?.paymentUrl, transaction?.paymentLink,
    transaction?.cardPaymentInfo?.paymentUrl, transaction?.cardPaymentInfo?.paymentLink,
    transaction?.cardPaymentStatus?.paymentUrl, transaction?.cardPaymentStatus?.paymentLink], stringId);
  const clientIds = [...collectIds(transaction?.clientId, ["id"]),
    ...collectIds(transaction?.client, ["id", "uuid", "clientId"])];
  const clientId = one(clientIds, stringId);
  const products = transaction?.products;
  // Only the intent fields the provider actually echoes can be compared.
  const productsValid = products === undefined || (Array.isArray(products) && products.length === 1
    && isObj(products[0]) && (products[0].id === undefined || products[0].id === intent?.productId)
    && (products[0].type === undefined || products[0].type === "SERVICE")
    && (products[0].count === undefined || products[0].count === 1)
    && (products[0].discount === undefined || products[0].discount === intent?.discountMinor));
  const bookingEvidence = [
    ...collectIds(transaction?.bookingId, ["id", "uuid", "bookingId", "clientBookingId"]),
    ...collectIds(transaction?.bookingIds, ["id", "uuid", "bookingId", "clientBookingId"]),
    ...collectIds(transaction?.paymentBookingIds, ["id", "uuid", "bookingId", "clientBookingId"]),
  ];
  if (Array.isArray(products)) for (const product of products) {
    for (const key of ["bookingId", "bookingIds", "paymentBookingIds", "clientBookingId"]) {
      bookingEvidence.push(...collectIds(product?.[key], ["id", "uuid", "bookingId", "clientBookingId"]));
    }
    if (Array.isArray(product?.pricingDetails)) for (const detail of product.pricingDetails) {
      bookingEvidence.push(...collectIds(detail?.clientBookingId, ["id", "uuid", "bookingId", "clientBookingId"]));
      bookingEvidence.push(...collectIds(detail?.bookingId, ["id", "uuid", "bookingId", "clientBookingId"]));
    }
  }
  const bookingId = one(bookingEvidence, stringId);
  const safeUrl = isNodeRedHttpsCheckout(paymentUrl);
  // A provider that omits an echo proves nothing either way: the persisted
  // intent, the exact transaction id and the exact payable amount already bind
  // this bill. Every alias the provider does supply must agree with the intent.
  if (!isHttpOk(msg.statusCode) || !isObj(transaction) || !isObj(intent)
    || id !== ctx.lk1.transactionId
    || (clientIds.length > 0 && normalizeId(clientId) !== normalizeId(ctx.actorClientId))
    || (bookingEvidence.length > 0 && normalizeId(bookingId) !== normalizeId(ctx.confirmedBookingId))
    || !productsValid
    || !Number.isSafeInteger(amount) || amount !== intent.chargeMinor || !safeUrl
    || (transaction.currency !== undefined && transaction.currency !== "RUB")) {
    return lk1Stop(ctx, "LK1_TRANSACTION_READBACK_MISMATCH");
  }
  ctx.lk1.checkout = { transactionId: id, paymentUrl, toPayMinor: amount };
  return prepareMongoUpdate(ctx, "lk1_checkout_saved", {
    _id: ctx.operationKey, operationId: ctx.operationId, bookingId: ctx.confirmedBookingId,
    "lk1.transactionId": id, "lk1.transactionAttemptedAt": ctx.lk1.transactionAttemptedAt,
  }, { $set: { "lk1.checkout": ctx.lk1.checkout } });
}

if (ctx.step === "lk1_checkout_saved") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1) return lk1Stop(ctx, "LK1_CHECKOUT_NOT_PERSISTED");
  return lk1Finish(ctx);
}

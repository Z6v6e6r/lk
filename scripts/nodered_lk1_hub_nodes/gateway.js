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
  // «Дружба 2 часа» (owner decision 2026-09-30): the day's covered event may also be a
  // «Время на друзей» session, including «Время на друзей (особый)» (2026-11-11).
  // Other tournament directions keep their configured discount.
  "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze(["tournament"]),
});
// A product listed here covers only the named directions of its categories; a product
// absent from this table keeps the whole category covered.
const LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES = Object.freeze({
  // «Время на друзей» and «Время на друзей (особый)» of the club.
  "6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze([5278, 5280]),
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
  if (isSpanishTrainingExercise(exercise)) return { code: "SPANISH_TRAINING_SUBSCRIPTION_UNAVAILABLE" };
  // The station of the resolved booking target is part of the contour decision: an
  // excluded station keeps the product's legacy path for this quote as well.
  const configured = lk1Config(owned, exercise?.studio?.id || exercise?.studioId || null);
  if (!configured.matched || configured.code) return { code: configured.code || "LK1_PRODUCT_RULE_CHANGED" };
  if (configured.legacy) return { legacy: true };
  if (resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)
    && !isProTrainingDiscountRule(configured.rule)) return { code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE" };
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
    ...(resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)
      ? { proTraining: true } : {}),
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
  // The club co-pay of «Дружба Топократы» is charged against the HOUR of court, never against
  // the event's one-time tariff (owner decision 2026-10-05). The hour has exactly one
  // server-owned source here: the whole court window the gateway proved for this station, room
  // and time through the master-service price lookup. The window total travels in the proof as
  // `windowTotalMinor`, so the stored fingerprint and the charge both describe the same window
  // and the derived hour is reproducible on a resumed request. A proof without a whole window
  // leaves the target without an hourly price and the evaluator refuses the club charge
  // (`LK1_COURT_PRICE_UNRESOLVED`) instead of falling back to the tariff that produced 500 ₽.
  const courtWindowTotalMinor = Number.isSafeInteger(proof.windowTotalMinor) && proof.windowTotalMinor > 0
    ? proof.windowTotalMinor : null;
  if (courtWindowTotalMinor !== null) {
    const hourlyCourtPriceMinor = Math.round(courtWindowTotalMinor * 60 / proof.durationMinutes);
    if (Number.isSafeInteger(hourlyCourtPriceMinor) && hourlyCourtPriceMinor > 0) {
      target.hourlyCourtPriceMinor = hourlyCourtPriceMinor;
    }
  }
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
  if (isObj(ctx.lk1?.unpaidCancellation)) return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");
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
  if (typeof lk1SeatReleasedOperation === "function" && lk1SeatReleasedOperation(operation)) return true;
  if (typeof lk1FreeReturnedOperation === "function" && lk1FreeReturnedOperation(operation)) return true;
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

// lk1Free* pure protocol is embedded from lib/lk1FreeCancellation.mjs.
const lk1FreeServiceToken = () => {
  try {
    const token = toStr(readGlobal('vivacrm_access_token'));
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 60_000 ? token : null;
  } catch (_) { return null; }
};
const lk1FreeApplyEffect = (ctx, effect) => {
  if (effect.kind === 'reply') {
    delete ctx.lk1FreeCancellation;
    if (effect.status >= 400) return finishError(ctx, effect.status, effect.payload.message, effect.payload.details);
    msg._subscriptionBooking = ctx; msg.statusCode = effect.status;
    msg.headers = responseHeaders(); msg.payload = effect.payload;
    return emit(OUTPUT_FINAL);
  }
  if (effect.kind === 'find') {
    delete ctx.lk1FreeExpectedHttp;
    return lk1Find(ctx, 'lk1_free_cancel_effect', effect.query);
  }
  if (effect.kind === 'update') {
    delete ctx.lk1FreeExpectedHttp;
    if (effect.change.$set?.phase === 'CANCEL_INTENT' && !lk1FreeServiceToken()) {
      return lk1FreeApplyEffect(ctx, lk1FreeStep(ctx.lk1FreeCancellation, { error: true }));
    }
    ctx.step = 'lk1_free_cancel_effect'; msg._subscriptionBooking = ctx;
    msg.payload = [effect.query, effect.change, effect.options]; delete msg.error;
    return emit(OUTPUT_MONGO_UPDATE);
  }
  if (effect.kind === 'http') {
    const token = lk1FreeServiceToken();
    if (!token) return lk1FreeApplyEffect(ctx, lk1FreeStep(ctx.lk1FreeCancellation, { error: true }));
    ctx.lk1FreeExpectedHttp = { method: effect.method, url: VIVA_API_BASE + effect.path };
    return prepareHttp(ctx, 'lk1_free_cancel_effect', effect.method, VIVA_API_BASE + effect.path,
      effect.body, { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' });
  }
  return lk1Stop(ctx, 'LK1_FREE_CANCEL_EFFECT_INVALID');
};
const lk1FreeStart = (ctx, verifyOnly = false) => {
  const begun = lk1FreeBegin({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    bookingId: ctx.releaseBookingId, requestId: verifyOnly ? null : ctx.operationId, verifyOnly });
  ctx.lk1FreeCancellation = begun.state;
  return lk1FreeApplyEffect(ctx, begun.effect);
};
const lk1FreePrewriteGate = (ctx, continuation) => {
  ctx.lk1FreeGateContinuation = continuation;
  return lk1Find(ctx, 'lk1_free_cancel_booking_gate', { kind: 'LK1_FREE_CANCEL_JOB_V1',
    tenantKey: ctx.tenantKey, clientSubscriptionId: normalizeId(ctx.clientSubscriptionId),
    phase: { $in: lk1FreePending } });
};
const lk1SeatApplyEffect = (ctx, effect) => {
  if (effect.kind === 'reply') {
    const resume = ctx.lk1SeatContinuation;
    ctx.lk1SeatSeen = { ...ctx.lk1SeatSeen, [resume.ownerKey]: true };
    delete ctx.lk1SeatRecovery; delete ctx.lk1SeatContinuation; delete ctx.lk1SeatExpectedHttp;
    return lk1Find(ctx, resume.step, resume.step === 'lk1_usage_operations'
      ? { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId }
      : { _id: resume.ownerKey });
  }
  if (effect.kind === 'find') return lk1Find(ctx, 'lk1_seat_recovery', effect.query);
  if (effect.kind === 'update') {
    ctx.step = 'lk1_seat_recovery'; msg._subscriptionBooking = ctx;
    msg.payload = [effect.query, effect.change, effect.options]; delete msg.error;
    return emit(OUTPUT_MONGO_UPDATE);
  }
  if (effect.kind === 'http' && effect.method === 'GET') {
    const token = lk1FreeServiceToken();
    if (!token) return lk1SeatApplyEffect(ctx, lk1FreeStep(ctx.lk1SeatRecovery, { error: true }));
    ctx.lk1SeatExpectedHttp = VIVA_API_BASE + effect.path;
    return prepareHttp(ctx, 'lk1_seat_recovery', 'GET', ctx.lk1SeatExpectedHttp,
      undefined, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
  }
  return lk1Stop(ctx, 'LK1_SEAT_EFFECT_INVALID');
};
const lk1SeatStart = (ctx, owner) => {
  if (!lk1SeatCandidate(owner) || ctx.lk1SeatSeen?.[owner._id]
    || owner.actorClientId !== ctx.actorClientId || owner.tenantKey !== ctx.tenantKey
    || normalizeId(owner.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)) return null;
  const begun = lk1FreeBegin({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    bookingId: owner.bookingId || null, seatOnly: true, operationKey: owner._id,
    reservationKey: ctx.operationKey, requestId: `lk-seat-release:${owner.operationId.slice(0, 130)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}` });
  ctx.lk1SeatContinuation = { step: ctx.step, ownerKey: owner._id };
  ctx.lk1SeatRecovery = begun.state;
  return lk1SeatApplyEffect(ctx, begun.effect);
};
// HUB_STEPS
if (ctx.step === 'lk1_seat_recovery') {
  if (!ctx.lk1SeatRecovery || !ctx.lk1SeatContinuation) return lk1Stop(ctx, 'LK1_SEAT_CONTEXT_MISSING');
  const expected = ctx.lk1SeatExpectedHttp;
  const invalid = expected && (msg.method !== 'GET' || msg.url !== expected || msg.responseUrl !== expected);
  delete ctx.lk1SeatExpectedHttp;
  return lk1SeatApplyEffect(ctx, lk1FreeStep(ctx.lk1SeatRecovery,
    { payload: msg.payload, status: msg.statusCode, error: !!msg.error || !!invalid }));
}
if (['lk1_ingress_operation_find', 'lk1_http_rejoin_predecessor_find', 'lk1_rejoin_predecessor_find'].includes(ctx.step)
  && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1) {
  const started = lk1SeatStart(ctx, msg.payload[0]);
  if (started) return started;
}
if (ctx.step === 'lk1_usage_operations' && !msg.error && Array.isArray(msg.payload)) {
  for (const owner of msg.payload) {
    if (owner?.serviceDate !== ctx.serviceDate || owner.state !== 'CONFIRMED') continue;
    const cancelled = ctx.lk1?.bookings?.some(row => (row.id || row.bookingId) === owner.bookingId
      && (row.isCancelled === true || row.cancelled === true));
    if (cancelled) { const started = lk1SeatStart(ctx, owner); if (started) return started; }
  }
}
if (ctx.step === 'lk1_profile_continue' && ctx.action === 'cancel-free') return lk1FreeStart(ctx);
if (ctx.step === 'lk1_free_cancel_effect') {
  if (!ctx.lk1FreeCancellation) return lk1Stop(ctx, 'LK1_FREE_CANCEL_CONTEXT_MISSING');
  const expected = ctx.lk1FreeExpectedHttp;
  const provenanceError = expected && (msg.method !== expected.method || msg.url !== expected.url || msg.responseUrl !== expected.url);
  delete ctx.lk1FreeExpectedHttp;
  return lk1FreeApplyEffect(ctx, lk1FreeStep(ctx.lk1FreeCancellation,
    { payload: msg.payload, status: msg.statusCode, error: !!msg.error || !!provenanceError }));
}
if (ctx.step === 'lk1_free_cancel_booking_gate') {
  if (msg.error || !Array.isArray(msg.payload)) return lk1Stop(ctx, 'LK1_FREE_CANCEL_GATE_READ_UNAVAILABLE');
  if (msg.payload.length) return finishError(ctx, 409,
    'Дождитесь подтверждения возврата посещения по отменяемой записи.', { code: 'LK1_FREE_CANCEL_RETURN_PENDING' });
  const continuation = ctx.lk1FreeGateContinuation;
  delete ctx.lk1FreeGateContinuation; ctx.lk1FreeGateCleared = true;
  return continuation === 'booking' ? prepareBookingCreate(ctx) : preparePreaccept(ctx);
}

// A stored attempt whose provider write was cleanly refused, or that never reached the
// provider at all, is terminal and unambiguous. The request id is deterministic
// (clientId|subscription|exercise), so without this reclaim a single refusal would make the
// exercise permanently unbookable for that client: every retry replays the same document and
// the ingress answers an unresolvable pending (production incident 2026-09-25, direction 6233
// «Топократы тренировка»: Viva refused «Абонемент «РА» не действует на этом занятии: другой тип
// занятия, другое направление», and neither the subscription, the co-pay nor a one-off could be
// booked afterwards).
// Portable on purpose: this fragment is composed both with and without the hook helpers, so it
// brings its own two readers instead of relying on isObj/toStr.
const lk1ReclaimIsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lk1ReclaimText = (value) => (typeof value === "string" && value.trim()) ? value.trim()
  : (typeof value === "number" && Number.isFinite(value)) ? String(value) : null;
const LK1_RECLAIM_ATTEMPT_CAP = 5;
const lk1ReclaimableAttempt = (operation) => {
  if (!lk1ReclaimIsRecord(operation)) return false;
  // A bounded number of restarts: an attempt that keeps failing on unchanged conditions must
  // not be replayed forever.
  if ((Number(operation.attempts) || 0) >= LK1_RECLAIM_ATTEMPT_CAP) return false;
  // An attempt that ever reached a booking, an accepted provider write or a money leg is never
  // replayed: its outcome is not ours to repeat.
  if (lk1ReclaimText(operation.bookingId) || lk1ReclaimText(operation.upstreamBookingId)) return false;
  if (lk1ReclaimText(operation.acceptedAt) || lk1ReclaimText(operation.correlationId)) return false;
  if (lk1ReclaimText(operation.lk1?.createAttemptedAt) || lk1ReclaimText(operation.lk1?.bookingAttemptedAt)) return false;
  if (lk1ReclaimText(operation.lk1?.transactionAttemptedAt) || lk1ReclaimText(operation.lk1?.transactionId)
    || lk1ReclaimIsRecord(operation.lk1?.transactionIntent) || lk1ReclaimIsRecord(operation.lk1?.checkout)
    || lk1ReclaimIsRecord(operation.lk1?.visitJob)) return false;
  if (operation.state === "FAILED") {
    const failure = operation.failure;
    if (!lk1ReclaimIsRecord(failure)) return false;
    const status = Number(failure.statusCode);
    // Only an explicit provider refusal (4xx) is a clean verdict. A 5xx or a transport failure
    // leaves the outcome unknown and keeps the existing reconciliation path.
    if (!Number.isInteger(status) || status < 400 || status >= 500) return false;
    return Boolean(lk1ReclaimText(operation.upstreamAttemptedAt) && lk1ReclaimText(operation.failedAt));
  }
  // Nothing was ever attempted: the document only reserved the deterministic id.
  return operation.state === "PREPARED" && !lk1ReclaimText(operation.upstreamAttemptedAt);
};
// A successor is selected by a later explicit click, never by a polling retry.
const lk1HttpRejoinIdentity = id => {
  const match = typeof id === "string" && /^(lk-subscription-[a-z0-9]+)(?::rejoin:([1-9]\d{0,3}))?$/.exec(id);
  return match && Number(match[2] || 0) <= 1000
    ? { base: match[1], generation: Number(match[2] || 0) } : null;
};
const lk1HttpRejoinPrevious = id => {
  const value = lk1HttpRejoinIdentity(id);
  return value?.generation > 0
    ? (value.generation === 1 ? value.base : `${value.base}:rejoin:${value.generation - 1}`) : null;
};
const lk1HttpRejoinRequest = ctx => ctx.caller === "http" && ctx.action === "book";
const lk1SafeCancelledUnpaidSuccessor = operation => {
  const proof = operation.lk1?.cancelledAllowanceRelease;
  const checkout = operation.lk1?.checkout;
  const intent = operation.lk1?.transactionIntent;
  const identity = lk1HttpRejoinIdentity(operation.operationId);
  const previousId = lk1HttpRejoinPrevious(operation.operationId);
  return identity && identity.generation < 1000 && operation.state === "RELEASED"
    && ["group_training", "tournament"].includes(operation.category)
    && (operation.releaseReason === "CANCELLED_UNPAID_BOOKING" ? !operation.lk1?.unpaidCancellation
      : operation.releaseReason === "LK1_UNPAID_CHECKOUT_EXPIRED"
        && operation.lk1?.unpaidCancellation?.phase === "CANCELLED"
        && operation.lk1.unpaidCancellation.verifiedAt === operation.releasedAt)
    && operation.lk1?.decision?.subscriptionVisitCount === 0 && !operation.lk1?.visitJob
    && proof?.schemaVersion === 1
    && proof.proofId === operation.operationId && proof.bookingState === "CANCELLED"
    && proof.transactionState === "UNPAID_EXPIRED" && proof.verifiedAt === operation.releasedAt
    && Number.isFinite(Date.parse(proof.verifiedAt))
    && proof.bookingId === operation.bookingId && proof.transactionId === checkout?.transactionId
    && proof.transactionId === operation.lk1.transactionId
    && intent?.bookingId === operation.bookingId && intent.actorClientId === operation.actorClientId
    && Number.isSafeInteger(proof.amountMinor) && proof.amountMinor > 0
    && proof.amountMinor === checkout.toPayMinor && proof.amountMinor === intent.chargeMinor
    && proof.amountMinor === operation.lk1.decision.benefit?.finalPriceMinor
    && (!operation.upstreamBookingId || operation.upstreamBookingId === operation.bookingId)
    && operation.serviceDate === operation.lk1.target?.startsAt?.slice(0, 10)
    && (!previousId || (operation.rejoinPredecessor?.rootOperationId === identity.base
      && operation.rejoinPredecessor?.operationId === previousId));
};
const lk1HttpReleaseAllowsRejoin = operation => {
  if (lk1SafeCancelledUnpaidSuccessor(operation)) return true;
  const identity = lk1HttpRejoinIdentity(operation.operationId);
  const previous = lk1HttpRejoinPrevious(operation.operationId);
  return identity && identity.generation < 1000
    && typeof lk1FreeReturnedOperation === "function" && (lk1FreeReturnedOperation(operation)
      || (typeof lk1SeatReleasedOperation === "function" && lk1SeatReleasedOperation(operation)))
    && (!previous || (operation.rejoinPredecessor?.rootOperationId === identity.base
      && operation.rejoinPredecessor?.operationId === previous));
};
if (ctx.step === "lk1_http_rejoin_predecessor_find") {
  const previousId = lk1HttpRejoinPrevious(ctx.operationId);
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
    || !lk1HttpRejoinRequest(ctx) || !previousId
    || !lk1ReplayIdentityMatches(ctx, msg.payload[0], previousId)
    || !lk1HttpReleaseAllowsRejoin(msg.payload[0])) {
    return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");
  }
  const previous = msg.payload[0];
  ctx.lk1Rejoin = { operationId: previousId, rootOperationId: lk1HttpRejoinIdentity(ctx.operationId).base,
    bookingId: previous.bookingId, releaseOperationId: previous.lk1.cancelledAllowanceRelease?.proofId || previous.lk1.freeCancellationReturn?.jobKey || previous.lk1.seatRelease?.jobKey,
    releasedAt: previous.releasedAt };
  delete ctx.lk1IngressReplay;
  ctx.step = "lk1_profile_continue";
}

if (ctx.step === "lk1_ingress_operation_find") {
  // Existing operations are only read. A new explicit successor must prove
  // its predecessor below before entering ordinary fresh validation.
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) {
    return lk1Stop(ctx, "LK1_OPERATION_READ_FAILED");
  }
  const operation = msg.payload[0];
  if (!operation && msg.payload.length === 0) {
    const httpPreviousId = lk1HttpRejoinPrevious(ctx.operationId);
    if (httpPreviousId && lk1HttpRejoinRequest(ctx)) return lk1Find(ctx, "lk1_http_rejoin_predecessor_find", {
      _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, httpPreviousId])}` });
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
    if (operation.state === "RELEASED" && lk1HttpRejoinRequest(ctx)) {
      if (!lk1HttpReleaseAllowsRejoin(operation)) return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");
      const identity = lk1HttpRejoinIdentity(ctx.operationId);
      return finishError(ctx, 409, "Предыдущая запись отменена. Обновите варианты и запишитесь снова.", {
        code: "SUBSCRIPTION_BOOKING_RELEASED", operationId: ctx.operationId,
        nextOperationId: `${identity.base}:rejoin:${identity.generation + 1}` });
    }
    if (operation.state === "RELEASED" && ctx.caller === "split" && ctx.managedAction === "JOIN_GAME") {
      const nextOperationId = lk1RejoinNextId(ctx.operationId);
      if (!nextOperationId || !lk1ReleasedWithoutPayment(operation)) {
        return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");
      }
      return finishError(ctx, 409, "Предыдущая запись отменена. Для новой записи нажмите «Присоединиться снова».", {
        code: "SUBSCRIPTION_BOOKING_RELEASED", operationId: ctx.operationId, nextOperationId,
      });
    }
    // The refusal is terminal, so the stored attempt is handed back to PREPARED under its own
    // id: the failure is kept for audit, the attempt counter is incremented, and the request
    // continues as a real new attempt instead of an unresolvable pending claim.
    if (ctx.caller !== "split_create_readonly_preflight" && lk1ReclaimableAttempt(operation)) {
      const reclaimedAt = new Date().toISOString();
      const reclaimQuery = {
        // The ingress path proves the document id but never sets ctx.operationKey, so the
        // validated _id of the found document is what the compare-and-set fences on.
        _id: operation._id, operationId: ctx.operationId, actorClientId: ctx.actorClientId,
        state: operation.state, bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] },
        ...(Number.isSafeInteger(operation.attempts) ? { attempts: operation.attempts } : {}),
      };
      return prepareMongoUpdate(ctx, "lk1_ingress_reclaim", reclaimQuery, {
        $set: {
          state: "PREPARED", updatedAt: reclaimedAt, reclaimedAt,
          previousFailure: operation.failure || null, previousFailureAt: lk1ReclaimText(operation.failedAt) || null,
        },
        $unset: { failedAt: "", upstreamAttemptedAt: "", leaseUntil: "", pendingUntil: "", failure: "" },
        $inc: { attempts: 1, reclaimCount: 1 },
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

if (ctx.step === "lk1_ingress_reclaim") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    // Another request owns this attempt now: never overwrite it, and report the same
    // reconciliation stop the replay used before this generation.
    return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
  }
  // The claim is handed back: continue as a fresh attempt of the same deterministic id.
  delete ctx.lk1IngressReplay;
  ctx.step = "lk1_profile_continue";
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
  ctx.lk1Rejoin = { operationId: previousId, releaseOperationId: previous.releaseOperationId || previous.lk1?.freeCancellationReturn?.jobKey || previous.lk1?.seatRelease?.jobKey,
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
  const selectedRows = findOwnedSubscriptions({ ...exercise, availableClientSubscriptions: rows }, ctx.clientSubscriptionId);
  const patriotsMoneyOnlyIdentity = ["group_training", "tournament"].includes(resolveCategory(exercise))
    && String(ctx.lk1ProductIdentity?.productId || "").trim().toLowerCase() === "37ab3713-4431-4815-96ba-d7ece76a9241"
    && identityBound(ctx);
  // The fresh general subscription read may omit the product id. Project only the
  // server-confirmed identity; identityOwned checks owner, instance and aliases.
  const selected = patriotsMoneyOnlyIdentity ? identityOwned(ctx, selectedRows, exercise) : selectedRows;
  const configured = lk1Config(selected, exercise?.studio?.id || exercise?.studioId || null);
  if (configured.code) return lk1Stop(ctx, configured.code);
  // An event discount outside Viva's visit scope must never fall back to legacy
  // booking if the Patriots rule is missing or excluded at runtime.
  if (patriotsMoneyOnlyIdentity && (!configured.matched || configured.legacy)) {
    return lk1Stop(ctx, "LK1_PATRIOTS_RULE_UNAVAILABLE");
  }
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
    // Patriots event benefits do not consume a visit. A NEW subscription would
    // otherwise remain unactivated while receiving an unbounded 50% discount.
    // The first game can activate the 30-day Viva window; event discounts then
    // use the same ACTIVE-window proof as every other money benefit.
    const patriotsMoneyOnlyEvent = configured.rule?.productId === "37ab3713-4431-4815-96ba-d7ece76a9241"
      && ["group_training", "tournament"].includes(resolveCategory(exercise));
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
    if (firstUse && patriotsMoneyOnlyEvent) violations.push("patriots_activation_required");
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

  let used = 0;
  const coveredBookings = new Set();
  const benefitBookings = new Set();
  // Free-first-event accounting: the covered cohort counts this subscription's events on the
  // target day from the same two sources the allowance already trusts (reserved operations
  // and provider bookings), deduplicated by booking identity.
  // The verdict helper is declared here, inside the step, because the step is executed on its
  // own by the regression harnesses (they slice this block) and by the price-preview closure:
  // a helper living at the top of the node body is invisible to both. The cohort tables stay at
  // the top of the body and are read defensively, so a harness without them has no cohort.
  // The target's own direction decides coverage for a direction-scoped product.
  const lk1FreeFirstEventCovers = (productId, category, directionId) => {
    const products = typeof LK1_FREE_FIRST_EVENT_PRODUCTS === "object" && LK1_FREE_FIRST_EVENT_PRODUCTS
      ? LK1_FREE_FIRST_EVENT_PRODUCTS : null;
    const scopes = typeof LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES === "object" && LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES
      ? LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES : null;
    if (!products || !category) return false;
    if (category === "group_training" && [5502, 5503, 5504, 5505, 5506, 5507].includes(Number(directionId))) return false;
    const categories = products[normalizeId(productId)] || null;
    if (!categories || !categories.includes(category)) return false;
    const scope = scopes ? scopes[normalizeId(productId)] || null : null;
    if (!Array.isArray(scope) || scope.length === 0) return true;
    return scope.includes(Number(directionId));
  };
  const freeFirstCovered = ctx.lk1.target?.proTraining !== true && lk1FreeFirstEventCovers(ctx.lk1.rule.productId, ctx.category,
    ctx.lk1.target?.directionId);
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
          // The club game of «Дружба Топократы» carries a game of up to 90 minutes with one
          // visit, so its free minutes legitimately exceed the day's 60-minute bucket. The
          // exemption is bound to the club pack and to a club direction, and the free minutes
          // still have to equal the whole event; every other covered game keeps the reviewed
          // ceiling. `typeof` keeps an un-composed body on the reviewed behaviour.
          const clubFreeVisit = typeof isTopokratyClubPack === "function"
            && typeof isTopokratyExercise === "function"
            && isTopokratyClubPack({ productId: operation.lk1.rule?.productId })
            && isTopokratyExercise(operation.lk1.target);
          const freeCeiling = clubFreeVisit ? duration : ctx.lk1.rule.freeGameMinutesPerDay;
          if (!Number.isSafeInteger(free) || free !== duration || free > freeCeiling
            || (operation.lk1.target?.durationMinutes !== undefined && operation.lk1.target.durationMinutes !== duration)) {
            return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
          }
          coveredId = upstreamId;
        }
      }
    }
    // AUDIT_BINDING_END
    if (lk1CancelledZeroVisitOperation(operation)) continue;
    if (coveredId) benefitBookings.add(coveredId);
    if (operation.serviceDate !== ctx.serviceDate) continue;
    if (freeFirstCovered && operation.lk1?.target?.proTraining !== true
      && lk1FreeFirstEventCovers(ctx.lk1.rule.productId,
      lk1OperationCategory(operation), operation.lk1?.target?.directionId)) freeFirstEventsToday += 1;
    const minutes = operation.lk1.decision.gameMinutes;
    if (minutes) {
      if (minutes.localDate !== ctx.serviceDate || !Number.isSafeInteger(minutes.freeMinutes)
        || minutes.freeMinutes < 0) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
      used += minutes.freeMinutes;
    }
    // The club training records its free hour in its own reviewed field: the shared day bucket
    // is spent by a training exactly as it is by a game, so the accumulator reads both.
    const courtMinutes = operation.lk1.decision.courtMinutes;
    if (courtMinutes) {
      if (courtMinutes.localDate !== ctx.serviceDate
        || !Number.isSafeInteger(courtMinutes.freeMinutes) || courtMinutes.freeMinutes < 0) {
        return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
      }
      used += courtMinutes.freeMinutes;
    }
    if (coveredId) coveredBookings.add(coveredId);
  }
  for (const booking of ctx.lk1.bookings) {
    if (isInactiveBooking(booking) || eventDate(booking) !== ctx.serviceDate
      || normalizeId(bookingSubscriptionId(booking)) !== normalizeId(ctx.clientSubscriptionId)
      || coveredBookings.has(normalizeId(bookingId(booking)))) continue;
    const category = resolveCategory(booking);
    if (!category) return lk1Stop(ctx, "LK1_BOOKING_CATEGORY_UNRESOLVED");
    if (freeFirstCovered && !(category === "group_training"
      && typeof isProTrainingExercise === "function" && isProTrainingExercise(booking.exercise || booking))
      && lk1FreeFirstEventCovers(ctx.lk1.rule.productId, category,
      exerciseDirectionId(booking.exercise || booking))) freeFirstEventsToday += 1;
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
  delete ctx.lk1.cancellationSnapshot;
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

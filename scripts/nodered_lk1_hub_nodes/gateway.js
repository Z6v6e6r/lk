const LK1_OVERLAY_HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const LK1_PRODUCT_POLICY_GLOBAL = "subscriptions_lk1_product_policy";
const lk1Fields = ["maxActiveBookings", "freeGameMinutesPerDay", "gameOverageDiscountPercent",
  "groupTrainingDiscountPercent", "tournamentDiscountPercent"];
const lk1Config = (owned) => {
  const ids = [...new Set(owned.flatMap(collectExactProductIds))];
  if (!ids.includes(LK1_OVERLAY_HUB_PRODUCT_ID)) return { matched: false };
  let raw;
  try { raw = global.get(LK1_PRODUCT_POLICY_GLOBAL); } catch (_) { raw = undefined; }
  if (raw === undefined || raw === null || raw === "") return { matched: false };
  try { if (typeof raw === "string") raw = JSON.parse(raw); } catch (_) { raw = null; }
  if (!isObj(raw) || ids.length !== 1 || raw.productId !== LK1_OVERLAY_HUB_PRODUCT_ID
    || Object.keys(raw).sort().join() !== ["productId", ...lk1Fields].sort().join()
    || lk1Fields.some((key) => !Number.isSafeInteger(raw[key]) || raw[key] < 0)
    || raw.maxActiveBookings < 1 || lk1Fields.slice(2).some((key) => raw[key] > 100)) {
    return { matched: true, code: "LK1_PRODUCT_RULE_INVALID" };
  }
  const rule = { productId: raw.productId };
  for (const key of lk1Fields) rule[key] = raw[key];
  return { matched: true, rule };
};
const lk1Stop = (ctx, code) => finishPending(ctx, "Запись или доплата требуют безопасной сверки", { code });
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
const lk1Quote = (ctx, exercise, owned) => {
  const configured = lk1Config(owned);
  if (!configured.matched || configured.code) return { code: configured.code || "LK1_PRODUCT_RULE_CHANGED" };
  const dates = collectSubscriptionPurchaseDateEvidence(owned);
  if (dates.invalid || dates.dates.length !== 1) return { code: "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED" };
  if (dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM) return { legacy: true };
  if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && lk1DiscountOwned(ctx, exercise).length !== 1) {
    return { code: "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN" };
  }
  const target = {
    resolutionSource: "SERVER", eventId: toStr(exercise.id || exercise.exerciseId),
    category: managedTargetCategory(resolveCategory(exercise)),
    externalEventTypeId: managedExternalEventTypeId(exercise), productTypeId: null,
    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),
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
const lk1Checkout = (ctx) => {
  if (ctx.lk1.decision.benefit.finalPriceMinor === 0) return lk1Finish(ctx);
  if (ctx.lk1.checkout) return lk1Finish(ctx);
  if (ctx.lk1.transactionAttemptedAt) {
    if (!ctx.lk1.transactionId) return lk1Stop(ctx, "LK1_TRANSACTION_OUTCOME_UNKNOWN");
    return prepareAdminGet(ctx, "lk1_transaction_readback", `/api/v1/transactions/${encodeURIComponent(ctx.lk1.transactionId)}`);
  }
  // Reuse the split SERVICE selection and serializer via the existing finalizer.
  const token = readGlobal("vivacrm_access_token");
  if (!token) return lk1Stop(ctx, "LK1_SERVICE_TOKEN_UNAVAILABLE");
  return prepareHttp(ctx, "lk1_payment_products", "POST", `${VIVA_API_BASE}/api/v1/products/available/by-booking`, {
    bookingIds: [ctx.confirmedBookingId], clientId: ctx.actorClientId, studioId: ctx.studioId,
  }, { Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
};


// HUB_STEPS
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
  const selected = findOwnedSubscriptions({ availableClientSubscriptions: rows }, ctx.clientSubscriptionId);
  const configured = lk1Config(selected);
  if (configured.code) return lk1Stop(ctx, configured.code);
  const dates = collectSubscriptionPurchaseDateEvidence(selected);
  if (configured.matched && (dates.invalid || dates.dates.length !== 1)) {
    return lk1Stop(ctx, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  }
  delete ctx.lk1MoneyOwnership;
  if (configured.matched && dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM) {
    const subscription = selected[0];
    const instanceIds = [subscription?.clientSubscriptionId, subscription?.subscriptionId, subscription?.id]
      .filter((id) => id !== undefined);
    const owners = [subscription?.clientId, subscription?.client?.id].filter((id) => id !== undefined);
    const activation = lk1LifecycleInstant(subscription?.activationDate);
    const expiry = lk1LifecycleInstant(subscription?.expirationDate, true);
    const targetStart = finiteDate(eventStartsAt(exercise))?.getTime();
    const duration = eventDurationMinutes(exercise);
    const targetEnd = targetStart + duration * 60_000 - 1;
    const now = Date.now();
    if (selected.length !== 1 || !instanceIds.length
      || instanceIds.some((id) => normalizeId(id) !== normalizeId(ctx.clientSubscriptionId))
      || owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))
      || subscription.status !== "ACTIVE" || activation === null || expiry === null
      || !Number.isFinite(targetStart) || !duration || !Number.isFinite(targetEnd)
      || activation > now || activation > targetStart || expiry < now || expiry < targetEnd
      || subscription.holdUntil || subscription.frozenUntil || subscription.isFrozen === true) {
      return lk1Stop(ctx, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN");
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
  // A nominal service carrier is not an event price. Require one explicit
  // event-bound tariff from the existing one-times read; ambiguity stays closed.
  const rows = extractItems(msg.payload);
  if (rows.length !== 1 || !isObj(rows[0])) return lk1Stop(ctx, "LK1_EVENT_TARIFF_AMBIGUOUS");
  const product = rows[0];
  const productIds = [product.id, product.productId].filter((id) => id !== undefined);
  const eventIds = [product.exerciseId, product.exercise?.id].filter((id) => id !== undefined);
  const amounts = [product.cost, product.price, product.amount, product.trialCost].filter((amount) => amount !== undefined);
  const types = [product.productType, product.type].filter((type) => type !== undefined);
  if (!productIds.length || !productIds.every((id) => typeof id === "string" && id.trim())
    || new Set(productIds).size !== 1 || !eventIds.length || eventIds.some((id) => id !== ctx.exerciseId)
    || !types.length || types.some((type) => !["SERVICE", "ONE_TIME", "INSTANT_SUB_SERVICE", "ADVANCE_SUB_SERVICE"].includes(type))
    || !amounts.length || amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || new Set(amounts).size !== 1) return lk1Stop(ctx, "LK1_EVENT_TARIFF_UNVERIFIED");
  ctx.lk1TariffProof = { source: "VIVA_EXISTING_TARIFF", kind: "EVENT_ONE_TIME",
    productId: productIds[0], amountMinor: amounts[0], stationId: toStr(exercise.studio?.id || exercise.studioId),
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

if (ctx.step === "lk1_usage_operations") {
  if (msg.error || !Array.isArray(msg.payload)) return lk1Stop(ctx, "LK1_ALLOWANCE_READ_FAILED");
  let used = 0;
  const coveredBookings = new Set();
  for (const operation of msg.payload) {
    if (!isObj(operation) || operation.actorClientId !== ctx.actorClientId
      || operation.tenantKey !== ctx.tenantKey || operation.serviceDate !== ctx.serviceDate
      || !isObj(operation.lk1?.decision)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
    if (["FAILED", "RELEASED"].includes(operation.state)) continue;
    const minutes = operation.lk1.decision.gameMinutes;
    if (minutes) {
      if (minutes.localDate !== ctx.serviceDate || !Number.isSafeInteger(minutes.freeMinutes)
        || minutes.freeMinutes < 0) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
      used += minutes.freeMinutes;
    }
    if (operation.bookingId) coveredBookings.add(normalizeId(operation.bookingId));
  }
  for (const booking of ctx.lk1.bookings) {
    if (isInactiveBooking(booking) || eventDate(booking) !== ctx.serviceDate
      || normalizeId(bookingSubscriptionId(booking)) !== normalizeId(ctx.clientSubscriptionId)
      || coveredBookings.has(normalizeId(bookingId(booking))) || resolveCategory(booking) !== "open_game") continue;
    const minutes = eventDurationMinutes(booking.exercise || booking);
    if (!minutes) return lk1Stop(ctx, "LK1_ALLOWANCE_PROVIDER_DURATION_UNRESOLVED");
    used += Math.min(ctx.lk1.rule.freeGameMinutesPerDay, minutes);
  }
  const active = ctx.lk1.activeBookings;
  if (!Number.isSafeInteger(used)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
  const policy = {};
  for (const field of lk1Fields) policy[field] = ctx.lk1.rule[field];
  ctx.step = "lk1_policy_decision";
  msg._subscriptionBooking = ctx;
  msg._managedSubscriptionPolicyInput = { evaluatedAt: new Date().toISOString(),
    action: ctx.managedAction, lk1Policy: policy,
    lk1ProductBinding: { policyProductId: ctx.lk1.rule.productId,
      ownedProductId: ctx.lk1.rule.productId, clientSubscriptionId: ctx.clientSubscriptionId },
    target: ctx.lk1.target, usage: { activeServiceScope: "ALL_BOOKINGS",
      dailyBucketLocalDate: ctx.serviceDate, activeServices: active.length,
      usedOrReservedFreeMinutesToday: used } };
  delete ctx.lk1.bookings;
  delete ctx.lk1.activeBookings;
  return emit(OUTPUT_MANAGED_POLICY);
}

if (ctx.step === "lk1_policy_decision") {
  const decision = msg._managedSubscriptionPolicyDecision;
  if (!isObj(decision) || decision.eligible !== true || !isObj(decision.benefit)
    || !Number.isSafeInteger(decision.benefit.finalPriceMinor) || decision.benefit.finalPriceMinor < 0
    || decision.benefit.finalPriceMinor > 1_000_000
    || ![0, 1].includes(decision.subscriptionVisitCount)) return lk1Stop(ctx, "LK1_DECISION_INVALID");
  ctx.lk1.decision = JSON.parse(JSON.stringify(decision));
  ctx.subscriptionVisitCount = decision.subscriptionVisitCount;
  ctx.step = "operation_insert";
  msg._subscriptionBooking = ctx;
  const now = new Date().toISOString();
  const record = { _id: ctx.operationKey, tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    clientSubscriptionId: ctx.clientSubscriptionId, operationId: ctx.operationId,
    exerciseId: ctx.exerciseId, serviceDate: ctx.serviceDate, category: ctx.category,
    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),
    createdAt: now, updatedAt: now, leaseUntil: new Date(Date.now() + PREPARED_LEASE_MS).toISOString() };
  msg.payload = [record, { writeConcern: { w: "majority", j: true } }];
  return emit(OUTPUT_MONGO_INSERT);
}

if (ctx.step === "lk1_payment_products") {
  if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, "LK1_PAYMENT_CARRIER_UNAVAILABLE");
  msg.statusCode = 200;
  msg._subscriptionBooking = ctx;
  return emit(OUTPUT_FINAL);
}

if (ctx.step === "lk1_payment_profile_recheck") {
  const profile = unwrapRecord(msg.payload);
  const payload = msg._splitCtx?.transactionPayload;
  const product = payload?.products?.[0];
  if (!isHttpOk(msg.statusCode) || normalizeId(profile?.id || profile?.clientId) !== normalizeId(ctx.actorClientId)
    || normalizePhone(profile?.phone || profile?.phoneNumber) !== normalizePhone(ctx.actorPhone)
    || !isObj(payload) || !Array.isArray(payload.products) || payload.products.length !== 1
    || !isObj(product) || product.type !== "SERVICE" || product.count !== 1 || product.customAmount !== null
    || !Array.isArray(product.bookingIds) || product.bookingIds.length !== 1
    || product.bookingIds[0] !== ctx.confirmedBookingId
    || payload.studioId !== ctx.studioId || payload.paymentMethod !== "SMS"
    || normalizePhone(payload.clientPhone) !== normalizePhone(ctx.actorPhone)
    || typeof product.id !== "string" || product.id !== msg._splitCtx.productId
    || !Number.isSafeInteger(product.discount)
    || product.discount !== 1_000_000 - ctx.lk1.decision.benefit.finalPriceMinor) {
    return lk1Stop(ctx, "LK1_PAYMENT_INTENT_INVALID");
  }
  const configured = lk1Config([{ productId: ctx.lk1.rule.productId }]);
  if (JSON.stringify(configured.rule) !== JSON.stringify(ctx.lk1.rule)) return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");
  const attemptedAt = new Date().toISOString();
  ctx.lk1.transactionAttemptedAt = attemptedAt;
  ctx.lk1.transactionIntent = { productId: product.id, bookingId: ctx.confirmedBookingId,
    actorClientId: ctx.actorClientId, studioId: ctx.studioId,
    chargeMinor: ctx.lk1.decision.benefit.finalPriceMinor, discountMinor: product.discount };
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
  // All supplied aliases are evidence, not alternatives from which to pick a
  // convenient value. Conflicting or malformed evidence cannot prove a bill.
  const one = (values, valid) => {
    const present = values.filter((value) => value !== undefined);
    return present.length && present.every(valid) && new Set(present).size === 1
      ? present[0] : undefined;
  };
  const stringId = (value) => typeof value === "string" && value.trim().length > 0;
  const id = one([transaction?.id, transaction?.transactionId], stringId);
  const amount = one([transaction?.toPayMinor, transaction?.toPay], Number.isSafeInteger);
  const clientId = one([transaction?.clientId, transaction?.client?.id], stringId);
  const paymentUrl = one([transaction?.paymentUrl, transaction?.paymentLink], stringId);
  const products = transaction?.products;
  const productsValid = products === undefined || (Array.isArray(products) && products.length === 1
    && isObj(products[0]) && products[0].id === intent?.productId
    && products[0].type === "SERVICE" && products[0].count === 1
    && products[0].discount === intent?.discountMinor);
  const bookingEvidence = [transaction?.bookingIds];
  if (Array.isArray(products)) bookingEvidence.push(...products.map((product) => product?.bookingIds));
  const suppliedBookings = bookingEvidence.filter((value) => value !== undefined);
  const bookingsValid = suppliedBookings.length > 0 && suppliedBookings.every((ids) =>
    Array.isArray(ids) && ids.length === 1 && ids[0] === ctx.confirmedBookingId);
  let safeUrl = false;
  try { const url = new URL(paymentUrl); safeUrl = url.protocol === "https:" && !url.username && !url.password; } catch (_) { /* fail closed */ }
  if (!isHttpOk(msg.statusCode) || !isObj(transaction) || !isObj(intent)
    || id !== ctx.lk1.transactionId || clientId !== ctx.actorClientId
    || !bookingsValid || !productsValid
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

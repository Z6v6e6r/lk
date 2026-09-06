// HUB_HELPERS
const MANAGED_ENFORCEMENT_PURCHASE_FROM = "2026-09-01";

const MANAGED_ENFORCEMENT_PURCHASE_TIME_ZONE = "Europe/Moscow";

const isValidDateKey = (value) => {
  const matched = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
};

const normalizePurchaseDateMoscow = (value) => {
  const text = toStr(value);
  const localDate = normalizeDate(text);
  if (!text || !localDate || !isValidDateKey(localDate)) return null;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const localTimestamp = text.match(
      /^\d{4}-\d{2}-\d{2}(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?$/,
    );
    if (!localTimestamp) return null;
    if (localTimestamp[1] === undefined) return localDate;
    const hour = Number(localTimestamp[1]);
    const minute = Number(localTimestamp[2]);
    const second = Number(localTimestamp[3]);
    return hour <= 23 && minute <= 59 && second <= 59 ? localDate : null;
  }
  const instant = new Date(text);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MANAGED_ENFORCEMENT_PURCHASE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  const moscowDate = `${part("year")}-${part("month")}-${part("day")}`;
  return isValidDateKey(moscowDate) ? moscowDate : null;
};

const findOwnedSubscriptions = (exercise, clientSubscriptionId) => {
  const target = normalizeId(clientSubscriptionId);
  return findArrayForKey(exercise, "availableClientSubscriptions")
    .filter((item) => {
      if (!isObj(item)) return false;
      const explicitIds = [
        item.clientSubscriptionId,
        item.subscriptionId,
        item.clientSubId,
        item.clientSubscription?.id,
        item.clientSubscription?.clientSubscriptionId,
        item.clientSub?.id,
      ].map(normalizeId).filter(Boolean);
      if (explicitIds.length > 0) return explicitIds.includes(target);
      return [item.id, item.uuid].map(normalizeId).filter(Boolean).includes(target);
    });
};

const collectSubscriptionPurchaseDateEvidence = (value) => {
  const records = Array.isArray(value) ? value.filter(isObj) : isObj(value) ? [value] : [];
  const normalizedDates = records.flatMap((record) => {
    const aliases = [record.purchaseAt, record.purchaseDate]
      .filter((date) => date !== null && date !== undefined && String(date).trim());
    return aliases.length > 0
      ? aliases.map(normalizePurchaseDateMoscow)
      : [null];
  });
  return {
    dates: [...new Set(normalizedDates.filter(Boolean))].sort(),
    invalid: normalizedDates.some((date) => date === null),
  };
};

const exerciseRoomId = (exercise) => toStr(
  exercise?.room?.id || exercise?.roomId || exercise?.court?.id || exercise?.courtId,
);

const lk1MongoMatched = (value) => {
  const keys = ["acknowledged", "matchedCount", "modifiedCount", "upsertedCount", "upsertedId"];
  if (!isObj(value) || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))
    || value.acknowledged !== true || ![0, 1].includes(value.matchedCount)
    || ![0, 1].includes(value.modifiedCount) || value.modifiedCount > value.matchedCount
    || value.upsertedCount !== 0 || value.upsertedId !== null) return null;
  return value.matchedCount;
};

const lk1MongoInserted = (value, expectedId) => isObj(value)
  && Object.keys(value).length === 2 && value.acknowledged === true
  && typeof value.insertedId === "string" && value.insertedId === expectedId;

// HUB_EXERCISE
const visitOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
let ruleConfigured = false;
try { ruleConfigured = Boolean(global.get(LK1_PRODUCT_POLICY_GLOBAL)); } catch (_) { /* absent */ }
if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"
    && (visitOwned.length === 0 || lk1Config(visitOwned).matched)) {
    ctx.lk1MoneyExercise = exercise;
    ctx.lk1MoneyReturnStep = "exercise";
    return prepareUserGet(ctx, "lk1_money_owned_subscriptions",
      `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
  }
const ownedSubscriptions = lk1QuoteOwned(ctx, exercise);
if (ownedSubscriptions.length === 0) {
    return finishError(ctx, 409, "Выбранный абонемент недоступен этому пользователю для упражнения", {
      code: "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE",
    });
  }
const productRule = lk1Config(ownedSubscriptions);
if (productRule.matched) {
    ctx.managedAction = managedActionForTarget({ ...ctx, category: resolveCategory(exercise) });
    const quote = lk1Quote(ctx, exercise, ownedSubscriptions);
    if (quote.code === "LK1_EVENT_TARIFF_UNVERIFIED" && !ctx.lk1TariffProof
      && ctx.caller === "http" && ["BOOK_GROUP_TRAINING", "BOOK_TOURNAMENT"].includes(ctx.managedAction)) {
      ctx.lk1TariffExercise = exercise;
      return prepareUserGet(ctx, "lk1_event_tariff",
        `/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`);
    }
    if (quote.code === "LK1_EVENT_TARIFF_UNVERIFIED" && !ctx.lk1TariffProof
      && ["split", "split_create_readonly_preflight"].includes(ctx.caller)) {
      // Product ownership and sale cohort have been established, but no write
      // may precede the existing authenticated master-service price pipeline.
      ctx.step = "lk1_tariff_required";
      msg.statusCode = 200;
      msg.payload = { state: "LK1_TARIFF_REQUIRED", operationId: ctx.operationId };
      return emit(OUTPUT_FINAL);
    }
    if (quote.code) return lk1Stop(ctx, quote.code);
    if (!quote.legacy) {
      if (ctx.caller === "split_create_readonly_preflight") {
        // Advisory only. Durable allowance is resolved by the mutating detour.
        ctx.lk1ReadOnlyQuote = quote;
        return prepareOperationFind(ctx);
      }
      ctx.lk1 = quote;
      ctx.serviceDate = eventDate(exercise);
      ctx.category = resolveCategory(exercise);
      ctx.studioId = quote.target.stationId;
      ctx.managedAction = managedActionForTarget(ctx);
      ctx.managedEnforcement = { enabled: false };
      ctx.planKey = "friendship";
      if (!ctx.managedAction || !/^[A-Za-z0-9._:-]{8,200}$/.test(ctx.operationId || "")) {
        return lk1Stop(ctx, "LK1_REQUEST_IDENTITY_INVALID");
      }
      // Per-request identity: never overwrite a former booking's minutes or
      // transaction when another booking shares its subscription/day.
      ctx.operationKey = `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;
      return lk1Find(ctx, "lk1_operation_find", { _id: ctx.operationKey });
    }
  }

// HUB_RECHECK
if (ctx.lk1) {
    if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, "LK1_PREWRITE_READ_UNAVAILABLE");
    const exercise = unwrapRecord(msg.payload);
    if (ctx.lk1MoneyOwnership && ctx.lk1MoneyReadbackPhase !== "exercise_recheck") {
      ctx.lk1MoneyExercise = exercise;
      ctx.lk1MoneyReturnStep = "exercise_recheck";
      return prepareUserGet(ctx, "lk1_money_owned_subscriptions",
        `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
    }
    const quote = exercise && lk1Quote(ctx, exercise, lk1QuoteOwned(ctx, exercise));
    if (!quote || quote.code || quote.fingerprint !== ctx.lk1.fingerprint) {
      return lk1Stop(ctx, "LK1_RULE_PRICE_OR_TARGET_CHANGED_BEFORE_WRITE");
    }
    if (ctx.lk1TariffProof?.kind === "EVENT_ONE_TIME") {
      ctx.lk1TariffExercise = exercise;
      ctx.lk1TariffRecheck = true;
      return prepareUserGet(ctx, "lk1_event_tariff",
        `/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`);
    }
    return prepareBookingCreate(ctx);
  }

// HUB_HISTORY
if (ctx.lk1 && ctx.action !== "release") {
    if (bookings.some((booking) => !isObj(booking) || !bookingId(booking)
      || (bookingClientId(booking) && normalizeId(bookingClientId(booking)) !== normalizeId(ctx.actorClientId)))) {
      return lk1Stop(ctx, "LK1_ACTOR_BOOKINGS_UNRESOLVED");
    }
    ctx.lk1.bookings = bookings;
    ctx.lk1.activeBookings = mergeBookings(activeBookingsPayload, []).filter((booking) => !isInactiveBooking(booking));
    return lk1Find(ctx, "lk1_usage_operations", { tenantKey: ctx.tenantKey,
      actorClientId: ctx.actorClientId, serviceDate: ctx.serviceDate,
      "lk1.rule.productId": ctx.lk1.rule.productId });
  }

// HUB_CONFIRMATION
if (ctx.lk1) {
    if (!isHttpOk(msg.statusCode) || !hasCompleteBookingList(msg.payload)) return lk1Stop(ctx, "LK1_BOOKING_READBACK_UNAVAILABLE");
    const expectedBookingId = ctx.immediateBookingId || ctx.confirmedBookingId;
    if (!expectedBookingId) return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    const matches = extractItems(msg.payload).filter((booking) => isObj(booking)
      && normalizeId(bookingId(booking)) === normalizeId(expectedBookingId)
      && !isInactiveBooking(booking) && normalizeId(bookingExerciseId(booking)) === normalizeId(ctx.exerciseId)
      && normalizeId(bookingClientId(booking)) === normalizeId(ctx.actorClientId)
      && (ctx.lk1.decision.subscriptionVisitCount === 1
        ? normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId)
          && isSubscriptionBooking(booking) && (booking.count === undefined || booking.count === 1)
        : !isSubscriptionBooking(booking)));
    if (matches.length !== 1 || !bookingId(matches[0])) {
      return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    }
    return prepareConfirmedUpdate(ctx, matches[0]);
  }

// HUB_PREACCEPT
if (ctx.lk1 && ctx.lk1BeforeCreate === true) {
    ctx.lk1.createAttemptedAt = now.toISOString();
    return prepareMongoUpdate(ctx, "lk1_create_attempt_saved", {
      _id: ctx.operationKey, operationId: ctx.operationId, state: "PREPARED",
      "lk1.createAttemptedAt": { $exists: false },
    }, { $set: { state: "PENDING_CONFIRMATION", "lk1.createAttemptedAt": ctx.lk1.createAttemptedAt,
      updatedAt: now.toISOString() }, $unset: { leaseUntil: "" }, $inc: { attempts: 1 } });
  }

// HUB_BOOKING
if (ctx.lk1 && ctx.lk1.decision.subscriptionVisitCount === 0) {
    payload.paymentType = "ON_PLACE";
    delete payload.clientSubscriptionId;
  }

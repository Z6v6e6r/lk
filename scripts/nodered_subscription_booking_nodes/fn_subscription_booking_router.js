const VIVA_API_BASE = "https://api.vivacrm.ru";
const SERV2_URL = "https://padlhub.su/seliger";
const DAILY_LIMIT_CODE = "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED";
const SHARED_LIMIT_FROM = "2026-08-01";
const PREPARED_LEASE_MS = 2 * 60 * 1000;
const PENDING_CONFIRMATION_MS = 24 * 60 * 60 * 1000;

const OUTPUT_HTTP = 0;
const OUTPUT_MONGO_FIND = 1;
const OUTPUT_MONGO_INSERT = 2;
const OUTPUT_MONGO_UPDATE = 3;
const OUTPUT_FINAL = 4;
const OUTPUT_DEBUG = 5;

const emit = (index, value = msg) => {
  const outputs = [null, null, null, null, null, null];
  outputs[index] = value;
  return outputs;
};

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const normalizeDate = (value) => {
  const matched = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
};
const normalizeMarker = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[^a-z0-9а-я]+/gi, "");
const isHttpOk = (status) => Number(status) >= 200 && Number(status) < 300;

const responseHeaders = () => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
});

const finishError = (ctx, statusCode, error, details) => {
  msg._subscriptionBooking = ctx;
  msg.statusCode = statusCode;
  msg.headers = responseHeaders();
  msg.payload = { error, details: details || null };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const finishPending = (ctx, message, details) => {
  msg._subscriptionBooking = ctx;
  msg.statusCode = 202;
  msg.headers = responseHeaders();
  msg.payload = {
    ok: true,
    state: "PENDING_CONFIRMATION",
    operationId: ctx.operationId,
    exerciseId: ctx.exerciseId,
    message: message || "Запись принята и ожидает подтверждения Viva",
    details: details || null,
  };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const finishConfirmed = (ctx, bookingId, statusCode = 200) => {
  const normalizedBookingId = toStr(bookingId);
  if (!normalizedBookingId) {
    return finishPending(ctx, "Запись найдена в Viva без устойчивого bookingId и требует сверки");
  }
  msg._subscriptionBooking = ctx;
  msg.statusCode = statusCode;
  msg.headers = responseHeaders();
  msg.payload = {
    ok: true,
    state: "CONFIRMED",
    operationId: ctx.operationId,
    exerciseId: ctx.exerciseId,
    bookingId: normalizedBookingId,
    clientSubscriptionId: ctx.clientSubscriptionId,
  };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const prepareHttp = (ctx, step, method, url, payload, headers = {}) => {
  ctx.step = step;
  msg._subscriptionBooking = ctx;
  msg.method = method;
  msg.url = url;
  msg.headers = headers;
  msg.payload = payload;
  delete msg.error;
  delete msg.statusCode;
  return emit(OUTPUT_HTTP);
};

const prepareUserGet = (ctx, step, path) => prepareHttp(
  ctx,
  step,
  "GET",
  `${VIVA_API_BASE}${path}`,
  undefined,
  { Authorization: ctx.authHeader, Accept: "application/json" },
);

const unwrapRecord = (value) => {
  if (!isObj(value)) return null;
  if (toStr(value.id || value.uuid || value.exerciseId || value.clientId)) return value;
  for (const key of ["data", "payload", "result"]) {
    if (isObj(value[key])) return unwrapRecord(value[key]) || value[key];
  }
  return value;
};

const extractItems = (value, seen = new Set()) => {
  if (Array.isArray(value)) return value;
  if (!isObj(value) || seen.has(value)) return [];
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings", "data", "payload", "result"]) {
    if (Array.isArray(value[key])) return value[key];
    const nested = extractItems(value[key], seen);
    if (nested.length > 0) return nested;
  }
  return [];
};

const hasBookingListShape = (value, seen = new Set()) => {
  if (Array.isArray(value)) return true;
  if (!isObj(value) || seen.has(value)) return false;
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings"]) {
    if (Array.isArray(value[key])) return true;
  }
  return ["data", "payload", "result"].some((key) => hasBookingListShape(value[key], seen));
};

const hasCompleteBookingList = (value, seen = new Set()) => {
  if (Array.isArray(value)) return true;
  if (!isObj(value) || seen.has(value)) return false;
  seen.add(value);
  const listKey = ["content", "items", "records", "bookings"]
    .find((key) => Array.isArray(value[key]));
  if (listKey) {
    const items = value[listKey];
    const total = Number(value.totalElements ?? value.totalCount);
    const page = Number(value.number ?? value.page);
    const totalPages = Number(value.totalPages);
    if (Number.isFinite(total) && total > items.length) return false;
    if (value.last === false || value.hasNext === true) return false;
    if (Number.isFinite(page) && Number.isFinite(totalPages) && page + 1 < totalPages) return false;
    return true;
  }
  return ["data", "payload", "result"].some((key) => hasCompleteBookingList(value[key], seen));
};

const findArrayForKey = (value, targetKey, seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (isObj(value) && Array.isArray(value[targetKey])) return value[targetKey];
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findArrayForKey(nested, targetKey, seen);
    if (found.length > 0) return found;
  }
  return [];
};

const findOwnedSubscription = (exercise, clientSubscriptionId) => {
  const target = normalizeId(clientSubscriptionId);
  return findArrayForKey(exercise, "availableClientSubscriptions")
    .find((item) => {
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
    }) || null;
};

const pickName = (value) => {
  if (!isObj(value)) return null;
  for (const key of ["subscriptionName", "productName", "name", "title", "displayName"]) {
    const candidate = toStr(value[key]);
    if (candidate) return candidate;
  }
  for (const key of ["subscription", "product", "template"]) {
    const nested = pickName(value[key]);
    if (nested) return nested;
  }
  return null;
};

const PLAN_PRODUCT_IDS = {
  friendship: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
  sport: "82caad6f-4d19-4d01-852b-932bdbb0f405",
  academy: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
  ra: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
};

const collectPlanMarkers = (value, seen = new Set()) => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectPlanMarkers(item, seen));
  const markers = [
    "productId", "subscriptionProductId", "planKey", "counterKey",
    "name", "title", "productName", "subscriptionName", "subscriptionProductName",
  ].flatMap((key) => collectPlanMarkers(value[key], seen));
  for (const key of ["subscription", "product", "template"]) {
    markers.push(...collectPlanMarkers(value[key], seen));
  }
  return markers;
};

const resolvePlanKey = (value) => {
  const markers = collectPlanMarkers(value);
  for (const [planKey, productId] of Object.entries(PLAN_PRODUCT_IDS)) {
    if (markers.some((marker) => normalizeId(marker) === productId)) return planKey;
  }
  const normalized = markers.map(normalizeMarker).filter(Boolean);
  if (normalized.some((marker) => marker.includes("friendship") || marker.includes("дружба") || marker.includes("druzhba"))) return "friendship";
  if (normalized.some((marker) => marker.includes("sport") || marker.includes("спорт"))) return "sport";
  if (normalized.some((marker) => marker.includes("academy") || marker.includes("академ"))) return "academy";
  if (normalized.some((marker) => marker === "ра" || marker === "ra" || marker.includes("летопаделра") || marker.includes("padelra"))) return "ra";
  return null;
};

const PLAN_CATEGORIES = {
  friendship: ["open_game"],
  sport: ["open_game", "tournament"],
  academy: ["open_game", "group_training"],
  ra: ["open_game", "group_training", "tournament"],
};

const resolveLimitMode = (planKey, serviceDate) => {
  if (!planKey) return "event";
  return serviceDate >= SHARED_LIMIT_FROM ? "shared_day" : "category_day";
};

const buildOperationKey = (ctx) => {
  const dailyKey = `${ctx.tenantKey}:${ctx.clientSubscriptionId}:${ctx.serviceDate}`;
  if (ctx.limitMode === "shared_day") return dailyKey;
  if (ctx.limitMode === "category_day") return `${dailyKey}:${ctx.category}`;
  return `${dailyKey}:${ctx.exerciseId}`;
};

const numericId = (value) => {
  if (isObj(value)) return Number(value.id ?? value.uuid ?? value.value);
  return Number(value);
};
const markerName = (value) => (isObj(value) ? toStr(value.name || value.title || value.label) : toStr(value));

const resolveCategory = (value) => {
  const exercise = isObj(value?.exercise) ? value.exercise : value;
  if (!isObj(exercise)) return null;
  const type = exercise.type || exercise.exerciseType || exercise.serviceType || value?.exerciseType;
  const direction = exercise.direction || exercise.exerciseDirection || value?.exerciseDirection;
  const typeId = numericId(type ?? exercise.typeId ?? value?.exerciseTypeId);
  const directionId = numericId(direction ?? exercise.directionId ?? value?.exerciseDirectionId);
  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";
  if ([839, 1013].includes(typeId) || [2617, 3284, 4769].includes(directionId)) return "tournament";
  if ([605, 847, 963, 1208].includes(typeId)) return "group_training";
  const markers = [markerName(type), markerName(direction), exercise.name, exercise.title]
    .map(normalizeMarker)
    .filter(Boolean);
  if (markers.some((item) => /турнир|tournament|американо|americano|мексикано|mexicano/.test(item))) return "tournament";
  if (markers.some((item) => /трен|training|coach|групп|group|игратренер/.test(item))) return "group_training";
  if (markers.some((item) => /свояигра|открытаяигра|opengame|сплит|split|игра|game/.test(item))) return "open_game";
  return null;
};

const eventDate = (value) => {
  if (!isObj(value)) return normalizeDate(value);
  for (const key of [
    "date", "bookingDate", "exerciseDate", "serviceDate", "visitDate", "startsAt", "startAt", "timeFrom", "fromTime",
  ]) {
    const normalized = normalizeDate(value[key]);
    if (normalized) return normalized;
  }
  for (const key of ["exercise", "event", "tournament"]) {
    const nested = eventDate(value[key]);
    if (nested) return nested;
  }
  return null;
};

const bookingExercise = (value) => (isObj(value?.exercise) ? value.exercise : null);
const bookingId = (value) => toStr(value?.id || value?.bookingId || value?.uuid);
const bookingExerciseId = (value) => {
  const exercise = bookingExercise(value);
  return toStr(exercise?.id || exercise?.uuid || value?.exerciseId || value?.vivaExerciseId || value?.eventId);
};
const bookingSubscriptionId = (value) => {
  const subscription = isObj(value?.subscription)
    ? value.subscription
    : isObj(value?.clientSubscription)
      ? value.clientSubscription
      : null;
  return toStr(
    value?.clientSubscriptionId
    || value?.subscriptionId
    || value?.clientSubId
    || subscription?.clientSubscriptionId
    || subscription?.subscriptionId
    || subscription?.id
    || subscription?.uuid,
  );
};
const isSubscriptionBooking = (value) => {
  const paymentType = String(value?.paymentType || value?.paymentMethod || "").trim().toUpperCase();
  return paymentType === "SUBSCRIPTION" || Boolean(bookingSubscriptionId(value));
};
const isInactiveBooking = (value) => {
  if (!isObj(value)) return true;
  const exercise = bookingExercise(value);
  if (
    value.isCancelled === true
    || value.cancelled === true
    || value.canceled === true
    || value.archived === true
    || toStr(value.cancellationDate)
    || toStr(value.cancelledAt)
    || exercise?.isCancelled === true
    || exercise?.cancelled === true
    || exercise?.canceled === true
    || exercise?.archived === true
  ) return true;
  const statuses = [
    value.status,
    value.state,
    value.bookingStatus,
    value.cancellationReason,
    exercise?.status,
    exercise?.state,
    value.transactionStatus?.transactionStatus,
    value.transactionStatus?.cardPaymentStatus?.status,
    value.transactionStatus?.cardPaymentStatus?.originalStatus,
  ];
  return statuses.some((status) => /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|ARCHIVE|REMOV/i.test(String(status || "")));
};

const mergeBookings = (activePayload, historyPayload) => {
  const byId = new Map();
  const withoutId = [];
  [...extractItems(activePayload), ...extractItems(historyPayload)].forEach((booking) => {
    if (!isObj(booking)) return;
    const id = bookingId(booking);
    if (!id) {
      withoutId.push(booking);
      return;
    }
    const previous = byId.get(id);
    byId.set(id, previous ? { ...previous, ...booking } : booking);
  });
  return [...byId.values(), ...withoutId];
};

const eventSummary = (booking) => {
  const exercise = bookingExercise(booking) || {};
  const studio = isObj(exercise.studio) ? exercise.studio : isObj(booking.studio) ? booking.studio : {};
  const from = toStr(exercise.timeFrom || booking.timeFrom || booking.fromTime);
  const to = toStr(exercise.timeTo || booking.timeTo || booking.toTime);
  return {
    bookingId: bookingId(booking),
    exerciseId: bookingExerciseId(booking),
    title: toStr(exercise.name || exercise.title || booking.serviceName || booking.title || booking.name) || "событие",
    date: eventDate(booking),
    timeFrom: from,
    timeTo: to,
    timeLabel: [from?.match(/\d{2}:\d{2}/)?.[0], to?.match(/\d{2}:\d{2}/)?.[0]].filter(Boolean).join("–"),
    studioName: toStr(studio.name || booking.studioName || booking.stationName),
    category: resolveCategory(booking),
  };
};

const cancelledBookingRef = (booking) => ({
  bookingId: bookingId(booking),
  exerciseId: bookingExerciseId(booking),
});

const operationHasConfirmedCancellation = (operation, cancelledBookings) => {
  if (!isObj(operation)) return false;
  const operationBookingId = normalizeId(operation.bookingId || operation.upstreamBookingId);
  const operationExerciseId = normalizeId(operation.exerciseId);
  return asArray(cancelledBookings).some((booking) => {
    if (!isObj(booking)) return false;
    const cancelledBookingId = normalizeId(booking.bookingId);
    const cancelledExerciseId = normalizeId(booking.exerciseId);
    if (operationBookingId) return Boolean(cancelledBookingId === operationBookingId);
    return Boolean(operationExerciseId && cancelledExerciseId === operationExerciseId);
  });
};

const findNumber = (value, keys, seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const key of keys) {
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNumber(nested, keys, seen);
    if (found !== null) return found;
  }
  return null;
};

const mongoMatched = (value) => findNumber(value, ["matchedCount", "modifiedCount", "upsertedCount"]);
const mongoInserted = (value) => {
  if (findNumber(value, ["insertedCount"]) > 0) return true;
  if (isObj(value) && (value.insertedId || value.acknowledged === true)) return true;
  if (Array.isArray(value)) return value.some(mongoInserted);
  return false;
};

const prepareOperationFind = (ctx) => {
  ctx.step = "operation_find";
  msg._subscriptionBooking = ctx;
  msg.payload = { _id: ctx.operationKey };
  delete msg.error;
  return emit(OUTPUT_MONGO_FIND);
};

const prepareMongoUpdate = (ctx, step, query, update) => {
  ctx.step = step;
  msg._subscriptionBooking = ctx;
  msg.payload = [query, update, {}];
  delete msg.error;
  return emit(OUTPUT_MONGO_UPDATE);
};

const preparePreaccept = (ctx) => {
  const now = new Date();
  return prepareMongoUpdate(ctx, "operation_preaccept", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "PREPARED",
  }, {
    $set: {
      state: "PENDING_CONFIRMATION",
      upstreamAttemptedAt: now.toISOString(),
      pendingUntil: new Date(now.getTime() + PENDING_CONFIRMATION_MS).toISOString(),
      updatedAt: now.toISOString(),
    },
    $inc: { attempts: 1 },
    $unset: { leaseUntil: "" },
  });
};

const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {
  _id: ctx.operationKey,
  operationId: operation.operationId ?? null,
  state: operation.state,
}, {
  $set: {
    operationId: ctx.operationId,
    actorClientId: ctx.actorClientId,
    exerciseId: ctx.exerciseId,
    category: ctx.category,
    planKey: ctx.planKey || null,
    limitMode: ctx.limitMode,
    state: "PREPARED",
    attempts: 0,
    leaseUntil: new Date(now.getTime() + PREPARED_LEASE_MS).toISOString(),
    updatedAt: now.toISOString(),
  },
  $unset: {
    bookingId: "",
    confirmedAt: "",
    pendingUntil: "",
    failure: "",
    failedAt: "",
    correlationId: "",
    acceptedAt: "",
    upstreamBookingId: "",
  },
});

const prepareConfirmedUpdate = (ctx, booking) => {
  const nowIso = new Date().toISOString();
  ctx.confirmedBookingId = bookingId(booking) || ctx.immediateBookingId || null;
  ctx.confirmedSpot = Number(booking?.spot) || ctx.spot || null;
  return prepareMongoUpdate(ctx, "operation_confirm", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
  }, {
    $set: {
      state: "CONFIRMED",
      bookingId: ctx.confirmedBookingId,
      exerciseId: ctx.exerciseId,
      confirmedAt: nowIso,
      updatedAt: nowIso,
    },
    $unset: { pendingUntil: "", failure: "" },
  });
};

const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {
  const nowIso = new Date().toISOString();
  ctx.finalFailure = { statusCode, message, rawCode: rawCode || null };
  return prepareMongoUpdate(ctx, "operation_fail", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
  }, {
    $set: {
      state: "FAILED",
      failure: ctx.finalFailure,
      failedAt: nowIso,
      updatedAt: nowIso,
    },
    $unset: { pendingUntil: "" },
  });
};

const extractCorrelationId = (value) => {
  if (!isObj(value)) return null;
  return toStr(value.correlationId || value.requestId || value.operationId)
    || extractCorrelationId(value.data)
    || extractCorrelationId(value.payload);
};

const serviceTokenAvailable = () => {
  try {
    return Boolean(toStr(global.get("vivacrm_access_token")));
  } catch {
    return false;
  }
};

const prepareBookingCreate = (ctx) => {
  let serviceToken = null;
  try {
    serviceToken = toStr(global.get("vivacrm_access_token"));
  } catch {
    serviceToken = null;
  }
  if (!serviceToken) {
    return prepareFailedUpdate(ctx, 503, "Сервисный токен Viva временно недоступен", "VIVA_SERVICE_TOKEN_UNAVAILABLE");
  }
  const payload = {
    clientId: ctx.actorClientId,
    phone: ctx.actorPhone ? `+${ctx.actorPhone}` : undefined,
    paymentType: "SUBSCRIPTION",
    clientSubscriptionId: ctx.clientSubscriptionId,
    customFields: [],
  };
  if (ctx.spot) payload.spot = ctx.spot;
  const subscriptionVisitCount = Math.floor(Number(ctx.subscriptionVisitCount));
  if (ctx.caller === "split" && subscriptionVisitCount >= 1 && subscriptionVisitCount <= 2) {
    payload.count = subscriptionVisitCount;
  }
  const adminVersion = ctx.caller === "split" ? "v1" : "v2";
  return prepareHttp(
    ctx,
    "booking_create",
    "POST",
    `${VIVA_API_BASE}/api/${adminVersion}/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
    payload,
    {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  );
};

const ctx = isObj(msg._subscriptionBooking) ? msg._subscriptionBooking : null;
if (!ctx) {
  return finishError({}, 500, "Контекст серверной записи по абонементу потерян", {
    code: "SUBSCRIPTION_BOOKING_CONTEXT_MISSING",
  });
}

if (ctx.step === "profile") {
  if (!isHttpOk(msg.statusCode)) {
    const profileStatus = Number(msg.statusCode);
    const responseStatus = profileStatus >= 400 && profileStatus < 500 ? profileStatus : 502;
    return finishError(ctx, responseStatus, "Не удалось подтвердить профиль Viva", {
      code: "SUBSCRIPTION_BOOKING_PROFILE_UNAVAILABLE",
    });
  }
  const profile = unwrapRecord(msg.payload);
  ctx.actorClientId = toStr(profile?.id || profile?.clientId);
  ctx.actorPhone = normalizePhone(profile?.phone || profile?.phoneNumber || profile?.mobile);
  if (!ctx.actorClientId || !ctx.actorPhone) {
    return finishError(ctx, 502, "Профиль Viva не содержит устойчивую идентичность", {
      code: "SUBSCRIPTION_BOOKING_PROFILE_INCOMPLETE",
    });
  }
  return prepareUserGet(
    ctx,
    "exercise",
    `/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`,
  );
}

if (ctx.step === "exercise") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, Number(msg.statusCode) || 502, "Не удалось получить упражнение Viva", {
      code: "SUBSCRIPTION_BOOKING_EXERCISE_UNAVAILABLE",
    });
  }
  const exercise = unwrapRecord(msg.payload);
  const actualExerciseId = toStr(exercise?.id || exercise?.exerciseId || exercise?.uuid);
  if (!exercise || normalizeId(actualExerciseId) !== normalizeId(ctx.exerciseId)) {
    return finishError(ctx, 409, "Упражнение Viva не совпало с целью записи", {
      code: "SUBSCRIPTION_BOOKING_EXERCISE_MISMATCH",
    });
  }
  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);
  if (!ownedSubscription) {
    return finishError(ctx, 409, "Выбранный абонемент недоступен этому пользователю для упражнения", {
      code: "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE",
    });
  }
  ctx.serviceDate = eventDate(exercise);
  ctx.category = resolveCategory(exercise);
  ctx.studioId = toStr(exercise.studio?.id || exercise.studioId);
  ctx.subscriptionName = pickName(ownedSubscription);
  ctx.planKey = resolvePlanKey(ownedSubscription) || resolvePlanKey(ctx.subscriptionName);
  if (!ctx.serviceDate || !ctx.category) {
    return finishError(ctx, 502, "Не удалось определить дату или категорию упражнения Viva", {
      code: "SUBSCRIPTION_BOOKING_TARGET_UNRESOLVED",
    });
  }
  if (ctx.planKey && !PLAN_CATEGORIES[ctx.planKey].includes(ctx.category)) {
    return finishError(ctx, 409, "Этот абонемент не разрешён для выбранной категории", {
      code: "SUBSCRIPTION_CATEGORY_NOT_ALLOWED",
      category: ctx.category,
      planKey: ctx.planKey,
    });
  }

  const nameMarker = normalizeMarker(ctx.subscriptionName);
  const isKnownUntrackedPlan = nameMarker.includes("энерг") || nameMarker.includes("energy");
  if (!ctx.planKey && !isKnownUntrackedPlan) {
    const search = `?type=get_sub_name&phone=${encodeURIComponent(ctx.actorPhone)}&subId=${encodeURIComponent(ctx.clientSubscriptionId)}`;
    return prepareHttp(ctx, "subscription_name", "GET", `${SERV2_URL}${search}`, undefined, {
      Accept: "application/json",
    });
  }
  ctx.limitMode = resolveLimitMode(ctx.planKey, ctx.serviceDate);
  ctx.trackedDailyLimit = ctx.limitMode !== "event";
  return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "subscription_name") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, 502, "Не удалось подтвердить тип выбранного абонемента", {
      code: "SUBSCRIPTION_PLAN_LOOKUP_FAILED",
    });
  }
  const payload = unwrapRecord(msg.payload) || msg.payload;
  ctx.subscriptionName = toStr(payload?.sertName || payload?.subscriptionName || payload?.name);
  ctx.planKey = resolvePlanKey(ctx.subscriptionName);
  if (!ctx.subscriptionName) {
    return finishError(ctx, 502, "Источник не вернул тип выбранного абонемента", {
      code: "SUBSCRIPTION_PLAN_UNRESOLVED",
    });
  }
  if (ctx.planKey && !PLAN_CATEGORIES[ctx.planKey].includes(ctx.category)) {
    return finishError(ctx, 409, "Этот абонемент не разрешён для выбранной категории", {
      code: "SUBSCRIPTION_CATEGORY_NOT_ALLOWED",
      category: ctx.category,
      planKey: ctx.planKey,
    });
  }
  ctx.limitMode = resolveLimitMode(ctx.planKey, ctx.serviceDate);
  ctx.trackedDailyLimit = ctx.limitMode !== "event";
  return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "active_bookings") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, 502, "Не удалось загрузить активные записи для проверки лимита", {
      code: "SUBSCRIPTION_BOOKINGS_ACTIVE_UNAVAILABLE",
    });
  }
  if (!hasBookingListShape(msg.payload)) {
    return finishError(ctx, 502, "Viva вернула неизвестный формат активных записей", {
      code: "SUBSCRIPTION_BOOKINGS_ACTIVE_SCHEMA_UNRECOGNIZED",
    });
  }
  if (!hasCompleteBookingList(msg.payload)) {
    return finishError(ctx, 502, "Список активных записей Viva неполон", {
      code: "SUBSCRIPTION_BOOKINGS_ACTIVE_INCOMPLETE",
    });
  }
  ctx.activeBookingsPayload = msg.payload;
  return prepareUserGet(
    ctx,
    "history_bookings",
    `/end-user/api/v2/${ctx.tenantKey}/bookings/history?includeCanceled=true&size=1000`,
  );
}

if (ctx.step === "history_bookings") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, 502, "Не удалось загрузить историю записей для проверки лимита", {
      code: "SUBSCRIPTION_BOOKINGS_HISTORY_UNAVAILABLE",
    });
  }
  if (!hasBookingListShape(msg.payload)) {
    return finishError(ctx, 502, "Viva вернула неизвестный формат истории записей", {
      code: "SUBSCRIPTION_BOOKINGS_HISTORY_SCHEMA_UNRECOGNIZED",
    });
  }
  if (!hasCompleteBookingList(msg.payload)) {
    return finishError(ctx, 502, "История записей Viva неполна", {
      code: "SUBSCRIPTION_BOOKINGS_HISTORY_INCOMPLETE",
    });
  }
  const bookings = mergeBookings(ctx.activeBookingsPayload, msg.payload);
  delete ctx.activeBookingsPayload;
  let sameExerciseBooking = null;
  let dailyConflict = null;
  let unresolvedBooking = null;
  const cancelledSubscriptionBookings = [];
  for (const booking of bookings) {
    if (!isObj(booking) || !isSubscriptionBooking(booking)) continue;
    if (eventDate(booking) !== ctx.serviceDate) continue;
    const subscriptionId = bookingSubscriptionId(booking);
    if (!subscriptionId) {
      if (ctx.trackedDailyLimit && !isInactiveBooking(booking)) unresolvedBooking = booking;
      continue;
    }
    if (normalizeId(subscriptionId) !== normalizeId(ctx.clientSubscriptionId)) continue;
    if (isInactiveBooking(booking)) {
      cancelledSubscriptionBookings.push(cancelledBookingRef(booking));
      continue;
    }
    if (normalizeId(bookingExerciseId(booking)) === normalizeId(ctx.exerciseId)) {
      sameExerciseBooking = booking;
      continue;
    }
    if (ctx.limitMode === "event") continue;
    const category = resolveCategory(booking);
    if (!category) {
      unresolvedBooking = booking;
      continue;
    }
    const consumesSameLimit = ctx.limitMode === "shared_day"
      ? PLAN_CATEGORIES[ctx.planKey].includes(category)
      : category === ctx.category;
    if (consumesSameLimit) {
      dailyConflict = booking;
      break;
    }
  }
  if (dailyConflict) {
    const existingEvent = eventSummary(dailyConflict);
    return finishError(ctx, 409, "По этому абонементу уже есть посещение на выбранную дату", {
      code: DAILY_LIMIT_CODE,
      existingEvent,
    });
  }
  if (unresolvedBooking) {
    return finishError(ctx, 502, "Нельзя безопасно определить принадлежность существующей записи дневному лимиту", {
      code: "SUBSCRIPTION_DAILY_LIMIT_BOOKING_UNRESOLVED",
    });
  }
  if (!serviceTokenAvailable()) {
    return finishError(ctx, 503, "Сервисный токен Viva временно недоступен", {
      code: "VIVA_SERVICE_TOKEN_UNAVAILABLE",
    });
  }
  ctx.sameExerciseBooking = sameExerciseBooking;
  ctx.cancelledSubscriptionBookings = cancelledSubscriptionBookings;
  ctx.operationKey = buildOperationKey(ctx);
  return prepareOperationFind(ctx);
}

if (ctx.step === "operation_find") {
  const rows = asArray(msg.payload);
  const operation = isObj(rows[0]) ? rows[0] : null;
  if (ctx.sameExerciseBooking) {
    if (operation && toStr(operation.operationId) === ctx.operationId) {
      const stableBookingId = bookingId(ctx.sameExerciseBooking)
        || toStr(operation.bookingId || operation.upstreamBookingId);
      if (!stableBookingId) {
        return finishPending(ctx, "Активная запись Viva найдена без устойчивого bookingId и требует сверки");
      }
      ctx.immediateBookingId = stableBookingId;
      return prepareConfirmedUpdate(ctx, ctx.sameExerciseBooking);
    }
    return finishError(ctx, 409, "По этому абонементу уже есть запись на выбранное событие", {
      code: DAILY_LIMIT_CODE,
      existingEvent: eventSummary(ctx.sameExerciseBooking),
    });
  }

  const now = new Date();
  const confirmedOperationWasCancelled = operationHasConfirmedCancellation(
    operation,
    ctx.cancelledSubscriptionBookings,
  );
  if (!operation) {
    ctx.step = "operation_insert";
    msg._subscriptionBooking = ctx;
    msg.payload = {
      _id: ctx.operationKey,
      tenantKey: ctx.tenantKey,
      clientSubscriptionId: ctx.clientSubscriptionId,
      serviceDate: ctx.serviceDate,
      operationId: ctx.operationId,
      actorClientId: ctx.actorClientId,
      exerciseId: ctx.exerciseId,
      category: ctx.category,
      planKey: ctx.planKey || null,
      limitMode: ctx.limitMode,
      state: "PREPARED",
      attempts: 0,
      leaseUntil: new Date(now.getTime() + PREPARED_LEASE_MS).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    delete msg.error;
    return emit(OUTPUT_MONGO_INSERT);
  }

  if (toStr(operation.operationId) === ctx.operationId) {
    if (operation.state === "CONFIRMED") {
      if (confirmedOperationWasCancelled) return prepareOperationReclaim(ctx, operation, now);
      return finishPending(
        ctx,
        "Подтверждённая ранее запись не найдена среди активных и требует сверки с Viva",
        { code: "SUBSCRIPTION_BOOKING_CONFIRMED_RECONCILIATION_REQUIRED" },
      );
    }
    if (operation.state === "FAILED") {
      return prepareOperationReclaim(ctx, operation, now);
    }
    if (operation.state === "PENDING_CONFIRMATION") {
      return finishPending(ctx, "Предыдущая попытка ещё ожидает подтверждения Viva");
    }
    if (operation.state === "PREPARED") return preparePreaccept(ctx);
  }

  const leaseUntil = Date.parse(String(operation.leaseUntil || ""));
  if (
    operation.state === "PENDING_CONFIRMATION"
    || (operation.state === "PREPARED" && Number.isFinite(leaseUntil) && leaseUntil > now.getTime())
  ) {
    return finishPending(ctx, "Другая операция уже резервирует дневное посещение");
  }

  const reclaimable = ["FAILED", "RELEASED"].includes(String(operation.state || ""))
    || (operation.state === "CONFIRMED" && confirmedOperationWasCancelled)
    || (operation.state === "PREPARED" && (!Number.isFinite(leaseUntil) || leaseUntil <= now.getTime()));
  if (!reclaimable) {
    const details = operation.state === "CONFIRMED"
      ? { code: "SUBSCRIPTION_BOOKING_CONFIRMED_RECONCILIATION_REQUIRED" }
      : null;
    return finishPending(ctx, "Дневное посещение уже обрабатывается или требует сверки с Viva", details);
  }
  return prepareOperationReclaim(ctx, operation, now);
}

if (ctx.step === "operation_insert") {
  if (msg.error || !mongoInserted(msg.payload)) {
    return finishPending(ctx, "Другая операция одновременно заняла дневное посещение");
  }
  return preparePreaccept(ctx);
}

if (ctx.step === "operation_reclaim") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Другая операция одновременно заняла дневное посещение");
  }
  return preparePreaccept(ctx);
}

if (ctx.step === "operation_preaccept") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Не удалось подтвердить владельца атомарной операции");
  }
  return prepareBookingCreate(ctx);
}

if (ctx.step === "booking_create") {
  const statusCode = Number(msg.statusCode) || null;
  if (!isHttpOk(statusCode)) {
    const rawMessage = toStr(msg.payload?.message || msg.payload?.error || msg.error?.message);
    if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
      return prepareFailedUpdate(
        ctx,
        statusCode,
        rawMessage || "Viva отклонила создание записи",
        toStr(msg.payload?.code),
      );
    }
    return finishPending(ctx, "Результат создания записи в Viva пока неизвестен");
  }
  ctx.correlationId = extractCorrelationId(msg.payload);
  ctx.immediateBookingId = bookingId(msg.payload) || null;
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, "operation_accept", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "PENDING_CONFIRMATION",
  }, {
    $set: {
      acceptedAt: nowIso,
      correlationId: ctx.correlationId || null,
      upstreamBookingId: ctx.immediateBookingId || null,
      updatedAt: nowIso,
    },
  });
}

if (ctx.step === "operation_accept") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Viva приняла запрос; локальное подтверждение ещё выполняется");
  }
  return prepareUserGet(ctx, "confirmation_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "confirmation_bookings") {
  if (!isHttpOk(msg.statusCode)) {
    return finishPending(ctx, "Viva приняла запрос; список записей ещё недоступен");
  }
  if (!hasBookingListShape(msg.payload)) {
    return finishPending(ctx, "Viva приняла запрос; формат списка записей требует повторной проверки");
  }
  const confirmed = extractItems(msg.payload).find((booking) => (
    isObj(booking)
    && !isInactiveBooking(booking)
    && normalizeId(bookingExerciseId(booking)) === normalizeId(ctx.exerciseId)
    && normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId)
  ));
  if (!confirmed) {
    return finishPending(ctx, "Viva приняла запрос; запись ещё не появилась в активных");
  }
  if (!bookingId(confirmed) && !ctx.immediateBookingId) {
    return finishPending(ctx, "Viva показала запись без устойчивого bookingId; требуется повторная проверка");
  }
  return prepareConfirmedUpdate(ctx, confirmed);
}

if (ctx.step === "operation_confirm") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Запись появилась в Viva; локальное подтверждение ещё выполняется");
  }
  return finishConfirmed(ctx, ctx.confirmedBookingId, 201);
}

if (ctx.step === "operation_fail") {
  const failure = ctx.finalFailure || {};
  return finishError(
    ctx,
    Number(failure.statusCode) || 409,
    toStr(failure.message) || "Viva отклонила создание записи",
    { code: toStr(failure.rawCode) || "VIVA_SUBSCRIPTION_BOOKING_REJECTED" },
  );
}

return finishError(ctx, 500, "Неизвестный этап серверной записи по абонементу", {
  code: "SUBSCRIPTION_BOOKING_STEP_UNSUPPORTED",
  step: ctx.step || null,
});

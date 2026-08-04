const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const SPLIT_DIRECTION_ID = 4588;
const SPLIT_EXERCISE_TYPE_ID = 1613;
const DEFAULT_ONE_TIME_PRODUCT_AMOUNT = 10000;
const SUBSCRIPTION_DAILY_LIMIT_CODE = "SUBSCRIPTION_DAILY_LIMIT_REACHED";

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const pickId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.id) || toStr(value.uuid);
};

const pickTransactionId = (value) => {
  if (!value || typeof value !== "object") return null;
  return (
    toStr(value.transactionId)
    || toStr(value.transactionUuid)
    || pickId(value)
    || pickId(value.transaction)
    || toStr(value.transaction?.transactionId)
    || toStr(value.transaction?.transactionUuid)
  );
};

const resolvePaymentMode = (value) => {
  const raw = toStr(value);
  if (!raw) return "one_time";
  const normalized = raw.toLowerCase().replace(/[^a-z0-9а-яё]+/g, "_");
  if (
    normalized.includes("subscription")
    || normalized.includes("abon")
    || normalized.includes("абон")
    || normalized.includes("visit")
    || normalized.includes("посещ")
  ) {
    return "subscription";
  }
  return "one_time";
};

const normalizePaymentMethod = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  if (["CARD", "CASH", "DEPOSIT", "WIDGET", "SUBSCRIPTION", "SMS"].includes(raw)) return raw;
  return null;
};

const resolveTransactionPaymentMethod = (ctx) => {
  const explicit = normalizePaymentMethod(ctx?.paymentMethod || ctx?.transactionPaymentMethod);
  if (explicit) return explicit;
  const selectedMode = resolvePaymentMode(ctx?.selectedPaymentMode || ctx?.paymentMode);
  if (selectedMode === "subscription") return "SUBSCRIPTION";
  return "SMS";
};

const resolveBookingPaymentType = (ctx) => {
  const explicit = String(ctx?.bookingPaymentType || "").trim().toUpperCase();
  if (explicit === "SUBSCRIPTION" || explicit === "ON_PLACE") return explicit;
  return resolvePaymentMode(ctx?.selectedPaymentMode || ctx?.paymentMode) === "subscription"
    ? "SUBSCRIPTION"
    : "ON_PLACE";
};

const resolveSubscriptionVisitCount = (ctx) => {
  const explicitCount = Math.floor(toNumber(ctx?.subscriptionVisitCount) ?? 0);
  if (explicitCount > 0) return explicitCount;
  const durationMinutes = Math.max(0, Math.floor(toNumber(ctx?.durationMinutes) ?? 0));
  return durationMinutes >= 90 ? 2 : 1;
};

const findSubscriptionDailyLimitPayload = (value, seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (toStr(value.code) === SUBSCRIPTION_DAILY_LIMIT_CODE) return value;
  const details = findSubscriptionDailyLimitPayload(value.details, seen);
  if (details) return details;
  const raw = findSubscriptionDailyLimitPayload(value.raw, seen);
  if (raw) return raw;
  return null;
};

const isSubscriptionDailyLimitPayload = (value) => {
  if (findSubscriptionDailyLimitPayload(value)) return true;
  const text = JSON.stringify(value || "");
  return (
    text.includes(SUBSCRIPTION_DAILY_LIMIT_CODE)
    || /1\s*раз\s*в\s*день/i.test(text)
    || /daily.+subscription.+limit/i.test(text)
  );
};

const formatSubscriptionDailyLimitMessage = (existingEvent) => {
  const event = existingEvent && typeof existingEvent === "object" ? existingEvent : {};
  const title = toStr(event.title) || "событие";
  const station = toStr(event.studioName || event.stationName);
  const time = toStr(event.timeLabel) || [
    toStr(event.timeFrom),
    toStr(event.timeTo),
  ].filter(Boolean).join("-");
  const locationPart = station ? ` на станции ${station}` : "";
  const timePart = time ? ` в ${time}` : "";
  return `Вы уже записаны на ${title}${locationPart}${timePart}. Подписка позволяет создавать или присоединяться к событию 1 раз в день. Создайте игру или присоединитесь к тренировке на завтра.`;
};

const buildSubscriptionDailyLimitFailure = (value) => {
  const payload = findSubscriptionDailyLimitPayload(value) || {};
  const existingEvent = payload.existingEvent && typeof payload.existingEvent === "object"
    ? payload.existingEvent
    : null;
  const message = toStr(payload.message) || formatSubscriptionDailyLimitMessage(existingEvent);
  return {
    message,
    details: {
      code: SUBSCRIPTION_DAILY_LIMIT_CODE,
      message,
      existingEvent,
    },
  };
};

const extractConflictExerciseId = (value, ctx) => {
  const conflicts = Array.isArray(value?.conflicts) ? value.conflicts : [];
  const targetStart = `${ctx.date}T${ctx.fromTime}:00+03:00`;
  const targetEnd = `${ctx.date}T${ctx.toTime}:00+03:00`;

  const matchingConflict = conflicts.find((item) => {
    if (!item || typeof item !== "object") return false;
    const exerciseId = toStr(item.conflictingExerciseId) || toStr(item.exerciseId);
    if (!exerciseId) return false;
    const roomId = toStr(item.room?.id || item.roomId);
    const startsAt = toStr(item.timeFrom);
    const endsAt = toStr(item.timeTo);
    return roomId === ctx.roomId && startsAt === targetStart && endsAt === targetEnd;
  });

  return matchingConflict
    ? toStr(matchingConflict.conflictingExerciseId) || toStr(matchingConflict.exerciseId)
    : null;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const adminRequest = (ctx, method, path, payload) => {
  msg._splitCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, msg];
};

const startSubscriptionBookingGateway = (ctx) => {
  const requestHeaders = msg.req && msg.req.headers && typeof msg.req.headers === "object"
    ? msg.req.headers
    : {};
  const authHeader = toStr(requestHeaders.authorization || requestHeaders.Authorization);
  const operationId = toStr(
    requestHeaders["idempotency-key"]
    || requestHeaders["Idempotency-Key"]
    || msg.req?.query?.operationId,
  );
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
    return fail(401, "Требуется авторизация Viva", {
      code: "SUBSCRIPTION_BOOKING_AUTH_REQUIRED",
    });
  }
  if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {
    return fail(400, "Требуется корректный operationId", {
      code: "SUBSCRIPTION_BOOKING_OPERATION_ID_REQUIRED",
    });
  }

  msg._splitCtx = ctx;
  msg._subscriptionBooking = {
    caller: "split",
    step: "profile",
    tenantKey: "iSkq6G",
    operationId,
    authHeader,
    exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    spot: ctx.spot || null,
    subscriptionVisitCount: resolveSubscriptionVisitCount(ctx),
    startedAt: new Date().toISOString(),
  };
  msg.method = "GET";
  msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
  msg.headers = {
    Authorization: authHeader,
    Accept: "application/json",
  };
  msg.payload = undefined;
  return [null, null, null, msg];
};

const extractList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return value.content;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
};

const isLikelyPaymentUrl = (value) => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  return /(pay|tbank|tinkoff|payment|checkout|bank|acquir)|([?&](payment|transaction|order|invoice)=)/i.test(text);
};

const extractPaymentUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return null;
    return isLikelyPaymentUrl(text) ? text : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractPaymentUrl(item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  for (const key of ["paymentUrl", "redirectUrl", "paymentLink", "checkoutUrl", "cardPaymentUrl", "paymentPageUrl"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["url", "link"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["data", "payload", "result", "transaction", "transactionStatus", "cardPaymentStatus", "payment", "paymentInfo", "cardPaymentInfo"]) {
    const found = extractPaymentUrl(value[key]);
    if (found) return found;
  }
  return null;
};

const resolveProductType = (value) => {
  const raw = String(value?.productType || value?.type || "").toUpperCase();
  if (
    raw === "SERVICE"
    || raw === "ADVANCE_SUB_SERVICE"
    || raw === "BOOKING_PAYMENT"
    || raw === "FULL_PAYMENT_SERVICE"
    || raw === "SUBSCRIPTION"
  ) {
    return raw;
  }
  return "SERVICE";
};

const normalizeProduct = (value) => {
  if (!value || typeof value !== "object") return null;
  const id = pickId(value);
  if (!id) return null;
  const type = resolveProductType(value);
  const costMinor = Math.max(0, Math.round(toNumber(value.cost) ?? 0));
  const name = toStr(value.name || value.title || value.displayName) || "Продукт Viva";
  const status = String(value.status || value.state || "").trim().toUpperCase();
  return {
    id,
    type,
    name,
    costMinor,
    status,
    raw: value,
  };
};

const isSubscriptionProduct = (product) => {
  if (!product || typeof product !== "object") return false;
  if (product.type === "ADVANCE_SUB_SERVICE" || product.type === "SUBSCRIPTION") return true;
  const nameLower = String(product.name || "").toLowerCase();
  if (
    nameLower.includes("абон")
    || nameLower.includes("subscription")
    || nameLower.includes("сертификат")
    || nameLower.includes("визит")
    || nameLower.includes("лето")
    || nameLower.includes("дружб")
  ) {
    return true;
  }
  return false;
};

const isOneTimeProduct = (product) => {
  if (!product || typeof product !== "object") return false;
  if (product.type === "BOOKING_PAYMENT" || product.type === "FULL_PAYMENT_SERVICE") return true;
  if (product.type === "SERVICE") return true;
  const nameLower = String(product.name || "").toLowerCase();
  if (
    nameLower.includes("разов")
    || nameLower.includes("one-time")
    || nameLower.includes("one_time")
    || nameLower.includes("корт")
  ) {
    return true;
  }
  return false;
};

const normalizeComparableId = (value) => {
  const text = toStr(value);
  return text ? text.toLowerCase() : null;
};

const collectComparableIds = (value, seen = new Set()) => {
  const ids = new Set();
  if (value === null || value === undefined || seen.has(value)) return ids;

  if (typeof value === "string" || typeof value === "number") {
    const normalized = normalizeComparableId(value);
    if (normalized) ids.add(normalized);
    return ids;
  }
  if (typeof value !== "object") return ids;

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectComparableIds(item, seen).forEach((id) => ids.add(id));
    });
    return ids;
  }

  const idKeys = [
    "id",
    "uuid",
    "productId",
    "subscriptionId",
    "clientSubscriptionId",
    "clientSubId",
  ];
  idKeys.forEach((key) => {
    const normalized = normalizeComparableId(value[key]);
    if (normalized) ids.add(normalized);
  });

  Object.values(value).forEach((nested) => {
    if (nested && typeof nested === "object") {
      collectComparableIds(nested, seen).forEach((id) => ids.add(id));
    }
  });
  return ids;
};

const productMatchesSubscriptionId = (product, preferredSubscriptionId) => {
  const normalizedPreferred = normalizeComparableId(preferredSubscriptionId);
  if (!normalizedPreferred || !product) return false;

  if (normalizeComparableId(product.id) === normalizedPreferred) return true;
  const rawIds = collectComparableIds(product.raw);
  return rawIds.has(normalizedPreferred);
};

const pickBestOneTimeProduct = (products, targetCostMinor) => {
  const candidates = products.filter((item) => isOneTimeProduct(item));
  if (candidates.length === 0) return null;
  const sorted = candidates.slice().sort((left, right) => {
    const leftDistance = Math.abs((left.costMinor || 0) - targetCostMinor);
    const rightDistance = Math.abs((right.costMinor || 0) - targetCostMinor);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    if (left.type !== right.type) {
      if (left.type === "BOOKING_PAYMENT") return -1;
      if (right.type === "BOOKING_PAYMENT") return 1;
    }
    return (right.costMinor || 0) - (left.costMinor || 0);
  });
  return sorted[0] || null;
};

const pickBestSubscriptionProduct = (products, preferredSubscriptionId) => {
  const candidates = products.filter((item) => {
    if (!isSubscriptionProduct(item)) return false;
    if (
      item.status.includes("EXPIRED")
      || item.status.includes("CANCEL")
      || item.status.includes("BLOCK")
      || item.status.includes("ARCHIVE")
    ) {
      return false;
    }
    return true;
  });
  if (candidates.length === 0) return null;

  const explicitlySelected = candidates.find((item) => productMatchesSubscriptionId(item, preferredSubscriptionId));
  if (explicitlySelected) return explicitlySelected;

  const sorted = candidates.slice().sort((left, right) => {
    const leftPreferred = /лето|падел|дружб/i.test(left.name || "") ? 1 : 0;
    const rightPreferred = /лето|падел|дружб/i.test(right.name || "") ? 1 : 0;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    return (right.costMinor || 0) - (left.costMinor || 0);
  });
  return sorted[0] || null;
};

const buildBookingRequest = (ctx) => {
  const bookingPaymentType = resolveBookingPaymentType(ctx);
  const clientSubscriptionId = toStr(ctx.clientSubscriptionId || ctx.subscriptionId);
  const requestedSubscriptionId = toStr(ctx.subscriptionId);
  const subscriptionVisitCount = resolveSubscriptionVisitCount(ctx);
  const payload = {
    phone: ctx.clientPhone,
    paymentType: bookingPaymentType,
    familyMemberId: "",
  };
  if (bookingPaymentType === "SUBSCRIPTION" && clientSubscriptionId) {
    payload.clientSubscriptionId = clientSubscriptionId;
    if (requestedSubscriptionId && requestedSubscriptionId !== clientSubscriptionId) {
      payload.subscriptionId = requestedSubscriptionId;
    }
    payload.count = subscriptionVisitCount;
    ctx.clientSubscriptionId = clientSubscriptionId;
  }
  if (ctx.spot) payload.spot = ctx.spot;

  ctx.bookingPaymentType = bookingPaymentType;
  ctx.subscriptionVisitCount = subscriptionVisitCount;
  ctx.selectedPaymentMode = resolvePaymentMode(ctx.paymentMode);
  if (
    bookingPaymentType === "SUBSCRIPTION"
    && clientSubscriptionId
    && ctx.subscriptionGuardDone !== true
  ) {
    return startSubscriptionBookingGateway(ctx);
  }
  ctx.step = "create_booking";
  return adminRequest(
    ctx,
    "POST",
    `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
    payload,
  );
};

const pickTransactionToPayMinor = (primaryPayload, fallbackPayload, fallbackMinor) => {
  const values = [
    toNumber(primaryPayload?.toPay),
    toNumber(fallbackPayload?.toPay),
    toNumber(fallbackMinor),
  ];
  const firstFinite = values.find((value) => Number.isFinite(value));
  return Math.max(0, Math.round(firstFinite ?? 0));
};

const pickTransactionDeadlineAt = (ctx, primaryPayload, fallbackPayload) => {
  const candidates = [
    toStr(primaryPayload?.paymentDueDate),
    toStr(primaryPayload?.paymentDeadline),
    toStr(primaryPayload?.paymentDeadlineAt),
    toStr(primaryPayload?.expiresAt),
    toStr(fallbackPayload?.paymentDueDate),
    toStr(fallbackPayload?.paymentDeadline),
    toStr(fallbackPayload?.paymentDeadlineAt),
    toStr(fallbackPayload?.expiresAt),
    toStr(ctx.deadlineAt),
  ];
  return candidates.find((item) => Boolean(item)) || null;
};

const buildSplitPaymentResponse = (ctx, primaryPayload, fallbackPayload) => {
  const transactionId =
    pickTransactionId(primaryPayload)
    || pickTransactionId(fallbackPayload)
    || toStr(ctx.transactionId)
    || null;
  const paymentUrl = extractPaymentUrl(primaryPayload) || extractPaymentUrl(fallbackPayload);
  const toPayMinor = pickTransactionToPayMinor(primaryPayload, fallbackPayload, ctx.shareAmountMinor);
  const deadlineAt = pickTransactionDeadlineAt(ctx, primaryPayload, fallbackPayload);

  return {
    ok: true,
    mode: ctx.action,
    paymentRef: ctx.paymentRef,
    exerciseId: ctx.exerciseId,
    bookingId: ctx.bookingId,
    productId: ctx.productId,
    transactionId,
    paymentUrl,
    toPayMinor,
    toPay: toPayMinor / 100,
    shareAmount: ctx.shareAmount,
    shareAmountMinor: ctx.shareAmountMinor,
    baseShareAmount: ctx.baseShareAmount,
    baseShareAmountMinor: ctx.baseShareAmountMinor,
    discountAmount: ctx.discountAmount,
    discountAmountMinor: ctx.discountAmountMinor,
    directionId: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
    exerciseTypeId: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
    totalAmount: toNumber(ctx.totalAmount),
    oneTimeBaseAmount: toNumber(ctx.oneTimeBaseAmount),
    selectedPaymentMode: ctx.selectedPaymentMode || resolvePaymentMode(ctx.paymentMode),
    paymentModes: Array.isArray(ctx.availablePaymentModes) ? ctx.availablePaymentModes : [],
    subscriptionVisitCount: resolveSubscriptionVisitCount(ctx),
    subscriptionProductId: ctx.subscriptionProductId || null,
    subscriptionProductName: ctx.subscriptionProductName || null,
    oneTimeProductId: ctx.oneTimeProductId || null,
    oneTimeProductName: ctx.oneTimeProductName || null,
    deadlineAt,
    assembleDeadlineAt: ctx.assembleDeadlineAt || null,
    spot: ctx.spot ?? null,
    reusedConflictingExercise: Boolean(ctx.reusedConflictingExercise),
  };
};

const ctx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : null;
if (!ctx) {
  return fail(500, "Split payment context is missing");
}

if (ctx.step === "token") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(500, "Viva token error", msg.payload || null);
  }
  ctx.token = msg.payload.access_token;

  if (ctx.action === "create") {
    ctx.step = "create_exercise";
    return adminRequest(ctx, "POST", "/exercises", {
      direction: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
      type: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
      timeFrom: `${ctx.date}T${ctx.fromTime}+03:00`,
      timeTo: `${ctx.date}T${ctx.toTime}+03:00`,
      maxClientsCount: ctx.maxClientsCount,
      roomId: ctx.roomId,
      clientId: ctx.clientId || undefined,
      requirements: [],
    });
  }

  return buildBookingRequest(ctx);
}

if (!isOk(msg.statusCode)) {
  if (
    ctx.step === "create_booking"
    && resolveBookingPaymentType(ctx) === "SUBSCRIPTION"
    && isSubscriptionDailyLimitPayload(msg.payload)
  ) {
    const dailyLimitFailure = buildSubscriptionDailyLimitFailure(msg.payload);
    return fail(409, dailyLimitFailure.message, dailyLimitFailure.details);
  }
  if (ctx.step === "transaction") {
    const errorMessage = String(
      msg.payload?.message
      || msg.payload?.error
      || msg.payload?.details?.message
      || "",
    ).toLowerCase();
    if (errorMessage.includes("payment method") && errorMessage.includes("not implemented")) {
      const currentMethod = ctx.transactionPayload?.paymentMethod;
      const fallbackMap = {
        SMS: "WIDGET",
        SUBSCRIPTION: "CARD",
        WIDGET: "CARD",
        CARD: "CASH",
      };
      const fallbackMethod = fallbackMap[currentMethod] || null;
      if (fallbackMethod && fallbackMethod !== currentMethod) {
        const retryPayload = Object.assign({}, ctx.transactionPayload, { paymentMethod: fallbackMethod });
        ctx.transactionPayload = retryPayload;
        return adminRequest(ctx, "POST", "/transactions", retryPayload);
      }
    }
  }
  if (ctx.step === "create_exercise" && Number(msg.statusCode) === 409) {
    const conflictExerciseId = extractConflictExerciseId(msg.payload, ctx);
    if (conflictExerciseId) {
      ctx.exercise = msg.payload;
      ctx.exerciseId = conflictExerciseId;
      ctx.reusedConflictingExercise = true;
      return buildBookingRequest(ctx);
    }
  }
  return fail(msg.statusCode || 502, "Viva request failed", msg.payload || null);
}

if (ctx.step === "create_exercise") {
  const exerciseId = pickId(msg.payload);
  if (!exerciseId) {
    return fail(502, "Viva exercise response has no id", msg.payload || null);
  }

  ctx.exercise = msg.payload;
  ctx.exerciseId = exerciseId;
  if (!ctx.studioId && msg.payload?.studio?.id) {
    ctx.studioId = msg.payload.studio.id;
  }
  return buildBookingRequest(ctx);
}

if (ctx.step === "create_booking") {
  const bookingId = pickId(msg.payload);
  if (!bookingId) {
    return fail(502, "Viva booking response has no id", msg.payload || null);
  }

  ctx.booking = msg.payload;
  ctx.bookingId = bookingId;
  ctx.clientId = ctx.clientId || toStr(msg.payload?.client?.id);
  ctx.clientPhone = ctx.clientPhone || toStr(msg.payload?.client?.phone);
  ctx.studioId = ctx.studioId || toStr(msg.payload?.studio?.id);
  ctx.spot = toNumber(msg.payload?.spot) ?? ctx.spot ?? null;

  if (!ctx.clientId || !ctx.studioId) {
    return fail(502, "Viva booking response has no clientId or studioId", msg.payload || null);
  }

  if (resolvePaymentMode(ctx.selectedPaymentMode || ctx.paymentMode) === "subscription") {
    const requestedClientSubscriptionId = toStr(ctx.clientSubscriptionId || ctx.subscriptionId);
    const actualClientSubscriptionId = toStr(
      msg.payload?.clientSubscriptionId
      || msg.payload?.subscriptionId
      || msg.payload?.clientSubId
      || msg.payload?.subscription?.id,
    );
    if (
      requestedClientSubscriptionId
      && actualClientSubscriptionId
      && normalizeComparableId(requestedClientSubscriptionId) !== normalizeComparableId(actualClientSubscriptionId)
    ) {
      return fail(409, "Viva списала другой абонемент", {
        requestedClientSubscriptionId,
        actualClientSubscriptionId,
        bookingId: ctx.bookingId,
      });
    }

    const shareCount = Math.max(1, Math.round(toNumber(ctx.shareCount) ?? 4));
    const oneTimeBaseAmount = Math.max(
      0,
      toNumber(ctx.oneTimeBaseAmount) ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT,
    );
    const baseShareAmount = oneTimeBaseAmount / shareCount;
    const shareAmount = Math.max(0, toNumber(ctx.shareAmount) ?? 0);
    const subscriptionVisitCount = resolveSubscriptionVisitCount(ctx);

    ctx.selectedPaymentMode = "subscription";
    ctx.subscriptionVisitCount = subscriptionVisitCount;
    ctx.shareAmount = shareAmount;
    ctx.shareAmountMinor = Math.max(0, Math.round(shareAmount * 100));
    ctx.baseShareAmount = baseShareAmount;
    ctx.baseShareAmountMinor = Math.max(0, Math.round(baseShareAmount * 100));
    ctx.discountAmount = 0;
    ctx.discountAmountMinor = 0;

    msg.statusCode = 201;
    msg.headers = { "Content-Type": "application/json; charset=utf-8" };
    msg.payload = {
      ok: true,
      mode: ctx.action,
      paymentRef: ctx.paymentRef,
      exerciseId: ctx.exerciseId,
      bookingId: ctx.bookingId,
      productId: null,
      transactionId: null,
      paymentUrl: null,
      toPayMinor: 0,
      toPay: 0,
      shareAmount: ctx.shareAmount,
      shareAmountMinor: ctx.shareAmountMinor,
      baseShareAmount: ctx.baseShareAmount,
      baseShareAmountMinor: ctx.baseShareAmountMinor,
      discountAmount: ctx.discountAmount,
      discountAmountMinor: ctx.discountAmountMinor,
      directionId: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
      exerciseTypeId: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
      totalAmount: toNumber(ctx.totalAmount),
      oneTimeBaseAmount: toNumber(ctx.oneTimeBaseAmount),
      selectedPaymentMode: "subscription",
      paymentModes: [
        {
          id: "subscription",
          label: subscriptionVisitCount > 1
            ? `Списать ${subscriptionVisitCount} посещения с абонемента`
            : "Списать посещение с абонемента",
          productId: actualClientSubscriptionId || requestedClientSubscriptionId || null,
          productName: null,
          type: "SUBSCRIPTION",
        },
      ],
      subscriptionVisitCount,
      subscriptionProductId: actualClientSubscriptionId || requestedClientSubscriptionId || null,
      subscriptionProductName: null,
      oneTimeProductId: null,
      oneTimeProductName: null,
      deadlineAt: ctx.deadlineAt,
      assembleDeadlineAt: ctx.assembleDeadlineAt || null,
      spot: ctx.spot ?? null,
      reusedConflictingExercise: Boolean(ctx.reusedConflictingExercise),
    };
    return [null, msg, msg];
  }

  ctx.step = "available_products";
  return adminRequest(ctx, "POST", "/products/available/by-booking", {
    bookingIds: [bookingId],
    clientId: ctx.clientId,
    studioId: ctx.studioId,
  });
}

if (ctx.step === "available_products") {
  const products = extractList(msg.payload)
    .map((item) => normalizeProduct(item))
    .filter((item) => Boolean(item));
  if (products.length === 0) {
    return fail(502, "No Viva booking payment product is available", msg.payload || null);
  }

  const shareAmountMinor = Math.max(0, Math.round(Number(ctx.shareAmount || 0) * 100));
  const oneTimeBaseMinor = Math.max(
    0,
    Math.round((toNumber(ctx.oneTimeBaseAmount) ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT) * 100),
  );
  const oneTimeProduct = pickBestOneTimeProduct(products, oneTimeBaseMinor);
  const requestedClientSubscriptionId = toStr(ctx.clientSubscriptionId || ctx.subscriptionId);
  const subscriptionProduct = pickBestSubscriptionProduct(products, requestedClientSubscriptionId);

  const availableModes = [];
  if (subscriptionProduct) {
    availableModes.push({
      id: "subscription",
      label: "Списать посещение с абонемента",
      productId: subscriptionProduct.id,
      productName: subscriptionProduct.name,
      type: subscriptionProduct.type,
    });
  }
  if (oneTimeProduct) {
    availableModes.push({
      id: "one_time",
      label: "Оплатить 1/4 стоимости",
      productId: oneTimeProduct.id,
      productName: oneTimeProduct.name,
      type: oneTimeProduct.type,
      baseAmountMinor: oneTimeProduct.costMinor || oneTimeBaseMinor,
    });
  }

  if (availableModes.length === 0) {
    return fail(502, "No available payment mode for split booking", msg.payload || null);
  }

  const requestedMode = resolvePaymentMode(ctx.paymentMode);
  const requestedSubscriptionMatched = requestedClientSubscriptionId
    ? productMatchesSubscriptionId(subscriptionProduct, requestedClientSubscriptionId)
    : false;
  let selectedMode = requestedMode;
  if (selectedMode === "subscription" && !subscriptionProduct) {
    selectedMode = "one_time";
  }
  if (selectedMode === "one_time" && !oneTimeProduct && subscriptionProduct) {
    selectedMode = "subscription";
  }

  if (
    selectedMode === "subscription"
    && requestedClientSubscriptionId
    && !requestedSubscriptionMatched
  ) {
    return fail(409, "Выбранный абонемент недоступен для списания", {
      requestedClientSubscriptionId,
      availableSubscriptionProducts: products
        .filter((item) => isSubscriptionProduct(item))
        .map((item) => ({ id: item.id, name: item.name })),
    });
  }

  const selectedProduct = selectedMode === "subscription"
    ? subscriptionProduct
    : oneTimeProduct || subscriptionProduct;
  if (!selectedProduct) {
    return fail(502, "Failed to resolve payment product", {
      requestedMode,
      availableModes,
    });
  }

  const selectedProductType = resolveProductType(selectedProduct.raw);
  const subscriptionVisitCount = resolveSubscriptionVisitCount(ctx);
  const selectedProductCostMinor = Math.max(
    0,
    Math.round(toNumber(selectedProduct.raw?.cost) ?? selectedProduct.costMinor ?? 0),
  );
  const baseShareAmountMinor = Math.max(
    oneTimeProduct?.costMinor || 0,
    oneTimeBaseMinor,
    selectedMode === "one_time" ? selectedProductCostMinor : 0,
  );
  const discountAmountMinor = selectedMode === "one_time"
    ? Math.max(selectedProductCostMinor - shareAmountMinor, 0)
    : 0;

  ctx.product = selectedProduct.raw;
  ctx.productId = selectedProduct.id;
  ctx.productType = selectedProductType;
  ctx.selectedPaymentMode = selectedMode;
  ctx.availablePaymentModes = availableModes;
  ctx.subscriptionProductId = selectedMode === "subscription"
    ? selectedProduct.id
    : (subscriptionProduct?.id || null);
  ctx.subscriptionProductName = selectedMode === "subscription"
    ? selectedProduct.name
    : (subscriptionProduct?.name || null);
  ctx.oneTimeProductId = oneTimeProduct?.id || null;
  ctx.oneTimeProductName = oneTimeProduct?.name || null;
  ctx.baseShareAmountMinor = baseShareAmountMinor;
  ctx.baseShareAmount = baseShareAmountMinor / 100;
  ctx.shareAmountMinor = shareAmountMinor;
  ctx.discountAmountMinor = discountAmountMinor;
  ctx.discountAmount = discountAmountMinor / 100;
  ctx.step = "transaction";

  const transactionPayload = {
    clientPhone: ctx.clientPhone.startsWith("+") ? ctx.clientPhone : `+${ctx.clientPhone}`,
    paymentMethod: resolveTransactionPaymentMethod(ctx),
    products: [
      {
        id: selectedProduct.id,
        count: selectedMode === "subscription" ? subscriptionVisitCount : 1,
        customAmount: null,
        type: selectedProductType,
        discount: discountAmountMinor,
        bookingIds: [ctx.bookingId],
      },
    ],
    studioId: ctx.studioId,
    discountReason: selectedMode === "subscription"
      ? `Открытая игра 4/4: списание ${subscriptionVisitCount} посещения(ий) абонемента`
      : "Открытая игра 4/4: 1/4 стоимости корта",
    offlineTillId: null,
    deposit: 0,
  };

  if (ctx.successUrl) {
    transactionPayload.successUrl = ctx.successUrl;
    transactionPayload.baseRedirectUrl = ctx.successUrl;
    transactionPayload.redirectUrl = ctx.successUrl;
    transactionPayload.returnUrl = ctx.successUrl;
    transactionPayload.successRedirectUrl = ctx.successUrl;
  }
  if (ctx.failUrl) {
    transactionPayload.failUrl = ctx.failUrl;
    transactionPayload.failRedirectUrl = ctx.failUrl;
    transactionPayload.failureRedirectUrl = ctx.failUrl;
  }

  ctx.transactionPayload = transactionPayload;
  return adminRequest(ctx, "POST", "/transactions", transactionPayload);
}

if (ctx.step === "transaction") {
  ctx.transaction = msg.payload;
  ctx.transactionId = pickTransactionId(msg.payload) || ctx.transactionId || null;

  const directPaymentUrl = extractPaymentUrl(msg.payload);
  if (!directPaymentUrl && ctx.transactionId) {
    ctx.step = "transaction_lookup";
    return adminRequest(
      ctx,
      "GET",
      `/transactions/${encodeURIComponent(ctx.transactionId)}`,
    );
  }

  const responsePayload = buildSplitPaymentResponse(ctx, msg.payload, ctx.transaction);
  if (!responsePayload.paymentUrl && responsePayload.toPayMinor > 0) {
    return fail(502, "Viva transaction has no paymentUrl", {
      transactionId: responsePayload.transactionId,
      createTransactionResponse: ctx.transaction || null,
    });
  }

  msg.statusCode = 201;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = responsePayload;
  return [null, msg, msg];
}

if (ctx.step === "transaction_lookup") {
  const responsePayload = buildSplitPaymentResponse(ctx, msg.payload, ctx.transaction);
  if (!responsePayload.paymentUrl && responsePayload.toPayMinor > 0) {
    return fail(502, "Viva transaction has no paymentUrl", {
      transactionId: responsePayload.transactionId,
      createTransactionResponse: ctx.transaction || null,
      lookupTransactionResponse: msg.payload || null,
    });
  }

  msg.statusCode = 201;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = responsePayload;
  return [null, msg, msg];
}

return fail(500, "Unsupported split payment step", { step: ctx.step });

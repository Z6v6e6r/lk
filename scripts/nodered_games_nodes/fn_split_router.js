const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const TOKEN_CLIENT_ID_DEFAULT = "React-auth-dev";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;
const TOKEN_REFRESH_LOCK_MS = 10 * 1000;
const SPLIT_DIRECTION_ID = 4588;
const SPLIT_EXERCISE_TYPE_ID = 1613;
const DEFAULT_ONE_TIME_PRODUCT_AMOUNT = 10000;
const SUBSCRIPTION_DAILY_LIMIT_CODE = "SUBSCRIPTION_DAILY_LIMIT_REACHED";
const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const readEnv = (key) => {
  try {
    return typeof env !== "undefined" && env && typeof env.get === "function"
      ? toStr(env.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const readGlobal = (key) => {
  try {
    return typeof global !== "undefined" && global && typeof global.get === "function"
      ? global.get(key)
      : null;
  } catch (_error) {
    return null;
  }
};

const writeGlobal = (key, value) => {
  if (typeof global !== "undefined" && global && typeof global.set === "function") {
    global.set(key, value);
  }
};

const clearRefreshLock = (owner) => {
  const normalizedOwner = toStr(owner);
  if (!normalizedOwner || toStr(readGlobal(KEY_REFRESH_OWNER)) !== normalizedOwner) return;
  writeGlobal(KEY_REFRESH_OWNER, null);
  writeGlobal(KEY_REFRESH_LOCK_UNTIL, 0);
};

const persistServiceToken = (token, expiresInRaw) => {
  const normalizedToken = toStr(token);
  if (!normalizedToken) return;
  const expiresIn = Number(expiresInRaw);
  const ttlSeconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300;
  writeGlobal(KEY_TOKEN, normalizedToken);
  writeGlobal(KEY_EXPIRES_AT, Date.now() + ttlSeconds * 1000);
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `+7${digits.slice(1)}`;
  if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0")) return `+${digits}`;
  return null;
};

const providerObjects = (value) => {
  const result = [];
  const seen = new Set();
  const visit = (item, depth) => {
    if (!item || typeof item !== "object" || seen.has(item) || depth > 6) return;
    seen.add(item);
    if (!Array.isArray(item)) result.push(item);
    Object.values(item).forEach((nested) => visit(nested, depth + 1));
  };
  visit(value, 0);
  return result;
};

const providerIds = (value, keys) => {
  const ids = new Set();
  providerObjects(value).forEach((item) => {
    keys.forEach((key) => {
      const candidate = item[key];
      if (Array.isArray(candidate)) {
        candidate.forEach((entry) => {
          const id = toStr(entry && typeof entry === "object" ? (entry.id || entry.uuid || entry.bookingId) : entry);
          if (id) ids.add(id);
        });
      } else {
        const id = toStr(candidate && typeof candidate === "object" ? (candidate.id || candidate.uuid || candidate.bookingId) : candidate);
        if (id) ids.add(id);
      }
    });
  });
  return Array.from(ids);
};

const providerPhone = (value) => {
  for (const item of providerObjects(value)) {
    for (const candidate of [item.clientPhone, item.phone, item.phoneNumber, item.mobile]) {
      const phone = normalizePhone(candidate);
      if (phone) return phone;
    }
  }
  return null;
};

const providerStatus = (value) => {
  for (const item of providerObjects(value)) {
    const status = toStr(item.paymentStatus || item.transactionStatus || item.status || item.state);
    if (status) return status.toUpperCase();
  }
  return null;
};

const statusIsConfirmed = (value) => {
  return String(value || "").trim().toUpperCase() === "PAID";
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
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(Number(status) === 503 ? { "Retry-After": "2" } : {}),
  };
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
  delete msg.requestTimeout;
  return [msg, null, null];
};

const resolveSplitPricingPolicy = (value) => {
  const source = value && typeof value === "object" && value.data && typeof value.data === "object"
    ? value.data
    : value;
  if (!source || typeof source !== "object") return null;
  const selectedPromoId = toStr(source.selectedPromoId);
  const campaignId = toStr(source.id) || selectedPromoId;
  const mode = toStr(source.pricingMode);
  const currency = toStr(source.currency)?.toUpperCase();
  const twoTeamsHourlyAmount = toNumber(source.shareAmounts?.twoTeams);
  const fourPlayersHourlyAmount = toNumber(source.shareAmounts?.fourPlayers);
  if (
    source.enabled !== true
    || !selectedPromoId
    || campaignId !== selectedPromoId
    || mode !== "PER_PARTICIPANT_HOUR"
    || currency !== "RUB"
    || twoTeamsHourlyAmount === null
    || twoTeamsHourlyAmount < 0
    || fourPlayersHourlyAmount === null
    || fourPlayersHourlyAmount < 0
  ) {
    return null;
  }
  return {
    id: selectedPromoId,
    title: toStr(source.title),
    pricingMode: mode,
    currency,
    twoTeamsHourlyAmount,
    fourPlayersHourlyAmount,
    activeFrom: toStr(source.activeFrom),
    activeTo: toStr(source.expiresAt),
    version: toStr(source.updatedAt) || selectedPromoId,
  };
};

const pricingPolicyMatchesExpected = (actual, expected, shareCount) => {
  if (!expected || typeof expected !== "object") return true;
  if (!actual) return false;
  const expectedId = toStr(expected.id || expected.pricingPolicyId);
  const expectedMode = toStr(expected.pricingMode || expected.model);
  const expectedCurrency = toStr(expected.currency)?.toUpperCase();
  const expectedHourlyAmount = toNumber(
    expected.hourlyAmount
    ?? expected.rate
    ?? (shareCount === 2 ? expected.twoTeamsHourlyAmount : expected.fourPlayersHourlyAmount),
  );
  const actualHourlyAmount = toNumber(
    shareCount === 2 ? actual.twoTeamsHourlyAmount : actual.fourPlayersHourlyAmount,
  );
  return (
    (!expectedId || expectedId === actual.id)
    && (!expectedMode || expectedMode === actual.pricingMode)
    && (!expectedCurrency || expectedCurrency === actual.currency)
    && (expectedHourlyAmount === null || expectedHourlyAmount === actualHourlyAmount)
  );
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
  if (toStr(preferredSubscriptionId)) return null;

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
  const clientSubscriptionId = toStr(ctx.clientSubscriptionId);
  const requestedSubscriptionId = toStr(ctx.subscriptionId);
  const subscriptionVisitCount = resolveSubscriptionVisitCount(ctx);
  const payload = {
    phone: ctx.clientPhone,
    paymentType: bookingPaymentType,
    familyMemberId: "",
  };
  if (bookingPaymentType === "SUBSCRIPTION" && !clientSubscriptionId) {
    return fail(400, "clientSubscriptionId is required for subscription payment", {
      code: "SUBSCRIPTION_SELECTION_REQUIRED",
    });
  }
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

const continueSplitAfterTrustedLocation = (ctx) => {
  if (ctx.action === "create") {
    ctx.step = "create_exercise";
    return adminRequest(ctx, "POST", "/exercises", {
      directionId: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
      typeId: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
      timeFrom: `${ctx.date}T${ctx.fromTime}+03:00`,
      timeTo: `${ctx.date}T${ctx.toTime}+03:00`,
      maxClientsCount: ctx.maxClientsCount,
      roomId: ctx.roomId,
      trainers: [],
      requirements: [],
    });
  }
  return buildBookingRequest(ctx);
};

const startRoomStudioVerification = (ctx) => {
  const studioId = toStr(ctx.studioId);
  const roomId = toStr(ctx.roomId);
  if (!studioId || !roomId) {
    return fail(400, "Для раздельной оплаты нужны stationId и roomId", {
      code: "SPLIT_PRICING_LOCATION_REQUIRED",
    });
  }
  ctx.step = "verify_room_studio";
  return adminRequest(
    ctx,
    "GET",
    `/studios/${encodeURIComponent(studioId)}/rooms/${encodeURIComponent(roomId)}`,
  );
};

const continueSplitAfterToken = (ctx) => {
  if (resolvePaymentMode(ctx.paymentMode) === "one_time") {
    return startRoomStudioVerification(ctx);
  }
  return continueSplitAfterTrustedLocation(ctx);
};

const startVivaAuthorization = (ctx) => {
  const cachedToken = toStr(readGlobal(KEY_TOKEN));
  const expiresAt = Number(readGlobal(KEY_EXPIRES_AT) || 0);
  if (cachedToken && Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_CACHE_GRACE_MS) {
    ctx.token = cachedToken;
    ctx.tokenSource = "cache";
    return continueSplitAfterToken(ctx);
  }

  const username = readEnv("VIVA_SERVICE_USERNAME");
  const password = readEnv("VIVA_SERVICE_PASSWORD");
  if (!username || !password) {
    return fail(503, "Сервисная авторизация Viva не настроена", {
      code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
    });
  }
  const now = Date.now();
  const lockUntil = Number(readGlobal(KEY_REFRESH_LOCK_UNTIL) || 0);
  if (Number.isFinite(lockUntil) && lockUntil > now) {
    return fail(503, "Авторизация Viva временно обновляется", {
      code: "VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS",
      retryAfterSeconds: 1,
    });
  }
  const owner = `split-policy:${now}:${Math.random().toString(36).slice(2, 10)}`;
  writeGlobal(KEY_REFRESH_OWNER, owner);
  writeGlobal(KEY_REFRESH_LOCK_UNTIL, now + TOKEN_REFRESH_LOCK_MS);
  ctx.step = "token";
  ctx.tokenSource = "refresh";
  ctx.tokenRefreshOwner = owner;
  msg._splitCtx = ctx;
  msg.method = "POST";
  msg.url = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.payload = [
    ["grant_type", "password"],
    ["client_id", readEnv("VIVA_SERVICE_CLIENT_ID") || TOKEN_CLIENT_ID_DEFAULT],
    ["username", username],
    ["password", password],
  ]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  delete msg.requestTimeout;
  return [msg, null, null];
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
    pricingPolicy: ctx.pricingPolicy || null,
  };
};

const ctx = msg._splitCtx && typeof msg._splitCtx === "object" ? msg._splitCtx : null;
if (!ctx) {
  return fail(500, "Split payment context is missing");
}

if (ctx.step === "token") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    clearRefreshLock(ctx.tokenRefreshOwner);
    return fail(503, "Сервисная авторизация Viva временно недоступна", {
      code: "VIVA_SERVICE_AUTH_UNAVAILABLE",
    });
  }
  ctx.token = msg.payload.access_token;
  if (ctx.tokenSource !== "cache") {
    persistServiceToken(ctx.token, msg.payload?.expires_in);
  }
  clearRefreshLock(ctx.tokenRefreshOwner);

  if (ctx.action === "confirm_payment") {
    if (ctx.operationType === "TRANSACTION" && ctx.clientId) {
      ctx.step = "confirm_transaction_lookup";
      return adminRequest(ctx, "GET", `/transactions/${encodeURIComponent(ctx.operationId)}`);
    }
    if (ctx.operationType === "SUBSCRIPTION_BOOKING" && ctx.clientId) {
      ctx.step = "confirm_subscription_booking_lookup";
      return adminRequest(
        ctx,
        "GET",
        `/clients/${encodeURIComponent(ctx.clientId)}/bookings/${encodeURIComponent(ctx.bookingId)}`,
      );
    }
    return fail(400, "Payment confirmation locator is invalid", {
      code: "LEGACY_PAYMENT_CONFIRM_INVALID",
    });
  }

  return continueSplitAfterToken(ctx);
}

if (!isOk(msg.statusCode)) {
  if (ctx.step === "pricing_policy") {
    return fail(503, "Не удалось проверить тариф раздельной оплаты", {
      code: "SPLIT_PRICING_POLICY_UNAVAILABLE",
    });
  }
  if (ctx.step === "verify_room_studio") {
    return fail(409, "Корт не принадлежит выбранной станции", {
      code: "SPLIT_PRICING_ROOM_STUDIO_MISMATCH",
      studioId: toStr(ctx.studioId),
      roomId: toStr(ctx.roomId),
    });
  }
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

if (ctx.step === "confirm_transaction_lookup") {
  const objects = providerObjects(msg.payload);
  const transaction = objects.find((item) => pickTransactionId(item) === ctx.operationId) || null;
  const bookingIds = providerIds(transaction, ["bookingId", "bookingIds", "bookings"]);
  const exerciseIds = providerIds(transaction, ["exerciseId", "exerciseIds", "exercise"]);
  const clientIds = providerIds(transaction, ["clientId", "client"]);
  const status = providerStatus(transaction);
  const clientPhoneE164 = providerPhone(transaction);
  if (
    !transaction
    || !statusIsConfirmed(status)
    || !bookingIds.includes(ctx.bookingId)
    || !exerciseIds.includes(ctx.expectedExerciseId)
    || !clientIds.includes(ctx.clientId)
    || !clientPhoneE164
  ) {
    return fail(409, "Viva transaction is not a confirmed payment for this booking", {
      code: "LEGACY_PAYMENT_NOT_CONFIRMED",
    });
  }
  const amountMinor = Math.floor(toNumber(
    transaction.amountMinor
    || transaction.totalAmountMinor
    || transaction.paidAmountMinor,
  ) ?? -1);
  msg._verifiedPaymentEvidence = {
    operationType: "TRANSACTION",
    operationId: ctx.operationId,
    bookingId: ctx.bookingId,
    exerciseId: ctx.expectedExerciseId,
    clientPhoneE164,
    verifiedAt: new Date().toISOString(),
    ...(amountMinor >= 0 ? { amountMinor } : {}),
    currency: toStr(transaction.currency)?.toUpperCase() || "RUB",
  };
  return [null, null, null, null, msg];
}

if (ctx.step === "confirm_subscription_booking_lookup") {
  const booking = providerObjects(msg.payload).find((item) => (
    toStr(item.id || item.uuid || item.bookingId) === ctx.bookingId
  )) || null;
  const exerciseIds = providerIds(booking, ["exerciseId", "exercise", "exerciseIds"]);
  const clientIds = providerIds(booking, ["clientId", "client"]);
  const clientPhoneE164 = providerPhone(booking);
  const hasSubscription = Boolean(booking && (
    Boolean(toStr(booking.clientSubscriptionId || booking.subscriptionId || booking.clientSubId))
    || /SUBSCRIPTION/i.test(String(booking.paymentType || booking.paymentMethod || ""))
  ));
  const explicitlyActiveSubscriptionBooking = Boolean(
    booking
    && booking.isCancelled === false
    && booking.cancelled === false
    && String(booking.paymentType || booking.detailedPaymentType || "").trim().toUpperCase() === "SUBSCRIPTION"
  );
  if (
    !booking
    || !exerciseIds.includes(ctx.expectedExerciseId)
    || !clientIds.includes(ctx.clientId)
    || !clientPhoneE164
    || !hasSubscription
    || !explicitlyActiveSubscriptionBooking
  ) {
    return fail(409, "Viva subscription booking is not confirmed for this player and game", {
      code: "LEGACY_SUBSCRIPTION_BOOKING_NOT_CONFIRMED",
    });
  }
  msg._verifiedPaymentEvidence = {
    operationType: "SUBSCRIPTION_BOOKING",
    operationId: ctx.operationId,
    bookingId: ctx.bookingId,
    exerciseId: ctx.expectedExerciseId,
    clientPhoneE164,
    verifiedAt: new Date().toISOString(),
    amountMinor: 0,
    currency: "RUB",
  };
  return [null, null, null, null, msg];
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

if (ctx.step === "verify_room_studio") {
  const verifiedRoomId = toStr(msg.payload?.id || msg.payload?.roomId);
  if (!verifiedRoomId || verifiedRoomId !== toStr(ctx.roomId)) {
    return fail(409, "Viva не подтвердила корт выбранной станции", {
      code: "SPLIT_PRICING_ROOM_STUDIO_MISMATCH",
      studioId: toStr(ctx.studioId),
      requestedRoomId: toStr(ctx.roomId),
      verifiedRoomId,
    });
  }
  ctx.verifiedStudioId = toStr(ctx.studioId);
  ctx.verifiedRoomId = verifiedRoomId;
  return continueSplitAfterTrustedLocation(ctx);
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
  ctx.studioId = toStr(ctx.verifiedStudioId) || toStr(msg.payload?.studio?.id) || toStr(ctx.studioId);
  ctx.roomId = toStr(ctx.verifiedRoomId) || toStr(msg.payload?.room?.id) || toStr(msg.payload?.roomId) || ctx.roomId;
  ctx.spot = toNumber(msg.payload?.spot) ?? ctx.spot ?? null;

  if (!ctx.clientId || !ctx.studioId) {
    return fail(502, "Viva booking response has no clientId or studioId", msg.payload || null);
  }

  if (resolvePaymentMode(ctx.selectedPaymentMode || ctx.paymentMode) === "subscription") {
    const requestedClientSubscriptionId = toStr(ctx.clientSubscriptionId);
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
    bookingIds: [ctx.bookingId],
    clientId: ctx.clientId,
    studioId: ctx.studioId,
  });
}

if (ctx.step === "pricing_policy") {
  ctx.pricingPolicy = resolveSplitPricingPolicy(msg.payload);
  if (!pricingPolicyMatchesExpected(ctx.pricingPolicy, ctx.expectedPricingPolicy, ctx.shareCount)) {
    return fail(409, "Цена раздельной оплаты изменилась", {
      code: "SPLIT_PRICING_POLICY_CHANGED",
      expectedPricingPolicyId: toStr(ctx.expectedPricingPolicy?.id || ctx.expectedPricingPolicy?.pricingPolicyId),
      actualPricingPolicyId: toStr(ctx.pricingPolicy?.id),
    });
  }
  return startVivaAuthorization(ctx);
}

if (ctx.step === "available_products") {
  const products = extractList(msg.payload)
    .map((item) => normalizeProduct(item))
    .filter((item) => Boolean(item));
  if (products.length === 0) {
    return fail(502, "No Viva booking payment product is available", msg.payload || null);
  }

  const oneTimeBaseMinor = Math.max(
    0,
    Math.round((toNumber(ctx.oneTimeBaseAmount) ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT) * 100),
  );
  const oneTimeProduct = pickBestOneTimeProduct(products, oneTimeBaseMinor);
  const requestedClientSubscriptionId = toStr(ctx.clientSubscriptionId);
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
  if (
    requestedMode === "subscription"
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
  let selectedMode = requestedMode;
  if (selectedMode === "subscription" && !subscriptionProduct) {
    selectedMode = "one_time";
  }
  if (selectedMode === "one_time" && !oneTimeProduct && subscriptionProduct) {
    selectedMode = "subscription";
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
  const shareCount = Math.max(1, Math.round(toNumber(ctx.shareCount) ?? 4));
  const durationMinutes = Math.max(1, Math.round(toNumber(ctx.durationMinutes) ?? 60));
  const policyHourlyAmount = toNumber(
    shareCount === 2
      ? ctx.pricingPolicy?.twoTeamsHourlyAmount
      : ctx.pricingPolicy?.fourPlayersHourlyAmount,
  );
  const shareAmountMinor = selectedMode === "one_time" && policyHourlyAmount !== null
    ? Math.max(0, Math.round(policyHourlyAmount * durationMinutes / 60 * 100))
    : Math.max(0, Math.round(selectedProductCostMinor / shareCount));
  ctx.shareAmount = shareAmountMinor / 100;
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

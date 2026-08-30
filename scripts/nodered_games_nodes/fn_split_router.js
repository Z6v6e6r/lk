const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const END_USER_API = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const CUP_API_DEFAULT = "https://padlhub.su/api";
const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const TOKEN_CLIENT_ID_DEFAULT = "React-auth-dev";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;
const TOKEN_REFRESH_LOCK_MS = 10 * 1000;
const SPLIT_DIRECTION_ID = 4588;
const SPLIT_EXERCISE_TYPE_ID = 1613;
const DEFAULT_ONE_TIME_PRODUCT_AMOUNT = 10000;
const TOKEN_REQUEST_TIMEOUT_MS = 10000;
const ADMIN_REQUEST_TIMEOUT_MS = 20000;
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

const providerClientSubscriptionId = (booking) => {
  if (!booking || typeof booking !== "object") return null;
  return toStr(
    booking.clientSubscriptionId
    || booking.clientSubId
    || booking.subscription?.clientSubscriptionId
    || booking.subscription?.subscriptionId,
  );
};

const providerSubscriptionVisitCount = (booking, fallback) => {
  if (!booking || typeof booking !== "object") return null;
  const explicit = Math.floor(toNumber(
    booking.count
    ?? booking.visitsCount
    ?? booking.visitCount
    ?? booking.subscription?.count,
  ) ?? 0);
  if (explicit > 0) return explicit;
  const expected = Math.floor(toNumber(fallback) ?? 0);
  return expected > 0 ? expected : null;
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
  msg.requestTimeout = ADMIN_REQUEST_TIMEOUT_MS;
  return [msg, null, null];
};

const endUserRequest = (ctx, path) => {
  msg._splitCtx = ctx;
  msg.method = "GET";
  msg.url = `${END_USER_API}${path}`;
  msg.headers = {
    Authorization: ctx.userAuthHeader,
    Accept: "application/json",
    "Cache-Control": "no-store",
  };
  msg.payload = undefined;
  msg.requestTimeout = ADMIN_REQUEST_TIMEOUT_MS;
  return [msg, null, null];
};

const buildQuery = (entries) => entries
  .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  .join("&");

const startPricingPolicyRequest = (ctx) => {
  const apiBase = (readEnv("CUP_API_BASE_URL") || CUP_API_DEFAULT).replace(/\/+$/, "");
  const query = buildQuery([
    ["forDate", ctx.date],
    ["stationId", ctx.studioId],
    ["roomId", ctx.roomId],
    ["force_ts", `${Date.now()}-${Math.random().toString(36).slice(2)}`],
  ]);
  ctx.step = "pricing_policy";
  msg._splitCtx = ctx;
  msg.method = "GET";
  msg.url = `${apiBase}/advertising/split-payment-promo?${query}`;
  msg.headers = { Accept: "application/json", "Cache-Control": "no-store" };
  msg.payload = undefined;
  msg.requestTimeout = 5000;
  return [msg, null, null];
};

const extractDirectPriceAmount = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of [
    "appliedValueFrom",
    "appliedValue",
    "appliedAmount",
    "from",
    "price",
    "cost",
    "amount",
    "fullPrice",
    "total",
    "value",
    "finalPrice",
    "valueFrom",
  ]) {
    const amount = toNumber(value[key]);
    if (amount !== null) return amount;
  }
  return null;
};

const extractCalculatedPriceAmount = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const direct = extractDirectPriceAmount(value);
  if (direct !== null) return direct;
  const calculation = value.calculation;
  if (!calculation || typeof calculation !== "object" || Array.isArray(calculation)) return null;
  for (const item of Object.values(calculation)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const basePrice = item.basePrice && typeof item.basePrice === "object" ? item.basePrice : null;
    const base = extractDirectPriceAmount(basePrice) ?? extractDirectPriceAmount(item);
    if (base === null) continue;
    const impacts = Array.isArray(item.impacts) ? item.impacts : [];
    const impactsTotal = impacts.reduce((sum, impact) => {
      if (!impact || typeof impact !== "object") return sum;
      const impactPrice = impact.price && typeof impact.price === "object" ? impact.price : {};
      const applied = toNumber(
        impact.appliedValueFrom
        ?? impact.appliedValue
        ?? impact.appliedAmount
        ?? impact.valueFrom
        ?? impact.from
        ?? impact.amount
        ?? impactPrice.appliedValueFrom
        ?? impactPrice.appliedValue
        ?? impactPrice.appliedAmount
        ?? impactPrice.valueFrom
        ?? impactPrice.from
        ?? impactPrice.amount,
      );
      if (applied !== null) return sum + applied;
      const raw = toNumber(impact.value ?? impact.valueTo ?? impactPrice.value ?? impactPrice.valueTo);
      if (raw === null) return sum;
      return String(impact.impactDirection || impact.direction || "").toUpperCase() === "DISCOUNT"
        ? sum - Math.abs(raw)
        : sum + raw;
    }, 0);
    return base + impactsTotal;
  }
  return null;
};

const extractExactCourtPrice = (payload, subServiceIds) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  for (const wrapperKey of ["data", "payload", "result", "pricing"]) {
    const wrapped = payload[wrapperKey];
    if (!wrapped || typeof wrapped !== "object" || wrapped === payload) continue;
    const amount = extractExactCourtPrice(wrapped, subServiceIds);
    if (amount !== null) return amount;
  }
  for (const subServiceId of subServiceIds) {
    const amount = extractCalculatedPriceAmount(payload[subServiceId]);
    if (amount !== null) return amount;
  }
  return extractCalculatedPriceAmount(payload);
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
    activeTo: toStr(source.activeTo || source.expiresAt),
    version: toStr(source.updatedAt) || selectedPromoId,
  };
};

const resolveSplitPricingPolicyResponse = (value) => {
  const source = value && typeof value === "object" && value.data && typeof value.data === "object"
    ? value.data
    : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { valid: false, policy: null };
  }
  if (source.enabled === false) {
    return { valid: !toStr(source.selectedPromoId), policy: null };
  }
  const policy = resolveSplitPricingPolicy(source);
  return { valid: Boolean(policy), policy };
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
    managedAction: ctx.action === "create"
      ? "CREATE_GAME"
      : ctx.action === "join"
        ? "JOIN_GAME"
        : null,
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
    for (const key of ["content", "data", "items", "result", "studios", "subServices", "services"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    for (const key of ["data", "payload", "result"]) {
      const nested = value[key];
      if (!nested || typeof nested !== "object" || nested === value) continue;
      const items = extractList(nested);
      if (items.length > 0) return items;
    }
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

const continueSplitAfterVerifiedPrice = (ctx) => {
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

const startOrdinaryPriceVerification = (ctx) => {
  const authHeader = toStr(ctx.userAuthHeader);
  const masterServiceId = toStr(ctx.masterServiceId);
  const subServiceIds = Array.isArray(ctx.subServiceIds)
    ? Array.from(new Set(ctx.subServiceIds.map((item) => toStr(item)).filter(Boolean)))
    : [];
  if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
    return fail(401, "Требуется авторизация Viva для проверки стоимости корта", {
      code: "SPLIT_EXACT_PRICE_AUTH_REQUIRED",
    });
  }
  if (!masterServiceId || subServiceIds.length === 0 || !ctx.date || !ctx.fromTime || !ctx.toTime) {
    return fail(409, "Не хватает данных Viva для точного расчёта стоимости корта", {
      code: "SPLIT_EXACT_PRICE_CONTRACT_INCOMPLETE",
    });
  }
  ctx.masterServiceId = masterServiceId;
  ctx.subServiceIds = subServiceIds;
  ctx.step = "ordinary_price_studios";
  return endUserRequest(
    ctx,
    `/products/master-services/${encodeURIComponent(masterServiceId)}/studios?`,
  );
};

const startOrdinarySubServiceVerification = (ctx) => {
  ctx.step = "ordinary_price_subservices";
  const query = buildQuery([
    ["studioId", ctx.studioId],
    ["showAll", "true"],
  ]);
  return endUserRequest(
    ctx,
    `/products/master-services/${encodeURIComponent(ctx.masterServiceId)}/subServices?${query}`,
  );
};

const continueSplitAfterTrustedLocation = (ctx) => {
  if (
    resolvePaymentMode(ctx.paymentMode) === "one_time"
    && !ctx.pricingPolicy
    && ctx.exactCourtPriceVerified !== true
  ) {
    return startOrdinaryPriceVerification(ctx);
  }
  return continueSplitAfterVerifiedPrice(ctx);
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
  const legacyPricingRecovery = ctx.legacyPricingRecovery && typeof ctx.legacyPricingRecovery === "object"
    ? ctx.legacyPricingRecovery
    : null;
  if (
    ctx.action === "join"
    && legacyPricingRecovery
    && legacyPricingRecovery.verified !== true
  ) {
    const organizerBookingId = toStr(legacyPricingRecovery.organizerBookingId);
    if (!organizerBookingId || !toStr(ctx.exerciseId)) {
      return fail(409, "Не удалось восстановить тариф игры", {
        code: "SPLIT_LEGACY_PRICING_RECOVERY_EVIDENCE_MISSING",
      });
    }
    ctx.step = "legacy_pricing_booking";
    return adminRequest(
      ctx,
      "GET",
      `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
    );
  }
  if (
    ctx.action === "join"
    && resolvePaymentMode(ctx.paymentMode) === "one_time"
    && ctx.pricingPolicy
    && ctx.pricingPolicyProof
    && ctx.pricingPolicyProofVerified !== true
  ) {
    ctx.step = "pricing_policy_proof";
    return adminRequest(
      ctx,
      "GET",
      `/transactions/${encodeURIComponent(ctx.pricingPolicyProof.transactionId)}`,
    );
  }
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
  msg.requestTimeout = TOKEN_REQUEST_TIMEOUT_MS;
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

const pickExplicitTransactionToPayMinor = (primaryPayload, fallbackPayload) => {
  const values = [
    toNumber(primaryPayload?.toPay),
    toNumber(primaryPayload?.toPayMinor),
    toNumber(fallbackPayload?.toPay),
    toNumber(fallbackPayload?.toPayMinor),
  ]
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, Math.round(value)));
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
};

const providerTransactionAmountMinor = (transaction) => {
  const values = [
    toNumber(transaction?.toPay),
    toNumber(transaction?.toPayMinor),
    toNumber(transaction?.amountMinor),
    toNumber(transaction?.totalAmountMinor),
    toNumber(transaction?.paidAmountMinor),
  ]
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, Math.round(value)));
  const uniqueValues = [...new Set(values)];
  return uniqueValues.length === 1 ? uniqueValues[0] : null;
};

const providerTransactionCreateDate = (transaction) => {
  const value = toStr(transaction?.createDate);
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
};

const addProviderIds = (target, value, objectKeys) => {
  const values = Array.isArray(value) ? value : [value];
  values.forEach((candidate) => {
    if (candidate && typeof candidate === "object") {
      for (const key of objectKeys) {
        const id = toStr(candidate[key]);
        if (id) target.add(id);
      }
      return;
    }
    const id = toStr(candidate);
    if (id) target.add(id);
  });
};

const exactTransactionClientIds = (transaction) => {
  const ids = new Set();
  addProviderIds(ids, transaction?.clientId, ["id"]);
  addProviderIds(ids, transaction?.client, ["id", "uuid", "clientId"]);
  return [...ids];
};

const exactTransactionIds = (transaction) => {
  const ids = new Set();
  for (const key of ["transactionId", "transactionUuid", "id", "uuid"]) {
    addProviderIds(ids, transaction?.[key], ["transactionId", "transactionUuid", "id", "uuid"]);
  }
  addProviderIds(ids, transaction?.transaction, ["transactionId", "transactionUuid", "id", "uuid"]);
  return [...ids];
};

const exactTransactionBookingIds = (transaction) => {
  const ids = new Set();
  for (const key of ["bookingId", "bookingIds", "paymentBookingIds"]) {
    addProviderIds(ids, transaction?.[key], ["id", "uuid", "bookingId", "clientBookingId"]);
  }
  const products = Array.isArray(transaction?.products) ? transaction.products : [];
  products.forEach((product) => {
    for (const key of ["bookingId", "bookingIds", "paymentBookingIds", "clientBookingId"]) {
      addProviderIds(ids, product?.[key], ["id", "uuid", "bookingId", "clientBookingId"]);
    }
    const pricingDetails = Array.isArray(product?.pricingDetails) ? product.pricingDetails : [];
    pricingDetails.forEach((detail) => {
      addProviderIds(ids, detail?.clientBookingId, ["id", "uuid", "bookingId", "clientBookingId"]);
      addProviderIds(ids, detail?.bookingId, ["id", "uuid", "bookingId", "clientBookingId"]);
    });
  });
  return [...ids];
};

const splitProviderAmountMismatch = (ctx, primaryPayload, fallbackPayload, responsePayload) => {
  if (resolvePaymentMode(ctx.selectedPaymentMode || ctx.paymentMode) !== "one_time") return null;
  const expectedRaw = toNumber(ctx.shareAmountMinor);
  const expectedAmountMinor = expectedRaw === null
    ? null
    : Math.max(0, Math.round(expectedRaw));
  const providerAmountMinor = pickExplicitTransactionToPayMinor(primaryPayload, fallbackPayload);
  if (expectedAmountMinor !== null && providerAmountMinor === expectedAmountMinor) return null;
  return {
    code: "SPLIT_PROVIDER_AMOUNT_MISMATCH",
    transactionId: responsePayload?.transactionId || toStr(ctx.transactionId),
    expectedAmountMinor,
    providerAmountMinor,
  };
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

const bookingRowsForExercise = (payload, exerciseId) => {
  const expectedExerciseId = toStr(exerciseId);
  const seen = new Set();
  return providerObjects(payload).filter((item) => {
    const bookingLike = Boolean(
      item.bookingId
      || item.exerciseId
      || item.exercise
      || item.client
      || item.paymentType
      || item.spot !== undefined,
    );
    if (!bookingLike) return false;
    const bookingId = pickId(item) || toStr(item.bookingId);
    if (!bookingId || seen.has(bookingId)) return false;
    const itemExerciseIds = providerIds(item, ["exerciseId", "exerciseIds", "exercise"]);
    if (itemExerciseIds.length > 0 && !itemExerciseIds.includes(expectedExerciseId)) return false;
    seen.add(bookingId);
    return true;
  });
};

const bookingMatchesCreateActor = (booking, ctx) => {
  const expectedPhone = normalizePhone(ctx.clientPhone);
  const actualPhone = providerPhone(booking);
  const expectedClientId = toStr(ctx.clientId);
  const clientIds = providerIds(booking, ["clientId", "client"]);
  return Boolean(
    (expectedPhone && actualPhone && expectedPhone === actualPhone)
    || (expectedClientId && clientIds.includes(expectedClientId)),
  );
};

const originalBookingFailure = (ctx, code, error, extra) => ({
  code,
  error,
  providerStatus: Number(ctx.bookingFailure?.statusCode) || null,
  providerPayload: ctx.bookingFailure?.payload || null,
  exerciseId: toStr(ctx.exerciseId),
  paymentRef: toStr(ctx.paymentRef),
  ...extra,
});

const finishManagedSubscriptionFailure = (ctx, compensation) => {
  const failure = ctx.bookingFailure && typeof ctx.bookingFailure === "object"
    ? ctx.bookingFailure
    : {};
  const failurePayload = failure.payload && typeof failure.payload === "object"
    ? failure.payload
    : {};
  const originalDetails = failurePayload.details && typeof failurePayload.details === "object"
    ? failurePayload.details
    : null;
  return fail(
    Number(failure.statusCode) || 409,
    toStr(failurePayload.error) || "Правила подписки не разрешили создание игры",
    {
      ...(originalDetails || {}),
      compensation,
    },
  );
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
  if (ctx.step === "compensate_verify_exercise" && Number(msg.statusCode) === 404) {
    if (ctx.bookingFailure?.source === "MANAGED_SUBSCRIPTION_GATEWAY") {
      return finishManagedSubscriptionFailure(ctx, {
        code: "SPLIT_CREATED_EXERCISE_COMPENSATED",
        verified: true,
        exerciseId: toStr(ctx.exerciseId),
      });
    }
    return fail(502, "Viva booking failed; empty exercise was removed", originalBookingFailure(
      ctx,
      "SPLIT_BOOKING_FAILED_EXERCISE_COMPENSATED",
      "Booking creation failed after exercise creation",
      { compensationVerified: true },
    ));
  }
  if (ctx.step === "compensate_delete_exercise") {
    ctx.compensationDeleteStatus = Number(msg.statusCode) || null;
    ctx.step = "compensate_verify_exercise";
    return adminRequest(ctx, "GET", `/exercises/${encodeURIComponent(ctx.exerciseId)}`);
  }
  if (ctx.step === "reconcile_booking_after_failure") {
    return fail(503, "Booking result is ambiguous; exercise was not deleted", originalBookingFailure(
      ctx,
      "SPLIT_BOOKING_RECONCILIATION_REQUIRED",
      "Viva booking readback failed",
      { retryable: true, destructiveRetryBlocked: true },
    ));
  }
  if (ctx.step === "pricing_policy") {
    return fail(503, "Не удалось проверить тариф раздельной оплаты", {
      code: "SPLIT_PRICING_POLICY_UNAVAILABLE",
    });
  }
  if (ctx.step === "pricing_policy_proof") {
    return fail(503, "Не удалось подтвердить сохранённый тариф игры", {
      code: "SPLIT_PRICING_POLICY_PROOF_UNAVAILABLE",
    });
  }
  if (ctx.step === "legacy_pricing_booking") {
    return fail(503, "Не удалось проверить способ оплаты организатора", {
      code: "SPLIT_LEGACY_PRICING_RECOVERY_UNAVAILABLE",
    });
  }
  if (ctx.step === "legacy_pricing_transaction") {
    return fail(503, "Не удалось проверить оплату организатора", {
      code: "SPLIT_LEGACY_PRICING_TRANSACTION_UNAVAILABLE",
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
    ctx.step === "ordinary_price_studios"
    || ctx.step === "ordinary_price_subservices"
    || ctx.step === "ordinary_exact_price"
  ) {
    if (Number(msg.statusCode) === 401 || Number(msg.statusCode) === 403) {
      return fail(401, "Авторизация Viva не позволяет проверить стоимость корта", {
        code: "SPLIT_EXACT_PRICE_AUTH_INVALID",
      });
    }
    return fail(503, "Не удалось получить точную стоимость корта Viva", {
      code: "SPLIT_EXACT_PRICE_UNAVAILABLE",
      providerStatus: Number(msg.statusCode) || null,
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
      ctx.ownsExercise = false;
      return buildBookingRequest(ctx);
    }
  }
  if (
    ctx.step === "create_booking"
    && ctx.action === "create"
    && ctx.ownsExercise === true
    && toStr(ctx.exerciseId)
  ) {
    ctx.bookingFailure = {
      statusCode: Number(msg.statusCode) || null,
      payload: msg.payload || null,
    };
    ctx.step = "reconcile_booking_after_failure";
    return adminRequest(
      ctx,
      "GET",
      `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
    );
  }
  return fail(msg.statusCode || 502, "Viva request failed", msg.payload || null);
}

if (ctx.step === "subscription_gateway_rejected") {
  if (ctx.action !== "create" || ctx.ownsExercise !== true || !toStr(ctx.exerciseId)) {
    return fail(409, "Нельзя безопасно подтвердить владельца созданной услуги", {
      code: "SPLIT_CREATED_EXERCISE_OWNERSHIP_UNVERIFIED",
      destructiveRetryBlocked: true,
    });
  }
  ctx.step = "reconcile_booking_after_failure";
  return adminRequest(
    ctx,
    "GET",
    `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
  );
}

if (ctx.step === "subscription_full_price_fallback") {
  if (ctx.subscriptionGuardDone !== true
    || resolvePaymentMode(ctx.selectedPaymentMode || ctx.paymentMode) !== "one_time") {
    return fail(409, "Нельзя безопасно продолжить без льготы подписки", {
      code: "SUBSCRIPTION_FULL_PRICE_FALLBACK_CONTEXT_INVALID",
    });
  }
  return buildBookingRequest(ctx);
}

if (ctx.step === "reconcile_booking_after_failure") {
  const rows = bookingRowsForExercise(msg.payload, ctx.exerciseId);
  const matchingRows = rows.filter((item) => bookingMatchesCreateActor(item, ctx));
  if (matchingRows.length === 1) {
    ctx.step = "create_booking";
    ctx.bookingRecoveredByReadback = true;
    msg.payload = matchingRows[0];
  } else if (rows.length === 0) {
    ctx.step = "compensate_delete_exercise";
    return adminRequest(ctx, "DELETE", `/exercises/${encodeURIComponent(ctx.exerciseId)}`);
  } else {
    return fail(409, "Booking result is ambiguous; exercise was not deleted", originalBookingFailure(
      ctx,
      "SPLIT_BOOKING_RECONCILIATION_AMBIGUOUS",
      "Viva returned zero or multiple actor matches with non-empty bookings",
      {
        bookingRows: rows.map((item) => pickId(item) || toStr(item.bookingId)).filter(Boolean),
        matchingBookingRows: matchingRows.map((item) => pickId(item) || toStr(item.bookingId)).filter(Boolean),
        destructiveRetryBlocked: true,
      },
    ));
  }
}

if (ctx.step === "compensate_delete_exercise") {
  ctx.compensationDeleteStatus = Number(msg.statusCode) || null;
  ctx.step = "compensate_verify_exercise";
  return adminRequest(ctx, "GET", `/exercises/${encodeURIComponent(ctx.exerciseId)}`);
}

if (ctx.step === "compensate_verify_exercise") {
  if (ctx.bookingFailure?.source === "MANAGED_SUBSCRIPTION_GATEWAY") {
    return fail(503, "Отказ подписки подтверждён, но удаление пустой услуги не доказано", {
      code: "SPLIT_CREATED_EXERCISE_COMPENSATION_UNVERIFIED",
      originalFailure: ctx.bookingFailure.payload || null,
      compensationDeleteStatus: ctx.compensationDeleteStatus || null,
      exerciseId: toStr(ctx.exerciseId),
      destructiveRetryBlocked: true,
    });
  }
  return fail(503, "Booking failed and exercise compensation was not verified", originalBookingFailure(
    ctx,
    "SPLIT_EXERCISE_COMPENSATION_UNVERIFIED",
    "Exercise still exists after compensation request",
    {
      compensationDeleteStatus: ctx.compensationDeleteStatus || null,
      destructiveRetryBlocked: true,
    },
  ));
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
  const clientSubscriptionId = providerClientSubscriptionId(booking);
  const subscriptionVisitCount = providerSubscriptionVisitCount(
    booking,
    ctx.expectedSubscriptionVisitCount,
  );
  const hasSubscription = Boolean(booking && (
    Boolean(clientSubscriptionId || toStr(booking.subscriptionId))
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
    || !clientSubscriptionId
    || !subscriptionVisitCount
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
    clientSubscriptionId,
    subscriptionVisitCount,
    verifiedAt: new Date().toISOString(),
    amountMinor: 0,
    currency: "RUB",
  };
  return [null, null, null, null, msg];
}

if (ctx.step === "legacy_pricing_booking") {
  const recovery = ctx.legacyPricingRecovery && typeof ctx.legacyPricingRecovery === "object"
    ? ctx.legacyPricingRecovery
    : {};
  const recoveryMode = toStr(recovery.mode)
    ? resolvePaymentMode(recovery.mode)
    : "subscription";
  const organizerBookingId = toStr(recovery.organizerBookingId);
  const bookingCandidates = providerObjects(msg.payload).filter((item) => (
    toStr(item.id || item.uuid || item.bookingId) === organizerBookingId
  ));
  const booking = bookingCandidates.length === 1 ? bookingCandidates[0] : null;
  const exerciseIds = providerIds(booking, ["exerciseId", "exercise", "exerciseIds"]);
  const clientIds = providerIds(booking, ["clientId", "client"]);
  const expectedOrganizerClientId = toStr(recovery.organizerClientId);
  const expectedOrganizerPhone = normalizePhone(recovery.organizerPhone);
  const actualOrganizerPhone = providerPhone(booking);
  const organizerIdentityMatches = expectedOrganizerClientId
    ? clientIds.includes(expectedOrganizerClientId)
    : Boolean(expectedOrganizerPhone && actualOrganizerPhone === expectedOrganizerPhone);
  const clientSubscriptionId = providerClientSubscriptionId(booking);
  const paymentType = String(
    booking?.paymentType
    || booking?.detailedPaymentType
    || booking?.paymentMethod
    || "",
  ).trim().toUpperCase();
  const isActiveBooking = Boolean(
    booking
    && organizerBookingId
    && exerciseIds.includes(toStr(ctx.exerciseId))
    && organizerIdentityMatches
    && booking.isCancelled === false
    && booking.cancelled === false
  );
  const isActiveSubscriptionBooking = Boolean(
    isActiveBooking
    && paymentType === "SUBSCRIPTION"
    && clientSubscriptionId
  );
  const isActiveOneTimeBooking = Boolean(
    isActiveBooking
    && paymentType === "ON_PLACE"
  );
  if (
    (recoveryMode === "subscription" && !isActiveSubscriptionBooking)
    || (recoveryMode === "one_time" && !isActiveOneTimeBooking)
  ) {
    return fail(409, recoveryMode === "subscription"
      ? "Абонемент организатора не подтверждён"
      : "Оплата организатора не подтверждена", {
      code: recoveryMode === "subscription"
        ? "SPLIT_LEGACY_ORGANIZER_SUBSCRIPTION_NOT_CONFIRMED"
        : "SPLIT_LEGACY_ORGANIZER_ONE_TIME_BOOKING_NOT_CONFIRMED",
    });
  }
  ctx.legacyPricingRecovery = {
    mode: recoveryMode,
    organizerBookingId,
    organizerClientId: expectedOrganizerClientId,
    organizerPhone: expectedOrganizerPhone,
    verified: recoveryMode === "subscription",
  };
  if (recoveryMode === "one_time") {
    ctx.legacyPricingRecovery.expectedAmountMinor = Math.floor(
      toNumber(recovery.expectedAmountMinor) ?? -1,
    );
    ctx.legacyPricingRecovery.paidDate = toStr(recovery.paidDate);
    ctx.legacyPricingRecovery.bookingVerified = true;
    if (
      !expectedOrganizerClientId
      || ctx.legacyPricingRecovery.expectedAmountMinor <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.legacyPricingRecovery.paidDate || "")
    ) {
      return fail(409, "Не удалось подтвердить оплату организатора", {
        code: "SPLIT_LEGACY_PRICING_TRANSACTION_EVIDENCE_MISSING",
      });
    }
    const query = buildQuery([
      ["clientIds", expectedOrganizerClientId],
      ["dateFrom", ctx.legacyPricingRecovery.paidDate],
      ["dateTo", ctx.legacyPricingRecovery.paidDate],
      ["page", 0],
      ["size", 100],
      ["sort", "createDate,desc"],
    ]);
    ctx.step = "legacy_pricing_transaction";
    return adminRequest(ctx, "GET", `/transactions?${query}`);
  }
  return startPricingPolicyRequest(ctx);
}

if (ctx.step === "legacy_pricing_transaction") {
  const recovery = ctx.legacyPricingRecovery && typeof ctx.legacyPricingRecovery === "object"
    ? ctx.legacyPricingRecovery
    : {};
  const organizerBookingId = toStr(recovery.organizerBookingId);
  const organizerClientId = toStr(recovery.organizerClientId);
  const expectedAmountMinor = Math.floor(toNumber(recovery.expectedAmountMinor) ?? -1);
  const expectedPaidDate = toStr(recovery.paidDate);
  const transactions = extractList(msg.payload).filter((item) => item && typeof item === "object");
  const matches = transactions.filter((transaction) => {
    const transactionIds = exactTransactionIds(transaction);
    const bookingIds = exactTransactionBookingIds(transaction);
    const clientIds = exactTransactionClientIds(transaction);
    const transactionStatus = toStr(
      transaction.paymentStatus
      || transaction.transactionStatus
      || transaction.status
      || transaction.state,
    )?.toUpperCase();
    return (
      statusIsConfirmed(transactionStatus)
      && transactionIds.length === 1
      && bookingIds.length === 1
      && bookingIds[0] === organizerBookingId
      && clientIds.length === 1
      && clientIds[0] === organizerClientId
      && providerTransactionCreateDate(transaction) === expectedPaidDate
      && providerTransactionAmountMinor(transaction) === expectedAmountMinor
    );
  });
  if (matches.length !== 1) {
    return fail(409, "Оплата организатора не подтверждает восстановленный тариф", {
      code: "SPLIT_LEGACY_ORGANIZER_PAYMENT_NOT_CONFIRMED",
    });
  }
  ctx.legacyPricingRecovery = {
    ...recovery,
    transactionId: exactTransactionIds(matches[0])[0],
    verified: true,
  };
  return startPricingPolicyRequest(ctx);
}

if (ctx.step === "ordinary_price_studios") {
  const availableStudioIds = new Set(
    extractList(msg.payload)
      .map((item) => toStr(item?.id || item?.uuid || item?.studioId || item?.stationId))
      .filter(Boolean),
  );
  if (!availableStudioIds.has(toStr(ctx.studioId))) {
    return fail(409, "Master-service игры не принадлежит выбранной станции Viva", {
      code: "SPLIT_EXACT_PRICE_MASTER_SERVICE_MISMATCH",
    });
  }
  return startOrdinarySubServiceVerification(ctx);
}

if (ctx.step === "ordinary_price_subservices") {
  const availableSubServiceIds = new Set(
    extractList(msg.payload)
      .flatMap((item) => (
        item && typeof item === "object" && Array.isArray(item.subServices)
          ? item.subServices
          : [item]
      ))
      .map((item) => toStr(item?.id || item?.uuid || item?.subServiceId || item?.serviceId || item?.productId))
      .filter(Boolean),
  );
  const requestedSubServiceIds = Array.isArray(ctx.subServiceIds) ? ctx.subServiceIds : [];
  const invalidSubServiceIds = requestedSubServiceIds.filter((id) => !availableSubServiceIds.has(id));
  if (availableSubServiceIds.size === 0 || invalidSubServiceIds.length > 0) {
    return fail(409, "Подуслуга игры не принадлежит выбранной станции Viva", {
      code: "SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH",
      invalidSubServiceIds,
    });
  }

  ctx.step = "ordinary_exact_price";
  const query = buildQuery([
    ["studioId", ctx.studioId],
    ["roomId", ctx.roomId],
    ["subServiceIds", requestedSubServiceIds.join(",")],
    ["fromTime", ctx.fromTime],
    ["toTime", ctx.toTime],
    ["fromDate", ctx.date],
  ]);
  return endUserRequest(
    ctx,
    `/products/master-services/${encodeURIComponent(ctx.masterServiceId)}/price?${query}`,
  );
}

if (ctx.step === "ordinary_exact_price") {
  const exactCourtPrice = extractExactCourtPrice(msg.payload, ctx.subServiceIds || []);
  if (exactCourtPrice === null || exactCourtPrice < 0) {
    return fail(502, "Viva вернула некорректную стоимость корта", {
      code: "SPLIT_EXACT_PRICE_INVALID",
    });
  }
  const shareCount = Math.max(1, Math.round(toNumber(ctx.shareCount) ?? 4));
  ctx.totalAmount = Math.round(exactCourtPrice * 100) / 100;
  ctx.shareAmount = Math.round(exactCourtPrice / shareCount * 100) / 100;
  ctx.exactCourtPriceVerified = true;
  return continueSplitAfterVerifiedPrice(ctx);
}

if (ctx.step === "create_exercise") {
  const exerciseId = pickId(msg.payload);
  if (!exerciseId) {
    return fail(502, "Viva exercise response has no id", msg.payload || null);
  }

  ctx.exercise = msg.payload;
  ctx.exerciseId = exerciseId;
  ctx.ownsExercise = true;
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
      pricingPolicy: ctx.pricingPolicy || null,
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
  const pricingPolicyResponse = resolveSplitPricingPolicyResponse(msg.payload);
  if (!pricingPolicyResponse.valid) {
    return fail(502, "CUP вернул некорректный тариф раздельной оплаты", {
      code: "SPLIT_PRICING_POLICY_INVALID",
    });
  }
  ctx.pricingPolicy = pricingPolicyResponse.policy;
  if (!pricingPolicyMatchesExpected(ctx.pricingPolicy, ctx.expectedPricingPolicy, ctx.shareCount)) {
    return fail(409, "Цена раздельной оплаты изменилась", {
      code: "SPLIT_PRICING_POLICY_CHANGED",
      expectedPricingPolicyId: toStr(ctx.expectedPricingPolicy?.id || ctx.expectedPricingPolicy?.pricingPolicyId),
      actualPricingPolicyId: toStr(ctx.pricingPolicy?.id),
    });
  }
  if (ctx.pricingPolicy) {
    const shareCount = Math.max(1, Math.round(toNumber(ctx.shareCount) ?? 4));
    const durationMinutes = Math.max(1, Math.round(toNumber(ctx.durationMinutes) ?? 60));
    const hourlyAmount = toNumber(
      shareCount === 2
        ? ctx.pricingPolicy.twoTeamsHourlyAmount
        : ctx.pricingPolicy.fourPlayersHourlyAmount,
    );
    if (hourlyAmount !== null) {
      ctx.shareAmount = Math.max(0, Math.round(hourlyAmount * durationMinutes / 60 * 100) / 100);
    }
  }
  return startVivaAuthorization(ctx);
}

if (ctx.step === "pricing_policy_proof") {
  const proof = ctx.pricingPolicyProof && typeof ctx.pricingPolicyProof === "object"
    ? ctx.pricingPolicyProof
    : {};
  const transactionId = toStr(proof.transactionId);
  const bookingId = toStr(proof.bookingId);
  const expectedAmountMinor = Math.floor(toNumber(proof.expectedAmountMinor) ?? -1);
  const objects = providerObjects(msg.payload);
  const transaction = objects.find((item) => pickTransactionId(item) === transactionId) || null;
  const bookingIds = providerIds(transaction, ["bookingId", "bookingIds", "bookings"]);
  const exerciseIds = providerIds(transaction, ["exerciseId", "exerciseIds", "exercise"]);
  const clientIds = providerIds(transaction, ["clientId", "client"]);
  const paidAmountMinor = Math.floor(toNumber(
    transaction?.amountMinor
    ?? transaction?.totalAmountMinor
    ?? transaction?.paidAmountMinor
    ?? transaction?.toPay
    ?? transaction?.sum,
  ) ?? -1);
  const currency = toStr(transaction?.currency)?.toUpperCase() || "RUB";
  const expectedClientId = toStr(proof.clientId);
  if (
    !transaction
    || !statusIsConfirmed(providerStatus(transaction))
    || !bookingId
    || !bookingIds.includes(bookingId)
    || !exerciseIds.includes(toStr(ctx.exerciseId))
    || (expectedClientId && !clientIds.includes(expectedClientId))
    || expectedAmountMinor < 0
    || paidAmountMinor !== expectedAmountMinor
    || currency !== "RUB"
  ) {
    return fail(409, "Сохранённый тариф игры не подтверждён оплатой организатора", {
      code: "SPLIT_PRICING_POLICY_PROOF_INVALID",
    });
  }
  ctx.pricingPolicyProofVerified = true;
  return startRoomStudioVerification(ctx);
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
  const shareCount = Math.max(1, Math.round(toNumber(ctx.shareCount) ?? 4));
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
      label: `Оплатить 1/${shareCount} стоимости`,
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
  const durationMinutes = Math.max(1, Math.round(toNumber(ctx.durationMinutes) ?? 60));
  const policyHourlyAmount = toNumber(
    shareCount === 2
      ? ctx.pricingPolicy?.twoTeamsHourlyAmount
      : ctx.pricingPolicy?.fourPlayersHourlyAmount,
  );
  const exactCourtPrice = toNumber(ctx.totalAmount);
  if (
    selectedMode === "one_time"
    && policyHourlyAmount === null
    && (ctx.exactCourtPriceVerified !== true || exactCourtPrice === null || exactCourtPrice < 0)
  ) {
    return fail(409, "Точная стоимость корта не была подтверждена Viva", {
      code: "SPLIT_EXACT_PRICE_NOT_VERIFIED",
    });
  }
  const shareAmountMinor = selectedMode === "one_time" && policyHourlyAmount !== null
    ? Math.max(0, Math.round(policyHourlyAmount * durationMinutes / 60 * 100))
    : selectedMode === "one_time"
      ? Math.max(0, Math.round(exactCourtPrice * 100 / shareCount))
      : 0;
  if (selectedMode === "one_time" && shareAmountMinor > selectedProductCostMinor) {
    return fail(409, "Viva product не покрывает рассчитанную долю стоимости корта", {
      code: "SPLIT_TRANSACTION_PRODUCT_AMOUNT_TOO_LOW",
    });
  }
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
      : `Открытая игра ${shareCount}/${shareCount}: 1/${shareCount} стоимости корта`,
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
  const directTransactionIds = exactTransactionIds(msg.payload);
  if (directTransactionIds.length !== 1) {
    return fail(409, "Viva вернула неоднозначный идентификатор транзакции", {
      code: "SPLIT_PROVIDER_TRANSACTION_ID_INVALID",
      transactionIds: directTransactionIds,
    });
  }
  ctx.transactionId = directTransactionIds[0];

  const directPaymentUrl = extractPaymentUrl(msg.payload);
  const directProviderAmountMinor = pickExplicitTransactionToPayMinor(msg.payload, null);
  if ((!directPaymentUrl || directProviderAmountMinor === null) && ctx.transactionId) {
    ctx.step = "transaction_lookup";
    return adminRequest(
      ctx,
      "GET",
      `/transactions/${encodeURIComponent(ctx.transactionId)}`,
    );
  }

  const responsePayload = buildSplitPaymentResponse(ctx, msg.payload, ctx.transaction);
  const amountMismatch = splitProviderAmountMismatch(ctx, msg.payload, ctx.transaction, responsePayload);
  if (amountMismatch) {
    return fail(409, "Viva вернула другую сумму оплаты", amountMismatch);
  }
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
  const expectedTransactionId = toStr(ctx.transactionId);
  const actualTransactionIds = exactTransactionIds(msg.payload);
  const actualTransactionId = actualTransactionIds.length === 1 ? actualTransactionIds[0] : null;
  if (!expectedTransactionId || actualTransactionId !== expectedTransactionId) {
    return fail(409, "Viva вернула другую транзакцию", {
      code: "SPLIT_PROVIDER_TRANSACTION_MISMATCH",
      expectedTransactionId,
      actualTransactionId,
      actualTransactionIds,
    });
  }
  const responsePayload = buildSplitPaymentResponse(ctx, msg.payload, ctx.transaction);
  const amountMismatch = splitProviderAmountMismatch(ctx, msg.payload, null, responsePayload);
  if (amountMismatch) {
    return fail(409, "Viva вернула другую сумму оплаты", amountMismatch);
  }
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

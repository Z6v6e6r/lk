const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const CUP_API_DEFAULT = "https://padlhub.su/api";
const TOKEN_CLIENT_ID_DEFAULT = "React-auth-dev";
const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;
const TOKEN_REFRESH_LOCK_MS = 10 * 1000;
const DEFAULT_OPEN_GAME_DIRECTION_ID = 4588;
const DEFAULT_OPEN_GAME_EXERCISE_TYPE_ID = 1613;
const DEFAULT_SPLIT_SHARE_COUNT = 4;
const DEFAULT_PAYMENT_DEADLINE_MINUTES = 25;
const DEFAULT_ONE_TIME_PRODUCT_AMOUNT = 10000;
const MIN_BOOKING_LEAD_MINUTES = 30;
const TOKEN_REQUEST_TIMEOUT_MS = 10000;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
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

const readEnv = (key) => {
  try {
    return typeof env !== "undefined" && env && typeof env.get === "function"
      ? toStr(env.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const startPricingPolicyRequest = (ctx) => {
  const apiBase = (readEnv("CUP_API_BASE_URL") || CUP_API_DEFAULT).replace(/\/+$/, "");
  const query = [
    ["forDate", ctx.date],
    ["stationId", ctx.studioId],
    ["roomId", ctx.roomId],
    ["force_ts", `${Date.now()}-${Math.random().toString(36).slice(2)}`],
  ]
    .filter(([, value]) => Boolean(toStr(value)))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(toStr(value))}`)
    .join("&");
  ctx.step = "pricing_policy";
  msg.method = "GET";
  msg.url = `${apiBase}/advertising/split-payment-promo?${query}`;
  msg.headers = { Accept: "application/json", "Cache-Control": "no-store" };
  msg.payload = undefined;
  msg.requestTimeout = 5000;
  return [msg, null, null, null];
};

const readCachedServiceToken = () => {
  const token = toStr(readGlobal(KEY_TOKEN));
  const expiresAt = Number(readGlobal(KEY_EXPIRES_AT) || 0);
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + TOKEN_CACHE_GRACE_MS) {
    return null;
  }
  return token;
};

const buildTokenRequestBody = () => {
  const username = readEnv("VIVA_SERVICE_USERNAME");
  const password = readEnv("VIVA_SERVICE_PASSWORD");
  if (!username || !password) return null;
  const clientId = readEnv("VIVA_SERVICE_CLIENT_ID") || TOKEN_CLIENT_ID_DEFAULT;
  return [
    ["grant_type", "password"],
    ["client_id", clientId],
    ["username", username],
    ["password", password],
  ]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const resolvePositiveInt = (value, fallback) => {
  const parsed = Math.floor(toNumber(value) ?? NaN);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeDate = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const normalizeIdList = (value) => {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(",") : []);
  return Array.from(new Set(raw.map((item) => toStr(item)).filter(Boolean)));
};

const readUserAuthHeader = () => {
  const headers = msg.req && msg.req.headers && typeof msg.req.headers === "object"
    ? msg.req.headers
    : {};
  const authHeader = toStr(headers.authorization || headers.Authorization);
  return authHeader && /^Bearer\s+\S+/i.test(authHeader) ? authHeader : null;
};

const parseTimeMinutes = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!matched) return null;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
};

const resolveDurationMinutes = (from, to, explicitDuration) => {
  const explicit = toNumber(explicitDuration);
  if (explicit && explicit > 0) return explicit;
  const fromMinutes = parseTimeMinutes(from);
  const toMinutes = parseTimeMinutes(to);
  if (fromMinutes === null || toMinutes === null) return 60;
  const delta = toMinutes >= fromMinutes
    ? toMinutes - fromMinutes
    : toMinutes + 24 * 60 - fromMinutes;
  return delta > 0 ? delta : 60;
};

const resolveSubscriptionVisitCount = (durationMinutes) => {
  const safeDuration = Math.max(0, Math.floor(toNumber(durationMinutes) ?? 0));
  return safeDuration >= 90 ? 2 : 1;
};

const resolveShareAmount = (baseAmount, durationMinutes, includesDuration) => {
  const safeBase = toNumber(baseAmount);
  if (safeBase === null) return null;
  if (includesDuration === true) return safeBase;
  return Math.round(safeBase * Math.max(durationMinutes, 1) / 60);
};

const roundMoney = (value) => {
  const safe = toNumber(value);
  if (safe === null) return null;
  return Math.round(safe * 100) / 100;
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

const isSinglesFormat = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "singles"
    || normalized.includes("1x1")
    || normalized.includes("1х1")
    || normalized.includes("1 на 1")
  );
};

const isSinglesCourtName = (value) => /сингл|single|1\s*[xх]\s*1|1\s*на\s*1/i.test(String(value || ""));

const isSinglesGame = (payload) => {
  if (!payload || typeof payload !== "object") return false;
  if (isSinglesFormat(payload.gameFormat || payload.format)) return true;
  return [payload.roomName, payload.courtName, payload.courtTitle].some((value) => isSinglesCourtName(value));
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const date = normalizeDate(body.date);
const fromTime = toStr(body.fromTime);
const toTime = toStr(body.toTime);
const roomId = toStr(body.roomId);
const clientPhone = normalizePhone(body.clientPhone || body.phone);

if (!date || !fromTime || !toTime || !roomId || !clientPhone) {
  return fail(400, "date, fromTime, toTime, roomId and clientPhone are required");
}

const startAtIso = `${date}T${fromTime}:00+03:00`;
const startAtTs = Date.parse(startAtIso);
if (!Number.isFinite(startAtTs)) {
  return fail(400, "Некорректные дата или время начала", {
    code: "INVALID_BOOKING_START",
  });
}
if (startAtTs < Date.now() + MIN_BOOKING_LEAD_MINUTES * 60 * 1000) {
  return fail(409, `Бронирование доступно минимум за ${MIN_BOOKING_LEAD_MINUTES} минут до начала. Выберите другое время.`, {
    code: "BOOKING_LEAD_TIME_TOO_SHORT",
    minLeadMinutes: MIN_BOOKING_LEAD_MINUTES,
  });
}

const bodyShareCount = Math.floor(toNumber(body.shareCount) || 0);
const shareCount = bodyShareCount === 2 || isSinglesGame(body) ? 2 : DEFAULT_SPLIT_SHARE_COUNT;
const durationMinutes = resolveDurationMinutes(fromTime, toTime, null);
const subscriptionVisitCount = resolveSubscriptionVisitCount(durationMinutes);
const oneTimeBaseAmount = roundMoney(
  body.oneTimeBaseAmount
  ?? body.oneTimeAmount
  ?? body.singlePaymentAmount
  ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT,
) ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT;
const totalAmount = roundMoney(
  body.totalAmount
  ?? body.gameAmount
  ?? body.courtAmount
  ?? body.courtPrice
  ?? body.slotPrice
  ?? body.amount,
);
const defaultShareAmount = roundMoney(oneTimeBaseAmount / Math.max(shareCount, 1))
  ?? (shareCount === 2 ? 5000 : 2500);
const resolvedShareAmountFromTotal =
  totalAmount !== null && totalAmount > 0
    ? roundMoney(totalAmount / Math.max(shareCount, 1))
    : null;
const shareAmount = resolvedShareAmountFromTotal
  ?? resolveShareAmount(
    toNumber(body.shareAmount) ?? defaultShareAmount,
    durationMinutes,
    body.shareAmountIncludesDuration === true,
  )
  ?? defaultShareAmount;
const maxClientsLimit = shareCount === 2 ? 2 : 4;
const maxClientsCount = Math.max(1, Math.min(maxClientsLimit, Math.floor(toNumber(body.maxClientsCount) ?? shareCount)));
const spot = Math.max(1, Math.min(maxClientsLimit, Math.floor(toNumber(body.spot) ?? 1)));
const paymentRef = toStr(body.paymentRef) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const vivaDirectionId = resolvePositiveInt(
  body.vivaDirectionId ?? body.directionId,
  DEFAULT_OPEN_GAME_DIRECTION_ID,
);
const vivaExerciseTypeId = resolvePositiveInt(
  body.vivaExerciseTypeId ?? body.exerciseTypeId,
  DEFAULT_OPEN_GAME_EXERCISE_TYPE_ID,
);
const paymentMode = resolvePaymentMode(body.paymentMode || body.payMode || body.preferredPaymentMode);
const clientSubscriptionId = toStr(body.clientSubscriptionId);
if (paymentMode === "subscription" && !clientSubscriptionId) {
  return fail(400, "clientSubscriptionId is required for subscription payment", {
    code: "SUBSCRIPTION_SELECTION_REQUIRED",
  });
}
const transactionPaymentMethod = toStr(body.transactionPaymentMethod || body.paymentMethod);
const paymentDeadlineMinutes = Math.max(
  1,
  Math.min(180, Math.floor(toNumber(body.paymentDeadlineMinutes) ?? DEFAULT_PAYMENT_DEADLINE_MINUTES)),
);
const assembleDeadlineAt = Number.isFinite(startAtTs)
  ? new Date(startAtTs - 24 * 60 * 60 * 1000).toISOString()
  : null;

msg._splitCtx = {
  action: "create",
  step: "token",
  paymentRef,
  date,
  fromTime,
  toTime,
  timeFrom: `${date}T${fromTime}:00+03:00`,
  timeTo: `${date}T${toTime}:00+03:00`,
  studioId: toStr(body.studioId),
  roomId,
  masterServiceId: toStr(body.masterServiceId),
  subServiceIds: normalizeIdList(body.subServiceIds),
  userAuthHeader: readUserAuthHeader(),
  expectedPricingPolicy: body.expectedPricingPolicy && typeof body.expectedPricingPolicy === "object"
    ? body.expectedPricingPolicy
    : null,
  clientId: toStr(body.clientId),
  clientPhone,
  shareCount,
  shareAmount,
  totalAmount,
  oneTimeBaseAmount,
  durationMinutes,
  subscriptionVisitCount,
  maxClientsCount,
  spot,
  vivaDirectionId,
  vivaExerciseTypeId,
  paymentMode,
  clientSubscriptionId,
  transactionPaymentMethod,
  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),
  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),
  deadlineAt: new Date(Date.now() + paymentDeadlineMinutes * 60 * 1000).toISOString(),
  assembleDeadlineAt,
};

// Pricing is independent from how the organizer pays. Resolve it server-side
// for subscription creates too, otherwise an old browser can persist the full
// court share and omit the active campaign snapshot from the game record.
if (paymentMode === "one_time" || paymentMode === "subscription") {
  return startPricingPolicyRequest(msg._splitCtx);
}

const cachedToken = readCachedServiceToken();
if (cachedToken) {
  msg._splitCtx.tokenSource = "cache";
  msg.statusCode = 200;
  msg.payload = { access_token: cachedToken };
  return [null, null, null, msg];
}

const now = Date.now();
const lockUntil = Number(readGlobal(KEY_REFRESH_LOCK_UNTIL) || 0);
if (Number.isFinite(lockUntil) && lockUntil > now) {
  return fail(503, "Авторизация Viva временно обновляется", {
    code: "VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS",
    retryAfterSeconds: 1,
  });
}

const tokenRequestBody = buildTokenRequestBody();
if (!tokenRequestBody) {
  return fail(503, "Сервисная авторизация Viva не настроена", {
    code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
  });
}

const refreshOwner = `split-create:${now}:${Math.random().toString(36).slice(2, 10)}`;
writeGlobal(KEY_REFRESH_OWNER, refreshOwner);
writeGlobal(KEY_REFRESH_LOCK_UNTIL, now + TOKEN_REFRESH_LOCK_MS);
msg._splitCtx.tokenRefreshOwner = refreshOwner;
msg._splitCtx.tokenSource = "refresh";
msg.method = "POST";
msg.url = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload = tokenRequestBody;
msg.requestTimeout = TOKEN_REQUEST_TIMEOUT_MS;

return [msg, null, null, null];

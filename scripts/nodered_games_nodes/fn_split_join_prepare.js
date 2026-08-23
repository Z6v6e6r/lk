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
const DEFAULT_PAYMENT_DEADLINE_MINUTES = 10;
const DEFAULT_ONE_TIME_PRODUCT_AMOUNT = 10000;
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

const resolveStoredPricingPolicy = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = toStr(value.id || value.pricingPolicyId);
  const mode = toStr(value.pricingMode || value.model);
  const currency = toStr(value.currency)?.toUpperCase();
  const twoTeamsHourlyAmount = toNumber(value.twoTeamsHourlyAmount);
  const fourPlayersHourlyAmount = toNumber(value.fourPlayersHourlyAmount);
  if (
    !id
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
    id,
    title: toStr(value.title),
    pricingMode: mode,
    currency,
    twoTeamsHourlyAmount,
    fourPlayersHourlyAmount,
    activeFrom: toStr(value.activeFrom),
    activeTo: toStr(value.activeTo || value.expiresAt),
    version: toStr(value.version || value.revision || value.updatedAt) || id,
  };
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

const resolveIsSinglesGame = ({ metadata, splitPayment, booking, game }) => {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const split = splitPayment && typeof splitPayment === "object" ? splitPayment : {};
  const bookingData = booking && typeof booking === "object" ? booking : {};
  const gameDoc = game && typeof game === "object" ? game : {};

  if (isSinglesFormat(meta.gameFormat || meta.format)) return true;
  const splitShareCount = Math.floor(toNumber(split.shareCount) || 0);
  if (splitShareCount === 2) return true;
  const inviteMaxPlayers = Math.floor(toNumber(gameDoc?.invite?.maxPlayers) || 0);
  if (inviteMaxPlayers === 2) return true;

  return [
    bookingData.roomName,
    meta.roomName,
    meta.courtName,
    meta.courtTitle,
  ].some((value) => isSinglesCourtName(value));
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};
const requestToken = () => {
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

  const refreshOwner = `split-join:${now}:${Math.random().toString(36).slice(2, 10)}`;
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
};
if (msg._legacyPaymentConfirmTrusted === true) {
  const confirmCtx = msg._legacyPaymentConfirm && typeof msg._legacyPaymentConfirm === "object"
    ? msg._legacyPaymentConfirm
    : null;
  const confirmRows = Array.isArray(msg.payload) ? msg.payload : [];
  const confirmGame = confirmRows[0] && typeof confirmRows[0] === "object" ? confirmRows[0] : null;
  if (!confirmCtx || !confirmGame || toStr(confirmGame.id) !== toStr(confirmCtx.gameId)) {
    return fail(404, "Game not found", { code: "LEGACY_PAYMENT_GAME_NOT_FOUND" });
  }
  const confirmMetadata = confirmGame.metadata && typeof confirmGame.metadata === "object"
    ? confirmGame.metadata
    : {};
  const confirmSplitPayment = confirmMetadata.splitPayment && typeof confirmMetadata.splitPayment === "object"
    ? confirmMetadata.splitPayment
    : {};
  const confirmBooking = confirmGame.booking && typeof confirmGame.booking === "object"
    ? confirmGame.booking
    : {};
  const expectedExerciseId =
    toStr(confirmSplitPayment.vivaExerciseId)
    || toStr(confirmSplitPayment.exerciseId)
    || toStr(confirmBooking.vivaExerciseId)
    || toStr(confirmBooking.exerciseId)
    || toStr(confirmMetadata.vivaExerciseId)
    || toStr(confirmMetadata.exerciseId);
  if (!expectedExerciseId) {
    return fail(409, "Game has no verified Viva exercise", {
      code: "LEGACY_PAYMENT_EXERCISE_MISSING",
    });
  }
  const expectedSubscriptionVisitCount = resolveSubscriptionVisitCount(resolveDurationMinutes(
    confirmBooking.timeFrom,
    confirmBooking.timeTo,
    confirmBooking.durationMinutes,
  ));
  confirmCtx.expectedExerciseId = expectedExerciseId;
  confirmCtx.expectedSubscriptionVisitCount = expectedSubscriptionVisitCount;
  msg._splitCtx = {
    action: "confirm_payment",
    step: "token",
    gameId: confirmCtx.gameId,
    reservationId: confirmCtx.reservationId,
    operationType: confirmCtx.operationType,
    operationId: confirmCtx.operationId,
    bookingId: confirmCtx.bookingId,
    clientId: confirmCtx.clientId,
    expectedExerciseId,
    expectedSubscriptionVisitCount,
  };
  return requestToken();
}

const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length === 0) {
  return fail(404, "Game not found");
}

const game = rows[0] && typeof rows[0] === "object" ? rows[0] : null;
if (!game) {
  return fail(404, "Game not found");
}

const body = msg._splitJoinBody && typeof msg._splitJoinBody === "object" ? msg._splitJoinBody : {};
const metadata = game.metadata && typeof game.metadata === "object" ? game.metadata : {};
const splitPayment = metadata.splitPayment && typeof metadata.splitPayment === "object" ? metadata.splitPayment : {};
const booking = game.booking && typeof game.booking === "object" ? game.booking : {};
const exerciseId =
  toStr(splitPayment.vivaExerciseId) ||
  toStr(splitPayment.viva_exercise_id) ||
  toStr(booking.vivaExerciseId) ||
  toStr(booking.exerciseId) ||
  toStr(metadata.vivaExerciseId) ||
  toStr(metadata.exerciseId) ||
  toStr(metadata.viva_exercise_id) ||
  toStr(metadata.exercise_id) ||
  toStr(splitPayment.exerciseId) ||
  toStr(splitPayment.exercise_id);
const clientPhone = normalizePhone(body.clientPhone || body.phone);
const paymentMode = resolvePaymentMode(body.paymentMode || body.payMode || body.preferredPaymentMode);
const storedStudioId = toStr(booking.studioId) || toStr(metadata.studioId);
const storedRoomId = toStr(booking.roomId) || toStr(metadata.roomId);
const storedMasterServiceId = toStr(booking.masterServiceId) || toStr(metadata.masterServiceId);
const storedSubServiceIds = normalizeIdList(
  booking.subServiceIds
  || metadata.subServiceIds,
);
const studioId = storedStudioId || (paymentMode === "subscription" ? toStr(body.studioId) : null);
const roomId = storedRoomId || (paymentMode === "subscription" ? toStr(body.roomId) : null);
const date = normalizeDate(
  booking.date
  || booking.timeFromIso
  || game.date
  || game.startAt
  || metadata.date
  || (paymentMode === "subscription" ? body.date : null)
);
const isSinglesGame = resolveIsSinglesGame({ metadata, splitPayment, booking, game });
const shareCount = Number(splitPayment.shareCount) === 2 || isSinglesGame
  ? 2
  : DEFAULT_SPLIT_SHARE_COUNT;
const durationMinutes = resolveDurationMinutes(
  booking.timeFrom,
  booking.timeTo,
  null,
);
const storedPricingPolicyPresent = paymentMode === "one_time"
  && splitPayment.pricingPolicy !== null
  && splitPayment.pricingPolicy !== undefined;
const storedPricingPolicy = storedPricingPolicyPresent
  ? resolveStoredPricingPolicy(splitPayment.pricingPolicy)
  : null;
if (storedPricingPolicyPresent && !storedPricingPolicy) {
  return fail(409, "Сохранённый тариф раздельной оплаты повреждён", {
    code: "SPLIT_PRICING_POLICY_SNAPSHOT_INVALID",
  });
}
const splitPayments = Array.isArray(splitPayment.payments)
  ? splitPayment.payments.filter((item) => item && typeof item === "object")
  : [];
const organizerPayment = splitPayments.find((item) => toStr(item.role)?.toUpperCase() === "ORGANIZER")
  || splitPayments.find((item) => Number(item.spot) === 1)
  || null;
const organizerUsedSubscription = resolvePaymentMode(
  splitPayment.selectedPaymentMode
  || splitPayment.organizerPaymentMode
  || organizerPayment?.selectedPaymentMode
  || organizerPayment?.paymentMode,
) === "subscription";
const pricingPolicyHourlyAmount = storedPricingPolicy
  ? (shareCount === 2
      ? storedPricingPolicy.twoTeamsHourlyAmount
      : storedPricingPolicy.fourPlayersHourlyAmount)
  : null;
const pricingPolicyProof = storedPricingPolicy && !organizerUsedSubscription
  ? {
      transactionId: toStr(organizerPayment?.transactionId),
      bookingId: toStr(organizerPayment?.bookingId) || toStr(splitPayment.organizerBookingId),
      clientId: toStr(organizerPayment?.clientId),
      clientPhone: normalizePhone(organizerPayment?.phone || organizerPayment?.phoneNorm),
      expectedAmountMinor: Math.max(
        0,
        Math.round(pricingPolicyHourlyAmount * durationMinutes / 60 * 100),
      ),
    }
  : null;
if (
  pricingPolicyProof
  && (!pricingPolicyProof.transactionId || !pricingPolicyProof.bookingId || !durationMinutes)
) {
  return fail(409, "Не удалось подтвердить сохранённый тариф игры", {
    code: "SPLIT_PRICING_POLICY_PROOF_MISSING",
  });
}
const subscriptionVisitCount = resolveSubscriptionVisitCount(durationMinutes);
const bodyShareAmount = toNumber(body.shareAmount);
const storedShareAmount = toNumber(splitPayment.shareAmount);
const oneTimeBaseAmount = roundMoney(
  body.oneTimeBaseAmount
  ?? splitPayment.oneTimeBaseAmount
  ?? splitPayment.baseShareAmount
  ?? body.oneTimeAmount
  ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT,
) ?? DEFAULT_ONE_TIME_PRODUCT_AMOUNT;
const totalAmount = roundMoney(
  body.totalAmount
  ?? splitPayment.totalAmount
  ?? body.gameAmount
  ?? body.courtAmount
  ?? body.courtPrice
  ?? body.slotPrice
  ?? body.amount,
);
const defaultShareAmount = roundMoney(oneTimeBaseAmount / Math.max(shareCount, 1))
  ?? (shareCount === 2 ? 5000 : 2500);
const shareAmount =
  (totalAmount !== null && totalAmount > 0
    ? roundMoney(totalAmount / Math.max(shareCount, 1))
    : null)
  ?? (
    bodyShareAmount !== null
      ? (resolveShareAmount(bodyShareAmount, durationMinutes, body.shareAmountIncludesDuration === true) ?? defaultShareAmount)
      : storedShareAmount ?? resolveShareAmount(defaultShareAmount, durationMinutes, false) ?? defaultShareAmount
  );
const maxClientsLimit = shareCount === 2 ? 2 : 4;
const maxClientsCount = Math.max(1, Math.min(maxClientsLimit, Math.floor(toNumber(body.maxClientsCount) ?? shareCount)));
const spotRaw = toNumber(body.spot);
const spot = spotRaw === null ? null : Math.max(1, Math.min(maxClientsLimit, Math.floor(spotRaw)));
const paymentRef = toStr(body.paymentRef) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const clientSubscriptionId = toStr(body.clientSubscriptionId);
if (paymentMode === "subscription" && !clientSubscriptionId) {
  return fail(400, "clientSubscriptionId is required for subscription payment", {
    code: "SUBSCRIPTION_SELECTION_REQUIRED",
  });
}
const transactionPaymentMethod = toStr(body.transactionPaymentMethod || body.paymentMethod);
const vivaDirectionId = resolvePositiveInt(
  body.vivaDirectionId
  ?? body.directionId
  ?? splitPayment.directionId
  ?? splitPayment.vivaDirectionId
  ?? metadata.directionId
  ?? metadata.vivaDirectionId,
  DEFAULT_OPEN_GAME_DIRECTION_ID,
);
const vivaExerciseTypeId = resolvePositiveInt(
  body.vivaExerciseTypeId
  ?? body.exerciseTypeId
  ?? splitPayment.exerciseTypeId
  ?? splitPayment.vivaExerciseTypeId
  ?? metadata.exerciseTypeId
  ?? metadata.vivaExerciseTypeId,
  DEFAULT_OPEN_GAME_EXERCISE_TYPE_ID,
);
const paymentDeadlineMinutes = Math.max(
  1,
  Math.min(180, Math.floor(toNumber(body.paymentDeadlineMinutes) ?? DEFAULT_PAYMENT_DEADLINE_MINUTES)),
);
const fallbackDeadlineAt = new Date(Date.now() + paymentDeadlineMinutes * 60 * 1000).toISOString();
const startAtIso = toStr(booking.timeFromIso)
  || (booking.date && booking.timeFrom ? `${booking.date}T${booking.timeFrom}:00+03:00` : null);
const startAtTs = startAtIso ? Date.parse(startAtIso) : null;
const assembleDeadlineAt = Number.isFinite(startAtTs)
  ? new Date(startAtTs - 24 * 60 * 60 * 1000).toISOString()
  : null;

if (!exerciseId || !clientPhone || !studioId) {
  return fail(400, "exerciseId, studioId and clientPhone are required");
}
if (paymentMode === "one_time" && (!roomId || !date)) {
  return fail(400, "Stored split game location is incomplete", {
    code: "SPLIT_GAME_LOCATION_INCOMPLETE",
  });
}

msg._splitCtx = {
  action: "join",
  step: "token",
  paymentRef,
  date,
  fromTime: toStr(booking.timeFrom),
  toTime: toStr(booking.timeTo),
  exerciseId,
  studioId,
  roomId,
  masterServiceId: storedMasterServiceId,
  subServiceIds: storedSubServiceIds,
  userAuthHeader: readUserAuthHeader(),
  pricingPolicy: storedPricingPolicy,
  expectedPricingPolicy: organizerUsedSubscription && storedPricingPolicy
    ? storedPricingPolicy
    : null,
  pricingPolicyProof,
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
  deadlineAt:
    toStr(body.deadlineAt)
    || toStr(splitPayment.participantDeadlineAt)
    || toStr(splitPayment.participantPaymentDeadlineAt)
    || fallbackDeadlineAt,
  assembleDeadlineAt: toStr(splitPayment.assembleDeadlineAt) || assembleDeadlineAt,
};

// Subscription organizers have no paid organizer transaction that can prove a
// one-time tariff. Re-resolve the campaign from the exact stored game location
// instead. This also repairs legacy subscription-created games that missed the
// policy snapshot entirely.
if (organizerUsedSubscription) {
  return startPricingPolicyRequest(msg._splitCtx);
}

return requestToken();

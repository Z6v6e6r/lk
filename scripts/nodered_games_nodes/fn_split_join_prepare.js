const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const DEFAULT_OPEN_GAME_DIRECTION_ID = 4588;
const DEFAULT_OPEN_GAME_EXERCISE_TYPE_ID = 1613;
const DEFAULT_SPLIT_SHARE_COUNT = 4;
const DEFAULT_PAYMENT_DEADLINE_MINUTES = 25;
const DEFAULT_ONE_TIME_PRODUCT_AMOUNT = 10000;

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

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
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

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

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
  toStr(booking.vivaExerciseId) ||
  toStr(booking.exerciseId);
const clientPhone = normalizePhone(body.clientPhone || body.phone);
const studioId = toStr(body.studioId) || toStr(booking.studioId);
const shareCount = Number(body.shareCount) === 2 || Number(splitPayment.shareCount) === 2
  ? 2
  : DEFAULT_SPLIT_SHARE_COUNT;
const durationMinutes = resolveDurationMinutes(booking.timeFrom, booking.timeTo, body.durationMinutes || booking.durationMinutes);
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
const maxClientsCount = Math.max(1, Math.min(4, Math.floor(toNumber(body.maxClientsCount) ?? shareCount)));
const spotRaw = toNumber(body.spot);
const spot = spotRaw === null ? null : Math.max(1, Math.min(4, Math.floor(spotRaw)));
const paymentRef = toStr(body.paymentRef) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const paymentMode = resolvePaymentMode(body.paymentMode || body.payMode || body.preferredPaymentMode);
const transactionPaymentMethod = toStr(body.transactionPaymentMethod || body.paymentMethod);
const vivaDirectionId = DEFAULT_OPEN_GAME_DIRECTION_ID;
const vivaExerciseTypeId = DEFAULT_OPEN_GAME_EXERCISE_TYPE_ID;
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

msg._splitCtx = {
  action: "join",
  step: "token",
  paymentRef,
  exerciseId,
  studioId,
  clientId: toStr(body.clientId),
  clientPhone,
  shareCount,
  shareAmount,
  totalAmount,
  oneTimeBaseAmount,
  durationMinutes,
  maxClientsCount,
  spot,
  vivaDirectionId,
  vivaExerciseTypeId,
  paymentMode,
  transactionPaymentMethod,
  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),
  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),
  deadlineAt: toStr(splitPayment.deadlineAt) || fallbackDeadlineAt,
  assembleDeadlineAt: toStr(splitPayment.assembleDeadlineAt) || assembleDeadlineAt,
};

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

return [msg, null, msg];

const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";

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
const shareCount = Number(body.shareCount) === 2 || Number(splitPayment.shareCount) === 2 ? 2 : 4;
const shareAmount = toNumber(body.shareAmount) ?? toNumber(splitPayment.shareAmount) ?? (shareCount === 2 ? 500 : 250);
const maxClientsCount = Math.max(1, Math.min(4, Math.floor(toNumber(body.maxClientsCount) ?? shareCount)));
const spotRaw = toNumber(body.spot);
const spot = spotRaw === null ? null : Math.max(1, Math.min(4, Math.floor(spotRaw)));
const paymentRef = toStr(body.paymentRef) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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
  maxClientsCount,
  spot,
  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),
  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),
  deadlineAt: toStr(splitPayment.deadlineAt) || new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
};

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

return [msg, null, msg];

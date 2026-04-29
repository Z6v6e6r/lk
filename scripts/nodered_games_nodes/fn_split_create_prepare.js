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
const activeTo = normalizeDate(body.activeTo || body.dateTo);

if (!date || !fromTime || !toTime || !roomId || !clientPhone) {
  return fail(400, "date, fromTime, toTime, roomId and clientPhone are required");
}
if (activeTo && date > activeTo) {
  return fail(409, "Split promo is not active for selected date", {
    date,
    activeTo,
  });
}

const shareCount = Number(body.shareCount) === 2 ? 2 : 4;
const shareAmount = toNumber(body.shareAmount) ?? (shareCount === 2 ? 500 : 250);
const maxClientsCount = Math.max(1, Math.min(4, Math.floor(toNumber(body.maxClientsCount) ?? shareCount)));
const spot = Math.max(1, Math.min(4, Math.floor(toNumber(body.spot) ?? 1)));
const paymentRef = toStr(body.paymentRef) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const vivaDirectionId = Math.max(1, Math.floor(toNumber(body.vivaDirectionId || body.directionId) ?? 4485));
const vivaExerciseTypeId = Math.max(1, Math.floor(toNumber(body.vivaExerciseTypeId || body.exerciseTypeId) ?? 1208));

msg._splitCtx = {
  action: "create",
  step: "token",
  paymentRef,
  date,
  activeTo,
  fromTime,
  toTime,
  timeFrom: `${date}T${fromTime}:00+03:00`,
  timeTo: `${date}T${toTime}:00+03:00`,
  studioId: toStr(body.studioId),
  roomId,
  clientId: toStr(body.clientId),
  clientPhone,
  shareCount,
  shareAmount,
  maxClientsCount,
  spot,
  vivaDirectionId,
  vivaExerciseTypeId,
  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),
  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),
  deadlineAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
};

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

return [msg, null, msg];

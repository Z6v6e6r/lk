const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const envValue = (key) => {
  try {
    return toStr(env.get(key));
  } catch {
    return null;
  }
};
const enabled = ["1", "true", "yes", "on"].includes(
  String(envValue("PADLHUB_LEGACY_ROSTER_BRIDGE_ENABLED") || "").toLowerCase(),
);
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { code, error };
  return [null, msg];
};

if (!enabled) {
  return respond(503, "LEGACY_GAME_BRIDGE_DISABLED", "Каноническое подтверждение оплаты отключено");
}
const gameId = toStr(msg.req?.params?.gameId);
if (!gameId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(gameId)) {
  return respond(400, "LEGACY_GAME_ID_INVALID", "Некорректный идентификатор игры");
}
const authorization = toStr(msg.req?.headers?.authorization);
if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
  return respond(401, "LEGACY_AUTH_REQUIRED", "Требуется авторизация");
}
const idempotencyKey = toStr(msg.req?.headers?.["idempotency-key"]);
if (
  !idempotencyKey
  || idempotencyKey.length < 16
  || idempotencyKey.length > 128
  || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
) {
  return respond(400, "IDEMPOTENCY_KEY_INVALID", "Некорректный Idempotency-Key");
}
const body = isObj(msg.payload) ? msg.payload : null;
const allowedKeys = new Set(["reservationId", "operationType", "operationId", "bookingId", "clientId"]);
if (!body || Object.keys(body).some((key) => !allowedKeys.has(key))) {
  return respond(400, "LEGACY_PAYMENT_CONFIRM_INVALID", "Некорректные данные подтверждения оплаты");
}
const reservationId = toStr(body.reservationId);
const operationType = toStr(body.operationType)?.toUpperCase();
const operationId = toStr(body.operationId);
const bookingId = toStr(body.bookingId);
const clientId = toStr(body.clientId);
const safeProviderId = (value) => Boolean(value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value));
if (
  !reservationId
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)
  || !["TRANSACTION", "SUBSCRIPTION_BOOKING"].includes(operationType || "")
  || !safeProviderId(operationId)
  || !safeProviderId(bookingId)
  || (operationType === "SUBSCRIPTION_BOOKING" && !safeProviderId(clientId))
) {
  return respond(400, "LEGACY_PAYMENT_CONFIRM_INVALID", "Некорректные данные подтверждения оплаты");
}

msg._legacyPaymentConfirm = {
  gameId,
  reservationId,
  operationType,
  operationId,
  bookingId,
  clientId,
  authorization,
  idempotencyKey,
};
msg._legacyPaymentConfirmTrusted = true;
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null];

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const respond = (statusCode, state, message) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { ok: false, state, message };
  return [null, msg, null];
};

const auth = isObj(msg._splitCleanupAuth) ? msg._splitCleanupAuth : null;
if (!auth || auth.verified !== true || (!toStr(auth.actorClientId) && !normalizePhone(auth.actorPhoneNorm))) {
  return respond(401, "UNAUTHORIZED", "Не удалось подтвердить авторизованного клиента");
}

const body = isObj(msg.payload) ? msg.payload : {};
const forbiddenFields = ["exerciseId", "gameId"];
if (forbiddenFields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
  return respond(
    400,
    "CONFLICT",
    "Идентификаторы участника и записи определяются сервером",
  );
}

const gameId = toStr(msg.req?.params?.gameId);
if (!gameId) return respond(400, "CONFLICT", "gameId is required");

const actorClientId = toStr(auth.actorClientId);
const actorPhoneNorm = normalizePhone(auth.actorPhoneNorm);
const legacyBookingIds = [
  ...(Array.isArray(body.bookingIds) ? body.bookingIds : []),
  ...(Array.isArray(body.bookingItems) ? body.bookingItems.map((item) => item?.bookingId) : []),
  body.bookingId,
].map(toStr).filter(Boolean);
const mode = legacyBookingIds.length > 0 ? "ORGANIZER_TARGET" : "SELF";
const requestedRefundMethodRaw = toStr(body.refundMethod)?.toUpperCase() || null;
const allowedRefundMethods = new Set(["CURRENCY", "DEPOSIT", "SERVICE", "NONE"]);
if (requestedRefundMethodRaw && !allowedRefundMethods.has(requestedRefundMethodRaw)) {
  return respond(400, "CONFLICT", "refundMethod имеет неверное значение");
}
const suppliedOperationId = mode === "ORGANIZER_TARGET" ? toStr(body.operationId) : null;
if (suppliedOperationId && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedOperationId)) {
  return respond(400, "CONFLICT", "operationId имеет неверный формат");
}
const identityKey = actorClientId || actorPhoneNorm;
const operationId = mode === "SELF"
  ? `self-leave:${gameId}:${identityKey}`
  : (suppliedOperationId || `organizer-leave:${gameId}:${Array.from(new Set(legacyBookingIds)).sort().join(",")}`);
const claimToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;

msg._splitLeaveCtx = {
  gameId,
  operationId,
  claimToken,
  reason: toStr(body.reason) || "PLAYER_LEFT",
  requestedRefundMethod: requestedRefundMethodRaw,
  actorClientId,
  actorPhoneNorm,
  actorAuthHeader: toStr(auth.authHeader),
  mode,
  legacyRequestedBookingIds: Array.from(new Set(legacyBookingIds)),
  legacyRequestedClientId: toStr(body.clientId || body.playerId || body.userId),
  legacyRequestedPhone: normalizePhone(body.playerPhone || body.phone || body.clientPhone),
  bookingQueue: [],
  initialBookingIds: [],
  bookingResults: [],
  trace: [],
  step: "authorize_leave",
};
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null, null];

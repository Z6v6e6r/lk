const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const normalizeId = (value) => {
  const normalized = toStr(value);
  return normalized ? normalized.toLowerCase() : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { ok: false, code, error };
  delete msg._splitCleanupAuth;
  delete msg._splitLeaveCtx;
  return [null, msg, null];
};

const addBookingTarget = (targets, bookingIdRaw, clientIdRaw) => {
  const bookingId = toStr(bookingIdRaw);
  if (!bookingId) return;
  const key = normalizeId(bookingId);
  const clientId = toStr(clientIdRaw);
  const existing = targets.get(key);
  if (existing) {
    if (!existing.clientId && clientId) existing.clientId = clientId;
    return;
  }
  targets.set(key, { bookingId, clientId: clientId || null });
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
if (!ctx || ctx.step !== "authorize_leave") {
  return respond(
    500,
    "SPLIT_LEAVE_CONTEXT_MISSING",
    "Не удалось проверить удаление игрока",
  );
}

const rows = asArray(msg.payload).filter(isObj);
const game = rows.find((item) => toStr(item.id) === toStr(ctx.gameId)) || null;
if (!game) {
  return respond(404, "SPLIT_LEAVE_GAME_NOT_FOUND", "Игра не найдена");
}

const actorClientId = normalizeId(ctx.actorClientId);
const actorPhoneNorm = normalizePhone(ctx.actorPhoneNorm);
const organizerIds = [
  game.organizer?.id,
  game.organizer?.clientId,
  game.metadata?.organizerId,
]
  .map(normalizeId)
  .filter(Boolean);
const organizerPhones = [
  game.organizer?.phoneNorm,
  game.organizer?.phone,
  game.metadata?.organizerPhoneNorm,
  game.metadata?.organizerPhone,
]
  .map(normalizePhone)
  .filter(Boolean);
const actorIsOrganizer = Boolean(
  (actorClientId && organizerIds.includes(actorClientId))
  || (actorPhoneNorm && organizerPhones.includes(actorPhoneNorm)),
);
if (!actorIsOrganizer) {
  return respond(
    403,
    "SPLIT_LEAVE_ORGANIZER_REQUIRED",
    "Удалить игрока может только организатор игры",
  );
}

const metadata = isObj(game.metadata) ? game.metadata : {};
const splitPayment = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
const booking = isObj(game.booking) ? game.booking : {};
const targets = new Map();

asArray(booking.bookingIds).forEach((bookingId) => addBookingTarget(targets, bookingId, null));
addBookingTarget(targets, booking.bookingId, null);
asArray(metadata.bookingIds).forEach((bookingId) => addBookingTarget(targets, bookingId, null));
addBookingTarget(targets, metadata.bookingId, null);
asArray(splitPayment.bookingIds).forEach((bookingId) => addBookingTarget(targets, bookingId, null));
addBookingTarget(targets, splitPayment.bookingId, null);
addBookingTarget(targets, splitPayment.organizerBookingId, game.organizer?.id);
asArray(splitPayment.bookingTargets).forEach((item) => {
  if (!isObj(item)) return;
  addBookingTarget(
    targets,
    item.bookingId || item.id || item.uuid,
    item.clientId || item.playerId || item.userId,
  );
});
asArray(splitPayment.payments).forEach((item) => {
  if (!isObj(item)) return;
  const clientId = item.clientId || item.playerId || item.userId;
  asArray(item.bookingIds).forEach((bookingId) => (
    addBookingTarget(targets, bookingId, clientId)
  ));
  addBookingTarget(targets, item.bookingId, clientId);
});

const requestedQueue = asArray(ctx.bookingQueue).filter(isObj);
const verifiedQueue = [];
for (const requested of requestedQueue) {
  const bookingId = toStr(requested.bookingId);
  const linked = targets.get(normalizeId(bookingId));
  if (!bookingId || !linked) {
    return respond(
      403,
      "SPLIT_LEAVE_BOOKING_NOT_LINKED",
      "Запись игрока не связана с этой игрой",
    );
  }
  const requestedClientId = normalizeId(requested.clientId || ctx.clientId || ctx.playerId);
  const linkedClientId = normalizeId(linked.clientId);
  if (requestedClientId && linkedClientId && requestedClientId !== linkedClientId) {
    return respond(
      403,
      "SPLIT_LEAVE_CLIENT_MISMATCH",
      "Клиент записи не совпадает с участником игры",
    );
  }
  verifiedQueue.push({
    bookingId: linked.bookingId,
    clientId: linked.clientId || toStr(requested.clientId || ctx.clientId || ctx.playerId),
  });
}

const authoritativeExerciseId = toStr(
  splitPayment.vivaExerciseId
  || booking.vivaExerciseId
  || booking.exerciseId
  || metadata.vivaExerciseId
  || metadata.exerciseId,
);
if (
  ctx.exerciseId
  && authoritativeExerciseId
  && normalizeId(ctx.exerciseId) !== normalizeId(authoritativeExerciseId)
) {
  return respond(
    403,
    "SPLIT_LEAVE_EXERCISE_MISMATCH",
    "Занятие Viva не совпадает с игрой",
  );
}

ctx.bookingQueue = verifiedQueue;
ctx.initialBookingIds = verifiedQueue.map((item) => item.bookingId);
ctx.exerciseId = authoritativeExerciseId || toStr(ctx.exerciseId);
ctx.step = "token_request";
msg._splitLeaveCtx = ctx;
msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

return [msg, null, null];

const context = msg.padelDay || {};
const exercise = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
const dateOf = (value) => String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
const invalid = Number(msg.statusCode || 0) >= 400
  || !exercise
  || String(exercise.id || "") !== context.exerciseId
  || Number(exercise.direction?.id) !== 5245
  || Number(exercise.type?.id) !== 1279
  || dateOf(exercise.timeFrom) !== context.eventDate
  || exercise.isCancelled === true
  || exercise.cancelled === true
  || exercise.archived === true;

if (invalid) {
  msg.statusCode = 409;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = { ok: false, code: "PADEL_DAY_SLOT_UNAVAILABLE", message: "Эта запись не относится к активному расписанию Padel Day" };
  return [null, msg];
}

const clientsCount = Math.max(0, Number(exercise.clientsCount || 0));
const maxClientsCount = Math.max(0, Number(exercise.maxClientsCount || 0));
if (maxClientsCount > 0 && clientsCount >= maxClientsCount) {
  msg.statusCode = 409;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = { ok: false, code: "PADEL_DAY_SLOT_FULL", message: "В этой записи больше нет свободных мест" };
  return [null, msg];
}

const now = new Date();
const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
const lockId = `iSkq6G:direction-5245:${context.clientId}`;
const guardId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${context.clientId.slice(0, 8)}`;
msg.padelDay = { ...context, lockId, guardId, expiresAt: expiresAt.toISOString() };
msg.query = {
  _id: lockId,
  $or: [
    { expiresAt: { $lte: now } },
    { status: { $in: ["RELEASED", "FAILED", "EXPIRED"] } },
    { idempotencyKey: context.idempotencyKey },
  ],
};
msg.payload = {
  $set: {
    guardId,
    tenantKey: "iSkq6G",
    eventDate: context.eventDate,
    clientId: context.clientId,
    exerciseId: context.exerciseId,
    idempotencyKey: context.idempotencyKey,
    status: "LOCKED",
    updatedAt: now,
    expiresAt,
  },
  $setOnInsert: { createdAt: now },
};
return [msg, null];

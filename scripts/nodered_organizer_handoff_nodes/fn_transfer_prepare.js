const auth = msg._splitCleanupAuth;
const body = msg.payload;
const fail = (statusCode, message) => { msg.statusCode = statusCode; msg.payload = { ok: false, message }; return [null, msg]; };
if (!auth?.verified || !auth.actorClientId) return fail(401, "Не удалось подтвердить профиль");
if (!body || typeof body !== "object" || typeof body.successorId !== "string"
  || !body.successorId.trim() || typeof body.expectedUpdatedAt !== "string"
  || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) return fail(400, "Обновите игру и выберите нового организатора");
const gameId = String(msg.req?.params?.gameId || "").trim();
if (!gameId) return fail(400, "Не указана игра");
msg._organizerTransfer = { gameId, actorId: String(auth.actorClientId).trim().toLowerCase(),
  successorId: body.successorId.trim().toLowerCase(), expectedUpdatedAt: body.expectedUpdatedAt };
delete msg._splitCleanupAuth;
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null];

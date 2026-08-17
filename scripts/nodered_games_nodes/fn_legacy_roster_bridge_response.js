const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const respond = (statusCode, code, error, raw = null) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { code, error, ...(raw ? { details: raw } : {}) };
  return [null, msg];
};

let payload = msg.payload;
if (typeof payload === "string") {
  try {
    payload = JSON.parse(payload);
  } catch {
    payload = null;
  }
}
const statusCode = Number(msg.statusCode);
if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
  const safePayload = isObj(payload) ? payload : {};
  return respond(
    Number.isInteger(statusCode) && statusCode >= 400 ? statusCode : 503,
    toStr(safePayload.code) || "LEGACY_GAME_BRIDGE_UPSTREAM_FAILED",
    toStr(safePayload.message || safePayload.error) || "Каноническая запись временно недоступна",
  );
}

const projection = isObj(payload?.projection) ? payload.projection : null;
const player = isObj(projection?.player) ? projection.player : null;
const commandId = toStr(payload?.commandId);
const legacyGameId = toStr(projection?.legacyGameId);
const canonicalGameId = toStr(projection?.canonicalGameId);
const relation = toStr(projection?.relation)?.toUpperCase();
const aggregateRevision = Number(projection?.aggregateRevision);
const reservationId = toStr(projection?.reservationId);
const userId = toStr(player?.userId);
const displayName = toStr(player?.displayName);
const phoneE164 = toStr(player?.phoneE164);
const levelLabel = toStr(player?.levelLabel);
const levelValue = player?.levelValue === null || player?.levelValue === undefined
  ? null
  : Number(player.levelValue);
const ctx = isObj(msg._legacyRosterBridge) ? msg._legacyRosterBridge : null;
if (
  !ctx
  || !commandId
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId)
  || legacyGameId !== ctx.gameId
  || !canonicalGameId
  || !["SEAT_RESERVED", "PARTICIPANT", "WAITLISTED"].includes(relation || "")
  || !Number.isSafeInteger(aggregateRevision)
  || aggregateRevision < 1
  || !userId
  || !displayName
  || ((relation === "SEAT_RESERVED" || ctx.command === "CONFIRM_PAYMENT")
    && (!reservationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)))
  || (ctx.command === "CONFIRM_PAYMENT" && reservationId !== ctx.reservationId)
  || (phoneE164 && !/^\+[1-9][0-9]{7,14}$/.test(phoneE164))
  || (levelValue !== null && (!Number.isFinite(levelValue) || levelValue < 0 || levelValue > 10))
) {
  return respond(503, "LEGACY_GAME_BRIDGE_RESPONSE_INVALID", "Канонический сервис вернул некорректный ответ");
}

msg._legacyRosterProjection = {
  commandId,
  replayed: payload.replayed === true,
  legacyGameId,
  canonicalGameId,
  aggregateRevision,
  relation,
  reservationId,
  player: { userId, displayName, phoneE164, levelLabel, levelValue },
};
msg.payload = { id: legacyGameId, archived: { $ne: true } };
delete msg.statusCode;
return [msg, null];

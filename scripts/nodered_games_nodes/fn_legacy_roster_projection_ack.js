const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const ctx = isObj(msg._legacyRosterBridge) ? msg._legacyRosterBridge : null;
const write = isObj(msg._legacyRosterProjectionWrite) ? msg._legacyRosterProjectionWrite : null;
const fail = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  msg.payload = { code, error };
  return msg;
};
if (!ctx || !write) {
  const error = fail(503, "LEGACY_ROSTER_PROJECTION_CONTEXT_INVALID", "Не удалось подтвердить проекцию состава");
  return [null, null, error, null];
}
if (msg.error) {
  const error = fail(503, "LEGACY_ROSTER_PROJECTION_WRITE_FAILED", "Не удалось сохранить проекцию состава");
  return [null, null, error, null];
}
const result = Array.isArray(msg.payload) ? msg.payload.find(isObj) : msg.payload;
const matchedCount = Number(result?.matchedCount ?? result?.n ?? result?.modifiedCount);
if (!isObj(result) || result.acknowledged === false || !Number.isFinite(matchedCount)) {
  const error = fail(503, "LEGACY_ROSTER_PROJECTION_UNACKNOWLEDGED", "Хранилище не подтвердило проекцию состава");
  return [null, null, error, null];
}
if (matchedCount < 1) {
  const retryCount = Number(ctx.retryCount || 0) + 1;
  if (retryCount > 3) {
    const error = fail(409, "LEGACY_ROSTER_PROJECTION_CONFLICT", "Состав игры изменился. Повторите действие");
    return [null, null, error, null];
  }
  msg._legacyRosterBridge = { ...ctx, retryCount };
  msg.payload = { id: ctx.gameId, archived: { $ne: true } };
  delete msg.statusCode;
  delete msg.error;
  return [null, msg, null, null];
}
const success = write.response;
const autojoin = {
  ...msg,
  statusCode: undefined,
  payload: { id: ctx.gameId, archived: { $ne: true } },
  _gameAutojoinPatch: {
    gameId: ctx.gameId,
    patch: {
      updatedAt: write.nextUpdatedAt,
      ...(Number.isInteger(write.nextRevision) ? { revision: write.nextRevision } : {}),
    },
    source: "canonical_roster_bridge",
  },
};
delete autojoin.error;
return [success, null, null, autojoin];

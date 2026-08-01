const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const ctx = isObj(msg._gamePatchCas) ? msg._gamePatchCas : null;
if (!ctx?.required) return [null, null, null];

const response = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = error
    ? { error, code, id: ctx.gameId || null }
    : {
      id: ctx.gameId || null,
      updatedAt: ctx.nextUpdatedAt || null,
      ...(Number.isInteger(ctx.nextRevision) ? { revision: ctx.nextRevision } : {}),
    };
  delete msg._gamePatchCas;
  return msg;
};

if (msg.error) {
  const failed = response(503, "GAME_PATCH_WRITE_FAILED", "Не удалось сохранить изменения игры");
  return [failed, failed, null];
}

const result = Array.isArray(msg.payload)
  ? msg.payload.find((item) => isObj(item))
  : msg.payload;
if (!isObj(result) || result.acknowledged === false) {
  const failed = response(503, "GAME_PATCH_WRITE_UNACKNOWLEDGED", "Хранилище не подтвердило изменения игры");
  return [failed, failed, null];
}

const matchedRaw = result.matchedCount ?? result.n ?? result.modifiedCount;
const matchedCount = Number(matchedRaw);
if (!Number.isFinite(matchedCount)) {
  const failed = response(503, "GAME_PATCH_WRITE_UNACKNOWLEDGED", "Хранилище не вернуло результат изменения игры");
  return [failed, failed, null];
}
if (matchedCount < 1) {
  const conflict = response(409, "GAME_PATCH_VERSION_CONFLICT", "Игра уже изменилась. Обновите данные и повторите действие");
  return [conflict, conflict, null];
}

const gameId = ctx.gameId || null;
const nextUpdatedAt = ctx.nextUpdatedAt || null;
const nextRevision = Number.isInteger(ctx.nextRevision) ? ctx.nextRevision : null;
const success = response(200, null, null);
const autojoin = {
  ...msg,
  statusCode: undefined,
  _gameAutojoinPatch: {
    gameId,
    patch: {
      updatedAt: nextUpdatedAt,
      ...(nextRevision !== null ? { revision: nextRevision } : {}),
    },
    source: "games_patch_cas",
  },
  payload: { id: gameId, archived: { $ne: true } },
};
delete autojoin.error;
return [success, success, autojoin];

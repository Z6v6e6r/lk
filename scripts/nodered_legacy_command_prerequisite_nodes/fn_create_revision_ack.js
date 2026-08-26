const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? raw?.result?.modifiedCount ?? raw?.payload?.modifiedCount ?? 0);
const upsertedCount = Number(raw?.upsertedCount ?? raw?.result?.upsertedCount ?? raw?.payload?.upsertedCount ?? 0);
const upsertedId = raw?.upsertedId ?? raw?.result?.upsertedId ?? raw?.payload?.upsertedId ?? null;
const acknowledged = raw?.acknowledged !== false;
const hasMongoError = Boolean(msg.error) || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const persisted = acknowledged && !hasMongoError
  && (matchedCount === 1 || modifiedCount === 1 || upsertedCount === 1 || Boolean(upsertedId));

if (!persisted || !msg._recordForResponse) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: hasMongoError ? 503 : 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: hasMongoError ? "Game write failed" : "Legacy game revision changed",
      code: hasMongoError ? "LEGACY_GAME_WRITE_FAILED" : "LEGACY_GAME_VERSION_CONFLICT",
      retryable: true,
      gameId: msg._recordForResponse?.id || null,
    },
  });
  return [errorMsg, errorMsg, null];
}

const responseMsg = Object.assign({}, msg, {
  statusCode: msg._httpStatus || 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: msg._recordForResponse,
});
const debugMsg = Object.assign({}, msg, {
  payload: msg._createRevisionDebug || {
    action: "legacy_game_revision_write_acknowledged",
    gameId: msg._recordForResponse.id,
    revision: msg._recordForResponse.revision,
  },
});
const autojoinMsg = Object.assign({}, msg, {
  _requestMode: msg._requestMode,
  _gameAutojoinSource: "games_create",
  payload: msg._recordForResponse,
});
return [responseMsg, debugMsg, autojoinMsg];

const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? raw?.result?.modifiedCount ?? raw?.payload?.modifiedCount ?? 0);
const acknowledged = raw?.acknowledged !== false;
const hasMongoError = Boolean(msg.error) || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const casOk = acknowledged && !hasMongoError && (matchedCount === 1 || modifiedCount === 1);
const deferred = msg._resultConfirmRevisionDeferred;
if (!casOk || !deferred) {
  const responseMsg = Object.assign({}, msg, {
    statusCode: hasMongoError ? 503 : 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: hasMongoError
        ? "Legacy game result projection failed"
        : "Legacy game changed before result side effects could be released",
      code: hasMongoError ? "LEGACY_GAME_WRITE_FAILED" : "LEGACY_GAME_VERSION_CONFLICT",
      retryable: true,
      gameId: msg._legacyGameRevisionCas?.gameId || null,
    },
  });
  return [null, responseMsg, responseMsg];
}
const dispatchMsg = Object.assign({}, msg, { _resultConfirmOutbox: deferred.outbox });
const acceptedMsg = Object.assign({}, deferred.responseMsg || msg, {
  statusCode: 202,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  payload: {
    status: "SIDE_EFFECTS_PROCESSING",
    code: "RESULT_SIDE_EFFECTS_ACCEPTED",
    recoveryRequired: false,
    bundleId: deferred.outbox?.bundleId || null,
    resultId: deferred.outbox?.resultId || null,
    resultRevision: deferred.outbox?.resultRevision || null,
  },
});
return [dispatchMsg, acceptedMsg, acceptedMsg];

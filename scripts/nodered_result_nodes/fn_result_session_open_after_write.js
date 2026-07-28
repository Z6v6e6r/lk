const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? raw?.result?.modifiedCount ?? raw?.payload?.modifiedCount ?? 0);
const upsertedCount = Number(raw?.upsertedCount ?? raw?.result?.upsertedCount ?? raw?.payload?.upsertedCount ?? 0);
const acknowledged = raw?.acknowledged !== false;
const hasMongoError = Boolean(msg.error)
  || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const persisted = acknowledged
  && !hasMongoError
  && (matchedCount > 0 || modifiedCount > 0 || upsertedCount > 0);
const responsePayload = msg._resultSessionResponse && typeof msg._resultSessionResponse === "object"
  ? msg._resultSessionResponse
  : null;

if (!persisted || !responsePayload) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result session was not opened because its draft was not saved.",
      code: "RESULT_SESSION_OPEN_PERSISTENCE_FAILED",
      retryable: true,
      sessionId: responsePayload?.sessionId || null,
    },
  });
  return [errorMsg, errorMsg];
}

const responseMsg = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: responsePayload,
});
return [responseMsg, null];

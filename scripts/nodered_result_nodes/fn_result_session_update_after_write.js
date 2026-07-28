const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const acknowledged = raw?.acknowledged !== false;
const hasMongoError = Boolean(msg.error)
  || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const responsePayload = msg._resultSessionResponse && typeof msg._resultSessionResponse === "object"
  ? msg._resultSessionResponse
  : null;

if (!acknowledged || hasMongoError) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result draft was not saved. Retry after refreshing the session.",
      code: "RESULT_SESSION_PERSISTENCE_FAILED",
      retryable: true,
      sessionId: responsePayload?.sessionId || null,
    },
  });
  return [errorMsg, errorMsg];
}

if (matchedCount < 1) {
  const conflictMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result session revision conflict",
      code: "RESULT_SESSION_REVISION_CONFLICT",
      sessionId: responsePayload?.sessionId || null,
      expectedRevision: Number.isInteger(Number(msg._resultSessionExpectedRevision))
        ? Number(msg._resultSessionExpectedRevision)
        : null,
      refreshRequired: true,
    },
  });
  return [conflictMsg, conflictMsg];
}

if (!responsePayload) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result session response is unavailable",
      code: "RESULT_SESSION_RESPONSE_MISSING",
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

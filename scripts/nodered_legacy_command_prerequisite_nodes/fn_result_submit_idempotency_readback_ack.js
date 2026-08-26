const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const expected = msg._resultSubmitDoc && typeof msg._resultSubmitDoc === "object"
  ? msg._resultSubmitDoc
  : null;
const stored = msg._resultSubmitStoredDoc && typeof msg._resultSubmitStoredDoc === "object"
  ? msg._resultSubmitStoredDoc
  : null;
const operationError = msg._legacyCommandOperationError;

if (operationError || !expected || !stored) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: operationError?.code === "RESULT_IDEMPOTENCY_CONFLICT" ? 409 : 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: {
      error: operationError?.message || "Result idempotency read-back failed",
      code: operationError?.code || "RESULT_IDEMPOTENCY_READBACK_FAILED",
      retryable: operationError?.code !== "RESULT_IDEMPOTENCY_CONFLICT",
    },
  });
  return [null, errorMsg, errorMsg];
}

const exactMatch = toStr(stored.tenantKey) === toStr(expected.tenantKey)
  && toStr(stored.id) === toStr(expected.id)
  && toStr(stored._id) === toStr(expected.id)
  && toStr(stored.gameId) === toStr(expected.gameId)
  && toStr(stored.idempotencyKey) === toStr(expected.idempotencyKey)
  && String(stored.resultSignature || "") === String(expected.resultSignature || "");
if (!exactMatch) {
  const conflictMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: {
      error: "Result idempotency key was already used for a different durable result",
      code: "RESULT_IDEMPOTENCY_CONFLICT",
      retryable: false,
      resultId: expected.id || null,
    },
  });
  return [null, conflictMsg, conflictMsg];
}

const sourceGame = msg._resultSubmit?.game && typeof msg._resultSubmit.game === "object"
  ? msg._resultSubmit.game
  : null;
const projectionApplied = toStr(sourceGame?.tenantKey) === toStr(stored.tenantKey)
  && toStr(sourceGame?.id) === toStr(stored.gameId)
  && toStr(sourceGame?.resultId) === toStr(stored.id)
  && String(sourceGame?.resultLifecycleState || "").toUpperCase() === String(stored.lifecycleState || stored.status || "").toUpperCase();
if (!projectionApplied) {
  const recoveryMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: {
      error: "Result is durable but its tenant-bound legacy game projection is incomplete",
      code: "LEGACY_GAME_PROJECTION_INCOMPLETE",
      retryable: false,
      recoveryRequired: true,
      resultId: stored.id,
      gameId: stored.gameId,
    },
  });
  return [null, recoveryMsg, recoveryMsg];
}

msg.statusCode = 200;
msg._resultSubmitDoc = Object.assign({}, stored, { idempotent: true });
return [msg, null, msg];

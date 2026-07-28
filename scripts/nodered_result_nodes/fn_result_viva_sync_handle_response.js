const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const task = isObject(msg._resultVivaSyncTask)
  ? msg._resultVivaSyncTask
  : (isObject(msg.payload) && msg.payload.outboxId ? {
    outboxId: msg.payload.outboxId,
    auditEventId: msg.payload.auditEventId || null,
    player: msg.payload.player || null,
    resultId: msg.payload.resultId || null,
    resultRevision: msg.payload.resultRevision || null,
    syncSignature: msg.payload.syncSignature || msg.payload.batchId || null,
  } : null);

if (!task || !task.outboxId) {
  return [null, null, msg];
}

const attemptedAt = toStr(msg._resultVivaSyncAttemptedAt) || toStr(msg.payload?.attemptedAt) || new Date().toISOString();
const httpStatus = Number(msg.statusCode || msg.payload?.statusCode || 0) || null;
const payload = isObject(msg.payload) ? msg.payload : null;
const explicitError = toStr(msg.error?.message || msg.payload?.error || msg.payload?.details?.error);
const nextAttempts = Math.max(0, Math.floor(Number(task.attempts || 0))) + 1;
const ok = !explicitError && (
  (payload && payload.ok === true)
  || (httpStatus !== null && httpStatus >= 200 && httpStatus < 300)
);
const auditEventId = toStr(payload?.auditEventId) || toStr(task.auditEventId);
const errorReason = ok
  ? null
  : (explicitError || (httpStatus ? `Viva sync failed with HTTP ${httpStatus}` : 'Viva sync failed'));
const lastSuccessAt = ok ? attemptedAt : null;

const statusPayload = [
  { _id: task.outboxId },
  {
    $set: {
      status: ok ? 'SYNCED' : 'FAILED',
      updatedAt: attemptedAt,
      lastAttemptAt: attemptedAt,
      lastSuccessAt,
      attempts: nextAttempts,
      lastError: errorReason,
      responsePayload: payload || msg.payload || null,
      syncedAt: ok ? attemptedAt : null,
      auditEventId,
    },
  },
  { upsert: true },
];

const joinPayload = {
  outboxId: task.outboxId,
  ok,
  status: ok ? 'SYNCED' : 'FAILED',
  player: task.player || null,
    resultId: task.resultId || null,
    resultRevision: Number.isInteger(Number(task.resultRevision)) ? Number(task.resultRevision) : null,
    syncSignature: toStr(task.syncSignature),
    attempts: nextAttempts,
    attemptedAt,
    lastSuccessAt,
    error: errorReason,
  auditEventId,
  httpStatus,
};

return [
  Object.assign({}, msg, { payload: statusPayload }),
  msg._resultVivaSyncBatch ? Object.assign({}, msg, { payload: joinPayload }) : null,
  Object.assign({}, msg, { payload: joinPayload }),
];

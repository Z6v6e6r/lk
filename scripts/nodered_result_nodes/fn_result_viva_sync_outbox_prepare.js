const task = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
if (!task || !task.outboxId) return null;

const nowIso = new Date().toISOString();
const requestPayload = task.payload && typeof task.payload === 'object' ? task.payload : {};
const failureReason = typeof task.skipReason === 'string' && task.skipReason.trim() ? task.skipReason.trim() : null;
const retryable = task.retryable !== false && !failureReason;

msg.payload = [
  { _id: task.outboxId },
  {
    $setOnInsert: {
      _id: task.outboxId,
      id: task.outboxId,
      kind: 'VIVA_ONBOARDING_LEVEL',
      batchId: task.syncSignature,
      syncSignature: task.syncSignature,
      gameId: task.gameId || null,
      resultId: task.resultId || null,
      resultRevision: Number.isInteger(Number(task.resultRevision)) ? Number(task.resultRevision) : null,
      ratingEventId: task.ratingEventId || null,
      player: task.player || null,
      createdAt: task.createdAt || nowIso,
      auditEventId: task.auditEventId || null,
      source: task.source || null,
      mode: task.mode || null,
      requestPayload,
      retryable,
    },
    $set: {
      status: failureReason ? 'FAILED' : 'PENDING',
      updatedAt: task.updatedAt || nowIso,
      lastError: failureReason,
      lastAttemptAt: null,
      lastSuccessAt: null,
      attempts: 0,
      retryable,
      responsePayload: null,
    },
  },
  { upsert: true },
];
return msg;

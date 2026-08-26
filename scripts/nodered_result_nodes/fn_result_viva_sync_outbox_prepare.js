const task = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
if (!task || !task.outboxId) return null;
const tenantKey = typeof task.tenantKey === 'string' ? task.tenantKey.trim() : '';
if (!tenantKey || tenantKey !== task.tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  throw new Error('Provider outbox tenant context is invalid');
}
const resultId = typeof task.resultId === 'string' ? task.resultId.trim() : '';
const resultRevision = Number(task.resultRevision);
if (!resultId || resultId !== task.resultId || !Number.isSafeInteger(resultRevision) || resultRevision < 1) {
  throw new Error('Provider outbox result identity is invalid');
}

const nowIso = new Date().toISOString();
const requestPayload = task.payload && typeof task.payload === 'object' ? task.payload : {};
const failureReason = typeof task.skipReason === 'string' && task.skipReason.trim() ? task.skipReason.trim() : null;
const retryable = false;

msg._resultVivaSyncOriginalTask = task;

msg.payload = [
  { _id: task.outboxId, id: task.outboxId, tenantKey, resultId, resultRevision },
  {
    $setOnInsert: {
      _id: task.outboxId,
      id: task.outboxId,
      tenantKey,
      kind: 'VIVA_ONBOARDING_LEVEL',
      batchId: task.syncSignature,
      syncSignature: task.syncSignature,
      gameId: task.gameId || null,
      resultId,
      resultRevision,
      ratingEventId: task.ratingEventId || null,
      player: task.player || null,
      createdAt: task.createdAt || nowIso,
      auditEventId: task.auditEventId || null,
      source: task.source || null,
      mode: task.mode || null,
      requestPayload,
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
  { upsert: true, writeConcern: { w: 'majority' } },
];
return msg;

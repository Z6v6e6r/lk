const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const row = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
if (!row) return [null, null];

const attempts = Math.max(0, Math.floor(Number(row.attempts || 0)));
const retryable = row.retryable !== false;
const requestPayload = row.requestPayload && typeof row.requestPayload === 'object'
  ? row.requestPayload
  : null;
const tenantKey = toStr(row.tenantKey);

if (!retryable || attempts >= 30 || !requestPayload || !tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  return [null, Object.assign({}, msg, {
    payload: {
      skipped: true,
      outboxId: toStr(row._id || row.id),
      reason: !retryable
        ? 'Outbox entry is not retryable'
        : attempts >= 30
          ? 'Outbox entry exhausted retry limit'
          : !requestPayload
            ? 'Outbox entry is missing requestPayload'
            : 'Outbox entry is missing canonical tenant identity',
    },
  })];
}

msg.payload = {
  outboxId: toStr(row._id || row.id),
  tenantKey,
  auditEventId: toStr(row.auditEventId),
  syncSignature: toStr(row.syncSignature || row.batchId),
  mode: toStr(row.mode),
  source: toStr(row.source),
  gameId: toStr(row.gameId),
  resultId: toStr(row.resultId),
  resultRevision: Number.isInteger(Number(row.resultRevision)) ? Number(row.resultRevision) : null,
  ratingEventId: toStr(row.ratingEventId),
  player: row.player || null,
  payload: requestPayload,
  attempts,
  retryable: true,
  createdAt: toStr(row.createdAt),
  updatedAt: new Date().toISOString(),
};
return [msg, null];

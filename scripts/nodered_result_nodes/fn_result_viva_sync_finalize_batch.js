const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const uniq = (items) => Array.from(new Set(asArray(items).map((item) => toStr(item)).filter(Boolean)));

const batch = msg._resultVivaSyncBatch && typeof msg._resultVivaSyncBatch === 'object'
  ? msg._resultVivaSyncBatch
  : null;
const rows = asArray(msg.payload);

if (!batch) {
  return [null, null, msg];
}

const totalPlayers = Math.max(asArray(batch.tasks).length, rows.length);
const syncedRows = rows.filter((item) => item && item.ok);
const syncedPlayers = syncedRows.length;
const failures = rows
  .filter((item) => item && !item.ok)
  .map((item) => ({
    id: toStr(item?.player?.id),
    phone: toStr(item?.player?.phoneNorm),
    name: toStr(item?.player?.name),
    reason: toStr(item?.error) || 'Unknown Viva sync error',
  }));
const status = totalPlayers === 0
  ? 'SUCCESS'
  : syncedPlayers === totalPlayers
    ? 'SUCCESS'
    : syncedPlayers > 0
      ? 'PARTIAL_SUCCESS'
      : 'FAILED';
const lastAttemptAt = rows
  .map((item) => toStr(item?.attemptedAt))
  .filter(Boolean)
  .sort()
  .at(-1) || batch.startedAt || null;
const lastSuccessAt = syncedRows
  .map((item) => toStr(item?.lastSuccessAt || item?.attemptedAt))
  .filter(Boolean)
  .sort()
  .at(-1) || null;
const lastError = failures[0]?.reason || null;
const auditEventIds = uniq([
  ...asArray(batch.pendingState?.auditEventIds),
  ...rows.map((item) => item?.auditEventId),
]);
const summary = {
  status,
  attempts: 1,
  lastAttemptAt,
  lastSuccessAt,
  lastError,
  totalPlayers,
  syncedPlayers,
  failures,
  syncSignature: toStr(batch.syncSignature),
  auditEventIds,
};

const resultUpdateMsg = Object.assign({}, msg, {
  payload: [
    {
      tenantKey: toStr(batch.tenantKey),
      id: batch.resultId,
      revision: Number.isInteger(Number(batch.resultRevision)) ? Number(batch.resultRevision) : null,
    },
    {
      $set: {
        vivaSync: summary,
        updatedAt: lastAttemptAt || new Date().toISOString(),
      },
    },
    { upsert: false, writeConcern: { w: 'majority' } },
  ],
});

const baseResponse = batch.response && typeof batch.response === 'object'
  ? batch.response
  : null;
const responseMsg = baseResponse
  ? Object.assign({}, msg, {
    statusCode: Number(baseResponse.statusCode || 200),
    headers: baseResponse.headers || { "Content-Type": "application/json; charset=utf-8" },
    payload: Object.assign({}, baseResponse.payload || {}, {
      vivaSync: summary,
      result: baseResponse.payload?.result && typeof baseResponse.payload.result === 'object'
        ? Object.assign({}, baseResponse.payload.result, { vivaSync: summary })
        : baseResponse.payload?.result,
    }),
  })
  : null;

return [resultUpdateMsg, null, Object.assign({}, msg, { payload: { summary, responseDeferred: Boolean(responseMsg) } })];

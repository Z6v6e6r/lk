const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const uniq = (items) => Array.from(new Set(asArray(items).map((item) => toStr(item)).filter(Boolean)));

const rows = asArray(msg.payload).filter((item) => item && typeof item === 'object');
if (rows.length === 0) {
  return [null, null, msg];
}

const reference = rows[0];
const resultId = toStr(reference.resultId);
const tenantKey = toStr(reference.tenantKey);
const resultRevision = Number(reference.resultRevision);
const sameIdentity = rows.every((row) => toStr(row.tenantKey) === tenantKey
  && toStr(row.resultId) === resultId
  && Number(row.resultRevision) === resultRevision);
if (!resultId || !tenantKey || !Number.isSafeInteger(resultRevision) || resultRevision < 1 || !sameIdentity) {
  return [null, null, msg];
}

const totalPlayers = rows.length;
const syncedRows = rows.filter((item) => String(item.status || '').toUpperCase() === 'SYNCED');
const failedRows = rows.filter((item) => String(item.status || '').toUpperCase() === 'FAILED');
const pendingRows = rows.filter((item) => {
  const status = String(item.status || '').toUpperCase();
  return status !== 'SYNCED' && status !== 'FAILED';
});
const syncedPlayers = syncedRows.length;
const failures = failedRows.map((item) => ({
  id: toStr(item?.player?.id),
  phone: toStr(item?.player?.phoneNorm),
  name: toStr(item?.player?.name),
  reason: toStr(item?.lastError) || 'Unknown Viva sync error',
})).filter((item) => item.id || item.phone || item.name || item.reason);

let status = 'PENDING';
if (pendingRows.length === 0) {
  status = syncedPlayers === totalPlayers
    ? 'SUCCESS'
    : syncedPlayers > 0
      ? 'PARTIAL_SUCCESS'
      : 'FAILED';
} else if (syncedPlayers > 0 || failedRows.length > 0) {
  status = 'PARTIAL_SUCCESS';
}

const lastAttemptAt = rows
  .map((item) => toStr(item?.lastAttemptAt))
  .filter(Boolean)
  .sort()
  .at(-1) || new Date().toISOString();
const lastSuccessAt = syncedRows
  .map((item) => toStr(item?.lastSuccessAt || item?.syncedAt))
  .filter(Boolean)
  .sort()
  .at(-1) || null;
const attempts = Math.max(
  0,
  ...rows.map((item) => Math.max(0, Math.floor(Number(item?.attempts || 0)))),
);
const auditEventIds = uniq(rows.map((item) => item?.auditEventId));
const lastError = failures[0]?.reason || null;

const summary = {
  status,
  attempts,
  lastAttemptAt,
  lastSuccessAt,
  lastError,
  totalPlayers,
  syncedPlayers,
  failures,
  syncSignature: toStr(reference.syncSignature || reference.batchId),
  auditEventIds,
};

const resultUpdateMsg = Object.assign({}, msg, {
  payload: [
    { tenantKey, id: resultId, revision: resultRevision },
    {
      $set: {
        vivaSync: summary,
        updatedAt: lastAttemptAt,
      },
    },
    { upsert: false, writeConcern: { w: 'majority' } },
  ],
});

return [resultUpdateMsg, Object.assign({}, msg, { payload: summary }), Object.assign({}, msg, { payload: rows })];

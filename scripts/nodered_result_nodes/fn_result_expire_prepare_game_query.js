const row = msg.payload;
if (!row || typeof row !== 'object') return [null, msg];

const gameId = String(row.gameId || '').trim();
const tenantKey = String(row.tenantKey || '').trim();
if (!gameId || !tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  msg.payload = {
    error: 'Skipped expired result without canonical tenant/game identity',
    resultId: row.id || row._id || null,
  };
  return [null, msg];
}

msg._resultPending = Object.assign({}, row, {
  id: row.id || row._id || null,
  gameId,
  tenantKey,
  expiredToNoResult: true,
});
msg._resultConfirm = Object.assign({}, msg._resultConfirm || {}, {
  tenantKey,
  action: 'EXPIRE_CRON',
  reason: 'CORRECTION_TIMEOUT',
});
msg.payload = { tenantKey, id: gameId, archived: { $ne: true } };
return [msg, msg];

const row = msg.payload;
if (!row || typeof row !== 'object') return [null, msg];

const gameId = String(row.gameId || '').trim();
if (!gameId) {
  msg.payload = {
    error: 'Skipped expired result without gameId',
    resultId: row.id || row._id || null,
  };
  return [null, msg];
}

msg._resultPending = Object.assign({}, row, {
  id: row.id || row._id || null,
  gameId,
  expiredToNoResult: true,
});
msg._resultConfirm = Object.assign({}, msg._resultConfirm || {}, {
  action: 'EXPIRE_CRON',
  reason: 'CORRECTION_TIMEOUT',
});
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, msg];

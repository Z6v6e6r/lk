const rows = Array.isArray(msg.payload) ? msg.payload : [];
const pending = msg._resultPending || {};
const game = rows[0] || { id: pending.gameId };

msg._resultConfirm = Object.assign({}, msg._resultConfirm || {}, { game });
msg.payload = [];
return [msg, msg];

const ctx = msg._organizerTransfer;
const ack = msg.payload;
const ok = !msg.error && ack?.acknowledged === true && ack.matchedCount === 1;
msg.statusCode = ok ? 200 : 409;
msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
msg.payload = { ok, state: ok ? "ORGANIZER_TRANSFERRED" : "CONFLICT",
  gameId: ctx?.gameId, successorId: ok ? ctx?.successorId : undefined,
  message: ok ? "Роль организатора передана. Теперь можно отменить своё участие." : "Передача не подтверждена. Обновите игру перед повтором." };
return msg;

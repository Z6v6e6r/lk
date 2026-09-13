if (msg.error || msg.payload?.acknowledged !== true || msg.payload.matchedCount !== 1) {
  msg.statusCode = 409; msg.payload = { ok: false, error: "Игра изменилась. Обновите состав перед отменой." }; return [null,msg];
}
msg.payload = msg._organizerCleanupTask;
return [msg,null];

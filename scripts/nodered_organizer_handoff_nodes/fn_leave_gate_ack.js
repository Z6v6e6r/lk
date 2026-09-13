const ack = msg.payload;
if (msg.error || ack?.acknowledged !== true || ack.matchedCount !== 1) {
  msg.statusCode = 409;
  msg.payload = { ok: false, state: "CONFLICT", message: "Состав игры изменился. Повторите выход." };
  return [null, msg];
}
msg.payload = msg._membershipGatePayload;
delete msg._membershipGatePayload;
return [msg, null];

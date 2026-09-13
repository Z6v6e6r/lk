if (msg.error || msg.payload?.acknowledged !== true) {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "RETRY_REQUIRED", message: "Выход завершён. Повторите проверку завершения операции." };
  return [null, msg];
}
msg.payload = msg._membershipReleasePayload;
delete msg._membershipReleasePayload;
return [msg, null];

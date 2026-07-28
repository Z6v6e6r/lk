const context = msg.padelDay || {};
const content = Array.isArray(msg.payload?.content) ? msg.payload.content : (Array.isArray(msg.payload) ? msg.payload : null);

if (Number(msg.statusCode || 0) >= 400 || !content) {
  msg.statusCode = 502;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = { ok: false, code: "PADEL_DAY_BOOKINGS_UNAVAILABLE", message: "Не удалось проверить действующие записи. Попробуйте ещё раз." };
  return [null, msg];
}

const dateOf = (value) => String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
const terminal = (booking) => {
  const values = [
    booking?.transactionStatus?.transactionStatus,
    booking?.transactionStatus?.cardPaymentStatus?.status,
  ].map((value) => String(value || "").toUpperCase());
  return values.some((value) => ["FAILED", "REFUND", "CANCEL", "EXPIRED"].some((marker) => value.includes(marker)));
};
const conflict = content.find((booking) => (
  booking?.isCancelled !== true
  && !terminal(booking)
  && Number(booking?.exercise?.direction?.id) === 5245
));

if (conflict) {
  msg.statusCode = 409;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = {
    ok: false,
    code: "PADEL_DAY_ALREADY_BOOKED",
    message: "У вас уже есть активная запись на Padel Day",
    booking: { id: conflict.id || null, exerciseId: conflict.exercise?.id || null, timeFrom: conflict.exercise?.timeFrom || null, date: dateOf(conflict.exercise?.timeFrom) },
  };
  return [null, msg];
}

msg.method = "GET";
msg.url = `https://api.vivacrm.ru/end-user/api/v1/iSkq6G/exercises/${encodeURIComponent(context.exerciseId)}`;
msg.headers = { authorization: context.authHeader, accept: "application/json" };
msg.payload = undefined;
return [msg, null];

const raw = String(msg.error?.message || msg.payload?.message || "");
const duplicate = /E11000|duplicate key/i.test(raw);
msg.statusCode = duplicate ? 409 : 503;
msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
msg.payload = {
  ok: false,
  code: duplicate ? "PADEL_DAY_GUARD_ACTIVE" : "PADEL_DAY_GUARD_UNAVAILABLE",
  message: duplicate
    ? "Запись уже оформляется в другом окне. Завершите предыдущую попытку или подождите несколько минут."
    : "Защита записи временно недоступна. Попробуйте ещё раз.",
};
return msg;

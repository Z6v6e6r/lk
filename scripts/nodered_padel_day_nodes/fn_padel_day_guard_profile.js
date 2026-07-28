const context = msg.padelDay || {};
const profile = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
const clientId = String(profile?.id || "").trim();

if (Number(msg.statusCode || 0) >= 400 || !clientId) {
  msg.statusCode = Number(msg.statusCode || 0) === 401 ? 401 : 502;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = { ok: false, code: "PADEL_DAY_PROFILE_UNAVAILABLE", message: "Не удалось проверить профиль клиента" };
  return [null, msg];
}

msg.padelDay = { ...context, clientId };
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v2/iSkq6G/bookings?size=1000";
msg.headers = { authorization: context.authHeader, accept: "application/json" };
msg.payload = undefined;
return [msg, null];

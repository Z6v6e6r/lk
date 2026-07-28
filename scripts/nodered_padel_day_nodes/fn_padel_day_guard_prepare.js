const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const authHeader = String(msg.req?.headers?.authorization || msg.headers?.authorization || "").trim();
const exerciseId = String(body.exerciseId || "").trim();
const eventDate = String(body.eventDate || "").trim();
const idempotencyKey = String(body.idempotencyKey || "").trim();
const allowedDates = new Set(["2026-07-29", "2026-07-26"]);

const respond = (statusCode, message) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  };
  msg.payload = { ok: false, code: statusCode === 409 ? "PADEL_DAY_ALREADY_BOOKED" : "PADEL_DAY_GUARD_REJECTED", message };
  return [null, msg];
};

if (!authHeader.toLowerCase().startsWith("bearer ")) return respond(401, "Необходимо войти в личный кабинет");
if (!exerciseId || !/^[0-9a-f-]{16,}$/i.test(exerciseId)) return respond(400, "Некорректная запись");
if (!allowedDates.has(eventDate)) return respond(400, "Запись доступна только на дату Padel Day");
if (!idempotencyKey || idempotencyKey.length > 180) return respond(400, "Некорректный ключ операции");

msg.padelDay = { authHeader, exerciseId, eventDate, idempotencyKey, tenantKey: "iSkq6G" };
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
msg.headers = { authorization: authHeader, accept: "application/json" };
msg.payload = undefined;
return [msg, null];

const VIVA_API_BASE = "https://api.vivacrm.ru";
const TENANT_KEY = "iSkq6G";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const requestHeader = (name) => {
  const headers = msg.req && msg.req.headers && typeof msg.req.headers === "object"
    ? msg.req.headers
    : {};
  return toStr(headers[String(name).toLowerCase()] || headers[name]);
};

const finish = (statusCode, error, details) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { error, details: details || null };
  return [null, msg];
};

const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
  ? msg.payload
  : {};
const authHeader = requestHeader("authorization");
const operationId = requestHeader("idempotency-key")
  || toStr(msg.req?.query?.operationId)
  || toStr(body.operationId);
const exerciseId = toStr(body.exerciseId);
const clientSubscriptionId = toStr(body.clientSubscriptionId);
const spotNumber = Number(body.spot);

if (!authHeader || !/^Bearer\s+\S+/i.test(authHeader)) {
  return finish(401, "Требуется авторизация Viva", { code: "SUBSCRIPTION_BOOKING_AUTH_REQUIRED" });
}
if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {
  return finish(400, "Требуется корректный operationId", { code: "SUBSCRIPTION_BOOKING_OPERATION_ID_REQUIRED" });
}
if (!exerciseId || !clientSubscriptionId) {
  return finish(400, "exerciseId и clientSubscriptionId обязательны", {
    code: "SUBSCRIPTION_BOOKING_TARGET_REQUIRED",
  });
}

msg._subscriptionBooking = {
  caller: "http",
  step: "profile",
  tenantKey: TENANT_KEY,
  operationId,
  authHeader,
  exerciseId,
  clientSubscriptionId,
  spot: Number.isFinite(spotNumber) && spotNumber > 0 ? Math.floor(spotNumber) : null,
  startedAt: new Date().toISOString(),
};
msg.method = "GET";
msg.url = `${VIVA_API_BASE}/end-user/api/v1/${TENANT_KEY}/profile`;
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = undefined;
return [msg, null];

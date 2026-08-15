const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const readEnv = (name) => {
  try {
    if (typeof env !== "undefined" && env && typeof env.get === "function") {
      return toStr(env.get(name));
    }
  } catch (_error) {
    return null;
  }
  return null;
};
const isCupTarget = (target) => {
  if (target !== "state") return false;
  const configured = (readEnv("RESULT_AUTH_CUP_TARGETS") || "none").toLowerCase();
  const targets = new Set(configured.split(",").map((value) => value.trim()).filter(Boolean));
  return targets.has("state");
};
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { error, code };
  return [null, msg];
};

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return respond(401, "RESULT_AUTH_TOKEN_REQUIRED", "Необходимо войти в личный кабинет");
}

const requestPayload = isObj(msg.payload) ? msg.payload : {};
const actorHint = [
  requestPayload.submittedBy,
  requestPayload.actor,
  requestPayload.openedBy,
].find(isObj) || {};
const requestPath = String(
  msg.req?.route?.path
  || msg.req?.originalUrl
  || msg.req?.url
  || "",
).toLowerCase();
let target = "confirm";
if (requestPath.includes("/result/state")) target = "state";
else if (requestPath.includes("/result/submit")) target = "submit";
else if (requestPath.includes("/result/session/open")) target = "session-open";
else if (requestPath.includes("/result/session/")) target = "session-update";

msg._resultAuth = {
  target,
  authSource: isCupTarget(target) ? "cup-jwt" : "viva-profile",
  requestPayload,
  actorHint: {
    id: toStr(actorHint.id || actorHint.clientId || actorHint.uuid || actorHint.userId || actorHint.playerId),
    phoneNorm: normPhone(
      actorHint.phoneNorm
      || actorHint.phone
      || actorHint.phoneNumber
      || actorHint.mobile
      || requestPayload.phone
      || requestPayload.senderPhone
      || requestPayload.playerPhone,
    ),
    name: toStr(actorHint.name || actorHint.fullName || actorHint.title),
  },
};
if (msg._resultAuth.authSource === "cup-jwt") {
  const integrationToken = readEnv("CUP_LK_IDENTITY_TOKEN");
  if (!integrationToken) {
    return respond(503, "RESULT_AUTH_CUP_NOT_CONFIGURED", "Проверка профиля временно недоступна");
  }
  const apiBase = (
    readEnv("CUP_API_BASE_URL")
    || readEnv("SUPPORT_API_BASE_URL")
    || "http://127.0.0.1:3000/api"
  ).replace(/\/+$/, "");
  msg.method = "POST";
  msg.url = `${apiBase}/internal/lk/identity/verify`;
  msg.headers = {
    Authorization: authHeader,
    "X-CUP-Integration-Token": integrationToken,
    Accept: "application/json",
  };
} else {
  msg.method = "GET";
  msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
  msg.headers = {
    Authorization: authHeader,
    Accept: "application/json",
  };
}
msg.payload = undefined;
return [msg, null];

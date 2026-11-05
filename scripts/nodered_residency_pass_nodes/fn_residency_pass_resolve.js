const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
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
const scrubContext = () => {
  delete msg._residentPass;
};
// Fixed-enum observability only: never the bearer, token, subscription id or subject.
const warn = (event, code, extra) => {
  if (typeof node === "undefined" || typeof node?.warn !== "function") return;
  try {
    node.warn(JSON.stringify(Object.assign({ event, code }, extra || {})));
  } catch (_error) {
    // Observability must never alter the response.
  }
};
const jsonHeaders = () => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Access-Control-Allow-Origin": "*",
});
const durationMs = (ctx) => {
  const startedAt = Number(ctx?.startedAt);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
};

const finish = (statusCode, code, message) => {
  const ctx = isObj(msg._residentPass) ? msg._residentPass : null;
  warn("residency_pass_subscription_rejected", code, {
    endpoint: "create",
    httpStatus: statusCode,
    upstreamStatus: Number.isInteger(Number(msg.statusCode)) ? Number(msg.statusCode) : null,
    durationMs: durationMs(ctx),
  });
  scrubContext();
  msg.statusCode = statusCode;
  msg.headers = jsonHeaders();
  msg.payload = { code, message };
  return [null, msg];
};
const parsePayload = () => {
  let payload = msg.payload;
  if (typeof payload === "string") {
    if (!payload.trim() || payload.length > 262144) return null;
    try {
      payload = JSON.parse(payload);
    } catch (_error) {
      return null;
    }
  }
  return isObj(payload) || Array.isArray(payload) ? payload : null;
};

const ctx = isObj(msg._residentPass) ? msg._residentPass : null;
if (!ctx || ctx.endpoint !== "create") {
  return finish(500, "RESIDENT_CLIENT_INTERNAL", "Не удалось прочитать абонементы");
}

const upstreamStatus = Number(msg.statusCode) || 0;
if (msg.error || upstreamStatus === 0) {
  return finish(503, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", "Данные абонементов временно недоступны");
}
if (upstreamStatus === 401 || upstreamStatus === 403) {
  return finish(401, "RESIDENT_CLIENT_AUTH_REQUIRED", "Сессия истекла. Войдите снова");
}
if (upstreamStatus < 200 || upstreamStatus >= 300) {
  return finish(503, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", "Данные абонементов временно недоступны");
}
const payload = parsePayload();
if (!payload) {
  return finish(503, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", "Данные абонементов временно недоступны");
}
const list = Array.isArray(payload)
  ? payload
  : (Array.isArray(payload.content)
    ? payload.content
    : (isObj(payload.data) && Array.isArray(payload.data.content) ? payload.data.content : null));
if (!Array.isArray(list)) {
  return finish(503, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", "Данные абонементов временно недоступны");
}

const requested = toStr(ctx.clientSubscriptionId).toLowerCase();
const now = Date.now();
const readDate = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
};
const matches = list.filter((entry) => (
  isObj(entry)
  && (toStr(entry.subscriptionId) || toStr(entry.id) || "").toLowerCase() === requested
));
if (matches.length !== 1) {
  return finish(409, "RESIDENT_CLIENT_SUBSCRIPTION_INVALID", "Абонемент не найден среди активных");
}
const subscription = matches[0];
const status = (toStr(subscription.status) || "").toUpperCase();
const activationTs = readDate(subscription.activationDate);
const expirationTs = readDate(subscription.expirationDate);
const holdTs = readDate(subscription.holdUntil);
const cancelledMarkers = ["CANCEL", "CLOSE", "FINISH", "EXPIRED", "ARCHIVE", "VOID", "DELETED"];
if (status && cancelledMarkers.some((marker) => status.includes(marker))) {
  return finish(409, "RESIDENT_CLIENT_SUBSCRIPTION_INVALID", "Абонемент не активен");
}
if (activationTs !== null && activationTs > now) {
  return finish(409, "RESIDENT_CLIENT_SUBSCRIPTION_INVALID", "Абонемент ещё не активирован");
}
if (expirationTs !== null && expirationTs <= now) {
  return finish(409, "RESIDENT_CLIENT_SUBSCRIPTION_INVALID", "Абонемент истёк");
}
if (holdTs !== null && holdTs > now) {
  return finish(409, "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN", "Абонемент заморожен");
}

const cupBase = readEnv("RESIDENT_CLIENT_CUP_API_BASE_URL");
const integrationToken = readEnv("RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN");
const authorizationHeader = toStr(ctx.authorization);
if (!cupBase || !integrationToken) {
  return finish(503, "RESIDENT_CLIENT_NOT_CONFIGURED", "Сервис пропусков не настроен");
}
if (!authorizationHeader) {
  return finish(401, "RESIDENT_CLIENT_AUTH_REQUIRED", "Сессия истекла. Войдите снова");
}
const createUrl = cupBase.replace(/\/+$/, "") + "/internal/subscriptions/resident-passes";
if (!/^https?:\/\/[^\s]+$/i.test(createUrl) || /[\r\n]/.test(createUrl)) {
  return finish(503, "RESIDENT_CLIENT_NOT_CONFIGURED", "Сервис пропусков не настроен");
}

msg._residentPass = Object.assign({}, ctx, {
  subscriptionMatched: true,
});
delete msg._residentPass.authorization;
msg.method = "POST";
msg.url = createUrl;
msg.headers = {
  Authorization: authorizationHeader,
  "X-Resident-Services-Integration-Token": integrationToken,
  "X-Correlation-Id": ctx.correlationId,
  "Content-Type": "application/json",
  Accept: "application/json",
};
msg.payload = { clientSubscriptionId: requested };
msg.requestTimeout = 8000;
msg.followRedirects = false;
msg.maxRedirects = 0;
delete msg.statusCode;
delete msg.error;
return [msg, null];

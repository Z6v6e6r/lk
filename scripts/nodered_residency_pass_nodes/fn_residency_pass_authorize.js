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
const scrubRequestAuthorization = () => {
  if (!isObj(msg.req)) return;
  if (isObj(msg.req.headers)) {
    delete msg.req.headers.authorization;
    delete msg.req.headers.Authorization;
  }
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

const AUTH_SERVICE_UNAVAILABLE = "RESIDENT_CLIENT_AUTH_UNAVAILABLE";
const finish = (statusCode, code, message) => {
  const ctx = isObj(msg._residentPass) ? msg._residentPass : {};
  warn("residency_pass_authorization_failed", code, {
    endpoint: ctx.endpoint || "unknown",
    httpStatus: statusCode,
    upstreamStatus: Number.isInteger(Number(msg.statusCode)) ? Number(msg.statusCode) : null,
    durationMs: Math.max(0, Date.now() - Number(ctx.startedAt || Date.now())),
  });
  scrubRequestAuthorization();
  scrubContext();
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { code, message };
  return [null, msg];
};

const ctx = isObj(msg._residentPass) ? msg._residentPass : null;
if (!ctx) {
  return finish(500, "RESIDENT_CLIENT_INTERNAL", "Не удалось проверить пользователя");
}

const upstreamStatus = Number(msg.statusCode) || 0;
if (msg.error || upstreamStatus === 0) {
  return finish(503, AUTH_SERVICE_UNAVAILABLE, "Не удалось проверить вход. Повторите позже");
}
if (upstreamStatus === 401 || upstreamStatus === 403) {
  return finish(401, "RESIDENT_CLIENT_AUTH_REQUIRED", "Сессия истекла. Войдите снова");
}
if (upstreamStatus < 200 || upstreamStatus >= 300) {
  return finish(503, AUTH_SERVICE_UNAVAILABLE, "Не удалось проверить вход. Повторите позже");
}

let claims = msg.payload;
if (typeof claims === "string") {
  if (!claims.trim() || claims.length > 65536) {
    return finish(503, AUTH_SERVICE_UNAVAILABLE, "Не удалось проверить вход. Повторите позже");
  }
  try {
    claims = JSON.parse(claims);
  } catch (_error) {
    return finish(503, AUTH_SERVICE_UNAVAILABLE, "Не удалось проверить вход. Повторите позже");
  }
}
if (!isObj(claims)) {
  return finish(503, AUTH_SERVICE_UNAVAILABLE, "Не удалось проверить вход. Повторите позже");
}
const subject = toStr(claims.sub);
if (!subject) {
  return finish(503, AUTH_SERVICE_UNAVAILABLE, "Не удалось проверить вход. Повторите позже");
}

const expectedClientId = readEnv("RESIDENT_CLIENT_EXPECTED_CLIENT_ID") || "widget";
const expectedTenantKey = readEnv("RESIDENT_CLIENT_TENANT_KEY") || "iSkq6G";
const authorizedParty = toStr(claims.azp) || toStr(claims.client_id) || toStr(claims.clientId);
if (authorizedParty !== expectedClientId) {
  return finish(403, "RESIDENT_CLIENT_FORBIDDEN", "Вход выполнен в другом приложении");
}
const tenantKey = toStr(claims.tenantKey) || toStr(claims.tenant_key) || toStr(claims.tenant);
if (tenantKey !== expectedTenantKey) {
  return finish(403, "RESIDENT_CLIENT_FORBIDDEN", "Вход выполнен в другом клубе");
}

// Only pass creation spends a CUP integration call; status polling is a cheap read.
if (ctx.endpoint === "create") {
  const configuredLimit = Number(readEnv("RESIDENT_CLIENT_RATE_LIMIT_PER_MINUTE") || 20);
  const limit = Number.isFinite(configuredLimit) ? Math.max(1, Math.min(120, Math.floor(configuredLimit))) : 20;
  const minuteBucket = Math.floor(Date.now() / 60000);
  const rateKey = "resident-pass-rate:" + subject + ":" + minuteBucket;
  let attempts = 0;
  try {
    if (typeof flow !== "undefined" && flow && typeof flow.get === "function") {
      const stored = Number(flow.get(rateKey));
      attempts = Number.isFinite(stored) && stored > 0 ? stored : 0;
      if (typeof flow.set === "function") flow.set(rateKey, attempts + 1);
    }
  } catch (_error) {
    attempts = 0;
  }
  if (attempts >= limit) {
    return finish(429, "RESIDENT_CLIENT_RATE_LIMITED", "Слишком много запросов. Подождите минуту");
  }
}

const authorizationHeader = toStr(ctx.authorization);
if (!authorizationHeader) {
  return finish(401, "RESIDENT_CLIENT_AUTH_REQUIRED", "Сессия истекла. Войдите снова");
}

const correlationId = ctx.correlationId;
let nextUrl = null;
if (ctx.endpoint === "create") {
  const vivaBase = (readEnv("RESIDENT_CLIENT_VIVA_API_BASE_URL") || "https://api.vivacrm.ru").replace(/\/+$/, "");
  nextUrl = vivaBase
    + "/end-user/api/v1/" + expectedTenantKey
    + "/subscriptions?includeFinished=false&size=100";
} else if (ctx.endpoint === "status") {
  const cupBase = readEnv("RESIDENT_CLIENT_CUP_API_BASE_URL");
  const integrationToken = readEnv("RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN");
  if (!cupBase || !integrationToken) {
    return finish(503, "RESIDENT_CLIENT_NOT_CONFIGURED", "Сервис пропусков не настроен");
  }
  const statusPath = toStr(ctx.statusPath);
  if (!statusPath || !/^\/(?!\/)[A-Za-z0-9._\-\/]*\/$/.test(statusPath)) {
    return finish(503, "RESIDENT_CLIENT_NOT_CONFIGURED", "Сервис пропусков не настроен");
  }
  nextUrl = cupBase.replace(/\/+$/, "")
    + statusPath
    + encodeURIComponent(ctx.passId);
} else {
  return finish(500, "RESIDENT_CLIENT_INTERNAL", "Не удалось продолжить обработку");
}
if (typeof nextUrl === "string" && /[\r\n]/.test(nextUrl)) {
  return finish(500, "RESIDENT_CLIENT_INTERNAL", "Не удалось продолжить обработку");
}

const nextHeaders = ctx.endpoint === "create"
  ? { Authorization: authorizationHeader, Accept: "application/json" }
  : {
      Authorization: authorizationHeader,
      "X-Resident-Services-Integration-Token": readEnv("RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN"),
      "X-Correlation-Id": correlationId,
      Accept: "application/json",
    };

msg._residentPass = Object.assign({}, ctx, { subject, tenantKey, verifiedAt: new Date().toISOString() });
// Create needs the verified Bearer once more for the CUP call after the Viva
// subscriptions read; the resolve node consumes and deletes it. Status ends here.
if (ctx.endpoint !== "create") {
  delete msg._residentPass.authorization;
}
msg.method = "GET";
msg.url = nextUrl;
msg.headers = nextHeaders;
msg.payload = null;
msg.requestTimeout = 8000;
msg.followRedirects = false;
msg.maxRedirects = 0;
delete msg.statusCode;
delete msg.error;
return [msg, null];

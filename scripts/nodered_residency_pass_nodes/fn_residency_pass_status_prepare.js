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

const finish = (statusCode, code, message) => {
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
const unavailable = (message) => {
  warn("residency_pass_status_disabled", "RESIDENCY_CLIENT_STATUS_UNAVAILABLE", { endpoint: "status" });
  scrubRequestAuthorization();
  scrubContext();
  msg.statusCode = 200;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = {
    schemaVersion: 1,
    statusAvailable: false,
    state: "UNKNOWN",
    issuedAt: null,
    expiresAt: null,
    consumedAt: null,
    message,
  };
  return [null, msg];
};

const enabled = (readEnv("RESIDENT_CLIENT_ENABLED") || "").toLowerCase() === "true";
if (!enabled) {
  return finish(503, "RESIDENT_CLIENT_DISABLED", "Сервис пропусков временно выключен");
}

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return finish(401, "RESIDENT_CLIENT_AUTH_REQUIRED", "Необходимо войти в личный кабинет");
}

const passIdRaw = toStr(msg.req?.params?.passId) || toStr(msg.req?.params?.[0]);
if (!passIdRaw
  || !/^resident_pass:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(passIdRaw)) {
  return finish(400, "RESIDENT_CLIENT_REQUEST_INVALID", "Некорректный идентификатор пропуска");
}

const configuredStatusPath = readEnv("RESIDENT_CLIENT_CUP_PASS_STATUS_PATH");
if (!configuredStatusPath) {
  return unavailable("Проверка состояния пропуска недоступна");
}
// The path is server config, never client input: same-origin path only, no authority.
const normalizedStatusPath = configuredStatusPath.replace(/\/+$/, "");
if (!/^\/(?!\/)[A-Za-z0-9._\-\/]*$/.test(normalizedStatusPath)) {
  return finish(503, "RESIDENT_CLIENT_NOT_CONFIGURED", "Сервис пропусков не настроен");
}
const statusPath = normalizedStatusPath + "/";

const correlationHeader = toStr(reqHeaders["x-correlation-id"]);
const correlationId = correlationHeader && correlationHeader.length >= 8 && correlationHeader.length <= 128
  ? correlationHeader
  : "residency-pass-status:" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffff).toString(16);

const userinfoUrl = readEnv("RESIDENT_CLIENT_KEYCLOAK_USERINFO_URL")
  || "https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/userinfo";

msg._residentPass = {
  endpoint: "status",
  correlationId,
  passId: passIdRaw,
  statusPath,
  authorization: authHeader,
  startedAt: Date.now(),
};
scrubRequestAuthorization();
msg.method = "GET";
msg.url = userinfoUrl;
msg.headers = { Authorization: authHeader, Accept: "application/json" };
msg.payload = null;
msg.requestTimeout = 10000;
msg.followRedirects = false;
msg.maxRedirects = 0;
delete msg.statusCode;
delete msg.error;
return [msg, null];

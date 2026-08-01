const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    Vary: "Authorization",
  };
  msg.payload = { ok: false, code, error };
  return [null, msg, msg];
};

const req = isObj(msg.req) ? msg.req : {};
const headers = isObj(req.headers) ? req.headers : {};
const authHeader = toStr(headers.authorization || headers.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return respond(401, "CHAT_AUTH_TOKEN_REQUIRED", "Необходимо войти в личный кабинет");
}

const method = String(req.method || msg.method || "GET").trim().toUpperCase();
const rawPath = toStr(
  req.route?.path
  || req.path
  || req._parsedUrl?.pathname
  || req.originalUrl
  || req.url,
) || "";
const pathname = rawPath.split("?", 1)[0].replace(/\/+$/u, "") || "/";

let routeKind = null;
if (method === "POST" && /^\/lk\/games\/(?:[^/]+|:gameId)\/chat\/messages$/u.test(pathname)) {
  routeKind = "send";
} else if (method === "GET" && /^\/lk\/games\/(?:[^/]+|:gameId)\/chat\/messages$/u.test(pathname)) {
  routeKind = "get";
} else if (method === "POST" && /^\/lk\/games\/(?:[^/]+|:gameId)\/chat\/read$/u.test(pathname)) {
  routeKind = "read";
} else if (method === "GET" && pathname === "/lk/chats/by-phone") {
  routeKind = "list";
}

if (!routeKind) {
  return respond(404, "CHAT_ROUTE_UNSUPPORTED", "Маршрут чата не поддерживается");
}

msg._chatAuth = {
  routeKind,
  authHeader,
  requestPayload: isObj(msg.payload) ? msg.payload : {},
};
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = undefined;

return [msg, null, msg];

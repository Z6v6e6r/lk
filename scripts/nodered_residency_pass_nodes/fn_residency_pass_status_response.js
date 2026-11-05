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

const respond = (statusCode, payload) => {
  scrubContext();
  msg.statusCode = statusCode;
  msg.headers = jsonHeaders();
  msg.payload = payload;
  return msg;
};
const fail = (statusCode, code, message) => respond(statusCode, { code, message });
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
  return isObj(payload) ? payload : null;
};
const nullableIso = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

const ctx = isObj(msg._residentPass) ? msg._residentPass : null;
const upstreamStatus = Number(msg.statusCode) || 0;
if (msg.error || upstreamStatus === 0) {
  warn("residency_pass_status_failed", "RESIDENT_CLIENT_UPSTREAM_TIMEOUT", {
    endpoint: "status",
    httpStatus: 504,
    durationMs: durationMs(ctx),
  });
  return fail(504, "RESIDENT_CLIENT_UPSTREAM_TIMEOUT", "Проверка пропуска не ответила вовремя");
}
const payload = parsePayload();
if (upstreamStatus === 401 || upstreamStatus === 403) {
  return fail(401, "RESIDENT_CLIENT_AUTH_REQUIRED", "Сессия истекла. Войдите снова");
}
if (upstreamStatus === 404) {
  const upstreamCode = toStr(payload?.error?.code) || toStr(payload?.code);
  return fail(404, upstreamCode === "RESIDENT_PASS_NOT_FOUND" ? upstreamCode : "RESIDENT_PASS_NOT_FOUND", "Пропуск не найден");
}
if (upstreamStatus < 200 || upstreamStatus >= 300 || !payload) {
  warn("residency_pass_status_failed", "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", {
    endpoint: "status",
    httpStatus: 503,
    upstreamStatus,
    durationMs: durationMs(ctx),
  });
  return fail(503, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE", "Состояние пропуска временно недоступно");
}

const state = (toStr(payload.state) || "").toUpperCase();
if (!["ACTIVE", "CONSUMED", "EXPIRED"].includes(state)) {
  return fail(503, "RESIDENT_CLIENT_UPSTREAM_INVALID", "Некорректное состояние пропуска");
}
const stationId = toStr(payload.stationId);
if (stationId && (stationId.length > 200 || /[\s\x00-\x1f\x7f]/.test(stationId))) {
  return fail(503, "RESIDENT_CLIENT_UPSTREAM_INVALID", "Некорректное состояние пропуска");
}
return respond(200, {
  schemaVersion: 1,
  statusAvailable: true,
  state,
  issuedAt: nullableIso(payload.issuedAt),
  expiresAt: nullableIso(payload.expiresAt),
  consumedAt: nullableIso(payload.consumedAt),
  stationId: stationId || null,
});

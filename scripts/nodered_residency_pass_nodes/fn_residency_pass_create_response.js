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

const PASSTHROUGH_CODES = new Set([
  "RESIDENT_PASS_NOT_FOUND",
  "RESIDENT_PASS_INVALID",
  "RESIDENT_PASS_EXPIRED",
  "RESIDENT_PASS_ALREADY_USED",
  "RESIDENT_NOT_ACTIVE",
  "RESIDENT_TERM_EXPIRED",
  "RESIDENT_EVIDENCE_STALE",
  "RESIDENT_EVIDENCE_INVALID",
  "RESIDENT_MAPPING_NOT_CURRENT",
  "RESIDENT_MAPPING_STALE",
  "RESIDENT_POLICY_NOT_CURRENT",
  "RESIDENT_TYPE_NOT_FOUND",
  "RESIDENT_INSTANCE_NOT_FOUND",
  "RESIDENT_SERVICES_DISABLED",
  "RESIDENT_SERVICES_NOT_CONFIGURED",
  "RESIDENT_SERVICES_INTEGRATION_FORBIDDEN",
  "RESIDENT_SERVICES_PERSISTENCE_UNAVAILABLE",
  "RESIDENT_SERVICES_CONFIG_INVALID",
  "RESIDENT_SERVICES_REQUEST_INVALID",
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR"
]);
const SAFE_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503, 504]);
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
const isIsoDate = (value) => {
  const text = toStr(value);
  if (!text || text.length > 64) return false;
  return Number.isFinite(Date.parse(text));
};

const ctx = isObj(msg._residentPass) ? msg._residentPass : null;
const upstreamStatus = Number(msg.statusCode) || 0;
if (msg.error || upstreamStatus === 0) {
  warn("residency_pass_failed", "RESIDENT_CLIENT_UPSTREAM_TIMEOUT", {
    endpoint: "create",
    httpStatus: 504,
    durationMs: durationMs(ctx),
  });
  return fail(504, "RESIDENT_CLIENT_UPSTREAM_TIMEOUT", "Выдача пропуска не ответила вовремя");
}
const payload = parsePayload();
if (upstreamStatus < 200 || upstreamStatus >= 300) {
  const upstreamCode = toStr(payload?.error?.code) || toStr(payload?.code);
  const code = upstreamCode && PASSTHROUGH_CODES.has(upstreamCode)
    ? upstreamCode
    : "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE";
  const statusCode = SAFE_STATUSES.has(upstreamStatus) ? upstreamStatus : 503;
  warn("residency_pass_failed", code, {
    endpoint: "create",
    httpStatus: statusCode,
    upstreamStatus,
    durationMs: durationMs(ctx),
  });
  return fail(statusCode, code, "Не удалось выдать пропуск");
}
if (!payload) {
  warn("residency_pass_failed", "RESIDENT_CLIENT_UPSTREAM_INVALID", {
    endpoint: "create",
    httpStatus: 503,
    upstreamStatus,
    durationMs: durationMs(ctx),
  });
  return fail(503, "RESIDENT_CLIENT_UPSTREAM_INVALID", "Некорректный ответ сервиса пропусков");
}

const passId = toStr(payload.passId);
const passToken = toStr(payload.token);
const tripInstanceId = toStr(payload.subscriptionInstanceId);
const residency = isObj(payload.residency) ? payload.residency : null;
const valid = passId
  && /^resident_pass:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(passId)
  && passToken
  && /^rsp1_[A-Za-z0-9_-]{16,}$/.test(passToken)
  && tripInstanceId
  && /^subscription_instance:[A-Za-z0-9._:-]{1,200}$/.test(tripInstanceId)
  && isIsoDate(payload.issuedAt)
  && isIsoDate(payload.expiresAt)
  && Date.parse(payload.expiresAt) > Date.parse(payload.issuedAt)
  && residency
  && toStr(residency.subscriptionTypeId)
  && toStr(residency.activeFrom)
  && toStr(residency.activeTo)
  && isIsoDate(residency.activeFrom)
  && isIsoDate(residency.activeTo);
if (!valid) {
  warn("residency_pass_failed", "RESIDENT_CLIENT_UPSTREAM_INVALID", {
    endpoint: "create",
    httpStatus: 503,
    upstreamStatus,
    durationMs: durationMs(ctx),
  });
  return fail(503, "RESIDENT_CLIENT_UPSTREAM_INVALID", "Некорректный ответ сервиса пропусков");
}

warn("residency_pass_created", "RESIDENT_PASS_CREATED", {
  endpoint: "create",
  httpStatus: 200,
  durationMs: durationMs(ctx),
  ttlSeconds: Math.round((Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)) / 1000),
});
return respond(200, {
  schemaVersion: 1,
  passId,
  passToken,
  issuedAt: new Date(Date.parse(payload.issuedAt)).toISOString(),
  expiresAt: new Date(Date.parse(payload.expiresAt)).toISOString(),
  subscriptionInstanceId: tripInstanceId,
  residency: {
    subscriptionTypeId: toStr(residency.subscriptionTypeId),
    subscriptionTypeTitle: toStr(residency.subscriptionTypeTitle),
    activeFrom: new Date(Date.parse(residency.activeFrom)).toISOString(),
    activeTo: new Date(Date.parse(residency.activeTo)).toISOString(),
  },
});

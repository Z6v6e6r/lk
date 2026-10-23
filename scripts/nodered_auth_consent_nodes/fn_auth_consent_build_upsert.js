// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "auth_verify", { sourceHash: "29cfbd1854788b26632f348f20ea10e21f52481073b397dbeef49a66d03a9981", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
try { if (typeof global !== "undefined") global.get("lkDiagnostics")?.upstream(msg, "auth_verify"); } catch { /* no-throw */ }
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
const upstreamStatus = Number(msg.statusCode);
const safeUpstreamStatus = Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599
  ? upstreamStatus : null;
const contentType = typeof msg.headers?.["content-type"] === "string"
  ? msg.headers["content-type"].trim().toLowerCase() : "";
const responseType = !contentType ? "missing"
  : /^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/.test(contentType) ? "json"
    : /^text\/html(?:;|$)/.test(contentType) ? "html"
      : /^text\//.test(contentType) ? "text" : "other";
const fail = (statusCode, error, code, reason) => {
  lkDiagnostic({ code, reason, httpStatus: statusCode, upstreamStatus: safeUpstreamStatus, responseKind: typeof msg.payload === "string" ? "text" : "object", subjectPresent: typeof msg.payload?.sub === "string" });
  // Fixed enums only: never log the bearer, claims, headers, body or subject.
  if (typeof node !== "undefined" && typeof node?.warn === "function") {
    try { node.warn(JSON.stringify({ event: "auth_consent_verification_failed", code, reason,
      upstreamStatus: safeUpstreamStatus, responseType, retryable: statusCode === 503 })); } catch { /* no-throw */ }
  }
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { error, code };
  return [null, msg];
};

const consent = isObj(msg._authConsent) ? msg._authConsent : null;
if (!consent) return fail(500, "Consent context is missing", "CONSENT_CONTEXT_MISSING", "context_missing");

if (msg.error || safeUpstreamStatus === null) {
  return fail(503, "Authentication service is unavailable", "AUTH_SERVICE_UNAVAILABLE", "transport_error");
}
if (safeUpstreamStatus === 401 || safeUpstreamStatus === 403) {
  return fail(401, "Bearer token is invalid or expired", "AUTH_TOKEN_INVALID", "upstream_unauthorized");
}
if (safeUpstreamStatus < 200 || safeUpstreamStatus >= 300) {
  return fail(503, "Authentication service is unavailable", "AUTH_SERVICE_UNAVAILABLE", "upstream_status");
}
let claims = msg.payload;
if (typeof claims === "string") {
  if (!claims.trim() || claims.length > 65536) {
    return fail(503, "Authentication service returned an invalid response", "AUTH_SERVICE_UNAVAILABLE", "json_invalid");
  }
  try { claims = JSON.parse(claims); }
  catch { return fail(503, "Authentication service returned an invalid response", "AUTH_SERVICE_UNAVAILABLE", "json_invalid"); }
}
const subject = isObj(claims) && typeof claims.sub === "string" ? toStr(claims.sub) : null;
if (!subject) {
  return fail(503, "Authentication service returned invalid claims", "AUTH_SERVICE_UNAVAILABLE", "claims_invalid");
}

const tenantKey = "iSkq6G";
const expectedClientId = "widget";
const tokenContext = isObj(consent.verifiedTokenContext) ? consent.verifiedTokenContext : {};
const authorizedParty = toStr(tokenContext.authorizedParty)
  || toStr(claims.azp)
  || toStr(claims.client_id)
  || toStr(claims.clientId);
if (authorizedParty !== expectedClientId) {
  return fail(403, "Bearer token belongs to another client", "AUTH_CLIENT_MISMATCH", "client_mismatch");
}
const verifiedTenantKey = toStr(tokenContext.tenantKey)
  || toStr(claims.tenantKey)
  || toStr(claims.tenant_key)
  || toStr(claims.tenant);
if (verifiedTenantKey !== tenantKey) {
  return fail(403, "Bearer token belongs to another tenant", "AUTH_TENANT_MISMATCH", "tenant_mismatch");
}
const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const acceptedAtClientTs = Date.parse(String(consent.acceptedAtClient || ""));
const acceptedAtClient = Number.isFinite(acceptedAtClientTs) ? new Date(acceptedAtClientTs) : null;
const safeSubject = encodeURIComponent(subject);
const id = `auth-consent:${tenantKey}:${safeSubject}:${consent.documentSetVersion}`;
const forwardedFor = toStr(msg.req?.headers?.["x-forwarded-for"]);
const clientIp = forwardedFor?.split(",")[0]?.trim() || msg.req?.ip || msg.req?.connection?.remoteAddress || null;

msg._authConsent = Object.assign({}, consent, {
  id,
  tenantKey,
  subject,
  recordedAt: nowIso,
});
msg.payload = [
  { _id: id },
  {
    $setOnInsert: {
      _id: id,
      id,
      schemaVersion: 1,
      tenantKey,
      issuer: "https://kc.vivacrm.ru/realms/clients",
      subject,
      documentSetVersion: consent.documentSetVersion,
      documents: consent.documents,
      acceptedAt: now,
      acceptedTs: nowTs,
      acceptedAtClient,
      authMethodReported: consent.authMethodReported || null,
      identity: {
        subject,
        userId: toStr(claims.userId) || toStr(claims.user_id) || toStr(claims.id),
        clientId: toStr(claims.clientId) || toStr(claims.client_id),
        phone: normPhone(claims.phone_number) || normPhone(claims.phone),
        email: toStr(claims.email)?.toLowerCase() || null,
        username: toStr(claims.preferred_username) || toStr(claims.name),
      },
      tokenClaims: {
        issuer: toStr(claims.iss),
        audience: tokenContext.audience || claims.aud || null,
        authorizedParty,
        tenantKey: verifiedTenantKey,
      },
      request: {
        ip: clientIp,
        userAgent: toStr(msg.req?.headers?.["user-agent"]),
      },
      createdAt: now,
      createdTs: nowTs,
    },
  },
  { upsert: true },
];

return [msg, null];

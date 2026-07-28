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
const fail = (statusCode, error, code) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { error, code };
  return [null, msg];
};

const consent = isObj(msg._authConsent) ? msg._authConsent : null;
if (!consent) return fail(500, "Consent context is missing", "CONSENT_CONTEXT_MISSING");

const statusCode = Number(msg.statusCode || 0);
const claims = isObj(msg.payload) ? msg.payload : {};
const subject = toStr(claims.sub);
if (!statusCode || statusCode >= 500 || (msg.error && statusCode >= 200 && statusCode < 300)) {
  return fail(503, "Authentication service is unavailable", "AUTH_SERVICE_UNAVAILABLE");
}
if (statusCode < 200 || statusCode >= 300 || !subject) {
  return fail(401, "Bearer token is invalid or expired", "AUTH_TOKEN_INVALID");
}

const tenantKey = "iSkq6G";
const expectedClientId = "widget";
const tokenContext = isObj(consent.verifiedTokenContext) ? consent.verifiedTokenContext : {};
const authorizedParty = toStr(tokenContext.authorizedParty)
  || toStr(claims.azp)
  || toStr(claims.client_id)
  || toStr(claims.clientId);
if (authorizedParty !== expectedClientId) {
  return fail(403, "Bearer token belongs to another client", "AUTH_CLIENT_MISMATCH");
}
const verifiedTenantKey = toStr(tokenContext.tenantKey)
  || toStr(claims.tenantKey)
  || toStr(claims.tenant_key)
  || toStr(claims.tenant);
if (verifiedTenantKey !== tenantKey) {
  return fail(403, "Bearer token belongs to another tenant", "AUTH_TENANT_MISMATCH");
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

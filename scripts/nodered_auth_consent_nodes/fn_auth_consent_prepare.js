// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "auth_prepare", { sourceHash: "f30c967cc5d1556d226dd510d1749e687050e35c8e8cceeecfde98dece301451", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const decodeJwtPayload = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
  } catch {
    return {};
  }
};

const DOCUMENT_SET_VERSION = "2026-07-14";
const DOCUMENTS = [
  {
    id: "public-offer",
    title: "Публичная оферта",
    version: "2026-07-14",
    url: "https://padlhub.ru/docs",
  },
  {
    id: "personal-data-policy",
    title: "Политика обработки персональных данных",
    version: "2026-07-14",
    url: "https://padlhub.ru/politica",
  },
];
const fail = (statusCode, error, code) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { error, code };
  return [null, msg];
};

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return fail(401, "Bearer token is required", "AUTH_TOKEN_REQUIRED");
}

const body = isObj(msg.payload) ? msg.payload : {};
if (Number(body.schemaVersion) !== 1) {
  return fail(400, "Unsupported consent schema version", "CONSENT_SCHEMA_INVALID");
}
if (toStr(body.documentSetVersion) !== DOCUMENT_SET_VERSION) {
  return fail(400, "Unsupported consent document set version", "CONSENT_VERSION_INVALID");
}

const submittedDocuments = Array.isArray(body.documents) ? body.documents : [];
const documentsAreValid = DOCUMENTS.every((expected) => submittedDocuments.some((current) => (
  isObj(current)
  && toStr(current.id) === expected.id
  && toStr(current.version) === expected.version
  && toStr(current.url) === expected.url
  && current.accepted === true
)));
if (submittedDocuments.length !== DOCUMENTS.length || !documentsAreValid) {
  return fail(400, "Both canonical documents must be accepted", "CONSENT_DOCUMENTS_INVALID");
}

const authMethodRaw = toStr(body.authMethod)?.toLowerCase();
const authMethod = ["sms", "vkid", "yandex"].includes(authMethodRaw) ? authMethodRaw : null;
const accessToken = authHeader.replace(/^Bearer\s+/i, "");
const tokenPayload = decodeJwtPayload(accessToken);

msg._authConsent = {
  documentSetVersion: DOCUMENT_SET_VERSION,
  acceptedAtClient: toStr(body.acceptedAtClient),
  authMethodReported: authMethod,
  documents: DOCUMENTS,
  // Unverified hints only. No raw token/claims are emitted and these booleans
  // must never participate in authorization or provider-refusal classification.
  tokenDiagnosticFlags: {
    unverifiedHints: true,
    openidPresent: typeof tokenPayload.scope === "string" ? tokenPayload.scope.split(/\s+/).includes("openid") : null,
    expiredByClaim: typeof tokenPayload.exp === "number" && Number.isFinite(tokenPayload.exp)
      ? tokenPayload.exp * 1000 <= Date.now() : null,
    clientMatchesClaim: typeof tokenPayload.azp === "string" ? tokenPayload.azp === "widget" : null,
    issuerMatchesClaim: typeof tokenPayload.iss === "string"
      ? tokenPayload.iss === "https://kc.vivacrm.ru/realms/clients" : null,
  },
  verifiedTokenContext: {
    authorizedParty: toStr(tokenPayload.azp),
    audience: tokenPayload.aud || null,
    tenantKey: toStr(tokenPayload.tenantKey) || toStr(tokenPayload.tenant_key) || toStr(tokenPayload.tenant),
  },
};
msg.method = "GET";
msg.url = "https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/userinfo";
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = null;
msg.requestTimeout = 10000;
msg.followRedirects = false;
msg.maxRedirects = 0;
delete msg.error;
delete msg.statusCode;

return [msg, null];

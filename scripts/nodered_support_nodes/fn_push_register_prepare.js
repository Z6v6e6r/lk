const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const normEmail = (value) => {
  const email = toStr(value)?.toLowerCase();
  return email && email.includes("@") ? email : null;
};
const decodeBase64Url = (value) => {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const full = normalized + pad;
  try {
    return Buffer.from(full, "base64").toString("utf8");
  } catch {
    return null;
  }
};
const parseJwtPayload = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  const decoded = decodeBase64Url(parts[1]);
  if (!decoded) return {};
  try {
    const parsed = JSON.parse(decoded);
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const cleanObj = (value) => {
  if (!isObj(value)) return {};
  const result = {};
  Object.entries(value).forEach(([key, current]) => {
    if (current === undefined) return;
    result[key] = current;
  });
  return result;
};

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
const bearerToken = authHeader && /^Bearer\s+/i.test(authHeader)
  ? authHeader.replace(/^Bearer\s+/i, "").trim()
  : null;
const claims = bearerToken ? parseJwtPayload(bearerToken) : {};

const body = isObj(msg.payload) ? msg.payload : {};
const token = toStr(body.token);
if (!token) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "token is required" };
  return [null, msg, msg];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const tenantKey = toStr(body.tenantKey) || toStr(claims.tenantKey) || "iSkq6G";
const platform = toStr(body.platform)?.toLowerCase() || "android";

const subject = toStr(claims.sub);
const userId =
  toStr(body.userId)
  || toStr(claims.userId)
  || toStr(claims.user_id)
  || toStr(claims.id);
const clientId =
  toStr(body.clientId)
  || toStr(claims.clientId)
  || toStr(claims.client_id);
const username = toStr(body.username) || toStr(claims.preferred_username) || toStr(claims.name);
const email = normEmail(body.email) || normEmail(claims.email);
const phone = normPhone(body.phone) || normPhone(claims.phone_number) || normPhone(claims.phone);

const identityKeys = uniq([
  subject ? `subject:${subject}` : null,
  userId ? `user:${userId}` : null,
  clientId ? `client:${clientId}` : null,
  username ? `username:${username.toLowerCase()}` : null,
  email ? `email:${email}` : null,
  phone ? `phone:${phone}` : null,
  ...((Array.isArray(body.identityKeys) ? body.identityKeys : [])
    .map((value) => toStr(value))
    .filter(Boolean)),
]);

const docId = `push:${tenantKey}:${token}`;
const setDoc = cleanObj({
  token,
  tenantKey,
  platform,
  channel: "FCM",
  appVersion: toStr(body.appVersion),
  timezone: toStr(body.timezone),
  userAgent: toStr(body.userAgent),
  subject,
  userId,
  clientId,
  username,
  email,
  phone,
  identityKeys,
  active: true,
  registeredAt: toStr(body.registeredAt) || nowIso,
  registeredTs: nowTs,
  unregisteredAt: null,
  updatedAt: nowIso,
  updatedTs: nowTs,
  claims: cleanObj({
    iss: toStr(claims.iss),
    aud: toStr(claims.aud),
    azp: toStr(claims.azp),
    scope: toStr(claims.scope),
  }),
});

msg._pushRegister = {
  id: docId,
  token,
  tenantKey,
  platform,
  identityKeys,
};

msg.payload = [
  { id: docId },
  {
    $set: setDoc,
    $setOnInsert: {
      id: docId,
      createdAt: nowIso,
      createdTs: nowTs,
    },
  },
  { upsert: true },
];

return [msg, null, msg];

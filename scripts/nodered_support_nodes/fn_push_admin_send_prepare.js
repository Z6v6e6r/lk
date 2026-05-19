const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const toInt = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};
const parseBool = (value) => {
  if (typeof value === "boolean") return value;
  const normalized = toStr(value)?.toLowerCase();
  if (!normalized) return false;
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};
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
const toDataMap = (value) => {
  if (!isObj(value)) return {};
  const result = {};
  Object.entries(value).forEach(([key, current]) => {
    const safeKey = toStr(key);
    if (!safeKey) return;
    if (current === null || current === undefined) return;
    result[safeKey] = String(current);
  });
  return result;
};
const toTokenArray = (value) => {
  if (Array.isArray(value)) {
    return uniq(value.map((item) => toStr(item)));
  }
  const single = toStr(value);
  if (!single) return [];
  if (!single.includes(",")) return [single];
  return uniq(single.split(",").map((item) => toStr(item)));
};

const body = isObj(msg.payload) ? msg.payload : {};
const title = toStr(body.title);
const text = toStr(body.body) || toStr(body.text) || toStr(body.message);
const data = toDataMap(body.data);
const channelId = toStr(body.androidChannelId || body.channelId) || "lk_default";
const dryRun = parseBool(body.dryRun);
const tenantKey = toStr(body.tenantKey);

if (!title && !text && Object.keys(data).length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Provide title, body or data payload" };
  return [null, null, msg, msg];
}

const explicitTokens = uniq([
  ...toTokenArray(body.token),
  ...toTokenArray(body.tokens),
]);

const maxRecipients = Math.min(100, Math.max(1, toInt(body.limit, 20)));
const allowBroadcast = parseBool(body.allowBroadcast);
const userId = toStr(body.userId);
const clientId = toStr(body.clientId);
const subject = toStr(body.subject);
const username = toStr(body.username);
const identityKey = toStr(body.identityKey);
const phone = normPhone(body.phone);
const email = normEmail(body.email);

const requestId =
  toStr(body.requestId)
  || `push_admin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

msg._pushAdminSend = {
  requestId,
  tenantKey,
  title,
  body: text,
  data,
  dryRun,
  channelId,
  maxRecipients,
  allowBroadcast,
  directTokens: explicitTokens,
};

if (explicitTokens.length > 0) {
  msg.payload = explicitTokens;
  return [null, msg, null, msg];
}

const query = { active: true };
if (tenantKey) query.tenantKey = tenantKey;

const filters = [];
if (userId) {
  filters.push({ userId });
  filters.push({ identityKeys: `user:${userId}` });
}
if (clientId) {
  filters.push({ clientId });
  filters.push({ identityKeys: `client:${clientId}` });
}
if (subject) {
  filters.push({ subject });
  filters.push({ identityKeys: `subject:${subject}` });
}
if (username) {
  filters.push({ username });
  filters.push({ identityKeys: `username:${username.toLowerCase()}` });
}
if (identityKey) {
  filters.push({ identityKeys: identityKey });
}
if (phone) {
  filters.push({ phone });
  filters.push({ identityKeys: `phone:${phone}` });
}
if (email) {
  filters.push({ email });
  filters.push({ identityKeys: `email:${email}` });
}

if (filters.length > 0) {
  query.$or = filters;
} else if (!allowBroadcast) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "Specify token or recipient filter (userId/clientId/phone/email) or set allowBroadcast=true",
  };
  return [null, null, msg, msg];
}

msg.payload = query;
return [msg, null, null, msg];

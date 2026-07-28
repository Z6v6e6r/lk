const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const body = isObj(msg.payload) ? msg.payload : {};
const token = toStr(body.token);
if (!token) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "token is required" };
  return [null, msg, msg];
}

const tenantKey = toStr(body.tenantKey);
const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const query = tenantKey
  ? { token, tenantKey }
  : { token };

msg._pushUnregister = {
  token,
  tenantKey: tenantKey || null,
};

msg.payload = [
  query,
  {
    $set: {
      active: false,
      unregisteredAt: toStr(body.unregisteredAt) || nowIso,
      updatedAt: nowIso,
      updatedTs: nowTs,
    },
  },
  { upsert: false },
];

return [msg, null, msg];

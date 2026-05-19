const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const uniq = (values) => Array.from(new Set(values.filter(Boolean)));
const toArray = (value) => (Array.isArray(value) ? value : []);

const ctx = isObj(msg._pushAdminSend) ? msg._pushAdminSend : null;
if (!ctx) {
  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Push admin context is missing" };
  return [null, msg, msg];
}

const rows = toArray(msg.payload).filter((item) => isObj(item));
const tokens = uniq(
  (Array.isArray(ctx.directTokens) && ctx.directTokens.length > 0
    ? ctx.directTokens
    : rows.map((row) => toStr(row.token)))
    .map((token) => toStr(token)),
).slice(0, Math.max(1, Number(ctx.maxRecipients || 20)));

if (tokens.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "No active push tokens matched recipient filter",
    requestId: ctx.requestId || null,
  };
  return [null, msg, msg];
}

msg._pushAdminSend = Object.assign({}, ctx, {
  resolvedTokens: tokens,
  matchedRows: rows.length,
});

msg.payload = {
  tokensCount: tokens.length,
  matchedRows: rows.length,
};

return [msg, null, msg];

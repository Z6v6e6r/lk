const result = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
const created = Boolean(result?.upsertedId) || Number(result?.upsertedCount || 0) > 0;
msg.statusCode = created ? 201 : 200;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};
msg.payload = {
  ok: true,
  id: msg._authConsent?.id || null,
  tenantKey: msg._authConsent?.tenantKey || null,
  documentSetVersion: msg._authConsent?.documentSetVersion || null,
  recordedAt: msg._authConsent?.recordedAt || new Date().toISOString(),
  created,
  idempotent: true,
};
return msg;

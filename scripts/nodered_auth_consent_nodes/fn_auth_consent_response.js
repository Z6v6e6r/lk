// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "auth_response", { sourceHash: "60195cb100b8a087484a31212d28058da1e0fe491a75cd22236677f5cdc1c89a", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
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

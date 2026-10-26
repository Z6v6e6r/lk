// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "onboarding_put", { sourceHash: "6450a240a3387e69fba21f4bafabf1eacdd3d40047c14d6a7ab477b1f57970f2", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
try { if (typeof global !== "undefined") global.get("lkDiagnostics")?.upstream(msg, "onboarding_put"); } catch { /* no-throw */ }
try {
  const p = msg.payload;
  const ct = msg.headers?.["content-type"] || "";
  let parseOk;
  const parseAttempted = typeof p === "string" && p.length <= 65536;
  if (parseAttempted) { try { JSON.parse(p); parseOk = true; } catch { parseOk = false; } }
  lkDiagnostic({ code: "UPSTREAM_OBSERVED", upstreamStatus: msg.statusCode,
    contentTypeClass: ct.includes("json") ? "json" : ct.startsWith("text/") ? "text" : ct ? "other" : "missing",
    sizeBucket: typeof p !== "string" ? "UNKNOWN" : p.length === 0 ? "empty" : p.length < 1024 ? "lt1k" : p.length < 65536 ? "lt64k" : "large",
    parseAttempted, parseOk });
} catch { /* no-throw */ }
const update = msg._vivaFieldUpdate && typeof msg._vivaFieldUpdate === 'object'
  ? msg._vivaFieldUpdate
  : {};
const httpStatus = Number(msg.statusCode || 0) || null;
const responsePayload = msg.payload;
const explicitError = responsePayload && typeof responsePayload === 'object'
  ? (responsePayload.error || responsePayload.message || null)
  : null;
const ok = !explicitError && httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

msg.payload = {
  fieldId: update.fieldId || null,
  requestedValue: update.requestedValue || null,
  httpStatus,
  ok,
  error: ok ? null : (explicitError || (httpStatus ? `Viva PUT failed with HTTP ${httpStatus}` : 'Viva PUT failed')),
  response: responsePayload ?? null,
};
delete msg._vivaFieldUpdate;
return msg;

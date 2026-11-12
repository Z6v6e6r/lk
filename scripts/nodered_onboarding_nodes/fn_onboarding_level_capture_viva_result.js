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
// ret=obj leaves the original string in place when the HTTP node cannot parse it.
// Do not reinterpret a JSON string/scalar as an acknowledgement. Node-RED maps
// a real 204 to {}, while bare function callers may represent no content as null/''.
const jsonPayload = Array.isArray(responsePayload)
  || (responsePayload !== null && Object.prototype.toString.call(responsePayload) === '[object Object]');
const noContent = httpStatus === 204 && (responsePayload == null || responsePayload === ''
  || (jsonPayload && !Array.isArray(responsePayload) && Object.keys(responsePayload).length === 0));
const responseValid = httpStatus === 204 ? noContent : jsonPayload;
const ok = !msg.error && !explicitError && responseValid
  && httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

// BEGIN bounded onboarding refusal diagnostic (no business state or response changes).
if (!ok) {
  try {
    // Independent of the optional shared observer: installed settings may lack it.
    // No timers or per-client keys; only three bounded numbers live in node context.
    if (typeof node !== 'undefined' && typeof node.log === 'function'
      && typeof context !== 'undefined' && typeof context.get === 'function' && typeof context.set === 'function') {
      const key = 'onboardingPutDiagnosticBudgetV1';
      const now = Date.now();
      const stored = context.get(key);
      const validBudget = stored && Number.isSafeInteger(stored.startedAt) && stored.startedAt >= 0
        && Number.isInteger(stored.emitted) && stored.emitted >= 0 && stored.emitted <= 20
        && Number.isInteger(stored.suppressed) && stored.suppressed >= 0 && stored.suppressed <= 1000000;
      if (Number.isSafeInteger(now) && now >= 0 && (stored == null || validBudget)) {
        const expired = validBudget && now - stored.startedAt >= 60000;
        const suppressedCount = expired ? stored.suppressed : 0;
        const budget = stored == null || expired
          ? { startedAt: now, emitted: 0, suppressed: 0 }
          : { startedAt: stored.startedAt, emitted: stored.emitted, suppressed: stored.suppressed };
        // A backwards clock does not reset the budget. Consume before logging so a
        // throwing sink cannot cause unlimited retries of diagnostic emission.
        const admitted = budget.emitted < 20;
        if (admitted) budget.emitted += 1;
        else budget.suppressed = Math.min(1000000, budget.suppressed + 1);
        context.set(key, budget);
        if (admitted) {
          const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
          const ct = msg.headers?.['content-type'];
          const mime = typeof ct === 'string' && ct.length <= 256 ? ct.split(';', 1)[0].trim().toLowerCase() : '';
          const contentTypeClass = ct == null || ct === '' ? 'missing'
            : mime === 'text/html' || mime === 'application/xhtml+xml' ? 'html'
              : mime === 'application/json' || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mime) ? 'json'
                : mime.startsWith('text/') ? 'text' : 'other';
          const responseKind = typeof responsePayload === 'string' ? 'text'
            : jsonPayload ? (Array.isArray(responsePayload) ? 'array' : 'object')
              : responsePayload === null ? 'null' : responsePayload === undefined ? 'missing'
                : typeof responsePayload === 'boolean' ? 'boolean' : typeof responsePayload === 'number' ? 'number' : 'other';
          let bodyClass = jsonPayload ? (Array.isArray(responsePayload) ? 'json_array' : 'json_object')
            : responsePayload == null ? 'missing'
              : typeof responsePayload === 'boolean' || (typeof responsePayload === 'number' && Number.isFinite(responsePayload)) ? 'json_scalar' : 'other';
          let sizeBucket = 'UNKNOWN';
          let parseAttempted = false;
          let parseOk = null;
          if (typeof responsePayload === 'string') {
            const size = responsePayload.length;
            sizeBucket = size === 0 ? 'empty' : size < 1024 ? 'lt1k' : size <= 65536 ? 'lt64k' : 'large';
            bodyClass = size === 0 ? 'empty' : size > 65536 ? 'oversize' : 'invalid_json';
            if (size <= 65536) {
              parseAttempted = true;
              try {
                const parsed = JSON.parse(responsePayload);
                parseOk = true;
                // Classify only; a parsed string never becomes a business acknowledgement.
                bodyClass = parsed === null || typeof parsed !== 'object' ? 'json_scalar'
                  : Array.isArray(parsed) ? 'json_array' : 'json_object';
              } catch { parseOk = false; }
            }
          }
          node.log(JSON.stringify({
            event: 'onboarding_level_projection_refused', schemaVersion: 1, stage: 'onboarding_put',
            upstreamStatus: status, contentTypeClass, responseKind, bodyClass, sizeBucket, parseAttempted, parseOk,
            refusalReason: msg.error ? 'transport_error' : status === null ? 'status_unknown'
              : status < 200 || status >= 300 ? 'upstream_status' : explicitError ? 'provider_error'
                : !responseValid ? 'acknowledgement_invalid' : 'UNKNOWN',
            projectionStatus: 'FAILED', suppressedCount,
          }));
        }
      }
    }
  } catch { /* Optional diagnostics must never change fail-closed execution. */ }
}
// END bounded onboarding refusal diagnostic.

msg.payload = {
  fieldId: update.fieldId || null,
  requestedValue: update.requestedValue || null,
  httpStatus,
  ok,
  error: ok ? null : (explicitError || (!responseValid && httpStatus >= 200 && httpStatus < 300
    ? 'Viva PUT response acknowledgement is invalid'
    : (httpStatus ? `Viva PUT failed with HTTP ${httpStatus}` : 'Viva PUT failed'))),
  response: responsePayload ?? null,
};
delete msg._vivaFieldUpdate;
return msg;

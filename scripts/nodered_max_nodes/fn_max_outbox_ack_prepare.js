// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "max_ack_prepare", { sourceHash: "048b78a5bfea883f51d5d40ca8240cf9aa0b20a631259cc199972dfe32f0d331", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const command = isObj(msg.supportOutbox) ? msg.supportOutbox : (isObj(msg.payload?.supportOutbox) ? msg.payload.supportOutbox : null);
if (!command || !command.id) {
  return null;
}

lkDiagnostic({ connector: command.connector, leaseAttempt: command.attempts, code: "UPSTREAM_OBSERVED", outcome: "outcome_unknown", botIdentityKnown: false, accessEvidenceKnown: false });
const apiBase = (() => {
  try {
    return toStr(env.get("SUPPORT_API_BASE_URL"));
  } catch {
    return null;
  }
})();
const integrationToken = (() => {
  try {
    return toStr(env.get("SUPPORT_INTEGRATION_TOKEN"));
  } catch {
    return null;
  }
})();

const baseUrl = apiBase || "http://127.0.0.1:3000/api";
msg.method = "POST";
msg.url = `${baseUrl}/support/outbox/${encodeURIComponent(command.id)}/ack`;
msg.headers = Object.assign(
  { "Content-Type": "application/json", Accept: "application/json" },
  integrationToken ? { "x-integration-token": integrationToken } : {},
);
msg.payload = {};
return msg;

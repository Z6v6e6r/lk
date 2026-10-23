// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "max_ingress", { sourceHash: "5442e6b8886b43e9c47788ec301bc94dd86cf965843e20bd7545f9372164ee4b", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const update = isObj(msg.maxUpdate) ? msg.maxUpdate : null;
if (!update) {
  return null;
}

try {
  if (typeof global !== "undefined") {
    const diagnostics = global.get("lkDiagnostics");
    diagnostics?.observe(msg, "max_ingress", { connector: "MAX_BOT", targetPresent: Boolean(update.recipient?.chatId || update.sender?.userId), targetSource: "inbound", targetType: update.recipient?.chatId ? "chat" : update.sender?.userId ? "user" : "UNKNOWN",
      bindingRef: diagnostics.ref("binding", String(update.recipient?.chatId || update.sender?.userId || "")), botIdentityKnown: false, accessEvidenceKnown: false });
  }
} catch { /* no-throw */ }
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
const queryParts = [];
const addQuery = (key, value) => {
  const normalized = toStr(value);
  if (!normalized) {
    return;
  }
  queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(normalized)}`);
};

addQuery("channel", "MAX");
addQuery("connector", "MAX_BOT");
addQuery("channelUserId", update.sender?.userId);
addQuery("userId", update.sender?.userId);
addQuery("chatId", update.recipient?.chatId);
addQuery("externalUserId", update.sender?.userId);
addQuery("externalChatId", update.recipient?.chatId);
addQuery("phone", update.contact?.phone);

msg.method = "GET";
msg.url = `${baseUrl}/support/clients/resolve${queryParts.length ? `?${queryParts.join("&")}` : ""}`;
msg.headers = Object.assign(
  { Accept: "application/json" },
  integrationToken ? { "x-integration-token": integrationToken } : {},
);
return msg;

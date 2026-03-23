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

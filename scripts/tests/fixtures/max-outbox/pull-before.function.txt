const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

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
msg.method = "GET";
msg.url = `${baseUrl}/support/outbox/pull?connector=MAX_BOT&limit=10&leaseSec=60`;
msg.headers = Object.assign(
  { Accept: "application/json" },
  integrationToken ? { "x-integration-token": integrationToken } : {},
);
return msg;

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

addQuery("connector", "MAX_BOT");
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

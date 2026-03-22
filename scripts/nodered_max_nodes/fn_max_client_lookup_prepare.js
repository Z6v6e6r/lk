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

const baseUrl = apiBase || "http://127.0.0.1:1880";
const query = new URLSearchParams();
query.set("channel", "MAX");
if (update.recipient?.chatId) query.set("chatId", update.recipient.chatId);
if (update.sender?.userId) query.set("channelUserId", update.sender.userId);
if (update.contact?.phone) query.set("phone", update.contact.phone);

msg.method = "GET";
msg.url = `${baseUrl}/lk/support/clients/resolve?${query.toString()}`;
msg.headers = { Accept: "application/json" };
return msg;

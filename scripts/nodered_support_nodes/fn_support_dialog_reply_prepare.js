const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const dialogId = toStr(msg.req?.params?.dialogId);
if (!dialogId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "dialogId is required" };
  return [null, msg, msg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const text = toStr(body.text || body.message || body.content);
if (!text) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "text is required" };
  return [null, msg, msg];
}

msg._supportReply = {
  dialogId,
  text,
  adminUserId: toStr(body.adminUserId || body.userId),
  adminName: toStr(body.adminName || body.authorName) || "Администратор",
  channel: toStr(body.channel)?.toUpperCase() || null,
  metadata: isObj(body.metadata) ? body.metadata : {},
};

msg.payload = {
  id: dialogId,
  archived: { $ne: true },
};
return [msg, null, msg];

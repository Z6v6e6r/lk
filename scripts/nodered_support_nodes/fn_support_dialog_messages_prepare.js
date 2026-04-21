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

const q = msg.req?.query || {};
const limitRaw = Number(q.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100;
const beforeRaw = Number(q.beforeTs || q.before);
const beforeTs = Number.isFinite(beforeRaw) ? beforeRaw : Date.now() + 1;

msg._supportDialogMessages = { dialogId, limit, beforeTs };
msg.payload = {
  dialogId,
  deleted: { $ne: true },
  $or: [
    { createdTs: { $lt: beforeTs } },
    { createdTs: { $exists: false } },
    { createdTs: null },
  ],
};
return [msg, null, msg];

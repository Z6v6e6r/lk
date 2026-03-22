const toArray = (value) => (Array.isArray(value) ? value : []);

const ctx = msg._supportDialogMessages || { dialogId: null, limit: 100, beforeTs: Date.now() + 1 };
const rows = toArray(msg.payload)
  .filter((item) => item && typeof item === "object")
  .sort((left, right) => Number(left.createdTs || 0) - Number(right.createdTs || 0));

const sliced = rows.slice(Math.max(0, rows.length - ctx.limit));
const hasMore = rows.length > sliced.length;
const nextBeforeTs = sliced.length > 0 ? Number(sliced[0].createdTs || ctx.beforeTs) : null;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  dialogId: ctx.dialogId,
  totalFetched: sliced.length,
  hasMore,
  nextBeforeTs,
  messages: sliced,
};
return [msg, msg];

const toArray = (value) => (Array.isArray(value) ? value : []);
const toTs = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};
const parseIsoTs = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};
const resolveCreatedTs = (row) => {
  const direct =
    toTs(row?.createdTs)
    ?? toTs(row?.timestamp)
    ?? parseIsoTs(row?.createdAt);
  return Number.isFinite(direct) ? direct : 0;
};

const ctx = msg._supportDialogMessages || { dialogId: null, limit: 100, beforeTs: Date.now() + 1 };
const rows = toArray(msg.payload)
  .filter((item) => item && typeof item === "object")
  .map((item) => {
    const createdTs = resolveCreatedTs(item);
    if (toTs(item.createdTs) !== null) return item;
    return Object.assign({}, item, {
      createdTs,
    });
  })
  .filter((item) => resolveCreatedTs(item) < Number(ctx.beforeTs || Date.now() + 1))
  .sort((left, right) => resolveCreatedTs(left) - resolveCreatedTs(right));

const sliced = rows.slice(Math.max(0, rows.length - ctx.limit));
const hasMore = rows.length > sliced.length;
const nextBeforeTs = sliced.length > 0 ? resolveCreatedTs(sliced[0]) : null;

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

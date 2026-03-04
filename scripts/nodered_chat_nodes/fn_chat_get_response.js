const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._chatGet || { limit: 50, beforeTs: Date.now(), phone: null, gameId: null };

const sorted = rows
  .filter((row) => row && typeof row === "object")
  .sort((a, b) => Number(a.createdTs || 0) - Number(b.createdTs || 0));

const sliced = sorted.slice(Math.max(0, sorted.length - ctx.limit));
const hasMore = sorted.length > sliced.length;
const nextBeforeTs = sliced.length > 0 ? Number(sliced[0].createdTs || ctx.beforeTs) : null;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  gameId: ctx.gameId,
  phone: ctx.phone,
  totalFetched: sliced.length,
  hasMore,
  nextBeforeTs,
  messages: sliced,
};

return [msg, msg];

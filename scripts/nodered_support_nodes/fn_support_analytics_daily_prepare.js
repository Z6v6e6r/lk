const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const q = msg.req?.query || {};
const dateRaw = toStr(q.date);
const date = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
  ? dateRaw
  : new Date().toISOString().slice(0, 10);
const startTs = Date.parse(`${date}T00:00:00+03:00`);
const endTs = Date.parse(`${date}T23:59:59.999+03:00`) + 1;

msg._supportAnalytics = { date, startTs, endTs };
msg.payload = {
  createdTs: {
    $gte: startTs,
    $lt: endTs,
  },
  deleted: { $ne: true },
};
return [msg, null, msg];

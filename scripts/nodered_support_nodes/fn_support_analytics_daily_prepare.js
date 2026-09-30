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
if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "date is invalid" };
  return [null, msg, msg];
}

msg._supportAnalytics = { date, startTs, endTs };
msg.payload = {
  createdAt: {
    $gte: new Date(startTs).toISOString(),
    $lt: new Date(endTs).toISOString(),
  },
  deleted: { $ne: true },
};
return [msg, null, msg];

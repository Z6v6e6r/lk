const asArray = (value) => (Array.isArray(value) ? value : []);

const items = asArray(msg.payload).filter((item) => item && typeof item === "object");

const processed = items.length;
const cancelled = items.filter((item) => item.cancelledInLk === true).length;
const withVivaErrors = items.filter((item) => item.withVivaErrors === true).length;
const dryRun = processed > 0 && items.every((item) => item.dryRun === true);

const byReason = {};
items.forEach((item) => {
  const reason = String(item.reason || "UNKNOWN");
  byReason[reason] = (byReason[reason] || 0) + 1;
});

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  dryRun,
  processed,
  cancelled,
  withVivaErrors,
  byReason,
  now: new Date().toISOString(),
  items,
};

return [msg, msg];

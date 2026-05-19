const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (["1", "true", "yes", "y", "on", "dry", "force"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  return null;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    ok: false,
    error,
    details: details || null,
  };
  return [null, msg, msg];
};

const query = msg.req?.query && typeof msg.req.query === "object" ? msg.req.query : {};
const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};

const gameId = toStr(query.gameId ?? body.gameId);
const force = toBoolean(query.force ?? body.force) === true;
const dryRun = toBoolean(query.dryRun ?? body.dryRun) === true;
const limit = Math.max(
  1,
  Math.min(500, Math.floor(toNumber(query.limit ?? body.limit) ?? 200)),
);

const nowTs = Date.now();
const nowIso = new Date(nowTs).toISOString();

const mongoQuery = {
  archived: { $ne: true },
  status: { $nin: ["CANCELLED", "CANCELED"] },
  $or: [
    { "settings.payMode": "split" },
    { "metadata.splitPayment.enabled": true },
  ],
};
if (gameId) {
  mongoQuery.id = gameId;
}

msg._splitCleanupRequest = {
  nowTs,
  nowIso,
  dryRun,
  limit,
  force,
  gameId,
};
msg.payload = mongoQuery;

if (!msg._splitCleanupRequest || typeof msg._splitCleanupRequest !== "object") {
  return fail(500, "Failed to prepare split cleanup request context");
}

return [msg, null, msg];

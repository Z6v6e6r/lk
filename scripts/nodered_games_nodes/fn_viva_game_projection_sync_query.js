const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";
const MAX_LOOKAHEAD_DAYS = 14;
const DEFAULT_LOOKAHEAD_DAYS = 7;
const MAX_GAMES_PER_RUN = 1000;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const readEnv = (key) => {
  try { return toStr(env.get(key)); } catch (_error) { return null; }
};
const moscowDate = (timestamp) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const fail = (code) => {
  const lease = global.get(LEASE_KEY);
  const runId = msg._vivaProjectionSync?.runId;
  if (lease && typeof lease === "object" && lease.runId === runId) global.set(LEASE_KEY, null);
  msg.payload = {
    ok: false,
    source: "viva_game_projection_sync",
    code,
    runId: msg._vivaProjectionSync?.runId || null,
    at: new Date().toISOString(),
  };
  global.set("lk_viva_game_projection_sync_last_report", msg.payload);
  delete msg.vivaToken;
  return [null, msg];
};

const ctx = msg._vivaProjectionSync;
const tenantKey = readEnv("PADLHUB_PLATFORM_TENANT_KEY");
if (!ctx || !["SHADOW", "ENFORCE"].includes(ctx.mode) || !toStr(msg.vivaToken)) {
  return fail("RUN_CONTEXT_INVALID");
}
if (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  return fail("TENANT_CONFIG_INVALID");
}

const configuredDaysRaw = readEnv("VIVA_GAME_PROJECTION_SYNC_LOOKAHEAD_DAYS");
const configuredDays = configuredDaysRaw === null ? null : Number(configuredDaysRaw);
const lookaheadDays = configuredDays !== null && Number.isFinite(configuredDays)
  ? Math.max(1, Math.min(MAX_LOOKAHEAD_DAYS, Math.floor(configuredDays)))
  : DEFAULT_LOOKAHEAD_DAYS;
const now = Date.now();
const dateFrom = moscowDate(now);
const dateTo = moscowDate(now + lookaheadDays * 24 * 60 * 60 * 1000);
ctx.tenantKey = tenantKey;
ctx.dateFrom = dateFrom;
ctx.dateTo = dateTo;
ctx.maxGames = MAX_GAMES_PER_RUN;
ctx.lookaheadDays = lookaheadDays;
msg._vivaProjectionSync = ctx;
msg.payload = {
  tenantKey,
  archived: { $ne: true },
  status: { $nin: ["CANCELLED", "CANCELED"] },
  revision: { $type: "number" },
  "booking.date": { $gte: dateFrom, $lte: dateTo },
  "booking.timeFrom": { $type: "string", $ne: "" },
  "booking.timeTo": { $type: "string", $ne: "" },
  "booking.studioId": { $type: "string", $ne: "" },
  "booking.roomId": { $type: "string", $ne: "" },
  "booking.vivaExerciseId": { $type: "string", $ne: "" },
};
return [msg, null];

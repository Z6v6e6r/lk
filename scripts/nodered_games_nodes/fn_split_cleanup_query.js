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

const readEnv = (key) => {
  try {
    return toStr(env.get(key));
  } catch (_error) {
    return null;
  }
};

const resolveLifecycleMode = () => {
  const mode = String(readEnv("SPLIT_LIFECYCLE_V2_MODE") || "SHADOW").trim().toUpperCase();
  return ["OFF", "SHADOW", "ENFORCE_NEW"].includes(mode) ? mode : "SHADOW";
};

const parseIsoTimestamp = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const millisecond = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const componentDate = new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    millisecond,
  ));
  if (
    componentDate.getUTCFullYear() !== Number(year)
    || componentDate.getUTCMonth() !== Number(month) - 1
    || componentDate.getUTCDate() !== Number(day)
    || componentDate.getUTCHours() !== Number(hour)
    || componentDate.getUTCMinutes() !== Number(minute)
    || componentDate.getUTCSeconds() !== Number(second)
  ) return null;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    iso: new Date(ts).toISOString(),
  };
};

const normalizeIntent = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized === "cancel_game") return "cancel_game";
  if (normalized === "participant_timeout") return "participant_timeout";
  return null;
};

const normalizeRefundMethod = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toUpperCase();
  if (["CURRENCY", "DEPOSIT", "SERVICE", "NONE"].includes(normalized)) return normalized;
  return null;
};

const normalizeCancellationActionId = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (["card", "deposit", "subscription", "none"].includes(normalized)) return normalized;
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
  return [null, msg, null];
};

const query = msg.req?.query && typeof msg.req.query === "object" ? msg.req.query : {};
const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const internal = msg._splitCleanupInternal && typeof msg._splitCleanupInternal === "object"
  ? msg._splitCleanupInternal
  : null;
const internalScheduler = internal?.source === "scheduler";
const auth = msg._splitCleanupAuth && typeof msg._splitCleanupAuth === "object"
  ? msg._splitCleanupAuth
  : null;
if (
  !internalScheduler
  && (!auth || auth.verified !== true || (!toStr(auth.actorClientId) && !toStr(auth.actorPhoneNorm)))
) {
  return fail(401, "Не удалось подтвердить авторизованного клиента");
}

const SCHEDULER_LEASE_KEY = "lk_split_cleanup_scheduler_lease_until";
if (internalScheduler) {
  const lifecycleMode = resolveLifecycleMode();
  if (lifecycleMode === "OFF") {
    msg.payload = {
      ok: true,
      source: "scheduler",
      mode: lifecycleMode,
      skipped: true,
      reason: "feature_off",
    };
    return [null, null, msg];
  }
  const cutoffRaw = readEnv("SPLIT_LIFECYCLE_V2_ENFORCE_FROM");
  const activationCutoff = parseIsoTimestamp(cutoffRaw);
  if (!activationCutoff) {
    msg.payload = {
      ok: true,
      source: "scheduler",
      mode: lifecycleMode,
      skipped: true,
      reason: cutoffRaw ? "activation_cutoff_invalid" : "activation_cutoff_missing",
    };
    return [null, null, msg];
  }
  msg._splitCleanupLifecycleMode = lifecycleMode;
  msg._splitCleanupActivationCutoff = activationCutoff;
  const nowTs = Date.now();
  const leaseUntil = Number(global.get(SCHEDULER_LEASE_KEY) || 0);
  if (Number.isFinite(leaseUntil) && leaseUntil > nowTs) {
    msg.payload = {
      ok: true,
      source: "scheduler",
      skipped: true,
      reason: "lease_active",
      leaseUntil: new Date(leaseUntil).toISOString(),
    };
    return [null, null, msg];
  }
  global.set(SCHEDULER_LEASE_KEY, nowTs + 5 * 60 * 1000);
}

const gameId = toStr(query.gameId ?? body.gameId);
let tenantKey = null;
try { tenantKey = toStr(env.get("PADLHUB_PLATFORM_TENANT_KEY")); } catch { tenantKey = null; }
if (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  msg.statusCode = 503;
  msg.payload = { ok: false, code: "LEGACY_GAME_TENANT_CONFIG_INVALID", error: "Cleanup tenant is not configured" };
  return [null, msg, msg];
}
const force = toBoolean(query.force ?? body.force) === true;
const dryRun = internalScheduler && msg._splitCleanupLifecycleMode !== "ENFORCE_NEW"
  ? true
  : toBoolean(query.dryRun ?? body.dryRun) === true;
const intent = normalizeIntent(query.intent ?? body.intent);
const preferredRefundMethod = normalizeRefundMethod(query.refundMethod ?? body.refundMethod);
const cancellationActionId = normalizeCancellationActionId(
  query.cancellationActionId ?? body.cancellationActionId,
);
const actorBookingId = toStr(query.actorBookingId ?? body.actorBookingId);
const limit = Math.max(
  1,
  Math.min(500, Math.floor(toNumber(query.limit ?? body.limit) ?? 200)),
);

const nowTs = Date.now();
const nowIso = new Date(nowTs).toISOString();

const mongoQuery = force && gameId
  ? {
      tenantKey,
      archived: { $ne: true },
      status: { $nin: ["CANCELLED", "CANCELED"] },
      id: gameId,
    }
  : {
      tenantKey,
      archived: { $ne: true },
      status: { $nin: ["CANCELLED", "CANCELED"] },
      $or: [
        { "settings.payMode": "split" },
        { "metadata.splitPayment.enabled": true },
      ],
    };
if (internalScheduler) {
  mongoQuery.createdAt = { $gte: msg._splitCleanupActivationCutoff.iso };
}
if (gameId && !Object.prototype.hasOwnProperty.call(mongoQuery, "id")) {
  mongoQuery.id = gameId;
}

msg._splitCleanupRequest = {
  nowTs,
  nowIso,
  dryRun,
  limit,
  force,
  gameId,
  tenantKey,
  intent,
  preferredRefundMethod,
  cancellationActionId,
  actorBookingId,
  actorClientId: internalScheduler ? null : toStr(auth.actorClientId),
  actorPhoneNorm: internalScheduler ? null : toStr(auth.actorPhoneNorm),
  allowForceGameCancel: intent === "cancel_game",
  internalScheduler,
  schedulerLeaseKey: internalScheduler ? SCHEDULER_LEASE_KEY : null,
  lifecycleMode: internalScheduler ? msg._splitCleanupLifecycleMode : null,
  activationCutoffTs: internalScheduler ? msg._splitCleanupActivationCutoff.ts : null,
  activationCutoffIso: internalScheduler ? msg._splitCleanupActivationCutoff.iso : null,
};
msg.payload = mongoQuery;

if (!msg._splitCleanupRequest || typeof msg._splitCleanupRequest !== "object") {
  return fail(500, "Failed to prepare split cleanup request context");
}

return [msg, null, null];

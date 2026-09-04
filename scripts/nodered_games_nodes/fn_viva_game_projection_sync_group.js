const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";
const RUN_STATE_KEY = "lk_viva_game_projection_sync_run_state";
const PAGE_SIZE = 200;
const PROVIDER_REQUEST_TIMEOUT_MS = 8 * 1000;

const isObj = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const uniq = (values) => Array.from(new Set(values.map(toStr).filter(Boolean)));
const exerciseIds = (game) => {
  const dedupeId = toStr(game?.dedupeKey)?.match(/^viva:([0-9a-f-]{16,})$/i)?.[1] || null;
  return uniq([
    game?.booking?.vivaExerciseId,
    game?.booking?.exerciseId,
    game?.metadata?.vivaExerciseId,
    game?.metadata?.exerciseId,
    dedupeId,
  ]);
};
const finish = (code, details = {}) => {
  const lease = global.get(LEASE_KEY);
  const runId = msg._vivaProjectionSync?.runId;
  if (lease && typeof lease === "object" && lease.runId === runId) global.set(LEASE_KEY, null);
  const report = {
    ok: code === "NO_GAMES",
    source: "viva_game_projection_sync",
    code,
    mode: msg._vivaProjectionSync?.mode || null,
    runId: msg._vivaProjectionSync?.runId || null,
    at: new Date().toISOString(),
    ...details,
  };
  global.set("lk_viva_game_projection_sync_last_report", report);
  msg.payload = report;
  delete msg.vivaToken;
  return [null, msg];
};

const ctx = isObj(msg._vivaProjectionSync) ? msg._vivaProjectionSync : null;
const token = toStr(msg.vivaToken);
const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (!ctx || !token) return finish("RUN_CONTEXT_INVALID");
const lease = global.get(LEASE_KEY);
if (!isObj(lease) || lease.runId !== ctx.runId || Number(lease.until) <= Date.now()) {
  return finish("RUN_LEASE_INVALID");
}
if (rows.length === 0) return finish("NO_GAMES", { checkedCount: 0 });
if (rows.length >= Number(ctx.maxGames || 1000)) {
  return finish("GAME_QUERY_TRUNCATED", { checkedCount: rows.length });
}

const byDate = new Map();
const skipped = {
  malformed: 0,
  tenantMismatch: 0,
  exerciseIdentityAmbiguous: 0,
  outsideWindow: 0,
};
for (const game of rows) {
  const date = toStr(game?.booking?.date);
  const ids = exerciseIds(game);
  const primaryExerciseId = toStr(game?.booking?.vivaExerciseId);
  const revision = Number(game?.revision);
  if (
    !isObj(game)
    || !toStr(game._id)
    || !toStr(game.id)
    || !Number.isSafeInteger(revision)
    || !toStr(game.status)
    || !toStr(game?.booking?.studioId)
    || !toStr(game?.booking?.roomId)
    || !toStr(game?.booking?.timeFrom)
    || !toStr(game?.booking?.timeTo)
    || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")
  ) {
    skipped.malformed += 1;
    continue;
  }
  if (toStr(game.tenantKey) !== toStr(ctx.tenantKey)) {
    skipped.tenantMismatch += 1;
    continue;
  }
  if (ids.length !== 1 || ids[0] !== primaryExerciseId) {
    skipped.exerciseIdentityAmbiguous += 1;
    continue;
  }
  if (date < ctx.dateFrom || date > ctx.dateTo) {
    skipped.outsideWindow += 1;
    continue;
  }
  const group = byDate.get(date) || [];
  group.push({
    _id: game._id,
    id: toStr(game.id),
    tenantKey: toStr(game.tenantKey),
    revision,
    status: toStr(game.status),
    updatedAt: game.updatedAt,
    exerciseId: primaryExerciseId,
    studioId: toStr(game.booking.studioId),
    roomId: toStr(game.booking.roomId),
    roomName: toStr(game.booking.roomName),
    date,
    timeFrom: toStr(game.booking.timeFrom),
    timeTo: toStr(game.booking.timeTo),
  });
  byDate.set(date, group);
}

if (byDate.size === 0) return finish("NO_ELIGIBLE_GAMES", { checkedCount: rows.length, skipped });
const requests = [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, games]) => ({
  _vivaProjectionSync: { ...ctx },
  _vivaProjectionSyncGroup: {
    date,
    games,
    page: 0,
    pageSize: PAGE_SIZE,
    maxPages: 5,
    providerRows: [],
    lastFingerprint: null,
  },
  _vivaProjectionSyncBearer: token,
  method: "GET",
  url: `${ADMIN_API}/exercises?date=${encodeURIComponent(date)}&includeCanceled=true&page=0&size=${PAGE_SIZE}`,
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  },
  requestTimeout: PROVIDER_REQUEST_TIMEOUT_MS,
  followRedirects: false,
  maxRedirects: 0,
  payload: undefined,
}));

const report = {
  ok: true,
  source: "viva_game_projection_sync",
  code: "RUN_IN_PROGRESS",
  mode: ctx.mode,
  runId: ctx.runId,
  checkedCount: rows.length,
  eligibleCount: requests.reduce((count, request) => count + request._vivaProjectionSyncGroup.games.length, 0),
  dateCount: requests.length,
  skipped,
  at: new Date().toISOString(),
};
global.set(RUN_STATE_KEY, {
  version: 1,
  runId: ctx.runId,
  mode: ctx.mode,
  startedAt: ctx.startedAt,
  checkedCount: rows.length,
  eligibleCount: report.eligibleCount,
  dateCount: requests.length,
  pendingDates: requests.length,
  completedDates: 0,
  pendingWrites: 0,
  writeScheduled: 0,
  writeSucceeded: 0,
  writeFailed: 0,
  driftCount: 0,
  failed: false,
  failures: [],
  skipped: { ...skipped },
  updatedAt: report.at,
});
global.set("lk_viva_game_projection_sync_last_report", report);
msg.payload = report;
delete msg.vivaToken;
return [requests, msg];

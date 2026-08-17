const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 24;
const CACHE_TTL_MS = 10_000;
const MAX_RATE_KEYS = 5_000;
const MAX_CACHE_KEYS = 1_000;

const now = Date.now();
const req = msg.req && typeof msg.req === "object" ? msg.req : {};
const headers = req.headers && typeof req.headers === "object" ? req.headers : {};
const query = req.query && typeof req.query === "object" ? req.query : {};
const tournamentId = String(query.tournamentId || "").trim();

const respond = (statusCode, code, message, retryAfter = null) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
  };
  msg.payload = { error: message, code };
  return [msg, null];
};

if (!tournamentId || tournamentId.length > 160) {
  return respond(400, "TOURNAMENT_ID_REQUIRED", "Не указан корректный идентификатор турнира");
}

const headerIp = String(headers["x-real-ip"] || "").trim();
const socketIp = String(req.socket?.remoteAddress || req.connection?.remoteAddress || "").trim();
const sourceIp = (headerIp || socketIp || "unknown").slice(0, 96);
const rateKey = `${sourceIp}|${tournamentId}`;
const cacheKey = `id:${tournamentId}`;
const rateState = flow.get("lkTournamentHistoryRateState") || {};

Object.keys(rateState).forEach((key) => {
  const row = rateState[key];
  if (!row || !Number.isFinite(row.windowStartedAt) || now - row.windowStartedAt >= WINDOW_MS * 2) {
    delete rateState[key];
  }
});
if (Object.keys(rateState).length >= MAX_RATE_KEYS && !rateState[rateKey]) {
  const oldestKey = Object.keys(rateState).sort((left, right) => (
    Number(rateState[left]?.windowStartedAt || 0) - Number(rateState[right]?.windowStartedAt || 0)
  ))[0];
  if (oldestKey) delete rateState[oldestKey];
}

const currentRate = rateState[rateKey];
const rateRow = !currentRate || now - currentRate.windowStartedAt >= WINDOW_MS
  ? { windowStartedAt: now, count: 0 }
  : currentRate;
rateRow.count += 1;
rateState[rateKey] = rateRow;
flow.set("lkTournamentHistoryRateState", rateState);

if (rateRow.count > MAX_REQUESTS_PER_WINDOW) {
  const retryAfter = Math.max(1, Math.ceil((rateRow.windowStartedAt + WINDOW_MS - now) / 1000));
  return respond(429, "TOURNAMENT_HISTORY_RATE_LIMITED", "Слишком много запросов истории турнира", retryAfter);
}

const cacheState = flow.get("lkTournamentHistoryResponseCache") || {};
Object.keys(cacheState).forEach((key) => {
  const row = cacheState[key];
  if (!row || !Number.isFinite(row.expiresAt) || row.expiresAt <= now) delete cacheState[key];
});
if (Object.keys(cacheState).length > MAX_CACHE_KEYS) {
  Object.keys(cacheState)
    .sort((left, right) => Number(cacheState[left]?.expiresAt || 0) - Number(cacheState[right]?.expiresAt || 0))
    .slice(0, Object.keys(cacheState).length - MAX_CACHE_KEYS)
    .forEach((key) => delete cacheState[key]);
}
flow.set("lkTournamentHistoryResponseCache", cacheState);

const cached = cacheState[cacheKey];
if (cached && cached.expiresAt > now && Array.isArray(cached.payload)) {
  msg.statusCode = 200;
  msg.headers = {
    ...(msg.headers && typeof msg.headers === "object" ? msg.headers : {}),
    "Cache-Control": "private, no-cache",
  };
  msg.payload = cached.payload;
  return [msg, null];
}

msg._tournamentHistoryCacheKey = cacheKey;
msg._tournamentHistoryCacheTtlMs = CACHE_TTL_MS;
return [null, msg];

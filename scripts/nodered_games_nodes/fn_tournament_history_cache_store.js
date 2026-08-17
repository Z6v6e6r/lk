const now = Date.now();
const cacheKey = String(msg._tournamentHistoryCacheKey || "").trim();
const ttlMs = Number(msg._tournamentHistoryCacheTtlMs || 0);

if (
  cacheKey
  && cacheKey.startsWith("id:")
  && cacheKey.length <= 163
  && Number.isFinite(ttlMs)
  && ttlMs > 0
  && Array.isArray(msg.payload)
  && (!msg.statusCode || Number(msg.statusCode) < 400)
) {
  const cacheState = flow.get("lkTournamentHistoryResponseCache") || {};
  cacheState[cacheKey] = {
    expiresAt: now + ttlMs,
    payload: msg.payload,
  };
  flow.set("lkTournamentHistoryResponseCache", cacheState);
}

delete msg._tournamentHistoryCacheKey;
delete msg._tournamentHistoryCacheTtlMs;
msg.headers = {
  ...(msg.headers && typeof msg.headers === "object" ? msg.headers : {}),
  "Cache-Control": "private, no-cache",
};
return msg;

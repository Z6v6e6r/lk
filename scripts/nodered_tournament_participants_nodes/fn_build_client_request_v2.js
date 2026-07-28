const CACHE_KEY = "lkTournamentParticipantClientRatingCacheV2";
const CACHE_TTL_MS = 30 * 60_000;
const participant = msg.payload || {};
const client = participant.client && typeof participant.client === "object"
  ? { ...participant.client }
  : participant.client;
if (client) {
  delete client.phone;
  delete client.phoneNorm;
  delete client.mobile;
}
msg.participant = { ...participant, client };

const clientId = String(client?.id || "").trim();
const cache = flow.get(CACHE_KEY) || {};
const cached = cache[clientId];
if (!clientId || (cached && Date.now() - Number(cached.at || 0) <= CACHE_TTL_MS)) {
  msg.payload = {
    ...msg.participant,
    rating: cached?.rating ?? null,
    ratingSource: cached?.ratingSource || "unavailable",
  };
  return [msg, null];
}

msg.method = "GET";
msg.requestTimeout = 2_500;
msg.url = `https://api.vivacrm.ru/api/v1/clients/${encodeURIComponent(clientId)}`;
msg.headers = { Authorization: `Bearer ${global.get("vivacrm_access_token")}` };
return [null, msg];

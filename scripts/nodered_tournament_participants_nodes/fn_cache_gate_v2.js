const CACHE_KEY = "lkTournamentParticipantResponseCacheV2";
const CIRCUIT_KEY = "lkTournamentParticipantVivaCircuitV2";
const FRESH_TTL_MS = 60_000;
const STALE_TTL_MS = 10 * 60_000;
const INFLIGHT_TTL_MS = 10_000;
const MAX_INFLIGHT_KEYS = 8;

const exerciseId = String(
  msg.req?.query?.exerciseId
  || msg.req?.query?.tournamentId
  || msg.payload?.exerciseId
  || msg.payload?.tournamentId
  || "",
).trim();

if (!exerciseId) {
  msg.statusCode = 400;
  msg.payload = { error: "exerciseId required" };
  return [null, msg];
}

const requestedSize = Number(msg.req?.query?.size) || 100;
const size = Math.max(1, Math.min(Math.floor(requestedSize), 200));
const key = `${exerciseId}:${size}`;
const now = Date.now();
const state = flow.get(CACHE_KEY) || { entries: {}, inflight: {} };
state.entries = state.entries || {};
state.inflight = state.inflight || {};

for (const [entryKey, entry] of Object.entries(state.entries)) {
  if (!entry || now - Number(entry.at || 0) > STALE_TTL_MS) delete state.entries[entryKey];
}
for (const [inflightKey, inflight] of Object.entries(state.inflight)) {
  if (!inflight || now - Number(inflight.startedAt || 0) > INFLIGHT_TTL_MS) delete state.inflight[inflightKey];
}

const entry = state.entries[key];
const entryAgeMs = entry ? now - Number(entry.at || 0) : Number.POSITIVE_INFINITY;
const serveCached = (cacheState) => {
  msg.statusCode = 200;
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": cacheState,
  };
  msg.payload = entry.payload;
  msg.participantCacheKey = key;
  msg.participantCacheBypassWrite = true;
  return [null, msg];
};
const rejectBusy = (reason) => {
  msg.statusCode = 429;
  msg.headers = {
    ...(msg.headers || {}),
    "Retry-After": "2",
    "x-lk-participants-cache": reason,
  };
  msg.payload = { error: "Participants refresh is busy" };
  msg.participantCacheKey = key;
  msg.participantCacheBypassWrite = true;
  return [null, msg];
};

if (entry && entryAgeMs <= FRESH_TTL_MS) {
  flow.set(CACHE_KEY, state);
  return serveCached("hit");
}

if (state.inflight[key]) {
  flow.set(CACHE_KEY, state);
  return entry && entryAgeMs <= STALE_TTL_MS
    ? serveCached("stale-refreshing")
    : rejectBusy("busy-key");
}

if (Object.keys(state.inflight).length >= MAX_INFLIGHT_KEYS) {
  flow.set(CACHE_KEY, state);
  return entry && entryAgeMs <= STALE_TTL_MS
    ? serveCached("stale-overload")
    : rejectBusy("busy-global");
}

const circuit = flow.get(CIRCUIT_KEY) || { failures: 0, openedUntil: 0 };
if (Number(circuit.openedUntil || 0) > now) {
  flow.set(CACHE_KEY, state);
  if (entry && entryAgeMs <= STALE_TTL_MS) return serveCached("stale-circuit");
  msg.statusCode = 503;
  msg.headers = {
    ...(msg.headers || {}),
    "Retry-After": "15",
    "x-lk-participants-cache": "circuit-open",
  };
  msg.payload = { error: "Participants temporarily unavailable" };
  msg.participantCacheKey = key;
  msg.participantCacheBypassWrite = true;
  return [null, msg];
}

state.inflight[key] = { startedAt: now };
flow.set(CACHE_KEY, state);
msg.participantCacheKey = key;
msg.participantSize = size;
return [msg, null];

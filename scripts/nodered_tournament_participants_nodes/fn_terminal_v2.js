const CACHE_KEY = "lkTournamentParticipantResponseCacheV2";
const EPOCH_KEY = "lkTournamentParticipantEpochV1";
const STALE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 500;
const state = flow.get(CACHE_KEY) || { entries: {}, inflight: {} };
state.entries = state.entries || {};
state.inflight = state.inflight || {};

const key = String(msg.participantCacheKey || "").trim();
const now = Date.now();
const statusCode = Number(msg.statusCode) || 200;
const exerciseId = String(msg.participantCacheExerciseId || "").trim();
const requestEpoch = Math.max(0, Number(msg.participantCacheEpoch) || 0);
const epochState = global.get(EPOCH_KEY) || {};
const currentEpoch = exerciseId ? Math.max(0, Number(epochState[exerciseId]) || 0) : requestEpoch;
const cached = key ? state.entries[key] : null;
const cachedAgeMs = cached ? now - Number(cached.at || 0) : Number.POSITIVE_INFINITY;

if (key) delete state.inflight[key];

if (exerciseId && requestEpoch !== currentEpoch) {
  msg.statusCode = 409;
  msg.payload = { error: "Participants changed; retry with a fresh read" };
  msg.headers = {
    ...(msg.headers || {}),
    "Retry-After": "0",
    "x-lk-participants-cache": "epoch-changed",
  };
  msg.participantCacheBypassWrite = true;
}

if (
  key
  && !msg.participantCacheBypassWrite
  && statusCode >= 200
  && statusCode < 300
  && Array.isArray(msg.payload)
) {
  state.entries[key] = { at: now, epoch: requestEpoch, payload: msg.payload };
  const entries = Object.entries(state.entries);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries
      .sort(([, left], [, right]) => Number(left?.at || 0) - Number(right?.at || 0))
      .slice(0, entries.length - MAX_CACHE_ENTRIES)
      .forEach(([entryKey]) => delete state.entries[entryKey]);
  }
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": "miss",
  };
} else if (
  key
  && !msg.participantCacheBypassWrite
  && cached
  && cachedAgeMs <= STALE_TTL_MS
  && (statusCode < 200 || statusCode >= 300)
) {
  msg.statusCode = 200;
  msg.payload = cached.payload;
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": "stale-if-error",
  };
}

for (const [entryKey, entry] of Object.entries(state.entries)) {
  if (!entry || now - Number(entry.at || 0) > STALE_TTL_MS) delete state.entries[entryKey];
}

delete msg.participantCacheBypassWrite;
flow.set(CACHE_KEY, state);
return msg;

const CACHE_KEY = "lkTournamentParticipantResponseCacheV2";
const CIRCUIT_KEY = "lkTournamentParticipantVivaCircuitV2";
const EPOCH_KEY = "lkTournamentParticipantEpochV1";
const MANUAL_COOLDOWN_KEY = "lkTournamentParticipantManualRefreshCooldownV1";
const INITIAL_REFRESH_MS = 60_000;
const STALE_TTL_MS = 10 * 60_000;
const INFLIGHT_TTL_MS = 30_000;
const MANUAL_COOLDOWN_MS = 30_000;
const MAX_INFLIGHT_KEYS = 8;
const MAX_COOLDOWN_ENTRIES = 1_000;
const VIVA_EXERCISE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const manualContext = msg._tournamentParticipantManualRefresh
  && msg._tournamentParticipantManualRefresh.authorized === true
  ? msg._tournamentParticipantManualRefresh
  : null;
const isManualRefresh = Boolean(manualContext);
const exerciseId = String(
  manualContext?.exerciseId
  || msg.req?.query?.exerciseId
  || msg.req?.query?.tournamentId
  || msg.payload?.exerciseId
  || msg.payload?.tournamentId
  || "",
).trim();

if (!exerciseId) {
  msg.statusCode = 400;
  msg.payload = { error: "exerciseId required" };
  msg.participantCacheSkipTerminalState = true;
  return [null, msg];
}
if (!VIVA_EXERCISE_UUID_RE.test(exerciseId)) {
  msg.statusCode = 400;
  msg.headers = {
    ...(msg.headers || {}),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  msg.payload = {
    error: "EXERCISE_ID_INVALID",
    code: "EXERCISE_ID_INVALID",
    message: "Некорректный Viva exerciseId",
  };
  msg.participantCacheSkipTerminalState = true;
  delete msg._tournamentParticipantManualRefresh;
  return [null, msg];
}

const requestedSize = Number(manualContext?.size ?? msg.req?.query?.size) || 100;
const responseSize = Math.max(1, Math.min(Math.floor(requestedSize), 200));
const fetchCapacity = responseSize > 100 ? 200 : 100;
const key = `${exerciseId}:${fetchCapacity}`;
const legacyCacheKeyInfo = (candidateKey) => {
  const normalizedKey = String(candidateKey || "");
  const separator = normalizedKey.lastIndexOf(":");
  const suffix = normalizedKey.slice(separator + 1);
  const capacity = /^\d{1,3}$/.test(suffix) ? Number(suffix) : 0;
  if (separator <= 0 || capacity < 1 || capacity > 200) {
    return { exerciseId: "", capacity: 0 };
  }
  return { exerciseId: normalizedKey.slice(0, separator), capacity };
};
const entryCapacity = (entryKey, entry) => {
  const explicitCapacity = Number(entry?.capacity ?? entry?.fetchCapacity);
  if (Number.isInteger(explicitCapacity) && explicitCapacity >= 1 && explicitCapacity <= 200) {
    return explicitCapacity;
  }
  return legacyCacheKeyInfo(entryKey).capacity;
};
const now = Date.now();
const epochState = global.get(EPOCH_KEY) || {};
const epoch = Math.max(0, Number(epochState[exerciseId]) || 0);
const state = flow.get(CACHE_KEY) || { entries: {}, inflight: {} };
state.entries = state.entries || {};
state.inflight = state.inflight || {};
state.refreshByExercise = state.refreshByExercise || {};

for (const [entryKey, entry] of Object.entries(state.entries)) {
  if (!entry || now - Number(entry.at || 0) > STALE_TTL_MS) delete state.entries[entryKey];
}
for (const [inflightKey, inflight] of Object.entries(state.inflight)) {
  if (!inflight || now - Number(inflight.startedAt || 0) > INFLIGHT_TTL_MS) {
    delete state.inflight[inflightKey];
  }
}
for (const [refreshExerciseId, refreshState] of Object.entries(state.refreshByExercise)) {
  if (!refreshState || now - Number(refreshState.at || 0) > STALE_TTL_MS) {
    delete state.refreshByExercise[refreshExerciseId];
  }
}

for (const [entryKey, entry] of Object.entries(state.entries)) {
  const entryExerciseId = String(entry?.exerciseId || "");
  if (
    (entryExerciseId === exerciseId || (!entryExerciseId && legacyCacheKeyInfo(entryKey).exerciseId === exerciseId))
    && Number(entry?.epoch || 0) !== epoch
  ) {
    delete state.entries[entryKey];
  }
}
if (Number(state.refreshByExercise[exerciseId]?.epoch || 0) !== epoch) {
  delete state.refreshByExercise[exerciseId];
}
for (const [inflightKey, inflight] of Object.entries(state.inflight)) {
  if (
    (
      String(inflight?.exerciseId || "") === exerciseId
      || inflightKey === key
      || (!inflight?.exerciseId && legacyCacheKeyInfo(inflightKey).exerciseId === exerciseId)
    )
    && Number(inflight.epoch || 0) !== epoch
  ) {
    delete state.inflight[inflightKey];
  }
}

const exerciseEntries = Object.entries(state.entries)
  .filter(([entryKey, entry]) => (
    (
      String(entry?.exerciseId || "") === exerciseId
      || (!entry?.exerciseId && legacyCacheKeyInfo(entryKey).exerciseId === exerciseId)
    )
    && entryCapacity(entryKey, entry) >= fetchCapacity
  ))
  .sort(([, left], [, right]) => Number(right?.at || 0) - Number(left?.at || 0));
const fallbackEntryPair = exerciseEntries[0] || null;
const currentEntryKey = fallbackEntryPair?.[0] || null;
const currentEntry = fallbackEntryPair?.[1] || null;
const entryAgeMs = currentEntry ? now - Number(currentEntry.at || 0) : Number.POSITIVE_INFINITY;
const exerciseRefreshState = state.refreshByExercise[exerciseId];
const exerciseNextRefreshAt = exerciseRefreshState
  ? Number(exerciseRefreshState.nextRefreshAt || 0)
    || Number(exerciseRefreshState.at || 0) + INITIAL_REFRESH_MS
  : currentEntry
    ? Number(currentEntry.nextRefreshAt || 0) || Number(currentEntry.at || 0) + INITIAL_REFRESH_MS
  : 0;
const exerciseInflight = Object.entries(state.inflight).find(([inflightKey, inflight]) => (
  String(inflight?.exerciseId || "") === exerciseId
  || inflightKey === key
  || (!inflight?.exerciseId && legacyCacheKeyInfo(inflightKey).exerciseId === exerciseId)
));

msg.participantCacheKey = key;
msg.participantSize = fetchCapacity;
msg.participantFetchCapacity = fetchCapacity;
msg.participantResponseSize = responseSize;
msg.participantCacheExerciseId = exerciseId;
msg.participantCacheEpoch = epoch;
msg.participantCacheFallbackKey = currentEntryKey;

const setRetryAfter = (retryAfterMs) => {
  const boundedRetryAfterMs = Math.max(0, Math.ceil(Number(retryAfterMs) || 0));
  if (boundedRetryAfterMs > 0) {
    msg.headers = {
      ...(msg.headers || {}),
      "Retry-After": String(Math.max(1, Math.ceil(boundedRetryAfterMs / 1000))),
    };
  }
  return boundedRetryAfterMs;
};
const serveCached = (cacheState) => {
  msg.statusCode = 200;
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": cacheState,
  };
  msg.payload = Array.isArray(currentEntry.payload)
    ? currentEntry.payload.slice(0, responseSize)
    : currentEntry.payload;
  msg.participantCacheBypassWrite = true;
  return [null, msg];
};
const reject = (statusCode, cacheState, reason, retryAfterMs, errorMessage = "Participants refresh is busy") => {
  const boundedRetryAfterMs = setRetryAfter(retryAfterMs);
  msg.statusCode = isManualRefresh ? 200 : statusCode;
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": cacheState,
  };
  msg.payload = isManualRefresh && Array.isArray(currentEntry?.payload)
    ? currentEntry.payload.slice(0, responseSize)
    : { error: errorMessage, retryAfterMs: boundedRetryAfterMs };
  msg.participantCacheBypassWrite = true;
  if (isManualRefresh) {
    msg.participantManualRefreshReason = reason;
    msg.participantManualRefreshRetryAfterMs = boundedRetryAfterMs;
    if (!Array.isArray(msg.payload)) msg.payload = [];
  }
  return [null, msg];
};

if (!isManualRefresh && currentEntry && now < exerciseNextRefreshAt) {
  flow.set(CACHE_KEY, state);
  return serveCached("hit");
}

if (exerciseInflight) {
  flow.set(CACHE_KEY, state);
  if (!isManualRefresh && currentEntry && entryAgeMs <= STALE_TTL_MS) {
    return serveCached("stale-refreshing");
  }
  const inflightStartedAt = Number(exerciseInflight[1]?.startedAt) || now;
  const inflightAgeMs = Math.max(0, now - inflightStartedAt);
  const retryAfterMs = Math.max(1_000, INFLIGHT_TTL_MS - inflightAgeMs);
  return reject(429, "busy-key", "in_progress", retryAfterMs);
}

const manualCooldownState = global.get(MANUAL_COOLDOWN_KEY) || {};
for (const [cooldownExerciseId, value] of Object.entries(manualCooldownState)) {
  if (!value || now - Number(value.at || 0) > STALE_TTL_MS) {
    delete manualCooldownState[cooldownExerciseId];
  }
}
const cooldownEntries = Object.entries(manualCooldownState);
if (cooldownEntries.length > MAX_COOLDOWN_ENTRIES) {
  cooldownEntries
    .sort(([, left], [, right]) => Number(left?.at || 0) - Number(right?.at || 0))
    .slice(0, cooldownEntries.length - MAX_COOLDOWN_ENTRIES)
    .forEach(([cooldownExerciseId]) => delete manualCooldownState[cooldownExerciseId]);
}
const lastManualRefreshAt = Number(manualCooldownState[exerciseId]?.at || 0);
const manualRetryAfterMs = Math.max(0, MANUAL_COOLDOWN_MS - (now - lastManualRefreshAt));
if (isManualRefresh && lastManualRefreshAt > 0 && manualRetryAfterMs > 0) {
  global.set(MANUAL_COOLDOWN_KEY, manualCooldownState);
  flow.set(CACHE_KEY, state);
  return reject(429, "manual-cooldown", "cooldown", manualRetryAfterMs);
}

if (Object.keys(state.inflight).length >= MAX_INFLIGHT_KEYS) {
  global.set(MANUAL_COOLDOWN_KEY, manualCooldownState);
  flow.set(CACHE_KEY, state);
  if (!isManualRefresh && currentEntry && entryAgeMs <= STALE_TTL_MS) {
    return serveCached("stale-overload");
  }
  return reject(429, "busy-global", "overload", 2_000);
}

const circuit = flow.get(CIRCUIT_KEY) || { failures: 0, openedUntil: 0 };
if (Number(circuit.openedUntil || 0) > now) {
  global.set(MANUAL_COOLDOWN_KEY, manualCooldownState);
  flow.set(CACHE_KEY, state);
  if (!isManualRefresh && currentEntry && entryAgeMs <= STALE_TTL_MS) {
    return serveCached("stale-circuit");
  }
  const retryAfterMs = Math.max(1_000, Number(circuit.openedUntil || 0) - now);
  return reject(
    503,
    "circuit-open",
    "unavailable",
    retryAfterMs,
    "Participants temporarily unavailable",
  );
}

const ownerId = `${now}:${Math.random().toString(36).slice(2, 12)}`;
state.inflight[key] = { startedAt: now, epoch, exerciseId, ownerId };
flow.set(CACHE_KEY, state);
msg.participantCacheOwnsInflight = true;
msg.participantCacheOwnerId = ownerId;
msg.participantRefreshStartedAt = now;

if (isManualRefresh) {
  manualCooldownState[exerciseId] = { at: now };
  global.set(MANUAL_COOLDOWN_KEY, manualCooldownState);
}

return [msg, null];

const CACHE_KEY = "lkTournamentParticipantResponseCacheV2";
const EPOCH_KEY = "lkTournamentParticipantEpochV1";
const MANUAL_COOLDOWN_KEY = "lkTournamentParticipantManualRefreshCooldownV1";
const NODE_RED_MANAGED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "transfer-encoding",
]);
const sanitizeResponseHeaders = () => {
  if (!msg.headers || typeof msg.headers !== "object" || Array.isArray(msg.headers)) return;
  msg.headers = Object.fromEntries(
    Object.entries(msg.headers).filter(
      ([name]) => !NODE_RED_MANAGED_RESPONSE_HEADERS.has(String(name).trim().toLowerCase()),
    ),
  );
};
if (msg.participantCacheSkipTerminalState === true) {
  delete msg.participantCacheSkipTerminalState;
  sanitizeResponseHeaders();
  return msg;
}
const STALE_TTL_MS = 10 * 60_000;
const MANUAL_COOLDOWN_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
const state = flow.get(CACHE_KEY) || { entries: {}, inflight: {} };
state.entries = state.entries || {};
state.inflight = state.inflight || {};
state.refreshByExercise = state.refreshByExercise || {};

const key = String(msg.participantCacheKey || "").trim();
const fallbackKey = String(msg.participantCacheFallbackKey || "").trim();
const fetchCapacity = Math.max(
  1,
  Math.min(Math.floor(Number(msg.participantFetchCapacity ?? msg.participantSize) || 100), 200),
);
const responseSize = Math.max(
  1,
  Math.min(Math.floor(Number(msg.participantResponseSize ?? msg.participantSize) || 100), 200),
);
const now = Date.now();
let statusCode = Number(msg.statusCode) || 200;
const exerciseId = String(msg.participantCacheExerciseId || "").trim();
const requestEpoch = Math.max(0, Number(msg.participantCacheEpoch) || 0);
const epochState = global.get(EPOCH_KEY) || {};
const currentEpoch = exerciseId ? Math.max(0, Number(epochState[exerciseId]) || 0) : requestEpoch;
const cached = (fallbackKey ? state.entries[fallbackKey] : null)
  || (key ? state.entries[key] : null)
  || null;
const cachedAgeMs = cached ? now - Number(cached.at || 0) : Number.POSITIVE_INFINITY;
const inflight = key ? state.inflight[key] : null;
const ownsInflight = Boolean(
  key
  && msg.participantCacheOwnsInflight === true
  && msg.participantCacheOwnerId
  && inflight?.ownerId === msg.participantCacheOwnerId
);

if (msg.participantCacheOwnsInflight === true && !ownsInflight) {
  msg.statusCode = 409;
  statusCode = 409;
  msg.payload = { error: "Participants refresh ownership changed" };
  msg.headers = {
    ...(msg.headers || {}),
    "Retry-After": "0",
    "x-lk-participants-cache": "owner-changed",
  };
  msg.participantCacheBypassWrite = true;
}

if (ownsInflight) delete state.inflight[key];

if (exerciseId && requestEpoch !== currentEpoch) {
  msg.statusCode = 409;
  statusCode = 409;
  msg.payload = { error: "Participants changed; retry with a fresh read" };
  msg.headers = {
    ...(msg.headers || {}),
    "Retry-After": "0",
    "x-lk-participants-cache": "epoch-changed",
  };
  msg.participantCacheBypassWrite = true;
}

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .sort()
    .reduce((result, field) => {
      result[field] = stableValue(value[field]);
      return result;
    }, {});
};
const stableParticipantKey = (participant) => {
  const bookingId = String(participant?.bookingId || participant?.id || "");
  const clientId = String(participant?.client?.id || participant?.clientId || "");
  const spot = String(participant?.spot ?? "");
  return `${bookingId}\u001f${clientId}\u001f${spot}\u001f${JSON.stringify(participant)}`;
};
const fingerprintPayload = (payload) => {
  const canonicalPayload = Array.isArray(payload)
    ? payload
      .map(stableValue)
      .sort((left, right) => {
        const leftKey = stableParticipantKey(left);
        const rightKey = stableParticipantKey(right);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
    : stableValue(payload);
  const source = JSON.stringify(canonicalPayload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}:${source.length}`;
};

let storedEntry = null;
if (
  key
  && ownsInflight
  && !msg.participantCacheBypassWrite
  && statusCode >= 200
  && statusCode < 300
  && Array.isArray(msg.payload)
) {
  const fingerprint = fingerprintPayload(msg.payload);
  const previousRefreshState = exerciseId ? state.refreshByExercise[exerciseId] : null;
  const previousFingerprint = previousRefreshState?.fingerprint
    || cached?.fingerprint
    || (Array.isArray(cached?.payload) ? fingerprintPayload(cached.payload) : null);
  const unchanged = Boolean(previousFingerprint && previousFingerprint === fingerprint);
  const unchangedCycles = unchanged
    ? Math.min(
      1_000,
      Math.max(0, Number(previousRefreshState?.unchangedCycles ?? cached?.unchangedCycles) || 0) + 1,
    )
    : 0;
  const refreshIntervalMs = unchangedCycles >= 2
    ? 300_000
    : unchangedCycles === 1
      ? 120_000
      : 60_000;
  storedEntry = {
    at: now,
    epoch: requestEpoch,
    exerciseId,
    capacity: fetchCapacity,
    payload: msg.payload,
    fingerprint,
    unchangedCycles,
    nextRefreshAt: now + refreshIntervalMs,
    refreshedAt: new Date(now).toISOString(),
  };
  state.entries[key] = storedEntry;
  if (exerciseId) {
    state.refreshByExercise[exerciseId] = {
      at: now,
      epoch: requestEpoch,
      fingerprint,
      unchangedCycles,
      nextRefreshAt: storedEntry.nextRefreshAt,
      refreshedAt: storedEntry.refreshedAt,
      cacheKey: key,
    };
  }
  const entries = Object.entries(state.entries);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries
      .sort(([, left], [, right]) => Number(left?.at || 0) - Number(right?.at || 0))
      .slice(0, entries.length - MAX_CACHE_ENTRIES)
      .forEach(([entryKey]) => delete state.entries[entryKey]);
  }
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": msg._tournamentParticipantManualRefresh ? "manual-refresh" : "miss",
  };
} else if (
  key
  && ownsInflight
  && !msg.participantCacheBypassWrite
  && cached
  && cachedAgeMs <= STALE_TTL_MS
  && (statusCode < 200 || statusCode >= 300)
) {
  msg.statusCode = 200;
  statusCode = 200;
  msg.payload = Array.isArray(cached.payload)
    ? cached.payload.slice(0, responseSize)
    : cached.payload;
  msg.headers = {
    ...(msg.headers || {}),
    "x-lk-participants-cache": "stale-if-error",
  };
  if (msg._tournamentParticipantManualRefresh) {
    msg.participantManualRefreshReason = "stale_if_error";
  }
}

for (const [entryKey, entry] of Object.entries(state.entries)) {
  if (!entry || now - Number(entry.at || 0) > STALE_TTL_MS) delete state.entries[entryKey];
}
for (const [refreshExerciseId, refreshState] of Object.entries(state.refreshByExercise)) {
  if (!refreshState || now - Number(refreshState.at || 0) > STALE_TTL_MS) {
    delete state.refreshByExercise[refreshExerciseId];
  }
}

delete msg.participantCacheBypassWrite;
flow.set(CACHE_KEY, state);

if (!msg._tournamentParticipantManualRefresh && Array.isArray(msg.payload)) {
  msg.payload = msg.payload.slice(0, responseSize);
}

if (msg._tournamentParticipantManualRefresh) {
  const refreshed = Boolean(storedEntry);
  const participantSource = Array.isArray(msg.payload)
    ? msg.payload
    : Array.isArray(cached?.payload)
      ? cached.payload
      : [];
  const participants = participantSource.slice(0, responseSize);
  const reason = msg.participantManualRefreshReason
    || (refreshed ? "refreshed" : "unavailable");
  const cooldownState = global.get(MANUAL_COOLDOWN_KEY) || {};
  const cooldownAt = Number(cooldownState[exerciseId]?.at || 0);
  const retryAfterMs = Number.isFinite(Number(msg.participantManualRefreshRetryAfterMs))
    ? Math.max(0, Number(msg.participantManualRefreshRetryAfterMs))
    : cooldownAt > 0
      ? Math.max(0, MANUAL_COOLDOWN_MS - (now - cooldownAt))
      : 0;
  msg.headers = {
    ...(msg.headers || {}),
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.statusCode = 200;
  msg.payload = {
    refreshed,
    reason,
    exerciseId,
    participants,
    refreshedAt: (storedEntry || cached)?.refreshedAt || null,
    retryAfterMs,
  };
}

delete msg.participantCacheOwnsInflight;
delete msg.participantCacheOwnerId;
delete msg.participantManualRefreshReason;
delete msg.participantManualRefreshRetryAfterMs;
// The HTTP response node owns connection and body framing. Forwarding these
// upstream headers can make nginx reject an otherwise valid response when
// Node.js selects its own transfer mode.
sanitizeResponseHeaders();
return msg;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asArray = (value) => (Array.isArray(value) ? value : []);
const toStringOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const toPositiveIntegerOrNull = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function participantRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw errorWithCode("PROVIDER_PARTICIPANTS_SCHEMA_INVALID", "Provider participants response has no recognized roster shape");
  }
  for (const key of ["participants", "bookings", "content", "data", "items", "records"]) {
    if (!Object.hasOwn(payload, key)) continue;
    if (Array.isArray(payload[key])) return payload[key];
    throw errorWithCode("PROVIDER_PARTICIPANTS_SCHEMA_INVALID", `Provider participants field ${key} is not an array`);
  }
  throw errorWithCode("PROVIDER_PARTICIPANTS_SCHEMA_INVALID", "Provider participants response has no recognized roster field");
}

function normalizeParticipant(row, rosterIndex) {
  if (!row || typeof row !== "object") {
    throw errorWithCode("PROVIDER_ROSTER_ROW_INVALID", `Provider roster row ${rosterIndex} is invalid`);
  }
  const client = row.client && typeof row.client === "object" ? row.client : {};
  const clientId = toStringOrNull(client.id ?? row.clientId ?? row.playerId ?? row.userId);
  if (!clientId || !UUID_RE.test(clientId)) {
    throw errorWithCode("PROVIDER_PLAYER_ID_INVALID", `Provider roster row ${rosterIndex} has no exact Viva client UUID`);
  }
  const name = [client.firstName, client.lastName]
    .map(toStringOrNull)
    .filter(Boolean)
    .join(" ") || toStringOrNull(row.name) || "Игрок";
  const isCancelled = row.isCancelled === true || row.cancelled === true || row.canceled === true
    ? true
    : row.isCancelled === false || row.cancelled === false || row.canceled === false
      ? false
      : null;
  if (isCancelled === null) {
    throw errorWithCode("PROVIDER_ACTIVE_STATUS_NOT_PROVEN", `Provider roster row ${rosterIndex} has no explicit cancellation state`);
  }
  const spot = toPositiveIntegerOrNull(row.spot ?? row.placeNumber);
  if (!isCancelled && !spot) {
    throw errorWithCode("PROVIDER_ACTIVE_SPOT_NOT_PROVEN", `Provider roster row ${rosterIndex} has no positive spot`);
  }
  return {
    clientId,
    name,
    spot,
    isCancelled,
  };
}

async function readJson(response, label) {
  if (!response || response.ok !== true) {
    const status = Number(response?.status);
    const statusLabel = Number.isInteger(status) ? `HTTP_${status}` : "TRANSPORT_ERROR";
    throw errorWithCode(`${label}_READ_FAILED`, `${label} read failed: ${statusLabel}`);
  }
  try {
    return await response.json();
  } catch {
    throw errorWithCode(`${label}_JSON_INVALID`, `${label} returned invalid JSON`);
  }
}

export async function loadTimeForFriendsProviderEnrollment({
  tournamentId,
  fetchImpl = globalThis.fetch,
  vivaBaseUrl = "https://api.vivacrm.ru",
  participantBaseUrl = "https://padlhub.su",
  tenantKey = "iSkq6G",
  timeoutMs = 20_000,
}) {
  const exerciseId = toStringOrNull(tournamentId);
  if (!exerciseId || !UUID_RE.test(exerciseId)) {
    throw errorWithCode("PROVIDER_EXERCISE_ID_INVALID", "Provider enrollment requires an exact Viva exercise UUID");
  }
  if (typeof fetchImpl !== "function") {
    throw errorWithCode("PROVIDER_FETCH_UNAVAILABLE", "Provider enrollment fetch is unavailable");
  }
  const vivaFetch = createVivaFetch(fetchImpl);

  const exerciseUrl = new URL(
    `/end-user/api/v1/${encodeURIComponent(tenantKey)}/exercises/${encodeURIComponent(exerciseId)}`,
    vivaBaseUrl,
  );
  const participantsUrl = new URL("/lk/tournaments/participants", participantBaseUrl);
  participantsUrl.searchParams.set("exerciseId", exerciseId);
  participantsUrl.searchParams.set("size", "200");
  const requestOptions = {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  };
  const [exerciseResponse, participantsResponse] = await Promise.all([
    vivaFetch(exerciseUrl, requestOptions),
    fetchImpl(participantsUrl, requestOptions),
  ]);
  const [exercise, participantsPayload] = await Promise.all([
    readJson(exerciseResponse, "PROVIDER_EXERCISE"),
    readJson(participantsResponse, "PROVIDER_PARTICIPANTS"),
  ]);

  const returnedExerciseId = toStringOrNull(exercise?.id ?? exercise?.exerciseId);
  if (returnedExerciseId !== exerciseId) {
    throw errorWithCode("PROVIDER_EXERCISE_ID_CONFLICT", "Provider exercise response does not match the requested UUID");
  }
  const directionId = toStringOrNull(exercise?.direction?.id ?? exercise?.directionId);
  const stationId = toStringOrNull(exercise?.studio?.id ?? exercise?.station?.id ?? exercise?.studioId ?? exercise?.stationId);
  const maxParticipants = toPositiveIntegerOrNull(
    exercise?.maxClientsCount ?? exercise?.maxParticipants ?? exercise?.capacity,
  );
  if (!directionId) throw errorWithCode("PROVIDER_DIRECTION_ID_NOT_PROVEN", "Provider direction id is missing");
  if (!stationId) throw errorWithCode("PROVIDER_STATION_ID_NOT_PROVEN", "Provider station id is missing");
  if (!maxParticipants) throw errorWithCode("PROVIDER_CAPACITY_NOT_PROVEN", "Provider capacity is missing");

  const rawParticipants = participantRows(participantsPayload);
  if (rawParticipants.length > 200) {
    throw errorWithCode("PROVIDER_ROSTER_LIMIT_EXCEEDED", "Provider roster exceeds the bounded 200-row response");
  }
  const participants = rawParticipants.map(normalizeParticipant);
  const playerIds = new Set();
  const activeSpots = new Set();
  let activeInCapacity = 0;
  participants.forEach((participant) => {
    if (playerIds.has(participant.clientId)) {
      throw errorWithCode("PROVIDER_PLAYER_ID_DUPLICATE", "Provider roster contains a duplicate client UUID");
    }
    playerIds.add(participant.clientId);
    if (participant.isCancelled) return;
    if (activeSpots.has(participant.spot)) {
      throw errorWithCode("PROVIDER_ACTIVE_SPOT_DUPLICATE", "Provider roster contains a duplicate active spot");
    }
    activeSpots.add(participant.spot);
    if (participant.spot <= maxParticipants) activeInCapacity += 1;
  });
  if (activeInCapacity > maxParticipants) {
    throw errorWithCode("PROVIDER_ACTIVE_CAPACITY_EXCEEDED", "Provider active roster exceeds proven capacity");
  }

  return {
    source: "VIVA_PUBLIC_ROSTER",
    exerciseId,
    directionId,
    stationId,
    maxParticipants,
    participants: asArray(participants),
  };
}
import { createVivaFetch } from "./vivaUserAgent.mjs";

import type {
  Exercise,
  ExerciseBooking,
  TournamentHistoryRecord,
} from "../../utils/apiClient";

export const TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS = {
  active: 60_000,
  unchanged: 120_000,
  max: 300_000,
} as const;

export const TOURNAMENT_PARTICIPANT_BUSY_RETRY_MS = 30_000;

export function resolveTournamentParticipantBusyRetryMs(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return TOURNAMENT_PARTICIPANT_BUSY_RETRY_MS;
  }
  const retryAfterMs = Number((payload as Record<string, unknown>).retryAfterMs);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return TOURNAMENT_PARTICIPANT_BUSY_RETRY_MS;
  }
  return Math.min(60_000, Math.max(1_000, Math.ceil(retryAfterMs)));
}

export function shouldApplyTournamentParticipantRefreshRoster(
  reason: string,
  refreshedAt: string | null | undefined,
) {
  return reason === "refreshed"
    || (reason === "stale_if_error" && Boolean(String(refreshedAt || "").trim()));
}

export type TournamentParticipantRefreshOutcome =
  | "initial"
  | "changed"
  | "unchanged"
  | "error";

const VIVA_EXERCISE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveTournamentParticipantRefreshDelay(
  outcome: TournamentParticipantRefreshOutcome,
  previousDelayMs = 0,
) {
  if (outcome === "error") {
    return TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.max;
  }
  if (outcome === "initial" || outcome === "changed") {
    return TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.active;
  }
  if (previousDelayMs < TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.unchanged) {
    return TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.unchanged;
  }
  return TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.max;
}

function normalizeFingerprintValue(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

export function buildTournamentParticipantRosterFingerprint(
  participants: readonly ExerciseBooking[],
) {
  const entries = participants.map((participant) => ({
    bookingId: normalizeFingerprintValue(participant.id),
    clientId: normalizeFingerprintValue(participant.client?.id),
    firstName: normalizeFingerprintValue(participant.client?.firstName),
    lastName: normalizeFingerprintValue(participant.client?.lastName),
    middleName: normalizeFingerprintValue(participant.client?.middleName),
    rating: normalizeFingerprintValue(participant.rating),
    spot: Number.isFinite(participant.spot) ? Number(participant.spot) : null,
  }));

  entries.sort((left, right) => {
    const leftKey = `${left.clientId}:${left.bookingId}:${left.spot ?? ""}`;
    const rightKey = `${right.clientId}:${right.bookingId}:${right.spot ?? ""}`;
    return leftKey.localeCompare(rightKey);
  });

  return JSON.stringify(entries);
}

export function resolveVivaLinkedTournamentExerciseId(
  tournament: Exercise | null,
  historyRecord?: TournamentHistoryRecord | null,
) {
  if (!tournament) return null;

  const historyParams = historyRecord?.params && typeof historyRecord.params === "object"
    ? historyRecord.params
    : null;
  if (historyParams?.manualTournament === true) {
    return null;
  }

  const tournamentRecord = tournament as Exercise & Record<string, unknown>;
  const candidates = [
    historyParams?.vivaExerciseId,
    historyParams?.sourceExerciseId,
    tournamentRecord.vivaExerciseId,
    tournamentRecord.sourceTournamentId,
    tournamentRecord.exerciseId,
    tournament.id,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (VIVA_EXERCISE_ID_PATTERN.test(normalized)) return normalized;
  }
  return null;
}

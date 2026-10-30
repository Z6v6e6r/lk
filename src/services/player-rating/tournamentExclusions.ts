import {
  buildTournamentCompensationEvent,
  eventAppliesToCanonicalState,
  ratingGradeFromNumeric,
  replayPlayerRatingEvents,
  roundPlayerRating,
  type PlayerRatingEventDocument,
} from "./ledger.ts";

export interface TournamentRatingExclusion {
  playerId: string;
  scopes: Array<"community" | "level">;
  auditId: string;
  reason: string;
  recordedAt: string;
}

// Admin-owned top-level metadata. Public tournament saves must never accept or
// replace it. Scores, rounds, standings and the original participant count stay intact.
export function getTournamentRatingExclusion(
  tournament: Record<string, unknown>,
  playerId: unknown,
  scope: "community" | "level",
): TournamentRatingExclusion | null {
  if (typeof playerId !== "string" || !playerId.trim()) return null;
  const exclusions = Array.isArray(tournament.ratingExclusions) ? tournament.ratingExclusions : [];
  for (const value of exclusions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.playerId !== playerId || !Array.isArray(row.scopes) || !row.scopes.includes(scope)) continue;
    if (typeof row.auditId !== "string" || !row.auditId.trim()
      || typeof row.reason !== "string" || !row.reason.trim()
      || typeof row.recordedAt !== "string" || !Number.isFinite(Date.parse(row.recordedAt))) {
      throw new Error("INVALID_TOURNAMENT_RATING_EXCLUSION");
    }
    return row as unknown as TournamentRatingExclusion;
  }
  return null;
}

export function planTournamentRatingAnnulment(input: {
  tournament: Record<string, unknown>;
  clientId: string;
  events: PlayerRatingEventDocument[];
}): PlayerRatingEventDocument[] {
  const exclusion = getTournamentRatingExclusion(input.tournament, input.clientId, "level");
  if (!exclusion) return [];
  const tournamentId = input.tournament.tournamentId ?? input.tournament.id;
  const events = input.events.filter((event) => (
    event.player.clientId === input.clientId || event.player.key === `client:${input.clientId}`
  ));
  const compensatedIds = new Set(events.map((event) => event.source.compensatesEventId));
  const active = events.filter((event) => (
    event.source.domain === "TOURNAMENT" && event.source.sourceId === tournamentId
    && !event.source.compensatesEventId && !compensatedIds.has(event.id)
    && eventAppliesToCanonicalState(event)
  ));
  if (active.length === 0) return [];
  const replay = replayPlayerRatingEvents(events);
  if (!replay) throw new Error("ANNULMENT_REQUIRES_RATING_BASELINE");
  const recordedAt = new Date(exclusion.recordedAt).toISOString();
  if (events.some((event) => eventAppliesToCanonicalState(event)
    && Date.parse(event.occurredAt) > Date.parse(recordedAt))) {
    throw new Error("ANNULMENT_PRECEDES_LEDGER_FRONTIER");
  }
  let currentRating = replay.ratingNumeric;
  const planned = active.map((event) => {
    // A later baseline may already absorb this result. Blind subtraction would
    // corrupt the player's level; such history needs a separate reconciliation.
    if (Date.parse(event.occurredAt) < Date.parse(replay.baselineAt)) {
      throw new Error("ANNULMENT_PRECEDES_RATING_BASELINE");
    }
    const compensation = buildTournamentCompensationEvent({
      event, occurredAt: recordedAt, createdAt: recordedAt, reason: "ANNULLED",
    });
    if (!compensation) throw new Error("ANNULMENT_REQUIRES_FINITE_DELTA");
    const nextRating = roundPlayerRating(currentRating + (compensation.change.delta as number));
    compensation.change = {
      before: currentRating,
      delta: compensation.change.delta,
      after: nextRating,
      gradeBefore: ratingGradeFromNumeric(currentRating),
      gradeAfter: ratingGradeFromNumeric(nextRating),
    };
    currentRating = nextRating;
    compensation.source.annulmentId = exclusion.auditId;
    compensation.source.annulmentReason = exclusion.reason;
    return compensation;
  });
  // Refuse histories where clamping or a baseline makes a simple inverse delta
  // disagree with complete ledger replay. Never silently reconcile that history.
  if (replayPlayerRatingEvents([...events, ...planned])?.ratingNumeric !== currentRating) {
    throw new Error("ANNULMENT_REPLAY_MISMATCH");
  }
  return planned;
}

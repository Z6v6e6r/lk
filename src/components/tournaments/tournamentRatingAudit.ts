import type { OnboardingLevelPayload, TournamentStartRatingChange } from "../../utils/apiClient";

interface TournamentRatingChangeActor {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
}

interface BuildTournamentRatingChangePayloadInput {
  tournamentId: string;
  clientId: string;
  playerName: string;
  playerPhone?: string | null;
  previousRating: number | null;
  nextRating: number;
  levelLetter: string;
  changedAt: string;
  changedBy: TournamentRatingChangeActor;
}

interface TournamentStartParticipantRating {
  participantId: string;
  clientId: string | null;
  name: string;
  phone: string | null;
  previousRating: number | null;
  nextRating: number | null;
  reason: TournamentStartRatingChange["source"]["reason"];
}

interface BuildTournamentStartRatingChangesInput {
  tournamentId: string;
  changedAt: string;
  changedBy: TournamentRatingChangeActor;
  participants: TournamentStartParticipantRating[];
}

function eventIdPart(value: string) {
  return encodeURIComponent(String(value || "unknown").trim() || "unknown").replace(/%/g, "~");
}

export function buildTournamentRatingChangePayload(
  input: BuildTournamentRatingChangePayloadInput,
): OnboardingLevelPayload {
  const changedAt = new Date(input.changedAt).toISOString();
  const changedByName = [input.changedBy.firstName, input.changedBy.lastName]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");

  return {
    clientId: input.clientId,
    phone: input.playerPhone ?? null,
    levelLetter: input.levelLetter,
    levelNumeric: input.nextRating,
    source: "tournament_start",
    gameId: input.tournamentId,
    playerName: input.playerName,
    previousRating: input.previousRating,
    nextRating: input.nextRating,
    confirmedAt: changedAt,
    changedById: input.changedBy.id,
    changedByName: changedByName || null,
    changedByPhone: input.changedBy.phone || null,
    eventId: [
      "rating_evt",
      "tournament_start",
      eventIdPart(input.tournamentId),
      eventIdPart(input.clientId),
      String(Date.parse(changedAt)),
    ].join(":"),
  };
}

export function buildTournamentStartRatingChanges(
  input: BuildTournamentStartRatingChangesInput,
): TournamentStartRatingChange[] {
  const occurredAt = new Date(input.changedAt).toISOString();
  const changedByName = [input.changedBy.firstName, input.changedBy.lastName]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");

  return input.participants.flatMap((participant) => {
    if (participant.nextRating == null || participant.nextRating === participant.previousRating) return [];

    return [{
      eventId: [
        "rating_evt",
        "tournament_start",
        eventIdPart(input.tournamentId),
        eventIdPart(participant.clientId || participant.participantId),
        String(Date.parse(occurredAt)),
      ].join(":"),
      eventType: "TOURNAMENT_START_RATING_CHANGED",
      occurredAt,
      source: {
        domain: "TOURNAMENT",
        tournamentId: input.tournamentId,
        reason: participant.reason,
      },
      player: {
        participantId: participant.participantId,
        clientId: participant.clientId,
        name: participant.name,
        phone: participant.phone,
      },
      change: {
        before: participant.previousRating,
        after: participant.nextRating,
      },
      changedBy: {
        id: input.changedBy.id,
        name: changedByName || null,
        phone: input.changedBy.phone || null,
      },
    }];
  });
}

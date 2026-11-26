import type { TournamentStartRatingChange } from "../../utils/apiClient";

interface TournamentRatingChangeActor {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
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

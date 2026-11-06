import { createFprState, applyFprCommand, type FprCommand } from "../../../src/components/tournaments/fpr6x25.ts";
const began = Date.parse("2026-11-01T10:00:00Z");
export function ratingFixture(n = 8, rounds = 6, levels?: number[]) {
  let state = createFprState({ tournamentId: "fpr-rating-synthetic", players: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name: `Synthetic ${i}`, level: levels?.[i] ?? 2 + i / 10, leaguePoints: n - i, leaguePlace: i + 1,
  })), courts: Array.from({ length: Math.floor(n / 4) }, (_, i) => `Court ${i}`), now: new Date(began).toISOString(),
  endsAt: new Date(began + 10800000).toISOString(), leagueSource: "Synthetic", reserveAllowed: true, testMode: false,
  communityRating: { policy: "community-tournament-v1", communityId: "synthetic", communityName: "Synthetic", period: "month",
    snapshotUpdatedAt: null, sourceExerciseId: "synthetic-source", publicationId: "synthetic-post" } });
  let tick = 0;
  const command = (input: Record<string, unknown>) => {
    state = applyFprCommand(state, { id: `synthetic-command-${++tick}`, expectedRevision: state.revision, ...input } as FprCommand,
      new Date(began + tick * 1000).toISOString());
  };
  for (let r = 0; r < rounds; r++) {
    if (!state.attempts.some(a => a.status === "scheduled" || a.status === "running")) command({ action: "prepare_round" });
    command({ action: "start_round" });
    for (const [index, m] of state.attempts.at(-1)!.matches.entries()) {
      const score1 = (r * 7 + index * 3) % 26;
      command({ action: "score", matchId: m.id, score1, score2: 25 - score1, confirmed1: true, confirmed2: true });
    }
    command({ action: "close_round" });
  }
  command({ action: "finish" });
  return state;
}

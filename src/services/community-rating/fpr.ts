import { validateFprState, fprCompletedRounds, type FprState } from "../../components/tournaments/fpr6x25.ts";

type RecordValue = Record<string, unknown>;
export type FprCommunitySelection = { status: "ambiguous"; eventId: string }
  | { status: "selected"; eventId: string; state: FprState; tournament: RecordValue; post: RecordValue; legacySource?: RecordValue };
const text = (value: unknown) => value == null ? "" : String(value).trim();
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

// Publications remain the ordinary authorization/scoping boundary. A new FPR
// result replaces this physical event's community fact, never its old document
// or its level ledger. Several completed protocols never become last-write-wins.
export function selectFprCommunityResults(input: {
  communityId: string; posts: RecordValue[]; tournaments: RecordValue[];
  postLink: (post: RecordValue) => string;
}): Map<string, FprCommunitySelection> {
  const posts = input.posts.filter(p => p.archived !== true && text(p.communityId) === input.communityId
    && text(p.kind || p.type).toUpperCase() === "TOURNAMENT");
  const grouped = new Map<string, Array<{ state: FprState; tournament: RecordValue; posts: RecordValue[] }>>();
  for (const tournament of input.tournaments) {
    if (tournament.archived === true || tournament.tournamentType !== "fpr_6x25") continue;
    const state = record(record(tournament.params).fpr6x25);
    const binding = record(state.communityRating);
    if (state.testMode !== false || binding.policy !== "community-tournament-v1" || binding.communityId !== input.communityId) continue;
    try { validateFprState(state); } catch { continue; }
    if (state.tournamentId !== tournament.tournamentId || state.status !== "completed"
      || fprCompletedRounds(state) < 6 || fprCompletedRounds(state) > 8) continue;
    const eventId = state.communityRating!.sourceExerciseId || state.tournamentId;
    const matching = posts.filter(post => [eventId, state.tournamentId].includes(input.postLink(post))
      && (!state.communityRating!.publicationId || text(post.id ?? post._id) === state.communityRating!.publicationId));
    if (!matching.length) continue;
    const group = grouped.get(eventId) ?? [];
    group.push({ state, tournament, posts: matching }); grouped.set(eventId, group);
  }
  const result = new Map<string, FprCommunitySelection>();
  for (const [eventId, candidates] of grouped) {
    const legacy = input.tournaments.filter(t => t.archived !== true && t.tournamentType !== "fpr_6x25"
      && [t.tournamentId, t.id, t.exerciseId, t.sourceTournamentId].some(id => text(id) === eventId));
    const candidate = candidates[0];
    const post = [...candidate.posts].sort((a, b) => {
      const role = (p: RecordValue) => text(p.publicationRole || p.ratingRole || record(p.details).publicationRole).toUpperCase() === "RATING_PRIMARY" ? 0 : 1;
      return role(a) - role(b) || text(a.id ?? a._id).localeCompare(text(b.id ?? b._id));
    })[0];
    const selected: FprCommunitySelection = candidates.length !== 1 || legacy.length > 1
      ? { status: "ambiguous", eventId }
      : { status: "selected", eventId, ...candidate, post, legacySource: legacy[0] };
    // Cover all repeated publications of the event, including direct FPR links,
    // so a later discovery post cannot overwrite its selected result with legacy.
    for (const linked of posts) if ([eventId, ...candidates.map(c => c.state.tournamentId)].includes(input.postLink(linked))) {
      const key = input.postLink(linked), previous = result.get(key);
      result.set(key, previous?.status === "ambiguous" ? previous
        : previous && previous.eventId !== eventId ? { status: "ambiguous", eventId } : selected);
    }
  }
  return result;
}

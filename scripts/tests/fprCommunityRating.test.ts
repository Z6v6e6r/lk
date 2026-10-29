import test from "node:test";
import assert from "node:assert/strict";
import { createFprState, applyFprCommand, fprProjection, fprStandings, type FprCommand } from "../../src/components/tournaments/fpr6x25.ts";
import { extractCommunityRatingFacts } from "../../src/services/community-rating/facts.ts";
import { calculateTournamentRawScore } from "../../src/services/community-rating/calculations.ts";
import { buildCommunityMonthlyReport } from "../../src/services/community-rating/monthly.ts";
import { isTournamentFinalized, resolveIncrementalCommunityIds } from "../rating_worker.mjs";
import { assignLeagueResults } from "../../src/services/community-rating/league.ts";
import { DEFAULT_LEAGUE_DIVISIONS } from "../../src/services/community-policy.ts";
const began = Date.parse("2026-10-12T10:00:00Z");
const at = (s: number) => new Date(began + s * 1000).toISOString();
function fixture(id = "fpr-community-test", n = 4, withdraw = false, rounds = 6) {
  let state = createFprState({ tournamentId: id, players: Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, name: `Synthetic ${i + 1}`, level: 2 + i / 10, leaguePlace: i + 1, leaguePoints: i < 2 ? 0 : 1,
  })), courts: Array.from({ length: Math.floor(n / 4) }, (_, i) => `Court ${i + 1}`), leagueSource: "Club · October",
  now: at(0), endsAt: at(10800), reserveAllowed: true, testMode: false,
  communityRating: { policy: "community-tournament-v1", communityId: "club", communityName: "Club", period: "month",
    snapshotUpdatedAt: at(0), sourceExerciseId: "source-event", publicationId: "publication" } });
  let seconds = 0;
  const command = (action: Record<string, unknown>) => { state = applyFprCommand(state,
    { id: `cmd-${state.revision + 1}`, expectedRevision: state.revision, ...action } as FprCommand, at(++seconds)); };
  const seen = new Map<string, number>();
  for (let r = 0; r < rounds; r++) {
    command({ action: "start_round" });
    for (const m of state.attempts.at(-1)!.matches) {
      const key = [...m.pair1].sort().join(":"); const occurrence = seen.get(key) ?? 0; seen.set(key, occurrence + 1);
      const score1 = occurrence % 2 ? 12 : 13;
      command({ action: "score", matchId: m.id, score1, score2: 25 - score1, confirmed1: true, confirmed2: true });
    }
    command({ action: "close_round" });
  }
  if (withdraw) { command({ action: "prepare_round" }); command({ action: "start_round" }); command({ action: "withdraw", playerId: "p1", reason: "DNF" }); }
  command({ action: "finish" });
  const tournament = { tournamentId: id, tournamentType: "fpr_6x25", participants: state.players, ...fprProjection(state) };
  const post = { id: "publication", communityId: "club", kind: "TOURNAMENT", relatedTournamentId: "source-event", publicationRole: "RATING_PRIMARY", startAt: at(0), publishedAt: at(0) };
  const community = { id: "club", members: state.players.map(p => ({ id: p.id, name: p.name, levelScore: 7 })) };
  return { state, tournament, post, community };
}
function facts(f: ReturnType<typeof fixture>, tournaments: unknown[] = [f.tournament], posts: unknown[] = [f.post]) {
  return extractCommunityRatingFacts({ community: f.community, tournaments, feedPosts: posts, collectedAt: at(1000) });
}
test("published FPR uses the normal community formula, canonical shared ranks and frozen level without enabling level awards", () => {
  const f = fixture(); const result = facts(f); const expected = fprStandings(f.state);
  assert.equal(result.length, 4); assert.equal(isTournamentFinalized(f.tournament), false);
  assert.deepEqual(expected.map(r => r.rank), [1, 1, 3, 3]);
  for (const fact of result) {
    assert.equal(fact.eventType, "tournament"); if (fact.eventType !== "tournament") continue;
    const row = expected.find(r => r.id === fact.playerId)!;
    assert.equal(fact.eventId, "source-event"); assert.equal(fact.metrics.place, row.rank);
    assert.equal(fact.metrics.tournamentRawScore, calculateTournamentRawScore({ participantsCount: 4, place: row.rank!,
      tournamentMatchesWon: row.wins, tournamentPointsScored: row.pointsFor, tournamentPointsDiff: row.pointsFor - row.pointsAgainst }));
    assert.equal(fact.sourceLevelAtEvent, f.state.players.find(p => p.id === fact.playerId)!.level);
    assert.equal(fact.sourceProtocolId, f.state.tournamentId);
  }
});
test("one FPR replaces legacy community metrics once, preserves event fact IDs and ignores corrupted root standings", () => {
  const f = fixture(); const original = facts(f);
  f.tournament.standings = [];
  const legacy = { tournamentId: "source-event", participants: f.state.players, params: { finished: true }, standings: [{ id: "p1", name: "Synthetic 1", rank: 1, wins: 99, pointsFor: 999 }] };
  const repeatedPost = { ...f.post, id: "discovery", publicationRole: "DISCOVERY_ONLY" };
  const result = facts(f, [legacy, f.tournament], [repeatedPost, f.post, repeatedPost]);
  assert.deepEqual(result.map(r => r.id).sort(), original.map(r => r.id).sort());
  assert.equal(result.length, 4); assert.deepEqual(result.map(r => r.metrics), original.map(r => r.metrics));
});
test("several eligible protocols and competing legacy documents fail closed; old tests do not cause ambiguity", () => {
  const f = fixture(); const second = fixture("fpr-second");
  assert.equal(facts(f, [f.tournament, second.tournament]).length, 0);
  const testProtocol = structuredClone(second.tournament); testProtocol.params.fpr6x25.testMode = true;
  assert.equal(facts(f, [f.tournament, testProtocol]).length, 4);
  const legacy = { tournamentId: "source-event", params: { finished: true } };
  assert.equal(facts(f, [f.tournament, legacy, structuredClone(legacy)]).length, 0);
});
test("unpublished, archived, wrong-community, mismatched-publication and old test protocols never accrue", () => {
  const f = fixture(); assert.equal(facts(f, [f.tournament], []).length, 0);
  assert.equal(facts(f, [f.tournament], [{ ...f.post, archived: true }]).length, 0);
  assert.equal(facts(f, [f.tournament], [{ ...f.post, communityId: "other" }]).length, 0);
  assert.equal(facts(f, [f.tournament], [{ ...f.post, id: "other" }]).length, 0);
  const old = structuredClone(f.tournament); old.params.fpr6x25.testMode = true;
  assert.equal(facts(f, [old], [{ ...f.post, relatedTournamentId: old.tournamentId }]).length, 0);
});
test("DNF has no placement award and an unmatched ID never receives a namesake member's points", () => {
  const f = fixture("fpr-dnf", 8, true); const result = facts(f);
  assert.equal(result.length, 7); assert.ok(result.every(r => r.playerId !== "p1"));
  assert.ok(result.every(r => r.eventType === "tournament" && r.metrics.participantsCount === 8));
  f.community.members = f.community.members.map(p => ({ ...p, id: "unrelated-" + p.id }));
  assert.equal(facts(f).length, 0);
});
test("the usual publication calendar keeps a previous-month FPR event out of this month", () => {
  const f = fixture(); const post = { ...f.post, startAt: "2026-09-30T10:00:00Z" };
  const report = buildCommunityMonthlyReport({ community: f.community, feedPosts: [post], tournaments: [f.tournament],
    games: [], visits: [], ratingEvents: [], ratingStates: [] }, Date.parse("2026-10-29T10:00:00Z"));
  assert.equal(report.tournamentsCount, 0);
});
test("canonical source annulments remain effective when its community result is replaced by FPR", () => {
  const f = fixture();
  const legacy = { tournamentId: "source-event", ratingExclusions: [{ playerId: "p1", scopes: ["community"],
    auditId: "annulment", reason: "Synthetic annulment", recordedAt: at(100) }] };
  const result = facts(f, [legacy, f.tournament]);
  assert.equal(result.length, 3); assert.ok(result.every(row => row.playerId !== "p1"));
});
test("a protocol cannot use another FPR protocol as its physical source", () => {
  const f = fixture(), second = fixture("fpr-second");
  second.state.communityRating!.sourceExerciseId = f.state.tournamentId;
  second.state.communityRating!.publicationId = "other-post";
  const duplicate = { ...f.post, id: "other-post", relatedTournamentId: f.state.tournamentId };
  assert.equal(facts(f, [f.tournament, second.tournament], [f.post, duplicate, duplicate]).length, 4);
});
test("month filtering cannot restore legacy metrics or clear an ambiguity from the full publication context", () => {
  const f = fixture();
  const oldPost = { ...f.post, startAt: "2026-09-30T10:00:00Z" };
  const currentPost = { ...f.post, id: "current-post" };
  const legacy = { tournamentId: "source-event", params: { finished: true }, standings: [{ id: "p1", name: "Synthetic 1", rank: 1, pointsFor: 900 }] };
  const source = { community: f.community, feedPosts: [oldPost, currentPost], tournaments: [legacy, f.tournament], games: [], visits: [], ratingEvents: [], ratingStates: [] };
  assert.equal(buildCommunityMonthlyReport(source, Date.parse("2026-10-29T10:00:00Z")).tournamentsCount, 0);
  const second = fixture("fpr-second"); second.state.communityRating!.publicationId = "current-post";
  source.tournaments.push(second.tournament);
  assert.equal(buildCommunityMonthlyReport(source, Date.parse("2026-10-29T10:00:00Z")).tournamentsCount, 0);
});
test("an incomplete FPR tournament has no community award", () => {
  const f = fixture("fpr-incomplete", 4, false, 2);
  assert.equal(f.state.status, "incomplete"); assert.equal(facts(f).length, 0);
});
test("league division uses the frozen FPR level and keeps a persisted assignment on correction", () => {
  const f = fixture(); const result = facts(f);
  const community = { id: "club", communityType: "LEAGUE", typeSettingsRevision: 1, typeSettingsEffectiveAt: at(-100),
    typeSettings: { divisions: DEFAULT_LEAGUE_DIVISIONS } };
  const initial = assignLeagueResults({ community, facts: result, ratingEvents: [], records: [], nowIso: at(1000) });
  assert.equal(initial.assignments.length, 4);
  assert.ok(initial.assignments.every(a => a.levelAtEvent! < 3 && a.division?.id === "d-plus-c"));
  const later = assignLeagueResults({ community, facts: result.map(r => ({ ...r, sourceLevelAtEvent: 5 })),
    existing: initial.assignments, ratingEvents: [], records: [], nowIso: at(2000) });
  assert.equal(later.assignments.length, 0); assert.ok(later.facts.every(r => r.leagueDivision?.id === "d-plus-c"));
});
test("an updated bound FPR schedules its community incrementally without a direct FPR feed link", async () => {
  for (const testMode of [false, true]) {
    const calls: Array<{ name: string; options: unknown }> = [];
    const db = { collection: (name: string) => ({ find: (_query: unknown, options: unknown) => {
      calls.push({ name, options });
      return { toArray: async () => name === "tournaments" ? [{ tournamentType: "fpr_6x25", tournamentId: "fpr-x",
        params: { fpr6x25: { testMode, communityRating: { policy: "community-tournament-v1", communityId: "club" } } } }] : [] };
    } }) };
    assert.deepEqual(await resolveIncrementalCommunityIds(db, at(0), false), testMode ? [] : ["club"]);
    assert.ok(JSON.stringify(calls.find(c => c.name === "tournaments")?.options).includes("params.fpr6x25.communityRating"));
  }
});

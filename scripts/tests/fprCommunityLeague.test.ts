import test from "node:test";
import assert from "node:assert/strict";
import { createFprState } from "../../src/components/tournaments/fpr6x25.ts";
import { loadFprCommunityLeague as loadOriginal, type FprLeagueRanking } from "../../src/components/tournaments/fprCommunityLeague.ts";
import { resolveFprCommunitySelection } from "../../src/components/tournaments/fprCommunitySelection.ts";
const loadFprCommunityLeague = (input: Omit<Parameters<typeof loadOriginal>[0], "fetchLevels">) => loadOriginal({ ...input,
  fetchLevels: async () => ({ source: "CUP_CANONICAL", rows: input.players.map(p => ({ clientId: p.id, ratingNumeric: Number(p.rating), version: "canonical-event" })) }),
});
const players = [{ id: "p1", rating: "3.1" }, { id: "p2", rating: "2.5" }];
const data = (period: "month" | "all", ids = ["p1", "p2"]): FprLeagueRanking => ({
  communityId: "club", period, updatedAt: "2026-10-29T05:00:00Z",
  items: ids.map((id, index) => ({ playerId: id, rank: index + 1, overallScore: index ? 0 : 91.25, currentLevel: 4 })),
});
test("uses current month when every exact player ID is present, including a zero result", async () => {
  const calls: string[] = [];
  const result = await loadFprCommunityLeague({ communityId: "club", communityName: "Club", players,
    fetch: async period => { calls.push(period); return data(period); } });
  assert.deepEqual(calls, ["month"]); assert.equal(result.period, "month");
  assert.deepEqual(result.values.p2, { level: "2.5", points: "0", place: "2", newcomer: false });
});
test("one missing monthly player switches the entire roster to all-time", async () => {
  const calls: string[] = [];
  const result = await loadFprCommunityLeague({ communityId: "club", communityName: "Club", players,
    fetch: async period => { calls.push(period); return data(period, period === "month" ? ["p1"] : ["p2", "p1"]); } });
  assert.deepEqual(calls, ["month", "all"]); assert.equal(result.period, "all");
  assert.equal(result.values.p1.place, "2"); assert.equal(result.values.p2.place, "1");
  assert.deepEqual(result.missingFromMonth, ["p2"]);
});
test("only a successful all-time table can establish a player without League points", async () => {
  const result = await loadFprCommunityLeague({ communityId: "club", communityName: "Club", players,
    fetch: async period => data(period, ["p1"]) });
  assert.deepEqual(result.values.p2, { level: "2.5", points: "0", place: "", newcomer: true });
});
test("a failed monthly request is not evidence of missing player data and does not silently use all-time", async () => {
  const calls: string[] = [];
  await assert.rejects(() => loadFprCommunityLeague({ communityId: "club", communityName: "Club", players,
    fetch: async period => { calls.push(period); throw new Error("Unavailable"); } }), /Unavailable/);
  assert.deepEqual(calls, ["month"]);
});
test("rejects duplicate identities, invalid numbers and another community/period", async () => {
  for (const change of [
    (d: FprLeagueRanking) => { d.items.push(d.items[0]); },
    (d: FprLeagueRanking) => { d.items[0].overallScore = Number.NaN; },
    (d: FprLeagueRanking) => { d.communityId = "other"; },
    (d: FprLeagueRanking) => { d.period = "all"; },
  ]) await assert.rejects(() => loadFprCommunityLeague({ communityId: "club", communityName: "Club", players,
    fetch: async period => { const d = data(period); change(d); return d; } }));
});

const communities = [
  { id: "ordinary", name: "Игра на рейтинг" },
  { id: "terekhovo", name: 'ЛИГА Терехово "Время На Друзей" D+/C' },
  { id: "kotelniki", name: "Котельники Время На Друзей C/C+" },
  { id: "spaces", name: "ЛИГА ВРЕМЯ\u00a0НА   ДРУЗЕЙ D" },
  { id: "summer", name: "Лето. Падел. Дружба" },
];
const publication = (id: string, primary = false, name: string | null = null) => ({
  communityId: id, communityName: name, publicationId: `publication-${id}`,
  role: primary ? "RATING_PRIMARY" as const : "DISCOVERY_ONLY" as const,
});

test("unpublished tournaments offer only Time for Friends communities, sorted by name", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null, publishedCommunities: [] }, communities, "kotelniki");
  assert.equal(result.fixed, false);
  assert.deepEqual(result.choices.map(c => c.id), ["kotelniki", "spaces", "terekhovo"]);
  assert.equal(result.communityId, "kotelniki");
  assert.equal(result.communityName, communities[2].name);
  assert.equal(result.error, null);
  assert.equal(communities[0].id, "ordinary", "sorting must not mutate the API list");
});

test("a missing binding allows a single selection, but never restores an unrelated or unavailable choice", () => {
  for (const selectedId of ["ordinary", "summer", "removed", ""]) {
    assert.equal(resolveFprCommunitySelection(null, communities, selectedId).communityId, "");
  }
});

test("no eligible communities produces an empty list without selecting another community", () => {
  const result = resolveFprCommunitySelection(null, [communities[0]], "ordinary");
  assert.deepEqual(result.choices, []);
  assert.equal(result.communityId, "");
});

test("a single publication fixes its community even without ratingCommunityId or list access", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null,
    publishedCommunities: [publication("published", false, "Опубликованное сообщество")] }, [], "kotelniki");
  assert.equal(result.fixed, true);
  assert.equal(result.communityId, "published");
  assert.equal(result.communityName, "Опубликованное сообщество");
  assert.deepEqual(result.publishedNames, ["Опубликованное сообщество"]);
  assert.deepEqual(result.choices, []);
  assert.equal(result.error, null);
});

test("existing published communities stay fixed even when their names are outside Time for Friends", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: "ordinary",
    publishedCommunities: [publication("ordinary", true)] }, communities, "kotelniki");
  assert.equal(result.communityId, "ordinary");
  assert.equal(result.communityName, "Игра на рейтинг");
  assert.deepEqual(result.choices, []);
});

test("multiple publications offer their communities and default to the explicit primary", () => {
  const binding = { ratingCommunityId: "terekhovo",
    publishedCommunities: [publication("ordinary"), publication("terekhovo", true)] };
  const result = resolveFprCommunitySelection(binding, communities, "");
  assert.equal(result.fixed, false);
  assert.equal(result.communityId, "terekhovo");
  assert.deepEqual(result.publishedNames, [communities[0].name, communities[1].name]);
  assert.equal(result.error, null);
});

test("a publication role also establishes the primary community when the top-level ID is missing", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null,
    publishedCommunities: [publication("ordinary"), publication("terekhovo", true)] }, communities, "");
  assert.equal(result.communityId, "terekhovo");
  assert.equal(result.error, null);
});

test("multiple publications require a selection and only offer published communities", () => {
  const binding = { ratingCommunityId: null,
    publishedCommunities: [publication("ordinary"), publication("terekhovo")] };
  for (const selectedId of ["", "kotelniki", "removed"]) {
    const result = resolveFprCommunitySelection(binding, communities, selectedId);
    assert.equal(result.fixed, false);
    assert.equal(result.communityId, "");
    assert.deepEqual(result.choices.map(c => c.id), ["ordinary", "terekhovo"]);
    assert.equal(result.error, null);
    assert.equal(result.needsCommunityList, false);
  }
  assert.equal(resolveFprCommunitySelection(binding, communities, "ordinary").communityId, "ordinary");
  assert.equal(resolveFprCommunitySelection(binding, communities, "terekhovo").communityId, "terekhovo");
});

test("an organizer can override the primary with another published community", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: "terekhovo",
    publishedCommunities: [publication("ordinary"), publication("terekhovo", true)] }, communities, "ordinary");
  assert.equal(result.fixed, false);
  assert.equal(result.communityId, "ordinary");
});

test("published options work without list access and need no Time for Friends name", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null,
    publishedCommunities: [publication("hub", false, "хАБ Нагатинская"),
      publication("women", false, "ЖЕНСКАЯ ЛИГА D")] }, [], "women");
  assert.equal(result.communityId, "women");
  assert.equal(result.communityName, "ЖЕНСКАЯ ЛИГА D");
  assert.equal(result.choices.length, 2);
  assert.equal(result.needsCommunityList, false);
});

test("duplicate publications in one community do not require a new selection", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null,
    publishedCommunities: [publication("ordinary"), publication("ordinary")] }, communities, "");
  assert.equal(result.fixed, true);
  assert.equal(result.communityId, "ordinary");
});

test("a stale primary or competing primary roles never select the first publication", () => {
  for (const binding of [
    { ratingCommunityId: "removed", publishedCommunities: [publication("ordinary"), publication("terekhovo")] },
    { ratingCommunityId: null, publishedCommunities: [publication("ordinary", true), publication("terekhovo", true)] },
  ]) assert.equal(resolveFprCommunitySelection(binding, communities, "").communityId, "");
});

test("an existing rating binding remains fixed without publication metadata", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: "unknown", publishedCommunities: [] }, [], "kotelniki");
  assert.equal(result.fixed, true);
  assert.equal(result.communityName, "unknown");
  assert.equal(result.communityId, "unknown");
  assert.deepEqual(result.choices, []);
});

test("switching the published community changes first-round seeds from its own snapshot", async () => {
  const roster = Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}`, name: `Player ${i + 1}`, rating: "3" }));
  const binding = { ratingCommunityId: null,
    publishedCommunities: [publication("hub"), publication("women")] };
  const order = { hub: roster.map(p => p.id), women: ["p1", "p3", "p5", "p7", "p2", "p4", "p6", "p8"] };
  const plans = [];
  for (const id of ["hub", "women"] as const) {
    const choice = resolveFprCommunitySelection(binding, [], id);
    const league = await loadFprCommunityLeague({ communityId: choice.communityId,
      communityName: choice.communityName, players: roster,
      fetch: async period => ({ communityId: choice.communityId, period, updatedAt: "2026-11-14T11:00:00Z",
        items: order[id].map((playerId, i) => ({ playerId, rank: i + 1, overallScore: 80 - i, currentLevel: 3 })) }) });
    const state = createFprState({ tournamentId: "synthetic-event", now: "2026-11-14T11:00:00Z",
      endsAt: "2026-11-14T14:00:00Z", courts: ["Court 1", "Court 2"], leagueSource: id, reserveAllowed: false,
      communityRating: { policy: "community-tournament-v1", communityId: choice.communityId,
        communityName: choice.communityName, period: league.period, snapshotUpdatedAt: league.snapshotUpdatedAt,
        sourceExerciseId: "synthetic-event", publicationId: `publication-${id}` },
      players: roster.map(p => ({ id: p.id, name: p.name, level: Number(league.values[p.id].level),
        leaguePlace: Number(league.values[p.id].place), leaguePoints: Number(league.values[p.id].points) })) });
    assert.deepEqual(state.players.map(p => p.id), order[id]);
    assert.equal(state.communityRating?.communityId, id);
    plans.push(state.attempts[0].matches);
  }
  assert.notDeepEqual(plans[0], plans[1]);
});

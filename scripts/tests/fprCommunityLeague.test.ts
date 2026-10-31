import test from "node:test";
import assert from "node:assert/strict";
import { loadFprCommunityLeague, type FprLeagueRanking } from "../../src/components/tournaments/fprCommunityLeague.ts";
import { resolveFprCommunitySelection } from "../../src/components/tournaments/fprCommunitySelection.ts";
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

test("multiple publications display all names and use the explicit primary community", () => {
  const binding = { ratingCommunityId: "terekhovo",
    publishedCommunities: [publication("ordinary"), publication("terekhovo", true)] };
  const result = resolveFprCommunitySelection(binding, communities, "kotelniki");
  assert.equal(result.fixed, true);
  assert.equal(result.communityId, "terekhovo");
  assert.deepEqual(result.publishedNames, [communities[0].name, communities[1].name]);
  assert.equal(result.error, null);
});

test("a publication role also establishes the primary community when the top-level ID is missing", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null,
    publishedCommunities: [publication("ordinary"), publication("terekhovo", true)] }, communities, "kotelniki");
  assert.equal(result.communityId, "terekhovo");
  assert.equal(result.error, null);
});

test("ambiguous publications never expose a selector or silently choose an unrelated community", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: null,
    publishedCommunities: [publication("ordinary"), publication("terekhovo")] }, communities, "kotelniki");
  assert.equal(result.fixed, true);
  assert.equal(result.communityId, "");
  assert.deepEqual(result.choices, []);
  assert.match(result.error!, /рейтинговое сообщество/);
});

test("an existing rating binding remains fixed without publication metadata", () => {
  const result = resolveFprCommunitySelection({ ratingCommunityId: "unknown", publishedCommunities: [] }, [], "kotelniki");
  assert.equal(result.fixed, true);
  assert.equal(result.communityName, "unknown");
  assert.equal(result.communityId, "unknown");
  assert.deepEqual(result.choices, []);
});

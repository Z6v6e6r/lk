import test from "node:test";
import assert from "node:assert/strict";
import { loadFprCommunityLeague, type FprLeagueRanking } from "../../src/components/tournaments/fprCommunityLeague.ts";
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

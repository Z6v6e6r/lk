import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { communityMonthWindow, eventInstant, publicPublishedEvent, publicRankingRow } from "../../src/services/community-rating/monthlyContract.ts";
import { buildCommunityMonthlyReport } from "../../src/services/community-rating/monthly.ts";
import type { CommunityRatingSourceData } from "../../src/services/community-rating/recalculation.ts";
import { buildCommunityMonthlyFlow } from "../patch_nodered_community_monthly_flow.mjs";

const syntheticPhone = ["+7", "999", "0000000"].join("");
const now = Date.parse("2026-10-05T11:00:00Z");
const post = (id: string, start = "2026-10-06T17:00:00+03:00") => ({ id: "post:" + id, communityId: "c", kind: "TOURNAMENT", relatedTournamentId: id, title: "Турнир", details: { publicTournament: { exerciseId: id, startsAt: start } } });
function flow() {
  return [
    { id: "community", type: "tab" }, { id: "tournament", type: "tab" }, { id: "mongo", type: "mongodb4-client" },
    { id: "legacy_rating", type: "http in", z: "community", method: "get", url: "/lk/communities/:communityId/rating", wires: [] },
    { id: "legacy_mongo", type: "mongodb4", z: "community", collection: "lk_communities", clientNode: "mongo", wires: [] },
    { id: "2e70b2e547e77c00", type: "function", z: "tournament", func: fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_recalculate.js", "utf8"), wires: [] },
    { id: "4f0f1ce8189a9e8c", type: "function", z: "tournament", func: fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_prepare.js", "utf8"), wires: [] },
    { id: "745f991e11130b08", type: "function", z: "tournament", func: fs.readFileSync("scripts/nodered_games_nodes/fn_tournament_save_ack.js", "utf8"), wires: [] },
  ];
}
export { flow as monthlyTestFlow };
const source = (members: Record<string, unknown>[]): CommunityRatingSourceData => ({ community: { id: "c", name: "Community", members }, feedPosts: [], games: [], tournaments: [], visits: [], ratingEvents: [], ratingStates: [] });
test("calendar month boundary is Moscow midnight, including December rollover", () => {
  assert.equal(communityMonthWindow(Date.parse("2026-09-30T20:59:59Z")).month, "2026-09");
  const october = communityMonthWindow(Date.parse("2026-09-30T21:00:00Z"));
  assert.equal(october.month, "2026-10"); assert.equal(october.from, "2026-09-30T21:00:00.000Z"); assert.equal(october.until, "2026-10-31T21:00:00.000Z");
  assert.equal(communityMonthWindow(Date.parse("2026-12-31T21:00:00Z")).month, "2027-01");
  assert.equal(eventInstant("2026-10-05T14:00:00"), now); assert.equal(eventInstant("2026-02-30"), null);
});
test("calendar top20 retains zero members and hydrates canonical levels without exposing identities", () => {
  const input = source(Array.from({ length: 26 }, (_, i) => ({ id: "player-" + i, name: "Игрок " + i, levelScore: 2 })));
  input.ratingStates = [{ clientId: "player-0", currentRating: 4.1, currentLevel: 4.1 }];
  const report = buildCommunityMonthlyReport(input, now);
  assert.equal(report.totalMembers, 26); assert.equal(report.items.length, 20); assert.equal(report.items[19].rank, 20);
  assert.ok(report.items.every(row => row.overallScore === 0));
  assert.doesNotMatch(JSON.stringify(report.items), /playerKey|playerPhone|playerId/);
  const phone = buildCommunityMonthlyReport(source([{ phone: syntheticPhone }, { id: "79991111111", name: "" }]), now);
  assert.doesNotMatch(JSON.stringify(phone), /79990000000|79991111111/);
});
test("scheduled month controls a late close and full population normalization precedes top20", () => {
  const input = source(Array.from({ length: 24 }, (_, i) => ({ id: "p" + i, name: "Игрок " + i })));
  const t = { tournamentId: "oct", params: { finished: true, finishedAt: "2026-10-05T10:00:00Z" }, participants: input.community.members, standings: Array.from({ length: 24 }, (_, i) => ({ id: "p" + i, place: i + 1, wins: 24 - i, pointsFor: 100 - i, pointsAgainst: i, pointDiff: 100 - 2 * i })) };
  input.tournaments = [t, { ...t, tournamentId: "sep" }, { ...t, tournamentId: "future" }];
  input.feedPosts = [post("oct", "2026-10-01T20:00:00+03:00"), post("oct", "2026-10-01T20:00:00+03:00"), post("sep", "2026-09-30T20:00:00+03:00"), post("future", "2026-10-06T20:00:00+03:00")];
  const report = buildCommunityMonthlyReport(input, now);
  assert.equal(report.tournamentsCount, 1); assert.equal(report.items.length, 20); assert.equal(report.activeMembers, 24);
  assert.equal(report.items[0].overallScore, 62.4); assert.equal(report.items[0].tournamentsPlayed, 1);
});
test("screenshot row uses personal level delta and max2 decimal display", () => {
  const row = publicRankingRow({ rank: 1, playerName: "Иван Петров", overallScore: 69.6004, lastRatingDelta: -0.1, playerPhone: syntheticPhone, tournamentsPlayed: 3 });
  assert.equal(row.initials, "ИП"); assert.equal(row.levelDirection, "down"); assert.equal(row.scoreDisplay, "69,6"); assert.equal(row.overallScore, 69.6);
});
test("event links use exact published IDs, and private/draft/cancelled/past events are excluded", () => {
  assert.equal(publicPublishedEvent(post("a/b"), now)?.signupUrl, "https://padlhub.ru/tournaments?tournamentId=a%2Fb");
  assert.equal(publicPublishedEvent({ ...post("t"), archived: true }, now), null);
  assert.equal(publicPublishedEvent({ ...post("t"), status: "DRAFT" }, now), null);
  assert.equal(publicPublishedEvent({ ...post("t"), details: { publicTournament: { startsAt: "2026-10-06T20:00:00+03:00", visibility: "PRIVATE" } } }, now), null);
  assert.equal(publicPublishedEvent(post("t"), now, "upcoming", { status: "cancelled" }), null);
  assert.equal(publicPublishedEvent(post("past", "2026-09-30T20:00:00+03:00"), now), null);
  assert.equal(publicPublishedEvent(post("past", "2026-09-30T20:00:00+03:00"), now, "all")?.signupUrl, null);
  assert.equal(publicPublishedEvent({ ...post("event"), kind: "EVENT", exerciseId: "event", details: { startsAt: "2026-10-06T20:00:00+03:00", signupUrl: "javascript:alert(1)", participants: [{ phone: syntheticPhone }] } }, now)?.signupUrl, null);
});
test("candidate is additive/idempotent; private access with spoofed identity never queries snapshots", () => {
  const built = buildCommunityMonthlyFlow(flow());
  const again = buildCommunityMonthlyFlow(built.candidate);
  assert.deepEqual(again.candidate, built.candidate);
  const fn = built.nodes.find(node => node.name === "Verify public community")!;
  const result = new Function("msg", fn.func)({ payload: [{ id: "c", visibility: "CLOSED", members: [{ id: "spoof" }] }], req: { query: { clientId: "spoof", phone: syntheticPhone } }, _communityMonthly: { communityId: "c", route: "monthly", nowTs: now } });
  assert.equal(result[0], null); assert.equal(result[1], null); assert.equal(result[2].statusCode, 403);
  const response = built.nodes.find(node => node.name === "Monthly top20 response")!;
  const missing = new Function("msg", response.func)({ payload: [], _communityMonthly: { communityId: "c", month: "2026-10", nowTs: now } });
  assert.equal(missing.statusCode, 503);
});

test("direct confirmed visits outside calendar month cannot affect activity", () => {
  const input = source([{ id: "p1", name: "Иван" }]);
  input.visits = [{ id: "sept", communityId: "c", client: { id: "p1", name: "Иван" }, visitConfirmed: true, visitedAt: "2026-09-15T10:00:00Z" }, { id: "oct", communityId: "c", client: { id: "p1", name: "Иван" }, visitConfirmed: true, visitedAt: "2026-10-04T10:00:00Z" }];
  const report = buildCommunityMonthlyReport(input, now);
  assert.equal(report.items[0].overallScore, 0.4);
});
test("nested cancelled source is excluded and raw Mongo ID falls back to canonical signup ID", () => {
  assert.equal(publicPublishedEvent(post("t"), now, "upcoming", { params: { status: "cancelled" } }), null);
  const legacy = { ...post("aaaaaaaaaaaaaaaaaaaaaaaa"), details: { publicTournament: { exerciseId: "stable", startsAt: "2026-10-06T17:00:00+03:00" } } };
  assert.equal(publicPublishedEvent(legacy, now)?.signupUrl, "https://padlhub.ru/tournaments?tournamentId=stable");
});


test("game booking schedule selects calendar month and gives correct signup time", () => {
  const members = [1, 2, 3, 4].map(i => ({ id: "p" + i, name: "Игрок " + i }));
  const game = { id: "oct-game", participants: members, booking: { date: "2026-10-04", timeFrom: "14:00", timeTo: "16:00", timeFromIso: "2026-10-04T11:00:00Z", timeToIso: "2026-10-04T13:00:00Z" }, metadata: { teamSlots: ["p1", "p2", "p3", "p4"], matchResult: { status: "CONFIRMED", sets: [{ left: 6, right: 4 }] } } };
  const input = source(members); input.games = [game];
  const gamePost = { id: "post-game", communityId: "c", kind: "GAME", relatedGameId: game.id, publishedAt: "2026-09-29T10:00:00Z" };
  input.feedPosts = [gamePost];
  const expected = buildCommunityMonthlyReport(input, now);
  assert.equal(expected.activeMembers, 4); assert.ok(expected.items[0].overallScore > 0);
  input.games.push({ ...game, id: "sept-game", booking: { ...game.booking, date: "2026-09-30", timeFromIso: "2026-09-30T11:00:00Z", timeToIso: "2026-09-30T13:00:00Z" } });
  input.feedPosts.push({ ...gamePost, id: "sept-post", relatedGameId: "sept-game" });
  assert.deepEqual(buildCommunityMonthlyReport(input, now).items, expected.items);
  const future = { ...game, booking: { date: "2026-10-06", timeFrom: "14:00", timeTo: "16:00" } };
  const item = publicPublishedEvent(gamePost, now, "upcoming", future);
  assert.equal(item?.startsAt, "2026-10-06T11:00:00.000Z"); assert.equal(item?.endsAt, "2026-10-06T13:00:00.000Z");
  assert.equal(item?.signupUrl, "https://padlhub.ru/game_join?gameId=oct-game");
});

function projectedSource(source: Record<string, unknown>, projection: Record<string, number>) {
  const projected: Record<string, unknown> = {};
  for (const [field, included] of Object.entries(projection)) {
    if (!included) continue;
    const path = field.split("."); let cursor: unknown = source;
    for (const key of path) cursor = cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[key] : undefined;
    if (cursor === undefined) continue;
    let target = projected;
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown> || (target[key] = {}) as Record<string, unknown>;
    target[path[path.length - 1]] = cursor;
  }
  return projected;
}
test("source Mongo projections retain every privacy/registration check before public mapping", () => {
  const built = buildCommunityMonthlyFlow(flow());
  for (const [kind, name] of [["TOURNAMENT", "Resolve published tournament sources"], ["GAME", "Resolve published game sources"]]) {
    const query = built.nodes.find(node => node.name === name)!;
    const msg = new Function("msg", query.func)({ payload: [], _communityMonthly: { posts: [] } });
    const projection = msg.payload[1].projection;
    const publication = kind === "GAME" ? { ...post("g"), kind, relatedGameId: "g" } : post("t");
    for (const invalid of [{ isPrivate: true }, { published: false }, { isPublished: false }, { summary: { archived: true } }, { params: { status: "in_progress", state: "cancelled" } }]) {
      assert.equal(publicPublishedEvent(publication, now, "upcoming", projectedSource(invalid, projection)), null);
    }
    for (const forbidden of [{ bookingAllowed: false }, { summary: { registrationClosed: true } }, { params: { bookingAllowed: false } }]) {
      assert.equal(publicPublishedEvent(publication, now, "upcoming", projectedSource(forbidden, projection))?.canRegister, false);
    }
  }
});
test("duplicate community ID fails closed and incompatible prepared report cannot be served", () => {
  const built = buildCommunityMonthlyFlow(flow());
  const community = built.nodes.find(node => node.name === "Verify public community")!;
  const msg = new Function("msg", community.func)({ payload: [{ id: "c", visibility: "OPEN" }, { id: "c", visibility: "OPEN" }], _communityMonthly: { communityId: "c", route: "monthly", nowTs: now } });
  assert.equal(msg[2].statusCode, 409);
  const report = buildCommunityMonthlyReport(source([]), now);
  const response = built.nodes.find(node => node.name === "Monthly top20 response")!;
  const call = (doc: unknown) => new Function("msg", response.func)({ payload: [doc], _communityMonthly: { communityId: "c", month: "2026-10", nowTs: now } });
  assert.equal(call(report).statusCode, 200);
  assert.equal(call({ ...report, calculationVersion: "obsolete" }).statusCode, 503);
  assert.equal(call({ ...report, updatedAt: "2026-10-04T11:00:00Z" }).payload.stale, true);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { communityMonthWindow, eventInstant, publicCommunityHeader, publicMediaUrl, publicPublishedEvent, publicRankingRow } from "../../src/services/community-rating/monthlyContract.ts";
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
  const projectPath = (value: unknown, path: string[]): unknown => {
    if (!path.length) return value;
    if (Array.isArray(value)) return value.map(item => projectPath(item, path));
    if (!value || typeof value !== "object") return undefined;
    const nested = projectPath((value as Record<string, unknown>)[path[0]], path.slice(1));
    return nested === undefined ? undefined : { [path[0]]: nested };
  };
  const merge = (target: Record<string, unknown>, patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (Array.isArray(value)) {
        const current = Array.isArray(target[key]) ? target[key] as Record<string, unknown>[] : [];
        target[key] = value.map((item, index) => item === undefined ? current[index] || {} : item && typeof item === "object" ? merge(current[index] || {}, item as Record<string, unknown>) : item);
      } else if (value && typeof value === "object") target[key] = merge((target[key] || {}) as Record<string, unknown>, value as Record<string, unknown>);
      else target[key] = value;
    }
    return target;
  };
  const projected: Record<string, unknown> = {};
  for (const [field, included] of Object.entries(projection)) {
    if (!included) continue;
    const patch = projectPath(source, field.split("."));
    if (patch) merge(projected, patch as Record<string, unknown>);
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

test("monthly worker and HTTP mapper retain avatars, live header and sorted top20", () => {
  const input = source(Array.from({ length: 26 }, (_, i) => ({ id: "p" + i, name: "Участник " + i, avatar: "https://media.example.test/avatar.webp" })));
  input.community.logoUrl = "/lk/media/community-logo/example";
  const report = buildCommunityMonthlyReport(input, now);
  assert.equal(report.communityLogoUrl, "https://padlhub.su/lk/media/community-logo/example");
  assert.ok(report.items.every(row => row.avatarUrl === "https://media.example.test/avatar.webp"));
  const built = buildCommunityMonthlyFlow(flow());
  const run = (name: string, msg: unknown) => new Function("msg", built.nodes.find(node => node.name === name)!.func)(msg);
  const prepared = run("Prepare monthly", { req: { params: { communityId: "c" } } })[0];
  prepared._communityMonthly.nowTs = now;
  const freshCommunity = { id: "c", visibility: "OPEN", name: "Новое имя", logoUrl: "/lk/media/community-logo/new", members: [{ phone: syntheticPhone }] };
  prepared.payload = [projectedSource(freshCommunity, prepared.payload[1].projection)];
  const verified = run("Verify public community", prepared)[0];
  verified.payload = [{ ...report, items: report.items.toReversed() }];
  const result = run("Monthly top20 response", verified);
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.communityName, "Новое имя");
  assert.equal(result.payload.communityLogoUrl, "https://padlhub.su/lk/media/community-logo/new");
  assert.deepEqual(result.payload.items.map((row: { rank: number }) => row.rank), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.doesNotMatch(JSON.stringify(result.payload), /playerKey|playerId|playerPhone|79990000000/);
  assert.equal(buildCommunityMonthlyReport(source([]), now).items.length, 0);
});

test("public media and names reject executable URLs, credentials and identity fallbacks", () => {
  for (const url of ["javascript:alert(1)", "data:image/svg+xml,unsafe", "file:///tmp/private", "https://user:password" + "@" + "media.example.test/p.webp", "https://media.example.test/p.webp?access_token=private", "//evil.example.test/p.webp", "/\\evil.example.test/p.webp"]) assert.equal(publicMediaUrl(url), null);
  assert.equal(publicMediaUrl("https://media.example.test/p.webp?width=128"), "https://media.example.test/p.webp?width=128");
  assert.equal(publicRankingRow({ playerName: syntheticPhone, avatarUrl: "javascript:alert(1)" }).playerName, "Игрок");
  assert.equal(publicRankingRow({ playerName: "internal", playerId: "internal" }).playerName, "Игрок");
  assert.equal(publicCommunityHeader({ id: "c", logo: "data:image/png;base64,legacy" }).communityLogoUrl, "https://padlhub.su/lk/media/community-logo-legacy/c");
  assert.equal(publicCommunityHeader({ name: "Клуб" }).communityLogoUrl, null);
});

test("bundled Node-RED functions retain media inside a VM without Node URL globals", () => {
  const built = buildCommunityMonthlyFlow(flow());
  const fn = built.nodes.find(node => node.name === "Verify public community")!;
  const result = vm.runInNewContext("(function(msg) {" + fn.func + "})(msg)", {
    msg: { payload: [{ id: "c", name: "Клуб", visibility: "OPEN", logoUrl: "/lk/media/community-logo/c" }], _communityMonthly: { communityId: "c", route: "events", nowTs: now } },
  });
  assert.equal(result[1]._communityMonthly.communityLogoUrl, "https://padlhub.su/lk/media/community-logo/c");
  const response = built.nodes.find(node => node.name === "Monthly top20 response")!;
  const doc = buildCommunityMonthlyReport(source([{ id: "p", name: "Участник", avatar: "https://media.example.test/p.webp" }]), now);
  const monthly = vm.runInNewContext("(function(msg) {" + response.func + "})(msg)", { msg: { payload: [doc], _communityMonthly: { communityId: "c", month: "2026-10", nowTs: now } } });
  assert.equal(monthly.payload.items[0].avatarUrl, "https://media.example.test/p.webp");
});

test("projected canonical game supplies card data and only four safe confirmed player previews", () => {
  const built = buildCommunityMonthlyFlow(flow());
  const query = built.nodes.find(node => node.name === "Resolve published game sources")!;
  const publication = { ...post("g"), kind: "GAME", relatedGameId: "g", title: "Старое имя", details: { publicGame: { spotsTaken: 4, levelFrom: 1, startsAt: "2026-10-06T11:00:00Z" } } };
  const raw = {
    id: "g", metadata: { gameTitle: "Вечерняя игра", gameFormat: "doubles", privateNote: "private" },
    booking: { date: "2026-10-06", timeFrom: "20:00", timeTo: "22:00", studioId: "station", studioName: "Станция", studioAddress: "Адрес станции", paymentRef: "private" },
    settings: { minRating: "D+", maxRating: "C+", isPrivate: false }, invite: { maxPlayers: 8, inviteCode: "private" },
    participants: [
      { id: "p0", name: "Участник 0", photo: "https://media.example.test/p.webp", phone: syntheticPhone },
      { id: "p0", name: "Дубликат" },
      ...Array.from({ length: 4 }, (_, i) => ({ id: "p" + (i + 1), name: "Участник " + (i + 1) })),
      { id: "phone-player", name: syntheticPhone },
      ...["WAITLIST", "PENDING", "CANCELLED"].map(status => ({ id: status, name: "Скрытый", status })),
    ],
    photo: "https://media.example.test/game.webp", payment: { url: "private" },
  };
  const msg = new Function("msg", query.func)({ payload: [publication], _communityMonthly: {} });
  const canonical = projectedSource(raw, msg.payload[1].projection);
  assert.doesNotMatch(JSON.stringify(canonical), /privateNote|paymentRef|inviteCode|private/);
  const item = publicPublishedEvent(publication, now, "upcoming", canonical)!;
  assert.equal(item.kind, "GAME"); assert.equal(item.cardKind, "game");
  assert.equal(item.title, "Вечерняя игра"); assert.equal(item.photo, raw.photo);
  assert.equal(item.startsAt, "2026-10-06T17:00:00.000Z"); assert.equal(item.endsAt, "2026-10-06T19:00:00.000Z");
  assert.equal(item.date, "2026-10-06"); assert.equal(item.dateLabel, "6 октября"); assert.equal(item.timeDisplay, "20:00–22:00");
  assert.equal(item.stationId, "station"); assert.equal(item.stationName, "Станция"); assert.equal(item.address, "Адрес станции");
  assert.equal(item.levelFrom, "D+"); assert.equal(item.levelTo, "C+");
  assert.equal(item.spotsTaken, 6); assert.equal(item.spotsTotal, 8); assert.equal(item.players.length, 4);
  assert.deepEqual(item.players[0], { playerName: "Участник 0", avatarUrl: "https://media.example.test/p.webp" });
  assert.doesNotMatch(JSON.stringify(item), /phone-player|79990000000|Дубликат|Скрытый|payment|memberKey|clientId/);
  const hidden = projectedSource({ ...raw, settings: { isPrivate: true } }, msg.payload[1].projection);
  assert.equal(publicPublishedEvent(publication, now, "upcoming", hidden), null);
  assert.equal(publicPublishedEvent({ ...publication, details: { game: { settings: { isPrivate: true } } } }, now), null);
  const empty = publicPublishedEvent(publication, now, "upcoming", { ...canonical, participants: [], organizer: { name: "Наблюдатель" } })!;
  assert.equal(empty.spotsTaken, 0); assert.deepEqual(empty.players, []);
});

test("tournament fields use current source counters and ranges; absent card data remains null", () => {
  const built = buildCommunityMonthlyFlow(flow());
  const query = built.nodes.find(node => node.name === "Resolve published tournament sources")!;
  const raw = { tournamentId: "t", params: { name: "Кубок", participantsCount: 0, maxParticipants: 16, accessLevels: ["4.0", "3.0", "3.5"], direction: { id: "5278" }, studio: { id: "station", name: "Станция", address: "Адрес" }, skin: { imageUrl: "https://media.example.test/cup.webp" } } };
  const msg = new Function("msg", query.func)({ payload: [], _communityMonthly: { posts: [post("t")] } });
  const publication = { ...post("t"), details: { publicTournament: { startsAt: "2026-10-06T17:00:00+03:00", stationId: "old", stationName: "Старое место", participantsCount: 9, levelFrom: 1, levelTo: 2, accessLevels: ["1.0", "5.0"] } } };
  const item = publicPublishedEvent(publication, now, "upcoming", projectedSource(raw, msg.payload[1].projection))!;
  assert.equal(item.kind, "TOURNAMENT"); assert.equal(item.cardKind, "friends"); assert.equal(item.title, "Кубок");
  assert.equal(item.spotsTaken, 0); assert.equal(item.spotsTotal, 16);
  assert.equal(item.levelFrom, 3); assert.equal(item.levelTo, 4);
  assert.equal(item.stationId, "station"); assert.equal(item.stationName, "Станция"); assert.equal(item.address, "Адрес");
  assert.equal(item.photo, "https://media.example.test/cup.webp"); assert.deepEqual(item.players, []);
  const unrestricted = publicPublishedEvent(publication, now, "upcoming", { params: { accessLevels: [] } })!;
  assert.equal(unrestricted.levelFrom, null); assert.equal(unrestricted.levelTo, null);
  const unknown = publicPublishedEvent(post("unknown"), now)!;
  for (const key of ["photo", "address", "stationName", "levelFrom", "levelTo", "spotsTaken", "spotsTotal"] as const) assert.equal(unknown[key], null);
});

test("friends classification, overnight Moscow time and roster redaction are independent of host timezone", () => {
  const publication = { ...post("g"), kind: "GAME", relatedGameId: "g", title: "", details: { spotsTotal: 4 } };
  const item = publicPublishedEvent(publication, now, "upcoming", { booking: { date: "2026-10-06", timeFrom: "23:30", timeTo: "01:30", directionId: 5278 }, participants: [{ id: "internal", name: "internal", photo: "javascript:alert(1)" }, { name: syntheticPhone }], settings: { minRating: 0, maxRating: "3,5" }, metadata: { gameFormat: "singles" } })!;
  assert.equal(item.kind, "GAME"); assert.equal(item.cardKind, "friends"); assert.equal(item.title, "23:30–01:30");
  assert.equal(item.date, "2026-10-06"); assert.equal(item.endsDate, "2026-10-07");
  assert.equal(item.endsAt, "2026-10-06T22:30:00.000Z"); assert.equal(item.timeDisplay, "23:30–01:30");
  assert.equal(item.spotsTaken, 2); assert.equal(item.spotsTotal, 2); assert.equal(item.levelFrom, 0); assert.equal(item.levelTo, 3.5);
  assert.deepEqual(item.players, [{ playerName: "Игрок", avatarUrl: null }, { playerName: "Игрок", avatarUrl: null }]);
});

test("events HTTP response includes fresh community header and keeps existing pagination", () => {
  const built = buildCommunityMonthlyFlow(flow());
  const run = (name: string, msg: unknown) => new Function("msg", built.nodes.find(node => node.name === name)!.func)(msg);
  const prepared = run("Prepare events", { req: { params: { communityId: "c" }, query: { scope: "all" } } })[0];
  prepared._communityMonthly.nowTs = now;
  prepared.payload = [{ id: "c", visibility: "OPEN", name: "Клуб", logoUrl: "/lk/media/community-logo/c" }];
  const verified = run("Verify public community", prepared)[1];
  verified.payload = [post("t")];
  const games = run("Resolve published game sources", verified);
  games.payload = [];
  const tournaments = run("Resolve published tournament sources", games);
  tournaments.payload = [];
  const response = run("Published events and signup links", tournaments).payload;
  assert.equal(response.communityName, "Клуб"); assert.equal(response.communityLogoUrl, "https://padlhub.su/lk/media/community-logo/c");
  assert.equal(response.items[0].cardKind, "tournament"); assert.equal(response.items[0].timeFrom, "17:00");
  assert.equal(response.scope, "all"); assert.equal(response.hasMore, false); assert.equal(response.nextCursor, null);
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

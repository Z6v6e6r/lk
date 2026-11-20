import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { MongoClient } from "mongodb";
import { club, createClubApi, database } from "../../deploy/novokuznetsk/api.mjs";
import { ClubError, createVivaClient, validateBookingSlot } from "../../deploy/novokuznetsk/viva-booking.mjs";

const court = club.courts[0];
const date = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const input = { studioId: club.stationId, roomId: court.id, timeFrom: date + "T15:00:00+07:00",
  timeTo: date + "T16:00:00+07:00", publishGame: true, ratingGame: true, title: "Матч тестового стенда" };

test("only verified club courts and UTC+7 time can reach the booking adapter", () => {
  assert.equal(validateBookingSlot(club, input).serviceId, court.subServiceId);
  for (const invalid of [
    { studioId: randomUUID() }, { roomId: randomUUID() }, { timeFrom: input.timeFrom.replace("+07:00", "+03:00") },
    { timeTo: input.timeTo.replace("16:00", "15:10") },
  ]) assert.throws(() => validateBookingSlot(club, { ...input, ...invalid }), { code: "INVALID_SLOT" });
});

test("Viva booking writes ON_PLACE only and readback rejects explicit other owner, charges and wrong venue", async () => {
  const actor = randomUUID(), correlationId = randomUUID(), bookingId = randomUUID(), exerciseId = randomUUID();
  const slot = validateBookingSlot(club, input);
  const intercepted = [];
  let variant = {};
  const viva = createVivaClient(club, { fetcher: async (url, request) => {
    assert.equal(url.origin, "https://api.vivacrm.ru");
    assert.match(url.pathname, /^\/end-user\/api\/v[12]\/fJzpsf\//);
    assert.equal(request.headers.authorization, "Bearer synthetic");
    assert.equal(request.redirect, "error");
    intercepted.push([url.pathname, request.method]);
    let payload;
    if (url.pathname.endsWith("/meta")) payload = { id: club.masterServiceId, onlinePaymentEnabled: false };
    if (url.pathname.endsWith("/booking")) {
      const body = JSON.parse(request.body);
      assert.equal(body.paymentType, "ON_PLACE");
      assert.equal(body.roomId, court.id);
      assert.deepEqual(body.subServiceIds, [court.subServiceId]);
      payload = { correlationId, exerciseIds: [exerciseId] };
    }
    if (url.pathname.endsWith(correlationId)) payload = { status: "COMPLETED", result: { bookingIds: [bookingId] } };
    if (url.pathname.endsWith("/bookings")) payload = { content: [{
      id: bookingId, exercise: { id: exerciseId, studioId: club.stationId, roomId: court.id, timeFrom: input.timeFrom, timeTo: input.timeTo },
      paymentType: "ON_PLACE", ...variant,
    }] };
    assert.ok(payload);
    return Response.json(payload);
  } });
  await viva.verifyOnSitePolicy("Bearer synthetic");
  const op = await viva.startBooking("Bearer synthetic", slot);
  assert.equal((await viva.readBooking("Bearer synthetic", actor, slot, op)).bookingId, bookingId);
  for (variant of [
    { clientId: actor, userId: randomUUID() }, { transactionStatus: { state: "UNPAID" } },
    { exercise: { id: exerciseId, studioId: randomUUID(), roomId: court.id, timeFrom: input.timeFrom, timeTo: input.timeTo } },
  ]) assert.equal(await viva.readBooking("Bearer synthetic", actor, slot, op), null);
  assert.equal(intercepted.filter(([, method]) => method === "POST").length, 1);
});

test("isolated club API persists bookings, games, community and confirmed levels without cross-account writes",
  { skip: !process.env.NVK_TEST_MONGO_URI && "Requires a disposable loopback MongoDB replica set" },
  async () => {
    const uri = process.env.NVK_TEST_MONGO_URI;
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d{4,5}\/$/);
    const client = new MongoClient(uri, { directConnection: true });
    const db = client.db(database);
    assert.deepEqual(await db.listCollections({}, { nameOnly: true }).toArray(), []);
    for (const name of ["lk_games", "lk_communities", "lk_player_levels", "lk_game_rating_events"]) await db.createCollection(name);
    const actors = Array.from({ length: 5 }, (_, i) => ({ id: randomUUID(), name: "Fixture " + i, bearer: "Bearer fixture-" + i }));
    const bookingId = randomUUID();
    const exerciseId = randomUUID();
    let bookingPosts = 0;
    const server = createClubApi({ client, consentVersion: "fixture", bookEnabled: true, viva: {
      async profile(bearer) {
        const actor = actors.find(row => row.bearer === bearer);
        if (!actor) throw new ClubError(401, "AUTH_REQUIRED", "Требуется вход.");
        return actor;
      },
      async verifyOnSitePolicy() {},
      async startBooking() { bookingPosts++; return { correlationId: randomUUID(), exerciseIds: [exerciseId] }; },
      async readBooking() { return { bookingId, exerciseId, room: court.id, station: club.stationId }; },
    } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}/novokuznetsk`;
    async function call(path, actor, body, origin = club.siteOrigin) {
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
        headers: { Origin: origin, ...(actor ? { Authorization: actor.bearer } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    }
    try {
      const [owner, player2, player3, player4, outsider] = actors;
      assert.equal((await call("/lk/onboarding/level", owner)).data.level, null);
      assert.equal((await call("/lk/onboarding/level", owner, { clientId: player2.id, levelNumeric: 1 })).status, 422);
      assert.equal((await call("/lk/onboarding/level", owner, undefined, "https://padlhub.ru")).status, 403);
      for (const actor of actors.slice(0, 4)) {
        assert.equal((await call("/lk/onboarding/level", actor, { clientId: actor.id, levelNumeric: "3,10000" })).status, 200);
      }
      assert.equal((await call("/lk/onboarding/level", owner, { clientId: owner.id, levelNumeric: 7 })).data.level, 3.1);
      const documents = [["public-offer", "/oferta"], ["personal-data-policy", "/politcs"]]
        .map(([id, path]) => ({ id, url: club.siteOrigin + path, version: "fixture", accepted: true }));
      assert.equal((await call("/lk/analytics/auth-consents", owner, { schemaVersion: 1, documentSetVersion: "fixture",
        documents, authMethod: "sms", acceptedAtClient: new Date().toISOString() })).status, 200);
      assert.equal((await call("/lk/venue-bookings", null, input)).status, 401);
      assert.equal((await call("/lk/venue-bookings", owner, { ...input, studioId: randomUUID() })).status, 422);
      const race = await Promise.all([call("/lk/venue-bookings", owner, input), call("/lk/venue-bookings", owner, input)]);
      const confirmed = race.find(result => result.status === 200);
      assert.ok(confirmed);
      const { game } = confirmed.data;
      assert.equal(game.payment.paid, false);
      assert.equal(game.payment.paymentMethod, "ON_PLACE");
      assert.equal((await call("/lk/venue-bookings", owner, input)).data.game.id, game.id);
      assert.equal(bookingPosts, 1);
      const publicList = (await call("/lk/games?public=true")).data;
      assert.equal(publicList.games[0].id, game.id);
      assert.equal(publicList.games[0].booking.bookingIds, undefined);
      for (const actor of [player2, player3, player4]) assert.equal((await call(`/lk/games/${game.id}/join`, actor, {})).status, 200);
      assert.equal((await call(`/lk/games/${game.id}/join`, outsider, {})).status, 409);
      assert.equal((await call(`/lk/games/${game.id}/result/submit`, owner, {})).status, 409);
      await db.collection("lk_games").updateOne({ id: game.id }, { $set: {
        "booking.timeFromIso": "2020-01-01T15:00:00+07:00", "booking.timeToIso": "2020-01-01T16:00:00+07:00",
      } });
      const submit = { idempotencyKey: "fixture-score-1", sets: [{ left: 6, right: 2 }],
        setPairings: [{ setIndex: 0, teamSlots: actors.slice(0, 4).map(actor => ({ memberKey: "id:" + actor.id })) }] };
      assert.equal((await call(`/lk/games/${game.id}/result/submit`, outsider, submit)).status, 404);
      const pending = await call(`/lk/games/${game.id}/result/submit`, owner, submit);
      assert.equal(pending.status, 200);
      assert.equal((await call(`/lk/games/${game.id}/result/submit`, owner, submit)).data.result.id, pending.data.result.id);
      assert.equal((await call(`/lk/games/${game.id}/result/confirm`, player2, {})).status, 409);
      const ratings = await Promise.all([call(`/lk/games/${game.id}/result/confirm`, player3, {}),
        call(`/lk/games/${game.id}/result/confirm`, player3, {})]);
      assert.ok(ratings.every(result => result.status === 200));
      assert.equal(await db.collection("lk_game_rating_events").countDocuments({ gameId: game.id }), 4);
      assert.ok((await call("/lk/onboarding/level", owner)).data.level > 3.1);
      assert.equal((await call("/lk/onboarding/level", outsider)).data.level, null);
      const create = { name: "Fixture club", description: "Тестовое описание", visibility: "CLOSED", creator: outsider };
      const community = (await call("/lk/communities", owner, create)).data.community;
      assert.equal(community.ownerId, owner.id);
      assert.equal((await call("/lk/communities", owner, create)).data.community.id, community.id);
      assert.equal((await call("/lk/communities", outsider)).data.communities.length, 0);
      assert.equal((await call(`/lk/communities/${community.id}`, outsider)).status, 404);
      const join = { inviteCode: community.inviteCode };
      assert.ok((await Promise.all([call("/lk/communities/join-by-invite", outsider, join),
        call("/lk/communities/join-by-invite", outsider, join)])).every(result => result.status === 200));
      assert.equal((await call(`/lk/communities/${community.id}`, owner)).data.community.memberCount, 2);
      assert.equal(await db.collection("lk_communities").countDocuments({}), 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await client.close();
    }
  });

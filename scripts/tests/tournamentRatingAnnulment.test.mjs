import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";
import {
  getTournamentRatingExclusion,
  planTournamentRatingAnnulment,
} from "../../src/services/player-rating/tournamentExclusions.ts";
import {
  buildTournamentRatingEvent,
  buildTournamentCompensationEvent,
  replayPlayerRatingEvents,
} from "../../src/services/player-rating/ledger.ts";
import { extractCommunityRatingFacts } from "../../src/services/community-rating/facts.ts";
import { processTournamentLedger } from "../rating_worker.mjs";

const finishedAt = "2026-10-01T17:32:55.219Z";
const recordedAt = "2026-10-26T14:30:00.000Z";
const exclusion = {
  playerId: "p1", scopes: ["community", "level"],
  auditId: "annulment-fixture-1", reason: "PLAYER_DID_NOT_PLAY", recordedAt,
};
const standings = [
  { id: "p1", name: "Player 1", rank: 1, pointsFor: 98, pointsAgainst: 63, wins: 5,
    ratingBefore: 3.118, ratingDelta: 0.08179, ratingAfter: 3.19979 },
  { id: "p2", name: "Player 2", rank: 2, pointsFor: 88, pointsAgainst: 73, wins: 5,
    ratingBefore: 2, ratingDelta: 0.1, ratingAfter: 2.1 },
];
const tournament = {
  tournamentId: "t1", updatedAt: recordedAt,
  params: { status: "completed", finishedAt },
  participants: Array.from({ length: 8 }, (_, i) => ({ id: `p${i + 1}` })),
  standings, ratingExclusions: [exclusion],
};
function baseline(clientId = "p1", rating = 3.11827) {
  return {
    _id: `baseline-${clientId}`, id: `baseline-${clientId}`, idempotencyKey: `baseline-${clientId}`,
    schemaVersion: 1, eventType: "RATING_INITIAL_IMPORTED",
    occurredAt: "2026-09-19T11:00:00.000Z", createdAt: "2026-09-19T11:00:00.000Z",
    player: { key: `client:${clientId}`, clientId, phoneNorm: null, name: clientId },
    actor: {}, source: { domain: "IMPORT" }, change: { before: null, delta: null, after: rating },
    formula: null, projectionIntent: { viva: "NONE" },
  };
}
function fixtureEvents() {
  const first = buildTournamentRatingEvent({ tournamentId: "t1", finishedAt,
    standing: standings[0], canonicalBefore: 3.11827 });
  const reverted = buildTournamentCompensationEvent({ event: first,
    occurredAt: "2026-10-01T18:00:00.000Z", reason: "CORRECTED" });
  const active = buildTournamentRatingEvent({ tournamentId: "t1", finishedAt,
    occurredAt: "2026-10-01T18:00:00.001Z", standing: standings[0],
    canonicalBefore: 3.11827, previousEventId: first.id });
  const other = buildTournamentRatingEvent({ tournamentId: "t1", finishedAt,
    standing: standings[1], canonicalBefore: 2 });
  return [baseline(), first, reverted, active, baseline("p2", 2), other];
}

test("annulment compensates only the active canonical event, once, without rounding to the standing delta", () => {
  const events = fixtureEvents();
  const planned = planTournamentRatingAnnulment({ tournament, clientId: "p1", events });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].change.delta, -0.08152);
  assert.equal(planned[0].eventType, "TOURNAMENT_RATING_ANNULLED");
  assert.equal(planned[0].source.annulmentId, exclusion.auditId);
  assert.equal(planned[0].source.compensatesEventId, events[3].id);
  assert.deepEqual(planned, planTournamentRatingAnnulment({ tournament, clientId: "p1", events }));
  assert.deepEqual(planTournamentRatingAnnulment({ tournament, clientId: "p1", events: [...events, ...planned] }), []);
  const own = (all) => all.filter((e) => e.player.clientId === "p1");
  assert.equal(replayPlayerRatingEvents(own(events)).ratingNumeric, 3.19979);
  assert.equal(replayPlayerRatingEvents(own([...events, ...planned])).ratingNumeric, 3.11827);
  assert.deepEqual(planTournamentRatingAnnulment({ tournament, clientId: "p2", events }), []);
});

test("scope and identity matching are exact; malformed matching metadata blocks instead of silently rating", () => {
  const communityOnly = { ...tournament, ratingExclusions: [{ ...exclusion, scopes: ["community"] }] };
  assert.equal(getTournamentRatingExclusion(communityOnly, "p1", "level"), null);
  assert.ok(getTournamentRatingExclusion(communityOnly, "p1", "community"));
  assert.equal(getTournamentRatingExclusion(tournament, null, "community"), null);
  assert.equal(getTournamentRatingExclusion(tournament, "p2", "community"), null);
  assert.deepEqual(planTournamentRatingAnnulment({ tournament: communityOnly, clientId: "p1", events: fixtureEvents() }), []);
  assert.throws(() => getTournamentRatingExclusion({ ...tournament,
    ratingExclusions: [{ ...exclusion, auditId: "" }] }, "p1", "level"), /INVALID_TOURNAMENT/);
});

test("a later valid rating event is retained in compensation before/after and complete replay", () => {
  const events = fixtureEvents();
  const later = buildTournamentRatingEvent({ tournamentId: "t2", finishedAt: "2026-10-20T12:00:00.000Z",
    standing: { ...standings[0], ratingBefore: 3.19979, ratingDelta: 0.10021, ratingAfter: 3.3 },
    canonicalBefore: 3.19979 });
  events.push(later);
  const [compensation] = planTournamentRatingAnnulment({ tournament, clientId: "p1", events });
  assert.equal(compensation.change.before, 3.3);
  assert.equal(compensation.change.delta, -0.08152);
  assert.equal(compensation.change.after, 3.21848);
  assert.equal(replayPlayerRatingEvents([...events, compensation].filter((e) => e.player.clientId === "p1")).ratingNumeric, 3.21848);
});

test("annulment refuses missing or newer baselines and a ledger beyond the recorded correction", () => {
  const events = fixtureEvents().filter((e) => e.player.clientId === "p1");
  assert.throws(() => planTournamentRatingAnnulment({ tournament, clientId: "p1",
    events: events.filter((e) => e.eventType !== "RATING_INITIAL_IMPORTED") }), /REQUIRES_RATING_BASELINE/);
  assert.throws(() => planTournamentRatingAnnulment({ tournament, clientId: "p1",
    events: [...events, { ...baseline(), id: "later-baseline", occurredAt: "2026-10-02T00:00:00.000Z" }] }), /PRECEDES_RATING_BASELINE/);
  assert.throws(() => planTournamentRatingAnnulment({ tournament, clientId: "p1",
    events: [...events, { ...events[1], id: "future-event", occurredAt: "2026-10-27T00:00:00.000Z" }] }), /PRECEDES_LEDGER_FRONTIER/);
});

test("community exclusion removes only the target event/player while preserving count, rank and metrics of others", () => {
  const input = {
    community: { id: "c1", members: standings.map((s) => ({ id: s.id, name: s.name })) },
    feedPosts: [{ id: "post1", kind: "TOURNAMENT", relatedTournamentId: "t1", createdAt: finishedAt },
      { id: "post2", kind: "TOURNAMENT", relatedTournamentId: "t2", createdAt: finishedAt }],
    tournaments: [{ ...tournament, ratingExclusions: [] }, { ...tournament, tournamentId: "t2", ratingExclusions: [] }],
    collectedAt: recordedAt,
  };
  const before = extractCommunityRatingFacts(input);
  const sourceBefore = structuredClone(tournament);
  const after = extractCommunityRatingFacts({ ...input, tournaments: [tournament, input.tournaments[1]] });
  assert.equal(before.length, 4);
  assert.equal(after.length, 3);
  assert.equal(after.some((f) => f.eventId === "t1" && f.playerId === "p1"), false);
  assert.ok(after.some((f) => f.eventId === "t2" && f.playerId === "p1"));
  assert.deepEqual(after, before.filter((f) => !(f.eventId === "t1" && f.playerId === "p1")));
  assert.equal(after.find((f) => f.eventId === "t1").metrics.participantsCount, 8);
  assert.deepEqual(tournament, sourceBefore);
});

function memoryDb(seed) {
  const rows = structuredClone(seed);
  const path = (row, key) => key.split(".").reduce((v, k) => v?.[k], row);
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (key === "$or") return value.some((q) => matches(row, q));
    const actual = path(row, key);
    if (value && typeof value === "object") {
      if ("$gte" in value) return actual >= value.$gte;
      if ("$ne" in value) return actual !== value.$ne;
    }
    return Array.isArray(actual) ? actual.includes(value) : actual === value;
  });
  const collection = (name) => {
    rows[name] ||= [];
    const updateOne = async (query, update, options = {}) => {
      let row = rows[name].find((r) => matches(r, query));
      if (!row && options.upsert) {
        row = { ...query, ...structuredClone(update.$setOnInsert || {}) };
        rows[name].push(row);
      }
      assert.ok(row, `Unexpected update without target in ${name}`);
      Object.assign(row, structuredClone(update.$set || {}));
      return { matchedCount: 1 };
    };
    return {
      find: (query) => ({ limit() { return this; }, toArray: async () => structuredClone(rows[name].filter((r) => matches(r, query))) }),
      findOne: async (query) => structuredClone(rows[name].find((r) => matches(r, query)) || null),
      updateOne,
      bulkWrite: async (ops) => {
        for (const { updateOne: op } of ops) await updateOne(op.filter, op.update, { upsert: op.upsert });
      },
    };
  };
  return { rows, collection };
}

function workerFixture() {
  const events = fixtureEvents();
  const states = ["p1", "p2"].map((id) => {
    const replay = replayPlayerRatingEvents(events.filter((e) => e.player.clientId === id));
    return { _id: `state-${id}`, playerKey: `client:${id}`, clientId: id, phoneNorm: null, name: id,
      ratingNumeric: replay.ratingNumeric, lastEventId: replay.lastEventId };
  });
  return memoryDb({ tournaments: [tournament], rating_events: events,
    player_rating_state: states, player_ratings: structuredClone(states), lk_communities: [], lk_training_visits: [] });
}
const workerOptions = { sinceIso: "2026-10-01T00:00:00.000Z", notBeforeIso: "2026-07-01T00:00:00.000Z", nowIso: recordedAt };

test("real worker dry-run writes nothing; apply and retries never reapply the excluded finalized result", async () => {
  const db = workerFixture();
  const before = structuredClone(db.rows);
  const dry = await processTournamentLedger(db, { ...workerOptions, dryRun: true });
  assert.equal(dry.annulled, 1);
  assert.equal(dry.statesChanged, 1);
  assert.deepEqual(db.rows.rating_events, before.rating_events);
  assert.deepEqual(db.rows.player_rating_state, before.player_rating_state);
  const applied = await processTournamentLedger(db, { ...workerOptions, dryRun: false });
  assert.equal(applied.eventsPlanned, 1);
  assert.equal(applied.annulled, 1);
  assert.equal(db.rows.player_rating_state.find((s) => s.clientId === "p1").ratingNumeric, 3.11827);
  assert.deepEqual(db.rows.player_rating_state.find((s) => s.clientId === "p2"), before.player_rating_state[1]);
  assert.deepEqual(db.rows.tournaments, before.tournaments);
  assert.equal(db.rows.rating_projection_outbox.length, 1);
  assert.equal(db.rows.rating_projection_outbox[0].clientId, "p1");
  assert.equal(db.rows.rating_projection_outbox[0].payload.levelNumeric, "3.11827");
  const retry = await processTournamentLedger(db, { ...workerOptions, nowIso: "2026-10-26T14:45:00.000Z", dryRun: false });
  assert.equal(retry.eventsPlanned, 0);
  assert.equal(db.rows.rating_projection_outbox.length, 1);
  assert.equal(db.rows.rating_events.length, before.rating_events.length + 1);
});

test("worker recovers a crash after event insert and before state/outbox projection", async () => {
  const db = workerFixture();
  db.rows.rating_events.push(...planTournamentRatingAnnulment({ tournament, clientId: "p1", events: db.rows.rating_events }));
  const recovered = await processTournamentLedger(db, { ...workerOptions, dryRun: false });
  assert.equal(recovered.eventsPlanned, 0);
  assert.equal(recovered.statesChanged, 1);
  assert.equal(db.rows.player_rating_state.find((s) => s.clientId === "p1").ratingNumeric, 3.11827);
  assert.equal(db.rows.rating_projection_outbox.length, 1);
});

test("public tournament save cannot submit rating exclusions", () => {
  const code = fs.readFileSync(new URL("../nodered_games_nodes/fn_tournament_prepare.js", import.meta.url), "utf8");
  const msg = { payload: { tournamentId: "t1", ratingExclusions: [exclusion], participants: standings } };
  const [result] = vm.runInNewContext(`(function(){${code}\n})()`, { msg, node: { warn() {} } });
  assert.ok(result);
  assert.equal(Object.hasOwn(result.payload.$set, "ratingExclusions"), false);
  assert.equal(Object.hasOwn(result.payload.$setOnInsert || {}, "ratingExclusions"), false);
  const saved = { ...structuredClone(tournament), ...result.payload.$set };
  assert.deepEqual(saved.ratingExclusions, tournament.ratingExclusions);
});

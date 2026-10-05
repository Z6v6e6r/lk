import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planCommunityTournamentClose, tournamentWriteFilter, buildTournamentWriteSnapshot, applyCommunityTournamentClose, assertTournamentWritersGuarded } from "../lib/communityMonthlyFinalization.mjs";
import { buildCommunityMonthlyFlow } from "../patch_nodered_community_monthly_flow.mjs";
import { MongoClient } from "mongodb";
import { runCommunityMonthlyJob } from "../community_monthly_worker.mjs";
const nowTs = Date.parse("2026-10-05T11:00:00Z");
function fixture() {
  return { tournamentId: "t1", createdAt: "2026-10-05T06:00:00Z", updatedAt: "2026-10-05T08:00:00Z", tournamentType: "americano", params: { status: "in_progress" }, participants: [1, 2, 3, 4].map(i => ({ id: "p" + i, clientId: "p" + i, name: "Игрок " + i, rating: 3 })), rounds: [{ id: "r1", matches: [{ id: "m1", pair1: ["p1", "p2"], pair2: ["p3", "p4"], score1: 12, score2: 9 }] }], standings: [1, 2, 3, 4].map(i => ({ id: "p" + i, place: i, wins: 1, pointsFor: 12, pointsAgainst: 9 })) };
}
const publications = [{ kind: "TOURNAMENT", relatedTournamentId: "t1", details: { startsAt: "2026-10-05T09:00:00+03:00" } }];
const plan = (tournament, options = {}) => planCommunityTournamentClose({ tournament, publications, nowTs, ...options });
function baseline() {
  return [{ id: "c", type: "tab" }, { id: "t", type: "tab" }, { id: "db", type: "mongodb4-client" }, { id: "rating", type: "http in", z: "c", method: "get", url: "/lk/communities/:communityId/rating", wires: [] }, { id: "find", type: "mongodb4", z: "c", collection: "lk_communities", clientNode: "db", wires: [] }, ...[["2e70b2e547e77c00", "fn_tournament_recalculate.js"], ["4f0f1ce8189a9e8c", "fn_tournament_prepare.js"], ["745f991e11130b08", "fn_tournament_save_ack.js"]].map(([id, file]) => ({ id, type: "function", z: "t", func: fs.readFileSync("scripts/nodered_games_nodes/" + file, "utf8"), wires: [] }))];
}
test("close waits three hours after later scheduled/actual start and preserves scores", () => {
  const tournament = fixture(), result = plan(tournament);
  assert.equal(result.close, true); assert.equal(result.finishedAt, "2026-10-05T09:00:00.000Z");
  assert.equal(plan({ ...tournament, createdAt: "2026-10-05T10:00:00Z" }).reason, "NOT_DUE");
  assert.equal(plan(tournament, { publications: [] }).reason, "MISSING_OR_AMBIGUOUS_SCHEDULE");
  assert.equal(plan(tournament, { publications: [{ details: { startsAt: "2026-10-06T09:00:00+03:00" } }] }).reason, "NOT_DUE");
  assert.equal(plan({ ...tournament, params: { finished: true } }).reason, "ALREADY_FINISHED");
});
test("incomplete/invalid scores, pairs and reopened/newer-level sources are quarantined", () => {
  for (const [score1, reason] of [[null, "INCOMPLETE_SCORES"], ["", "INCOMPLETE_SCORES"], [-1, "INVALID_SCORE"], [Infinity, "INVALID_SCORE"], [0.5, "INVALID_SCORE"], [true, "INVALID_SCORE"], [false, "INVALID_SCORE"], ["   ", "INVALID_SCORE"]]) {
    const t = fixture(); t.rounds[0].matches[0].score1 = score1;
    assert.equal(plan(t).reason, reason);
  }
  const t = fixture(); t.rounds[0].matches[0].pair2 = ["p1", "p2"]; assert.equal(plan(t).reason, "INVALID_PAIRING");
  assert.equal(plan(fixture(), { ratingEvents: [{ id: "original" }] }).reason, "EXISTING_LEDGER_REQUIRES_REVIEW");
  assert.equal(plan(fixture(), { ratingStates: [{ lastEventAt: "2026-10-05T10:00:00Z" }] }).reason, "NEWER_CANONICAL_LEVEL_REQUIRES_REVIEW");
});
test("unreviewed live writers cannot enable unattended apply", () => {
  assert.throws(() => assertTournamentWritersGuarded(baseline()), /WRITE_GUARDS_NOT_INSTALLED/);
  const candidate = buildCommunityMonthlyFlow(baseline()).candidate;
  assert.doesNotThrow(() => assertTournamentWritersGuarded(candidate));
  assert.throws(() => assertTournamentWritersGuarded(candidate.map(node => node.id === "t" ? { ...node, disabled: true } : node)), /WRITE_GUARDS_NOT_INSTALLED/);
});
test("no-op candidates never write; CAS includes every mutated score/lifecycle field", async () => {
  const result = await applyCommunityTournamentClose({ collection() { throw Error("unexpected write"); } }, fixture(), { close: false, reason: "INCOMPLETE_SCORES" });
  assert.equal(result.applied, false);
  const query = tournamentWriteFilter("t1", buildTournamentWriteSnapshot(fixture()));
  assert.ok(query.$and.some(item => Object.hasOwn(item, "rounds"))); assert.ok(query.$and.some(item => Object.hasOwn(item, "params")));
});
const uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
test("real Mongo: stale result write loses after closure; closed create is an atomic no-op; retry is idempotent", { skip: !uri }, async t => {
  const client = new MongoClient(uri); await client.connect();
  const db = client.db("community_monthly_test_" + Date.now());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "community-close-test-"));
  t.after(async () => { await db.dropDatabase(); await client.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const tournament = fixture(); await db.collection("tournaments").insertOne(tournament);
  const built = buildCommunityMonthlyFlow(baseline()).candidate;
  const resultsFn = built.find(node => node.id === "2e70b2e547e77c00").func;
  const staleSource = await db.collection("tournaments").findOne({ tournamentId: "t1" });
  const stale = new Function("msg", resultsFn)({ payload: [staleSource], req: { body: { results: [] } } });
  assert.equal(await db.collection("tournaments").countDocuments(stale.mongoQuery), 1);
  const closed = await applyCommunityTournamentClose(db, tournament, plan(tournament), tmp);
  assert.equal(closed.applied, true);
  assert.equal((await db.collection("tournaments").updateOne(stale.mongoQuery, stale.mongoUpdate)).matchedCount, 0);
  const saved = await db.collection("tournaments").findOne({ tournamentId: "t1" });
  assert.equal(saved.params.finished, true); assert.deepEqual(saved.rounds, tournament.rounds);
  assert.equal(plan(saved).reason, "ALREADY_FINISHED");
  const createFn = built.find(node => node.id === "4f0f1ce8189a9e8c").func;
  const create = new Function("msg", createFn)({ payload: { ...fixture(), participants: [{ id: "evil", name: "$literalName" }] } })[0];
  const written = await db.collection("tournaments").updateOne(create.payload[0], create.payload[1], { upsert: true });
  assert.equal(written.matchedCount, 1); assert.equal(written.modifiedCount, 0);
  const ackFn = built.find(node => node.id === "745f991e11130b08").func;
  const ack = new Function("msg", ackFn)({ payload: written, _tournamentGuardedUpsert: true, _tournamentLegacySuccessPayload: create._tournamentLegacySuccessPayload }); assert.equal(ack.statusCode, 409);
  const freshCreate = new Function("msg", createFn)({ payload: { ...fixture(), tournamentId: "new", participants: [{ id: "p", name: "$literalName" }], createdAt: "2026-10-01T10:00:00Z" } })[0];
  const first = await db.collection("tournaments").updateOne(freshCreate.payload[0], freshCreate.payload[1], { upsert: true }); assert.equal(first.upsertedCount, 1);
  const inserted = await db.collection("tournaments").findOne({ tournamentId: "new" }); assert.equal(inserted.participants[0].name, "$literalName"); assert.equal(inserted.createdAt, "2026-10-01T10:00:00Z");
  // Updating an open tournament keeps its original start and literal participant text.
  const edited = new Function("msg", createFn)({ payload: { ...fixture(), tournamentId: "new", participants: [{ id: "p", name: "$editedName" }], createdAt: "2026-10-05T10:00:00Z" } })[0];
  assert.equal((await db.collection("tournaments").updateOne(edited.payload[0], edited.payload[1], { upsert: true })).modifiedCount, 1);
  const updated = await db.collection("tournaments").findOne({ tournamentId: "new" });
  assert.equal(updated.createdAt, inserted.createdAt); assert.equal(updated.participants[0].name, "$editedName");
  for (const [index, lifecycle] of [{ params: { status: " COMPLETED " } }, { summary: { finished: " TRUE " } }, { params: { manualFinish: 1 } }].entries()) {
    const id = "closed-" + index;
    await db.collection("tournaments").insertOne({ ...fixture(), tournamentId: id, ...lifecycle });
    const retry = new Function("msg", createFn)({ payload: { ...fixture(), tournamentId: id } })[0];
    const ack = await db.collection("tournaments").updateOne(retry.payload[0], retry.payload[1], { upsert: true });
    assert.equal(ack.modifiedCount, 0); assert.equal(await db.collection("tournaments").countDocuments({ tournamentId: id }), 1);
  }

});

test("guarded acknowledgement detects recursive and legacy no-op envelopes", () => {
  const fn = buildCommunityMonthlyFlow(baseline()).candidate.find(node => node.id === "745f991e11130b08").func;
  for (const payload of [{ payload: { acknowledged: true, matchedCount: 1, modifiedCount: 0 } }, { acknowledged: true, n: 1, nModified: 0 }]) {
    const result = new Function("msg", fn)({ payload, _tournamentGuardedUpsert: true, _tournamentLegacySuccessPayload: { ok: true } }); assert.equal(result.statusCode, 409);
  }
  const ordinary = new Function("msg", fn)({ payload: { acknowledged: true, matchedCount: 1, modifiedCount: 0 }, _tournamentLegacySuccessPayload: { ok: true } }); assert.equal(ordinary.statusCode, 200);
});


function readonlyDb(tournaments) {
  const rows = {
    lk_communities: [{ id: "c", name: "Community", visibility: "OPEN", members: fixture().participants }],
    lk_community_feed: publications.map(post => ({ ...post, id: "post1", communityId: "c" })),
    tournaments, lk_games: [], lk_training_visits: [], rating_events: [], player_rating_state: [],
  };
  return { rows, collection(name) {
    return { find() { return { async toArray() { return structuredClone(rows[name] || []); } }; },
      updateOne() { throw Error("dry-run tried to write"); }, replaceOne() { throw Error("dry-run tried to write"); } };
  } };
}
test("worker dry-run projects a complete close into rating without changing any database source", async () => {
  const recalculated = new Function("msg", baseline().find(node => node.id === "2e70b2e547e77c00").func)({ payload: [fixture()], req: { body: { results: [] } } });
  const canonical = { ...fixture(), ...recalculated.mongoUpdate.$set };
  // Legacy unfinished source already has derived round results but no completion status.
  canonical.summary.status = "in_progress";
  const db = readonlyDb([canonical]), before = structuredClone(db.rows);
  const result = await runCommunityMonthlyJob({ db, nowTs, flow: baseline() });
  assert.equal(result.mode, "dry-run"); assert.equal(result.finalized, 0);
  assert.equal(result.reasons.DRY_RUN_CANDIDATE, 1);
  assert.equal(result.reports[0].tournamentsCount, 1);
  assert.deepEqual(db.rows, before);
});
test("worker rejects a shared publication alias matching different canonical tournaments", async () => {
  const db = readonlyDb([{ ...fixture(), id: "shared" }, { ...fixture(), tournamentId: "t2", id: "t1" }]);
  const result = await runCommunityMonthlyJob({ db, nowTs, flow: baseline() });
  assert.equal(result.reasons.AMBIGUOUS_TOURNAMENT_ID, 2);
  assert.equal(result.finalized, 0); assert.equal(result.reports[0].tournamentsCount, 0);
});

test("cancelled/unpublished source lifecycle never closes even with an active publication", () => {
  for (const lifecycle of [{ cancelled: true }, { summary: { status: "cancelled" } }, { params: { status: "in_progress", state: "cancelled" } }, { params: { archived: true } }, { published: false }]) {
    assert.equal(plan({ ...fixture(), ...lifecycle }).reason, "NOT_ACTIVE");
  }
  const query = tournamentWriteFilter("t1", buildTournamentWriteSnapshot(fixture()));
  for (const key of ["cancelled", "archived", "status", "finishedAt"]) assert.ok(query.$and.some(row => Object.hasOwn(row, key)));
});

test("live result guard also captures concurrent root cancellation/lifecycle fields", () => {
  const fn = buildCommunityMonthlyFlow(baseline()).candidate.find(node => node.id === "2e70b2e547e77c00").func;
  const result = new Function("msg", fn)({ payload: [fixture()], req: { body: { results: [] } } });
  for (const field of ["cancelled", "archived", "status", "finishedAt"]) assert.ok(result.mongoQuery.$and.some(row => Object.hasOwn(row, field)));
});

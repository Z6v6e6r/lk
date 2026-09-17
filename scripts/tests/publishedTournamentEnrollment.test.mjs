import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { buildPublishedEnrollmentPlan, resolveEnrollmentPlayers, inspectMembership, runPublishedTournamentEnrollment, restorePublishedEnrollment, ENROLLMENT_COLLECTION } from "../lib/publishedTournamentEnrollment.mjs";
import { loadTimeForFriendsProviderEnrollment } from "../lib/timeForFriendsRuntimeRoster.mjs";

const player = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const tournamentId = "33333333-3333-4333-8333-333333333333";
const nowIso = "2026-09-17T12:00:00.000Z";
const scope = { fromIso: "2026-08-31T21:00:00.000Z", toIso: "2026-09-30T21:00:00.000Z", nowIso };
function fixtures() {
  const tournament = { _id: "t1", tournamentId, params: { finished: true, finishedAt: "2026-09-16T19:00:00.000Z" },
    participants: [{ id: player, name: "$$ROOT" }], standings: [{ id: player, ratingAfter: 2 }] };
  const publication = { _id: "p1", id: "p1", source: "ADMIN_PANEL", status: "PUBLISHED", kind: "TOURNAMENT", communityId: "c1",
    relatedTournamentId: tournamentId, startAt: "2026-09-16T18:00:00.000Z" };
  const community = { _id: "c1", id: "c1", members: [], bannedMembers: [], pendingMembers: [], memberCount: 0 };
  return { tournaments: [tournament], publications: [publication], communities: [community], ...scope };
}
test("all directions and every published community; September uses event date not edit date", () => {
  const f = fixtures();
  f.publications.push({ ...f.publications[0], _id: "p2", id: "p2", communityId: "c2" });
  f.communities.push({ ...f.communities[0], _id: "c2", id: "c2" });
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 2);
  f.publications.forEach((p) => { p.startAt = "2026-08-31T20:59:59Z"; p.updatedAt = nowIso; });
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  f.publications.forEach((p) => { p.startAt = "2026-08-31T21:00:00Z"; });
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 2);
});
test("unpublished, archived, non-admin and conflicting dates cannot enroll", () => {
  for (const update of [{ status: "DRAFT" }, { archived: true }, { source: "USER" }, { details: { startsAt: "2026-09-15T18:00:00Z" } }]) {
    const f = fixtures(); Object.assign(f.publications[0], update);
    assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  }
});
test("missing tournament calendar date never falls back to updatedAt", () => {
  const f = fixtures(); delete f.publications[0].startAt; delete f.tournaments[0].params.finishedAt; f.tournaments[0].updatedAt = nowIso;
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
});
test("ambiguous aliases, bans and conflicting player identities are quarantined", () => {
  let f = fixtures(); f.tournaments.push({ ...f.tournaments[0], _id: "t2" });
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  f = fixtures(); f.communities[0].bannedMembers = [{ id: player }];
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  f = fixtures(); f.tournaments[0].standings[0].clientId = other;
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
});
test("cancelled, waitlisted and unproven active participants never enroll", () => {
  const roster = { maxParticipants: 1, participants: [{ clientId: player, isCancelled: true, spot: 1 }, { clientId: other, isCancelled: false, spot: 2 }] };
  assert.deepEqual(resolveEnrollmentPlayers(null, roster).players, []);
  roster.participants = [{ clientId: player, spot: 1 }];
  assert.ok(resolveEnrollmentPlayers(null, roster).reasons.length);
  roster.participants = [{ clientId: player, isCancelled: false, spot: 1 }];
  assert.equal(resolveEnrollmentPlayers(null, roster).players.length, 1);
});
test("raw provider cancellation status and waitlist markers survive normalization", async () => {
  for (const marker of [{ status: "cancelled" }, { status: "waitlist" }]) {
    const roster = await loadTimeForFriendsProviderEnrollment({ tournamentId, fetchImpl: async (url) => ({ ok: true, json: async () => String(url).includes("/exercises/")
      ? { id: tournamentId, directionId: 2617, studioId: "station", maxClientsCount: 8 }
      : [{ clientId: player, isCancelled: false, spot: 1, ...marker }] }) });
    assert.equal(resolveEnrollmentPlayers(null, roster).players.length, 0);
  }
});
test("phone collisions and conflicting existing IDs fail closed", () => {
  const f = fixtures(); f.tournaments[0].standings.push({ id: other, phone: "79990000001" }); f.tournaments[0].standings[0].phone = "79990000001";
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  assert.equal(inspectMembership({ members: [{ id: other, phone: "89990000001" }] }, { playerId: player, phoneNorm: "79990000001" }), "MEMBER_IDENTITY_CONFLICT");
});
test("final standings do not bypass cancelled or waitlisted roster evidence", () => {
  for (const marker of [{ isCancelled: true }, { status: "WAITLIST" }, { isWaitlist: true }, { spot: 9 }]) {
    const f = fixtures(); Object.assign(f.tournaments[0].participants[0], marker); f.tournaments[0].maxParticipants = 8;
    assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  }
  const f = fixtures(); f.tournaments[0].waitlist = [{ id: player }];
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
});
test("previous receipt respects departures; different tournaments retain independent receipts", () => {
  const f = fixtures(); const plan = buildPublishedEnrollmentPlan(f);
  f.prior = [{ _id: plan.operations[0].operationId }];
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
});

test("cross-tournament/canonical phone collisions quarantine both identities", () => {
  const f = fixtures();
  f.tournaments[0].standings[0].phone = "79990000001";
  f.states = [{ clientId: other, phoneNorm: "79990000001" }];
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  delete f.states;
  const id = "44444444-4444-4444-8444-444444444444";
  f.tournaments.push({ ...f.tournaments[0], _id: "t2", tournamentId: id, participants: [], standings: [{ id: other, phone: "79990000001" }] });
  f.publications.push({ ...f.publications[0], _id: "p2", id: "p2", relatedTournamentId: id });
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
});
test("same provider alias with inconsistent source dates is quarantined", () => {
  const f = fixtures();
  f.publications.push({ ...f.publications[0], _id: "p2", id: "p2", startAt: "2026-09-15T18:00:00Z" });
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
});
test("future confirmed bookings enroll; no provider roster means no invented membership", () => {
  const f = fixtures(); f.tournaments = []; f.publications[0].startAt = "2026-09-25T18:00:00Z";
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 0);
  f.rosters = new Map([[tournamentId, { maxParticipants: 4, participants: [{ clientId: player, isCancelled: false, spot: 1 }] }]]);
  assert.equal(buildPublishedEnrollmentPlan(f).operations.length, 1);
});

const mongoUri = process.env.MONGO_REHEARSAL_URI;
test("Mongo: dry-run no writes; apply literal; concurrent replay; restore CAS; source drift", { skip: !mongoUri }, async () => {
  const client = new MongoClient(mongoUri), dbName = `enrollment_rehearsal_${Date.now()}`;
  await client.connect(); const db = client.db(dbName);
  try {
    const f = fixtures();
    await db.collection("tournaments").insertMany(f.tournaments);
    await db.collection("lk_community_feed").insertMany(f.publications);
    await db.collection("lk_communities").insertMany(f.communities);
    const args = { client, db, ...scope, providerLimit: 0 };
    assert.equal((await runPublishedTournamentEnrollment({ ...args, dryRun: true })).planned, 1);
    assert.equal(await db.collection(ENROLLMENT_COLLECTION).countDocuments(), 0);
    const concurrent = await Promise.all([runPublishedTournamentEnrollment({ ...args, dryRun: false }), runPublishedTournamentEnrollment({ ...args, dryRun: false })]);
    assert.equal(concurrent.reduce((n, r) => n + r.applied, 0), 1);
    let community = await db.collection("lk_communities").findOne({ id: "c1" });
    assert.equal(community.members.length, 1); assert.equal(community.members[0].name, "$$ROOT"); assert.equal(community.memberCount, 1);
    const audit = await db.collection(ENROLLMENT_COLLECTION).findOne({});
    await db.collection("lk_communities").updateOne({ id: "c1" }, { $set: { unrelated: "edited" } });
    await assert.rejects(restorePublishedEnrollment({ client, db, operationId: audit._id }), /drift/);
    await db.collection("lk_communities").updateOne({ id: "c1" }, { $unset: { unrelated: "" } });
    await restorePublishedEnrollment({ client, db, operationId: audit._id });
    community = await db.collection("lk_communities").findOne({ id: "c1" }); assert.deepEqual(community.members, []);
    assert.equal((await runPublishedTournamentEnrollment({ ...args, dryRun: false })).applied, 0);
    await db.collection(ENROLLMENT_COLLECTION).deleteMany({});
    const drift = await runPublishedTournamentEnrollment({ ...args, dryRun: false, beforeApply: async () => {
      await db.collection("lk_community_feed").updateOne({ _id: "p1" }, { $set: { status: "DRAFT" } });
    } });
    assert.equal(drift.applied, 0); assert.equal(drift.issues[0].reason, "SOURCE_DRIFT");
    assert.equal(await db.collection(ENROLLMENT_COLLECTION).countDocuments(), 0);
  } finally { await db.dropDatabase(); await client.close(); }
});

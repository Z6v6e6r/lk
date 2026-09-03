import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  assertFullCommunityPreimage,
  hashCommunityPreimage,
  hashFullCommunityPreimage,
  hashFrozenPlan,
  validateCurrentMembershipPreconditions,
  validateFrozenPlan,
  validateRestoreBackup,
} from "../apply_published_tournament_membership_plan.mjs";
import {
  buildCommunityRestoreReplacement,
  buildTimeForAtomicMembershipMutation,
  PUBLISHED_TOURNAMENT_JOIN_SOURCE,
} from "../lib/publishedTournamentMembershipPlan.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  const observedAt = "2026-09-02T18:43:30.941Z";
  const community = {
    _id: "mongo-community-id",
    id: "community-1",
    archived: false,
    updatedAt: "2026-09-02T18:40:00.000Z",
    members: [],
    bannedMembers: [],
    pendingMembers: [],
    memberCount: 0,
  };
  const playerId = "11111111-1111-4111-8111-111111111111";
  const operation = {
    operationId: `published-tournament:${sha256(`community-1|${playerId}`).slice(0, 32)}`,
    communityId: "community-1",
    stationId: "station-1",
    playerId,
    phoneNorm: "79990000000",
    playerName: "Игрок",
    tournamentIds: ["22222222-2222-4222-8222-222222222222"],
    publicationIds: ["publication-1"],
    directionIds: ["5280"],
  };
  const plan = {
    observedAt,
    planSha256: "",
    version: "published-tournament-community-membership-plan-v4",
    stationId: "station-1",
    period: { startInclusive: "2026-07-31T21:00:00.000Z", endExclusive: "2026-08-31T21:00:00.000Z" },
    communities: [{ communityId: "community-1", role: "tff_c" }],
    approvedScope: { levelCommunityOverrides: {}, excludedExercises: {} },
    sourceFingerprint: { community: hashCommunityPreimage([community]), feed: "f".repeat(64), tournaments: "a".repeat(64) },
    operations: [operation],
    skipped: [],
    quarantined: [],
    publications: [],
  };
  plan.planSha256 = hashFrozenPlan(plan);
  return { plan, community, operation };
}

test("accepts a fresh immutable plan with exact current community preimage", () => {
  const { plan, community } = fixture();
  const now = Date.parse(plan.observedAt) + 5 * 60_000;
  assert.equal(validateFrozenPlan(plan, now, 15).operationCount, 1);
  assert.deepEqual(validateCurrentMembershipPreconditions(plan, [community]), {
    communityCount: 1,
    operationCount: 1,
  });
});

test("rejects plan tampering, quarantine, staleness, and membership drift", () => {
  const { plan, community } = fixture();
  const now = Date.parse(plan.observedAt) + 5 * 60_000;
  assert.throws(() => validateFrozenPlan({ ...plan, stationId: "tampered" }, now, 15), /Plan SHA/);

  const quarantined = { ...plan, quarantined: [{ reason: "AMBIGUOUS" }] };
  quarantined.planSha256 = hashFrozenPlan(quarantined);
  assert.throws(() => validateFrozenPlan(quarantined, now, 15), /quarantined/);
  assert.throws(() => validateFrozenPlan(plan, now + 20 * 60_000, 15), /freshness/);

  const drifted = { ...community, updatedAt: "2026-09-02T18:41:00.000Z" };
  assert.throws(() => validateCurrentMembershipPreconditions(plan, [drifted]), /preimage drifted/);
});

test("rejects banned, existing, and unresolved phone-only identities", () => {
  const { plan, community, operation } = fixture();
  const banned = { ...community, bannedMembers: [{ id: operation.playerId }], memberCount: 0 };
  plan.sourceFingerprint.community = hashCommunityPreimage([banned]);
  plan.planSha256 = hashFrozenPlan(plan);
  assert.throws(() => validateCurrentMembershipPreconditions(plan, [banned]), /banned/);

  const existing = { ...community, members: [{ id: operation.playerId }], memberCount: 1 };
  plan.sourceFingerprint.community = hashCommunityPreimage([existing]);
  plan.planSha256 = hashFrozenPlan(plan);
  assert.throws(() => validateCurrentMembershipPreconditions(plan, [existing]), /already belongs/);

  const phoneOnly = { ...community, members: [{ phone: "+1 202 555 0100" }], memberCount: 1 };
  const noPhonePlan = { ...plan, operations: [{ ...operation, phoneNorm: null }] };
  noPhonePlan.sourceFingerprint.community = hashCommunityPreimage([phoneOnly]);
  noPhonePlan.planSha256 = hashFrozenPlan(noPhonePlan);
  assert.throws(() => validateCurrentMembershipPreconditions(noPhonePlan, [phoneOnly]), /phone-only/);
});

test("builds provenance-bound add and CAS-bound restore operations", () => {
  const { community, operation } = fixture();
  const provenance = "published-tournament-community-membership-plan-v4:plan-sha";
  const mutation = buildTimeForAtomicMembershipMutation(operation, "2026-09-02T19:00:00.000Z", provenance);
  const member = mutation.update[0].$set.members.$concatArrays[1].$literal[0];
  assert.equal(member.joinSource.type, PUBLISHED_TOURNAMENT_JOIN_SOURCE);
  assert.equal(member.joinSource.version, provenance);
  assert.deepEqual(member.joinSource.tournamentIds, operation.tournamentIds);

  const restore = buildCommunityRestoreReplacement(community, "2026-09-02T19:00:00.000Z");
  assert.deepEqual(restore.filter, { _id: community._id, updatedAt: "2026-09-02T19:00:00.000Z" });
  assert.equal(restore.replacement, community);
});

test("literalizes the complete imported member payload", () => {
  const { operation } = fixture();
  const adversarialOperation = {
    ...operation,
    playerName: "$$ROOT",
    tournamentIds: ["$members", { $getField: "privateField" }],
  };
  const mutation = buildTimeForAtomicMembershipMutation(
    adversarialOperation,
    "2026-09-02T19:00:00.000Z",
    "published-tournament-community-membership-plan-v4:plan-sha",
  );

  assert.deepEqual(mutation.update[0].$set.members.$concatArrays[1], {
    $literal: [{
      id: operation.playerId,
      name: "$$ROOT",
      role: "MEMBER",
      status: "ACTIVE",
      joinedAt: "2026-09-02T19:00:00.000Z",
      joinSource: {
        type: PUBLISHED_TOURNAMENT_JOIN_SOURCE,
        version: "published-tournament-community-membership-plan-v4:plan-sha",
        tournamentIds: ["$members", { $getField: "privateField" }],
      },
    }],
  });
});

test("full BSON preimage guard detects non-membership drift on every transaction attempt", () => {
  const { community } = fixture();
  const expectedSha = hashFullCommunityPreimage([community]);
  assert.equal(assertFullCommunityPreimage([community], expectedSha, "Attempt 1"), expectedSha);

  const retryPostimage = {
    ...community,
    description: "concurrent writer",
    pendingMembers: [{ id: "pending-player", role: "REQUESTED" }],
  };
  assert.equal(hashCommunityPreimage([retryPostimage]), hashCommunityPreimage([community]));
  assert.throws(
    () => assertFullCommunityPreimage([retryPostimage], expectedSha, "Attempt 2"),
    /Attempt 2 full community preimage drifted/,
  );
});

test("accepts only a complete backup bound to the frozen preimage", () => {
  const { plan, community } = fixture();
  const appliedAt = "2026-09-02T19:00:00.000Z";
  const backup = {
    version: "published-tournament-community-membership-backup-v2",
    generatedAt: appliedAt,
    appliedAt,
    planSha256: plan.planSha256,
    provenanceVersion: `${plan.version}:${plan.planSha256}`,
    communityPreimageSha256: plan.sourceFingerprint.community,
    communityFullPreimageSha256: hashFullCommunityPreimage([community]),
    communities: [community],
  };
  assert.equal(validateRestoreBackup(plan, backup).communityCount, 1);

  assert.throws(
    () => validateRestoreBackup(plan, { ...backup, communities: [] }),
    /community set/,
  );
  assert.throws(
    () => validateRestoreBackup(plan, {
      ...backup,
      communities: [{ ...community, members: [{ id: "unexpected" }], memberCount: 1 }],
    }),
    /preimage/,
  );
  assert.throws(
    () => validateRestoreBackup(plan, { ...backup, provenanceVersion: "other" }),
    /provenance/,
  );
  assert.throws(
    () => validateRestoreBackup(plan, { ...backup, communityFullPreimageSha256: "0".repeat(64) }),
    /full community preimage/,
  );
});

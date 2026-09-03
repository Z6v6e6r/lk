import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MongoClient } from "mongodb";
import {
  hashCommunityPreimage,
  hashFrozenPlan,
  main as runExecutor,
} from "../apply_published_tournament_membership_plan.mjs";

const mongoUri = process.env.MONGO_REHEARSAL_URI;
const maybeTest = mongoUri ? test : test.skip;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function operation(communityId, playerId, suffix) {
  return {
    operationId: `published-tournament:${sha256(`${communityId}|${playerId}`).slice(0, 32)}`,
    communityId,
    stationId: "station-rehearsal",
    playerId,
    phoneNorm: `7999000000${suffix}`,
    playerName: `Player ${suffix}`,
    tournamentIds: [`22222222-2222-4222-8222-22222222222${suffix}`],
    publicationIds: [`publication-${suffix}`],
    directionIds: ["5280"],
  };
}

maybeTest("physically applies and CAS-restores a frozen membership plan in a replica set", async () => {
  const databaseName = `membership_rehearsal_${Date.now()}`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "published-membership-rehearsal-"));
  fs.chmodSync(tempDir, 0o700);
  const planPath = path.join(tempDir, "plan.json");
  const backupDir = path.join(tempDir, "backup");
  const applyReportPath = path.join(tempDir, "apply-report.json");
  const restoreReportPath = path.join(tempDir, "restore-report.json");
  const client = new MongoClient(mongoUri);
  const previousMongoUri = process.env.MONGO_URI;
  try {
    await client.connect();
    const db = client.db(databaseName);
    const communities = [
      {
        _id: "community-mongo-1",
        id: "community-1",
        archived: false,
        updatedAt: "2026-09-02T19:00:00.000Z",
        members: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Existing" }],
        bannedMembers: [],
        pendingMembers: [],
        memberCount: 1,
      },
      {
        _id: "community-mongo-2",
        id: "community-2",
        archived: false,
        updatedAt: "2026-09-02T19:00:00.000Z",
        members: [],
        bannedMembers: [],
        pendingMembers: [{ id: "22222222-2222-4222-8222-222222222222" }],
        memberCount: 0,
      },
    ];
    await db.collection("lk_communities").insertMany(communities);
    const plan = {
      observedAt: new Date().toISOString(),
      planSha256: "",
      version: "published-tournament-community-membership-plan-v4",
      stationId: "station-rehearsal",
      period: { startInclusive: "2026-08-01T00:00:00.000Z", endExclusive: "2026-09-01T00:00:00.000Z" },
      communities: [
        { communityId: "community-1", role: "station" },
        { communityId: "community-2", role: "tff_d" },
      ],
      approvedScope: { levelCommunityOverrides: {}, excludedExercises: {} },
      sourceFingerprint: {
        community: hashCommunityPreimage(communities),
        feed: "f".repeat(64),
        tournaments: "a".repeat(64),
      },
      operations: [
        operation("community-1", "11111111-1111-4111-8111-111111111111", "1"),
        operation("community-2", "22222222-2222-4222-8222-222222222222", "2"),
      ],
      skipped: [],
      quarantined: [],
      publications: [],
    };
    plan.planSha256 = hashFrozenPlan(plan);
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
    process.env.MONGO_URI = mongoUri;

    await runExecutor([
      "--plan", planPath,
      "--db", databaseName,
      "--apply",
      "--confirm-plan-sha", plan.planSha256,
      "--backup-dir", backupDir,
      "--report", applyReportPath,
    ]);
    const applied = await db.collection("lk_communities").find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(applied.map((row) => row.memberCount), [2, 1]);
    assert.equal(applied[1].pendingMembers.length, 0);
    assert.equal(await db.collection("lk_tournament_community_enrollments").countDocuments({ planSha256: plan.planSha256 }), 2);
    assert.equal(await db.collection("lk_tournament_community_backfill_executions").countDocuments({ planSha256: plan.planSha256 }), 1);

    const applyReport = JSON.parse(fs.readFileSync(applyReportPath, "utf8"));
    await db.collection("lk_communities").updateOne(
      { id: "community-1" },
      { $set: { description: "concurrent writer after apply" } },
    );
    await assert.rejects(
      runExecutor([
        "--plan", planPath,
        "--db", databaseName,
        "--restore",
        "--confirm-plan-sha", plan.planSha256,
        "--backup", applyReport.backupPath,
        "--confirm-backup-sha", applyReport.backupSha256,
        "--report", restoreReportPath,
      ]),
      /Restore current postimage full community preimage drifted/,
    );
    const rejectedRestore = await db.collection("lk_communities").findOne({ id: "community-1" });
    assert.equal(rejectedRestore.description, "concurrent writer after apply");
    assert.equal(rejectedRestore.memberCount, 2);
    await db.collection("lk_communities").updateOne(
      { id: "community-1" },
      { $unset: { description: "" } },
    );
    await runExecutor([
      "--plan", planPath,
      "--db", databaseName,
      "--restore",
      "--confirm-plan-sha", plan.planSha256,
      "--backup", applyReport.backupPath,
      "--confirm-backup-sha", applyReport.backupSha256,
      "--report", restoreReportPath,
    ]);
    const restored = await db.collection("lk_communities").find({}).sort({ _id: 1 }).toArray();
    assert.equal(hashCommunityPreimage(restored), hashCommunityPreimage(communities));
    assert.equal(restored[1].pendingMembers.length, 1);
    assert.equal(await db.collection("lk_tournament_community_enrollments").countDocuments({ planSha256: plan.planSha256 }), 0);
    assert.equal(await db.collection("lk_tournament_community_backfill_executions").countDocuments({ planSha256: plan.planSha256 }), 0);
  } finally {
    if (previousMongoUri === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = previousMongoUri;
    await client.db(databaseName).dropDatabase().catch(() => {});
    await client.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

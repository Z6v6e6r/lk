import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyIndexSpecs,
  EXPECTED_CANDIDATE_FLOW_SHA256,
  EXPECTED_LIVE_FLOW_SHA256,
  PRODUCTION_MIGRATION_ID,
  PRODUCTION_PACKET_SCHEMA_VERSION,
  readProtectedExecutionPacket,
  sanitizeProductionRunnerError,
  sha256,
  validateProductionExecutionPacket,
} from "../run_legacy_game_command_production_migration.mjs";

const digest = (character) => character.repeat(64);
const releaseSha = "a".repeat(40);
const COMBINED_SOURCE_ONLY_CANDIDATE_SHA256 = "e730bf8c043e2f33f5a75c6825d56f39a580a10201f77c399d2323f70f9f7e4d";

const context = {
  target: { databaseName: "games", targetFingerprint: digest("1") },
  planDigest: digest("2"),
  readyForExecutionPacket: true,
  source: {
    liveFlowSha256: EXPECTED_LIVE_FLOW_SHA256,
    candidateFlowSha256: EXPECTED_CANDIDATE_FLOW_SHA256,
    packageSha256: digest("3"),
    writerRegistrySha256: digest("4"),
    runnerSha256: digest("a"),
    migrationCoreSha256: digest("b"),
  },
};

const buildPacket = (overrides = {}) => ({
  schemaVersion: PRODUCTION_PACKET_SCHEMA_VERSION,
  migrationId: PRODUCTION_MIGRATION_ID,
  environment: "production",
  target: { databaseName: "games", fingerprint: context.target.targetFingerprint },
  source: {
    repositoryCommit: releaseSha,
    liveFlowSha256: EXPECTED_LIVE_FLOW_SHA256,
    candidateFlowSha256: EXPECTED_CANDIDATE_FLOW_SHA256,
    packageSha256: context.source.packageSha256,
    writerRegistrySha256: context.source.writerRegistrySha256,
    runnerSha256: context.source.runnerSha256,
    migrationCoreSha256: context.source.migrationCoreSha256,
  },
  plan: { digest: context.planDigest, generatedAt: "2026-08-26T11:53:00.000Z" },
  backup: {
    manifestSha256: digest("5"),
    snapshotIdentitySha256: digest("6"),
    restoreVerificationSha256: digest("7"),
    completedAt: "2026-08-26T11:52:00.000Z",
    restoreVerifiedAt: "2026-08-26T11:54:00.000Z",
  },
  quiescence: {
    attestationSha256: digest("8"),
    writerCount: 7,
    writerRegistrySha256: context.source.writerRegistrySha256,
    writersStoppedAt: "2026-08-26T11:50:00.000Z",
    observedFrom: "2026-08-26T11:51:00.000Z",
    observedTo: "2026-08-26T11:58:00.000Z",
    expiresAt: "2026-08-26T12:20:00.000Z",
  },
  runtime: {
    compatibilityReportSha256: digest("9"),
    nodeVersion: "v22.0.0",
    mongodbDriverVersion: "6.20.0",
    verifiedAt: "2026-08-26T11:55:00.000Z",
  },
  authorization: {
    approvedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:20:00.000Z",
  },
  execution: { nonce: "11111111-1111-4111-8111-111111111111" },
  ...overrides,
});

const validate = (packet) => {
  const body = Buffer.from(JSON.stringify(packet));
  const packetSha256 = sha256(body);
  return validateProductionExecutionPacket(packet, context, {
    packetSha256,
    actualPacketSha256: packetSha256,
    releaseSha,
    now: new Date("2026-08-26T12:10:00.000Z"),
    evidenceSha256: {
      backupManifestSha256: digest("5"),
      restoreVerificationSha256: digest("7"),
      quiescenceAttestationSha256: digest("8"),
      runtimeCompatibilitySha256: digest("9"),
    },
  });
};

test("production execution packet accepts exact short-lived stopped-writer evidence", () => {
  assert.deepEqual(validate(buildPacket()), {
    deadlineMs: Date.parse("2026-08-26T12:20:00.000Z"),
  });
});

test("combined source-only candidate is not production-authorized", () => {
  assert.notEqual(EXPECTED_CANDIDATE_FLOW_SHA256, COMBINED_SOURCE_ONLY_CANDIDATE_SHA256);
  const combinedCandidate = buildPacket({
    source: {
      ...buildPacket().source,
      candidateFlowSha256: COMBINED_SOURCE_ONLY_CANDIDATE_SHA256,
    },
  });
  assert.throws(() => validate(combinedCandidate), /candidate flow digest mismatch/);
});

test("production execution packet rejects drift, weak quiescence, stale backup, and reused authority", () => {
  const stalePlan = buildPacket({ plan: { digest: digest("f"), generatedAt: "2026-08-26T11:53:00.000Z" } });
  assert.throws(() => validate(stalePlan), /plan digest is stale/);

  const sourceDrift = buildPacket({
    source: { ...buildPacket().source, liveFlowSha256: digest("e") },
  });
  assert.throws(() => validate(sourceDrift), /live flow digest mismatch/);

  const weakQuiescence = buildPacket({
    quiescence: { ...buildPacket().quiescence, observedTo: "2026-08-26T11:52:00.000Z" },
  });
  assert.throws(() => validate(weakQuiescence), /Quiescence evidence/);

  const expired = buildPacket({
    authorization: { approvedAt: "2026-08-26T11:30:00.000Z", expiresAt: "2026-08-26T12:00:00.000Z" },
  });
  assert.throws(() => validate(expired), /authorization window/);

  const staleBackup = buildPacket({
    backup: { ...buildPacket().backup, completedAt: "2026-08-24T11:52:00.000Z" },
  });
  assert.throws(() => validate(staleBackup), /Backup or restore verification evidence/);

  const wrongTarget = buildPacket({ target: { databaseName: "other", fingerprint: context.target.targetFingerprint } });
  assert.throws(() => validate(wrongTarget), /target identity mismatch/);
});

test("index classifier rejects same-name drift and equivalent indexes under another name", () => {
  const specs = [{ key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id", unique: true }];
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id", unique: true, v: 2 },
  ], specs), { matching: ["uniq_tenant_game_id"], missing: [], conflicts: [] });
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: 1, id: -1 }, name: "uniq_tenant_game_id", unique: true },
  ], specs).conflicts, ["uniq_tenant_game_id:definition"]);
  assert.deepEqual(classifyIndexSpecs([
    { key: { id: 1, tenantKey: 1 }, name: "uniq_tenant_game_id", unique: true },
  ], specs).conflicts, ["uniq_tenant_game_id:definition"]);
  assert.deepEqual(classifyIndexSpecs([
    { key: { tenantKey: 1, id: 1 }, name: "other_name", unique: true },
  ], specs).conflicts, ["uniq_tenant_game_id:equivalent-as-other_name"]);
});

test("execution packet loader rejects permissive files and returns exact byte digest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-command-packet-"));
  try {
    const packetPath = path.join(directory, "packet.json");
    const body = `${JSON.stringify(buildPacket())}\n`;
    fs.writeFileSync(packetPath, body, { mode: 0o600 });
    const loaded = readProtectedExecutionPacket(packetPath);
    assert.equal(loaded.sha256, sha256(Buffer.from(body)));
    fs.chmodSync(packetPath, 0o644);
    assert.throws(() => readProtectedExecutionPacket(packetPath), /owned private regular file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runner diagnostics redact Mongo credentials", () => {
  const scheme = ["mongo", "db"].join("");
  const username = ["sample", "user"].join("-");
  const password = ["sample", "password"].join("-");
  const message = sanitizeProductionRunnerError(new Error(
    `connect failed ${scheme}://${username}:${password}@mongo.internal:27017/games`,
  ));
  assert.equal(message.includes(username), false);
  assert.equal(message.includes(password), false);
  assert.equal(message.includes(`${scheme}://`), false);
  assert.equal(message, "LEGACY_GAME_COMMAND_PRODUCTION_MIGRATION_FAILED");
});

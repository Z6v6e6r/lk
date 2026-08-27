import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import {
  assertPinnedMongoRuntimeClosure,
  classifyAmbiguousExecutionReceipt,
  classifyIndexSpecs,
  executionReceiptIdentityMatches,
  EXPECTED_CANDIDATE_FLOW_SHA256,
  EXPECTED_LIVE_FLOW_SHA256,
  PRODUCTION_MIGRATION_ID,
  PRODUCTION_PACKET_SCHEMA_VERSION,
  PRODUCTION_RUNTIME_IDENTITY,
  readProtectedExecutionPacket,
  resolveRuntimePackageClosure,
  sanitizeProductionRunnerError,
  sha256,
  stableStringify,
  validateProductionExecutionPacket,
  validateProductionReleaseAttestation,
} from "../run_legacy_game_command_production_migration.mjs";

const require = createRequire(import.meta.url);
const digest = (character) => character.repeat(64);
const releaseSha = "a".repeat(40);
const COMBINED_SOURCE_ONLY_CANDIDATE_SHA256 = "e730bf8c043e2f33f5a75c6825d56f39a580a10201f77c399d2323f70f9f7e4d";

const context = {
  target: { databaseName: "games", targetFingerprint: digest("1") },
  planDigest: digest("2"),
  stateDigest: digest("0"),
  readyForExecutionPacket: true,
  source: {
    liveFlowSha256: EXPECTED_LIVE_FLOW_SHA256,
    candidateFlowSha256: EXPECTED_CANDIDATE_FLOW_SHA256,
    packageSha256: digest("3"),
    writerRegistrySha256: digest("4"),
    installerSha256: digest("9"),
    runnerSha256: digest("a"),
    migrationCoreSha256: digest("b"),
    approvalVerifierSha256: digest("c"),
    trustAnchorManifestSha256: digest("d"),
    rootPackageSha256: digest("5"),
    dependencyLockSha256: digest("6"),
    nodeExecutableSha256: digest("7"),
    mongodbRuntimeClosureSha256: digest("8"),
    releaseAttestationSha256: digest("e"),
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
    installerSha256: context.source.installerSha256,
    runnerSha256: context.source.runnerSha256,
    migrationCoreSha256: context.source.migrationCoreSha256,
    approvalVerifierSha256: context.source.approvalVerifierSha256,
    trustAnchorManifestSha256: context.source.trustAnchorManifestSha256,
    rootPackageSha256: context.source.rootPackageSha256,
    dependencyLockSha256: context.source.dependencyLockSha256,
    nodeExecutableSha256: context.source.nodeExecutableSha256,
    mongodbRuntimeClosureSha256: context.source.mongodbRuntimeClosureSha256,
    releaseAttestationSha256: context.source.releaseAttestationSha256,
  },
  plan: { digest: context.planDigest, stateDigest: context.stateDigest, generatedAt: "2026-08-26T11:53:00.000Z" },
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
    nodeVersion: PRODUCTION_RUNTIME_IDENTITY.nodeVersion,
    mongodbDriverVersion: PRODUCTION_RUNTIME_IDENTITY.mongodbDriverVersion,
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
  assert.throws(() => validate({ ...buildPacket(), unreviewed: true }), /approved schema/);
  assert.throws(() => validate(buildPacket({
    authorization: { approvedAt: "2026-08-26T12:00:00Z", expiresAt: "2026-08-26T12:20:00.000Z" },
  })), /canonical UTC RFC3339/);

  const stalePlan = buildPacket({
    plan: { digest: digest("f"), stateDigest: context.stateDigest, generatedAt: "2026-08-26T11:53:00.000Z" },
  });
  assert.throws(() => validate(stalePlan), /plan digest is stale/);

  const sourceDrift = buildPacket({
    source: { ...buildPacket().source, liveFlowSha256: digest("e") },
  });
  assert.throws(() => validate(sourceDrift), /live flow digest mismatch/);

  const runtimeDrift = buildPacket({
    runtime: { ...buildPacket().runtime, nodeVersion: "v0.0.0" },
  });
  assert.throws(() => validate(runtimeDrift), /runtime identity differs/);

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

test("release attestation binds a custodian deployment to every local source digest", () => {
  const packet = buildPacket();
  const actualSource = { ...packet.source };
  delete actualSource.repositoryCommit;
  const attestation = {
    schemaVersion: 1,
    migrationId: PRODUCTION_MIGRATION_ID,
    environment: "production",
    deploymentId: "11111111-1111-4111-8111-111111111111",
    repositoryCommit: packet.source.repositoryCommit,
    source: Object.fromEntries(Object.entries(actualSource).filter(([key]) => key !== "releaseAttestationSha256")),
    activatedAt: "2026-08-26T11:45:00.000Z",
    status: "ACTIVE",
  };
  assert.equal(validateProductionReleaseAttestation(packet, attestation, {
    attestationSha256: packet.source.releaseAttestationSha256,
    actualSource,
    now: new Date("2026-08-26T12:10:00.000Z"),
  }), true);
  assert.throws(() => validateProductionReleaseAttestation(packet, {
    ...attestation,
    source: { ...attestation.source, runnerSha256: digest("f") },
  }, {
    attestationSha256: packet.source.releaseAttestationSha256,
    actualSource,
    now: new Date("2026-08-26T12:10:00.000Z"),
  }), /runnerSha256 mismatch/);
});

test("ambiguous majority receipt never authorizes writes and distinguishes recovery from conflict", async () => {
  const expected = {
    _id: "11111111-1111-4111-8111-111111111111",
    migrationId: PRODUCTION_MIGRATION_ID,
    packetSha256: digest("1"),
    planDigest: digest("2"),
    targetFingerprint: digest("3"),
    repositoryCommit: releaseSha,
    approvalKeyId: "operations-approval-2026-01",
    approvalKeyFingerprintSha256: digest("4"),
  };
  assert.equal(executionReceiptIdentityMatches({ ...expected, status: "APPLYING" }, expected), true);
  assert.equal(await classifyAmbiguousExecutionReceipt({
    findOne: async () => ({ ...expected, status: "APPLYING" }),
  }, expected), "RECOVERY_REQUIRED");
  assert.equal(await classifyAmbiguousExecutionReceipt({
    findOne: async () => ({ ...expected, packetSha256: digest("9") }),
  }, expected), "CONFLICT");
  assert.equal(await classifyAmbiguousExecutionReceipt({ findOne: async () => null }, expected), "UNKNOWN_ABSENT");
  assert.equal(await classifyAmbiguousExecutionReceipt({ findOne: async () => { throw new Error("timeout"); } }, expected), "UNKNOWN_UNREADABLE");
});

test("runtime closure includes installed peers and fails on a missing required peer", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-command-runtime-closure-"));
  try {
    const projectDirectory = path.join(directory, "project");
    const nodeModules = path.join(projectDirectory, "node_modules");
    const entryDirectory = path.join(nodeModules, "root-runtime");
    const peerDirectory = path.join(nodeModules, "peer-runtime");
    fs.mkdirSync(entryDirectory, { recursive: true });
    fs.mkdirSync(peerDirectory, { recursive: true });
    const entryManifestPath = path.join(entryDirectory, "package.json");
    fs.writeFileSync(entryManifestPath, JSON.stringify({
      name: "root-runtime",
      version: "1.0.0",
      peerDependencies: {
        "peer-runtime": "2.0.0",
        "missing-optional-runtime": "1.0.0",
      },
      peerDependenciesMeta: { "missing-optional-runtime": { optional: true } },
    }));
    fs.writeFileSync(path.join(peerDirectory, "package.json"), JSON.stringify({
      name: "peer-runtime",
      version: "2.0.0",
      exports: "./index.js",
    }));
    fs.writeFileSync(path.join(peerDirectory, "index.js"), "export const peer = true;\n");
    assert.deepEqual(
      resolveRuntimePackageClosure(entryManifestPath).map((item) => item.identity),
      ["peer-runtime@2.0.0", "root-runtime@1.0.0"],
    );
    fs.writeFileSync(entryManifestPath, JSON.stringify({
      name: "root-runtime",
      version: "1.0.0",
      peerDependencies: { "missing-required-runtime": "1.0.0" },
    }));
    assert.throws(() => resolveRuntimePackageClosure(entryManifestPath), /missing-required-runtime/);

    const ambientDirectory = path.join(directory, "node_modules", "ambient-runtime");
    fs.mkdirSync(ambientDirectory, { recursive: true });
    fs.writeFileSync(path.join(ambientDirectory, "package.json"), JSON.stringify({
      name: "ambient-runtime",
      version: "9.9.9",
    }));
    fs.writeFileSync(path.join(ambientDirectory, "index.js"), "export const ambient = true;\n");
    fs.writeFileSync(entryManifestPath, JSON.stringify({
      name: "root-runtime",
      version: "1.0.0",
      peerDependencies: { "ambient-runtime": "9.9.9" },
      peerDependenciesMeta: { "ambient-runtime": { optional: true } },
    }));
    assert.deepEqual(
      resolveRuntimePackageClosure(entryManifestPath).map((item) => item.identity),
      ["root-runtime@1.0.0"],
    );
    fs.writeFileSync(entryManifestPath, JSON.stringify({
      name: "root-runtime",
      version: "1.0.0",
      dependencies: { "ambient-runtime": "9.9.9" },
    }));
    assert.throws(
      () => resolveRuntimePackageClosure(entryManifestPath),
      /outside the approved node_modules root/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("release input rejects changed MongoDB dependency bytes with unchanged package metadata", (t) => {
  const sourceEntry = require.resolve("mongodb/package.json");
  const sourcePackages = resolveRuntimePackageClosure(sourceEntry);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "legacy-command-pinned-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const runtimePackage of sourcePackages) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const markerIndex = runtimePackage.directory.indexOf(marker);
    const relative = runtimePackage.directory.slice(markerIndex + marker.length);
    fs.cpSync(runtimePackage.directory, path.join(root, "node_modules", relative), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  const copiedEntry = path.join(root, "node_modules", "mongodb", "package.json");
  assertPinnedMongoRuntimeClosure(copiedEntry);
  fs.appendFileSync(path.join(root, "node_modules", "mongodb", "lib", "index.js"), "\n// tampered\n");
  assert.throws(
    () => assertPinnedMongoRuntimeClosure(copiedEntry),
    /independently pinned npm ci digest/,
  );
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
    const body = `${stableStringify(buildPacket())}\n`;
    fs.writeFileSync(packetPath, body, { mode: 0o600 });
    const loaded = readProtectedExecutionPacket(packetPath);
    assert.equal(loaded.sha256, sha256(Buffer.from(body)));
    fs.writeFileSync(packetPath, `${JSON.stringify(buildPacket())}\n`, { mode: 0o600 });
    assert.throws(() => readProtectedExecutionPacket(packetPath), /canonical JSON/);
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
  assert.equal(sanitizeProductionRunnerError({
    code: "LEGACY_GAME_COMMAND_RECEIPT_RECOVERY_REQUIRED",
  }), "LEGACY_GAME_COMMAND_RECEIPT_RECOVERY_REQUIRED");
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertImmutableProductionSourceCustody,
  buildApprovalSignatureMessage,
  canonicalJson,
  PRODUCTION_APPROVAL_ALGORITHM,
  PRODUCTION_APPROVAL_SIGNATURE_SCHEMA_VERSION,
  PRODUCTION_MIGRATION_ID,
  readCustodianCanonicalJson,
  readProtectedCanonicalJson,
  readTrustedEd25519PublicKey,
  sha256,
  verifyProductionApprovalSignature,
} from "../lib/legacy_game_command_production_approval.mjs";
import {
  digestProductionEvidenceDocuments,
  PRODUCTION_RUNTIME_IDENTITY,
  validateProductionEvidenceDigests,
  validateProductionEvidenceDocuments,
} from "../run_legacy_game_command_production_migration.mjs";

const digest = (character) => character.repeat(64);

const buildApproval = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyBody = Buffer.from(publicKey.export({ type: "spki", format: "pem" }));
  const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
  const packetBody = Buffer.from(canonicalJson({ migration: PRODUCTION_MIGRATION_ID, nonce: "approved-once" }));
  const packetSha256 = sha256(packetBody);
  const signature = crypto.sign(null, buildApprovalSignatureMessage(packetSha256), privateKey);
  return {
    packetBody,
    publicKeyBody,
    trustAnchor: {
      schemaVersion: 1,
      status: "BOUND",
      algorithm: PRODUCTION_APPROVAL_ALGORITHM,
      keyId: "operations-approval-2026-01",
      publicKeySpkiSha256: fingerprint,
    },
    envelope: {
      schemaVersion: PRODUCTION_APPROVAL_SIGNATURE_SCHEMA_VERSION,
      migrationId: PRODUCTION_MIGRATION_ID,
      algorithm: PRODUCTION_APPROVAL_ALGORITHM,
      keyId: "operations-approval-2026-01",
      keyFingerprintSha256: fingerprint,
      packetSha256,
      signatureBase64: signature.toString("base64"),
    },
  };
};

test("detached Ed25519 approval binds exact packet bytes to the source trust anchor", () => {
  const approval = buildApproval();
  assert.deepEqual(verifyProductionApprovalSignature(approval), {
    algorithm: "Ed25519",
    keyId: approval.trustAnchor.keyId,
    keyFingerprintSha256: approval.trustAnchor.publicKeySpkiSha256,
    packetSha256: approval.envelope.packetSha256,
  });
});

test("approval rejects unbound, substituted, ambiguous, and tampered authority", () => {
  const approval = buildApproval();
  assert.throws(() => verifyProductionApprovalSignature({
    ...approval,
    trustAnchor: { ...approval.trustAnchor, status: "UNBOUND", keyId: "UNBOUND", publicKeySpkiSha256: "UNBOUND" },
  }), /not bound/);
  assert.throws(() => verifyProductionApprovalSignature({
    ...approval,
    packetBody: Buffer.from(canonicalJson({ migration: PRODUCTION_MIGRATION_ID, nonce: "tampered" })),
  }), /packet digest mismatch/);
  assert.throws(() => verifyProductionApprovalSignature({
    ...approval,
    envelope: { ...approval.envelope, extra: true },
  }), /approved schema/);
  assert.throws(() => verifyProductionApprovalSignature({
    ...approval,
    envelope: { ...approval.envelope, keyFingerprintSha256: digest("f") },
  }), /trust-anchor identity mismatch/);
  const other = buildApproval();
  assert.throws(() => verifyProductionApprovalSignature({
    ...approval,
    publicKeyBody: other.publicKeyBody,
  }), /public key fingerprint mismatch/);
  assert.throws(() => verifyProductionApprovalSignature({
    ...approval,
    envelope: { ...approval.envelope, signatureBase64: Buffer.alloc(64).toString("base64") },
  }), /verification failed/);
});

test("approval files require canonical private JSON and a non-writable Ed25519 public key", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-command-approval-"));
  const approval = buildApproval();
  try {
    const signaturePath = path.join(directory, "approval.json");
    const publicKeyPath = path.join(directory, "approval.pem");
    fs.writeFileSync(signaturePath, canonicalJson(approval.envelope), { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, approval.publicKeyBody, { mode: 0o644 });
    assert.equal(readProtectedCanonicalJson(signaturePath, 16_384, "Approval signature").sha256.length, 64);
    assert.equal(readTrustedEd25519PublicKey(publicKeyPath).spkiSha256, approval.trustAnchor.publicKeySpkiSha256);
    fs.writeFileSync(signaturePath, `${JSON.stringify(approval.envelope, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => readProtectedCanonicalJson(signaturePath, 16_384, "Approval signature"), /canonical JSON/);
    fs.chmodSync(publicKeyPath, 0o666);
    assert.throws(() => readTrustedEd25519PublicKey(publicKeyPath), /non-writable regular file/);
    const rsaPublicKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ type: "spki", format: "pem" });
    fs.writeFileSync(publicKeyPath, rsaPublicKey, { mode: 0o644 });
    fs.chmodSync(publicKeyPath, 0o644);
    assert.throws(() => readTrustedEd25519PublicKey(publicKeyPath), /must use Ed25519/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const packet = {
  target: { databaseName: "games", fingerprint: digest("1") },
  source: {
    repositoryCommit: "a".repeat(40),
    liveFlowSha256: digest("2"),
    candidateFlowSha256: digest("3"),
    packageSha256: digest("4"),
    writerRegistrySha256: digest("5"),
    installerSha256: digest("f"),
    runnerSha256: digest("6"),
    migrationCoreSha256: digest("7"),
    approvalVerifierSha256: digest("8"),
    trustAnchorManifestSha256: digest("9"),
    rootPackageSha256: digest("1"),
    dependencyLockSha256: digest("2"),
    nodeExecutableSha256: digest("3"),
    mongodbRuntimeClosureSha256: digest("4"),
    releaseAttestationSha256: digest("0"),
  },
  plan: { stateDigest: digest("f") },
  backup: {
    manifestSha256: digest("a"),
    snapshotIdentitySha256: digest("b"),
    restoreVerificationSha256: digest("c"),
    completedAt: "2026-08-26T11:52:00.000Z",
    restoreVerifiedAt: "2026-08-26T11:54:00.000Z",
  },
  quiescence: {
    attestationSha256: digest("d"),
    writerCount: 7,
    writerRegistrySha256: digest("5"),
    writersStoppedAt: "2026-08-26T11:50:00.000Z",
    observedFrom: "2026-08-26T11:51:00.000Z",
    observedTo: "2026-08-26T11:58:00.000Z",
    expiresAt: "2026-08-26T12:20:00.000Z",
  },
  runtime: {
    compatibilityReportSha256: digest("e"),
    nodeVersion: PRODUCTION_RUNTIME_IDENTITY.nodeVersion,
    mongodbDriverVersion: PRODUCTION_RUNTIME_IDENTITY.mongodbDriverVersion,
    verifiedAt: "2026-08-26T11:55:00.000Z",
  },
};

const evidenceDocuments = {
  backupManifest: {
    schemaVersion: 1,
    migrationId: PRODUCTION_MIGRATION_ID,
    environment: "production",
    targetFingerprint: packet.target.fingerprint,
    repositoryCommit: packet.source.repositoryCommit,
    snapshotIdentitySha256: packet.backup.snapshotIdentitySha256,
    stateDigestSha256: packet.plan.stateDigest,
    artifactSetSha256: digest("f"),
    backupToolName: "mongodump",
    backupToolVersion: "100.11.0",
    startedAt: "2026-08-26T11:51:00.000Z",
    completedAt: packet.backup.completedAt,
    status: "COMPLETED",
  },
  restoreVerification: {
    schemaVersion: 1,
    migrationId: PRODUCTION_MIGRATION_ID,
    environment: "production",
    targetFingerprint: packet.target.fingerprint,
    repositoryCommit: packet.source.repositoryCommit,
    backupManifestSha256: packet.backup.manifestSha256,
    snapshotIdentitySha256: packet.backup.snapshotIdentitySha256,
    restoredStateDigestSha256: packet.plan.stateDigest,
    verifiedAt: packet.backup.restoreVerifiedAt,
    status: "VERIFIED",
  },
  quiescenceAttestation: {
    schemaVersion: 1,
    migrationId: PRODUCTION_MIGRATION_ID,
    environment: "production",
    targetFingerprint: packet.target.fingerprint,
    repositoryCommit: packet.source.repositoryCommit,
    writerRegistrySha256: packet.quiescence.writerRegistrySha256,
    writerCount: packet.quiescence.writerCount,
    writersStoppedAt: packet.quiescence.writersStoppedAt,
    observedFrom: packet.quiescence.observedFrom,
    observedTo: packet.quiescence.observedTo,
    expiresAt: packet.quiescence.expiresAt,
    writeCountBefore: "1042",
    writeCountAfter: "1042",
    status: "QUIESCENT",
  },
  runtimeCompatibility: {
    schemaVersion: 1,
    migrationId: PRODUCTION_MIGRATION_ID,
    environment: "production",
    targetFingerprint: packet.target.fingerprint,
    repositoryCommit: packet.source.repositoryCommit,
    liveFlowSha256: packet.source.liveFlowSha256,
    candidateFlowSha256: packet.source.candidateFlowSha256,
    packageSha256: packet.source.packageSha256,
    writerRegistrySha256: packet.source.writerRegistrySha256,
    installerSha256: packet.source.installerSha256,
    runnerSha256: packet.source.runnerSha256,
    migrationCoreSha256: packet.source.migrationCoreSha256,
    approvalVerifierSha256: packet.source.approvalVerifierSha256,
    trustAnchorManifestSha256: packet.source.trustAnchorManifestSha256,
    rootPackageSha256: packet.source.rootPackageSha256,
    dependencyLockSha256: packet.source.dependencyLockSha256,
    nodeExecutableSha256: packet.source.nodeExecutableSha256,
    mongodbRuntimeClosureSha256: packet.source.mongodbRuntimeClosureSha256,
    releaseAttestationSha256: packet.source.releaseAttestationSha256,
    nodeVersion: packet.runtime.nodeVersion,
    mongodbDriverVersion: packet.runtime.mongodbDriverVersion,
    verifiedAt: packet.runtime.verifiedAt,
    status: "COMPATIBLE",
  },
};

test("strict evidence schemas bind backup, restore, quiescence, and runtime to the signed packet", () => {
  assert.equal(validateProductionEvidenceDocuments(packet, evidenceDocuments), true);
  const evidenceDigests = {
    backupManifestSha256: packet.backup.manifestSha256,
    restoreVerificationSha256: packet.backup.restoreVerificationSha256,
    quiescenceAttestationSha256: packet.quiescence.attestationSha256,
    runtimeCompatibilitySha256: packet.runtime.compatibilityReportSha256,
  };
  assert.equal(validateProductionEvidenceDigests(packet, evidenceDigests), true);
  const recomputed = digestProductionEvidenceDocuments(evidenceDocuments);
  assert.deepEqual(recomputed, {
    backupManifestSha256: sha256(Buffer.from(canonicalJson(evidenceDocuments.backupManifest))),
    restoreVerificationSha256: sha256(Buffer.from(canonicalJson(evidenceDocuments.restoreVerification))),
    quiescenceAttestationSha256: sha256(Buffer.from(canonicalJson(evidenceDocuments.quiescenceAttestation))),
    runtimeCompatibilitySha256: sha256(Buffer.from(canonicalJson(evidenceDocuments.runtimeCompatibility))),
  });
  assert.throws(() => validateProductionEvidenceDigests(packet, {
    ...evidenceDigests,
    backupManifestSha256: digest("f"),
  }), /backup manifest evidence file digest mismatch/);
  assert.throws(() => validateProductionEvidenceDocuments(packet, {
    ...evidenceDocuments,
    quiescenceAttestation: { ...evidenceDocuments.quiescenceAttestation, writeCountAfter: "1043" },
  }), /Quiescence attestation content mismatch/);
  assert.throws(() => validateProductionEvidenceDocuments(packet, {
    ...evidenceDocuments,
    runtimeCompatibility: { ...evidenceDocuments.runtimeCompatibility, runnerSha256: digest("f") },
  }), /Runtime compatibility report content mismatch/);
  assert.throws(() => validateProductionEvidenceDocuments(packet, {
    ...evidenceDocuments,
    backupManifest: { ...evidenceDocuments.backupManifest, operatorNote: "unreviewed" },
  }), /approved schema/);
  assert.throws(() => validateProductionEvidenceDocuments(packet, {
    ...evidenceDocuments,
    restoreVerification: { ...evidenceDocuments.restoreVerification, status: "PENDING" },
  }), /Restore verification content mismatch/);
  assert.throws(() => validateProductionEvidenceDocuments(packet, {
    ...evidenceDocuments,
    restoreVerification: { ...evidenceDocuments.restoreVerification, restoredStateDigestSha256: digest("e") },
  }), /Restore verification content mismatch/);
});

test("custodian files and source must be read-only and outside the executor identity", () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), ".legacy-command-custody-"));
  const executorUid = (typeof process.getuid === "function" ? process.getuid() : 0) + 1;
  try {
    const attestationPath = path.join(directory, "release-attestation.json");
    fs.writeFileSync(attestationPath, canonicalJson({ status: "ACTIVE" }), { mode: 0o444 });
    assert.equal(readCustodianCanonicalJson(
      attestationPath,
      4096,
      "Release attestation",
      { executorUid },
    ).value.status, "ACTIVE");
    assert.equal(assertImmutableProductionSourceCustody([attestationPath], { executorUid }), true);
    assert.throws(() => assertImmutableProductionSourceCustody([attestationPath], {
      executorUid: typeof process.getuid === "function" ? process.getuid() : 0,
    }), /outside executor control/);
    fs.chmodSync(attestationPath, 0o644);
    assert.throws(() => readCustodianCanonicalJson(
      attestationPath,
      4096,
      "Release attestation",
      { executorUid },
    ), /custodian-owned read-only/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

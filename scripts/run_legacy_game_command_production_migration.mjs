#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BSON, MongoClient } from "mongodb";
import {
  LEGACY_COMMAND_COLLECTIONS,
  LEGACY_COMMAND_INDEX_SPECS,
} from "../node-red/custom-nodes/legacy-game-command-transaction/legacy-game-command-core.mjs";
import {
  auditHasBlockingFindings,
  auditLegacyCommandPrerequisites,
  buildLegacyPrerequisiteRollbackPlan,
} from "./migrate_legacy_game_command_prerequisites.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const RUNNER_PATH = fileURLToPath(import.meta.url);
const MIGRATION_CORE_PATH = path.join(SCRIPT_DIR, "migrate_legacy_game_command_prerequisites.mjs");
const PACKAGE_DIR = path.join(REPO_ROOT, "node-red/custom-nodes/legacy-game-command-transaction");
const WRITER_REGISTRY_PATH = path.join(SCRIPT_DIR, "legacy_game_revision_writers.json");
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["audit", "dry-run", "postcheck", "apply", "rollback-plan"]);
const PRIMARY_MAJORITY = { readPreference: "primary", readConcern: { level: "majority" } };

export const PRODUCTION_MIGRATION_ID = "legacy-game-command-prerequisites-production-v1";
export const PRODUCTION_PACKET_SCHEMA_VERSION = 1;
export const PRODUCTION_APPLY_CONFIRMATION = "APPLY_LEGACY_GAME_COMMAND_PREREQUISITES_PRODUCTION_V1";
export const PRODUCTION_APPROVAL_TRUST_ANCHOR_SHA256 = "UNBOUND";
export const EXPECTED_LIVE_FLOW_SHA256 = "0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e";
export const EXPECTED_CANDIDATE_FLOW_SHA256 = "035e9d93b70ee8d3b2817280f42539679e5a7ed270bf8f0c242b364ad57a0e02";
export const MIN_QUIESCENCE_OBSERVATION_MS = 120_000;
export const MAX_PACKET_LIFETIME_MS = 30 * 60_000;
export const MAX_BACKUP_AGE_MS = 24 * 60 * 60_000;
export const EXECUTION_COLLECTION = "lk_legacy_game_prerequisite_migration_executions";

export const RATING_INDEX_SPECS = Object.freeze([
  Object.freeze({ collection: "player_rating_state", key: Object.freeze({ playerKey: 1 }), name: "player_rating_state_key_uq", unique: true }),
  Object.freeze({ collection: "player_rating_state", key: Object.freeze({ clientId: 1 }), name: "player_rating_state_client_uq", unique: true, partialFilterExpression: Object.freeze({ clientId: Object.freeze({ $type: "string" }) }) }),
  Object.freeze({ collection: "player_rating_state", key: Object.freeze({ phoneNorm: 1 }), name: "player_rating_state_phone_uq", unique: true, partialFilterExpression: Object.freeze({ phoneNorm: Object.freeze({ $type: "string" }) }) }),
]);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
};

export const stableStringify = (value) => JSON.stringify(stableValue(value));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalBson = (value) => stableValue(JSON.parse(BSON.EJSON.stringify(value, { relaxed: false })));

const normalizeIndex = (index) => ({
  name: String(index?.name || ""),
  key: Object.entries(index?.key || {}).map(([field, direction]) => [field, canonicalBson(direction)]),
  unique: index?.unique === true,
  sparse: index?.sparse === true,
  hidden: index?.hidden === true,
  expireAfterSeconds: Number.isFinite(index?.expireAfterSeconds) ? Number(index.expireAfterSeconds) : null,
  collation: index?.collation ? stableValue(index.collation) : null,
  partialFilterExpression: index?.partialFilterExpression ? stableValue(index.partialFilterExpression) : null,
});

const normalizeSpec = (spec) => normalizeIndex({
  name: spec.name,
  key: spec.key,
  unique: spec.unique,
  sparse: spec.sparse,
  hidden: spec.hidden,
  expireAfterSeconds: spec.expireAfterSeconds,
  collation: spec.collation,
  partialFilterExpression: spec.partialFilterExpression,
});

const asTimestamp = (value, label) => {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an RFC3339 timestamp`);
  return parsed;
};

const assertHash = (value, label) => {
  if (!HASH_PATTERN.test(String(value || ""))) throw new Error(`${label} must be a SHA-256 digest`);
};

export function hashPrivatePackage(directory = PACKAGE_DIR) {
  const root = path.resolve(directory);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules")
    .sort((left, right) => left.name.localeCompare(right.name));
  const digest = crypto.createHash("sha256");
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`Package contains unsupported entry ${entry.name}`);
    const body = fs.readFileSync(path.join(root, entry.name));
    digest.update(`${entry.name}\u0000${body.length}\u0000`);
    digest.update(body);
  }
  return digest.digest("hex");
}

export const writerRegistrySha256 = () => sha256(fs.readFileSync(WRITER_REGISTRY_PATH));

async function listIndexes(collection) {
  try {
    return await collection.listIndexes().toArray();
  } catch (error) {
    if (error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
}

export function classifyIndexSpecs(existingIndexes, specs) {
  const existing = existingIndexes.map(normalizeIndex);
  const matching = [];
  const missing = [];
  const conflicts = [];
  for (const spec of specs) {
    const expected = normalizeSpec(spec);
    const sameName = existing.find((item) => item.name === expected.name);
    if (sameName) {
      if (isDeepStrictEqual(sameName, expected)) matching.push(expected.name);
      else conflicts.push(`${expected.name}:definition`);
      continue;
    }
    const sameKey = existing.find((item) => isDeepStrictEqual(item.key, expected.key));
    if (sameKey) conflicts.push(`${expected.name}:equivalent-as-${sameKey.name}`);
    else missing.push(expected.name);
  }
  return { matching, missing, conflicts };
}

async function classifyPrerequisiteIndexes(db) {
  const matching = [];
  const missing = [];
  const conflicts = [];
  const catalogs = {};
  for (const [logicalName, specs] of Object.entries(LEGACY_COMMAND_INDEX_SPECS)) {
    const collectionName = LEGACY_COMMAND_COLLECTIONS[logicalName];
    const existing = await listIndexes(db.collection(collectionName));
    catalogs[collectionName] = existing.map(normalizeIndex).sort((a, b) => a.name.localeCompare(b.name));
    const result = classifyIndexSpecs(existing, specs);
    matching.push(...result.matching.map((name) => `${collectionName}.${name}`));
    missing.push(...result.missing.map((name) => `${collectionName}.${name}`));
    conflicts.push(...result.conflicts.map((name) => `${collectionName}.${name}`));
  }
  return { matching, missing, conflicts, catalogs };
}

async function classifyRatingIndexes(db) {
  const collection = db.collection("player_rating_state");
  const existing = await listIndexes(collection);
  const result = classifyIndexSpecs(existing, RATING_INDEX_SPECS);
  return {
    matching: result.matching,
    missing: result.missing,
    conflicts: result.conflicts,
    catalog: existing.map(normalizeIndex).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function digestCollection(collection, digest) {
  let count = 0;
  const cursor = collection.find({}, { ...PRIMARY_MAJORITY, batchSize: 200, maxTimeMS: 120_000 }).sort({ _id: 1 });
  for await (const document of cursor) {
    const body = stableStringify(canonicalBson(document));
    digest.update(`${body.length}:`);
    digest.update(body);
    count += 1;
  }
  return count;
}

export async function buildMigrationStateDigest(db, prerequisiteCatalogs, ratingCatalog) {
  const digest = crypto.createHash("sha256");
  const counts = {};
  const collectionNames = [...new Set(Object.values(LEGACY_COMMAND_COLLECTIONS))].sort();
  for (const collectionName of collectionNames) {
    digest.update(`collection:${collectionName}\u0000`);
    counts[collectionName] = await digestCollection(db.collection(collectionName), digest);
  }
  digest.update(stableStringify({ prerequisiteCatalogs, ratingCatalog }));
  return { stateDigest: digest.digest("hex"), collectionCounts: counts };
}

export async function identifyProductionTarget(db) {
  const [hello, buildInfo] = await Promise.all([
    db.admin().command({ hello: 1 }),
    db.command({ buildInfo: 1 }),
  ]);
  if (!hello?.setName || hello?.isWritablePrimary !== true) {
    throw new Error("Production migration requires a writable replica-set primary");
  }
  const identity = {
    databaseName: db.databaseName,
    replicaSet: String(hello.setName),
    hosts: [...new Set([...(hello.hosts || []), ...(hello.passives || []), ...(hello.arbiters || [])])].sort(),
  };
  return {
    databaseName: db.databaseName,
    targetFingerprint: sha256(stableStringify(identity)),
    serverVersion: String(buildInfo?.version || "unknown"),
    replicaSetMemberCount: identity.hosts.length,
  };
}

export async function buildProductionMigrationContext(db, { now = new Date() } = {}) {
  const [target, audit, prerequisiteIndexes, ratingIndexes] = await Promise.all([
    identifyProductionTarget(db),
    auditLegacyCommandPrerequisites(db),
    classifyPrerequisiteIndexes(db),
    classifyRatingIndexes(db),
  ]);
  const state = await buildMigrationStateDigest(db, prerequisiteIndexes.catalogs, ratingIndexes.catalog);
  const publicPrerequisiteIndexes = {
    matching: prerequisiteIndexes.matching,
    missing: prerequisiteIndexes.missing,
    conflicts: prerequisiteIndexes.conflicts,
  };
  const publicRatingIndexes = {
    matching: ratingIndexes.matching,
    missing: ratingIndexes.missing,
    conflicts: ratingIndexes.conflicts,
  };
  const packageSha256 = hashPrivatePackage();
  const registrySha256 = writerRegistrySha256();
  const planMaterial = {
    schemaVersion: PRODUCTION_PACKET_SCHEMA_VERSION,
    migrationId: PRODUCTION_MIGRATION_ID,
    target,
    stateDigest: state.stateDigest,
    audit,
    prerequisiteIndexes: publicPrerequisiteIndexes,
    ratingIndexes: publicRatingIndexes,
    source: {
      liveFlowSha256: EXPECTED_LIVE_FLOW_SHA256,
      candidateFlowSha256: EXPECTED_CANDIDATE_FLOW_SHA256,
      packageSha256,
      writerRegistrySha256: registrySha256,
      runnerSha256: sha256(fs.readFileSync(RUNNER_PATH)),
      migrationCoreSha256: sha256(fs.readFileSync(MIGRATION_CORE_PATH)),
    },
  };
  return {
    generatedAt: now.toISOString(),
    ...planMaterial,
    planDigest: sha256(stableStringify(planMaterial)),
    collectionCounts: state.collectionCounts,
    readyForExecutionPacket: !auditHasBlockingFindings(audit)
      && prerequisiteIndexes.conflicts.length === 0
      && ratingIndexes.missing.length === 0
      && ratingIndexes.conflicts.length === 0,
  };
}

export function validateProductionExecutionPacket(packet, context, {
  packetSha256,
  actualPacketSha256,
  releaseSha,
  now = new Date(),
  environment = "production",
  evidenceSha256,
} = {}) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error("Execution packet must be an object");
  assertHash(packetSha256, "Expected packet digest");
  if (packetSha256 !== actualPacketSha256) throw new Error("Execution packet digest mismatch");
  if (packet.schemaVersion !== PRODUCTION_PACKET_SCHEMA_VERSION || packet.migrationId !== PRODUCTION_MIGRATION_ID) {
    throw new Error("Execution packet schema or migration identity mismatch");
  }
  if (packet.environment !== environment) throw new Error("Execution packet environment mismatch");
  if (!COMMIT_PATTERN.test(String(releaseSha || "")) || packet.source?.repositoryCommit !== releaseSha) {
    throw new Error("Execution packet release commit mismatch");
  }
  const exactHashes = [
    [packet.source?.liveFlowSha256, EXPECTED_LIVE_FLOW_SHA256, "live flow"],
    [packet.source?.candidateFlowSha256, EXPECTED_CANDIDATE_FLOW_SHA256, "candidate flow"],
    [packet.source?.packageSha256, context.source.packageSha256, "custom node package"],
    [packet.source?.writerRegistrySha256, context.source.writerRegistrySha256, "writer registry"],
    [packet.source?.runnerSha256, context.source.runnerSha256, "production runner"],
    [packet.source?.migrationCoreSha256, context.source.migrationCoreSha256, "migration core"],
  ];
  for (const [actual, expected, label] of exactHashes) {
    assertHash(actual, `${label} digest`);
    if (actual !== expected) throw new Error(`Execution packet ${label} digest mismatch`);
  }
  if (packet.target?.databaseName !== context.target.databaseName
    || packet.target?.fingerprint !== context.target.targetFingerprint) {
    throw new Error("Execution packet target identity mismatch");
  }
  if (packet.plan?.digest !== context.planDigest) throw new Error("Execution packet plan digest is stale");
  if (!context.readyForExecutionPacket) throw new Error("Fresh production audit is not ready for apply");

  const nowMs = now.getTime();
  const approvedAt = asTimestamp(packet.authorization?.approvedAt, "authorization.approvedAt");
  const expiresAt = asTimestamp(packet.authorization?.expiresAt, "authorization.expiresAt");
  const planGeneratedAt = asTimestamp(packet.plan?.generatedAt, "plan.generatedAt");
  if (approvedAt > nowMs || expiresAt <= nowMs || expiresAt - approvedAt > MAX_PACKET_LIFETIME_MS) {
    throw new Error("Execution packet authorization window is invalid or expired");
  }
  if (planGeneratedAt > approvedAt) throw new Error("Execution packet plan was generated after approval");

  assertHash(packet.backup?.manifestSha256, "backup.manifestSha256");
  assertHash(packet.backup?.snapshotIdentitySha256, "backup.snapshotIdentitySha256");
  assertHash(packet.backup?.restoreVerificationSha256, "backup.restoreVerificationSha256");
  const backupCompletedAt = asTimestamp(packet.backup?.completedAt, "backup.completedAt");
  const restoreVerifiedAt = asTimestamp(packet.backup?.restoreVerifiedAt, "backup.restoreVerifiedAt");
  if (restoreVerifiedAt < backupCompletedAt || approvedAt - backupCompletedAt > MAX_BACKUP_AGE_MS) {
    throw new Error("Backup or restore verification evidence is stale or out of order");
  }

  assertHash(packet.quiescence?.attestationSha256, "quiescence.attestationSha256");
  if (packet.quiescence?.writerCount !== 7
    || packet.quiescence?.writerRegistrySha256 !== context.source.writerRegistrySha256) {
    throw new Error("Quiescence writer inventory mismatch");
  }
  const stoppedAt = asTimestamp(packet.quiescence?.writersStoppedAt, "quiescence.writersStoppedAt");
  const observedFrom = asTimestamp(packet.quiescence?.observedFrom, "quiescence.observedFrom");
  const observedTo = asTimestamp(packet.quiescence?.observedTo, "quiescence.observedTo");
  const quiescenceExpiresAt = asTimestamp(packet.quiescence?.expiresAt, "quiescence.expiresAt");
  if (stoppedAt > observedFrom || observedTo - observedFrom < MIN_QUIESCENCE_OBSERVATION_MS
    || observedTo > approvedAt || quiescenceExpiresAt <= nowMs) {
    throw new Error("Quiescence evidence is incomplete, too short, or expired");
  }
  if (planGeneratedAt < observedFrom || planGeneratedAt > observedTo) {
    throw new Error("Fresh plan is outside the attested quiescence window");
  }
  if (backupCompletedAt < stoppedAt || backupCompletedAt > observedTo || restoreVerifiedAt > approvedAt) {
    throw new Error("Backup evidence is outside the stopped-writer approval window");
  }

  assertHash(packet.runtime?.compatibilityReportSha256, "runtime.compatibilityReportSha256");
  const runtimeVerifiedAt = asTimestamp(packet.runtime?.verifiedAt, "runtime.verifiedAt");
  if (runtimeVerifiedAt < stoppedAt || runtimeVerifiedAt > approvedAt) {
    throw new Error("Runtime compatibility evidence is outside the approval window");
  }
  if (typeof packet.runtime?.nodeVersion !== "string" || !packet.runtime.nodeVersion.trim()
    || typeof packet.runtime?.mongodbDriverVersion !== "string" || !packet.runtime.mongodbDriverVersion.trim()) {
    throw new Error("Runtime compatibility versions are absent");
  }
  if (!UUID_PATTERN.test(String(packet.execution?.nonce || ""))) throw new Error("Execution nonce must be a UUID");
  const evidence = optionsEvidence({ evidenceSha256 });
  const evidencePairs = [
    [evidence.backupManifestSha256, packet.backup.manifestSha256, "backup manifest"],
    [evidence.restoreVerificationSha256, packet.backup.restoreVerificationSha256, "restore verification"],
    [evidence.quiescenceAttestationSha256, packet.quiescence.attestationSha256, "quiescence attestation"],
    [evidence.runtimeCompatibilitySha256, packet.runtime.compatibilityReportSha256, "runtime compatibility"],
  ];
  for (const [actual, expected, label] of evidencePairs) {
    assertHash(actual, `${label} evidence digest`);
    if (actual !== expected) throw new Error(`${label} evidence file digest mismatch`);
  }
  return {
    deadlineMs: Math.min(expiresAt, quiescenceExpiresAt),
  };
}

function optionsEvidence(options) {
  return options?.evidenceSha256 && typeof options.evidenceSha256 === "object"
    ? options.evidenceSha256
    : {};
}

function assertProductionApprovalTrustAnchorBound() {
  throw new Error("Production approval trust anchor is not bound in source");
}

function invalidRevisionFilter() {
  return {
    $or: [
      { revision: { $exists: false } },
      { revision: null },
      { revision: { $not: { $type: "number" } } },
      { revision: { $lt: 1 } },
      { revision: { $gt: Number.MAX_SAFE_INTEGER } },
      { $expr: { $cond: [
        { $in: [{ $type: "$revision" }, ["int", "long", "double", "decimal"]] },
        { $ne: [{ $mod: ["$revision", 1] }, 0] },
        false,
      ] } },
    ],
  };
}

function remainingDeadlineMs(deadlineMs, nowProvider = Date.now) {
  const remaining = deadlineMs - nowProvider();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Production apply authority or quiescence expired");
  return Math.max(1, Math.min(120_000, remaining));
}

async function applyProductionPrerequisiteMutations(db, { deadlineMs, nowProvider = Date.now }) {
  const before = await auditLegacyCommandPrerequisites(db, {
    maxTimeMS: remainingDeadlineMs(deadlineMs, nowProvider),
  });
  if (auditHasBlockingFindings(before)) throw new Error("Production migration audit became blocking");
  const revisionResult = await db.collection(LEGACY_COMMAND_COLLECTIONS.games).updateMany(
    invalidRevisionFilter(),
    { $set: { revision: 1 } },
    {
      writeConcern: { w: "majority" },
      maxTimeMS: remainingDeadlineMs(deadlineMs, nowProvider),
    },
  );
  if (!revisionResult.acknowledged) throw new Error("Production revision backfill was not majority acknowledged");
  for (const [logicalName, specs] of Object.entries(LEGACY_COMMAND_INDEX_SPECS)) {
    const collection = db.collection(LEGACY_COMMAND_COLLECTIONS[logicalName]);
    for (const spec of specs) {
      const { key, ...indexOptions } = spec;
      await collection.createIndex(key, {
        ...indexOptions,
        writeConcern: { w: "majority" },
        maxTimeMS: remainingDeadlineMs(deadlineMs, nowProvider),
      });
    }
  }
  const after = await auditLegacyCommandPrerequisites(db, {
    maxTimeMS: remainingDeadlineMs(deadlineMs, nowProvider),
  });
  if (after.invalidRevisionCount || auditHasBlockingFindings(after)) {
    throw new Error("Production migration postcheck failed after writes");
  }
  remainingDeadlineMs(deadlineMs, nowProvider);
  return {
    before,
    revisionMatchedCount: revisionResult.matchedCount,
    revisionModifiedCount: revisionResult.modifiedCount,
    after,
  };
}

export async function executeProductionMigration(db, options) {
  assertProductionApprovalTrustAnchorBound();
  if (options.confirmation !== PRODUCTION_APPLY_CONFIRMATION) throw new Error("Production apply confirmation is absent");
  const context = await buildProductionMigrationContext(db, { now: options.now });
  const { deadlineMs } = validateProductionExecutionPacket(options.packet, context, options);
  const executions = db.collection(EXECUTION_COLLECTION);
  const receipt = {
    _id: options.packet.execution.nonce,
    migrationId: PRODUCTION_MIGRATION_ID,
    packetSha256: options.packetSha256,
    planDigest: context.planDigest,
    targetFingerprint: context.target.targetFingerprint,
    repositoryCommit: options.releaseSha,
    status: "APPLYING",
    startedAt: (options.now || new Date()).toISOString(),
  };
  try {
    await executions.insertOne(receipt, {
      writeConcern: { w: "majority" },
      maxTimeMS: remainingDeadlineMs(deadlineMs, options.nowProvider),
    });
  } catch (error) {
    if (error?.code === 11000) throw new Error("Execution nonce was already consumed");
    throw error;
  }
  try {
    const migration = await applyProductionPrerequisiteMutations(db, { deadlineMs, nowProvider: options.nowProvider });
    remainingDeadlineMs(deadlineMs, options.nowProvider);
    const postcheck = await buildProductionMigrationContext(db, { now: options.now });
    if (postcheck.audit.invalidRevisionCount || auditHasBlockingFindings(postcheck.audit)
      || postcheck.prerequisiteIndexes.missing.length || postcheck.prerequisiteIndexes.conflicts.length
      || postcheck.ratingIndexes.missing.length || postcheck.ratingIndexes.conflicts.length) {
      throw new Error("Production migration postcheck failed");
    }
    const completion = await executions.updateOne(
      { _id: receipt._id, status: "APPLYING" },
      { $set: { status: "SUCCEEDED", completedAt: (options.now || new Date()).toISOString(), postcheckPlanDigest: postcheck.planDigest } },
      { writeConcern: { w: "majority" }, maxTimeMS: remainingDeadlineMs(deadlineMs, options.nowProvider) },
    );
    if (!completion.acknowledged || completion.matchedCount !== 1 || completion.modifiedCount !== 1) {
      throw new Error("Migration execution receipt completion was not acknowledged");
    }
    return {
      migrationId: PRODUCTION_MIGRATION_ID,
      executionNonce: receipt._id,
      packetSha256: options.packetSha256,
      revisionMatchedCount: migration.revisionMatchedCount,
      revisionModifiedCount: migration.revisionModifiedCount,
      postcheckPlanDigest: postcheck.planDigest,
      mutationsPerformed: true,
    };
  } catch (error) {
    await executions.updateOne(
      { _id: receipt._id, status: "APPLYING" },
      { $set: { status: "FAILED", failedAt: new Date().toISOString(), failureCode: "MIGRATION_OR_POSTCHECK_FAILED" } },
      { writeConcern: { w: "majority" } },
    ).catch(() => {});
    throw new Error("Production migration stopped after execution receipt; run postcheck and recovery plan before any retry", { cause: error });
  }
}

function readPrivateRegularFile(filePath, maximumSize, label) {
  const absolutePath = path.resolve(String(filePath || ""));
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid
      || (stat.mode & 0o077) !== 0 || stat.size > maximumSize) {
      throw new Error("unsafe");
    }
    return fs.readFileSync(descriptor);
  } catch {
    throw new Error(`${label} must be an owned private regular file with one link`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readProtectedExecutionPacket(packetPath) {
  const body = readPrivateRegularFile(packetPath, 65_536, "Execution packet");
  return { packet: JSON.parse(body.toString("utf8")), sha256: sha256(body) };
}

export function hashProtectedEvidenceFile(evidencePath) {
  return sha256(readPrivateRegularFile(evidencePath, 16 * 1024 * 1024, "Evidence artifact"));
}

function reservePrivateReport(reportPath, inputPaths = []) {
  if (!reportPath) return null;
  const absolutePath = path.resolve(reportPath);
  if (inputPaths.filter(Boolean).map((item) => path.resolve(item)).includes(absolutePath)) {
    throw new Error("Output report path must differ from every input artifact");
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(absolutePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  return { absolutePath, descriptor };
}

function writeReservedReport(reservation, report) {
  if (!reservation) return;
  const body = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  fs.writeSync(reservation.descriptor, body, 0, body.length, 0);
  fs.fsyncSync(reservation.descriptor);
  fs.closeSync(reservation.descriptor);
  reservation.descriptor = null;
}

function parseArgs(argv) {
  const result = { mode: "audit" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    result[token.slice(2)] = value;
    index += 1;
  }
  if (!MODES.has(result.mode)) throw new Error(`Unsupported mode ${result.mode}`);
  return result;
}

function publicContext(context, mode) {
  return {
    schemaVersion: PRODUCTION_PACKET_SCHEMA_VERSION,
    migrationId: PRODUCTION_MIGRATION_ID,
    mode,
    generatedAt: context.generatedAt,
    target: context.target,
    planDigest: context.planDigest,
    collectionCounts: context.collectionCounts,
    audit: context.audit,
    prerequisiteIndexes: context.prerequisiteIndexes,
    ratingIndexes: context.ratingIndexes,
    source: context.source,
    readyForExecutionPacket: context.readyForExecutionPacket,
    mutationsPerformed: false,
  };
}

export function sanitizeProductionRunnerError(error) {
  void error;
  return "LEGACY_GAME_COMMAND_PRODUCTION_MIGRATION_FAILED";
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.mode === "apply") {
    if (!args["execution-packet"] || !args["expected-packet-sha256"]) {
      throw new Error("Apply requires --execution-packet and --expected-packet-sha256");
    }
    for (const name of ["backup-manifest", "restore-verification", "quiescence-attestation", "runtime-compatibility-report"]) {
      if (!args[name]) throw new Error(`Apply requires --${name}`);
    }
    assertProductionApprovalTrustAnchorBound();
  }
  const applyInputPaths = args.mode === "apply" ? [
    args["execution-packet"],
    args["backup-manifest"],
    args["restore-verification"],
    args["quiescence-attestation"],
    args["runtime-compatibility-report"],
  ] : [];
  const reportReservation = reservePrivateReport(args.out, applyInputPaths);
  let reportWritten = false;
  try {
  if (args.mode === "rollback-plan") {
    const report = { mode: args.mode, rollback: buildLegacyPrerequisiteRollbackPlan(), mutationsPerformed: false };
    writeReservedReport(reportReservation, report);
    reportWritten = true;
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const mongoUri = String(process.env.LK_LEGACY_COMMAND_MONGO_URI || "").trim();
  const databaseName = String(args.database || process.env.LK_LEGACY_COMMAND_MONGO_DB || "").trim();
  const releaseSha = String(process.env.LK_LEGACY_COMMAND_RELEASE_SHA || "").trim().toLowerCase();
  if (!mongoUri || !databaseName) throw new Error("Mongo connection env and database are required");
  if (!COMMIT_PATTERN.test(releaseSha)) throw new Error("LK_LEGACY_COMMAND_RELEASE_SHA is required");
  const client = new MongoClient(mongoUri, {
    appName: `PadlHubLegacyGamePrerequisite:${args.mode}`,
    readPreference: "primary",
    readConcern: { level: "majority" },
    retryReads: true,
    retryWrites: false,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await client.connect();
    const db = client.db(databaseName);
    let report;
    if (args.mode === "apply") {
      const protectedPacket = readProtectedExecutionPacket(args["execution-packet"]);
      report = await executeProductionMigration(db, {
        packet: protectedPacket.packet,
        packetSha256: args["expected-packet-sha256"].toLowerCase(),
        actualPacketSha256: protectedPacket.sha256,
        releaseSha,
        confirmation: process.env.LK_LEGACY_COMMAND_PRODUCTION_APPLY,
        evidenceSha256: {
          backupManifestSha256: hashProtectedEvidenceFile(args["backup-manifest"]),
          restoreVerificationSha256: hashProtectedEvidenceFile(args["restore-verification"]),
          quiescenceAttestationSha256: hashProtectedEvidenceFile(args["quiescence-attestation"]),
          runtimeCompatibilitySha256: hashProtectedEvidenceFile(args["runtime-compatibility-report"]),
        },
      });
    } else {
      const context = await buildProductionMigrationContext(db);
      if (args.mode === "postcheck" && (
        context.audit.invalidRevisionCount || auditHasBlockingFindings(context.audit)
        || context.prerequisiteIndexes.missing.length || context.prerequisiteIndexes.conflicts.length
        || context.ratingIndexes.missing.length || context.ratingIndexes.conflicts.length
      )) throw new Error("Production postcheck failed");
      report = publicContext(context, args.mode);
    }
    writeReservedReport(reportReservation, report);
    reportWritten = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
  } finally {
    if (!reportWritten && reportReservation?.descriptor !== null) {
      fs.closeSync(reportReservation.descriptor);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(sanitizeProductionRunnerError(error));
    process.exitCode = 1;
  });
}

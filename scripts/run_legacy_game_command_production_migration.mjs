#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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
import {
  assertImmutableProductionSourceCustody,
  assertExactObjectKeys,
  assertProductionTrustAnchorBound,
  canonicalJson,
  parseCanonicalJson,
  PRODUCTION_MIGRATION_ID,
  readCustodianCanonicalJson,
  readProtectedCanonicalJson,
  readTrustedEd25519PublicKey,
  sha256 as approvalSha256,
  validateTrustAnchorManifest,
  verifyProductionApprovalSignature,
} from "./lib/legacy_game_command_production_approval.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const RUNNER_PATH = fileURLToPath(import.meta.url);
const INSTALLER_PATH = path.join(SCRIPT_DIR, "install_legacy_game_command_production_release.mjs");
const MIGRATION_CORE_PATH = path.join(SCRIPT_DIR, "migrate_legacy_game_command_prerequisites.mjs");
const PACKAGE_DIR = path.join(REPO_ROOT, "node-red/custom-nodes/legacy-game-command-transaction");
const WRITER_REGISTRY_PATH = path.join(SCRIPT_DIR, "legacy_game_revision_writers.json");
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, "package.json");
const DEPENDENCY_LOCK_PATH = path.join(REPO_ROOT, "package-lock.json");
const APPROVAL_VERIFIER_PATH = path.join(SCRIPT_DIR, "lib/legacy_game_command_production_approval.mjs");
const TRUST_ANCHOR_MANIFEST_PATH = path.join(SCRIPT_DIR, "legacy_game_command_production_trust_anchor.json");
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MODES = new Set(["audit", "dry-run", "postcheck", "apply", "rollback-plan"]);
const PRIMARY_MAJORITY = { readPreference: "primary", readConcern: { level: "majority" } };
const SAFE_RECEIPT_FAILURE_CODES = new Set([
  "LEGACY_GAME_COMMAND_RECEIPT_RECOVERY_REQUIRED",
  "LEGACY_GAME_COMMAND_RECEIPT_NONCE_CONFLICT",
  "LEGACY_GAME_COMMAND_RECEIPT_OUTCOME_UNKNOWN",
]);
const REQUIRE = createRequire(import.meta.url);
const MONGODB_PACKAGE_PATH = REQUIRE.resolve("mongodb/package.json");
const NODE_EXECUTABLE_PATH = path.resolve(process.execPath);
const MONGODB_PACKAGE_VERSION = JSON.parse(fs.readFileSync(MONGODB_PACKAGE_PATH, "utf8")).version;

export { PRODUCTION_MIGRATION_ID };
export const PRODUCTION_PACKET_SCHEMA_VERSION = 1;
export const PRODUCTION_APPLY_CONFIRMATION = "APPLY_LEGACY_GAME_COMMAND_PREREQUISITES_PRODUCTION_V1";
export const EXPECTED_LIVE_FLOW_SHA256 = "42cbd9a4fc3e53aacadb24601c2a430e78f36d9b79a5f5725782667a87735c42";
export const EXPECTED_CANDIDATE_FLOW_SHA256 = "ccc71f8f54881f3bfd5424a7fc1acc0008d4c3eceb16f1ec4560c281c448c03a";
// Frozen from a new `npm ci --ignore-scripts --omit=dev` install of package-lock.json.
export const EXPECTED_MONGODB_RUNTIME_CLOSURE_SHA256 = "0ca817b6104013a415c8766fa43ec5d5baaf8859ddffeba182d5a69dc609fcc7";
export const MIN_QUIESCENCE_OBSERVATION_MS = 120_000;
export const MAX_PACKET_LIFETIME_MS = 30 * 60_000;
export const MAX_BACKUP_AGE_MS = 24 * 60 * 60_000;
export const EXECUTION_COLLECTION = "lk_legacy_game_prerequisite_migration_executions";
export const PRODUCTION_RUNTIME_IDENTITY = Object.freeze({
  nodeVersion: process.version,
  mongodbDriverVersion: String(MONGODB_PACKAGE_VERSION),
});

const TRUST_ANCHOR_MANIFEST_BODY = fs.readFileSync(TRUST_ANCHOR_MANIFEST_PATH);
export const PRODUCTION_TRUST_ANCHOR_MANIFEST = validateTrustAnchorManifest(
  parseCanonicalJson(TRUST_ANCHOR_MANIFEST_BODY, "Production trust-anchor manifest"),
);
export const PRODUCTION_APPROVAL_TRUST_ANCHOR_SHA256 = PRODUCTION_TRUST_ANCHOR_MANIFEST.publicKeySpkiSha256;

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
  const text = String(value || "");
  const parsed = Date.parse(text);
  if (!RFC3339_PATTERN.test(text) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new Error(`${label} must be a canonical UTC RFC3339 timestamp`);
  }
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

function listRegularFilesRecursively(directory) {
  const root = path.resolve(directory);
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime package contains unsupported symlink ${absolutePath}`);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
      else throw new Error(`Runtime package contains unsupported entry ${absolutePath}`);
    }
  };
  visit(root);
  return files;
}

function hashFileInventory(root, filePaths) {
  const digest = crypto.createHash("sha256");
  for (const filePath of filePaths) {
    const body = fs.readFileSync(filePath);
    const relativePath = path.relative(root, filePath);
    digest.update(`${relativePath}\u0000${body.length}\u0000`);
    digest.update(body);
  }
  return digest.digest("hex");
}

export function resolveRuntimePackageClosure(entryPackageJsonPath) {
  const resolvedEntry = fs.realpathSync(path.resolve(entryPackageJsonPath));
  const nodeModulesMarker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = resolvedEntry.indexOf(nodeModulesMarker);
  if (markerIndex < 0) throw new Error("Runtime package entry must be inside node_modules");
  const allowedNodeModules = `${resolvedEntry.slice(0, markerIndex)}${path.sep}node_modules${path.sep}`;
  const assertInsideRuntimeRoot = (candidate) => {
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(allowedNodeModules)) {
      throw new Error(`Runtime package resolved outside the approved node_modules root: ${resolved}`);
    }
    return resolved;
  };
  const resolveDependencyManifest = (packageRequire, dependency) => {
    try {
      return assertInsideRuntimeRoot(packageRequire.resolve(`${dependency}/package.json`));
    } catch (error) {
      if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      let current = path.dirname(packageRequire.resolve(dependency));
      while (true) {
        const candidate = path.join(current, "package.json");
        if (fs.existsSync(candidate)) {
          const manifest = JSON.parse(fs.readFileSync(candidate, "utf8"));
          if (manifest.name === dependency) return assertInsideRuntimeRoot(candidate);
        }
        const parent = path.dirname(current);
        if (parent === current || path.basename(current) === "node_modules") break;
        current = parent;
      }
      throw new Error(`Unable to resolve runtime package manifest for ${dependency}`);
    }
  };
  const packages = [];
  const visited = new Set();
  const queue = [assertInsideRuntimeRoot(resolvedEntry)];
  while (queue.length > 0) {
    const packageJsonPath = queue.shift();
    if (visited.has(packageJsonPath)) continue;
    visited.add(packageJsonPath);
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const directory = path.dirname(packageJsonPath);
    packages.push({
      identity: `${manifest.name}@${manifest.version}`,
      directory,
      files: listRegularFilesRecursively(directory),
    });
    const packageRequire = createRequire(packageJsonPath);
    const ordinaryDependencies = {
      ...(manifest.dependencies || {}),
      ...(manifest.optionalDependencies || {}),
    };
    for (const dependency of Object.keys(ordinaryDependencies).sort()) {
      try {
        queue.push(resolveDependencyManifest(packageRequire, dependency));
      } catch (error) {
        if (!(dependency in (manifest.optionalDependencies || {}))) throw error;
      }
    }
    for (const dependency of Object.keys(manifest.peerDependencies || {}).sort()) {
      try {
        queue.push(resolveDependencyManifest(packageRequire, dependency));
      } catch (error) {
        if (manifest.peerDependenciesMeta?.[dependency]?.optional !== true) throw error;
      }
    }
  }
  return packages.sort((left, right) => left.identity.localeCompare(right.identity));
}

const mongodbRuntimePackages = () => resolveRuntimePackageClosure(MONGODB_PACKAGE_PATH);
const mongodbRuntimeFiles = () => mongodbRuntimePackages().flatMap((item) => item.files);
export const hashRuntimePackageClosure = (entryPackageJsonPath) => {
  const digest = crypto.createHash("sha256");
  for (const runtimePackage of resolveRuntimePackageClosure(entryPackageJsonPath)) {
    digest.update(`${runtimePackage.identity}\u0000`);
    digest.update(hashFileInventory(runtimePackage.directory, runtimePackage.files));
  }
  return digest.digest("hex");
};
export const assertPinnedMongoRuntimeClosure = (entryPackageJsonPath = MONGODB_PACKAGE_PATH) => {
  const actual = hashRuntimePackageClosure(entryPackageJsonPath);
  if (actual !== EXPECTED_MONGODB_RUNTIME_CLOSURE_SHA256) {
    throw new Error("MongoDB runtime closure does not match the independently pinned npm ci digest");
  }
  return actual;
};
export const writerRegistrySha256 = () => sha256(fs.readFileSync(WRITER_REGISTRY_PATH));

function productionSourceCustodyPaths() {
  const packageFiles = fs.readdirSync(PACKAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules")
    .map((entry) => path.join(PACKAGE_DIR, entry.name));
  return [
    RUNNER_PATH,
    INSTALLER_PATH,
    MIGRATION_CORE_PATH,
    WRITER_REGISTRY_PATH,
    ROOT_PACKAGE_PATH,
    DEPENDENCY_LOCK_PATH,
    NODE_EXECUTABLE_PATH,
    ...mongodbRuntimeFiles(),
    APPROVAL_VERIFIER_PATH,
    TRUST_ANCHOR_MANIFEST_PATH,
    ...packageFiles,
  ];
}

export function buildProductionStaticSourceIdentity({
  releaseAttestationSha256 = "UNBOUND",
  sourceRoot = REPO_ROOT,
} = {}) {
  const root = fs.realpathSync(sourceRoot);
  const sourceScriptDirectory = path.join(root, "scripts");
  const sourceRunnerPath = path.join(sourceScriptDirectory, "run_legacy_game_command_production_migration.mjs");
  const sourcePackageDirectory = path.join(root, "node-red/custom-nodes/legacy-game-command-transaction");
  const sourceRequire = createRequire(path.join(root, "package.json"));
  const sourceMongoPackagePath = sourceRequire.resolve("mongodb/package.json");
  return {
    liveFlowSha256: EXPECTED_LIVE_FLOW_SHA256,
    candidateFlowSha256: EXPECTED_CANDIDATE_FLOW_SHA256,
    packageSha256: hashPrivatePackage(sourcePackageDirectory),
    writerRegistrySha256: sha256(fs.readFileSync(path.join(sourceScriptDirectory, "legacy_game_revision_writers.json"))),
    installerSha256: sha256(fs.readFileSync(path.join(sourceScriptDirectory, "install_legacy_game_command_production_release.mjs"))),
    runnerSha256: sha256(fs.readFileSync(sourceRunnerPath)),
    migrationCoreSha256: sha256(fs.readFileSync(path.join(sourceScriptDirectory, "migrate_legacy_game_command_prerequisites.mjs"))),
    approvalVerifierSha256: sha256(fs.readFileSync(path.join(sourceScriptDirectory, "lib/legacy_game_command_production_approval.mjs"))),
    trustAnchorManifestSha256: sha256(fs.readFileSync(path.join(sourceScriptDirectory, "legacy_game_command_production_trust_anchor.json"))),
    rootPackageSha256: sha256(fs.readFileSync(path.join(root, "package.json"))),
    dependencyLockSha256: sha256(fs.readFileSync(path.join(root, "package-lock.json"))),
    nodeExecutableSha256: sha256(fs.readFileSync(NODE_EXECUTABLE_PATH)),
    mongodbRuntimeClosureSha256: assertPinnedMongoRuntimeClosure(sourceMongoPackagePath),
    releaseAttestationSha256,
  };
}

const RELEASE_ATTESTATION_SOURCE_KEYS = [
  "liveFlowSha256", "candidateFlowSha256", "packageSha256", "writerRegistrySha256",
  "installerSha256", "runnerSha256", "migrationCoreSha256", "approvalVerifierSha256", "trustAnchorManifestSha256",
  "rootPackageSha256", "dependencyLockSha256",
  "nodeExecutableSha256", "mongodbRuntimeClosureSha256",
];

export function validateProductionReleaseAttestation(packet, attestation, {
  attestationSha256,
  actualSource,
  environment = "production",
  now = new Date(),
} = {}) {
  assertExactObjectKeys(attestation, [
    "schemaVersion", "migrationId", "environment", "deploymentId", "repositoryCommit",
    "source", "activatedAt", "status",
  ], "Production release attestation");
  assertExactObjectKeys(attestation.source, RELEASE_ATTESTATION_SOURCE_KEYS, "Production release attestation source");
  assertHash(attestationSha256, "Production release attestation digest");
  if (attestation.schemaVersion !== 1 || attestation.migrationId !== PRODUCTION_MIGRATION_ID
    || attestation.environment !== environment || attestation.status !== "ACTIVE"
    || !UUID_PATTERN.test(String(attestation.deploymentId || ""))
    || !COMMIT_PATTERN.test(String(attestation.repositoryCommit || ""))
    || attestation.repositoryCommit !== packet.source.repositoryCommit
    || attestationSha256 !== packet.source.releaseAttestationSha256) {
    throw new Error("Production release attestation identity mismatch");
  }
  const activatedAt = asTimestamp(attestation.activatedAt, "releaseAttestation.activatedAt");
  if (activatedAt > now.getTime()
    || (packet.plan && activatedAt > asTimestamp(packet.plan.generatedAt, "plan.generatedAt"))) {
    throw new Error("Production release attestation activation is in the future");
  }
  for (const key of RELEASE_ATTESTATION_SOURCE_KEYS) {
    assertHash(attestation.source[key], `release attestation ${key}`);
    if (attestation.source[key] !== packet.source[key] || attestation.source[key] !== actualSource?.[key]) {
      throw new Error(`Production release attestation ${key} mismatch`);
    }
  }
  if (actualSource?.releaseAttestationSha256 !== attestationSha256) {
    throw new Error("Production local source release attestation digest mismatch");
  }
  return true;
}

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

export async function buildProductionMigrationContext(db, {
  now = new Date(),
  releaseAttestationSha256 = "UNBOUND",
} = {}) {
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
  const planMaterial = {
    schemaVersion: PRODUCTION_PACKET_SCHEMA_VERSION,
    migrationId: PRODUCTION_MIGRATION_ID,
    target,
    stateDigest: state.stateDigest,
    audit,
    prerequisiteIndexes: publicPrerequisiteIndexes,
    ratingIndexes: publicRatingIndexes,
    source: buildProductionStaticSourceIdentity({ releaseAttestationSha256 }),
  };
  return {
    generatedAt: now.toISOString(),
    ...planMaterial,
    planDigest: sha256(stableStringify(planMaterial)),
    collectionCounts: state.collectionCounts,
    readyForExecutionPacket: HASH_PATTERN.test(releaseAttestationSha256)
      && !auditHasBlockingFindings(audit)
      && prerequisiteIndexes.conflicts.length === 0
      && ratingIndexes.missing.length === 0
      && ratingIndexes.conflicts.length === 0,
  };
}

function validateProductionExecutionPacketSchema(packet) {
  assertExactObjectKeys(packet, [
    "schemaVersion", "migrationId", "environment", "target", "source", "plan",
    "backup", "quiescence", "runtime", "authorization", "execution",
  ], "Execution packet");
  assertExactObjectKeys(packet.target, ["databaseName", "fingerprint"], "Execution packet target");
  assertExactObjectKeys(packet.source, [
    "repositoryCommit", "liveFlowSha256", "candidateFlowSha256", "packageSha256",
    "writerRegistrySha256", "installerSha256", "runnerSha256", "migrationCoreSha256",
    "approvalVerifierSha256", "trustAnchorManifestSha256", "rootPackageSha256",
    "dependencyLockSha256", "nodeExecutableSha256", "mongodbRuntimeClosureSha256",
    "releaseAttestationSha256",
  ], "Execution packet source");
  assertExactObjectKeys(packet.plan, ["digest", "stateDigest", "generatedAt"], "Execution packet plan");
  assertExactObjectKeys(packet.backup, [
    "manifestSha256", "snapshotIdentitySha256", "restoreVerificationSha256", "completedAt", "restoreVerifiedAt",
  ], "Execution packet backup");
  assertExactObjectKeys(packet.quiescence, [
    "attestationSha256", "writerCount", "writerRegistrySha256", "writersStoppedAt",
    "observedFrom", "observedTo", "expiresAt",
  ], "Execution packet quiescence");
  assertExactObjectKeys(packet.runtime, [
    "compatibilityReportSha256", "nodeVersion", "mongodbDriverVersion", "verifiedAt",
  ], "Execution packet runtime");
  assertExactObjectKeys(packet.authorization, ["approvedAt", "expiresAt"], "Execution packet authorization");
  assertExactObjectKeys(packet.execution, ["nonce"], "Execution packet execution");
}

export function validateProductionExecutionPacketStatic(packet, {
  environment = "production",
  releaseSha,
} = {}) {
  validateProductionExecutionPacketSchema(packet);
  if (packet.schemaVersion !== PRODUCTION_PACKET_SCHEMA_VERSION || packet.migrationId !== PRODUCTION_MIGRATION_ID) {
    throw new Error("Execution packet schema or migration identity mismatch");
  }
  if (packet.environment !== environment) throw new Error("Execution packet environment mismatch");
  if (!COMMIT_PATTERN.test(String(packet.source.repositoryCommit || ""))
    || (releaseSha !== undefined && packet.source.repositoryCommit !== releaseSha)) {
    throw new Error("Execution packet release commit mismatch");
  }
  if (typeof packet.target.databaseName !== "string" || !packet.target.databaseName.trim()
    || packet.target.databaseName !== packet.target.databaseName.trim()) {
    throw new Error("Execution packet database name is invalid");
  }
  const hashes = [
    packet.target.fingerprint,
    packet.source.liveFlowSha256,
    packet.source.candidateFlowSha256,
    packet.source.packageSha256,
    packet.source.writerRegistrySha256,
    packet.source.installerSha256,
    packet.source.runnerSha256,
    packet.source.migrationCoreSha256,
    packet.source.approvalVerifierSha256,
    packet.source.trustAnchorManifestSha256,
    packet.source.rootPackageSha256,
    packet.source.dependencyLockSha256,
    packet.source.nodeExecutableSha256,
    packet.source.mongodbRuntimeClosureSha256,
    packet.source.releaseAttestationSha256,
    packet.plan.digest,
    packet.plan.stateDigest,
    packet.backup.manifestSha256,
    packet.backup.snapshotIdentitySha256,
    packet.backup.restoreVerificationSha256,
    packet.quiescence.attestationSha256,
    packet.quiescence.writerRegistrySha256,
    packet.runtime.compatibilityReportSha256,
  ];
  hashes.forEach((hash, index) => assertHash(hash, `Execution packet static digest ${index + 1}`));
  for (const [timestamp, label] of [
    [packet.plan.generatedAt, "plan.generatedAt"],
    [packet.backup.completedAt, "backup.completedAt"],
    [packet.backup.restoreVerifiedAt, "backup.restoreVerifiedAt"],
    [packet.quiescence.writersStoppedAt, "quiescence.writersStoppedAt"],
    [packet.quiescence.observedFrom, "quiescence.observedFrom"],
    [packet.quiescence.observedTo, "quiescence.observedTo"],
    [packet.quiescence.expiresAt, "quiescence.expiresAt"],
    [packet.runtime.verifiedAt, "runtime.verifiedAt"],
    [packet.authorization.approvedAt, "authorization.approvedAt"],
    [packet.authorization.expiresAt, "authorization.expiresAt"],
  ]) asTimestamp(timestamp, label);
  if (packet.quiescence.writerCount !== 7
    || typeof packet.runtime.nodeVersion !== "string" || !packet.runtime.nodeVersion.trim()
    || typeof packet.runtime.mongodbDriverVersion !== "string" || !packet.runtime.mongodbDriverVersion.trim()
    || !UUID_PATTERN.test(String(packet.execution.nonce || ""))) {
    throw new Error("Execution packet static runtime, writer, or nonce contract mismatch");
  }
  return true;
}

function assertEvidenceIdentity(document, packet, environment, label) {
  if (document.schemaVersion !== 1 || document.migrationId !== PRODUCTION_MIGRATION_ID
    || document.environment !== environment || document.targetFingerprint !== packet.target.fingerprint
    || document.repositoryCommit !== packet.source.repositoryCommit) {
    throw new Error(`${label} identity mismatch`);
  }
}

export function validateProductionEvidenceDocuments(packet, documents, { environment = "production" } = {}) {
  const backup = documents?.backupManifest;
  assertExactObjectKeys(backup, [
    "schemaVersion", "migrationId", "environment", "targetFingerprint", "repositoryCommit",
    "snapshotIdentitySha256", "stateDigestSha256", "artifactSetSha256", "backupToolName", "backupToolVersion",
    "startedAt", "completedAt", "status",
  ], "Backup manifest");
  assertEvidenceIdentity(backup, packet, environment, "Backup manifest");
  assertHash(backup.artifactSetSha256, "backup artifactSetSha256");
  const backupStartedAt = asTimestamp(backup.startedAt, "backup.startedAt");
  const backupCompletedAt = asTimestamp(backup.completedAt, "backup.completedAt");
  if (backup.snapshotIdentitySha256 !== packet.backup.snapshotIdentitySha256
    || backup.stateDigestSha256 !== packet.plan.stateDigest
    || backup.completedAt !== packet.backup.completedAt || backup.status !== "COMPLETED"
    || typeof backup.backupToolName !== "string" || !backup.backupToolName.trim()
    || typeof backup.backupToolVersion !== "string" || !backup.backupToolVersion.trim()
    || backupStartedAt < asTimestamp(packet.quiescence.writersStoppedAt, "quiescence.writersStoppedAt")
    || backupStartedAt > backupCompletedAt) {
    throw new Error("Backup manifest content mismatch");
  }

  const restore = documents?.restoreVerification;
  assertExactObjectKeys(restore, [
    "schemaVersion", "migrationId", "environment", "targetFingerprint", "repositoryCommit",
    "backupManifestSha256", "snapshotIdentitySha256", "restoredStateDigestSha256", "verifiedAt", "status",
  ], "Restore verification");
  assertEvidenceIdentity(restore, packet, environment, "Restore verification");
  assertHash(restore.restoredStateDigestSha256, "restore restoredStateDigestSha256");
  if (restore.backupManifestSha256 !== packet.backup.manifestSha256
    || restore.snapshotIdentitySha256 !== packet.backup.snapshotIdentitySha256
    || restore.restoredStateDigestSha256 !== packet.plan.stateDigest
    || restore.verifiedAt !== packet.backup.restoreVerifiedAt || restore.status !== "VERIFIED") {
    throw new Error("Restore verification content mismatch");
  }

  const quiescence = documents?.quiescenceAttestation;
  assertExactObjectKeys(quiescence, [
    "schemaVersion", "migrationId", "environment", "targetFingerprint", "repositoryCommit",
    "writerRegistrySha256", "writerCount", "writersStoppedAt", "observedFrom", "observedTo",
    "expiresAt", "writeCountBefore", "writeCountAfter", "status",
  ], "Quiescence attestation");
  assertEvidenceIdentity(quiescence, packet, environment, "Quiescence attestation");
  const counterPattern = /^(0|[1-9][0-9]*)$/;
  if (quiescence.writerRegistrySha256 !== packet.quiescence.writerRegistrySha256
    || quiescence.writerCount !== packet.quiescence.writerCount
    || quiescence.writersStoppedAt !== packet.quiescence.writersStoppedAt
    || quiescence.observedFrom !== packet.quiescence.observedFrom
    || quiescence.observedTo !== packet.quiescence.observedTo
    || quiescence.expiresAt !== packet.quiescence.expiresAt
    || !counterPattern.test(String(quiescence.writeCountBefore || ""))
    || quiescence.writeCountAfter !== quiescence.writeCountBefore
    || quiescence.status !== "QUIESCENT") {
    throw new Error("Quiescence attestation content mismatch");
  }

  const runtime = documents?.runtimeCompatibility;
  assertExactObjectKeys(runtime, [
    "schemaVersion", "migrationId", "environment", "targetFingerprint", "repositoryCommit",
    "liveFlowSha256", "candidateFlowSha256", "packageSha256", "writerRegistrySha256",
    "installerSha256", "runnerSha256", "migrationCoreSha256", "approvalVerifierSha256", "trustAnchorManifestSha256",
    "rootPackageSha256", "dependencyLockSha256", "nodeExecutableSha256", "mongodbRuntimeClosureSha256",
    "releaseAttestationSha256", "nodeVersion", "mongodbDriverVersion", "verifiedAt", "status",
  ], "Runtime compatibility report");
  assertEvidenceIdentity(runtime, packet, environment, "Runtime compatibility report");
  const runtimePairs = [
    [runtime.liveFlowSha256, packet.source.liveFlowSha256],
    [runtime.candidateFlowSha256, packet.source.candidateFlowSha256],
    [runtime.packageSha256, packet.source.packageSha256],
    [runtime.writerRegistrySha256, packet.source.writerRegistrySha256],
    [runtime.installerSha256, packet.source.installerSha256],
    [runtime.runnerSha256, packet.source.runnerSha256],
    [runtime.migrationCoreSha256, packet.source.migrationCoreSha256],
    [runtime.approvalVerifierSha256, packet.source.approvalVerifierSha256],
    [runtime.trustAnchorManifestSha256, packet.source.trustAnchorManifestSha256],
    [runtime.rootPackageSha256, packet.source.rootPackageSha256],
    [runtime.dependencyLockSha256, packet.source.dependencyLockSha256],
    [runtime.nodeExecutableSha256, packet.source.nodeExecutableSha256],
    [runtime.mongodbRuntimeClosureSha256, packet.source.mongodbRuntimeClosureSha256],
    [runtime.releaseAttestationSha256, packet.source.releaseAttestationSha256],
    [runtime.nodeVersion, packet.runtime.nodeVersion],
    [runtime.mongodbDriverVersion, packet.runtime.mongodbDriverVersion],
    [runtime.verifiedAt, packet.runtime.verifiedAt],
  ];
  if (runtime.status !== "COMPATIBLE" || runtimePairs.some(([actual, expected]) => actual !== expected)) {
    throw new Error("Runtime compatibility report content mismatch");
  }
  return true;
}

export function validateProductionEvidenceDigests(packet, evidenceSha256) {
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
  return true;
}

export function digestProductionEvidenceDocuments(documents) {
  return {
    backupManifestSha256: approvalSha256(Buffer.from(canonicalJson(documents.backupManifest))),
    restoreVerificationSha256: approvalSha256(Buffer.from(canonicalJson(documents.restoreVerification))),
    quiescenceAttestationSha256: approvalSha256(Buffer.from(canonicalJson(documents.quiescenceAttestation))),
    runtimeCompatibilitySha256: approvalSha256(Buffer.from(canonicalJson(documents.runtimeCompatibility))),
  };
}

export function validateProductionExecutionPacketTemporal(packet, { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const approvedAt = asTimestamp(packet.authorization?.approvedAt, "authorization.approvedAt");
  const expiresAt = asTimestamp(packet.authorization?.expiresAt, "authorization.expiresAt");
  const planGeneratedAt = asTimestamp(packet.plan?.generatedAt, "plan.generatedAt");
  if (approvedAt > nowMs || expiresAt <= nowMs || expiresAt - approvedAt > MAX_PACKET_LIFETIME_MS) {
    throw new Error("Execution packet authorization window is invalid or expired");
  }
  if (planGeneratedAt > approvedAt) throw new Error("Execution packet plan was generated after approval");

  const backupCompletedAt = asTimestamp(packet.backup?.completedAt, "backup.completedAt");
  const restoreVerifiedAt = asTimestamp(packet.backup?.restoreVerifiedAt, "backup.restoreVerifiedAt");
  if (restoreVerifiedAt < backupCompletedAt || approvedAt - backupCompletedAt > MAX_BACKUP_AGE_MS) {
    throw new Error("Backup or restore verification evidence is stale or out of order");
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

  const runtimeVerifiedAt = asTimestamp(packet.runtime?.verifiedAt, "runtime.verifiedAt");
  if (runtimeVerifiedAt < stoppedAt || runtimeVerifiedAt > approvedAt) {
    throw new Error("Runtime compatibility evidence is outside the approval window");
  }
  return { deadlineMs: Math.min(expiresAt, quiescenceExpiresAt) };
}

export function validateProductionRuntimeIdentity(packet, actualRuntime = PRODUCTION_RUNTIME_IDENTITY) {
  if (packet.runtime?.nodeVersion !== actualRuntime.nodeVersion
    || packet.runtime?.mongodbDriverVersion !== actualRuntime.mongodbDriverVersion) {
    throw new Error("Execution runtime identity differs from the approved runtime");
  }
  return true;
}

export function validateProductionExecutionPacket(packet, context, {
  packetSha256,
  actualPacketSha256,
  releaseSha,
  now = new Date(),
  environment = "production",
  evidenceSha256,
} = {}) {
  if (!COMMIT_PATTERN.test(String(releaseSha || ""))) throw new Error("Execution release commit is required");
  validateProductionExecutionPacketStatic(packet, { environment, releaseSha });
  validateProductionRuntimeIdentity(packet);
  assertHash(packetSha256, "Expected packet digest");
  if (packetSha256 !== actualPacketSha256) throw new Error("Execution packet digest mismatch");
  const exactHashes = [
    [packet.source?.liveFlowSha256, EXPECTED_LIVE_FLOW_SHA256, "live flow"],
    [packet.source?.candidateFlowSha256, EXPECTED_CANDIDATE_FLOW_SHA256, "candidate flow"],
    [packet.source?.packageSha256, context.source.packageSha256, "custom node package"],
    [packet.source?.writerRegistrySha256, context.source.writerRegistrySha256, "writer registry"],
    [packet.source?.installerSha256, context.source.installerSha256, "release installer"],
    [packet.source?.runnerSha256, context.source.runnerSha256, "production runner"],
    [packet.source?.migrationCoreSha256, context.source.migrationCoreSha256, "migration core"],
    [packet.source?.approvalVerifierSha256, context.source.approvalVerifierSha256, "approval verifier"],
    [packet.source?.trustAnchorManifestSha256, context.source.trustAnchorManifestSha256, "trust anchor manifest"],
    [packet.source?.rootPackageSha256, context.source.rootPackageSha256, "root package"],
    [packet.source?.dependencyLockSha256, context.source.dependencyLockSha256, "dependency lock"],
    [packet.source?.nodeExecutableSha256, context.source.nodeExecutableSha256, "Node executable"],
    [packet.source?.mongodbRuntimeClosureSha256, context.source.mongodbRuntimeClosureSha256, "MongoDB runtime closure"],
    [packet.source?.releaseAttestationSha256, context.source.releaseAttestationSha256, "release attestation"],
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
  if (packet.plan?.stateDigest !== context.stateDigest) throw new Error("Execution packet state digest is stale");
  if (!context.readyForExecutionPacket) throw new Error("Fresh production audit is not ready for apply");

  if (packet.quiescence?.writerCount !== 7
    || packet.quiescence?.writerRegistrySha256 !== context.source.writerRegistrySha256) {
    throw new Error("Quiescence writer inventory mismatch");
  }
  const temporal = validateProductionExecutionPacketTemporal(packet, { now });
  validateProductionEvidenceDigests(packet, evidenceSha256);
  return temporal;
}

function optionsEvidence(options) {
  return options?.evidenceSha256 && typeof options.evidenceSha256 === "object"
    ? options.evidenceSha256
    : {};
}

function assertProductionApprovalTrustAnchorBound() {
  return assertProductionTrustAnchorBound(PRODUCTION_TRUST_ANCHOR_MANIFEST);
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

const RECEIPT_IDENTITY_KEYS = [
  "_id", "migrationId", "packetSha256", "planDigest", "targetFingerprint",
  "repositoryCommit", "approvalKeyId", "approvalKeyFingerprintSha256",
];

export function executionReceiptIdentityMatches(actual, expected) {
  return Boolean(actual) && RECEIPT_IDENTITY_KEYS.every((key) => actual[key] === expected[key]);
}

export async function classifyAmbiguousExecutionReceipt(executions, expected, { maxTimeMS = 10_000 } = {}) {
  try {
    const actual = await executions.findOne(
      { _id: expected._id },
      { ...PRIMARY_MAJORITY, maxTimeMS },
    );
    if (!actual) return "UNKNOWN_ABSENT";
    return executionReceiptIdentityMatches(actual, expected) ? "RECOVERY_REQUIRED" : "CONFLICT";
  } catch {
    return "UNKNOWN_UNREADABLE";
  }
}

async function stopAfterAmbiguousReceipt(executions, receipt, maxTimeMS) {
  const classification = await classifyAmbiguousExecutionReceipt(executions, receipt, { maxTimeMS });
  if (classification === "RECOVERY_REQUIRED") {
    throw new ProductionReceiptError("LEGACY_GAME_COMMAND_RECEIPT_RECOVERY_REQUIRED");
  }
  if (classification === "CONFLICT") {
    throw new ProductionReceiptError("LEGACY_GAME_COMMAND_RECEIPT_NONCE_CONFLICT");
  }
  throw new ProductionReceiptError("LEGACY_GAME_COMMAND_RECEIPT_OUTCOME_UNKNOWN");
}

class ProductionReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProductionReceiptError";
    this.code = code;
  }
}

async function executeProductionMigration(db, options) {
  const trustAnchor = assertProductionApprovalTrustAnchorBound();
  if (options.confirmation !== PRODUCTION_APPLY_CONFIRMATION) throw new Error("Production apply confirmation is absent");
  const packetBody = Buffer.isBuffer(options.packetBody) ? options.packetBody : Buffer.from([]);
  const parsedPacket = parseCanonicalJson(packetBody, "Execution packet");
  if (!isDeepStrictEqual(parsedPacket, options.packet)) throw new Error("Execution packet body mismatch");
  const approval = verifyProductionApprovalSignature({
    packetBody,
    envelope: options.approvalSignature,
    publicKeyBody: options.approvalPublicKeyBody,
    trustAnchor,
  });
  if (approval.packetSha256 !== options.packetSha256) throw new Error("Approval packet digest mismatch");
  validateProductionEvidenceDocuments(options.packet, options.evidenceDocuments, {
    environment: options.environment || "production",
  });
  const recomputedEvidenceSha256 = digestProductionEvidenceDocuments(options.evidenceDocuments);
  validateProductionEvidenceDigests(options.packet, recomputedEvidenceSha256);
  const context = await buildProductionMigrationContext(db, {
    now: options.now,
    releaseAttestationSha256: options.releaseAttestationSha256,
  });
  const { deadlineMs } = validateProductionExecutionPacket(options.packet, context, {
    ...options,
    evidenceSha256: recomputedEvidenceSha256,
  });
  const executions = db.collection(EXECUTION_COLLECTION);
  const receipt = {
    _id: options.packet.execution.nonce,
    migrationId: PRODUCTION_MIGRATION_ID,
    packetSha256: options.packetSha256,
    planDigest: context.planDigest,
    targetFingerprint: context.target.targetFingerprint,
    repositoryCommit: options.releaseSha,
    approvalKeyId: approval.keyId,
    approvalKeyFingerprintSha256: approval.keyFingerprintSha256,
    status: "APPLYING",
    startedAt: (options.now || new Date()).toISOString(),
  };
  let receiptResult;
  try {
    receiptResult = await executions.insertOne(receipt, {
      writeConcern: { w: "majority" },
      maxTimeMS: remainingDeadlineMs(deadlineMs, options.nowProvider),
    });
  } catch {
    await stopAfterAmbiguousReceipt(
      executions,
      receipt,
      10_000,
    );
  }
  if (!receiptResult?.acknowledged) {
    await stopAfterAmbiguousReceipt(
      executions,
      receipt,
      10_000,
    );
  }
  try {
    const migration = await applyProductionPrerequisiteMutations(db, { deadlineMs, nowProvider: options.nowProvider });
    remainingDeadlineMs(deadlineMs, options.nowProvider);
    const postcheck = await buildProductionMigrationContext(db, {
      now: options.now,
      releaseAttestationSha256: options.releaseAttestationSha256,
    });
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
      approvalKeyId: approval.keyId,
      approvalKeyFingerprintSha256: approval.keyFingerprintSha256,
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

export function readProtectedExecutionPacket(packetPath) {
  const loaded = readProtectedCanonicalJson(packetPath, 65_536, "Execution packet");
  return { body: loaded.body, packet: loaded.value, sha256: loaded.sha256 };
}

export function hashProtectedEvidenceFile(evidencePath) {
  return readProtectedCanonicalJson(evidencePath, 16 * 1024 * 1024, "Evidence artifact").sha256;
}

function readProtectedEvidenceDocument(evidencePath, label) {
  const loaded = readProtectedCanonicalJson(evidencePath, 16 * 1024 * 1024, label);
  return { body: loaded.body, document: loaded.value, sha256: loaded.sha256 };
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
    stateDigest: context.stateDigest,
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
  if (SAFE_RECEIPT_FAILURE_CODES.has(error?.code)) return error.code;
  return "LEGACY_GAME_COMMAND_PRODUCTION_MIGRATION_FAILED";
}

async function main(argv) {
  const args = parseArgs(argv);
  let applyInputs = null;
  let releaseInputs = null;
  if (args.mode === "apply") {
    if (!args["execution-packet"] || !args["expected-packet-sha256"]) {
      throw new Error("Apply requires --execution-packet and --expected-packet-sha256");
    }
    for (const name of [
      "release-attestation", "approval-public-key", "approval-signature", "backup-manifest", "restore-verification",
      "quiescence-attestation", "runtime-compatibility-report",
    ]) {
      if (!args[name]) throw new Error(`Apply requires --${name}`);
    }
    const trustAnchor = assertProductionApprovalTrustAnchorBound();
    assertImmutableProductionSourceCustody(productionSourceCustodyPaths());
    const packet = readProtectedExecutionPacket(args["execution-packet"]);
    validateProductionExecutionPacketStatic(packet.packet);
    validateProductionRuntimeIdentity(packet.packet);
    validateProductionExecutionPacketTemporal(packet.packet);
    const releaseAttestation = readCustodianCanonicalJson(
      args["release-attestation"],
      65_536,
      "Production release attestation",
    );
    const actualSource = buildProductionStaticSourceIdentity({
      releaseAttestationSha256: releaseAttestation.sha256,
    });
    validateProductionReleaseAttestation(packet.packet, releaseAttestation.value, {
      attestationSha256: releaseAttestation.sha256,
      actualSource,
    });
    const signature = readProtectedCanonicalJson(args["approval-signature"], 16_384, "Approval signature");
    const publicKey = readTrustedEd25519PublicKey(args["approval-public-key"]);
    const backupManifest = readProtectedEvidenceDocument(args["backup-manifest"], "Backup manifest");
    const restoreVerification = readProtectedEvidenceDocument(args["restore-verification"], "Restore verification");
    const quiescenceAttestation = readProtectedEvidenceDocument(args["quiescence-attestation"], "Quiescence attestation");
    const runtimeCompatibility = readProtectedEvidenceDocument(args["runtime-compatibility-report"], "Runtime compatibility report");
    const expectedPacketSha256 = String(args["expected-packet-sha256"] || "").toLowerCase();
    assertHash(expectedPacketSha256, "Expected packet digest");
    if (expectedPacketSha256 !== packet.sha256) throw new Error("Execution packet digest mismatch");
    verifyProductionApprovalSignature({
      packetBody: packet.body,
      envelope: signature.value,
      publicKeyBody: publicKey.body,
      trustAnchor,
    });
    const evidenceDocuments = {
      backupManifest: backupManifest.document,
      restoreVerification: restoreVerification.document,
      quiescenceAttestation: quiescenceAttestation.document,
      runtimeCompatibility: runtimeCompatibility.document,
    };
    validateProductionEvidenceDocuments(packet.packet, evidenceDocuments);
    const evidenceSha256 = {
      backupManifestSha256: backupManifest.sha256,
      restoreVerificationSha256: restoreVerification.sha256,
      quiescenceAttestationSha256: quiescenceAttestation.sha256,
      runtimeCompatibilitySha256: runtimeCompatibility.sha256,
    };
    validateProductionEvidenceDigests(packet.packet, evidenceSha256);
    applyInputs = {
      packet,
      releaseAttestation,
      approvalSignature: signature.value,
      approvalPublicKeyBody: publicKey.body,
      evidenceDocuments,
      evidenceSha256,
    };
    releaseInputs = { releaseAttestation, actualSource };
  } else if (args["release-attestation"]) {
    assertImmutableProductionSourceCustody(productionSourceCustodyPaths());
    const releaseAttestation = readCustodianCanonicalJson(
      args["release-attestation"],
      65_536,
      "Production release attestation",
    );
    const actualSource = buildProductionStaticSourceIdentity({
      releaseAttestationSha256: releaseAttestation.sha256,
    });
    validateProductionReleaseAttestation({
      source: {
        repositoryCommit: releaseAttestation.value.repositoryCommit,
        ...releaseAttestation.value.source,
        releaseAttestationSha256: releaseAttestation.sha256,
      },
    }, releaseAttestation.value, {
      attestationSha256: releaseAttestation.sha256,
      actualSource,
    });
    releaseInputs = { releaseAttestation, actualSource };
  }
  const inputPaths = [
    args["release-attestation"],
    ...(args.mode === "apply" ? [
      args["execution-packet"],
      args["approval-public-key"],
      args["approval-signature"],
      args["backup-manifest"],
      args["restore-verification"],
      args["quiescence-attestation"],
      args["runtime-compatibility-report"],
    ] : []),
  ];
  const reportReservation = reservePrivateReport(args.out, inputPaths);
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
  const releaseShaEnv = String(process.env.LK_LEGACY_COMMAND_RELEASE_SHA || "").trim().toLowerCase();
  const releaseSha = releaseInputs ? releaseInputs.releaseAttestation.value.repositoryCommit : releaseShaEnv;
  if (!mongoUri || !databaseName) throw new Error("Mongo connection env and database are required");
  if (!COMMIT_PATTERN.test(releaseSha)) throw new Error("LK_LEGACY_COMMAND_RELEASE_SHA is required");
  if (releaseInputs && releaseShaEnv && releaseShaEnv !== releaseSha) {
    throw new Error("Release environment and custodian attestation mismatch");
  }
  if (applyInputs && applyInputs.packet.packet.source?.repositoryCommit !== releaseSha) {
    throw new Error("Execution packet release commit mismatch");
  }
  if (applyInputs && process.env.LK_LEGACY_COMMAND_PRODUCTION_APPLY !== PRODUCTION_APPLY_CONFIRMATION) {
    throw new Error("Production apply confirmation is absent");
  }
  if (applyInputs) validateProductionExecutionPacketTemporal(applyInputs.packet.packet);
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
      report = await executeProductionMigration(db, {
        packet: applyInputs.packet.packet,
        packetBody: applyInputs.packet.body,
        packetSha256: applyInputs.packet.sha256,
        actualPacketSha256: applyInputs.packet.sha256,
        releaseSha,
        confirmation: process.env.LK_LEGACY_COMMAND_PRODUCTION_APPLY,
        approvalSignature: applyInputs.approvalSignature,
        approvalPublicKeyBody: applyInputs.approvalPublicKeyBody,
        evidenceDocuments: applyInputs.evidenceDocuments,
        evidenceSha256: applyInputs.evidenceSha256,
        releaseAttestationSha256: applyInputs.releaseAttestation.sha256,
      });
    } else {
      const context = await buildProductionMigrationContext(db, {
        releaseAttestationSha256: releaseInputs?.releaseAttestation.sha256,
      });
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
  } catch (error) {
    const failureCode = sanitizeProductionRunnerError(error);
    if (SAFE_RECEIPT_FAILURE_CODES.has(failureCode) && reportReservation?.descriptor !== null) {
      writeReservedReport(reportReservation, {
        schemaVersion: 1,
        migrationId: PRODUCTION_MIGRATION_ID,
        mode: args.mode,
        status: "STOPPED",
        failureCode,
        prerequisiteMutationsStarted: false,
        receiptStateRequiresOperatorReadback: true,
      });
      reportWritten = true;
    }
    throw error;
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

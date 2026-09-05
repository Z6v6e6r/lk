#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BSON, ObjectId } from "mongodb";

import {
  buildVivaGameProjectionCutoverPlan,
  canonicalJson,
  inventoryLkGamesWriters,
  sha256,
} from "./lib/vivaGameProjectionCutoverContract.mjs";
import {
  hashCanonicalEjson,
  validateExecutableTenantMigrationPlan,
} from "./lib/vivaGameProjectionTenantMigrationExecution.mjs";
import {
  buildExactGraphContract,
  syncDirectory,
  validateExactGraphContract,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildVivaGameProjectionSyncCandidate } from "./prepare_viva_game_projection_sync_candidate.mjs";
import { buildLegacyTenantMigrationPlan } from "./lib/vivaGameProjectionTenantMigration.mjs";
import {
  requireFreshProjection,
  validateCaptureReceipt,
  validateProjectedInputs,
} from "./prepare_viva_game_projection_tenant_migration.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const COMMIT_RE = /^[a-f0-9]{40}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const EXECUTOR_SOURCE_PATHS = [
  "scripts/prepare_viva_game_projection_cutover_packet.mjs",
  "scripts/prepare_viva_game_projection_tenant_migration.mjs",
  "scripts/prepare_viva_game_projection_restore_rehearsal.mjs",
  "scripts/run_viva_game_projection_cutover.sh",
  "scripts/run_viva_game_projection_cutover_coordinator.mjs",
  "scripts/finalize_viva_game_projection_cutover_ready.mjs",
  "scripts/run_viva_game_projection_fence_guardian.mjs",
  "scripts/run_viva_game_projection_recovery_fence_takeover.mjs",
  "scripts/prepare_viva_game_projection_cutover_postcheck.mjs",
  "scripts/recover_viva_game_projection_mongo_write_barrier.mjs",
  "scripts/run_viva_game_projection_tenant_migration.mjs",
  "scripts/lib/vivaGameProjectionMongoWriteBarrier.mjs",
  "scripts/lib/vivaGameProjectionTenantMigration.mjs",
  "scripts/lib/vivaGameProjectionTenantMigrationExecution.mjs",
  "scripts/lib/vivaGameProjectionCutoverContract.mjs",
  "scripts/lib/vivaGameProjectionCutoverPacketValidation.mjs",
  "scripts/lib/vivaGameProjectionExecutorSource.mjs",
  "scripts/lib/vivaGameProjectionFenceGuardian.mjs",
  "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs",
];

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function repositoryIdentity() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd: REPO_ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const identity = { commit: commit.stdout.trim(), branch: branch.stdout.trim() };
  if (commit.status !== 0 || branch.status !== 0 || status.status !== 0
    || !COMMIT_RE.test(identity.commit) || !identity.branch || status.stdout.trim()) {
    fail("Cutover packet requires a clean exact task-branch commit");
  }
  return identity;
}

function executorSourceManifest(repositoryCommit) {
  return EXECUTOR_SOURCE_PATHS.map((relativePath) => {
    const absolutePath = path.join(REPO_ROOT, relativePath);
    const bytes = fs.readFileSync(absolutePath);
    const committed = spawnSync("git", ["show", `${repositoryCommit}:${relativePath}`], {
      cwd: REPO_ROOT, encoding: null, maxBuffer: 32 * 1024 * 1024,
    });
    if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout) || !committed.stdout.equals(bytes)) {
      fail(`Executor source is not the exact committed byte stream: ${relativePath}`);
    }
    return { path: relativePath, sha256: sha256(bytes) };
  });
}

function assertPrivateDirectory(directoryPath, label) {
  if (!path.isAbsolute(String(directoryPath || ""))) fail(`${label} must be absolute`);
  const requested = path.resolve(directoryPath);
  const stat = fs.lstatSync(requested);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(requested) !== requested
    || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    fail(`${label} must be an owned private canonical directory`);
  }
  return requested;
}

function readPrivateFile(filePath, label, maximumSize) {
  if (!path.isAbsolute(String(filePath || ""))) fail(`${label} must be absolute`);
  const requested = path.resolve(filePath);
  if (fs.realpathSync(requested) !== requested) fail(`${label} path must be canonical`);
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o077) !== 0
      || stat.size === 0 || stat.size > maximumSize) {
      fail(`${label} must be an owned private single-link regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateJson(filePath, label, maximumSize) {
  const bytes = readPrivateFile(filePath, label, maximumSize);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} must contain valid JSON`); }
  return { bytes, value };
}

export function assertExternalPacketDirectory(outputDirectory) {
  if (!path.isAbsolute(String(outputDirectory || ""))) fail("Packet output must be absolute");
  const output = path.resolve(outputDirectory);
  const relative = path.relative(REPO_ROOT, output);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail("Packet output must be outside the repository");
  }
  if (fs.existsSync(output)) fail("Packet output must not already exist");
  const parent = path.dirname(output);
  const stat = fs.lstatSync(parent);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent
    || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    fail("Packet output parent must be an owned private canonical directory");
  }
  return output;
}

function writePrivate(filePath, bytes) {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateCandidateReport(report, source, sourceBytes, candidateBytes) {
  const rebuilt = buildVivaGameProjectionSyncCandidate(structuredClone(source), sha256(sourceBytes));
  const expectedCandidateBytes = Buffer.from(`${JSON.stringify(rebuilt.candidate, null, 2)}\n`);
  const expectedReport = { ...rebuilt.report, candidateSha256: sha256(expectedCandidateBytes) };
  if (!candidateBytes.equals(expectedCandidateBytes) || !isDeepStrictEqual(report, expectedReport)) {
    fail("Viva projection candidate report does not match the reviewed cutover contract");
  }
  return { report: expectedReport, candidate: rebuilt.candidate };
}

function loadMigrationPlans(indexPath, expectedSourceFlowSha256, tenantKey) {
  const { value: index } = readPrivateJson(indexPath, "Migration plan index", 4 * 1024 * 1024);
  if (!isObject(index) || index.formatVersion !== 1 || index.tenantKey !== tenantKey
    || !Array.isArray(index.plans) || index.plans.length === 0 || index.plans.length > 64) {
    fail("Migration plan index contract mismatch");
  }
  return index.plans.map((entry, planIndex) => {
    if (!isObject(entry) || !path.isAbsolute(String(entry.path || "")) || !HASH_RE.test(String(entry.sha256 || ""))
      || !path.isAbsolute(String(entry.gamesPath || "")) || !path.isAbsolute(String(entry.providerPath || ""))
      || !path.isAbsolute(String(entry.providerCaptureReceiptPath || ""))) {
      fail(`Migration plan index entry ${planIndex} is invalid`);
    }
    const { bytes, value: plan } = readPrivateJson(entry.path, `Migration plan ${planIndex}`, 64 * 1024 * 1024);
    validateExecutableTenantMigrationPlan(plan, {
      expectedPlanSha256: entry.sha256,
      planBytes: bytes,
      expectedSourceFlowSha256,
      expectedTenantKey: tenantKey,
    });
    const gamesRead = readPrivateJson(entry.gamesPath, `Migration games projection ${planIndex}`, 32 * 1024 * 1024);
    const providerRead = readPrivateJson(entry.providerPath, `Migration provider projection ${planIndex}`, 64 * 1024 * 1024);
    const receiptRead = readPrivateJson(entry.providerCaptureReceiptPath, `Migration provider receipt ${planIndex}`, 1024 * 1024);
    const receiptSha256 = sha256(receiptRead.bytes);
    if (sha256(gamesRead.bytes) !== plan.source.gamesSha256 || sha256(providerRead.bytes) !== plan.source.providerSha256
      || receiptSha256 !== plan.source.providerCaptureReceiptSha256) {
      fail(`Migration plan ${planIndex} source evidence digest mismatch`);
    }
    validateProjectedInputs(gamesRead.value, providerRead.value, plan.scope);
    validateCaptureReceipt(receiptRead.value, receiptSha256, providerRead.value, plan.scope);
    requireFreshProjection(gamesRead.value, {
      sourceKind: "live-147-mongo-projection", sourceHost: "lk-primary-147", database: "games", collection: "lk_games",
    }, "Games", plan.generatedAt);
    requireFreshProjection(providerRead.value, { sourceKind: "viva-end-user-tenant-projection" }, "Provider", plan.generatedAt);
    if (gamesRead.value.sourceFlowSha256 !== expectedSourceFlowSha256 || providerRead.value.tenantKey !== tenantKey) {
      fail(`Migration plan ${planIndex} source evidence target mismatch`);
    }
    const rebuiltBody = buildLegacyTenantMigrationPlan(
      gamesRead.value.games, providerRead.value.rowsByDate, plan.scope, plan.generatedAt,
    );
    const rebuilt = { ...plan, ...rebuiltBody };
    if (!isDeepStrictEqual(plan, rebuilt)) fail(`Migration plan ${planIndex} does not deterministically match its source evidence`);
    return {
      planSha256: entry.sha256,
      plan,
      bytes,
      sourceEvidence: {
        games: { bytes: gamesRead.bytes, sha256: plan.source.gamesSha256 },
        provider: { bytes: providerRead.bytes, sha256: plan.source.providerSha256 },
        providerCaptureReceipt: { bytes: receiptRead.bytes, sha256: receiptSha256 },
      },
    };
  });
}

function loadControlEvidence(controls) {
  const evidence = [];
  if (controls.writerFence?.state === "HELD") {
    const proof = readPrivateJson(controls.writerFence.externalWriterProofPath, "External writer proof", 16 * 1024 * 1024);
    const proofObservedAt = Date.parse(proof.value?.observedAt);
    const fenceObservedAt = Date.parse(controls.writerFence.observedAt);
    const fenceExpiresAt = Date.parse(controls.writerFence.expiresAt);
    if (sha256(proof.bytes) !== controls.writerFence.externalWriterProofSha256
      || proof.value?.formatVersion !== 1
      || proof.value?.kind !== "viva-game-projection-external-writer-proof"
      || proof.value?.writerInventorySha256 !== controls.writerFence.writerInventorySha256
      || proof.value?.fenceTokenSha256 !== controls.writerFence.fenceTokenSha256
      || proof.value?.host !== controls.writerFence.host
      || proof.value?.hostname !== controls.writerFence.hostname
      || proof.value?.canonicalLockPath !== controls.writerFence.lockPath
      || proof.value?.allWritersUseCanonicalLock !== true
      || proof.value?.unfencedWriterCount !== 0
      || !Number.isSafeInteger(proof.value?.writerProcessCount)
      || proof.value.writerProcessCount < 1
      || !Array.isArray(proof.value?.writerProcesses)
      || proof.value.writerProcesses.length !== proof.value.writerProcessCount
      || proof.value.writerProcesses.some((item) => !Number.isSafeInteger(item?.pid) || item.pid < 1
        || !HASH_RE.test(String(item?.commandSha256 || "")) || item?.canonicalLockObserved !== true)
      || !Number.isFinite(proofObservedAt) || proofObservedAt < fenceObservedAt
      || proofObservedAt >= fenceExpiresAt || Math.abs(proofObservedAt - fenceObservedAt) > 60_000) {
      fail("External writer proof does not bind every writer to the canonical fence");
    }
    evidence.push({ name: "external-writer-proof.json", bytes: proof.bytes });
  }
  if (controls.backup?.state === "PASS") {
    const backup = readPrivateJson(controls.backup.manifestPath, "Full backup manifest", 16 * 1024 * 1024);
    const artifact = readPrivateFile(controls.backup.artifactPath, "Full backup artifact", 1024 * 1024 * 1024);
    let documents;
    try { documents = BSON.EJSON.parse(artifact.toString("utf8"), { relaxed: false }); } catch {
      fail("Full backup artifact must be canonical EJSON");
    }
    if (!Array.isArray(documents) || documents.some((document) => !(document?._id instanceof ObjectId))) {
      fail("Full backup artifact must be an array of BSON documents with ObjectId identity");
    }
    const stateRows = documents.map((document) => ({
      mongoId: document._id.toHexString(),
      documentSha256: hashCanonicalEjson(document),
    })).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
    if (new Set(stateRows.map(({ mongoId }) => mongoId)).size !== stateRows.length) {
      fail("Full backup artifact contains duplicate document identities");
    }
    const artifactSha256 = sha256(artifact);
    const fullCollectionStateSha256 = sha256(canonicalJson(stateRows));
    if (sha256(backup.bytes) !== controls.backup.manifestSha256
      || backup.value?.formatVersion !== 1
      || backup.value?.kind !== "viva-game-projection-full-lk-games-backup-manifest"
      || backup.value?.backupSha256 !== controls.backup.backupSha256
      || backup.value?.fullCollectionStateSha256 !== controls.backup.fullCollectionStateSha256
      || backup.value?.mongoTargetIdentitySha256 !== controls.backup.mongoTargetIdentitySha256
      || backup.value?.artifactPath !== controls.backup.artifactPath
      || artifactSha256 !== controls.backup.backupSha256
      || fullCollectionStateSha256 !== controls.backup.fullCollectionStateSha256
      || backup.value?.fenceTokenSha256 !== controls.backup.fenceTokenSha256
      || backup.value?.database !== controls.backup.database
      || backup.value?.collection !== controls.backup.collection
      || backup.value?.documentCount !== controls.backup.documentCount
      || documents.length !== controls.backup.documentCount
      || backup.value?.startedAt !== controls.backup.startedAt
      || backup.value?.completedAt !== controls.backup.completedAt) {
      fail("Full backup manifest does not bind the declared backup control");
    }
    evidence.push({ name: "full-backup.manifest.json", bytes: backup.bytes });
    evidence.push({ name: "full-backup.ejson", bytes: artifact });
  }
  if (controls.restoreRehearsal?.state === "PASS") {
    const restore = readPrivateJson(controls.restoreRehearsal.receiptPath, "Restore rehearsal receipt", 16 * 1024 * 1024);
    const restoredArtifact = readPrivateFile(
      controls.restoreRehearsal.restoredArtifactPath, "Restore rehearsal artifact", 1024 * 1024 * 1024,
    );
    let restoredDocuments;
    try { restoredDocuments = BSON.EJSON.parse(restoredArtifact.toString("utf8"), { relaxed: false }); } catch {
      fail("Restore rehearsal artifact must be canonical EJSON");
    }
    if (!Array.isArray(restoredDocuments) || restoredDocuments.some((document) => !(document?._id instanceof ObjectId))) {
      fail("Restore rehearsal artifact must contain BSON documents with ObjectId identity");
    }
    const restoredRows = restoredDocuments.map((document) => ({
      mongoId: document._id.toHexString(), documentSha256: hashCanonicalEjson(document),
    })).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
    const restoredStateSha256 = sha256(canonicalJson(restoredRows));
    if (sha256(restore.bytes) !== controls.restoreRehearsal.receiptSha256
      || restore.value?.formatVersion !== 1
      || restore.value?.kind !== "viva-game-projection-full-backup-restore-rehearsal"
      || restore.value?.backupSha256 !== controls.restoreRehearsal.backupSha256
      || restore.value?.manifestSha256 !== controls.restoreRehearsal.manifestSha256
      || restore.value?.fullCollectionStateSha256 !== controls.restoreRehearsal.fullCollectionStateSha256
      || restore.value?.mongoTargetIdentitySha256 !== controls.restoreRehearsal.mongoTargetIdentitySha256
      || restore.value?.isolatedTargetIdentitySha256 !== controls.restoreRehearsal.isolatedTargetIdentitySha256
      || restore.value?.restoredArtifactSha256 !== controls.restoreRehearsal.restoredArtifactSha256
      || restore.value?.restoredArtifactPath !== controls.restoreRehearsal.restoredArtifactPath
      || sha256(restoredArtifact) !== controls.restoreRehearsal.restoredArtifactSha256
      || restoredStateSha256 !== controls.restoreRehearsal.fullCollectionStateSha256
      || restoredDocuments.length !== controls.restoreRehearsal.restoredDocumentCount
      || restore.value?.restoredDocumentCount !== controls.restoreRehearsal.restoredDocumentCount
      || restore.value?.isolatedTarget !== true
      || restore.value?.postRestoreHashMatch !== true
      || restore.value?.rehearsedAt !== controls.restoreRehearsal.rehearsedAt) {
      fail("Restore rehearsal receipt does not bind the declared restore control");
    }
    evidence.push({ name: "full-backup.restore-rehearsal.json", bytes: restore.bytes });
    evidence.push({ name: "full-backup.restored.ejson", bytes: restoredArtifact });
  }
  return evidence;
}

function buildPacketManifest(directory, plan) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolutePath);
        files.push({ path: path.relative(directory, absolutePath), size: bytes.length, sha256: sha256(bytes) });
      } else fail("Cutover packet contains an unsupported filesystem entry");
    }
  };
  visit(directory);
  return {
    formatVersion: 1,
    kind: "viva-game-projection-cutover-packet-manifest",
    repository: plan.repository,
    sourceFlowSha256: plan.sourceFlowSha256,
    candidateSha256: plan.candidateSha256,
    state: plan.state,
    files,
  };
}

export function prepareVivaGameProjectionCutoverPacket({
  workspace,
  candidateDirectory,
  migrationIndexFile,
  controlsFile,
  outputDirectory,
  tenantKey,
  repository,
  executorSources,
  nowMs,
} = {}) {
  const repositoryProof = repository || repositoryIdentity();
  const verified = verifyWorkspace(workspace, { quiet: true, ...(nowMs === undefined ? {} : { nowMs }) });
  const sourceBytes = readPrivateFile(verified.sourcePath, "Node-RED source flow", 256 * 1024 * 1024);
  if (sha256(sourceBytes) !== verified.sourceSha256) fail("Node-RED source changed after workspace verification");
  const source = JSON.parse(sourceBytes.toString("utf8"));
  if (!isDeepStrictEqual(source, verified.source)) fail("Node-RED source changed after workspace parsing");
  const candidateRoot = assertPrivateDirectory(candidateDirectory, "Candidate directory");
  const candidateBytes = readPrivateFile(path.join(candidateRoot, "candidate.flow.json"), "Projection candidate", 256 * 1024 * 1024);
  const reportRead = readPrivateJson(path.join(candidateRoot, "report.json"), "Projection candidate report", 4 * 1024 * 1024);
  const rebuilt = validateCandidateReport(reportRead.value, source, sourceBytes, candidateBytes);
  const { report, candidate } = rebuilt;
  const contract = buildExactGraphContract({
    liveBytes: sourceBytes,
    candidateBytes,
    deploymentId: "viva-game-projection-tenant-cutover",
    allowedChanges: report.changedNodes.map((change) => ({ id: change.id, fields: change.changedFields })),
    allowedAdditionIds: report.addedNodes.map((addition) => addition.id),
  });
  validateExactGraphContract({ liveBytes: sourceBytes, candidateBytes, contract });
  const plans = loadMigrationPlans(migrationIndexFile, verified.sourceSha256, tenantKey);
  const controlsRead = readPrivateJson(controlsFile, "Cutover controls", 4 * 1024 * 1024);
  const controls = controlsRead.value;
  const controlEvidence = loadControlEvidence(controls);
  const contractBytes = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`);
  const plan = buildVivaGameProjectionCutoverPlan({
    repository: repositoryProof,
    sourceFlowSha256: verified.sourceSha256,
    candidateSha256: report.candidateSha256,
    candidateCanonicalSha256: sha256(canonicalJson(candidate)),
    tenantKey,
    sourceWriters: inventoryLkGamesWriters(source),
    candidateWriters: inventoryLkGamesWriters(candidate),
    plans,
    controls,
    controlsSha256: sha256(controlsRead.bytes),
    reviewedFlowContractSha256: sha256(contractBytes),
    executorSources: executorSources || executorSourceManifest(repositoryProof.commit),
    generatedAt: new Date(nowMs ?? Date.now()).toISOString(),
  });
  const output = assertExternalPacketDirectory(outputDirectory);
  const parent = path.dirname(output);
  const temporary = fs.mkdtempSync(path.join(parent, `.${path.basename(output)}.stage-`));
  let published = false;
  try {
    fs.chmodSync(temporary, 0o700);
    const migrationDirectory = path.join(temporary, "migration-plans");
    fs.mkdirSync(migrationDirectory, { mode: 0o700 });
    fs.chmodSync(migrationDirectory, 0o700);
    const evidenceDirectory = path.join(temporary, "evidence");
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    fs.chmodSync(evidenceDirectory, 0o700);
    const migrationEvidenceDirectory = path.join(temporary, "migration-evidence");
    fs.mkdirSync(migrationEvidenceDirectory, { mode: 0o700 });
    fs.chmodSync(migrationEvidenceDirectory, 0o700);
    writePrivate(path.join(temporary, "source.flow.json"), sourceBytes);
    writePrivate(path.join(temporary, "candidate.flow.json"), candidateBytes);
    writePrivate(path.join(temporary, "candidate.report.json"), reportRead.bytes);
    writePrivate(path.join(temporary, "reviewed-flow.contract.json"), contractBytes);
    writePrivate(path.join(temporary, "cutover-controls.json"), controlsRead.bytes);
    writePrivate(path.join(temporary, "cutover-plan.json"), Buffer.from(`${JSON.stringify(plan, null, 2)}\n`));
    plans.forEach((item, index) => writePrivate(
      path.join(migrationDirectory, `${String(index + 1).padStart(2, "0")}-${item.planSha256}.json`),
      item.bytes,
    ));
    plans.forEach((item, index) => {
      const sourceDirectory = path.join(migrationEvidenceDirectory, String(index + 1).padStart(2, "0"));
      fs.mkdirSync(sourceDirectory, { mode: 0o700 });
      fs.chmodSync(sourceDirectory, 0o700);
      writePrivate(path.join(sourceDirectory, "games.projection.json"), item.sourceEvidence.games.bytes);
      writePrivate(path.join(sourceDirectory, "provider.projection.json"), item.sourceEvidence.provider.bytes);
      writePrivate(path.join(sourceDirectory, "provider.capture-receipt.json"), item.sourceEvidence.providerCaptureReceipt.bytes);
      syncDirectory(sourceDirectory);
    });
    controlEvidence.forEach((item) => writePrivate(path.join(evidenceDirectory, item.name), item.bytes));
    syncDirectory(migrationDirectory);
    syncDirectory(migrationEvidenceDirectory);
    syncDirectory(evidenceDirectory);
    const manifest = buildPacketManifest(temporary, plan);
    writePrivate(path.join(temporary, "packet.manifest.json"), Buffer.from(canonicalJson(manifest)));
    syncDirectory(temporary);
    fs.renameSync(temporary, output);
    published = true;
    syncDirectory(parent);
    return { output, plan, contract, manifest };
  } catch (error) {
    fs.rmSync(published ? output : temporary, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key)) fail(`Invalid argument: ${key || ""}`);
    values[key] = value;
  }
  for (const key of ["--workspace", "--candidate-directory", "--migration-index", "--controls", "--output-directory", "--tenant-key"]) {
    if (!values[key]) fail(`Missing ${key}`);
  }
  return {
    workspace: values["--workspace"],
    candidateDirectory: values["--candidate-directory"],
    migrationIndexFile: values["--migration-index"],
    controlsFile: values["--controls"],
    outputDirectory: values["--output-directory"],
    tenantKey: values["--tenant-key"],
  };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/prepare_viva_game_projection_cutover_packet.mjs --workspace /private/fresh-live-workspace --candidate-directory /private/candidate --migration-index /private/plan-index.json --controls /private/controls.json --output-directory /private/new-cutover-packet --tenant-key <tenant>\n");
  } else {
    try {
      const result = prepareVivaGameProjectionCutoverPacket(parseArgs(process.argv.slice(2)));
      process.stdout.write(`${JSON.stringify({
        packetDirectory: result.output,
        state: result.plan.state,
        blockerCount: result.plan.blockers.length,
        sourceFlowSha256: result.plan.sourceFlowSha256,
        candidateSha256: result.plan.candidateSha256,
        liveMutationAuthorized: result.plan.liveMutationAuthorized,
        deploymentPerformed: result.plan.deploymentPerformed,
        databaseMutationPerformed: result.plan.databaseMutationPerformed,
      })}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

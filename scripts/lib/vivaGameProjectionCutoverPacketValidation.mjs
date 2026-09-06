import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BSON, ObjectId } from "mongodb";

import {
  buildVivaGameProjectionCutoverPlan,
  canonicalJson,
  inventoryLkGamesWriters,
  sha256,
} from "./vivaGameProjectionCutoverContract.mjs";
import { buildLegacyTenantMigrationPlan } from "./vivaGameProjectionTenantMigration.mjs";
import {
  hashCanonicalEjson,
  validateExecutableTenantMigrationPlan,
} from "./vivaGameProjectionTenantMigrationExecution.mjs";
import {
  requireFreshProjection,
  validateCaptureReceipt,
  validateProjectedInputs,
} from "../prepare_viva_game_projection_tenant_migration.mjs";
import { validateExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(message); };

const readPacketBytes = (packetRoot, relativePath, label, maximumSize) => {
  const requested = path.resolve(packetRoot, relativePath);
  const relative = path.relative(packetRoot, requested);
  if (relative !== relativePath || relative.startsWith("..") || path.isAbsolute(relative)
    || fs.realpathSync(requested) !== requested) fail(`${label} path is outside the exact packet`);
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > maximumSize) {
      fail(`${label} is not an owned private packet file`);
    }
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
};

const readPacketJson = (packetRoot, relativePath, label, maximumSize) => {
  const bytes = readPacketBytes(packetRoot, relativePath, label, maximumSize);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not valid JSON`); }
  return { bytes, value };
};

const parseBackupArtifact = (bytes, label) => {
  let documents;
  try { documents = BSON.EJSON.parse(bytes.toString("utf8"), { relaxed: false }); } catch { fail(`${label} is not canonical EJSON`); }
  if (!Array.isArray(documents) || documents.some((document) => !(document?._id instanceof ObjectId))) {
    fail(`${label} does not contain BSON documents with ObjectId identity`);
  }
  const rows = documents.map((document) => ({
    mongoId: document._id.toHexString(), documentSha256: hashCanonicalEjson(document),
  })).sort((left, right) => left.mongoId.localeCompare(right.mongoId));
  if (new Set(rows.map(({ mongoId }) => mongoId)).size !== rows.length) fail(`${label} contains duplicate identities`);
  return { documents, fullCollectionStateSha256: sha256(canonicalJson(rows)) };
};

export const validateCopiedControlEvidence = (root, controls) => {
  const proof = readPacketJson(root, "evidence/external-writer-proof.json", "Packet external-writer proof", 16 * 1024 * 1024);
  const proofObservedAt = Date.parse(proof.value?.observedAt);
  const fenceObservedAt = Date.parse(controls.writerFence?.observedAt);
  const fenceExpiresAt = Date.parse(controls.writerFence?.expiresAt);
  if (sha256(proof.bytes) !== controls.writerFence?.externalWriterProofSha256
    || proof.value?.formatVersion !== 1 || proof.value?.kind !== "viva-game-projection-external-writer-proof"
    || proof.value?.writerInventorySha256 !== controls.writerFence?.writerInventorySha256
    || proof.value?.fenceTokenSha256 !== controls.writerFence?.fenceTokenSha256
    || proof.value?.host !== controls.writerFence?.host || proof.value?.hostname !== controls.writerFence?.hostname
    || proof.value?.canonicalLockPath !== controls.writerFence?.lockPath
    || proof.value?.allWritersUseCanonicalLock !== true || proof.value?.unfencedWriterCount !== 0
    || !Number.isSafeInteger(proof.value?.writerProcessCount) || proof.value.writerProcessCount < 1
    || !Array.isArray(proof.value?.writerProcesses)
    || proof.value.writerProcesses.length !== proof.value.writerProcessCount
    || proof.value.writerProcesses.some((item) => !Number.isSafeInteger(item?.pid) || item.pid < 1
      || !HASH_RE.test(String(item?.commandSha256 || "")) || item?.canonicalLockObserved !== true)
    || !Number.isFinite(proofObservedAt) || proofObservedAt < fenceObservedAt
    || proofObservedAt >= fenceExpiresAt || Math.abs(proofObservedAt - fenceObservedAt) > 60_000) {
    fail("Packet external-writer proof does not bind every writer to the canonical fence");
  }

  const backupManifest = readPacketJson(root, "evidence/full-backup.manifest.json", "Packet backup manifest", 16 * 1024 * 1024);
  const backupArtifact = readPacketBytes(root, "evidence/full-backup.ejson", "Packet full backup", 1024 * 1024 * 1024);
  const backup = parseBackupArtifact(backupArtifact, "Packet full backup");
  if (sha256(backupManifest.bytes) !== controls.backup?.manifestSha256
    || sha256(backupArtifact) !== controls.backup?.backupSha256
    || backup.fullCollectionStateSha256 !== controls.backup?.fullCollectionStateSha256
    || backup.documents.length !== controls.backup?.documentCount
    || backupManifest.value?.formatVersion !== 1
    || backupManifest.value?.kind !== "viva-game-projection-full-lk-games-backup-manifest"
    || backupManifest.value?.backupSha256 !== controls.backup?.backupSha256
    || backupManifest.value?.fullCollectionStateSha256 !== controls.backup?.fullCollectionStateSha256
    || backupManifest.value?.mongoTargetIdentitySha256 !== controls.backup?.mongoTargetIdentitySha256
    || backupManifest.value?.artifactPath !== controls.backup?.artifactPath
    || backupManifest.value?.fenceTokenSha256 !== controls.backup?.fenceTokenSha256
    || backupManifest.value?.database !== "games" || backupManifest.value?.collection !== "lk_games"
    || backupManifest.value?.documentCount !== controls.backup?.documentCount
    || backupManifest.value?.startedAt !== controls.backup?.startedAt
    || backupManifest.value?.completedAt !== controls.backup?.completedAt) {
    fail("Packet full backup does not bind the declared backup control");
  }

  const restoreReceipt = readPacketJson(
    root, "evidence/full-backup.restore-rehearsal.json", "Packet restore-rehearsal receipt", 16 * 1024 * 1024,
  );
  const restoredArtifact = readPacketBytes(
    root, "evidence/full-backup.restored.ejson", "Packet restored rehearsal artifact", 1024 * 1024 * 1024,
  );
  const restored = parseBackupArtifact(restoredArtifact, "Packet restored rehearsal artifact");
  if (sha256(restoreReceipt.bytes) !== controls.restoreRehearsal?.receiptSha256
    || sha256(restoredArtifact) !== controls.restoreRehearsal?.restoredArtifactSha256
    || restored.fullCollectionStateSha256 !== controls.restoreRehearsal?.fullCollectionStateSha256
    || restored.documents.length !== controls.restoreRehearsal?.restoredDocumentCount
    || restoreReceipt.value?.formatVersion !== 1
    || restoreReceipt.value?.kind !== "viva-game-projection-full-backup-restore-rehearsal"
    || restoreReceipt.value?.backupSha256 !== controls.restoreRehearsal?.backupSha256
    || restoreReceipt.value?.manifestSha256 !== controls.restoreRehearsal?.manifestSha256
    || restoreReceipt.value?.fullCollectionStateSha256 !== controls.restoreRehearsal?.fullCollectionStateSha256
    || restoreReceipt.value?.mongoTargetIdentitySha256 !== controls.restoreRehearsal?.mongoTargetIdentitySha256
    || restoreReceipt.value?.isolatedTargetIdentitySha256 !== controls.restoreRehearsal?.isolatedTargetIdentitySha256
    || restoreReceipt.value?.restoredArtifactSha256 !== controls.restoreRehearsal?.restoredArtifactSha256
    || restoreReceipt.value?.restoredArtifactPath !== controls.restoreRehearsal?.restoredArtifactPath
    || restoreReceipt.value?.restoredDocumentCount !== controls.restoreRehearsal?.restoredDocumentCount
    || restoreReceipt.value?.isolatedTarget !== true || restoreReceipt.value?.postRestoreHashMatch !== true
    || restoreReceipt.value?.rehearsedAt !== controls.restoreRehearsal?.rehearsedAt) {
    fail("Packet restore rehearsal does not bind the declared restore control");
  }
};

const assertExactPacketTree = (packetRoot, manifest) => {
  const observed = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute
          || (stat.mode & 0o777) !== 0o700
          || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          fail("Cutover packet contains a non-private directory");
        }
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(packetRoot, absolute);
        if (relative === "packet.manifest.json") continue;
        const declared = (manifest?.files || []).find((item) => item?.path === relative);
        if (!declared || !Number.isSafeInteger(declared.size) || declared.size < 0
          || declared.size > 1024 * 1024 * 1024) fail("Cutover packet manifest contains an invalid file size");
        const bytes = readPacketBytes(packetRoot, relative, `Packet file ${relative}`, declared.size);
        observed.push({ path: relative, size: bytes.length, sha256: sha256(bytes) });
      } else fail("Cutover packet contains an unsupported filesystem entry");
    }
  };
  visit(packetRoot);
  observed.sort((left, right) => left.path.localeCompare(right.path));
  const expected = [...(manifest?.files || [])].sort((left, right) => String(left?.path).localeCompare(String(right?.path)));
  if (!isDeepStrictEqual(observed, expected)) fail("Cutover packet tree differs from its exact manifest");
};

export function validateExactCutoverPacket({ packetRoot, plan, manifest, nowMs = Date.now() }) {
  const root = fs.realpathSync(packetRoot);
  const rootStat = fs.lstatSync(root);
  if (root !== path.resolve(packetRoot) || !rootStat.isDirectory() || rootStat.isSymbolicLink()
    || (rootStat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())
    || !Array.isArray(manifest?.files)) {
    fail("Cutover packet root or manifest is not private and canonical");
  }
  assertExactPacketTree(root, manifest);
  const sourceFlowRead = readPacketJson(root, "source.flow.json", "Packet source flow", 256 * 1024 * 1024);
  const candidateFlowRead = readPacketJson(root, "candidate.flow.json", "Packet candidate flow", 256 * 1024 * 1024);
  const controlsRead = readPacketJson(root, "cutover-controls.json", "Packet cutover controls", 16 * 1024 * 1024);
  const reviewedContractRead = readPacketJson(
    root, "reviewed-flow.contract.json", "Packet reviewed-flow contract", 16 * 1024 * 1024,
  );
  if (!Array.isArray(sourceFlowRead.value) || !Array.isArray(candidateFlowRead.value)
    || sha256(sourceFlowRead.bytes) !== plan?.sourceFlowSha256
    || sha256(candidateFlowRead.bytes) !== plan?.candidateSha256
    || sha256(canonicalJson(candidateFlowRead.value)) !== plan?.candidateCanonicalSha256
    || sha256(controlsRead.bytes) !== plan?.controlsSha256
    || sha256(reviewedContractRead.bytes) !== plan?.reviewedFlowContractSha256) {
    fail("Cutover packet core evidence differs from the cutover plan");
  }
  validateExactGraphContract({
    liveBytes: sourceFlowRead.bytes,
    candidateBytes: candidateFlowRead.bytes,
    contract: reviewedContractRead.value,
  });
  validateCopiedControlEvidence(root, controlsRead.value);
  const generatedAtMs = Date.parse(plan?.generatedAt);
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 60_000 || nowMs - generatedAtMs > 30 * 60_000
    || plan?.migration?.futureBoundaryTimeZone !== "UTC"
    || plan?.migration?.futureBoundaryDate !== new Date(generatedAtMs).toISOString().slice(0, 10)) {
    fail("Cutover packet future boundary is stale or not fixed to its UTC production clock");
  }
  if (!Array.isArray(plan.migration?.planSha256s) || !Array.isArray(plan.migration?.sourceEvidence)
    || plan.migration.planSha256s.length === 0
    || plan.migration.sourceEvidence.length !== plan.migration.planSha256s.length) {
    fail("Cutover packet migration source evidence is incomplete");
  }
  const validatedPlans = [];
  const plansForRebuild = [];
  for (const [index, planSha256] of plan.migration.planSha256s.entries()) {
    if (!HASH_RE.test(String(planSha256 || ""))) fail("Cutover packet migration-plan digest is invalid");
    const ordinal = String(index + 1).padStart(2, "0");
    const source = plan.migration.sourceEvidence[index];
    const expectedSource = {
      planSha256,
      gamesPath: `migration-evidence/${ordinal}/games.projection.json`,
      gamesSha256: source?.gamesSha256,
      providerPath: `migration-evidence/${ordinal}/provider.projection.json`,
      providerSha256: source?.providerSha256,
      providerCaptureReceiptPath: `migration-evidence/${ordinal}/provider.capture-receipt.json`,
      providerCaptureReceiptSha256: source?.providerCaptureReceiptSha256,
    };
    if (!isDeepStrictEqual(source, expectedSource)
      || [source.gamesSha256, source.providerSha256, source.providerCaptureReceiptSha256]
        .some((value) => !HASH_RE.test(String(value || "")))) {
      fail(`Cutover packet migration source evidence ${index} is invalid`);
    }
    const planPath = `migration-plans/${ordinal}-${planSha256}.json`;
    const planRead = readPacketJson(root, planPath, `Migration plan ${index}`, 64 * 1024 * 1024);
    const gamesRead = readPacketJson(root, source.gamesPath, `Migration games projection ${index}`, 32 * 1024 * 1024);
    const providerRead = readPacketJson(root, source.providerPath, `Migration provider projection ${index}`, 64 * 1024 * 1024);
    const receiptRead = readPacketJson(root, source.providerCaptureReceiptPath, `Migration provider receipt ${index}`, 1024 * 1024);
    if (sha256(planRead.bytes) !== planSha256 || sha256(gamesRead.bytes) !== source.gamesSha256
      || sha256(providerRead.bytes) !== source.providerSha256
      || sha256(receiptRead.bytes) !== source.providerCaptureReceiptSha256) {
      fail(`Cutover packet migration evidence ${index} digest mismatch`);
    }
    validateExecutableTenantMigrationPlan(planRead.value, {
      expectedPlanSha256: planSha256,
      planBytes: planRead.bytes,
      expectedSourceFlowSha256: plan.sourceFlowSha256,
      nowMs,
    });
    validateProjectedInputs(gamesRead.value, providerRead.value, planRead.value.scope);
    validateCaptureReceipt(
      receiptRead.value,
      source.providerCaptureReceiptSha256,
      providerRead.value,
      planRead.value.scope,
      planRead.value.source.providerServicePrincipalSha256,
    );
    requireFreshProjection(gamesRead.value, {
      sourceKind: "live-147-mongo-projection", sourceHost: "lk-primary-147", database: "games", collection: "lk_games",
    }, "Games", planRead.value.generatedAt);
    requireFreshProjection(providerRead.value, { sourceKind: "viva-admin-service-projection" }, "Provider", planRead.value.generatedAt);
    if (gamesRead.value.sourceFlowSha256 !== plan.sourceFlowSha256
      || sha256(String(providerRead.value.tenantKey || "")) !== plan.tenantKeySha256) {
      fail(`Cutover packet migration evidence ${index} target mismatch`);
    }
    const rebuilt = {
      ...planRead.value,
      ...buildLegacyTenantMigrationPlan(
        gamesRead.value.games, providerRead.value.rowsByDate, planRead.value.scope, planRead.value.generatedAt,
      ),
    };
    if (!isDeepStrictEqual(rebuilt, planRead.value)) {
      fail(`Cutover packet migration plan ${index} does not deterministically match its evidence`);
    }
    validatedPlans.push({ planPath: path.join(root, planPath), planSha256, scope: planRead.value.scope });
    plansForRebuild.push({
      planSha256,
      plan: planRead.value,
      sourceEvidence: {
        games: { sha256: source.gamesSha256 },
        provider: { sha256: source.providerSha256 },
        providerCaptureReceipt: { sha256: source.providerCaptureReceiptSha256 },
      },
    });
  }
  const rebuiltCutoverPlan = buildVivaGameProjectionCutoverPlan({
    repository: plan.repository,
    sourceFlowSha256: plan.sourceFlowSha256,
    candidateSha256: plan.candidateSha256,
    candidateCanonicalSha256: plan.candidateCanonicalSha256,
    tenantKey: controlsRead.value?.tenantKey,
    sourceWriters: inventoryLkGamesWriters(sourceFlowRead.value),
    candidateWriters: inventoryLkGamesWriters(candidateFlowRead.value),
    plans: plansForRebuild,
    controls: controlsRead.value,
    controlsSha256: plan.controlsSha256,
    reviewedFlowContractSha256: plan.reviewedFlowContractSha256,
    executorSources: plan.executorSources,
    generatedAt: plan.generatedAt,
  });
  if (!isDeepStrictEqual(rebuiltCutoverPlan, plan)) fail("Cutover plan does not deterministically match the exact packet evidence");
  return {
    futureBoundaryDate: plan.migration.futureBoundaryDate,
    futureBoundaryTimeZone: "UTC",
    validatedPlans,
    packetTreeSha256: sha256(canonicalJson(manifest.files)),
  };
}

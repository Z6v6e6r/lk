import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  buildVivaGameProjectionCutoverPlan,
  canonicalJson,
  inventoryLkGamesWriters,
  sha256,
} from "./vivaGameProjectionCutoverContract.mjs";
import { buildLegacyTenantMigrationPlan } from "./vivaGameProjectionTenantMigration.mjs";
import { validateExecutableTenantMigrationPlan } from "./vivaGameProjectionTenantMigrationExecution.mjs";
import {
  requireFreshProjection,
  validateCaptureReceipt,
  validateProjectedInputs,
} from "../prepare_viva_game_projection_tenant_migration.mjs";
import { validateExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

const HASH_RE = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(message); };

const readPacketJson = (packetRoot, relativePath, label, maximumSize) => {
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
    const bytes = fs.readFileSync(descriptor);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} is not valid JSON`); }
    return { bytes, value };
  } finally { fs.closeSync(descriptor); }
};

const assertExactPacketTree = (packetRoot, manifest) => {
  const observed = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) fail("Cutover packet contains a non-private directory");
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(packetRoot, absolute);
        if (relative === "packet.manifest.json") continue;
        const bytes = fs.readFileSync(absolute);
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
    || (rootStat.mode & 0o077) !== 0 || !Array.isArray(manifest?.files)) {
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
    validateCaptureReceipt(receiptRead.value, source.providerCaptureReceiptSha256, providerRead.value, planRead.value.scope);
    requireFreshProjection(gamesRead.value, {
      sourceKind: "live-147-mongo-projection", sourceHost: "lk-primary-147", database: "games", collection: "lk_games",
    }, "Games", planRead.value.generatedAt);
    requireFreshProjection(providerRead.value, { sourceKind: "viva-end-user-tenant-projection" }, "Provider", planRead.value.generatedAt);
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

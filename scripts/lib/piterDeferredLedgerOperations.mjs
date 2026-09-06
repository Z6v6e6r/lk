import { validateAtomicLedgerCustody, validateAtomicLedgerShape } from './piterAtomicLedgerOperations.mjs';
import { buildPiterDeferredSentinel, validatePiterDeferredActivationPacket, digestDeferredDocuments, stableJson } from './piterDeferredActivationContract.mjs';
export { validateAtomicLedgerCustody, validateAtomicLedgerShape };
const fail = code => { throw new Error('Piter deferred ledger: ' + code); };
const toStr = v => v == null ? null : String(v).trim() || null;
const exactPacketBaseline = (packet, rows) => {
  const legacy = rows.filter(r => r._id !== packet.target.ledgerId && !String(r._id).startsWith('piter-sale:'));
  if (digestDeferredDocuments(legacy) !== packet.baseline.legacyLedgerDigest) fail('complete legacy preimage drift');
  return packet.baseline;
};

const assertExpectedRevision = (value) => {
  if (!Number.isInteger(value) || value < 0) fail("expected revision must be a non-negative integer");
};

const hasExactPacketCustody = (ledger, packet) => (
  ledger?.activationContractDigest === packet.contractDigest
  && ledger?.schemaVersion === (packet.launchQuota ? 2 : 1)
  && (packet.launchQuota ? ledger?.quotaAdjustment === packet.launchQuota.adjustment : !Object.hasOwn(ledger, "quotaAdjustment"))
  && ledger?.baselineDigest === packet.baseline.digest
  && stableJson(ledger?.legacyPaymentRefs) === stableJson(packet.baseline.legacyPaymentRefs)
);

const isExactSeedState = (ledger, packet) => {
  try { validateAtomicLedgerShape(ledger, packet.target.totalLimit); } catch { return false; }
  return hasExactPacketCustody(ledger, packet)
    && ledger.ready === false
    && ledger.revision === 0
    && ledger.paidCount === packet.baseline.paidCount
    && ledger.reservedCount === 0
    && ledger.takenCount === packet.baseline.paidCount
    && ledger.reservations.length === 0;
};

export function buildPiterDeferredLedgerPlan({
  action,
  packet,
  documents,
  activeFlowSha256,
  expectedRevision = 0,
  now = new Date(),
  reason = null,
}) {
  const allowExpired = action === "deactivate" || action === "rollback-check";
  validatePiterDeferredActivationPacket(packet, { now, allowExpired });
  if (!Array.isArray(documents)) fail("current Piter documents are required");
  if (documents.some(r => !r || !toStr(r._id)) || new Set(documents.map(r => String(r._id))).size !== documents.length) fail("document identity mismatch");
  if (!["preflight", "seed", "activate", "deactivate", "rollback-check"].includes(action)) fail("unsupported action");
  if (["preflight", "seed", "activate"].includes(action)
    && activeFlowSha256 !== packet.deployment.candidateSha256) fail("active flow SHA does not match the reviewed candidate");

  const sentinels = documents.filter((row) => row?._id === packet.target.ledgerId);
  if (sentinels.length > 1) fail("multiple atomic sentinels found");
  const ledger = sentinels[0] || null;
  const atomicSales = documents.filter((row) => String(row?._id || "").startsWith("piter-sale:"));
  const liveBaseline = allowExpired
    ? { digest: packet.baseline.digest }
    : exactPacketBaseline(packet, documents);
  const nowIso = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  if (action === "rollback-check") {
    let structurallyValid = true;
    if (ledger) {
      validateAtomicLedgerCustody(ledger);
      try { validateAtomicLedgerShape(ledger, packet.target.totalLimit); } catch { structurallyValid = false; }
    }
    const reservationCount = ledger?.reservations?.length || 0;
    const offlinePreconditionSatisfied = structurallyValid && reservationCount === 0
      && atomicSales.length === 0 && ledger?.ready !== true;
    return {
      action,
      mutation: null,
      outcome: offlinePreconditionSatisfied
        ? "OFFLINE_FLOW_ROLLBACK_PRECONDITION_SATISFIED"
        : "OFFLINE_FLOW_ROLLBACK_PRECONDITION_FAILED",
      authorizesRollback: false,
      ready: ledger?.ready === true,
      revision: ledger?.revision ?? null,
      reservationCount,
      atomicSaleCount: atomicSales.length,
      structurallyValid,
      baselineDigest: liveBaseline.digest,
    };
  }

  if (action === "seed") {
    if (atomicSales.length > 0) fail("atomic sale history exists without a sentinel");
    assertExpectedRevision(expectedRevision);
    if (expectedRevision !== 0) fail("seed expected revision must be zero");
    if (ledger) {
      if (!isExactSeedState(ledger, packet)) fail("atomic sentinel already exists in a different state");
      return {
        action,
        mutation: null,
        outcome: "ALREADY_APPLIED",
        expectedRevision,
        ready: false,
        revision: 0,
        baselineDigest: liveBaseline.digest,
      };
    }
    const document = buildPiterDeferredSentinel(packet, nowIso);
    return { action, mutation: { type: "insertOne", document }, expectedRevision, baselineDigest: liveBaseline.digest };
  }

  if (!ledger) {
    if (action === "preflight") {
      return { action, mutation: null, outcome: "READY_TO_SEED", ready: false, revision: null, baselineDigest: liveBaseline.digest };
    }
    fail("atomic sentinel is missing");
  }
  if (action === "deactivate") validateAtomicLedgerCustody(ledger);
  else validateAtomicLedgerShape(ledger, packet.target.totalLimit);
  if (!hasExactPacketCustody(ledger, packet)) {
    fail("atomic sentinel custody mismatch");
  }
  if (action === "preflight") {
    const hasAtomicHistory = ledger.reservations.length > 0 || atomicSales.length > 0;
    return {
      action,
      mutation: null,
      outcome: ledger.ready ? "ALREADY_ACTIVE"
        : hasAtomicHistory ? "DEACTIVATED_REQUIRES_REVIEW" : "READY_TO_ACTIVATE",
      ready: ledger.ready,
      revision: ledger.revision,
      baselineDigest: liveBaseline.digest,
    };
  }

  assertExpectedRevision(expectedRevision);
  if (action === "activate") {
    if (ledger.ready === true && ledger.revision >= expectedRevision + 1
      && ledger.activationBaseRevision === expectedRevision
      && ledger.activationDeploymentId === packet.deployment.deploymentId) {
      return {
        action,
        mutation: null,
        outcome: "ALREADY_APPLIED",
        expectedRevision,
        ready: true,
        revision: ledger.revision,
        baselineDigest: liveBaseline.digest,
      };
    }
    if (ledger.revision !== expectedRevision) fail("atomic sentinel revision drifted");
    if (atomicSales.length > 0) fail("atomic sale history blocks seed-state activation");
    if (ledger.ready !== false || ledger.reservations.length !== 0
      || ledger.reservedCount !== 0 || ledger.takenCount !== packet.baseline.paidCount) {
      fail("atomic sentinel is not in the exact seed state");
    }
    return {
      action,
      mutation: {
        type: "updateOne",
        filter: {
          _id: packet.target.ledgerId,
          ready: false,
          revision: expectedRevision,
          activationContractDigest: packet.contractDigest,
          baselineDigest: packet.baseline.digest,
          schemaVersion: packet.launchQuota ? 2 : 1,
          quotaAdjustment: packet.launchQuota ? packet.launchQuota.adjustment : { $exists: false },
          paidCount: packet.baseline.paidCount,
          reservedCount: 0,
          takenCount: packet.baseline.paidCount,
          reservations: { $size: 0 },
        },
        update: {
          $set: {
            ready: true,
            activatedAt: nowIso,
            activationBaseRevision: expectedRevision,
            activationDeploymentId: packet.deployment.deploymentId,
            updatedAt: nowIso,
          },
          $inc: { revision: 1 },
        },
      },
      expectedRevision,
      baselineDigest: liveBaseline.digest,
    };
  }

  const normalizedReason = toStr(reason);
  if (!normalizedReason || normalizedReason.length < 8 || normalizedReason.length > 200) {
    fail("deactivation reason must contain 8 to 200 characters");
  }
  let inactiveShapeValid = true;
  try { validateAtomicLedgerShape(ledger, packet.target.totalLimit); } catch { inactiveShapeValid = false; }
  if (ledger.ready === false && ledger.revision >= expectedRevision + 1
    && ledger.deactivationReason === normalizedReason
    && ledger.deactivationBaseRevision === expectedRevision
    && (ledger.revision === expectedRevision + 1 || inactiveShapeValid)) {
    return {
      action,
      mutation: null,
      outcome: "ALREADY_APPLIED",
      expectedRevision,
      ready: false,
      revision: ledger.revision,
      baselineDigest: liveBaseline.digest,
      activeReservationCount: ledger.reservedCount,
    };
  }
  if (ledger.revision !== expectedRevision) fail("atomic sentinel revision drifted");
  if (ledger.ready !== true) fail("atomic sentinel is already inactive");
  return {
    action,
    mutation: {
      type: "updateOne",
      filter: {
        _id: packet.target.ledgerId,
        ready: true,
        revision: expectedRevision,
        activationContractDigest: packet.contractDigest,
        paidCount: ledger.paidCount,
        schemaVersion: ledger.schemaVersion,
        quotaAdjustment: ledger.schemaVersion === 2 ? ledger.quotaAdjustment : { $exists: false },
        reservedCount: ledger.reservedCount,
        takenCount: ledger.takenCount,
      },
      update: {
        $set: {
          ready: false,
          deactivatedAt: nowIso,
          deactivationReason: normalizedReason,
          deactivationBaseRevision: expectedRevision,
          updatedAt: nowIso,
        },
        $inc: { revision: 1 },
      },
    },
    expectedRevision,
    baselineDigest: liveBaseline.digest,
    activeReservationCount: ledger.reservedCount,
    preDeactivateQuotaCustody: {
      schemaVersion: ledger.schemaVersion,
      hasQuotaAdjustment: Object.hasOwn(ledger, "quotaAdjustment"),
      quotaAdjustment: ledger.quotaAdjustment,
    },
    preDeactivateCounts: {
      paidCount: ledger.paidCount,
      reservedCount: ledger.reservedCount,
      takenCount: ledger.takenCount,
    },
    preDeactivateReservations: ledger.reservations.map((item) => ({ ...item })),
  };
}

export function redactPiterDeferredLedgerPlan(plan) {
  return {
    ok: true,
    action: plan.action,
    outcome: plan.outcome || "MUTATION_PREPARED",
    mutationType: plan.mutation?.type || null,
    expectedRevision: plan.expectedRevision ?? plan.revision ?? null,
    ready: plan.ready ?? null,
    baselineDigest: plan.baselineDigest,
    reservationCount: plan.reservationCount ?? plan.activeReservationCount ?? null,
    atomicSaleCount: plan.atomicSaleCount ?? null,
    structurallyValid: plan.structurallyValid ?? null,
    authorizesRollback: plan.authorizesRollback ?? null,
    mutationPerformed: false,
  };
}

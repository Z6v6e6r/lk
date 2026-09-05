import {
  PITER_ATOMIC_ACTIVATION,
  buildPiterAtomicSentinel,
  digestPiterLegacyLedgerRows,
  hashId,
  sha256,
  stableJson,
  validatePiterAtomicActivationPacket,
} from "./piterAtomicActivationContract.mjs";

const TERMINAL_PAID = new Set(["PAID", "SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "APPROVED"]);
const TERMINAL_FAILED = new Set(["FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED", "REFUNDED"]);
const ACTIVE_STATES = new Set(["CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN"]);

const fail = (message) => {
  throw new Error(`Piter atomic ledger operation failed: ${message}`);
};

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toInteger = (value) => (typeof value === "number" && Number.isInteger(value) ? value : null);
const normalizeStatus = (value) => String(value || "").trim().toUpperCase();
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length === 11 ? digits : null;
};

const projectPaidEntry = (row, productId) => {
  const paymentRef = toStr(row?.paymentRef);
  const transactionId = toStr(row?.transactionId) || toStr(row?.paymentId);
  const amountMinor = toInteger(row?.amountMinor);
  const providerProductCostMinor = toInteger(row?.providerProductCostMinor);
  const discountMinor = toInteger(row?.discountMinor);
  const clientId = toStr(row?.clientId);
  const clientPhone = normalizePhone(row?.clientPhone);
  if (!paymentRef || !transactionId || toStr(row?.productId) !== productId) fail("live paid row identity mismatch");
  if (!Number.isInteger(amountMinor) || amountMinor <= 0
    || providerProductCostMinor !== PITER_ATOMIC_ACTIVATION.providerCostMinor
    || !Number.isInteger(discountMinor) || discountMinor < 0
    || amountMinor + discountMinor !== providerProductCostMinor) {
    fail(`live paid row price mismatch for ${hashId(transactionId)}`);
  }
  if (!clientId && !clientPhone) fail(`live paid row client identity is missing for ${hashId(transactionId)}`);
  return {
    paymentRef,
    transactionId,
    productId,
    amountMinor,
    providerProductCostMinor,
    discountMinor,
    clientId,
    clientPhone,
  };
};

export function deriveLiveLegacyBaseline(rows, productId) {
  if (!Array.isArray(rows)) fail("live rows must be an array");
  const entries = [];
  const legacyRows = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("live row must be an object");
    if (row._id === PITER_ATOMIC_ACTIVATION.ledgerId || String(row._id || "").startsWith("piter-sale:")) continue;
    legacyRows.push(row);
    if (toStr(row.inventoryId) !== PITER_ATOMIC_ACTIVATION.inventoryId
      || toStr(row.counterKey) !== PITER_ATOMIC_ACTIVATION.counterKey) fail("live row is outside Piter scope");
    const status = normalizeStatus(row.status);
    if (TERMINAL_PAID.has(status)) entries.push(projectPaidEntry(row, productId));
    else if (!TERMINAL_FAILED.has(status)) fail(`live legacy row ${hashId(row._id)} is nonterminal`);
  }
  entries.sort((left, right) => left.paymentRef.localeCompare(right.paymentRef));
  const paymentRefs = entries.map((entry) => entry.paymentRef);
  const transactionIds = entries.map((entry) => entry.transactionId);
  if (new Set(paymentRefs).size !== entries.length || new Set(transactionIds).size !== entries.length) {
    fail("live paid baseline contains duplicate identities");
  }
  const digestSource = {
    formatVersion: 1,
    counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
    inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
    totalLimit: PITER_ATOMIC_ACTIVATION.totalLimit,
    entries,
  };
  return {
    digest: sha256(stableJson(digestSource)),
    paidCount: entries.length,
    reservedCount: 0,
    takenCount: entries.length,
    legacyPaymentRefs: paymentRefs,
    entries,
    legacyLedgerDigest: digestPiterLegacyLedgerRows(legacyRows),
  };
}

export function validateAtomicLedgerCustody(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) fail("atomic sentinel is missing");
  if (ledger._id !== PITER_ATOMIC_ACTIVATION.ledgerId
    || ledger.documentType !== "PITER_ATOMIC_INVENTORY_LEDGER"
    || ![1, 2].includes(ledger.schemaVersion)
    || typeof ledger.ready !== "boolean"
    || !Number.isInteger(ledger.revision) || ledger.revision < 0
    || !Number.isInteger(ledger.paidCount) || ledger.paidCount < 0
    || !Number.isInteger(ledger.reservedCount) || ledger.reservedCount < 0
    || !Number.isInteger(ledger.takenCount) || ledger.takenCount < 0
    || !/^[a-f0-9]{64}$/.test(toStr(ledger.baselineDigest) || "")
    || !/^[a-f0-9]{64}$/.test(toStr(ledger.activationContractDigest) || "")
    || !Array.isArray(ledger.legacyPaymentRefs)
    || !Array.isArray(ledger.reservations)) fail("atomic sentinel custody mismatch");
  return ledger;
}

export function validateAtomicLedgerShape(ledger, totalLimit = PITER_ATOMIC_ACTIVATION.totalLimit) {
  validateAtomicLedgerCustody(ledger);
  const quotaAdjustment = ledger.schemaVersion === 2 ? ledger.quotaAdjustment : 0;
  if ((ledger.schemaVersion === 1 && Object.hasOwn(ledger, "quotaAdjustment"))
    || !Number.isSafeInteger(quotaAdjustment) || quotaAdjustment < 0
    || (ledger.schemaVersion === 2 && ledger.legacyPaymentRefs.length + quotaAdjustment !== 50)
    || ledger.takenCount + quotaAdjustment > totalLimit) fail("atomic launch quota invariant mismatch");
  if (ledger.takenCount !== ledger.paidCount + ledger.reservedCount || ledger.takenCount > totalLimit) {
    fail("atomic sentinel invariant mismatch");
  }
  const legacyRefs = ledger.legacyPaymentRefs.map(toStr);
  const reservationRefs = ledger.reservations.map((item) => toStr(item?.paymentRef));
  const allowedStates = new Set([...ACTIVE_STATES, "PAID", "FAILED"]);
  if (legacyRefs.some((item) => !item) || reservationRefs.some((item) => !item)
    || ledger.reservations.some((item) => !allowedStates.has(item?.state))
    || new Set(legacyRefs).size !== legacyRefs.length
    || new Set(reservationRefs).size !== reservationRefs.length
    || reservationRefs.some((item) => legacyRefs.includes(item))) fail("atomic sentinel identity invariant mismatch");
  const active = ledger.reservations.filter((item) => ACTIVE_STATES.has(item?.state)).length;
  const paid = ledger.reservations.filter((item) => item?.state === "PAID").length;
  const activeIntents = ledger.reservations
    .filter((item) => ACTIVE_STATES.has(item?.state))
    .map((item) => toStr(item?.intentFingerprint));
  const transactionIds = ledger.reservations.map((item) => toStr(item?.transactionId)).filter(Boolean);
  if (ledger.reservedCount !== active || ledger.paidCount !== ledger.legacyPaymentRefs.length + paid) {
    fail("atomic sentinel count projection mismatch");
  }
  if (activeIntents.some((item) => !item) || new Set(activeIntents).size !== activeIntents.length
    || new Set(transactionIds).size !== transactionIds.length) fail("atomic sentinel active identity mismatch");
  return ledger;
}

const exactPacketBaseline = (packet, rows) => {
  const live = deriveLiveLegacyBaseline(rows, packet.product.id);
  if (stableJson(live) !== stableJson(packet.baseline)) fail("live legacy baseline drifted from the activation packet");
  return live;
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

export function buildPiterAtomicLedgerPlan({
  action,
  packet,
  documents,
  activeFlowSha256,
  expectedRevision = 0,
  now = new Date(),
  reason = null,
}) {
  const allowExpired = action === "deactivate" || action === "rollback-check";
  validatePiterAtomicActivationPacket(packet, { now, allowExpired });
  if (!Array.isArray(documents)) fail("current Piter documents are required");
  if (!["preflight", "seed", "activate", "deactivate", "rollback-check"].includes(action)) fail("unsupported action");
  if (["preflight", "seed", "activate"].includes(action)
    && activeFlowSha256 !== packet.deployment.candidateSha256) fail("active flow SHA does not match the reviewed candidate");

  const sentinels = documents.filter((row) => row?._id === packet.target.ledgerId);
  if (sentinels.length > 1) fail("multiple atomic sentinels found");
  const ledger = sentinels[0] || null;
  const atomicSales = documents.filter((row) => String(row?._id || "").startsWith(`piter-sale:${packet.target.inventoryId}:`));
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
    const document = buildPiterAtomicSentinel(packet, nowIso);
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

export function redactPiterAtomicLedgerPlan(plan) {
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

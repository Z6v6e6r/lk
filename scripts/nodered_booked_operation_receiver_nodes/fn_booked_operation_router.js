// Durable, idempotent booked-operation router.
//
// One document per operation_id in the existing `lk_subscription_daily_booking_ops`
// collection. The first accepted admission is written with `$setOnInsert`, so a
// repeated or racing POST can never overwrite the binding and never creates a
// second attempt. Missing/ambiguous storage fails closed and never reports
// CONFIRMED.
//
// Output 3 forwards a PENDING admission to the disabled-by-default execution
// adapter. It only does so when the verified delegation carried the complete
// actor-token/subscription binding (`execution.enabled`), the target is
// admissible and still in the future. The adapter itself writes the ATTEMPTING
// dispatch marker before any provider POST; an ATTEMPTING or terminal operation
// is never forwarded again.

const OUTPUT_UPSERT = 0;
const OUTPUT_RESPONSE = 1;
const OUTPUT_FIND = 2;
const OUTPUT_EXECUTE = 3;

const isObject = (value) => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value);
const toText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const isCanonicalIso = (value) => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const respond = (msg, statusCode, body) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  msg.payload = body;
  delete msg._bookedOperation;
  return [null, msg, null, null];
};
const reject = (msg, statusCode, code) => respond(msg, statusCode, { error: code, code });
const unavailable = (msg, code) => reject(msg, 503, code);

// Strict read outcome: PENDING/ATTEMPTING -> PENDING, CONFIRMED -> CONFIRMED,
// UNKNOWN -> UNKNOWN. REJECTED is a stable terminal 409 error payload: it is not
// confirmation evidence and never authorizes another purchase.
const outcome = (document, operationId) => {
  const state = toText(document && document.state);
  // asOf is durable updatedAt only: never the read clock and never a fallback
  // field, otherwise an invalid timestamp could look like confirmation evidence.
  const asOf = isCanonicalIso(document && document.updatedAt) ? document.updatedAt : null;
  if (state === "CONFIRMED" && asOf) {
    return {
      status: "CONFIRMED",
      statusCode: 200,
      payload: {
        asOf,
        contractVersion: document.contractVersion,
        operationId,
        reason: "OWNER_BOOKING_CONFIRMED",
        status: "CONFIRMED",
      },
    };
  }
  if (state === "PENDING" || state === "ATTEMPTING") {
    return {
      status: "PENDING",
      statusCode: 202,
      payload: {
        asOf,
        contractVersion: document.contractVersion,
        operationId,
        reason: "OWNER_PENDING",
        status: "PENDING",
      },
    };
  }
  if (state === "REJECTED") {
    return {
      status: "REJECTED",
      statusCode: 409,
      payload: {
        asOf,
        code: "BOOKED_OPERATION_REJECTED",
        contractVersion: document.contractVersion,
        error: "BOOKED_OPERATION_REJECTED",
        operationId,
        rejectionCode: toText(document && document.rejectionCode)
          || "PROVIDER_BOOKING_REJECTED",
      },
    };
  }
  return {
    status: "UNKNOWN",
    statusCode: 202,
    payload: {
      asOf,
      contractVersion: document.contractVersion,
      operationId,
      reason: "RECONCILIATION_REQUIRED",
      status: "UNKNOWN",
    },
  };
};
const respondOutcome = (msg, context, document) => {
  const mapped = outcome(document, context.operationId);
  if (document.contractVersion === 2 && mapped.status === "CONFIRMED") {
    mapped.status = "UNKNOWN"; mapped.statusCode = 202;
    mapped.payload = { contractVersion: 2, operationId: context.operationId, asOf: null,
      reason: "RECONCILIATION_REQUIRED", status: "UNKNOWN" };
  }
  if (context.mode === "read" && context.includeReceipt && document.reservationId
    && ["ATTEMPTING", "UNKNOWN", "CONFIRMED"].includes(document.state)
    && context.step !== "owner_receipt") {
    msg._bookedOperation = { ...context, step: "owner_receipt", stored: document };
    msg.payload = {
      operationId: document.operationId,
      tenantKey: document.tenantKey,
      actorClientId: document.providerClientId,
      exerciseId: document.providerExerciseId,
      clientSubscriptionId: document.providerClientSubscriptionId,
      state: "CONFIRMED",
    };
    return [null, null, msg, null];
  }
  if (mapped.status === "REJECTED") {
    return respond(msg, 409, mapped.payload);
  }
  return respond(
    msg,
    context.mode === "read" ? 200 : mapped.statusCode,
    mapped.payload,
  );
};
const bindingMatches = (document, context) => {
  if (
    !isObject(document)
    || document.kind !== "BOOKED_OPERATION_ADMISSION"
    || document.contractVersion !== (context.contractVersion || 1)
    || document.operationId !== context.operationId
    || document.tenantId !== context.identity.tenantId
    || document.userId !== context.identity.userId
    || document.providerClientId !== context.identity.providerClientId
    || document.providerMappingId !== context.identity.providerMappingId
  ) {
    return false;
  }
  // Session rotation and a fresh per-request correlation are expected on replay;
  // the actor, provider mapping and exact request binding are not.
  if (document.contractVersion === 2 && (!managedJoinV2Request(document.managedJoinV2)
    || typeof nodeCrypto === "undefined" || typeof nodeCrypto.createHash !== "function"
    || document.requestSha256 !== "sha256:" + nodeCrypto.createHash("sha256")
      .update("booked-operation-admission:v2\0" + JSON.stringify(managedJoinV2Request(document.managedJoinV2))).digest("hex")
    || document.managedJoinV2.target.id !== document.targetId
    || document.managedJoinV2.target.expectedRevision !== document.expectedRevision)) return false;
  return context.mode === "read"
    ? true
    : document.delegationBindingSha256 === context.bindingSha256;
};
// Only a PENDING admission with the complete, already verified token/subscription
// binding moves to the adapter. ATTEMPTING (a dispatched or in-flight write) and
// every terminal state are answered from the durable document instead.
const executionStart = (document, context) => {
  if (context.mode !== "admit" || context.executionSuppressed === true) return null;
  const execution = isObject(context.execution) ? context.execution : null;
  if (!execution || execution.enabled !== true || !toText(execution.actorToken)) return null;
  if (!isObject(document)) return null;
  const recoveryOnly = document.contractVersion === 2 && execution.recoveryOnlyRequested === true
    && ["ATTEMPTING", "UNKNOWN"].includes(document.state);
  if (execution.recoveryOnlyRequested === true && !recoveryOnly) return null;
  if (!recoveryOnly && document.state !== "PENDING") return null;
  if (!recoveryOnly && document.targetAdmissible !== true) return null;
  if (recoveryOnly && document.recovery?.leaseUntil && (!isCanonicalIso(document.recovery.leaseUntil)
    || Date.parse(document.recovery.leaseUntil) > Date.now())) return null;
  const startsAt = Date.parse(document.targetStartsAt);
  if (!recoveryOnly && (!Number.isFinite(startsAt) || startsAt <= Date.now())) return null;
  if (
    !toText(document.providerExerciseId)
    || !toText(document.providerClientId)
    || !toText(document.providerClientSubscriptionId)
    || !toText(document.tenantKey)
  ) {
    return null;
  }
  msg._bookedOperation = { ...context, step: "execute", stored: document, execution: { ...execution, recoveryOnly } };
  return [null, null, null, msg];
};

const context = isObject(msg._bookedOperation) ? msg._bookedOperation : null;
if (
  !context
  || !["admit", "read"].includes(context.mode)
  || !["find", "write", "readback", "owner_receipt"].includes(context.step)
  || !isObject(context.identity)
) {
  return reject(msg, 503, "BOOKED_OPERATION_ROUTER_CONTEXT_INVALID");
}

if (context.step === "owner_receipt") {
  const stored = context.stored;
  const rows = !msg.error && Array.isArray(msg.payload) ? msg.payload : [];
  const row = rows.length === 1 ? rows[0] : null;
  // Never treat the admission document or an incomplete managed entitlement as
  // proof. Bind the canonical owner's durable result to the exact original actor,
  // tenant, operation, exercise and subscription. No user token is needed here.
  let entitlement = null;
  if (stored.contractVersion === 2 && row) {
    const admission = managedJoinV2Request(stored.managedJoinV2);
    const decision = row.managedDecision;
    if (admission && JSON.stringify(row.managedJoinV2) === JSON.stringify(admission)
      && row.managedSubscriptionInstanceId === admission.entitlement.subscriptionInstanceId
      && managedJoinV2Id(row.managedEntitlementOperationId) && row.managedEntitlementState === "CONFIRMED"
      && decision?.decisionKind === "ENTITLEMENT" && decision.action === "JOIN_GAME"
      && decision.target?.targetId === stored.providerExerciseId
      && decision.policyVersion === admission.entitlement.expectations.policyVersion
      && decision.policyDigest === admission.entitlement.expectations.policyDigest
      && decision.money?.currency === "RUB" && decision.money.finalPriceMinor === 0
      && managedJoinV2Positive(decision.usageUnits)) {
      entitlement = { subscriptionInstanceId: row.managedSubscriptionInstanceId,
        policyRef: { policyVersion: decision.policyVersion, policyDigest: decision.policyDigest },
        usageRef: { usageRef: row.managedEntitlementOperationId, reservationUnits: decision.usageUnits } };
    }
  }
  if ((stored.contractVersion !== 2 || entitlement) && row && row.kind !== "BOOKED_OPERATION_ADMISSION"
    && row.operationId === stored.operationId && row.tenantKey === stored.tenantKey
    && row.actorClientId === stored.providerClientId
    && row.exerciseId === stored.providerExerciseId
    && row.clientSubscriptionId === stored.providerClientSubscriptionId
    && row.state === "CONFIRMED" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(row.bookingId || "")
    && isCanonicalIso(row.confirmedAt)
    && ["NOT_REQUIRED", "CONFIRMED"].includes(row.activationState)
    && (!row.managedEntitlementOperationId || row.managedEntitlementState === "CONFIRMED")) {
    const receipt = {
      contractVersion: stored.contractVersion, source: "LK1_SUBSCRIPTION_BOOKING_OWNER",
      operationId: stored.operationId, tenantId: stored.tenantId, userId: stored.userId,
      gameId: stored.targetId, reservationId: stored.reservationId,
      providerClientId: stored.providerClientId,
      providerClientSubscriptionId: stored.providerClientSubscriptionId,
      providerExerciseId: stored.providerExerciseId, providerMappingId: stored.providerMappingId,
      targetMappingId: stored.targetMappingId, targetVersion: stored.targetVersion,
      requestSha256: stored.requestSha256, idempotencyKeySha256: stored.idempotencyKeySha256,
      bookingId: row.bookingId, verifiedAt: row.confirmedAt,
      ...(entitlement ? { entitlement } : {}),
    };
    return respond(msg, 200, { asOf: row.confirmedAt, contractVersion: stored.contractVersion,
      operationId: context.operationId, reason: "OWNER_BOOKING_CONFIRMED", status: "CONFIRMED", receipt });
  }
  // Missing/ambiguous or subsequently cancelled owner result is never settlement
  // evidence, including when an older outer CONFIRMED document exists.
  return respond(msg, 200, { asOf: null, contractVersion: stored.contractVersion,
    operationId: context.operationId, reason: "RECONCILIATION_REQUIRED", status: "UNKNOWN" });
}

if (context.step === "find" || context.step === "readback") {
  if (msg.error) {
    return unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  }
  const rows = Array.isArray(msg.payload) ? msg.payload : null;
  if (!rows) {
    return unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  }
  if (rows.length > 1) {
    return context.mode === "read"
      ? reject(msg, 404, "BOOKED_OPERATION_NOT_FOUND")
      : unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  }
  if (rows.length === 0) {
    if (context.execution?.recoveryOnlyRequested === true) return reject(msg, 404, "BOOKED_OPERATION_NOT_FOUND");
    if (context.mode === "read" || context.step === "readback") {
      return context.mode === "read"
        ? reject(msg, 404, "BOOKED_OPERATION_NOT_FOUND")
        : unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
    }
    if (!isObject(context.document)) {
      return reject(msg, 503, "BOOKED_OPERATION_ROUTER_CONTEXT_INVALID");
    }
    // Atomic first-writer wins: a concurrent replay cannot replace the binding.
    msg._bookedOperation = { ...context, step: "write" };
    msg.payload = [
      { _id: context.operationId },
      { $setOnInsert: context.document },
      { upsert: true },
    ];
    return [msg, null, null, null];
  }
  const document = rows[0];
  if (!bindingMatches(document, context)) {
    return context.mode === "read"
      ? reject(msg, 404, "BOOKED_OPERATION_NOT_FOUND")
      : reject(msg, 409, "BOOKED_OPERATION_BINDING_CONFLICT");
  }
  if (context.step === "find" && context.mode === "admit") {
    const start = executionStart(document, context);
    if (start) return start;
  }
  return respondOutcome(msg, context, document);
}

if (context.step === "write") {
  if (msg.error) {
    // An ambiguous upsert acknowledgement is never success. The caller keeps the
    // attempt and the same idempotency key; a repeat reads the durable document.
    return unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  }
  const acknowledgement = isObject(msg.payload) ? msg.payload : null;
  if (!acknowledgement || acknowledgement.acknowledged !== true) {
    return unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
  }
  const upsertedId = toText(acknowledgement.upsertedId);
  const exactInsert = acknowledgement.upsertedCount === 1
    && upsertedId === context.operationId;
  const exactExisting = acknowledgement.upsertedCount === 0
    && Number(acknowledgement.matchedCount) === 1;
  if (exactInsert) {
    if (isObject(context.document) && context.mode === "admit") {
      const start = executionStart(context.document, context);
      if (start) return start;
    }
    return respondOutcome(msg, context, context.document);
  }
  if (exactExisting) {
    // Lost the race or lost the insert acknowledgement: recover by reading the
    // durable document. Never attempt a second write.
    msg._bookedOperation = { ...context, step: "readback" };
    msg.payload = { _id: context.operationId };
    return [null, null, msg, null];
  }
  return unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
}

return reject(msg, 503, "BOOKED_OPERATION_ROUTER_CONTEXT_INVALID");

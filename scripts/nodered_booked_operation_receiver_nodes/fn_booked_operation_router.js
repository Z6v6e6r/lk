// Durable, idempotent booked-operation router.
//
// One document per operation_id in the existing `lk_subscription_daily_booking_ops`
// collection. The first accepted admission is written with `$setOnInsert`, so a
// repeated or racing POST can never overwrite the binding and never creates a
// second attempt. Missing/ambiguous storage fails closed and never reports
// CONFIRMED. No provider call happens anywhere in this flow.

const OUTPUT_UPSERT = 0;
const OUTPUT_RESPONSE = 1;
const OUTPUT_FIND = 2;

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
  return [null, msg, null];
};
const reject = (msg, statusCode, code) => respond(msg, statusCode, { error: code, code });
const unavailable = (msg, code) => reject(msg, 503, code);

// Strict read outcome: only contractVersion, operationId, status, asOf, reason.
// REJECTED is deliberately reported as UNKNOWN/RECONCILIATION_REQUIRED: it is
// not confirmed booking evidence and never authorizes another purchase.
const outcome = (document, operationId) => {
  const state = toText(document && document.state);
  // asOf is durable updatedAt only: never the read clock and never a fallback
  // field, otherwise an invalid timestamp could look like confirmation evidence.
  const asOf = isCanonicalIso(document && document.updatedAt) ? document.updatedAt : null;
  if (state === "CONFIRMED" && asOf) {
    return {
      asOf,
      contractVersion: 1,
      operationId,
      reason: "OWNER_BOOKING_CONFIRMED",
      status: "CONFIRMED",
    };
  }
  if (state === "PENDING" && asOf) {
    return {
      asOf,
      contractVersion: 1,
      operationId,
      reason: "OWNER_PENDING",
      status: "PENDING",
    };
  }
  return {
    asOf,
    contractVersion: 1,
    operationId,
    reason: "RECONCILIATION_REQUIRED",
    status: "UNKNOWN",
  };
};
const bindingMatches = (document, context) => {
  if (
    !isObject(document)
    || document.kind !== "BOOKED_OPERATION_ADMISSION"
    || document.contractVersion !== 1
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
  return context.mode === "read"
    ? true
    : document.delegationBindingSha256 === context.bindingSha256;
};

const context = isObject(msg._bookedOperation) ? msg._bookedOperation : null;
if (
  !context
  || !["admit", "read"].includes(context.mode)
  || !["find", "write", "readback"].includes(context.step)
  || !isObject(context.identity)
) {
  return reject(msg, 503, "BOOKED_OPERATION_ROUTER_CONTEXT_INVALID");
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
    return [msg, null, null];
  }
  const document = rows[0];
  if (!bindingMatches(document, context)) {
    return context.mode === "read"
      ? reject(msg, 404, "BOOKED_OPERATION_NOT_FOUND")
      : reject(msg, 409, "BOOKED_OPERATION_BINDING_CONFLICT");
  }
  return respond(
    msg,
    context.mode === "read" ? 200 : 202,
    outcome(document, context.operationId),
  );
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
    return respond(msg, 202, outcome(context.document, context.operationId));
  }
  if (exactExisting) {
    // Lost the race or lost the insert acknowledgement: recover by reading the
    // durable document. Never attempt a second write.
    msg._bookedOperation = { ...context, step: "readback" };
    msg.payload = { _id: context.operationId };
    return [null, null, msg];
  }
  return unavailable(msg, "BOOKED_OPERATION_STORE_UNAVAILABLE");
}

return reject(msg, 503, "BOOKED_OPERATION_ROUTER_CONTEXT_INVALID");

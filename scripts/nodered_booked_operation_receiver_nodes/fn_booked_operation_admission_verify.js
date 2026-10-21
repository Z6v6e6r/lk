// POST /lk/integrations/v1/booked-operation-admissions - verify the LK2
// actor delegation and bind the canonical admission body before any write.
//
// This node performs no provider call and never invents a booking. It only
// produces the verified operation context and the exact Mongo lookup query.
// The delegation token is scrubbed before the message leaves this node.

const verification = bookedOperationVerifyDelegation(msg, env, "admit");
if (!verification.ok) {
  return [null, bookedOperationReject(msg, verification.statusCode, verification.code)];
}

const claims = verification.claims;
const reject = (statusCode, code) => [
  null,
  bookedOperationReject(msg, statusCode, code),
];

const headers = bookedOperationIsObject(msg.req) && bookedOperationIsObject(msg.req.headers)
  ? msg.req.headers
  : {};
const contentType = bookedOperationToText(headers["content-type"]);
if (!contentType || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) {
  return reject(400, "BOOKED_OPERATION_REQUEST_INVALID");
}

const parseAdmissionBody = (value) => {
  if (!bookedOperationIsObject(value)) return null;
  if (Object.keys(value).sort().join(",") !== "action,paymentIntent,target") return null;
  if (value.action !== "JOIN_GAME" || value.paymentIntent !== "USE_SUBSCRIPTION") return null;
  const target = value.target;
  if (!bookedOperationIsObject(target)) return null;
  if (Object.keys(target).sort().join(",") !== "expectedRevision,id") return null;
  if (!bookedOperationIsLowerUuid(target.id)) return null;
  if (!bookedOperationIsInteger(target.expectedRevision) || target.expectedRevision < 1) return null;
  return {
    action: "JOIN_GAME",
    target: { id: target.id, expectedRevision: target.expectedRevision },
    paymentIntent: "USE_SUBSCRIPTION",
  };
};
const body = parseAdmissionBody(msg.payload);
if (!body) return reject(400, "BOOKED_OPERATION_REQUEST_INVALID");

if (
  !BOOKED_OP_SHA256.test(bookedOperationToText(claims.request_sha256) || "")
  || !BOOKED_OP_SHA256.test(bookedOperationToText(claims.idempotency_key_sha256) || "")
  || !bookedOperationIsLowerUuid(claims.target_id)
  || !bookedOperationIsLowerUuid(claims.target_mapping_id)
  || !bookedOperationIsInteger(claims.expected_revision)
  || claims.expected_revision < 1
  || !BOOKED_OP_ID.test(bookedOperationToText(claims.provider_exercise_id) || "")
  || !BOOKED_OP_TARGET_VERSION.test(bookedOperationToText(claims.target_version) || "")
  || !bookedOperationIsCanonicalIso(claims.target_starts_at)
  || !bookedOperationIsInteger(claims.target_duration_minutes)
  || claims.target_duration_minutes < 1 || claims.target_duration_minutes > 1440
  || !bookedOperationIsInteger(claims.target_capacity)
  || claims.target_capacity < 1 || claims.target_capacity > 1000
  || typeof claims.target_admissible !== "boolean"
) {
  return reject(401, "BOOKED_OPERATION_DELEGATION_INVALID");
}

// Canonical admission body exactly as the LK2 issuer hashes it. Key order is
// fixed here, so the owner does not trust the client's JSON serialization.
const canonicalBody = JSON.stringify({
  action: "JOIN_GAME",
  target: { id: body.target.id, expectedRevision: body.target.expectedRevision },
  paymentIntent: "USE_SUBSCRIPTION",
});
const requestSha256 = bookedOperationSha256(BOOKED_OP_ADMISSION_PREFIX + canonicalBody);
if (requestSha256 !== claims.request_sha256) {
  return reject(403, "BOOKED_OPERATION_REQUEST_BINDING_MISMATCH");
}
if (
  claims.target_id !== body.target.id
  || claims.expected_revision !== body.target.expectedRevision
) {
  return reject(403, "BOOKED_OPERATION_REQUEST_BINDING_MISMATCH");
}

const nowIso = new Date().toISOString();
const document = {
  _id: claims.operation_id,
  kind: "BOOKED_OPERATION_ADMISSION",
  contractVersion: 1,
  operationId: claims.operation_id,
  state: "PENDING",
  stateReason: "OWNER_PENDING",
  tenantId: claims.tenant_id,
  tenantKey: claims.tenant_key,
  userId: claims.sub,
  sessionId: claims.sid,
  provider: "VIVA",
  providerClientId: claims.provider_client_id,
  providerMappingId: claims.provider_mapping_id,
  providerExerciseId: claims.provider_exercise_id,
  targetMappingId: claims.target_mapping_id,
  targetVersion: claims.target_version,
  targetId: claims.target_id,
  expectedRevision: claims.expected_revision,
  targetStartsAt: claims.target_starts_at,
  targetDurationMinutes: claims.target_duration_minutes,
  targetCapacity: claims.target_capacity,
  targetAdmissible: claims.target_admissible,
  requestSha256: claims.request_sha256,
  idempotencyKeySha256: claims.idempotency_key_sha256,
  delegationBindingSha256: verification.bindingSha256,
  delegation: {
    issuer: verification.config.issuer,
    audience: verification.config.audience,
    keyId: verification.config.keyId,
    caller: claims.caller,
    jti: claims.jti,
    correlationId: claims.correlation_id,
    issuedAt: new Date(claims.iat * 1000).toISOString(),
    notBefore: new Date(claims.nbf * 1000).toISOString(),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  },
  // Read-side association expected by the LK2 booked-operation read contract.
  padlHubOperation: {
    contractVersion: 1,
    operationId: claims.operation_id,
    tenantId: claims.tenant_id,
    userId: claims.sub,
    providerMappingId: claims.provider_mapping_id,
    issuer: verification.config.issuer,
    caller: claims.caller,
  },
  createdAt: nowIso,
  updatedAt: nowIso,
  attempts: [{
    at: nowIso,
    kind: "ADMISSION_ACCEPTED",
    correlationId: claims.correlation_id,
    delegationBindingSha256: verification.bindingSha256,
  }],
  receipts: [],
};

msg._bookedOperation = {
  mode: "admit",
  step: "find",
  operationId: claims.operation_id,
  bindingSha256: verification.bindingSha256,
  identity: {
    tenantId: claims.tenant_id,
    userId: claims.sub,
    providerClientId: claims.provider_client_id,
    providerMappingId: claims.provider_mapping_id,
  },
  document,
};
bookedOperationScrubDelegation(msg);
// The find node reads this payload as its query; no body/token survives.
msg.payload = { _id: claims.operation_id };
return [msg, null];

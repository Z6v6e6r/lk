// POST /lk/integrations/v2/booked-operation-preflights: verify the exact
// read-only actor delegation before any provider/CUP read. No Mongo output.
// The delegation token is scrubbed before the message leaves this node.

const verification = bookedOperationVerifyDelegation(msg, env, "preflight");
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

const body = managedJoinV2Request(msg.payload, true);
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
const canonicalBody = JSON.stringify(body);
const requestSha256 = bookedOperationSha256("booked-operation-preflight:v2\0" + canonicalBody);
if (requestSha256 !== claims.request_sha256) {
  return reject(403, "BOOKED_OPERATION_REQUEST_BINDING_MISMATCH");
}
if (
  claims.target_id !== body.target.id
  || claims.expected_revision !== body.target.expectedRevision
) {
  return reject(403, "BOOKED_OPERATION_REQUEST_BINDING_MISMATCH");
}

{
  const chars = nodeCrypto.createHash("sha256").update("booked-operation-admission:v1\0lk2-api\0"
    + claims.tenant_id + "\0" + claims.sub + "\0" + claims.idempotency_key_sha256).digest("hex").slice(0, 32).split("");
  chars[12] = "8"; chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join("");
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  if (claims.operation_id !== id) return reject(403, "BOOKED_OPERATION_REQUEST_BINDING_MISMATCH");
}

msg._bookedOperationPreflight = { step: "start", claims, body, actorToken: verification.actorToken };
bookedOperationScrubDelegation(msg);
msg.payload = undefined;
return [msg, null];

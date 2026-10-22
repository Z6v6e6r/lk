// GET /lk/integrations/v1/booked-operations/:operationId - verify the LK2
// actor delegation for a read and produce only the exact Mongo lookup query.
//
// Read never mutates state, never performs a provider request and never writes
// a receipt. A delegation issued for admission cannot pass this node.

const verification = bookedOperationVerifyDelegation(msg, env, "read");
if (!verification.ok) {
  return [null, bookedOperationReject(msg, verification.statusCode, verification.code)];
}

const claims = verification.claims;
const reject = (statusCode, code) => [
  null,
  bookedOperationReject(msg, statusCode, code),
];

const operationId = bookedOperationToText(msg.req && msg.req.params && msg.req.params.operationId);
if (!operationId || operationId !== claims.operation_id) {
  return reject(403, "BOOKED_OPERATION_DELEGATION_CONTEXT_MISMATCH");
}

msg._bookedOperation = {
  mode: "read",
  includeReceipt: claims.receipt_version === 1,
  step: "find",
  operationId: claims.operation_id,
  bindingSha256: verification.bindingSha256,
  identity: {
    tenantId: claims.tenant_id,
    userId: claims.sub,
    providerClientId: claims.provider_client_id,
    providerMappingId: claims.provider_mapping_id,
  },
};
bookedOperationScrubDelegation(msg);
msg.payload = { _id: claims.operation_id };
return [msg, null];

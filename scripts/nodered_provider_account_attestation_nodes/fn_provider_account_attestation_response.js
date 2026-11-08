// Single exit for the attestation and probe routes. Only the documented result or a closed code
// leaves LK1: never a credential, raw provider payload, phone, name or private context.
bookedOperationScrubDelegation(msg);
const status = Number(msg.statusCode);
const result = msg.payload;
const allowed = ["contractVersion", "operationId", "providerTenantKey", "providerClientId", "subscriptions",
  "attestedAt", "targetProof"];
const closed = (code) => paObject(result) && paKeys(result, "code") && result.code === code;
const ok = status === 200 && paObject(result) && (
  (result.capability === "PROVIDER_ACCOUNT_ATTESTATION" && paKeys(result, "capability,contractVersion,maxSubscriptions,targetProof"))
  || (Object.keys(result).every((k) => allowed.includes(k)) && result.contractVersion === 1
    && Array.isArray(result.subscriptions) && result.subscriptions.length <= PA_MAX_SUBSCRIPTIONS
    && Buffer.byteLength(JSON.stringify(result), "utf8") <= PA_MAX_BODY_BYTES));
const codes = { 400: "PROVIDER_ACCOUNT_REQUEST_INVALID", 401: ["PROVIDER_ACCOUNT_DELEGATION_REQUIRED", "PROVIDER_ACCOUNT_DELEGATION_INVALID"],
  403: ["PROVIDER_ACCOUNT_FORBIDDEN", "PROVIDER_ACCOUNT_CONTEXT_MISMATCH", "PROVIDER_ACCOUNT_ACTOR_TOKEN_INVALID"],
  404: "PROVIDER_ACCOUNT_ATTESTATION_PROBE_NOT_FOUND", 409: "PROVIDER_ACCOUNT_INVALID",
  503: "PROVIDER_ACCOUNT_UNAVAILABLE" };
const known = [codes[status]].flat().filter(Boolean).find((code) => closed(code));
const out = ok ? { statusCode: 200, payload: result }
  : known ? { statusCode: status, payload: { code: known } }
    : { statusCode: 503, payload: { code: "PROVIDER_ACCOUNT_UNAVAILABLE" } };
for (const key of Object.keys(msg)) if (!["_msgid", "req", "res"].includes(key)) delete msg[key];
msg.statusCode = out.statusCode;
msg.payload = out.payload;
msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer" };
return msg;

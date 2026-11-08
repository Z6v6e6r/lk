// Unauthenticated capability probe: GET with `X-Provider-Account-Attestation-Contract: 1`.
// It reveals only whether contract v1 is installed and enabled; it reads nothing.
const version = bookedOperationHeader(msg, "x-provider-account-attestation-contract");
const plain = paObject(msg.req) && String(msg.req.method || "").toUpperCase() === "GET"
  && String(msg.req.originalUrl || msg.req.url || "") === PA_PATH
  && (msg.req.query === undefined || (paObject(msg.req.query) && !Object.keys(msg.req.query).length));
if (!plain || version !== "1") return paReject(msg, 404, "PROVIDER_ACCOUNT_ATTESTATION_PROBE_NOT_FOUND");
if (!bookedOperationReadConfig(env).ok || !paEnabled(env)) return paReject(msg, 503, "PROVIDER_ACCOUNT_UNAVAILABLE");
msg.statusCode = 200;
msg.payload = { contractVersion: 1, capability: "PROVIDER_ACCOUNT_ATTESTATION", maxSubscriptions: PA_MAX_SUBSCRIPTIONS,
  targetProof: true };
return msg;

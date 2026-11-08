// Outputs: [verified -> router, refusal -> response]. Never logs, stores or forwards the
// delegation or the actor token beyond the private router context.
const fail = (status, code) => {
  bookedOperationScrubDelegation(msg);
  return [null, paReject(msg, status, code)];
};
const loaded = bookedOperationReadConfig(env);
if (!loaded.ok || !paEnabled(env)) return fail(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
const config = loaded.config;
if (!paObject(msg.req) || (msg.req.query !== undefined && !paObject(msg.req.query))
  || Object.keys(msg.req.query || {}).length) return fail(400, "PROVIDER_ACCOUNT_REQUEST_INVALID");
const token = bookedOperationHeader(msg, "x-subscription-actor-delegation");
if (!token) return fail(401, "PROVIDER_ACCOUNT_DELEGATION_REQUIRED");
const bad = () => fail(401, "PROVIDER_ACCOUNT_DELEGATION_INVALID");
if (!BOOKED_OP_TOKEN.test(token)) return bad();
const parts = token.split(".");
if (parts.length !== 3) return bad();
const bytes = parts.map(bookedOperationDecode);
if (bytes.some((x) => !x)) return bad();
const header = bookedOperationParseObject(bytes[0]);
// The booked-operation `typ` is refused here, and this `typ` is refused by every booking route.
if (!paKeys(header, "alg,kid,typ") || header.alg !== "RS256" || header.kid !== config.keyId
  || header.typ !== PA_TYPE) return bad();
let signed = false;
try {
  signed = nodeCrypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1], "utf8"),
    config.publicKeyPem, bytes[2]);
} catch (_error) {
  signed = false;
}
if (!signed) return bad();
const c = bookedOperationParseObject(bytes[1]);
if (!paObject(c) || Object.keys(c).sort().join(",") !== PA_CLAIMS) return bad();
const nowMs = Date.now();
const now = Math.floor(nowMs / 1000);
const skew = config.clockSkewSeconds;
if (c.iss !== config.issuer || c.aud !== config.audience || c.caller !== "lk2-api"
  || c.contract_version !== 1 || c.scope !== PA_SCOPE || c.provider !== "VIVA"
  || c.tenant_key !== PA_TENANT_KEY
  || ![c.sub, c.sid, c.jti, c.tenant_id, c.operation_id].every(paUuid)
  || ![c.iat, c.nbf, c.exp].every(bookedOperationIsInteger)
  || c.exp <= now || c.nbf > now + skew || c.iat > now + skew || c.exp <= c.iat
  || c.exp - c.iat > Math.min(PA_MAX_LIFETIME_SECONDS, config.maxLifetimeSeconds)
  || c.iat - c.nbf > skew
  || typeof c.correlation_id !== "string" || !BOOKED_OP_CORRELATION.test(c.correlation_id)
  || typeof c.request_sha256 !== "string" || !BOOKED_OP_SHA256.test(c.request_sha256)
  || typeof c.actor_token_sha256 !== "string" || !BOOKED_OP_SHA256.test(c.actor_token_sha256)
  || !bookedOperationIsCanonicalIso(c.actor_token_expires_at)) return bad();
if (c.method !== "POST" || c.path !== PA_PATH || String(msg.req.method || "").toUpperCase() !== "POST"
  || String(msg.req.originalUrl || msg.req.url || "") !== PA_PATH
  || bookedOperationHeader(msg, "x-correlation-id") !== c.correlation_id) {
  return fail(403, "PROVIDER_ACCOUNT_CONTEXT_MISMATCH");
}
const actorToken = bookedOperationHeader(msg, BOOKED_OP_ACTOR_TOKEN_HEADER);
if (!actorToken || /[\r\n]/.test(actorToken) || !bookedOperationTokenBindingMatches(actorToken, c.actor_token_sha256)
  || !(Date.parse(c.actor_token_expires_at) > nowMs + skew * 1000)) {
  return fail(403, "PROVIDER_ACCOUNT_ACTOR_TOKEN_INVALID");
}
const contentType = bookedOperationHeader(msg, "content-type");
const body = paRequest(msg.payload);
if (!contentType || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType) || !body
  || body.operationId !== c.operation_id || paRequestSha256(body) !== c.request_sha256) {
  return fail(400, "PROVIDER_ACCOUNT_REQUEST_INVALID");
}
// Replay is checked last, so an unauthenticated or mismatched request can never burn an id.
const remembered = paRemember(context, ["op:" + c.operation_id, "jti:" + c.jti],
  (c.exp + skew) * 1000, nowMs);
if (remembered === "REPLAY") return fail(409, "PROVIDER_ACCOUNT_INVALID");
if (remembered !== "OK") return fail(503, "PROVIDER_ACCOUNT_UNAVAILABLE");
bookedOperationScrubDelegation(msg);
msg._providerAccountAttestation = { step: "start", claims: c, body, actorToken };
msg.payload = undefined;
return [msg, null];

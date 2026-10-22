// Fail-closed verification prelude for the LK2 booked-operation receiver.
//
// The flow patcher embeds this exact source into both verification function
// nodes, so one reviewed implementation guards POST and GET. It is a function
// body (not a module): it is concatenated in front of the mode-specific body.
//
// The runtime supplies `nodeCrypto` through the function node external module
// entry {"var":"nodeCrypto","module":"crypto"}. Node-RED only refuses external
// modules when settings.js explicitly sets functionExternalModules:false; the
// embedded crypto module is a Node.js builtin (no extra npm dependency).
//
// The delegation token itself is never copied into msg.out, Mongo, logs or
// responses. Only verified claims and a binding hash leave this node.

const BOOKED_OP_ADMIT_PATH = "/lk/integrations/v1/booked-operation-admissions";
const BOOKED_OP_READ_PREFIX = "/lk/integrations/v1/booked-operations/";
const BOOKED_OP_ADMIT_SCOPE = "subscription-runtime.booked-operation.admit";
const BOOKED_OP_READ_SCOPE = "subscription-runtime.booked-operation.read";
const BOOKED_OP_DELEGATION_TYPE = "phub-subscription-runtime-actor-delegation+jwt";
const BOOKED_OP_ADMISSION_PREFIX = "booked-operation-admission:v1\0";
const BOOKED_OP_BINDING_PREFIX = "booked-operation-delegation:v1\0";
const BOOKED_OP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOKED_OP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const BOOKED_OP_CORRELATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const BOOKED_OP_TARGET_VERSION = /^[A-Za-z0-9._:-]{1,128}$/;
const BOOKED_OP_SHA256 = /^sha256:[a-f0-9]{64}$/;
const BOOKED_OP_TOKEN = /^[!-~]{1,4096}$/;
const BOOKED_OP_KEY_ID = /^[A-Za-z0-9._:-]{3,64}$/;
const BOOKED_OP_PRINTABLE = /^[!-~]+$/;
const BOOKED_OP_STANDARD_CLAIMS = ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"];
const BOOKED_OP_ADMIT_CLAIMS = [
  ...BOOKED_OP_STANDARD_CLAIMS,
  "contract_version", "scope", "caller", "method", "path", "operation_id",
  "tenant_id", "tenant_key", "sid", "provider", "provider_client_id",
  "provider_mapping_id", "correlation_id", "request_sha256",
  "idempotency_key_sha256", "target_id", "expected_revision", "target_mapping_id",
  "provider_exercise_id", "target_version", "target_starts_at",
  "target_duration_minutes", "target_capacity", "target_admissible",
];
const BOOKED_OP_READ_CLAIMS = [
  ...BOOKED_OP_STANDARD_CLAIMS,
  "contract_version", "scope", "caller", "method", "path", "operation_id",
  "tenant_id", "tenant_key", "sid", "provider", "provider_client_id",
  "provider_mapping_id", "correlation_id",
];
// Contract extension negotiated with LK2 for real execution. They are optional in
// the signed delegation so the current PENDING-only contract keeps verifying
// unchanged; the executor only runs when all required bindings are present.
const BOOKED_OP_ADMIT_OPTIONAL_CLAIMS = [
  "actor_token_sha256", "actor_token_expires_at", "provider_client_subscription_id",
];
const BOOKED_OP_ACTOR_TOKEN_HEADER = "x-subscription-actor-token";
const BOOKED_OP_ACTOR_TOKEN_HEADER_UPPER = "X-Subscription-Actor-Token";
const BOOKED_OP_ACTOR_TOKEN = /^[!-~]{16,4096}$/;
const BOOKED_OP_EXECUTION_ENABLED_VALUES = ["1", "true", "yes", "on"];

const bookedOperationIsObject = (value) => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value);
const bookedOperationToText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const bookedOperationEnv = (env, name) => {
  try {
    return bookedOperationToText(env.get(name));
  } catch (_error) {
    return null;
  }
};
const bookedOperationReject = (msg, statusCode, code) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  msg.payload = { error: code, code };
  delete msg._bookedOperation;
  return msg;
};
const bookedOperationInvalid = (statusCode, code) => ({ ok: false, statusCode, code });
const bookedOperationHeader = (msg, name) => {
  const headers = bookedOperationIsObject(msg.req) && bookedOperationIsObject(msg.req.headers)
    ? msg.req.headers
    : {};
  return bookedOperationToText(headers[name])
    || bookedOperationToText(headers[String(name).toLowerCase()]);
};
const bookedOperationScrubDelegation = (msg) => {
  if (bookedOperationIsObject(msg.req) && bookedOperationIsObject(msg.req.headers)) {
    delete msg.req.headers["x-subscription-actor-delegation"];
    delete msg.req.headers["X-Subscription-Actor-Delegation"];
    delete msg.req.headers[BOOKED_OP_ACTOR_TOKEN_HEADER];
    delete msg.req.headers[BOOKED_OP_ACTOR_TOKEN_HEADER_UPPER];
  }
};
const bookedOperationExecutionFlagEnabled = (env) => BOOKED_OP_EXECUTION_ENABLED_VALUES.includes(
  String(bookedOperationEnv(env, "BOOKED_OPERATION_EXECUTION_ENABLED") || "").toLowerCase(),
);
// Constant-time comparison of the header token hash with the signed claim.
const bookedOperationTokenBindingMatches = (token, claim) => {
  if (!BOOKED_OP_SHA256.test(bookedOperationToText(claim) || "")) return false;
  if (!BOOKED_OP_ACTOR_TOKEN.test(bookedOperationToText(token) || "")) return false;
  const expected = String(claim).slice("sha256:".length);
  const actual = nodeCrypto.createHash("sha256").update(token, "utf8").digest("hex");
  try {
    return nodeCrypto.timingSafeEqual(
      Buffer.from(actual, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch (_error) {
    return false;
  }
};
const bookedOperationDecode = (part) => {
  if (typeof part !== "string" || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
  try {
    const buffer = Buffer.from(part, "base64url");
    // Refuse non-canonical base64url so the signed bytes are the decoded bytes.
    return buffer.toString("base64url") === part ? buffer : null;
  } catch (_error) {
    return null;
  }
};
const bookedOperationParseObject = (buffer) => {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    return bookedOperationIsObject(value) ? value : null;
  } catch (_error) {
    return null;
  }
};
const bookedOperationIsInteger = (value) => typeof value === "number" && Number.isSafeInteger(value);
const bookedOperationIsLowerUuid = (value) => typeof value === "string"
  && BOOKED_OP_UUID.test(value)
  && value === value.toLowerCase();
const bookedOperationIsCanonicalIso = (value) => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const bookedOperationSha256 = (text) => "sha256:"
  + nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
const bookedOperationReadConfig = (env) => {
  const enabled = ["1", "true", "yes", "on"].includes(
    String(bookedOperationEnv(env, "LK1_BOOKED_OPERATION_RECEIVER_ENABLED") || "").toLowerCase(),
  );
  if (!enabled) return { ok: false };
  const issuer = bookedOperationEnv(env, "LK2_BOOKED_OPERATION_DELEGATION_ISSUER");
  const audience = bookedOperationEnv(env, "LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE");
  const keyId = bookedOperationEnv(env, "LK2_BOOKED_OPERATION_DELEGATION_KEY_ID");
  const publicKeyPem = (
    bookedOperationEnv(env, "LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM") || ""
  ).replace(/\\n/g, "\n");
  const lifetimeText = bookedOperationEnv(env, "LK2_BOOKED_OPERATION_DELEGATION_MAX_LIFETIME_SECONDS");
  const skewText = bookedOperationEnv(env, "LK2_BOOKED_OPERATION_DELEGATION_CLOCK_SKEW_SECONDS");
  const maxLifetimeSeconds = lifetimeText === null ? 120 : Number(lifetimeText);
  const clockSkewSeconds = skewText === null ? 5 : Number(skewText);
  if (
    !issuer || issuer.length > 512 || !BOOKED_OP_PRINTABLE.test(issuer)
    || !audience || audience.length > 256 || !BOOKED_OP_PRINTABLE.test(audience)
    || !keyId || !BOOKED_OP_KEY_ID.test(keyId)
    || !publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")
    || !publicKeyPem.includes("-----END PUBLIC KEY-----")
    || publicKeyPem.length > 8192
    || !bookedOperationIsInteger(maxLifetimeSeconds)
    || maxLifetimeSeconds < 10 || maxLifetimeSeconds > 300
    || !bookedOperationIsInteger(clockSkewSeconds)
    || clockSkewSeconds < 0 || clockSkewSeconds > 60
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    config: { issuer, audience, keyId, publicKeyPem, maxLifetimeSeconds, clockSkewSeconds },
  };
};
const bookedOperationBindingSha256 = (claims) => bookedOperationSha256(
  BOOKED_OP_BINDING_PREFIX + JSON.stringify([
    claims.iss,
    claims.aud,
    claims.sub,
    claims.tenant_id,
    claims.tenant_key,
    claims.provider,
    claims.provider_client_id,
    claims.provider_mapping_id,
    claims.operation_id,
    claims.method,
    claims.path,
    claims.request_sha256 === undefined ? null : claims.request_sha256,
    claims.idempotency_key_sha256 === undefined ? null : claims.idempotency_key_sha256,
    claims.target_id === undefined ? null : claims.target_id,
    claims.expected_revision === undefined ? null : claims.expected_revision,
    claims.target_mapping_id === undefined ? null : claims.target_mapping_id,
    claims.provider_exercise_id === undefined ? null : claims.provider_exercise_id,
    claims.target_version === undefined ? null : claims.target_version,
    claims.target_starts_at === undefined ? null : claims.target_starts_at,
    claims.target_duration_minutes === undefined ? null : claims.target_duration_minutes,
    claims.target_capacity === undefined ? null : claims.target_capacity,
    claims.target_admissible === undefined ? null : claims.target_admissible,
    claims.provider_client_subscription_id === undefined
      ? null
      : claims.provider_client_subscription_id,
  ]),
);

// Returns {ok:true, claims, config, bindingSha256} or a stable failure code.
// `mode` is "admit" (POST) or "read" (GET); each mode has an exact claim set.
const bookedOperationVerifyDelegation = (msg, env, mode) => {
  const loaded = bookedOperationReadConfig(env);
  if (!loaded.ok) {
    return bookedOperationInvalid(503, "BOOKED_OPERATION_RECEIVER_UNAVAILABLE");
  }
  const config = loaded.config;
  if (!bookedOperationIsObject(msg.req)) {
    return bookedOperationInvalid(400, "BOOKED_OPERATION_REQUEST_INVALID");
  }
  const query = msg.req.query;
  if (bookedOperationIsObject(query) && Object.keys(query).length > 0) {
    return bookedOperationInvalid(400, "BOOKED_OPERATION_REQUEST_INVALID");
  }
  const token = bookedOperationHeader(msg, "x-subscription-actor-delegation");
  if (!token) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_REQUIRED");
  }
  if (!BOOKED_OP_TOKEN.test(token)) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const headerBuffer = bookedOperationDecode(parts[0]);
  const payloadBuffer = bookedOperationDecode(parts[1]);
  const signatureBuffer = bookedOperationDecode(parts[2]);
  if (!headerBuffer || !payloadBuffer || !signatureBuffer) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const header = bookedOperationParseObject(headerBuffer);
  if (
    !header
    || Object.keys(header).sort().join(",") !== "alg,kid,typ"
    || header.alg !== "RS256"
    || header.typ !== BOOKED_OP_DELEGATION_TYPE
    || header.kid !== config.keyId
  ) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  let signatureValid = false;
  try {
    // Node.js builtin RSA PKCS#1 v1.5 verification; no hand-written crypto.
    signatureValid = nodeCrypto.verify(
      "RSA-SHA256",
      Buffer.from(parts[0] + "." + parts[1], "utf8"),
      config.publicKeyPem,
      signatureBuffer,
    );
  } catch (_error) {
    signatureValid = false;
  }
  if (!signatureValid) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const claims = bookedOperationParseObject(payloadBuffer);
  if (!claims) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const requiredClaims = (mode === "admit" ? BOOKED_OP_ADMIT_CLAIMS : BOOKED_OP_READ_CLAIMS)
    .slice()
    .sort();
  const optionalClaims = mode === "admit" ? BOOKED_OP_ADMIT_OPTIONAL_CLAIMS : [];
  const actualClaims = Object.keys(claims).sort();
  if (
    requiredClaims.some((key) => !Object.hasOwn(claims, key))
    || actualClaims.some((key) => !requiredClaims.includes(key) && !optionalClaims.includes(key))
  ) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  if (
    mode === "admit"
    && (
      (claims.actor_token_sha256 !== undefined
        && !BOOKED_OP_SHA256.test(bookedOperationToText(claims.actor_token_sha256) || ""))
      || (claims.actor_token_expires_at !== undefined
        && !bookedOperationIsCanonicalIso(claims.actor_token_expires_at))
      || (claims.actor_token_expires_at !== undefined && claims.actor_token_sha256 === undefined)
      || (claims.provider_client_subscription_id !== undefined
        && !BOOKED_OP_ID.test(
          bookedOperationToText(claims.provider_client_subscription_id) || "",
        ))
    )
  ) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== config.issuer
    || claims.aud !== config.audience
    || !bookedOperationIsLowerUuid(claims.sub)
    || !bookedOperationIsLowerUuid(claims.jti)
    || !bookedOperationIsInteger(claims.iat)
    || !bookedOperationIsInteger(claims.nbf)
    || !bookedOperationIsInteger(claims.exp)
    || claims.exp <= now - config.clockSkewSeconds
    || claims.nbf > now + config.clockSkewSeconds
    || claims.iat > now + config.clockSkewSeconds
    || claims.exp <= claims.iat
    || claims.exp - claims.iat > config.maxLifetimeSeconds
    || claims.iat - claims.nbf > config.clockSkewSeconds
  ) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  if (
    claims.contract_version !== 1
    || claims.provider !== "VIVA"
    || !bookedOperationToText(claims.tenant_key)
    || !BOOKED_OP_ID.test(bookedOperationToText(claims.tenant_key) || "")
    || !bookedOperationIsLowerUuid(claims.operation_id)
    || !bookedOperationIsLowerUuid(claims.tenant_id)
    || !bookedOperationIsLowerUuid(claims.sid)
    || !bookedOperationIsLowerUuid(claims.provider_mapping_id)
    || !BOOKED_OP_ID.test(bookedOperationToText(claims.provider_client_id) || "")
    || !BOOKED_OP_CORRELATION.test(bookedOperationToText(claims.correlation_id) || "")
  ) {
    return bookedOperationInvalid(401, "BOOKED_OPERATION_DELEGATION_INVALID");
  }
  const expectedScope = mode === "admit" ? BOOKED_OP_ADMIT_SCOPE : BOOKED_OP_READ_SCOPE;
  const expectedMethod = mode === "admit" ? "POST" : "GET";
  const expectedPath = mode === "admit"
    ? BOOKED_OP_ADMIT_PATH
    : BOOKED_OP_READ_PREFIX + claims.operation_id;
  if (
    claims.caller !== "lk2-api"
    || claims.scope !== expectedScope
    || claims.method !== expectedMethod
    || claims.path !== expectedPath
    || String(msg.req.method || "").toUpperCase() !== expectedMethod
  ) {
    return bookedOperationInvalid(403, "BOOKED_OPERATION_DELEGATION_SCOPE_INVALID");
  }
  const correlationHeader = bookedOperationHeader(msg, "x-correlation-id");
  if (!correlationHeader || correlationHeader !== claims.correlation_id) {
    return bookedOperationInvalid(403, "BOOKED_OPERATION_DELEGATION_CONTEXT_MISMATCH");
  }
  // Contract extension for real execution: the signed delegation binds the exact
  // user-scoped Viva token the caller must present in the wire header. A token
  // without that claim is never used, and a header token must never be swapped
  // across delegations.
  let actorToken = null;
  if (mode === "admit" && claims.actor_token_sha256 !== undefined) {
    const headerToken = bookedOperationHeader(msg, BOOKED_OP_ACTOR_TOKEN_HEADER);
    if (!headerToken) {
      return bookedOperationInvalid(403, "BOOKED_OPERATION_ACTOR_TOKEN_REQUIRED");
    }
    if (!bookedOperationTokenBindingMatches(headerToken, claims.actor_token_sha256)) {
      return bookedOperationInvalid(403, "BOOKED_OPERATION_ACTOR_TOKEN_MISMATCH");
    }
    if (claims.actor_token_expires_at !== undefined) {
      const expiry = Date.parse(claims.actor_token_expires_at);
      if (!Number.isFinite(expiry) || expiry <= Date.now() + config.clockSkewSeconds * 1000) {
        return bookedOperationInvalid(403, "BOOKED_OPERATION_ACTOR_TOKEN_EXPIRED");
      }
    }
    actorToken = headerToken;
  }
  return {
    ok: true,
    actorToken,
    actorTokenExpiresAt: claims.actor_token_expires_at === undefined
      ? null
      : claims.actor_token_expires_at,
    actorTokenSha256: claims.actor_token_sha256 === undefined
      ? null
      : claims.actor_token_sha256,
    claims,
    config,
    bindingSha256: bookedOperationBindingSha256(claims),
  };
};

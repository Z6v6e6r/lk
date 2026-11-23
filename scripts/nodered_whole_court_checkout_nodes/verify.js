// Private LK2 backend command. The browser never supplies provider identity or return URLs.
const refuse = (status, code) => [null, wholeCourtReply(status, { code })];
const loaded = bookedOperationReadConfig(env);
const target = wholeCourtConfig();
if (!target || !loaded.ok || !bookedOperationExecutionFlagEnabled(env))
  return refuse(503, 'WHOLE_COURT_UNAVAILABLE');
const config = loaded.config;
if (
  !gcObject(msg.req) ||
  !gcObject(msg.req.query || {}) ||
  Object.keys(msg.req.query || {}).length ||
  msg.req.method !== 'POST' ||
  !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
    bookedOperationHeader(msg, 'content-type') || '',
  )
)
  return refuse(400, 'WHOLE_COURT_REQUEST_INVALID');
const path = msg.req.originalUrl || msg.req.url;
const mode =
  path === wholeCourtPrefix + '/reserve'
    ? 'reserve'
    : path === wholeCourtPrefix + '/confirm'
      ? 'confirm'
      : null;
const token = bookedOperationHeader(msg, 'x-subscription-actor-delegation');
if (!mode || !token || !BOOKED_OP_TOKEN.test(token))
  return refuse(401, 'WHOLE_COURT_DELEGATION_INVALID');
const parts = token.split('.');
const bytes = parts.map(bookedOperationDecode);
if (parts.length !== 3 || bytes.some((value) => value === null))
  return refuse(401, 'WHOLE_COURT_DELEGATION_INVALID');
const h = bookedOperationParseObject(bytes[0]);
const c = bookedOperationParseObject(bytes[1]);
const now = Math.floor(Date.now() / 1000);
if (
  !gcKeys(h, 'alg,kid,typ') ||
  h.alg !== 'RS256' ||
  h.kid !== config.keyId ||
  h.typ !== BOOKED_OP_DELEGATION_TYPE ||
  !gcKeys(c, wholeCourtClaims) ||
  c.iss !== config.issuer ||
  c.aud !== config.audience ||
  c.contract_version !== 1 ||
  c.caller !== 'lk2-api' ||
  c.provider !== 'VIVA' ||
  c.tenant_key !== wholeCourtTenant ||
  c.scope !== 'game-create.whole-court.' + mode ||
  c.method !== 'POST' ||
  c.path !== path ||
  ![c.sub, c.sid, c.jti, c.tenant_id, c.operation_id].every(gcUuid) ||
  !gcId(c.provider_client_id) ||
  ![c.request_sha256, c.idempotency_key_sha256, c.actor_token_sha256].every(gcDigest) ||
  !gcIso(c.actor_token_expires_at) ||
  !wholeCourtFresh(c) ||
  ![c.exp, c.iat, c.nbf].every(Number.isSafeInteger) ||
  c.nbf > c.exp ||
  c.iat > now + config.clockSkewSeconds ||
  c.nbf > now + config.clockSkewSeconds ||
  c.exp <= c.iat ||
  c.exp - c.iat > config.maxLifetimeSeconds ||
  typeof c.correlation_id !== 'string' ||
  !BOOKED_OP_CORRELATION.test(c.correlation_id) ||
  /[\r\n]/.test(c.correlation_id) ||
  bookedOperationHeader(msg, 'x-correlation-id') !== c.correlation_id
)
  return refuse(401, 'WHOLE_COURT_DELEGATION_INVALID');
try {
  if (
    !nodeCrypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      config.publicKeyPem,
      bytes[2],
    )
  )
    return refuse(401, 'WHOLE_COURT_DELEGATION_INVALID');
} catch {
  return refuse(401, 'WHOLE_COURT_DELEGATION_INVALID');
}
const actorToken = bookedOperationHeader(msg, BOOKED_OP_ACTOR_TOKEN_HEADER);
const body = wholeCourtBody(msg.payload);
if (
  !body ||
  c.operation_id !== body.operationId ||
  gcOperationId(c) !== c.operation_id ||
  bookedOperationSha256('whole-court:' + mode + ':v1\0' + JSON.stringify(body)) !==
    c.request_sha256 ||
  !bookedOperationTokenBindingMatches(actorToken, c.actor_token_sha256) ||
  !wholeCourtTargetMatches(target, c, body)
)
  return refuse(403, 'WHOLE_COURT_BINDING_MISMATCH');
msg._wholeCourt = { phase: 'start', mode, claims: c, body, actorToken };
bookedOperationScrubDelegation(msg);
msg.payload = undefined;
return [msg, null];

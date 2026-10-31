const fail = (status, code) => [null, gcReject(msg, status, code)];
const loaded = bookedOperationReadConfig(env);
if (!loaded.ok || !bookedOperationExecutionFlagEnabled(env))
  return fail(503, 'GAME_CREATE_PREPARATION_UNAVAILABLE');
const config = loaded.config;
if (!gcObject(msg.req) || !gcObject(msg.req.query || {}) || Object.keys(msg.req.query || {}).length)
  return fail(400, 'GAME_CREATE_PREPARATION_REQUEST_INVALID');
const token = bookedOperationHeader(msg, 'x-subscription-actor-delegation');
if (!token || !BOOKED_OP_TOKEN.test(token))
  return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
const parts = token.split('.');
if (parts.length !== 3) return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
const bytes = parts.map(bookedOperationDecode);
if (bytes.some((x) => !x)) return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
const header = bookedOperationParseObject(bytes[0]);
if (
  !gcKeys(header, 'alg,kid,typ') ||
  header.alg !== 'RS256' ||
  header.kid !== config.keyId ||
  header.typ !== BOOKED_OP_DELEGATION_TYPE
)
  return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
try {
  if (
    !nodeCrypto.verify(
      'RSA-SHA256',
      Buffer.from(parts[0] + '.' + parts[1]),
      config.publicKeyPem,
      bytes[2],
    )
  )
    return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
} catch {
  return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
}
const c = bookedOperationParseObject(bytes[1]);
const fields =
  'iss,aud,sub,iat,nbf,exp,jti,sid,contract_version,caller,scope,method,path,tenant_id,tenant_key,provider,provider_client_id,provider_mapping_id,subscription_id,provider_client_subscription_id,operation_id,idempotency_key_sha256,request_sha256,correlation_id,actor_token_sha256,actor_token_expires_at,draft_id,expected_revision,station_id,court_id,station_mapping_id,court_mapping_id,mapping_version,provider_station_id,provider_room_id';
if (!gcKeys(c, fields)) return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
const now = Math.floor(Date.now() / 1000);
if (
  c.iss !== config.issuer ||
  c.aud !== config.audience ||
  c.caller !== 'lk2-api' ||
  c.contract_version !== 1 ||
  c.tenant_key !== 'iSkq6G' ||
  c.provider !== 'VIVA' ||
  ![
    c.sub,
    c.jti,
    c.sid,
    c.tenant_id,
    c.provider_mapping_id,
    c.subscription_id,
    c.operation_id,
    c.draft_id,
    c.station_id,
    c.court_id,
    c.station_mapping_id,
    c.court_mapping_id,
  ].every(gcUuid) ||
  ![
    c.provider_client_id,
    c.provider_client_subscription_id,
    c.provider_station_id,
    c.provider_room_id,
    c.mapping_version,
  ].every(gcId) ||
  !Number.isSafeInteger(c.expected_revision) ||
  c.expected_revision < 1 ||
  ![c.iat, c.nbf, c.exp].every(Number.isSafeInteger) ||
  c.exp <= now ||
  c.nbf > now + config.clockSkewSeconds ||
  c.iat > now + config.clockSkewSeconds ||
  c.exp <= c.iat ||
  c.exp - c.iat > config.maxLifetimeSeconds ||
  c.iat - c.nbf > config.clockSkewSeconds ||
  typeof c.correlation_id !== 'string' ||
  !BOOKED_OP_CORRELATION.test(c.correlation_id) ||
  /[\r\n]/.test(c.correlation_id)
)
  return fail(401, 'GAME_CREATE_PREPARATION_DELEGATION_INVALID');
if (
  c.scope !== 'subscription-runtime.game-create.prepare' ||
  c.path !== gcPath ||
  c.method !== 'POST' ||
  (msg.req.originalUrl || msg.req.url) !== gcPath ||
  msg.req.method !== 'POST' ||
  bookedOperationHeader(msg, 'x-correlation-id') !== c.correlation_id
)
  return fail(403, 'GAME_CREATE_PREPARATION_CONTEXT_MISMATCH');
const actorToken = bookedOperationHeader(msg, BOOKED_OP_ACTOR_TOKEN_HEADER);
if (
  ![c.request_sha256, c.idempotency_key_sha256, c.actor_token_sha256].every(gcDigest) ||
  !gcIso(c.actor_token_expires_at) ||
  Date.parse(c.actor_token_expires_at) <= Date.now() + config.clockSkewSeconds * 1000 ||
  !bookedOperationTokenBindingMatches(actorToken, c.actor_token_sha256) ||
  gcOperationId(c) !== c.operation_id
)
  return fail(403, 'GAME_CREATE_PREPARATION_BINDING_MISMATCH');
const body = gcRequest(msg.payload);
const contentType = bookedOperationHeader(msg, 'content-type');
if (
  !contentType ||
  !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType) ||
  !body ||
  Date.parse(body.target.startsAt) <= Date.now() ||
  body.subscriptionId !== c.subscription_id ||
  body.target.draftId !== c.draft_id ||
  body.target.expectedRevision !== c.expected_revision ||
  body.target.stationId !== c.station_id ||
  body.target.courtId !== c.court_id ||
  gcHash('game-create-preparation:v1\0' + JSON.stringify(body)) !== c.request_sha256
)
  return fail(400, 'GAME_CREATE_PREPARATION_REQUEST_INVALID');
msg._gameCreatePreparation = { step: 'start', claims: c, body, actorToken };
bookedOperationScrubDelegation(msg);
msg.payload = undefined;
return [msg, null];

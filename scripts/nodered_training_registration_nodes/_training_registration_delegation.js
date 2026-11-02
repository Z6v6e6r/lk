const trVerify = (msg, env, mode) => {
  const fail = (statusCode, code) => ({ ok: false, statusCode, code });
  const loaded = bookedOperationReadConfig(env);
  if (!loaded.ok || !bookedOperationExecutionFlagEnabled(env))
    return fail(503, 'TRAINING_REGISTRATION_UNAVAILABLE');
  const config = loaded.config;
  if (
    !trObject(msg.req) ||
    !trObject(msg.req.query || {}) ||
    Object.keys(msg.req.query || {}).length
  )
    return fail(400, 'TRAINING_REGISTRATION_REQUEST_INVALID');
  const token = bookedOperationHeader(msg, 'x-subscription-actor-delegation');
  if (!token || !BOOKED_OP_TOKEN.test(token))
    return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  const parts = token.split('.');
  if (parts.length !== 3) return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  const bytes = parts.map(bookedOperationDecode);
  if (bytes.some((x) => !x)) return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  const h = bookedOperationParseObject(bytes[0]);
  if (
    !trKeys(h, 'alg,kid,typ') ||
    h.alg !== 'RS256' ||
    h.kid !== config.keyId ||
    h.typ !== BOOKED_OP_DELEGATION_TYPE
  )
    return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  try {
    if (
      !nodeCrypto.verify(
        'RSA-SHA256',
        Buffer.from(parts[0] + '.' + parts[1]),
        config.publicKeyPem,
        bytes[2],
      )
    )
      return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  } catch {
    return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  }
  const c = bookedOperationParseObject(bytes[1]);
  const required =
    'iss,aud,sub,iat,nbf,exp,jti,contract_version,caller,scope,method,path,operation_id,tenant_id,tenant_key,sid,provider,provider_client_id,provider_mapping_id,subscription_id,provider_client_subscription_id,idempotency_key_sha256,target_id,date_hint,request_sha256,actor_token_sha256,actor_token_expires_at,correlation_id';
  if (
    !c ||
    !trKeys(
      c,
      required + (mode === 'admit' && Object.hasOwn(c, 'recovery_only') ? ',recovery_only' : ''),
    )
  )
    return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  const now = Math.floor(Date.now() / 1000);
  if (
    c.iss !== config.issuer ||
    c.aud !== config.audience ||
    c.caller !== 'lk2-api' ||
    c.contract_version !== 1 ||
    c.provider !== 'VIVA' ||
    c.tenant_key !== 'iSkq6G' ||
    ![
      c.sub,
      c.jti,
      c.tenant_id,
      c.sid,
      c.operation_id,
      c.provider_mapping_id,
      c.subscription_id,
      c.target_id,
    ].every(trUuid) ||
    ![c.provider_client_id, c.provider_client_subscription_id].every(trId) ||
    !trDate(c.date_hint) ||
    ![c.iat, c.nbf, c.exp].every(bookedOperationIsInteger) ||
    c.exp <= now - config.clockSkewSeconds ||
    c.nbf > now + config.clockSkewSeconds ||
    c.iat > now + config.clockSkewSeconds ||
    c.exp <= c.iat ||
    c.exp - c.iat > config.maxLifetimeSeconds ||
    c.iat - c.nbf > config.clockSkewSeconds ||
    typeof c.correlation_id !== 'string' ||
    !BOOKED_OP_CORRELATION.test(c.correlation_id) ||
    /[\r\n]/.test(c.correlation_id) ||
    (Object.hasOwn(c, 'recovery_only') && c.recovery_only !== true)
  )
    return fail(401, 'TRAINING_REGISTRATION_DELEGATION_INVALID');
  const path = trPaths[mode] + (mode === 'read' ? c.operation_id : '');
  if (
    c.scope !== 'subscription-runtime.training-registration.' + mode ||
    c.path !== path ||
    c.method !== (mode === 'read' ? 'GET' : 'POST') ||
    (msg.req.originalUrl || msg.req.url) !== path ||
    msg.req.method !== c.method ||
    bookedOperationHeader(msg, 'x-correlation-id') !== c.correlation_id
  )
    return fail(403, 'TRAINING_REGISTRATION_CONTEXT_MISMATCH');
  const actorToken = bookedOperationHeader(msg, BOOKED_OP_ACTOR_TOKEN_HEADER);
  if (
    ![c.request_sha256, c.idempotency_key_sha256, c.actor_token_sha256].every(trDigest) ||
    !trIso(c.actor_token_expires_at) ||
    Date.parse(c.actor_token_expires_at) <= Date.now() + config.clockSkewSeconds * 1000 ||
    !bookedOperationTokenBindingMatches(actorToken, c.actor_token_sha256) ||
    trOperationId(c) !== c.operation_id
  )
    return fail(403, 'TRAINING_REGISTRATION_BINDING_MISMATCH');
  let request = null;
  if (mode === 'read') {
    if (
      msg.payload !== undefined &&
      msg.payload !== null &&
      !(trObject(msg.payload) && !Object.keys(msg.payload).length)
    )
      return fail(400, 'TRAINING_REGISTRATION_REQUEST_INVALID');
    if (
      c.request_sha256 !==
      trHash('training-registration-read:v1\0' + JSON.stringify({ operationId: c.operation_id }))
    )
      return fail(400, 'TRAINING_REGISTRATION_REQUEST_INVALID');
  } else {
    const contentType = bookedOperationHeader(msg, 'content-type');
    request = trRequest(msg.payload, mode === 'admit');
    if (
      !contentType ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType) ||
      !request ||
      request.target.id !== c.target_id ||
      request.target.dateHint !== c.date_hint ||
      request.subscriptionId !== c.subscription_id ||
      trHash(
        'training-registration-' +
          (mode === 'admit' ? 'admission' : 'prepare') +
          ':v1\0' +
          JSON.stringify(request),
      ) !== c.request_sha256 ||
      (mode === 'admit' && !trCapsuleClaims(request.preparation, c))
    )
      return fail(400, 'TRAINING_REGISTRATION_REQUEST_INVALID');
  }
  return { ok: true, claims: c, actorToken, request };
};

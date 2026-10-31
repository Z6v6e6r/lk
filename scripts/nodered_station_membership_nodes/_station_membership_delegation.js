function smVerify(msg, env, mode) {
  const get = key => { try { return env.get(key); } catch { return undefined; } };
  if (get(SM_FLAG) !== 'true') return { code: 'STATION_MEMBERSHIP_DISABLED', status: 503 };
  const issuer = get('LK2_BOOKED_OPERATION_DELEGATION_ISSUER'), audience = get('LK2_STATION_MEMBERSHIP_DELEGATION_AUDIENCE');
  const kid = get('LK2_BOOKED_OPERATION_DELEGATION_KEY_ID'), publicKey = get('LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM');
  if (![issuer, audience, kid, publicKey].every(x => typeof x === 'string' && x.length > 0)) return { code: 'STATION_MEMBERSHIP_AUTH_UNAVAILABLE', status: 503 };
  const invalid = { code: 'STATION_MEMBERSHIP_DELEGATION_INVALID', status: 401 };
  const token = msg.req?.headers?.['x-station-membership-delegation'];
  if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return invalid;
  try {
    const parts = token.split('.'), header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!smKeys(header, ['alg', 'kid', 'typ']) || header.alg !== 'RS256' || header.kid !== kid || header.typ !== 'phub-station-membership-delegation+jwt') return invalid;
    if (!nodeCrypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), publicKey, Buffer.from(parts[2], 'base64url'))) return invalid;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const common = ['iss','aud','sub','jti','iat','nbf','exp','tenant_id','provider_client_id','provider_mapping_id','operation_id','caller','scope','method','path','body_sha256','correlation_id','contract_version'];
    if (!smKeys(c, [...common, ...(mode === 'admission' ? ['sid','fresh_operation','adoption_version'] : ['persisted_fact'])])) return invalid;
    const now = Math.floor(Date.now() / 1000);
    if (c.iss !== issuer || c.aud !== audience || ![c.sub,c.jti,c.tenant_id,c.provider_mapping_id,c.operation_id].every(smUuid) || !smId(c.provider_client_id) ||
      ![c.iat,c.nbf,c.exp].every(Number.isSafeInteger) || c.exp <= now - 5 || c.nbf > now + 5 || c.iat > now + 5 || c.exp <= c.iat || c.exp - c.iat > 120 || Math.abs(c.nbf - c.iat) > 5 || c.contract_version !== 1) return invalid;
    if (mode === 'admission' ? c.caller !== 'lk2-api' || !smUuid(c.sid) || c.fresh_operation !== true || c.adoption_version !== 1
      : !['lk2-api','lk2-worker'].includes(c.caller) || c.persisted_fact !== true) return invalid;
    const path = smPath(c.operation_id, mode), expectedScope = mode === 'admission' ? 'communities.station-membership.admit' : 'communities.station-membership.confirm';
    if (c.scope !== expectedScope || c.path !== path || c.method !== 'POST' || msg.req?.method !== 'POST' || (msg.req.originalUrl || msg.req.url) !== path ||
      msg.req?.params?.operationId !== c.operation_id || (msg.req.query && Object.keys(msg.req.query).length) ||
      !smId(c.correlation_id) || msg.req.headers['x-correlation-id'] !== c.correlation_id) return { code: 'STATION_MEMBERSHIP_CONTEXT_INVALID', status: 403 };
    const body = msg.payload;
    if (Buffer.byteLength(JSON.stringify(body) || '') > 8192 || !(mode === 'admission' ? smAdmissionRequest(body) : smConfirmationRequest(body)) || body.operationId !== c.operation_id || c.body_sha256 !== smHash('station-membership-body:v1', body)) return { code: 'STATION_MEMBERSHIP_BODY_INVALID', status: 400 };
    return { claims: c, actor: smActor(c), request: body };
  } catch { return invalid; }
}

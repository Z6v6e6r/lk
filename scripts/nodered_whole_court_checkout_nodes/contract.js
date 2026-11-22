const wholeCourtPrefix = '/lk/integrations/v1/whole-court-checkout';
const wholeCourtOrigin = 'https://lk2.padlhub.su';
const wholeCourtViva = 'https://api.vivacrm.ru';
const wholeCourtCheckoutOrigin = 'https://pay.vivacrm.ru';
const wholeCourtTenant = 'iSkq6G';
const wholeCourtKind = 'WHOLE_COURT_CHECKOUT_V1';
const wholeCourtClaims = [
  'iss',
  'aud',
  'sub',
  'iat',
  'nbf',
  'exp',
  'jti',
  'sid',
  'contract_version',
  'caller',
  'scope',
  'method',
  'path',
  'tenant_id',
  'tenant_key',
  'provider',
  'provider_client_id',
  'operation_id',
  'request_sha256',
  'correlation_id',
  'idempotency_key_sha256',
  'actor_token_sha256',
  'actor_token_expires_at',
].join(',');
const wholeCourtMoney = (v) => Number.isSafeInteger(v) && v > 0 && v <= 10000000;
const wholeCourtZonedDate = (v) => {
  const timestamp = parseVivaTimestamp(v, { requireZone: true });
  return timestamp ? new Date(Number(timestamp.nanoseconds / 1_000_000n)).toISOString() : null;
};
const wholeCourtWindow = (start, end) =>
  gcIso(start) &&
  gcIso(end) &&
  Date.parse(start) % 60000 === 0 &&
  [60, 90, 120].includes((Date.parse(end) - Date.parse(start)) / 60000) &&
  gcMoscow(start).slice(0, 10) === gcMoscow(end).slice(0, 10);
const wholeCourtOriginOf = (v) => {
  if (typeof v !== 'string' || v.length > 2048 || !/^https:\/\/[^\s\\]+$/u.test(v)) return null;
  try {
    const url = new nodeUrl.URL(v);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
};
const wholeCourtConfig = () => {
  if (bookedOperationEnv(env, 'LK1_WHOLE_COURT_CHECKOUT_ENABLED') !== 'true') return null;
  try {
    const raw = bookedOperationEnv(env, 'LK1_WHOLE_COURT_CHECKOUT_TARGET');
    if (!raw || raw.length > 2048) return null;
    const p = JSON.parse(raw);
    if (
      !gcKeys(
        p,
        'actorId,providerClientId,tenantId,stationId,roomId,startsAt,endsAt,amountMinor',
      ) ||
      ![p.actorId, p.tenantId].every(gcUuid) ||
      ![p.providerClientId, p.stationId, p.roomId].every(gcId) ||
      !wholeCourtWindow(p.startsAt, p.endsAt) ||
      !wholeCourtMoney(p.amountMinor)
    )
      return null;
    return p;
  } catch {
    return null;
  }
};
const wholeCourtBody = (p) => {
  if (
    !gcKeys(
      p,
      'contractVersion,action,operationId,draftId,stationId,roomId,startsAt,endsAt,amountMinor,currency',
    ) ||
    p.contractVersion !== 1 ||
    p.action !== 'CREATE_GAME' ||
    p.currency !== 'RUB' ||
    ![p.operationId, p.draftId].every(gcUuid) ||
    ![p.stationId, p.roomId].every(gcId) ||
    !wholeCourtWindow(p.startsAt, p.endsAt) ||
    !wholeCourtMoney(p.amountMinor)
  )
    return null;
  return {
    contractVersion: 1,
    action: 'CREATE_GAME',
    operationId: p.operationId,
    draftId: p.draftId,
    stationId: p.stationId,
    roomId: p.roomId,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    amountMinor: p.amountMinor,
    currency: 'RUB',
  };
};
const wholeCourtTargetMatches = (cfg, c, b) =>
  cfg &&
  cfg.actorId === c.sub &&
  cfg.tenantId === c.tenant_id &&
  cfg.providerClientId === c.provider_client_id &&
  ['stationId', 'roomId', 'startsAt', 'endsAt', 'amountMinor'].every((key) => cfg[key] === b[key]);
const wholeCourtKey = (c, b) =>
  'whole-court:v1:' +
  gcHash(JSON.stringify([c.tenant_key, b.roomId, b.startsAt, b.endsAt])).slice(7);
const wholeCourtAdmissionKey = (c) => 'whole-court:v1:admission:' + c.operation_id;
const wholeCourtBinding = (c, b) =>
  gcHash(
    'whole-court-binding:v1\0' +
      JSON.stringify([c.tenant_id, c.sub, c.provider_client_id, c.idempotency_key_sha256, b]),
  );
const wholeCourtFresh = (c) =>
  c.exp * 1000 > Date.now() && Date.parse(c.actor_token_expires_at) > Date.now();
const wholeCourtHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};
const wholeCourtReply = (status, body) => {
  const correlationId = msg._wholeCourt?.claims?.correlation_id || nodeCrypto.randomUUID();
  for (const key of Object.keys(msg)) {
    if (!['_msgid', 'req', 'res'].includes(key)) delete msg[key];
  }
  if (msg.req) {
    msg.req.body = undefined;
    for (const key of Object.keys(msg.req.headers || {}))
      if (/authorization|token|delegation|cookie/i.test(key)) delete msg.req.headers[key];
  }
  msg.statusCode = status;
  msg.headers = { ...wholeCourtHeaders, 'X-Correlation-ID': correlationId };
  msg.payload = body;
  return msg;
};

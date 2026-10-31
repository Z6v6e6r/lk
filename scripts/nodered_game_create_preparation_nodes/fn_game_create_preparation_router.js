// Only outputs: bounded credentialed GET, sanitized response. No Mongo or business write.
const ctx = msg._gameCreatePreparation;
const reject = (status, code) => [null, gcReject(msg, status, code)];
if (!gcObject(ctx) || !gcObject(ctx.claims) || !gcRequest(ctx.body))
  return reject(400, 'GAME_CREATE_PREPARATION_REQUEST_INVALID');
const c = ctx.claims,
  target = ctx.body.target;
const fresh = () =>
  c.exp * 1000 > Date.now() &&
  Date.parse(c.actor_token_expires_at) > Date.now() &&
  Date.parse(target.startsAt) > Date.now() &&
  bookedOperationExecutionFlagEnabled(env) &&
  bookedOperationReadConfig(env).ok &&
  bookedOperationTokenBindingMatches(ctx.actorToken, c.actor_token_sha256);
if (!fresh()) return reject(409, 'GAME_CREATE_PREPARATION_EXPIRED');
const base = 'https://api.vivacrm.ru';
const user = '/end-user/api/v1/iSkq6G';
const request = (step, path, admin = false) => {
  let token = ctx.actorToken;
  if (admin) {
    try {
      token = global.get('vivacrm_access_token');
    } catch {
      token = null;
    }
  }
  if (typeof token !== 'string' || !BOOKED_OP_ACTOR_TOKEN.test(token) || /[\r\n]/.test(token))
    return reject(503, 'GAME_CREATE_PREPARATION_UNAVAILABLE');
  ctx.step = step;
  ctx.expectedUrl = base + path;
  msg.url = ctx.expectedUrl;
  msg.method = 'GET';
  msg.headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  msg.payload = undefined;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  delete msg.error;
  delete msg.responseUrl;
  delete msg.statusCode;
  return [msg, null];
};
const exact = (row, keys, id) => gcAlias(row, keys) === id;
const active = (row) =>
  row.archived !== true && row.isActive !== false && row.disabled !== true && row.deleted !== true;
if (ctx.step === 'start') {
  const service = lk1CourtMasterServices[c.provider_station_id];
  if (!service || !gcId(service.masterServiceId) || !gcId(service.subServiceId))
    return reject(409, 'GAME_CREATE_SERVICE_UNRESOLVED');
  ctx.service = { masterServiceId: service.masterServiceId, subServiceId: service.subServiceId };
  return request('profile', user + '/profile');
}
if (
  msg.error ||
  msg.statusCode !== 200 ||
  msg.url !== ctx.expectedUrl ||
  msg.responseUrl !== ctx.expectedUrl
)
  return reject(503, 'GAME_CREATE_PREPARATION_UPSTREAM_UNAVAILABLE');
const p = msg.payload,
  service = ctx.service;
if (ctx.step === 'profile') {
  if (!exact(p, ['id', 'clientId'], c.provider_client_id))
    return reject(403, 'GAME_CREATE_PREPARATION_ACTOR_MISMATCH');
  return request('subscriptions', user + '/subscriptions?includeFinished=true&size=1000');
}
if (ctx.step === 'subscriptions') {
  const rows = gcList(p);
  if (!rows) return reject(503, 'GAME_CREATE_PREPARATION_UPSTREAM_UNAVAILABLE');
  const matches = rows.filter((r) =>
    [
      r.clientSubscriptionId,
      r.subscriptionId,
      r.clientSubId,
      r.clientSubscription?.id,
      r.clientSubscription?.clientSubscriptionId,
      r.clientSub?.id,
      r.id,
      r.uuid,
    ].includes(c.provider_client_subscription_id),
  );
  if (matches.length !== 1) return reject(403, 'GAME_CREATE_PREPARATION_SUBSCRIPTION_MISMATCH');
  const row = matches[0];
  const explicit = [
    row.clientSubscriptionId,
    row.subscriptionId,
    row.clientSubId,
    row.clientSubscription?.id,
    row.clientSubscription?.clientSubscriptionId,
    row.clientSub?.id,
  ].filter((v) => v !== undefined);
  const identifiers = explicit.length
    ? explicit
    : [row.id, row.uuid].filter((v) => v !== undefined);
  const owners = [row.clientId, row.client?.id].filter((v) => v !== undefined);
  if (
    !identifiers.length ||
    identifiers.some((v) => v !== c.provider_client_subscription_id) ||
    owners.some((v) => v !== c.provider_client_id)
  )
    return reject(403, 'GAME_CREATE_PREPARATION_SUBSCRIPTION_MISMATCH');
  // Ownership observation only; remaining units, expiry and policy are not adjudicated here.
  return request(
    'room',
    '/api/v1/studios/' +
      encodeURIComponent(c.provider_station_id) +
      '/rooms/' +
      encodeURIComponent(c.provider_room_id),
    true,
  );
}
if (ctx.step === 'room') {
  if (
    !exact(p, ['id', 'roomId'], c.provider_room_id) ||
    !active(p) ||
    [p.studioId, p.stationId, p.studio?.id, p.station?.id].some(
      (v) => v !== undefined && v !== c.provider_station_id,
    )
  )
    return reject(409, 'GAME_CREATE_LOCATION_MISMATCH');
  return request(
    'studios',
    user + '/products/master-services/' + encodeURIComponent(service.masterServiceId) + '/studios?',
  );
}
if (ctx.step === 'studios') {
  const rows = gcList(p);
  if (!rows) return reject(503, 'GAME_CREATE_PREPARATION_UPSTREAM_UNAVAILABLE');
  const matches = rows.filter((r) =>
    [r.id, r.uuid, r.studioId, r.stationId].includes(c.provider_station_id),
  );
  if (
    matches.length !== 1 ||
    !exact(matches[0], ['id', 'uuid', 'studioId', 'stationId'], c.provider_station_id) ||
    !active(matches[0])
  )
    return reject(409, 'GAME_CREATE_SERVICE_MISMATCH');
  return request(
    'subservices',
    user +
      '/products/master-services/' +
      encodeURIComponent(service.masterServiceId) +
      '/subServices?studioId=' +
      encodeURIComponent(c.provider_station_id) +
      '&showAll=true',
  );
}
if (ctx.step === 'subservices') {
  const groups = gcList(p);
  if (!groups) return reject(503, 'GAME_CREATE_PREPARATION_UPSTREAM_UNAVAILABLE');
  const rows = [];
  for (const group of groups) {
    if (Object.hasOwn(group, 'subServices')) {
      const nested = gcList(group.subServices);
      if (!nested) return reject(503, 'GAME_CREATE_PREPARATION_UPSTREAM_UNAVAILABLE');
      rows.push(...nested);
    } else rows.push(group);
  }
  if (rows.length > 1000) return reject(503, 'GAME_CREATE_PREPARATION_UPSTREAM_UNAVAILABLE');
  const matches = rows.filter((r) =>
    [r.id, r.uuid, r.subServiceId, r.serviceId, r.productId].includes(service.subServiceId),
  );
  if (
    matches.length !== 1 ||
    !exact(
      matches[0],
      ['id', 'uuid', 'subServiceId', 'serviceId', 'productId'],
      service.subServiceId,
    ) ||
    !active(matches[0])
  )
    return reject(409, 'GAME_CREATE_SERVICE_MISMATCH');
  const selected = matches[0];
  if (
    selected.roomIds !== undefined &&
    (!Array.isArray(selected.roomIds) ||
      !selected.roomIds.every(gcId) ||
      !selected.roomIds.includes(c.provider_room_id))
  )
    return reject(409, 'GAME_CREATE_SERVICE_MISMATCH');
  ctx.catalogEvidenceSha256 = gcHash(
    'game-create-catalog:v1\0' +
      JSON.stringify({
        stationId: c.provider_station_id,
        roomId: c.provider_room_id,
        ...service,
        roomIds: selected.roomIds ? [...selected.roomIds].sort() : null,
      }),
  );
  const start = gcMoscow(target.startsAt),
    end = gcMoscow(
      new Date(Date.parse(target.startsAt) + target.durationMinutes * 60000).toISOString(),
    );
  const query = Object.entries({
    fromDate: start.slice(0, 10),
    fromTime: start.slice(11, 16),
    toTime: end.slice(11, 16),
    size: 100,
  })
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  return request(
    'price',
    '/api/v1/studios/' +
      encodeURIComponent(c.provider_station_id) +
      '/rooms/' +
      encodeURIComponent(c.provider_room_id) +
      '/sub-services/' +
      encodeURIComponent(service.subServiceId) +
      '/price?' +
      query,
    true,
  );
}
if (ctx.step === 'price') {
  if (
    !gcObject(p) ||
    !Number.isSafeInteger(p.total) ||
    p.total <= 0 ||
    p.total > 10000000 ||
    p.total % 4 !== 0 ||
    (p.currency !== undefined && p.currency !== 'RUB')
  )
    return reject(409, 'GAME_CREATE_PRICE_UNRESOLVED');
  const observedAt = new Date().toISOString();
  const capsule = {
    schemaVersion: 1,
    nonBinding: true,
    operationId: c.operation_id,
    requestSha256: c.request_sha256,
    idempotencyKeySha256: c.idempotency_key_sha256,
    actor: {
      tenantId: c.tenant_id,
      userId: c.sub,
      providerClientId: c.provider_client_id,
      providerMappingId: c.provider_mapping_id,
    },
    subscription: {
      id: ctx.body.subscriptionId,
      providerClientSubscriptionId: c.provider_client_subscription_id,
    },
    target: {
      ...target,
      endsAt: new Date(Date.parse(target.startsAt) + target.durationMinutes * 60000).toISOString(),
      stationMappingId: c.station_mapping_id,
      courtMappingId: c.court_mapping_id,
      mappingVersion: c.mapping_version,
      providerStationId: c.provider_station_id,
      providerRoomId: c.provider_room_id,
    },
    pricing: {
      masterServiceId: service.masterServiceId,
      subServiceIds: [service.subServiceId],
      selectorRevision: gcSelectorRevision,
      catalogEvidenceSha256: ctx.catalogEvidenceSha256,
      participantCount: 4,
      priceBasis: 'WHOLE_COURT_WINDOW',
      courtWindowPriceMinor: p.total,
      quarterPriceMinor: p.total / 4,
      currency: 'RUB',
    },
    observedAt,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  msg.statusCode = 200;
  msg.payload = {
    ...capsule,
    sha256: gcHash('game-create-capsule:v1\0' + JSON.stringify(capsule)),
  };
  return [null, msg];
}
return reject(400, 'GAME_CREATE_PREPARATION_REQUEST_INVALID');

// Shared server-only resolver. MongoDB owns mappings, names and cross-host leases.
// Outputs: HTTP GET, Mongo find, Mongo updateOne, finish, bounded wait.
const ctx = msg._subscriptionProduct;
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const emit = i => { const out = [null, null, null, null, null]; out[i] = msg; return out; };
const key = (kind, ...parts) => JSON.stringify([kind, ctx.tenantKey, ...parts]);
const finish = (code, status = 503, result = null) => {
  if (!code && ctx.caller !== 'refresh' && !freshProductMatches(ctx.subscription, ctx.productId)) { code = 'SUBSCRIPTION_PRODUCT_CURRENT_IDENTITY_CONFLICT'; status = 503; }
  // Neither provider payloads nor headers are permitted in responses/debug.
  delete msg.headers; delete msg.error; delete msg.url; delete msg.method;
  msg.statusCode = code ? status : 200;
  msg.payload = code ? { error: 'Не удалось подтвердить продукт абонемента', code } : result;
  return emit(3);
};
const find = (step, id) => {
  ctx.step = step; delete msg.error; delete msg.headers;
  msg.payload = { _id: id }; return emit(1);
};
const update = (step, query, change, upsert = false) => {
  ctx.step = step; delete msg.error; delete msg.headers;
  msg.payload = [query, change, { upsert, writeConcern: { w: 'majority', j: true } }];
  return emit(2);
};
const http = (step, path, admin = false) => {
  const token = admin ? global.get('vivacrm_access_token') : null;
  if (admin && (typeof token !== 'string' || !token)) return ctx.lockHeld ? failClaimed('SUBSCRIPTION_PRODUCT_SERVICE_UNAVAILABLE') : finish('SUBSCRIPTION_PRODUCT_SERVICE_UNAVAILABLE');
  ctx.step = step; delete msg.error;
  msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru' + path;
  msg.headers = { Authorization: admin ? `Bearer ${token}` : ctx.authHeader, Accept: 'application/json', 'X-Correlation-ID': ctx.requestId };
  msg.payload = undefined; msg.requestTimeout = 10000;
  msg.followRedirects = false; msg.maxRedirects = 0;
  return emit(0);
};
const one = () => !msg.error && Array.isArray(msg.payload) && msg.payload.length <= 1 ? msg.payload[0] || null : undefined;
const ack = () => !msg.error && object(msg.payload) && msg.payload.acknowledged === true;
const changed = () => ack() && (msg.payload.modifiedCount === 1 || msg.payload.upsertedCount === 1);
const mappingValid = row => object(row) && row._id === ctx.instanceKey && row.kind === 'instance'
  && row.tenantKey === ctx.tenantKey && row.actorClientId === ctx.actorClientId
  && row.subscriptionId === ctx.subscriptionId && uuid(row.productId) && row.invalid !== true;
const catalogValid = row => object(row) && row._id === key('product', ctx.productId)
  && row.kind === 'product' && row.tenantKey === ctx.tenantKey && row.productId === ctx.productId
  && typeof row.name === 'string' && row.name.trim().length > 0 && row.name.length <= 500;
const freshProductMatches = (row, expected) => {
  if (!object(row)) return false;
  const values = [row.productId, row.subscriptionProductId, row.templateId,
    row.product?.id, row.product?.uuid, row.product?.productId,
    row.template?.id, row.template?.uuid, row.template?.productId,
    row.subscription?.productId, row.subscription?.subscriptionProductId,
    row.subscription?.product?.id, row.subscription?.product?.uuid, row.subscription?.product?.productId,
    row.subscription?.template?.id, row.subscription?.template?.uuid, row.subscription?.template?.productId];
  return values.filter(v => v !== undefined && v !== null).every(v => uuid(v) && v.toLowerCase() === expected.toLowerCase());
};
const result = () => ({ productId: ctx.productId, sertName: ctx.catalog.name });
const ownedRead = () => http('owned', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
const lookup = () => {
  ctx.instanceKey = key('instance', ctx.actorClientId, ctx.subscriptionId);
  ctx.lockKey = key('lock', ctx.actorClientId, ctx.subscriptionId);
  return find('instance', ctx.instanceKey);
};
// CREATE preflight may bind verified product metadata. Booking, benefit usage
// and payment writes remain guarded by the booking gateway after this lookup.
const claim = () => update('claim', {
  _id: ctx.lockKey, $or: [{ leaseUntil: { $lte: Date.now() } }, { leaseUntil: { $exists: false } }],
}, { $set: { kind: 'lock', leaseUntil: Date.now() + 120000, owner: ctx.requestId } }, true);
const release = () => update('released', { _id: ctx.lockKey, owner: ctx.requestId },
  { $set: { leaseUntil: 0, owner: null } });
const failClaimed = code => { ctx.failure = code; return release(); };
const detail = () => {
  ctx.observedAt = Date.now();
  return http('detail', `/api/v1/clients/${ctx.actorClientId}/subscriptions/${ctx.subscriptionId}`, true);
};
if (!object(ctx) || ctx.tenantKey !== 'iSkq6G'
  || !['name', 'booking', 'refresh'].includes(ctx.caller)
  || typeof ctx.requestId !== 'string' || !ctx.requestId
  || !Number.isFinite(ctx.startedAt) || Date.now() - ctx.startedAt > 60000) {
  return finish('SUBSCRIPTION_PRODUCT_CONTEXT_INVALID');
}
if (ctx.step === 'start') {
  if (ctx.caller === 'refresh') {
    if (!uuid(ctx.productId)) return finish('SUBSCRIPTION_PRODUCT_ID_INVALID', 400);
    return find('refresh_catalog', key('product', ctx.productId));
  }
  if (!uuid(ctx.subscriptionId) || !/^Bearer \S+$/i.test(ctx.authHeader || '')) return finish('SUBSCRIPTION_PRODUCT_AUTH_REQUIRED', 401);
  // Even cache hits need current ownership. Booking actor comes from its verified profile.
  if (ctx.caller === 'booking') return uuid(ctx.actorClientId) ? ownedRead() : finish('SUBSCRIPTION_PRODUCT_ACTOR_INVALID');
  return http('profile', `/end-user/api/v1/${ctx.tenantKey}/profile`);
}
if (ctx.step === 'profile') {
  if (msg.error || msg.statusCode !== 200 || !uuid(msg.payload?.id)) return finish('SUBSCRIPTION_PRODUCT_AUTH_FAILED', 401);
  ctx.actorClientId = msg.payload.id;
  return ownedRead();
}
if (ctx.step === 'owned') {
  const body = msg.payload, rows = body?.content;
  const complete = Array.isArray(rows) && body.totalElements === rows.length
    && (!Object.hasOwn(body, 'number') || body.number === 0)
    && (!Object.hasOwn(body, 'totalPages') || [0, 1].includes(body.totalPages))
    && body.last !== false && body.hasNext !== true;
  if (msg.error || msg.statusCode !== 200 || !complete) return finish('SUBSCRIPTION_PRODUCT_OWNERSHIP_UNAVAILABLE');
  const selected = rows.filter(row => object(row) && row.subscriptionId === ctx.subscriptionId);
  if (selected.length !== 1) return finish('SUBSCRIPTION_PRODUCT_NOT_OWNED', 403);
  const selectedRow = selected[0];
  const instanceAliases = [selectedRow.subscriptionId, selectedRow.clientSubscriptionId, selectedRow.id].filter(v => v !== undefined);
  const ownerAliases = [selectedRow.clientId, selectedRow.client?.id].filter(v => v !== undefined);
  if (instanceAliases.some(v => v !== ctx.subscriptionId) || ownerAliases.some(v => v !== ctx.actorClientId)) return finish('SUBSCRIPTION_PRODUCT_OWNERSHIP_CONFLICT');
  ctx.subscription = selectedRow;
  ctx.purchaseDate = selectedRow.purchaseDate;
  return lookup();
}
if (ctx.step === 'refresh_catalog') {
  const row = one();
  if (!catalogValid(row) || !uuid(row.representative?.actorClientId) || !uuid(row.representative?.subscriptionId)) {
    return finish('SUBSCRIPTION_PRODUCT_NOT_CACHED', 404);
  }
  ctx.actorClientId = row.representative.actorClientId; ctx.subscriptionId = row.representative.subscriptionId;
  ctx.expectedProductId = ctx.productId;
  ctx.instanceKey = key('instance', ctx.actorClientId, ctx.subscriptionId);
  ctx.lockKey = key('lock', ctx.actorClientId, ctx.subscriptionId);
  return claim();
}
if (ctx.step === 'instance') {
  const row = one();
  if (row === undefined) return finish('SUBSCRIPTION_PRODUCT_STORE_UNAVAILABLE');
  if (row === null) return claim();
  if (!mappingValid(row)) return finish('SUBSCRIPTION_PRODUCT_MAPPING_INVALID');
  ctx.productId = row.productId; ctx.expectedProductId = row.productId;
  return find('catalog', key('product', ctx.productId));
}
if (ctx.step === 'catalog') {
  const row = one();
  if (row === undefined) return finish('SUBSCRIPTION_PRODUCT_STORE_UNAVAILABLE');
  if (row === null) return claim();
  if (!catalogValid(row)) return finish('SUBSCRIPTION_PRODUCT_CATALOG_INVALID');
  ctx.catalog = row; return finish(null, 200, result());
}
if (ctx.step === 'claim') {
  if (!changed()) {
    // Duplicate-key means another host holds the same deterministic lease.
    if (msg.error && Number(msg.error.code) !== 11000) return finish('SUBSCRIPTION_PRODUCT_STORE_UNAVAILABLE');
    ctx.waits = (ctx.waits || 0) + 1;
    if (ctx.waits > 24) return finish('SUBSCRIPTION_PRODUCT_LOOKUP_BUSY', 503);
    ctx.step = 'wait'; delete msg.error; delete msg.headers; msg.payload = null;
    return emit(4);
  }
  // A contender may have populated the mapping between our miss and lease acquisition.
  ctx.lockHeld = true;
  if (ctx.caller !== 'refresh') return find('claimed_instance', ctx.instanceKey);
  return detail();
}
if (ctx.step === 'wait') return ctx.caller === 'refresh' ? claim() : lookup();
if (ctx.step === 'claimed_instance') {
  const row = one();
  if (row === undefined || (row !== null && !mappingValid(row))) return failClaimed('SUBSCRIPTION_PRODUCT_MAPPING_INVALID');
  if (row) {
    ctx.productId = row.productId; ctx.expectedProductId = row.productId;
    return find('claimed_catalog', key('product', ctx.productId));
  }
  return detail();
}
if (ctx.step === 'claimed_catalog') {
  const row = one();
  if (row === undefined || (row !== null && !catalogValid(row))) return failClaimed('SUBSCRIPTION_PRODUCT_CATALOG_INVALID');
  if (row) { ctx.catalog = row; return release(); }
  return detail();
}
if (ctx.step === 'detail') {
  const body = msg.payload;
  if (msg.error || msg.statusCode !== 200) return failClaimed('SUBSCRIPTION_PRODUCT_PROVIDER_UNAVAILABLE');
  if (object(body) && body.subscriptionId === ctx.subscriptionId && uuid(body.product?.id)
    && ctx.expectedProductId && body.product.id !== ctx.expectedProductId) {
    ctx.failure = 'SUBSCRIPTION_PRODUCT_PROVIDER_IDENTITY_MISMATCH';
    return update('quarantined', { _id: ctx.instanceKey, productId: ctx.expectedProductId }, { $set: { invalid: true } });
  }
  if (!object(body) || body.subscriptionId !== ctx.subscriptionId || !uuid(body.product?.id)
    || typeof body.product.name !== 'string' || !body.product.name.trim() || body.product.name.length > 500
    || (ctx.expectedProductId && body.product.id !== ctx.expectedProductId)) {
    return failClaimed('SUBSCRIPTION_PRODUCT_PROVIDER_IDENTITY_MISMATCH');
  }
  if (ctx.caller !== 'refresh' && !freshProductMatches(ctx.subscription, body.product.id)) return failClaimed('SUBSCRIPTION_PRODUCT_CURRENT_IDENTITY_CONFLICT');
  ctx.productId = body.product.id;
  ctx.catalog = { _id: key('product', ctx.productId), kind: 'product', tenantKey: ctx.tenantKey,
    productId: ctx.productId, name: body.product.name.trim(), observedAt: ctx.observedAt,
    representative: { actorClientId: ctx.actorClientId, subscriptionId: ctx.subscriptionId } };
  return update('catalog_saved', { _id: ctx.catalog._id, $or: [
    { observedAt: { $lte: ctx.observedAt } }, { observedAt: { $exists: false } },
  ] }, { $set: Object.fromEntries(Object.entries(ctx.catalog).filter(([field]) => field !== '_id')) }, true);
}
if (ctx.step === 'catalog_saved') {
  if (!changed() && !(msg.error && Number(msg.error.code) === 11000)) return failClaimed('SUBSCRIPTION_PRODUCT_CATALOG_WRITE_UNKNOWN');
  return find('catalog_confirmed', key('product', ctx.productId));
}
if (ctx.step === 'catalog_confirmed') {
  const row = one();
  if (!catalogValid(row)) return failClaimed('SUBSCRIPTION_PRODUCT_CATALOG_WRITE_UNKNOWN');
  ctx.catalog = row;
  if (ctx.caller === 'refresh') return release();
  const mapping = { _id: ctx.instanceKey, kind: 'instance', tenantKey: ctx.tenantKey,
    actorClientId: ctx.actorClientId, subscriptionId: ctx.subscriptionId, productId: ctx.productId };
  return update('instance_saved', { _id: ctx.instanceKey }, { $setOnInsert: mapping }, true);
}
if (ctx.step === 'instance_saved') {
  if (!ack()) return failClaimed('SUBSCRIPTION_PRODUCT_MAPPING_WRITE_UNKNOWN');
  return find('instance_confirmed', ctx.instanceKey);
}
if (ctx.step === 'instance_confirmed') {
  const row = one();
  if (!mappingValid(row) || row.productId !== ctx.productId) return failClaimed('SUBSCRIPTION_PRODUCT_MAPPING_CONFLICT');
  return release();
}
if (ctx.step === 'quarantined') return ack() ? release() : failClaimed('SUBSCRIPTION_PRODUCT_QUARANTINE_UNKNOWN');
if (ctx.step === 'released') {
  if (!ack() || msg.payload.matchedCount !== 1) return finish('SUBSCRIPTION_PRODUCT_LEASE_RELEASE_UNKNOWN');
  return ctx.failure ? finish(ctx.failure) : finish(null, 200, result());
}
return finish('SUBSCRIPTION_PRODUCT_STEP_INVALID');

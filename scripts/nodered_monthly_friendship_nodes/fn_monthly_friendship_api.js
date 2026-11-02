// Five ports: shared-owner find, update, projection, sanitized response, bounded HTTP.
const api = monthlyFriendshipApi, custody = monthlyFriendshipCustody;
const get = key => env.get(key);
const scrubTransport = () => { for (const k of ['headers','url','method','error','statusCode','responseUrl','requestTimeout','httpRequestTimeout']) delete msg[k]; };
const ports = index => { const out = [null,null,null,null,null]; out[index] = msg; return out; };
const response = (status, body) => {
  scrubTransport(); delete msg._summerSubscriptionCtx; delete msg._monthlyFriendshipApi;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
  msg.statusCode = status; msg.payload = body; return ports(3);
};
const fail = (status, code) => response(status, { contract: api.version, code });
let state = msg._monthlyFriendshipApi;
if (!state) {
  const verified = api.verify(msg, get);
  for (const k of ['x-subscription-actor-delegation','x-subscription-actor-token']) if (msg.req?.headers) delete msg.req.headers[k];
  if (!verified.ok) return fail(verified.status, verified.code);
  state = msg._monthlyFriendshipApi = { ...verified, phase: 'start' };
}
const c = state.claims;
const fresh = () => api.config(get)?.TENANT_ID === c.tenant_id && c.exp * 1000 > Date.now()
  && Date.parse(c.actor_token_expires_at) > Date.now() && api.hash(state.actorToken) === c.actor_token_sha256;
const reply = (status, body) => fresh() ? response(status, body) : fail(401, 'MONTHLY_API_ACTOR_EXPIRED');
const serviceToken = () => {
  const token = global.get('vivacrm_access_token');
  return typeof token === 'string' && /^[!-~]{16,4096}$/.test(token) ? token : null;
};
const find = (phase, query) => { scrubTransport(); state.phase = phase; msg.payload = query; return ports(0); };
const request = (phase, url, token) => {
  if (!fresh() || !token) return fail(503, 'MONTHLY_API_UPSTREAM_UNAVAILABLE');
  scrubTransport(); state.phase = phase; state.expectedUrl = url;
  msg.method = 'GET'; msg.url = url; msg.payload = undefined;
  msg.headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  msg.followRedirects = false; msg.maxRedirects = 0; msg.requestTimeout = 10000; msg.httpRequestTimeout = 10000;
  return ports(4);
};
const httpOkay = () => !msg.error && msg.statusCode === 200 && msg.url === state.expectedUrl && msg.responseUrl === state.expectedUrl;
const recovery = row => {
  if (state.mode === 'read') {
    state.binding = row;
    return find('ledger_read', { _id: custody.id(c.tenant_id, row.quote.inventoryId), tenant_id: c.tenant_id });
  }
  const token = serviceToken(); if (!token) return fail(503, 'MONTHLY_API_UPSTREAM_UNAVAILABLE');
  state.binding = row; state.phase = 'atomic';
  msg._summerSubscriptionCtx = { action: 'confirm', counterKey: 'friendship', step: 'monthly_confirm_start',
    inventoryId: row.quote.inventoryId, productId: row.quote.productId, clientId: c.provider_client_id,
    paymentRef: c.operation_id, token, monthlyScope: { tenant_id: c.tenant_id, counterKey: 'friendship', inventoryId: row.quote.inventoryId } };
  return atomic();
};
const atomic = () => {
  // Process received provider facts through durable observation even if auth expired
  // in flight. Check freshness only at the next outbound I/O/response boundary.
  const output = monthlyPrivateAtomic(msg, global, env, node);
  if (!Array.isArray(output) || output.length !== 5 || output.filter(Boolean).length !== 1) return fail(503, 'MONTHLY_API_OWNER_UNAVAILABLE');
  if (output[4]) {
    if (!fresh()) return fail(401, 'MONTHLY_API_ACTOR_EXPIRED');
    const url = msg.url, ctx = msg._summerSubscriptionCtx;
    const allowed = msg.method === 'GET'
      ? /^https:\/\/api\.vivacrm\.ru\/api\/v1\/(?:clients\?phone=[^&]+&size=20|transactions\/[A-Za-z0-9%._:-]+|clients\/[A-Za-z0-9%._:-]+\/subscriptions\?includeFinished=true&size=200&page=[0-9]+)$/.test(url)
      : msg.method === 'POST' && url === 'https://api.vivacrm.ru/api/v1/transactions' && ctx.step === 'monthly_provider_result'
        && ctx.monthlyLedger && custody.lookup(ctx.monthlyLedger, c.operation_id)?.state === 'DISPATCHING';
    if (!allowed) return fail(503, 'MONTHLY_API_TRANSPORT_REJECTED');
  }
  if (output[3]) {
    const p = msg.payload;
    if (!p?.ok || p.paymentRef !== c.operation_id) return reply(msg.statusCode >= 400 ? msg.statusCode : 503,
      { contract: api.version, operationId: c.operation_id, code: typeof p?.code === 'string' ? p.code : 'MONTHLY_API_RECOVERY_REQUIRED' });
    if (p.productId !== state.binding.quote.productId || p.inventoryId !== state.binding.quote.inventoryId || p.priceMinor !== state.binding.quote.amountMinor) return fail(409, 'MONTHLY_API_BINDING_CONFLICT');
    return reply(200, { contract: api.version, operationId: c.operation_id, offerId: api.offerId,
      state: p.status, amountMinor: state.binding.quote.amountMinor, currency: 'RUB',
      paymentUrl: p.paymentUrl || null, paymentExpiresAt: p.paymentExpiresAt || null,
      providerTransactionId: p.transactionId || null, providerSubscriptionId: p.clientSubscriptionId || null });
  }
  return output;
};
try {
  if (state.phase === 'start') return request('profile', 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile', state.actorToken);
  if (state.phase === 'profile') {
    if (!httpOkay()) return fail(503, 'MONTHLY_API_UPSTREAM_UNAVAILABLE');
    const phone = api.profilePhone(msg.payload, c.provider_client_id);
    if (!phone) return fail(403, 'MONTHLY_API_ACTOR_MISMATCH');
    state.phone = phone;
    if (state.mode !== 'quote') return find('binding', { _id: api.bindingId(c), tenant_id: c.tenant_id });
    state.phase = 'prepare';
  }
  if (state.phase === 'binding' || state.phase === 'insert_readback') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return fail(503, 'MONTHLY_API_STORAGE_UNAVAILABLE');
    if (msg.payload.length) {
      const row = msg.payload[0];
      if (!api.bindingMatches(row, c) || !api.digest(row.requestHash) || !api.exact(row.quote, 'contract,offerId,revision,amountMinor,currency,inventoryId,productId')
        || row.quote.contract !== api.version || row.quote.offerId !== api.offerId || !api.id(row.quote.inventoryId) || !api.id(row.quote.productId)
        || !api.digest(row.quote.revision) || row.quote.currency !== 'RUB' || !Number.isSafeInteger(row.quote.amountMinor) || row.quote.amountMinor <= 0
        || (state.mode === 'purchase' && row.requestHash !== c.request_sha256)) return fail(409, 'MONTHLY_API_BINDING_CONFLICT');
      return recovery(row);
    }
    if (state.mode !== 'purchase' || state.phase === 'insert_readback') return fail(404, 'MONTHLY_API_OPERATION_NOT_FOUND');
    state.phase = 'prepare';
  }
  if (state.phase === 'ledger_read') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1 || !custody.validate(msg.payload[0])) return fail(503, 'MONTHLY_API_STORAGE_UNAVAILABLE');
    const op = custody.lookup(msg.payload[0], c.operation_id), q = state.binding.quote;
    if (!op) return fail(404, 'MONTHLY_API_OPERATION_NOT_FOUND');
    if (op.request.tenant_id !== c.tenant_id || op.request.clientId !== c.provider_client_id || op.request.productId !== q.productId
      || op.request.inventoryId !== q.inventoryId || op.request.amountMinor !== q.amountMinor) return fail(409, 'MONTHLY_API_BINDING_CONFLICT');
    return reply(200, { contract: api.version, operationId: c.operation_id, offerId: api.offerId,
      state: op.state === 'PAID' ? 'PAID' : op.state === 'PAYMENT_PENDING' ? 'PAYMENT_PENDING' : 'PROVIDER_UNKNOWN',
      amountMinor: q.amountMinor, currency: 'RUB', paymentUrl: op.state === 'PAYMENT_PENDING' && Date.parse(op.expiresAt) > Date.now() ? op.paymentUrl : null,
      paymentExpiresAt: op.expiresAt, providerTransactionId: op.transactionId, providerSubscriptionId: op.subscriptionId });
  }
  if (state.phase === 'prepare') {
    if (!fresh()) return fail(401, 'MONTHLY_API_ACTOR_EXPIRED');
    msg.payload = { counterKey: 'friendship', clientPhone: state.phone, clientId: c.provider_client_id,
      paymentRef: c.operation_id, transactionPaymentMethod: 'CARD',
      successUrl: 'https://padlhub.su/lk2/subscription-payment-return', failUrl: 'https://padlhub.su/lk2/subscription-payment-return' };
    const output = monthlyPrivatePrepare(msg, global);
    if (!output?.[0]) return fail(output?.[1]?.statusCode || 503, 'MONTHLY_API_OFFER_UNAVAILABLE');
    msg = output[0]; msg._monthlyFriendshipApi = state;
    const ctx = msg._summerSubscriptionCtx, b = global.get('monthly_friendship_custody_binding');
    if (ctx.counterKey !== 'friendship' || b?.version !== 1 || b.enabled !== true || b.tenantId !== c.tenant_id || b.inventoryId !== ctx.inventoryId)
      return fail(503, 'MONTHLY_API_OFFER_UNAVAILABLE');
    state.phase = 'capacity'; scrubTransport(); return ports(0);
  }
  if (state.phase === 'capacity') {
    if (msg.error || !Array.isArray(msg.payload)) return fail(503, 'MONTHLY_API_STORAGE_UNAVAILABLE');
    const ctx = msg._summerSubscriptionCtx;
    const ledgers = msg.payload.filter(r => r.documentType === custody.kind);
    if (ledgers.length) {
      if (ledgers.length !== 1 || ledgers[0].tenant_id !== c.tenant_id || ledgers[0].inventoryId !== ctx.inventoryId) return fail(503, 'MONTHLY_API_STORAGE_UNAVAILABLE');
      msg.payload = custody.countingRows(msg.payload, ledgers[0]);
    }
    const capacity = monthlyCapacityProbe(msg, global);
    if (capacity?.ok !== true) return fail(409, 'MONTHLY_API_CAPACITY_UNAVAILABLE');
    return request('products', 'https://api.vivacrm.ru/api/v1/products/subscriptions?size=500', serviceToken());
  }
  if (state.phase === 'products') {
    if (!httpOkay() || !fresh()) return fail(503, 'MONTHLY_API_UPSTREAM_UNAVAILABLE');
    const ctx = msg._summerSubscriptionCtx, product = api.products(msg.payload, ctx.productId);
    if (!product) return fail(503, 'MONTHLY_API_PRODUCT_UNAVAILABLE');
    ctx.token = serviceToken(); ctx.step = 'load_products';
    const output = monthlyPrivateProducts(msg, global);
    // No returned HTTP request is dispatched here. Quote never reaches reserve.
    if (!output?.[4] || output[0] || ctx.step !== 'piter_reserve_start') return fail(503, 'MONTHLY_API_OFFER_UNAVAILABLE');
    const quote = api.quote(ctx, product);
    if (state.mode === 'quote') return reply(200, { ...quote, operationId: c.operation_id });
    if (state.body.expectedRevision !== quote.revision || state.body.amountMinor !== quote.amountMinor) return fail(409, 'MONTHLY_API_PRICE_CHANGED');
    const row = { _id: api.bindingId(c), documentType: 'MONTHLY_FRIENDSHIP_ACTOR_BINDING_V1', tenant_id: c.tenant_id,
      userId: c.sub, originatingSessionId: c.sid, providerClientId: c.provider_client_id, providerMappingId: c.provider_mapping_id,
      operationId: c.operation_id, idempotencyKeyHash: c.idempotency_key_sha256, offerId: api.offerId,
      requestHash: c.request_sha256, quote, createdAt: new Date().toISOString() };
    state.binding = row; state.phase = 'insert'; scrubTransport();
    msg.payload = [{ _id: row._id, tenant_id: c.tenant_id }, { $setOnInsert: row }, { upsert: true }]; return ports(2);
  }
  if (state.phase === 'insert') {
    if (!msg.error && msg.payload?.acknowledged === true && msg.payload.upsertedCount === 1
      && msg.payload.matchedCount === 0 && msg.payload.modifiedCount === 0) {
      if (!fresh()) return fail(401, 'MONTHLY_API_ACTOR_EXPIRED');
      state.phase = 'atomic'; return atomic();
    }
    return find('insert_readback', { _id: api.bindingId(c), tenant_id: c.tenant_id });
  }
  if (state.phase === 'atomic') return atomic();
  return fail(503, 'MONTHLY_API_STAGE_INVALID');
} catch { return fail(503, 'MONTHLY_API_RECOVERY_REQUIRED'); }

// Dedicated authenticated checkout. No provider write occurs until a durable
// insertOne ACK; an uncertain insert/POST can never cause a second transaction.
const trialCtx = trialRecord(msg._subscriptionBooking) ? msg._subscriptionBooking : null;
function trialCheckoutMongo(ctx, step, output, payload) {
  ctx.step = step; msg._subscriptionBooking = ctx; msg.payload = payload; delete msg.error;
  const out = [null, null, null, null, null, null, null]; out[output] = msg; return out;
}
function trialCheckoutFind(ctx) {
  return trialCheckoutMongo(ctx, 'checkout_find_target', 1, [{ _id: ctx.targetKey }, { limit: 2 }]);
}
function trialCheckoutPending() {
  delete msg._subscriptionBooking;
  msg.statusCode = 202;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*' };
  msg.payload = { state: 'PENDING_CONFIRMATION', details: { code: 'TRIAL_CHECKOUT_OUTCOME_UNRESOLVED' },
    message: 'Запись ожидает подтверждения. Повторное создание оплаты заблокировано.' };
  return [null, null, null, null, msg, null, null];
}
function trialCheckoutResponse(payload) {
  delete msg._subscriptionBooking;
  msg.statusCode = 200;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*' };
  msg.payload = payload;
  return [null, null, null, null, msg, null, null];
}
function trialCheckoutContinue(ctx) {
  if (ctx.action === 'check') return trialCheckoutResponse({ eligible: true,
    ...(ctx.trialVisitEvidence || { mode: 'off' }) });
  return trialHttp(ctx, 'checkout_products',
    `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`);
}
function trialCheckoutHttpVerified() {
  return !msg.error && Number.isInteger(msg.statusCode) && msg.statusCode >= 200 && msg.statusCode < 300
    && msg.method === 'GET' && typeof msg.url === 'string'
    && (msg.responseUrl === undefined || msg.responseUrl === msg.url)
    && msg.followRedirects === false && msg.maxRedirects === 0;
}
function trialCheckoutTargetBinding(exercise) {
  return JSON.stringify([exercise?.id, exercise?.type?.id ?? exercise?.typeId,
    exercise?.direction?.id ?? exercise?.directionId, exercise?.timeFrom, exercise?.timeTo, exercise?.studio?.id]);
}
function trialCheckoutOfferBinding(product) {
  return JSON.stringify([product?.id, product?.productType ?? product?.type, product?.name]);
}
function trialCheckoutTargetValid(ctx, exercise) {
  return trialRecord(exercise) && exercise.id === ctx.exerciseId && isTrialGroupExercise(exercise)
    && typeof exercise.studio?.id === 'string' && Boolean(exercise.studio.id)
    && exercise.isCancelled !== true && exercise.cancelled !== true && exercise.canceled !== true
    && exercise.archived !== true && !/CANCEL|DELETE|ARCHIVE/.test(String(exercise.status || '').toUpperCase())
    && Number.isFinite(Date.parse(exercise.timeFrom)) && Date.parse(exercise.timeFrom) > Date.now();
}
if (!trialCtx) {
  const body = trialRecord(msg.payload) ? msg.payload : {};
  const authHeader = msg.req?.headers?.authorization;
  const operationId = trialId(msg.req?.query?.operationId);
  const action = body.action || 'checkout';
  const envTenantKey = trialId(env.get('VIVA_TENANT_KEY'));
  if (!/^Bearer\s+\S+$/i.test(authHeader || '')) return trialFinish(401, 'TRIAL_CHECKOUT_AUTH_REQUIRED');
  if (!['check', 'checkout'].includes(action) || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.exerciseId || '')
    || (action === 'checkout' && (!/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)
      || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.productId || '')
      || !['one-time', 'client-one-time'].includes(body.source)))
    || (body.promoCode != null && (typeof body.promoCode !== 'string' || body.promoCode.length > 100))) {
    return trialFinish(400, 'TRIAL_CHECKOUT_REQUEST_INVALID');
  }
  const ctx = { caller: 'trial_checkout', action, authHeader, operationId,
    trialRequestedAt: new Date().toISOString(),
    exerciseId: body.exerciseId, productId: body.productId, source: body.source,
    promoCode: body.promoCode || null };
  ctx.checkoutPolicy = trialReadPolicy();
  if (ctx.checkoutPolicy.code) return trialFinish(503, ctx.checkoutPolicy.code);
  if (envTenantKey && ctx.checkoutPolicy.tenantKey && envTenantKey !== ctx.checkoutPolicy.tenantKey) {
    return trialFinish(503, 'TRIAL_CHECKOUT_TENANT_CONFLICT');
  }
  ctx.tenantKey = envTenantKey || ctx.checkoutPolicy.tenantKey;
  if (!/^[A-Za-z0-9_-]+$/.test(ctx.tenantKey || '')) return trialFinish(503, 'TRIAL_CHECKOUT_TENANT_UNCONFIGURED');
  if (action === 'checkout' && ctx.checkoutPolicy.checkoutMode !== 'enabled') {
    return trialFinish(503, 'TRIAL_CHECKOUT_DISABLED');
  }
  // No client identity, price, redirect, category or skip flag is copied.
  return trialHttp(ctx, 'checkout_profile', `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/profile`);
}
const ctx = trialCtx;
if (ctx.caller !== 'trial_checkout') return trialFinish(400, 'TRIAL_CHECKOUT_CONTEXT_INVALID');
if (ctx.step === 'checkout_profile') {
  if (!trialCheckoutHttpVerified(ctx) || msg.url !== `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/profile`
    || !trialRecord(msg.payload) || typeof msg.payload.id !== 'string' || !msg.payload.id
    || typeof msg.payload.phone !== 'string' || !msg.payload.phone) return trialFinish(503, 'TRIAL_CHECKOUT_PROFILE_UNVERIFIED');
  ctx.actorClientId = msg.payload.id; ctx.actorPhone = msg.payload.phone;
  if (ctx.action === 'checkout') {
    ctx.targetKey = `trial-group-target-v2:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.exerciseId])}`;
    ctx.fingerprint = JSON.stringify([ctx.exerciseId, ctx.productId, ctx.source, ctx.promoCode]);
    return trialCheckoutFind(ctx);
  }
  return trialHttp(ctx, 'checkout_exercise',
    `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`);
}
if (ctx.step === 'checkout_find_target') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return trialCheckoutPending();
  const saved = msg.payload[0];
  if (saved) {
    if (saved._id !== ctx.targetKey || saved.actorClientId !== ctx.actorClientId
      || saved.tenantKey !== ctx.tenantKey || saved.exerciseId !== ctx.exerciseId) return trialCheckoutPending();
    if (saved.fingerprint !== ctx.fingerprint) return trialFinish(409, 'TRIAL_CHECKOUT_TARGET_CONFLICT');
    if (!['ATTEMPTING', 'CREATED'].includes(saved.state)) return trialCheckoutPending();
    // Replay bypasses a new eligibility decision: the transaction already exists.
    if (typeof saved.transactionId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(saved.transactionId)) {
      ctx.transactionId = saved.transactionId;
      return trialHttp(ctx, 'checkout_readback',
        `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/transactions/${encodeURIComponent(saved.transactionId)}/status`);
    }
    return trialCheckoutPending();
  }
  return trialCheckoutMongo(ctx, 'checkout_find_legacy', 1,
    [{ actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId, schemaVersion: { $ne: 2 } }, { limit: 2 }]);
}
if (ctx.step === 'checkout_find_legacy') {
  // Old operation-id documents cannot prove that a target has no in-flight
  // checkout.  Conservatively reconcile them outside this request.
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return trialCheckoutPending();
  if (msg.payload[0]) return trialCheckoutPending();
  return trialHttp(ctx, 'checkout_exercise',
    `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`);
}
if (ctx.step === 'checkout_exercise') {
  const exercise = msg.payload;
  if (!trialCheckoutHttpVerified()
    || msg.url !== `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`
    || !trialCheckoutTargetValid(ctx, exercise)) {
    return trialFinish(409, 'TRIAL_CHECKOUT_TARGET_UNVERIFIED');
  }
  ctx.exercise = exercise;
  ctx.checkoutPolicy = trialReadPolicy();
  const gated = trialBeginGate(ctx, exercise, 'checkout');
  return gated || trialCheckoutContinue(ctx);
}
if (ctx.step === 'trial_visit_history') {
  const stopped = trialGateDecision(ctx, trialHistoryOutcome(ctx));
  if (stopped) return stopped;
  delete ctx.trialVisitGate;
  return trialCheckoutContinue(ctx);
}
if (ctx.step === 'checkout_products') {
  if (!trialCheckoutHttpVerified()
    || msg.url !== `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`) {
    return trialFinish(503, 'TRIAL_CHECKOUT_PRODUCT_UNVERIFIED');
  }
  const offered = Array.isArray(msg.payload) ? msg.payload : msg.payload?.content;
  if (!Array.isArray(offered)) return trialFinish(503, 'TRIAL_CHECKOUT_PRODUCT_UNVERIFIED');
  const products = ctx.source === 'client-one-time' ? ctx.exercise.availableClientOneTimes : offered;
  const selected = Array.isArray(products) ? products.filter(row => row?.id === ctx.productId) : [];
  const product = selected[0];
  const types = [product?.productType, product?.type].filter(value => value !== undefined);
  const supported = ['SERVICE', 'INSTANT_SUB_SERVICE', 'ADVANCE_SUB_SERVICE', 'FULL_PAYMENT_SERVICE'];
  if (selected.length !== 1 || types.length === 0 || types.some(value => !supported.includes(value))
    || new Set(types).size !== 1
    || typeof product.name !== 'string') {
    return trialFinish(409, 'TRIAL_CHECKOUT_PRODUCT_UNAVAILABLE');
  }
  ctx.offerBinding = trialCheckoutOfferBinding(product);
  ctx.transactionPayload = { products: [{ id: product.id, name: product.name, type: types[0], count: 1,
    bookingRequests: [{ exerciseId: ctx.exerciseId, client: null, comment: null, marketingAttribution: {} }] }],
  clientPhone: ctx.actorPhone, paymentMethod: 'WIDGET', exerciseId: ctx.exerciseId,
  studioId: ctx.exercise.studio.id, promoCode: ctx.promoCode,
  successUrl: `https://padlhub.ru/group?exerciseId=${encodeURIComponent(ctx.exerciseId)}`,
  failUrl: `https://padlhub.ru/group?exerciseId=${encodeURIComponent(ctx.exerciseId)}` };
  return trialHttp(ctx, 'checkout_exercise_recheck',
    `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`);
}
if (ctx.step === 'checkout_exercise_recheck') {
  if (!trialCheckoutHttpVerified()
    || msg.url !== `https://api.vivacrm.ru/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`
    || !trialCheckoutTargetValid(ctx, msg.payload)
    || trialCheckoutTargetBinding(msg.payload) !== trialCheckoutTargetBinding(ctx.exercise)
    || JSON.stringify(trialReadPolicy()) !== JSON.stringify(ctx.checkoutPolicy)
    || ctx.checkoutPolicy.checkoutMode !== 'enabled'
    || (ctx.checkoutPolicy.mode !== 'off' && !trialEvidenceMatches(ctx))) {
    return trialFinish(409, 'TRIAL_CHECKOUT_CONDITIONS_CHANGED');
  }
  if (ctx.source === 'client-one-time') {
    const current = Array.isArray(msg.payload.availableClientOneTimes) ? msg.payload.availableClientOneTimes : [];
    const chosen = current.filter(row => row?.id === ctx.productId);
    const types = [chosen[0]?.productType, chosen[0]?.type].filter(value => value !== undefined);
    if (chosen.length !== 1 || types.length !== 1 || trialCheckoutOfferBinding(chosen[0]) !== ctx.offerBinding
      || !['SERVICE', 'INSTANT_SUB_SERVICE', 'ADVANCE_SUB_SERVICE', 'FULL_PAYMENT_SERVICE'].includes(types[0])) {
      return trialFinish(409, 'TRIAL_CHECKOUT_PRODUCT_UNAVAILABLE');
    }
    // Use only the row read immediately before the durable fence.
    ctx.transactionPayload.products[0] = { id: chosen[0].id, name: chosen[0].name, type: types[0], count: 1,
      bookingRequests: [{ exerciseId: ctx.exerciseId, client: null, comment: null, marketingAttribution: {} }] };
  }
  // _id uniqueness is the concurrency boundary. No lease can reopen an attempt.
  return trialCheckoutMongo(ctx, 'checkout_insert', 2, [{ _id: ctx.targetKey, schemaVersion: 2,
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId,
    operationId: ctx.operationId, fingerprint: ctx.fingerprint, generation: 1, revision: 1,
    state: 'ATTEMPTING', evidence: ctx.trialVisitEvidence || { mode: 'off' }, createdAt: new Date().toISOString() },
  { writeConcern: { w: 'majority', j: true } }]);
}
if (ctx.step === 'checkout_insert') {
  if (msg.error || msg.payload?.acknowledged !== true || msg.payload.insertedId !== ctx.targetKey) {
    return trialCheckoutFind(ctx);
  }
  if (JSON.stringify(trialReadPolicy()) !== JSON.stringify(ctx.checkoutPolicy)
    || ctx.checkoutPolicy.checkoutMode !== 'enabled') return trialCheckoutPending();
  ctx.step = 'checkout_post'; msg._subscriptionBooking = ctx;
  msg.method = 'POST'; msg.url = `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/transactions`;
  msg.headers = { Authorization: ctx.authHeader, 'Content-Type': 'application/json' };
  msg.payload = ctx.transactionPayload; msg.requestTimeout = 20000;
  msg.followRedirects = false; msg.maxRedirects = 0;
  return [msg, null, null, null, null, null, null];
}
if (ctx.step === 'checkout_post') {
  if (msg.error || msg.method !== 'POST'
    || msg.url !== `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/transactions`
    || (msg.responseUrl !== undefined && msg.responseUrl !== msg.url)
    || msg.followRedirects !== false || msg.maxRedirects !== 0) return trialCheckoutPending();
  const transactionId = msg.payload?.id ?? msg.payload?.transactionId;
  const created = msg.statusCode >= 200 && msg.statusCode < 300
    && typeof transactionId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(transactionId);
  if (!created && (!Number.isInteger(msg.statusCode) || msg.statusCode < 400 || msg.statusCode > 499)) {
    return trialCheckoutPending();
  }
  ctx.transactionId = created ? transactionId : null;
  ctx.postOutcome = created ? 'CREATED' : 'REJECTED_UNVERIFIED';
  return trialCheckoutMongo(ctx, 'checkout_save', 3, [{ _id: ctx.targetKey, state: 'ATTEMPTING', fingerprint: ctx.fingerprint,
    generation: 1, revision: 1 }, { $set: { state: ctx.postOutcome, transactionId: ctx.transactionId,
      revision: 2, updatedAt: new Date().toISOString() } }, { writeConcern: { w: 'majority', j: true } }]);
}
if (ctx.step === 'checkout_save') {
  if (msg.error || msg.payload?.acknowledged !== true || msg.payload.matchedCount !== 1
    || msg.payload.modifiedCount !== 1) return trialCheckoutPending();
  if (!ctx.transactionId) return trialCheckoutPending();
  return trialHttp(ctx, 'checkout_readback',
    `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/transactions/${encodeURIComponent(ctx.transactionId)}/status`);
}
if (ctx.step === 'checkout_readback') {
  if (!trialCheckoutHttpVerified(ctx)
    || msg.url !== `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/transactions/${encodeURIComponent(ctx.transactionId)}/status`
    || !trialRecord(msg.payload) || !trialOwnerMatches(msg.payload, ctx.actorClientId)
    || (msg.payload.id !== undefined && msg.payload.id !== ctx.transactionId)
    || (msg.payload.transactionId !== undefined && msg.payload.transactionId !== ctx.transactionId)) return trialCheckoutPending();
  // Same actor-scoped provider DTO as the existing client's transaction polling.
  return trialCheckoutResponse({ ...msg.payload, id: ctx.transactionId });
}
return trialFinish(503, 'TRIAL_CHECKOUT_STEP_UNSUPPORTED');

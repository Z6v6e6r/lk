// Dedicated advisory graph. `canonical` consists only of source-bound helpers.
const ctx = msg._subscriptionPricePreview;
if (!ctx) return null;
const out = index => { const result = [null, null, null, null, null]; result[index] = msg; return result; };
const stop = (code, status = 503) => { ctx.done = true; ctx.error = code; ctx.statusCode = status; return out(4); };
const ok = () => !msg.error && Number(msg.statusCode) >= 200 && Number(msg.statusCode) < 300;
const rows = () => canonical.extractItems(msg.payload);
const key = (kind, ...parts) => JSON.stringify([kind, ctx.tenantKey, ...parts]);
const find = (step, query, output = 1) => {
  ctx.step = step; delete msg.error; delete msg.headers; delete msg.statusCode;
  msg.payload = query; return out(output);
};
const http = (step, path, admin = false) => {
  const token = admin ? global.get('vivacrm_access_token') : null;
  if (admin && (typeof token !== 'string' || !token
    || !Number.isFinite(Number(global.get('vivacrm_token_expires_at'))) || Number(global.get('vivacrm_token_expires_at')) <= Date.now() + 30000)) return stop('VIVA_SERVICE_TOKEN_UNAVAILABLE');
  ctx.step = step; delete msg.error; delete msg.statusCode;
  msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru' + path;
  msg.headers = { Authorization: admin ? `Bearer ${token}` : ctx.auth, Accept: 'application/json' };
  msg.payload = undefined; msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
  return out(0);
};
const quote = (subscriptionId, status, amountMinor = null, freeMinutes = 0, paidMinutes = 0, reasonCode = null) => {
  ctx.quotes.push({ subscriptionId, selectionKey: JSON.stringify([ctx.target.slotId, ctx.target.stationId,
    ctx.target.roomId, ctx.target.masterServiceId, ctx.target.subServiceIds, ctx.target.startsAt,
    ctx.target.durationMinutes, ctx.target.shareCount]), status, basePriceMinor: ctx.basePriceMinor,
    amountMinor, freeMinutes, paidMinutes, reasonCode, evaluatedAt: Date.now(), expiresAt: Date.now() + 30000 });
};
if (ctx.done) return out(4);
if (msg.error) return stop('PRICE_PREVIEW_READ_FAILED');
if (Date.now() - ctx.startedAt > 28000) return stop('PRICE_PREVIEW_TIMEOUT');
if (ctx.step === 'start') return http('profile', `/end-user/api/v1/${ctx.tenantKey}/profile`);
if (ctx.step === 'profile') {
  const profile = canonical.unwrapRecord(msg.payload);
  if (!ok() || !profile || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(profile.id || profile.clientId || '')) return stop('PRICE_PREVIEW_AUTH_REQUIRED', 401);
  ctx.actorClientId = profile.id || profile.clientId;
  return http('subscriptions', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.step === 'subscriptions') {
  const body = msg.payload;
  const list = Array.isArray(body) ? body : body?.content;
  if (!ok() || !Array.isArray(list) || list.some(row => !canonical.isObj(row))
    || (!Array.isArray(body) && (body.totalElements !== list.length || (body.number !== undefined && body.number !== 0)
      || (body.totalPages !== undefined && ![0, 1].includes(body.totalPages)) || body.last === false || body.hasNext === true))) {
    return stop('PRICE_PREVIEW_SUBSCRIPTIONS_INCOMPLETE');
  }
  ctx.subscriptions = {};
  for (const id of ctx.requestedIds) {
    const matches = list.filter(row => row.subscriptionId === id);
    if (matches.length !== 1 || [matches[0].clientSubscriptionId, matches[0].id].some(v => v !== undefined && v !== id)
      || [matches[0].clientId, matches[0].client?.id].some(v => v !== undefined && v !== ctx.actorClientId)) return stop('PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
    ctx.subscriptions[id] = matches[0];
  }
  return find('metadata', { _id: { $in: ctx.requestedIds.map(id => key('instance', ctx.actorClientId, id)) } });
}
if (ctx.step === 'metadata') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
  ctx.metadata = {};
  for (const id of ctx.requestedIds) {
    const matches = msg.payload.filter(row => row?._id === key('instance', ctx.actorClientId, id));
    const row = matches[0];
    if (matches.length !== 1 || row.kind !== 'instance' || row.tenantKey !== ctx.tenantKey
      || row.actorClientId !== ctx.actorClientId || row.subscriptionId !== id || row.invalid === true
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.productId || '')
      || canonical.collectExactProductIds(ctx.subscriptions[id]).some(product => product !== row.productId.toLowerCase())) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
    ctx.metadata[id] = row;
  }
  return find('catalog', { _id: { $in: [...new Set(Object.values(ctx.metadata).map(row => key('product', row.productId)))] } });
}
if (ctx.step === 'catalog') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('SUBSCRIPTION_PRODUCT_CATALOG_UNAVAILABLE');
  ctx.catalog = {};
  for (const mapping of Object.values(ctx.metadata)) {
    const matches = msg.payload.filter(row => row?._id === key('product', mapping.productId));
    const row = matches[0];
    if (matches.length !== 1 || row.kind !== 'product' || row.tenantKey !== ctx.tenantKey
      || row.productId !== mapping.productId || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 500) return stop('SUBSCRIPTION_PRODUCT_CATALOG_UNAVAILABLE');
    ctx.catalog[mapping.productId] = row.name;
  }
  return http('activeBookings', `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}
if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {
  if (!ok() || !canonical.hasCompleteBookingList(msg.payload) || rows().some(row => !canonical.isObj(row)
    || !canonical.bookingId(row) || (canonical.bookingClientId(row) && canonical.normalizeId(canonical.bookingClientId(row)) !== canonical.normalizeId(ctx.actorClientId)))) return stop('PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
  if (ctx.step === 'activeBookings') {
    ctx.activePayload = msg.payload;
    return http('historyBookings', `/end-user/api/v2/${ctx.tenantKey}/bookings/history?includeCanceled=true&size=1000`);
  }
  ctx.bookings = canonical.mergeBookings(ctx.activePayload, msg.payload);
  ctx.activeBookings = canonical.mergeBookings(ctx.activePayload, []).filter(row => !canonical.isInactiveBooking(row));
  delete ctx.activePayload;
  return find('operations', { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    serviceDate: ctx.target.startsAt.slice(0, 10), 'lk1.rule.productId': 'db7a5250-7369-4f43-8ac5-9111be24bc74' }, 2);
}
if (ctx.step === 'operations') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('LK1_ALLOWANCE_READ_FAILED');
  ctx.operations = msg.payload;
  return http('room', `/api/v1/studios/${encodeURIComponent(ctx.target.stationId)}/rooms/${encodeURIComponent(ctx.target.roomId)}`, true);
}
if (ctx.step === 'room') {
  if (!ok() || String(msg.payload?.id || msg.payload?.roomId || '') !== ctx.target.roomId) return stop('SPLIT_PRICING_ROOM_STUDIO_MISMATCH');
  return http('studios', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/studios?`);
}
if (ctx.step === 'studios') {
  if (!ok() || !pricing.extractList(msg.payload).some(row => String(row?.id || row?.uuid || row?.studioId || row?.stationId || '') === ctx.target.stationId)) return stop('SPLIT_EXACT_PRICE_MASTER_SERVICE_MISMATCH');
  return http('subservices', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/subServices?studioId=${ctx.target.stationId}&showAll=true`);
}
if (ctx.step === 'subservices') {
  const ids = new Set(pricing.extractList(msg.payload).flatMap(row => Array.isArray(row?.subServices) ? row.subServices : [row])
    .map(row => String(row?.id || row?.uuid || row?.subServiceId || row?.serviceId || row?.productId || '')));
  if (!ok() || ctx.target.subServiceIds.some(id => !ids.has(id))) return stop('SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH');
  const localEnd = new Date(Date.parse(ctx.target.startsAt) + (ctx.target.durationMinutes + 180) * 60000).toISOString();
  // Current CREATE binds a single local date to both ends. Do not invent a cross-day tariff here.
  if (localEnd.slice(0, 10) !== ctx.target.startsAt.slice(0, 10)) return stop('PRICE_PREVIEW_CROSS_DAY_UNRESOLVED');
  const query = new URLSearchParams({ studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    subServiceIds: ctx.target.subServiceIds.join(','), fromTime: ctx.target.startsAt.slice(11, 19),
    toTime: localEnd.slice(11, 19), fromDate: ctx.target.startsAt.slice(0, 10) });
  return http('price', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/price?${query}`);
}
if (ctx.step === 'price') {
  const total = pricing.extractExactCourtPrice(msg.payload, ctx.target.subServiceIds);
  if (!ok() || total === null || total < 0) return stop('SPLIT_EXACT_PRICE_INVALID');
  ctx.basePriceMinor = Math.round(total / ctx.target.shareCount * 100);
  if (!Number.isSafeInteger(ctx.basePriceMinor) || ctx.basePriceMinor > 1000000) return stop('SPLIT_EXACT_PRICE_INVALID');
  ctx.pending = [...ctx.requestedIds]; ctx.quotes = []; ctx.step = 'next';
}
if (ctx.step === 'evaluate') {
  const decision = msg._managedSubscriptionPolicyDecision;
  if (!canonical.isObj(decision)) return stop('PRICE_PREVIEW_DECISION_INVALID');
  if (!decision.eligible) {
    if (decision.blockers?.length === 1 && decision.blockers[0].code === 'ACTIVE_SERVICES_LIMIT_REACHED') quote(ctx.currentId, 'LIMIT_USED', null, 0, 0, 'ACTIVE_SERVICES_LIMIT_REACHED');
    else return stop('PRICE_PREVIEW_DECISION_UNRESOLVED');
  } else {
    if (!Number.isSafeInteger(decision.benefit?.finalPriceMinor) || !decision.gameMinutes) return stop('PRICE_PREVIEW_DECISION_INVALID');
    quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, decision.gameMinutes.freeMinutes, decision.gameMinutes.paidOverageMinutes);
  }
  delete msg._managedSubscriptionPolicyDecision; delete msg._managedSubscriptionPolicyInput;
  ctx.step = 'next';
}
while (ctx.step === 'next') {
  const id = ctx.pending.shift();
  if (!id) { ctx.done = true; ctx.statusCode = 200; return out(4); }
  const live = ctx.subscriptions[id];
  const productId = ctx.metadata[id].productId;
  const name = ctx.catalog[productId];
  const bound = { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: id,
    lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,
      productId, name, purchaseDate: live.purchaseDate, subscription: live } };
  const exercise = { id: 'preview', studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    timeFrom: ctx.target.startsAt, timeTo: new Date(Date.parse(ctx.target.startsAt) + ctx.target.durationMinutes * 60000).toISOString(),
    directionId: 4588, typeId: 1613, availableClientSubscriptions: [live] };
  if (['availableStudios', 'availableTypes', 'availableDirections'].some(field => live[field] != null && !Array.isArray(live[field]))) return stop('PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID');
  if (canonical.preflightAvailability.resolveSplitSubscriptionLifecycle(live, ctx.target.startsAt.slice(0, 10)) === 'UNAVAILABLE'
    || live.holdUntil || live.frozenUntil || live.isFrozen === true || live.visitsLeft === 0) {
    quote(id, live.visitsLeft === 0 ? 'LIMIT_USED' : 'UNAVAILABLE', null, 0, 0, live.visitsLeft === 0 ? 'SUBSCRIPTION_VISITS_EXHAUSTED' : 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue;
  }
  const owned = canonical.identityOwned(bound, [live], exercise);
  if (owned.length !== 1) return stop('PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED');
  if (productId.toLowerCase() === 'db7a5250-7369-4f43-8ac5-9111be24bc74') {
    const dates = canonical.collectSubscriptionPurchaseDateEvidence(owned);
    if (dates.invalid || dates.dates.length !== 1) return stop('SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED');
  }
  const configured = canonical.lk1Config(owned);
  if (configured.code) return stop(configured.code);
  const visitCount = configured.matched ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;
  if (canonical.preflightAvailability.filterSplitEligibleSubscriptions(owned, new Set(['1613']), new Set(['4588']),
    ctx.target.stationId, visitCount, ctx.target.durationMinutes, ctx.target.startsAt.slice(0, 10)).length !== 1) {
    quote(id, 'UNAVAILABLE', null, 0, 0, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue;
  }
  if (!configured.matched) {
    const plan = canonical.compatibilityPlanKey(canonical.resolvePlanKey(owned), { enabled: false });
    if (!plan || !canonical.PLAN_CATEGORIES[plan]?.includes('open_game')) return stop('PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED');
    const limit = canonical.resolveLimitMode(plan, ctx.target.startsAt.slice(0, 10));
    let conflict = false;
    for (const booking of ctx.bookings) {
      if (!canonical.isSubscriptionBooking(booking) || canonical.isInactiveBooking(booking)
        || canonical.eventDate(booking) !== ctx.target.startsAt.slice(0, 10)) continue;
      const subscription = canonical.bookingSubscriptionId(booking);
      if (!subscription && limit !== 'event') return stop('SUBSCRIPTION_DAILY_LIMIT_BOOKING_UNRESOLVED');
      if (canonical.normalizeId(subscription) !== canonical.normalizeId(id) || limit === 'event') continue;
      const category = canonical.resolveCategory(booking);
      if (!category) return stop('SUBSCRIPTION_DAILY_LIMIT_BOOKING_UNRESOLVED');
      if (limit === 'shared_day' ? canonical.PLAN_CATEGORIES[plan].includes(category) : category === 'open_game') conflict = true;
    }
    quote(id, conflict ? 'LIMIT_USED' : 'AVAILABLE', conflict ? null : 0,
      conflict ? 0 : ctx.target.durationMinutes, 0, conflict ? 'SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED' : null);
    continue;
  }
  ctx.currentId = id;
  const usageContext = { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: id,
    serviceDate: ctx.target.startsAt.slice(0, 10), managedAction: 'CREATE_GAME', step: 'lk1_usage_operations',
    lk1: { rule: configured.rule, bookings: ctx.bookings, activeBookings: ctx.activeBookings,
      target: { resolutionSource: 'SERVER', category: 'GAME', currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF',
        basePriceMinor: ctx.basePriceMinor, startsAt: ctx.target.startsAt, durationMinutes: ctx.target.durationMinutes } } };
  if (ctx.operations.some(row => row?.lk1?.rule?.productId !== configured.rule.productId)) return stop('LK1_ALLOWANCE_RECORD_INVALID');
  const usageMessage = { payload: ctx.operations, _subscriptionBooking: usageContext };
  canonicalUsage(usageMessage);
  if (usageMessage.previewError || !usageMessage._managedSubscriptionPolicyInput) return stop(usageMessage.previewError || 'LK1_ALLOWANCE_READ_FAILED');
  msg._managedSubscriptionPolicyInput = usageMessage._managedSubscriptionPolicyInput;
  ctx.step = 'evaluate'; return out(3);
}
return stop('PRICE_PREVIEW_STEP_INVALID');

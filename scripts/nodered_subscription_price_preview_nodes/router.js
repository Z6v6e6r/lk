// Dedicated advisory graph. `canonical` consists only of source-bound helpers.
const ctx = msg._subscriptionPricePreview;
if (!ctx) return null;
// Event identity is checked again against Viva; caller input cannot select a game tariff.
const eventCategory = ctx.eventCategory || (ctx.groupTraining ? 'GROUP_TRAINING' : null);
const eventRoute = eventCategory === 'GROUP_TRAINING'
  ? { category: 'group_training', action: 'BOOK_GROUP_TRAINING', rule: 'groupTrainingDiscountPercent',
    kind: 'GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1', error: 'GROUP_DISCOUNT' }
  : eventCategory === 'TOURNAMENT'
    ? { category: 'tournament', action: 'BOOK_TOURNAMENT', rule: 'tournamentDiscountPercent',
      kind: 'TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1', error: 'TOURNAMENT_DISCOUNT' } : null;
const out = index => { const result = [null, null, null, null, null, null]; result[index] = msg; return result; };
const stop = (code, status = 503) => { ctx.done = true; ctx.error = code; ctx.statusCode = status; return out(4); };
// A decision blocker states something about this subscription, not about the request.
// Only the codes below describe a state the client can act on (book with another
// subscription, or pay the ordinary price); every other code stays a fail-closed 503.
// `ACTIVE_SERVICES_LIMIT_REACHED` is the superseded cap blocker: the cap is a discount
// now (`aboveActiveLimit`), and the code is kept only for generations that still emit it.
// `USAGE_SNAPSHOT_BUCKET_MISMATCH` is what that cap used to mask for a client whose
// active bookings are full and whose free-minute snapshot does not prove the day, so it
// restores the pre-release answer for exactly that cohort.
const LIMIT_DECISION_BLOCKERS = ['ACTIVE_SERVICES_LIMIT_REACHED', 'USAGE_SNAPSHOT_BUCKET_MISMATCH'];
// A subscription that cannot be applied to this booking is not a transport failure: the
// target is outside the rule, the event is not included, or a partial benefit has no
// proven tariff to attach the paid part to (the contract forbids inventing the surcharge).
const UNAVAILABLE_DECISION_BLOCKERS = ['TARGET_NOT_SERVER_RESOLVED', 'EVENT_NOT_INCLUDED',
  'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND'];
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
  // A request's provenance must be its own response: Node-RED sets `msg.responseUrl`
  // on every reply and the group-tariff step compares it with the URL it asked for.
  // A stale value from the previous step made every event quote fail
  // `LK1_EVENT_TARIFF_UNVERIFIED` while the response itself was correct.
  ctx.step = step; delete msg.error; delete msg.responseUrl; delete msg.statusCode;
  msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru' + path;
  msg.headers = { Authorization: admin ? `Bearer ${token}` : ctx.auth, Accept: 'application/json' };
  msg.payload = undefined; msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
  return out(0);
};
const quote = (subscriptionId, status, amountMinor = null, freeMinutes = 0, paidMinutes = 0, reasonCode = null) => {
  ctx.quotes.push({ subscriptionId, selectionKey: ctx.selectionKey, status, basePriceMinor: ctx.basePriceMinor,
    amountMinor, freeMinutes, paidMinutes, reasonCode,
    ...(eventRoute ? { kind: eventRoute.kind, exerciseId: ctx.exerciseId,
      actorClientId: ctx.actorClientId, productId: ctx.priceProductId, subscriptionName: ctx.catalog[ctx.metadata[subscriptionId].productId],
      discountPercent: ctx.groupDiscountPercent, startsAt: ctx.target.startsAt, durationMinutes: ctx.target.durationMinutes } : {}), evaluatedAt: Date.now(), expiresAt: Date.now() + 30000 });
};
// The preview owns no rule copy. It asks the shared resolver named in the
// rollout contract (scripts/lib/lk1PlanRules.mjs), which Node-RED receives as a
// generated declaration inside this node's helper closure. The guarded fallback
// below only keeps an un-generated runtime on its current HUB-only behaviour and
// owns no rule constant of its own.
const previewRule = (owned) => {
  if (typeof canonical.resolveLk1Rule === 'function') {
    try {
      const globalReader = typeof canonical.lk1PlanRulesGlobal === 'function' ? canonical.lk1PlanRulesGlobal : null;
      const planRules = globalReader ? globalReader() : undefined;
      return canonical.resolveLk1Rule(planRules === undefined ? { owned } : { owned, planRules });
    } catch (_) { return { matched: true, code: 'LK1_PLAN_RULES_INVALID' }; }
  }
  const configured = canonical.lk1Config(owned);
  if (!configured.matched || configured.code) return configured;
  const dates = canonical.collectSubscriptionPurchaseDateEvidence(owned);
  if (dates.invalid || dates.dates.length !== 1) return { matched: true, code: 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED' };
  const enforceFrom = '2026-09-01';
  return dates.dates[0] < enforceFrom
    ? { matched: true, legacy: true, purchaseDate: dates.dates[0], enforceFrom, source: 'PLAN' }
    : { matched: true, legacy: false, rule: configured.rule, productId: configured.rule.productId,
      purchaseDate: dates.dates[0], enforceFrom, source: 'PLAN' };
};
const previewRuleCode = (configured) => configured.code === 'LK1_PRODUCT_RULE_SOURCE_MISMATCH'
  ? 'LK1_PLAN_RULES_INVALID' : configured.code;
if (ctx.done) return out(4);
if (eventRoute && typeof canonical.identityMoneyOwned !== 'function') return stop(eventRoute.error + '_BACKEND_NOT_READY');
if (msg.error) return stop('PRICE_PREVIEW_READ_FAILED');
if (Date.now() - ctx.startedAt > 28000) return stop('PRICE_PREVIEW_TIMEOUT');
if (ctx.step === 'start') return http('profile', `/end-user/api/v1/${ctx.tenantKey}/profile`);
if (ctx.step === 'profile') {
  const profile = canonical.unwrapRecord(msg.payload);
  if (!ok() || !profile || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(profile.id || profile.clientId || '')) return stop('PRICE_PREVIEW_AUTH_REQUIRED', 401);
  ctx.actorClientId = profile.id || profile.clientId;
  if (eventRoute) return http('groupExercise', `/end-user/api/v1/${ctx.tenantKey}/exercises/${ctx.exerciseId}`);
  if (ctx.existingGame) return find('game', { id: ctx.target.gameId }, 5);
  return http('subscriptions', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.step === 'groupExercise') {
  const exercise = canonical.unwrapRecord(msg.payload);
  const start = Date.parse(canonical.eventStartsAt(exercise));
  const duration = canonical.eventDurationMinutes(exercise);
  if (!ok() || !exercise || String(exercise.id || exercise.exerciseId || '') !== ctx.exerciseId
    || canonical.resolveCategory(exercise) !== eventRoute?.category || !Number.isFinite(start) || start <= Date.now()
    || !Number.isSafeInteger(duration) || duration < 1 || duration > 720
    || !canonical.exerciseRoomId(exercise) || !(exercise.studio?.id || exercise.studioId)
    || !canonical.managedExternalEventTypeId(exercise) || exercise.isCancelled === true || exercise.isCanceled === true
    || ['CANCELLED', 'CANCELED', 'DELETED', 'FINISHED', 'COMPLETED'].includes(String(exercise.status || '').toUpperCase())) return stop(eventRoute.error + '_TARGET_UNRESOLVED');
  ctx.exercise = exercise;
  // A PRO group training is outside every subscription benefit (owner decision 2026-09-18):
  // no plan percentage and no free first event apply to it, so the preview answers with an
  // empty, successful quote list instead of pricing a discount the booking gateway refuses.
  // The helper is read defensively: a generation whose canonical closure predates the
  // exclusion keeps its previous pricing instead of failing the whole quote.
  if (typeof canonical.isProTrainingExercise === 'function'
    && eventRoute.category === 'group_training' && canonical.isProTrainingExercise(exercise)) {
    ctx.quotes = []; ctx.done = true; ctx.statusCode = 200; return out(4);
  }
  ctx.target = { ...ctx.target, startsAt: new Date(start + 180 * 60000).toISOString().slice(0, 23) + '+03:00',
    durationMinutes: duration, stationId: exercise.studio?.id || exercise.studioId, roomId: canonical.exerciseRoomId(exercise) };
  return http('subscriptions', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.step === 'game') {
  if (!Array.isArray(msg.payload) || msg.payload.length !== 1 || msg.payload[0]?.id !== ctx.target.gameId) return stop('PRICE_PREVIEW_GAME_UNRESOLVED');
  const game = msg.payload[0];
  const booking = game.booking || {};
  const metadata = game.metadata || {};
  const splitPayment = metadata.splitPayment || {};
  const exerciseIds = [splitPayment.vivaExerciseId, splitPayment.viva_exercise_id, booking.vivaExerciseId,
    booking.exerciseId, metadata.vivaExerciseId, metadata.exerciseId, metadata.viva_exercise_id,
    metadata.exercise_id, splitPayment.exerciseId, splitPayment.exercise_id].filter(value => value != null && value !== '');
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const stationId = booking.studioId || metadata.studioId;
  const roomId = booking.roomId || metadata.roomId;
  const masterServiceId = booking.masterServiceId || metadata.masterServiceId;
  const subServiceIds = booking.subServiceIds || metadata.subServiceIds;
  const storedDuration = canonical.eventDurationMinutes({timeFrom: booking.timeFrom, timeTo: booking.timeTo});
  const start = `${booking.date}T${String(booking.timeFrom || '').length === 5 ? booking.timeFrom + ':00' : booking.timeFrom}+03:00`;
  if (game.isCancelled === true || game.isCanceled === true || ['CANCELLED', 'CANCELED', 'DELETED', 'FINISHED', 'COMPLETED'].includes(String(game.status || '').toUpperCase())
    || !canonical.isObj(metadata.splitPayment) || splitPayment.enabled === false
    || storedDuration !== ctx.target.durationMinutes
    || (booking.durationMinutes != null && Number(booking.durationMinutes) !== storedDuration)
    || !exerciseIds.length || exerciseIds.some(id => !uuid(id)) || new Set(exerciseIds).size !== 1
    || !uuid(stationId) || !uuid(roomId) || !uuid(masterServiceId)
    || !Array.isArray(subServiceIds) || subServiceIds.length < 1 || subServiceIds.length > 20
    || subServiceIds.some(id => !uuid(id)) || new Set(subServiceIds).size !== subServiceIds.length
    || Date.parse(start) !== Date.parse(ctx.target.startsAt)) return stop('PRICE_PREVIEW_GAME_UNRESOLVED');
  ctx.exerciseId = exerciseIds[0];
  ctx.target = { ...ctx.target, stationId, roomId, masterServiceId, subServiceIds: [...subServiceIds].sort(),
    shareCount: joinPricing.resolveIsSinglesGame({game, booking, metadata, splitPayment}) ? 2 : 4 };
  return http('exercise', `/end-user/api/v1/${ctx.tenantKey}/exercises/${ctx.exerciseId}`);
}
if (ctx.step === 'exercise') {
  const exercise = canonical.unwrapRecord(msg.payload);
  if (!ok() || !exercise || String(exercise.id || exercise.exerciseId || '') !== ctx.exerciseId
    || canonical.resolveCategory(exercise) !== 'open_game'
    || String(exercise.studio?.id || exercise.studioId || '') !== ctx.target.stationId || canonical.exerciseRoomId(exercise) !== ctx.target.roomId
    || canonical.eventDurationMinutes(exercise) !== ctx.target.durationMinutes
    || Date.parse(canonical.eventStartsAt(exercise)) !== Date.parse(ctx.target.startsAt)
    || exercise.isCancelled === true || exercise.isCanceled === true
    || ['CANCELLED', 'CANCELED', 'DELETED', 'FINISHED', 'COMPLETED'].includes(String(exercise.status || '').toUpperCase())
    || !Array.isArray(exercise.availableClientSubscriptions)) return stop('PRICE_PREVIEW_GAME_UNRESOLVED');
  ctx.exercise = exercise;
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
  if (eventRoute && ctx.requestedIds === undefined) {
    ctx.requestedIds = list.filter(row => row.status === 'ACTIVE').map(row => row.subscriptionId || row.clientSubscriptionId || row.id);
    if (ctx.requestedIds.length > 20 || ctx.requestedIds.some(id => typeof id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      || new Set(ctx.requestedIds).size !== ctx.requestedIds.length) return stop('PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
    if (!ctx.requestedIds.length) { ctx.quotes = []; ctx.done = true; ctx.statusCode = 200; return out(4); }
  }
  ctx.subscriptions = {};
  for (const id of ctx.requestedIds) {
    const matches = list.filter(row => (eventRoute ? row.subscriptionId || row.clientSubscriptionId || row.id : row.subscriptionId) === id);
    if (matches.length !== 1 || [matches[0].clientSubscriptionId, matches[0].id].some(v => v !== undefined && v !== id)
      || [matches[0].clientId, matches[0].client?.id].some(v => v !== undefined && v !== ctx.actorClientId)) return stop('PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
    ctx.subscriptions[id] = matches[0];
  }
  return find('metadata', { _id: { $in: ctx.requestedIds.map(id => key('instance', ctx.actorClientId, id)) } });
}
if (ctx.step === 'metadata') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
  ctx.metadata = {};
  // The same resolver decides which products carry a rule; the selected
  // instance's product comes from its server-owned identity, never from a name.
  ctx.rules = {};
  for (const id of ctx.requestedIds) {
    const matches = msg.payload.filter(row => row?._id === key('instance', ctx.actorClientId, id));
    const row = matches[0];
    if (matches.length !== 1 || row.kind !== 'instance' || row.tenantKey !== ctx.tenantKey
      || row.actorClientId !== ctx.actorClientId || row.subscriptionId !== id || row.invalid === true
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/i.test(row.productId || '')
      || canonical.collectExactProductIds(ctx.subscriptions[id]).some(product => product !== row.productId.toLowerCase())) return stop('SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE');
    ctx.metadata[id] = row;
    const configured = previewRule([{ ...ctx.subscriptions[id], productId: row.productId.toLowerCase() }]);
    if (configured.code) return stop(previewRuleCode(configured));
    ctx.rules[id] = configured;
  }
  ctx.ruleProductIds = [...new Set(Object.values(ctx.metadata).map(row => row.productId.toLowerCase()))];
  if (eventRoute) {
    // The contour decides which subscriptions the managed evaluator prices, never
    // which ones the client may see a price for. Out-of-contour subscriptions (a sale
    // date before the rule, or no plan rule at all) stay in the batch and are quoted at
    // the ordinary event tariff below. Dropping them produced an empty quote batch and
    // blocked every group training and tournament booking for that cohort (2026-09-15).
    ctx.managedIds = ctx.requestedIds.filter(id => ctx.rules[id].matched && !ctx.rules[id].legacy);
    ctx.outOfContourIds = ctx.requestedIds.filter(id => !ctx.managedIds.includes(id));
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
    'lk1.rule.productId': { $in: ctx.ruleProductIds } }, 2);
}
if (ctx.step === 'operations') {
  if (msg.error || !Array.isArray(msg.payload)) return stop('LK1_ALLOWANCE_READ_FAILED');
  ctx.operations = msg.payload;
  if (eventRoute) return http('groupTariff', `/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${ctx.exerciseId}`);
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
  // Function nodes do not expose Node.js URLSearchParams in their sandbox.
  const query = Object.entries({ studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    subServiceIds: ctx.target.subServiceIds.join(','), fromTime: ctx.target.startsAt.slice(11, 19),
    toTime: localEnd.slice(11, 19), fromDate: ctx.target.startsAt.slice(0, 10) })
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  return http('price', `/end-user/api/v1/${ctx.tenantKey}/products/master-services/${ctx.target.masterServiceId}/price?${query}`);
}
if (ctx.step === 'price') {
  const total = pricing.extractExactCourtPrice(msg.payload, ctx.target.subServiceIds);
  if (!ok() || total === null || total < 0) return stop('SPLIT_EXACT_PRICE_INVALID');
  ctx.basePriceMinor = Math.round(total / ctx.target.shareCount * 100);
  if (!Number.isSafeInteger(ctx.basePriceMinor) || ctx.basePriceMinor > 1000000) return stop('SPLIT_EXACT_PRICE_INVALID');
  ctx.pending = [...ctx.requestedIds]; ctx.quotes = []; ctx.step = 'next';
}
if (ctx.step === 'groupTariff') {
  if (!ok() || !canonical.hasCompleteBookingList(msg.payload)) return stop('LK1_EVENT_TARIFF_UNAVAILABLE');
  // Viva scopes this product list by the request, without echoing exerciseId.
  const tariffUrl = `https://api.vivacrm.ru/end-user/api/v2/${ctx.tenantKey}/products/one-times?exerciseId=${encodeURIComponent(ctx.exerciseId)}`;
  // Every refusal below names the exact sub-condition it refused on and the observed
  // shape (counts and enum values only, never amounts or names). The accept/reject
  // decision is unchanged: the detail exists so a production refusal can be diagnosed
  // from the response instead of guessed, without widening what this node accepts.
  const tariffRefusal = (stage, observed) => {
    ctx.errorDetails = { stage, observed };
    return stop('LK1_EVENT_TARIFF_UNVERIFIED');
  };
  if (msg.method !== 'GET' || msg.url !== tariffUrl
    || (msg.responseUrl !== undefined && msg.responseUrl !== tariffUrl)) {
    return tariffRefusal('request_url', { method: msg.method || null,
      urlMatch: msg.url === tariffUrl, responseUrlMatch: msg.responseUrl === undefined || msg.responseUrl === tariffUrl });
  }
  const rows = canonical.extractItems(msg.payload);
  if (rows.length !== 1 || !canonical.isObj(rows[0])) return stop("LK1_EVENT_TARIFF_AMBIGUOUS");
  const product = rows[0];
  const productIds = [product.id, product.productId].filter((id) => id !== undefined);
  const eventIds = [product.exerciseId, product.exercise?.id].filter((id) => id !== undefined);
  // The DTO carries two kinds of money: the paid price (`cost`/`price`/`amount` are
  // aliases of one number and must agree) and the trial price (`trialCost`), which
  // describes a different offer and only has to be a non-negative integer. Requiring the
  // trial price to equal the paid one refused every exercise whose trial tariff differs
  // (live evidence 2026-09-15: both fields present, two distinct non-zero integers).
  const paidFields = ['cost', 'price', 'amount'].filter((field) => product[field] !== undefined);
  const paidAmounts = paidFields.map((field) => product[field]);
  const trialPresent = product.trialCost !== undefined;
  const trialAmount = trialPresent ? product.trialCost : null;
  const types = [product.productType, product.type].filter((type) => type !== undefined);
  const allowedTypes = ["SERVICE", "ONE_TIME", "INSTANT_SUB_SERVICE", "ADVANCE_SUB_SERVICE"];
  // Field names and shapes only: an amount is never copied into the refusal, but the
  // names and the number of distinct (and zero) values are what identifies the rule.
  const observed = { productIds: productIds.length, idsAgree: new Set(productIds).size === 1,
    eventIds: eventIds.length, eventIdMatches: !eventIds.some((id) => id !== ctx.exerciseId),
    types: types.map((type) => String(type).slice(0, 40)), paidFields, paidDistinct: new Set(paidAmounts).size,
    paidZero: paidAmounts.filter((amount) => amount === 0).length,
    paidAgree: new Set(paidAmounts).size === 1,
    paidAreNonNegativeIntegers: paidAmounts.every((amount) => Number.isSafeInteger(amount) && amount >= 0),
    trialPresent, trialIsNonNegativeInteger: !trialPresent || (Number.isSafeInteger(trialAmount) && trialAmount >= 0) };
  if (!productIds.length || !productIds.every((id) => typeof id === "string" && id.trim())
    || new Set(productIds).size !== 1 || eventIds.some((id) => id !== ctx.exerciseId)) {
    return tariffRefusal('product_identity', observed);
  }
  if (!types.length || types.some((type) => !allowedTypes.includes(type))) return tariffRefusal('product_type', observed);
  if (!paidAmounts.length || paidAmounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || new Set(paidAmounts).size !== 1) return tariffRefusal('product_amount', observed);
  if (trialPresent && (!Number.isSafeInteger(trialAmount) || trialAmount < 0)) {
    return tariffRefusal('product_trial_amount', observed);
  }
  ctx.basePriceMinor = paidAmounts[0]; ctx.priceProductId = productIds[0];
  if (ctx.basePriceMinor > 1000000) return tariffRefusal('amount_ceiling', observed);
  ctx.pending = [...ctx.requestedIds]; ctx.quotes = []; ctx.step = 'next';
}
if (ctx.step === 'evaluate') {
  const decision = msg._managedSubscriptionPolicyDecision;
  if (!canonical.isObj(decision)) return stop('PRICE_PREVIEW_DECISION_INVALID');
  if (!decision.eligible) {
    const code = decision.blockers?.length === 1 ? decision.blockers[0].code : null;
    if (LIMIT_DECISION_BLOCKERS.includes(code)) quote(ctx.currentId, 'LIMIT_USED', null, 0, 0, code);
    else if (UNAVAILABLE_DECISION_BLOCKERS.includes(code)) quote(ctx.currentId, 'UNAVAILABLE', null, 0, 0, code);
    else {
      // Name the blocker (codes only) so an unmapped refusal is diagnosed from the
      // response instead of reproduced. The verdict itself stays fail-closed.
      ctx.errorDetails = { stage: 'decision_blockers',
        blockers: (decision.blockers || []).map((blocker) => String(blocker?.code || 'UNNAMED').slice(0, 60)) };
      return stop('PRICE_PREVIEW_DECISION_UNRESOLVED');
    }
  } else {
    if (!Number.isSafeInteger(decision.benefit?.finalPriceMinor) || decision.benefit.finalPriceMinor < 0
      || decision.benefit.finalPriceMinor > ctx.basePriceMinor) return stop('PRICE_PREVIEW_DECISION_INVALID');
    if (eventRoute) {
      // The first covered event of the subscription's day is carried by the plan itself: one
      // visit is consumed and nothing is charged. It is quoted as the full benefit at zero (100%
      // of the base), which is the shape the widget validates and the shape the booking gateway
      // accepts as the expectation for a free covered event. Every later event of that day keeps
      // the configured discount.
      const freeCovered = decision.subscriptionVisitCount === 1
        && decision.benefit?.kind === 'FREE_ENTITLEMENT' && decision.benefit.finalPriceMinor === 0;
      if (!freeCovered && (decision.subscriptionVisitCount !== 0
        || (!Number.isSafeInteger(ctx.groupDiscountPercent) || ctx.groupDiscountPercent < 0 || ctx.groupDiscountPercent > 100)
        || decision.benefit.finalPriceMinor !== ctx.basePriceMinor - Math.floor(ctx.basePriceMinor * ctx.groupDiscountPercent / 100))) {
        return stop(eventRoute.error + '_DECISION_INVALID');
      }
      if (freeCovered) {
        const configuredPercent = ctx.groupDiscountPercent;
        ctx.groupDiscountPercent = 100;
        quote(ctx.currentId, 'AVAILABLE', 0, 0, ctx.target.durationMinutes);
        ctx.groupDiscountPercent = configuredPercent;
      } else {
        quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, 0, ctx.target.durationMinutes);
      }
    } else {
      if (!decision.gameMinutes) return stop('PRICE_PREVIEW_DECISION_INVALID');
      quote(ctx.currentId, 'AVAILABLE', decision.benefit.finalPriceMinor, decision.gameMinutes.freeMinutes, decision.gameMinutes.paidOverageMinutes);
    }
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
  const exercise = ctx.exercise || { id: 'preview', studioId: ctx.target.stationId, roomId: ctx.target.roomId,
    timeFrom: ctx.target.startsAt, timeTo: new Date(Date.parse(ctx.target.startsAt) + ctx.target.durationMinutes * 60000).toISOString(),
    directionId: 4588, typeId: 1613, availableClientSubscriptions: [live] };
  if (!eventRoute && ['availableStudios', 'availableTypes', 'availableDirections'].some(field => live[field] != null && !Array.isArray(live[field]))) return stop('PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID');
  if (!eventRoute && (canonical.preflightAvailability.resolveSplitSubscriptionLifecycle(live, ctx.target.startsAt.slice(0, 10)) === 'UNAVAILABLE'
    || live.holdUntil || live.frozenUntil || live.isFrozen === true || live.visitsLeft === 0)) {
    quote(id, live.visitsLeft === 0 ? 'LIMIT_USED' : 'UNAVAILABLE', null, 0, 0, live.visitsLeft === 0 ? 'SUBSCRIPTION_VISITS_EXHAUSTED' : 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue;
  }
  const available = ctx.existingGame ? exercise.availableClientSubscriptions.filter(row => {
    if (!canonical.isObj(row)) return false;
    const ids = [row.clientSubscriptionId, row.subscriptionId, row.clientSubId, row.clientSubscription?.id,
      row.clientSubscription?.clientSubscriptionId, row.clientSub?.id].filter(value => value !== undefined && value !== null);
    const aliases = ids.length ? ids : [row.id, row.uuid].filter(value => value !== undefined && value !== null);
    return aliases.length > 0 && aliases.every(value => typeof value === 'string' && canonical.normalizeId(value) === canonical.normalizeId(id));
  }) : [live];
  if (!available.length) { quote(id, 'UNAVAILABLE', null, 0, 0, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue; }
  // An annual HUB event quote keeps its money mandate (the strict instance money
  // identity); every other product is verified by the product identity layer, which
  // applies the same HUB constraints for HUB and stays product-agnostic otherwise.
  // Before this split only HUB could ever be owned on the event route, so a plan
  // product that passed the cohort gate died here with PRODUCT_IDENTITY_UNRESOLVED.
  const productIsHub = canonical.normalizeId(productId) === canonical.LK1_OVERLAY_HUB_PRODUCT_ID;
  const owned = eventRoute && productIsHub
    ? canonical.identityMoneyOwned(bound, available)
    : canonical.identityOwned(bound, available, exercise);
  if (owned.length !== 1) return stop('PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED');
  const dates = canonical.collectSubscriptionPurchaseDateEvidence(owned);
  const configured = previewRule(owned);
  if (configured.code) return stop(previewRuleCode(configured));
  ctx.previewResolved = configured.matched && !configured.legacy && productId.toLowerCase() === configured.rule.productId;
  if (ctx.previewResolved && (dates.invalid || dates.dates.length !== 1)) return stop('SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED');
  if (eventRoute && ctx.previewResolved) {
    const activation = canonical.lk1LifecycleInstant(live.activationDate);
    const expiry = canonical.lk1LifecycleInstant(live.expirationDate, true);
    const targetStart = Date.parse(ctx.target.startsAt);
    if (live.status !== 'ACTIVE' || activation === null || expiry === null || activation > Date.now()
      || activation > targetStart || expiry < Date.now() || expiry < targetStart + ctx.target.durationMinutes * 60000 - 1
      || live.holdUntil || live.frozenUntil || live.isFrozen === true) {
      quote(id, 'UNAVAILABLE', null, 0, 0, 'LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN'); continue;
    }
    ctx.groupDiscountPercent = configured.rule[eventRoute.rule];
    if ((!Number.isSafeInteger(ctx.groupDiscountPercent) || ctx.groupDiscountPercent < 0 || ctx.groupDiscountPercent > 100)) return stop(eventRoute.error + '_RULE_UNCONFIRMED');
  }
  const visitCount = ctx.previewResolved ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;
  if (!eventRoute && canonical.preflightAvailability.filterSplitEligibleSubscriptions(owned, new Set(['1613']), new Set(['4588']),
    ctx.target.stationId, visitCount, ctx.target.durationMinutes, ctx.target.startsAt.slice(0, 10)).length !== 1) {
    quote(id, 'UNAVAILABLE', null, 0, 0, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue;
  }
  if (!ctx.previewResolved) {
    // Contour off for this subscription (sale before the rule, or no plan rule): the
    // subscription still has to produce a price the client can act on. The group and
    // tournament validators accept only an AVAILABLE quote whose amount equals the base
    // price less the quoted discount, so an ordinary-tariff quote at zero discount is
    // the exact representation of "no managed benefit here".
    if (eventRoute) {
      ctx.groupDiscountPercent = 0;
      quote(id, 'AVAILABLE', ctx.basePriceMinor, 0, ctx.target.durationMinutes);
      continue;
    }
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
    serviceDate: ctx.target.startsAt.slice(0, 10), managedAction: eventRoute ? eventRoute.action : ctx.existingGame ? 'JOIN_GAME' : 'CREATE_GAME', step: 'lk1_usage_operations',
    // The same instance identity the booking gateway binds before its policy decision: the
    // shared usage block takes the proven visit balance from it, and a covered product without
    // that balance would otherwise fail closed on a snapshot the preview could not stand behind.
    lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,
      productId, name, purchaseDate: live.purchaseDate, subscription: live },
    // The shared usage block reads the resolved source category for the cohort table; the
    // gateway sets it during target resolution, the preview has to carry it explicitly.
    category: eventRoute ? eventRoute.category : 'open_game',
    lk1: { rule: configured.rule, bookings: ctx.bookings, activeBookings: ctx.activeBookings,
      target: { resolutionSource: 'SERVER', eventId: ctx.exerciseId || 'preview', category: eventRoute ? eventCategory : 'GAME', currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF',
        basePriceMinor: ctx.basePriceMinor, startsAt: ctx.target.startsAt, durationMinutes: ctx.target.durationMinutes,
        ...(eventRoute ? { stationId: ctx.target.stationId, roomId: ctx.target.roomId,
          externalEventTypeId: canonical.managedExternalEventTypeId(exercise), productTypeId: null,
          priceProductId: ctx.priceProductId } : {}) } } };
  // The batch is deliberately wider than one product: the query above asks for every product
  // this client owns (`ctx.ruleProductIds`), because the shared usage builder scopes the day and
  // minute accounting per subscription. Demanding a single rule product here rejected the whole
  // batch for a client who owns two managed products (HUB + plan), which surfaced as a 503 and
  // "Не удалось проверить скидку по подписке" on every group and tournament form.
  if (ctx.operations.some(row => !ctx.ruleProductIds.includes(String(row?.lk1?.rule?.productId || '').toLowerCase()))) {
    return stop('LK1_ALLOWANCE_RECORD_INVALID');
  }
  const usageMessage = { payload: ctx.operations, _subscriptionBooking: usageContext };
  canonicalUsage(usageMessage);
  if (usageMessage.previewError || !usageMessage._managedSubscriptionPolicyInput) return stop(usageMessage.previewError || 'LK1_ALLOWANCE_READ_FAILED');
  msg._managedSubscriptionPolicyInput = usageMessage._managedSubscriptionPolicyInput;
  ctx.step = 'evaluate'; return out(3);
}
return stop('PRICE_PREVIEW_STEP_INVALID');

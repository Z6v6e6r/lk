// Server/provisioning input only. Terms bind an approved published policy and
// the Viva product to explicit stations and services/directions.
function readPilotRaBoostPolicy(raw, tenant, now) {
  let policy;
  try { policy = JSON.parse(raw); } catch { return null; }
  const uuid = value => typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  if (!policy || policy.tenantKey !== tenant || policy.state !== 'PUBLISHED' || policy.currency !== 'RUB'
    || typeof policy.publicationDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(policy.publicationDigest)
    || !Number.isSafeInteger(policy.validUntilMs) || policy.validUntilMs <= now
    || !uuid(policy.productId) || !Number.isSafeInteger(policy.productAmountMinor) || policy.productAmountMinor <= 0 || policy.productAmountMinor > 100000000
    || !Number.isSafeInteger(policy.durationDays) || policy.durationDays < 1 || policy.durationDays > 365
    || !pilotRaBoostProviderFacts(policy.providerFacts)
    || !policy.baseProducts || typeof policy.baseProducts !== 'object' || Array.isArray(policy.baseProducts)
    || !Object.entries(policy.baseProducts).length || !Object.entries(policy.baseProducts).every(([id, plan]) =>
      uuid(id) && ['residency', 'friendship', 'friendship-2', 'ra'].includes(plan))
    || !Array.isArray(policy.scopes) || !policy.scopes.length || !policy.scopes.every(scope => scope
      && uuid(scope.stationId) && (
        ['NEW_GAME', 'EXISTING_GAME'].includes(scope.targetKind) && uuid(scope.scopeId)
        || ['GROUP_TRAINING', 'TOURNAMENT'].includes(scope.targetKind) && Number.isSafeInteger(scope.scopeId)
      ))) return null;
  return policy;
}

function pilotRaBoostCoverage({ plan, service, pro, activeCount, gameMinutes, eventCount, proUsed, duration }) {
  if (activeCount > 8 || (pro && (proUsed || !['ra', 'friendship-2'].includes(plan)))) return 0;
  if (plan === 'friendship-2') return service === 'open_game'
    ? Math.min(duration, Math.max(0, 120 - gameMinutes)) : Number(eventCount === 0) * duration;
  const slots = Math.max(0, (plan === 'residency' ? 1 : 2) - eventCount - gameMinutes / 60);
  return service === 'open_game' ? Math.min(duration, Math.floor(slots * 60)) : Number(slots >= 1) * duration;
}

function pilotRaBoostOwnedProductId(ctx, canonical, row) {
  const products = new Set(canonical.collectExactProductIds(row));
  if (products.size > 1) return null;
  const [providerId] = products;
  const subscriptionId = row.subscriptionId || row.clientSubscriptionId || row.id;
  const mappedId = row.status === 'ACTIVE' && typeof subscriptionId === 'string'
    && Object.hasOwn(ctx.metadata, subscriptionId)
    ? ctx.metadata[subscriptionId].productId.toLowerCase() : null;
  if (providerId && mappedId && providerId !== mappedId) return null;
  return providerId || mappedId || null;
}

function pilotRaBoostCandidate(ctx, canonical, service, now) {
  const policy = ctx.pilotRaBoostPolicy;
  const duration = ctx.target.durationMinutes;
  const game = service === 'open_game';
  const targetScopeId = game ? ctx.target.masterServiceId : ctx.directionId;
  const startsAt = Date.parse(ctx.target.startsAt);
  const endsAt = startsAt + duration * 60000;
  if (!policy || !Number.isSafeInteger(ctx.basePriceMinor) || ctx.basePriceMinor <= 0
    || !Number.isSafeInteger(duration) || duration <= 0 || !Number.isFinite(startsAt) || startsAt <= now
    || (game && (ctx.target.shareCount !== 4 || ![60, 90, 120].includes(duration)))
    || !policy.scopes.some(scope => scope.targetKind === ctx.target.targetKind
      && scope.stationId === ctx.target.stationId && scope.scopeId === targetScopeId)
    || !Array.isArray(ctx.bookings) || !Array.isArray(ctx.activeBookings) || !Array.isArray(ctx.operations)
    || !Array.isArray(ctx.pilotRaBoostSubscriptions)) return null;

  // Active legacy rows can omit product aliases. The normal preview pipeline has
  // already linked those instances to the actor and checked provider conflicts.
  const ownedProducts = ctx.pilotRaBoostSubscriptions.map(row => ({
    row, productId: pilotRaBoostOwnedProductId(ctx, canonical, row),
  }));
  if (ownedProducts.some(({ productId }) => !productId)) return null;

  const facts = pilotRaBoostProviderFacts(policy.providerFacts);
  if (!facts || (facts.hasStudioLimitation && !facts.availableStudios.includes(ctx.target.stationId))) return null;
  if (facts.hasTypeLimitation || facts.hasDirectionLimitation) {
    const resolvedType = canonical.managedExternalEventTypeId(ctx.exercise);
    const ids = /^viva:direction:(\d+):type:(\d+)$/.exec(resolvedType || '');
    if (!ids || (facts.hasDirectionLimitation && !facts.availableDirections.includes(Number(ids[1])))
      || (facts.hasTypeLimitation && !facts.availableTypes.includes(Number(ids[2])))) return null;
  }

  const available = ctx.quotes.filter(quote => quote.status === 'AVAILABLE'
    && Number.isSafeInteger(quote.amountMinor) && quote.amountMinor >= 0);
  if (!available.length || available.some(quote => !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now)) return null;
  const baseQuotesExpireAt = Math.min(...available.map(quote => quote.expiresAt));
  const bestPrice = Math.min(ctx.basePriceMinor, ...available.map(quote => quote.amountMinor));
  if (bestPrice <= 0 || Object.keys(ctx.instanceErrors).length) return null;

  const ownsBoost = ownedProducts.filter(({ productId }) => productId === policy.productId).map(({ row }) => row);
  // Ambiguous, frozen, unactivated and not-yet-effective instances cannot lead to a
  // duplicate offer or an included price.
  const covers = row => row?.status === 'ACTIVE' && row.isFrozen !== true && !row.frozenUntil && !row.holdUntil
    && row.visitsLeft !== 0 && Number.isFinite(canonical.lk1LifecycleInstant(row.activationDate))
    && canonical.lk1LifecycleInstant(row.activationDate) <= now
    && Number.isFinite(canonical.lk1LifecycleInstant(row.expirationDate, true))
    && canonical.lk1LifecycleInstant(row.expirationDate, true) >= endsAt;
  if (ownsBoost.length > 1 || ownsBoost.length === 1 && !covers(ownsBoost[0])
    || !ownsBoost.length && endsAt > now + policy.durationDays * 86400000) return null;

  const date = ctx.target.startsAt.slice(0, 10);
  // Reconcile same-day operations against the complete Viva snapshot. Unknown
  // or pending operations can still change the allowance while preview runs.
  if (ctx.operations.some(row => {
    if (typeof row?.serviceDate !== 'string') return true;
    if (row.serviceDate !== date || row.state === 'FAILED' || row.state === 'RELEASED') return false;
    const bookingId = canonical.normalizeId(row.bookingId || row.upstreamBookingId);
    const subscriptionId = canonical.normalizeId(row.clientSubscriptionId);
    return row.state !== 'CONFIRMED' || !bookingId || !subscriptionId || !ctx.bookings.some(booking =>
      canonical.normalizeId(canonical.bookingId(booking)) === bookingId
      && canonical.eventDate(booking) === date && canonical.isSubscriptionBooking(booking)
      && canonical.normalizeId(canonical.bookingSubscriptionId(booking)) === subscriptionId);
  })) return null;
  let gameMinutes = 0;
  let eventCount = 0;
  let proUsed = false;
  for (const booking of ctx.bookings) {
    if (canonical.isInactiveBooking(booking) || !canonical.isSubscriptionBooking(booking)) continue;
    const day = canonical.eventDate(booking);
    if (!day) return null;
    if (day !== date) continue;
    const category = canonical.resolveCategory(booking);
    if (category === 'open_game') {
      const minutes = canonical.eventDurationMinutes(booking.exercise || booking);
      if (!Number.isSafeInteger(minutes) || minutes <= 0) return null;
      gameMinutes += minutes;
    } else if (category === 'group_training' || category === 'tournament') {
      eventCount += 1;
      proUsed ||= canonical.isProTrainingExercise(booking.exercise || booking);
    } else return null;
  }

  let best = null;
  for (const quote of available) {
    const row = ctx.subscriptions[quote.subscriptionId];
    const productId = ctx.metadata[quote.subscriptionId]?.productId;
    const plan = Object.hasOwn(policy.baseProducts, productId) ? policy.baseProducts[productId] : null;
    // AVAILABLE at the one-time price is the legacy fallback, not proof that
    // the base product applies to this event.
    if (quote.amountMinor >= ctx.basePriceMinor || !plan || !covers(row)
      || pilotRaBoostOwnedProductId(ctx, canonical, row) !== productId) continue;
    const free = pilotRaBoostCoverage({ plan, service, pro: !game && canonical.isProTrainingExercise(ctx.exercise),
      activeCount: ctx.activeBookings.filter(canonical.isSubscriptionBooking).length, gameMinutes, eventCount, proUsed, duration });
    if (free <= 0) continue;
    // Match the LK1 evaluator's minor-unit proration and discount rounding.
    const paidPartMinor = game ? Math.floor(ctx.basePriceMinor * (duration - free) / duration) : 0;
    const participationAmountMinor = paidPartMinor - Math.floor(paidPartMinor * 30 / 100);
    if (participationAmountMinor >= bestPrice || best && participationAmountMinor >= best.participationAmountMinor) continue;
    best = { kind: 'RA_BOOST', mode: ownsBoost.length ? 'included' : 'offer', selectionKey: ctx.selectionKey,
      productId: policy.productId, durationDays: policy.durationDays, participationAmountMinor,
      productAmountMinor: ownsBoost.length ? 0 : policy.productAmountMinor, basePriceMinor: ctx.basePriceMinor, basePlan: plan,
      baseAmountMinor: quote.amountMinor, baseSubscriptionId: quote.subscriptionId, expiresAt: baseQuotesExpireAt };
  }
  return best;
}

function pilotRaBoostProviderFacts(product) {
  if (!product || !Number.isSafeInteger(product.activationDays) || product.activationDays < 0
    || !['type', 'variant', 'appliesTo'].every(field => typeof product[field] === 'string' && product[field])
    || !['hasStudioLimitation', 'hasDirectionLimitation', 'hasTypeLimitation',
      'hasDayLimitation', 'hasTimeRangeLimitation', 'hasDayTimeLimitation'].every(field => typeof product[field] === 'boolean')
    // No day/time exceptions are part of the approved pilot policy. Any provider
    // restriction here needs a policy revision before restoring prices.
    || product.hasDayLimitation || product.hasTimeRangeLimitation || product.hasDayTimeLimitation) return null;
  const normalizeIds = (rows, type) => {
    if (!Array.isArray(rows)) return null;
    const ids = rows.map(row => (row !== null && typeof row === 'object' ? row.id : row));
    if (!ids.every(id => type === 'studio' ? typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id)
      : Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length) return null;
    return ids.sort();
  };
  const availableStudios = normalizeIds(product.availableStudios, 'studio');
  const availableDirections = normalizeIds(product.availableDirections, 'direction');
  const availableTypes = normalizeIds(product.availableTypes, 'type');
  if (!availableStudios || !availableDirections || !availableTypes
    || product.hasStudioLimitation && !availableStudios.length
    || product.hasDirectionLimitation && !availableDirections.length
    || product.hasTypeLimitation && !availableTypes.length) return null;
  return { activationDays: product.activationDays, type: product.type, variant: product.variant, appliesTo: product.appliesTo,
    hasStudioLimitation: product.hasStudioLimitation, availableStudios,
    hasDirectionLimitation: product.hasDirectionLimitation, availableDirections,
    hasTypeLimitation: product.hasTypeLimitation, availableTypes,
    hasDayLimitation: false, hasTimeRangeLimitation: false, hasDayTimeLimitation: false };
}

function pilotRaBoostProviderMatches(product, policy) {
  const normalizedName = typeof product?.name === 'string' ? product.name.normalize('NFKC').toLowerCase().replace(/[\s._-]+/g, '') : '';
  const facts = pilotRaBoostProviderFacts(product);
  return product?.id === policy.productId && normalizedName === 'рабуста'
    && product.cost === policy.productAmountMinor && product.validityDays === policy.durationDays
    && (product.discountPrice == null || product.discountPrice === product.cost)
    && product.validityMonths == null && product.onlyInternalSale !== true && product.showToUser !== false
    && facts !== null && JSON.stringify(facts) === JSON.stringify(pilotRaBoostProviderFacts(policy.providerFacts));
}

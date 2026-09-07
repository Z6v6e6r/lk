// Product identity is server-owned metadata; eligibility and balances still come
// from the current end-user response, never from the persistent catalog.
const identityBound = (ctx) => {
  const p = ctx.lk1ProductIdentity;
  return isObj(p) && p.actorClientId === ctx.actorClientId
    && p.subscriptionId === ctx.clientSubscriptionId && p.tenantKey === ctx.tenantKey
    && /^[a-f0-9-]{36}$/i.test(p.productId) && typeof p.name === 'string' && p.name.trim();
};
const identitySelected = (body, ctx) => {
  if (!isObj(body) || !Array.isArray(body.content) || body.totalElements !== body.content.length
    || (body.number !== undefined && body.number !== 0) || (body.totalPages !== undefined && ![0, 1].includes(body.totalPages))
    || body.last === false || body.hasNext === true) return null;
  const rows = body.content.filter(row => isObj(row) && row.subscriptionId === ctx.clientSubscriptionId);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if ([row.subscriptionId, row.clientSubscriptionId, row.id].filter(v => v !== undefined).some(v => v !== ctx.clientSubscriptionId)
    || [row.clientId, row.client?.id].filter(v => v !== undefined).some(v => v !== ctx.actorClientId)) return null;
  return row;
};
const identityOwned = (ctx, rows, exercise) => {
  if (ctx.action === 'release') return rows;
  if (!identityBound(ctx)) return [];
  const p = ctx.lk1ProductIdentity;
  const verifiedDate = normalizePurchaseDateMoscow(p.purchaseDate);
  if (isObj(p.subscription) && collectExactProductIds(p.subscription).some(id => id !== normalizeId(p.productId))) return [];
  const hub = normalizeId(p.productId) === LK1_OVERLAY_HUB_PRODUCT_ID;
  if (hub) {
    const live = p.subscription;
    if (!identitySelected({ content: [live], totalElements: 1 }, ctx)
      || collectExactProductIds(live).some(id => id !== normalizeId(p.productId))
      || preflightAvailability.resolveSplitSubscriptionLifecycle(live, eventDate(exercise)) === 'UNAVAILABLE'
      || live.holdUntil || live.frozenUntil || live.isFrozen === true
      || !Number.isSafeInteger(live.visitsLeft) || live.visitsLeft < 1
      || (live.variant !== undefined && live.variant !== 'BY_VISITS')) return [];
  }
  const result = [];
  for (const row of rows) {
    const ids = collectExactProductIds(row);
    if (ids.some(id => id !== normalizeId(p.productId))) return [];
    const aliases = [row.purchaseDate, row.purchaseAt].filter(v => v !== undefined && v !== null && v !== '');
    if (aliases.some(v => !verifiedDate || normalizePurchaseDateMoscow(v) !== verifiedDate)) return [];
    result.push({ ...(hub ? p.subscription : row), productId: p.productId, name: p.name,
      product: { ...(isObj(row.product) ? row.product : {}), id: p.productId, name: p.name },
      ...(aliases.length ? {} : { purchaseDate: p.purchaseDate }) });
  }
  return result;
};

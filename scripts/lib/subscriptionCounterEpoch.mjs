// A new allocation of LK purchases; never a claim to include provider history.
// This factory is embedded in the existing function nodes, with no new endpoint.
export function createSubscriptionCounterEpoch() {
  const id = 'subscription-sales-20260910';
  const cutoffKey = 'subscription_counter_epoch_started_at';
  const inventories = {
    ra: 'ab_leto_20260910_epoch_ra',
    friendship: 'ab_leto_20260910_epoch_friendship',
    network_friendship: 'network_friendship_12m_20260910_epoch',
    piter_friendship: 'piter_friendship_12m_20260910_epoch',
  };
  const previous = {
    network_friendship: 'network_friendship_12m_2026_v1',
    piter_friendship: 'piter_friendship_12m_2026_v1',
  };
  const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const startedAt = globalContext => {
    const value = globalContext.get(cutoffKey);
    return iso(value) ? value : null;
  };
  const isNew = (counterKey, inventoryId) => Object.hasOwn(inventories, counterKey) && inventories[counterKey] === inventoryId;
  const activeInventory = (counterKey, fallback, globalContext) => startedAt(globalContext) && Object.hasOwn(inventories, counterKey)
    ? inventories[counterKey] : fallback;
  const descriptor = value => ({ id, startedAt: value, timeZone: 'Europe/Moscow', membership: 'NEW_LK_RESERVATIONS_ONLY' });
  const validDescriptor = value => value && Object.keys(value).sort().join() === ['id','startedAt','timeZone','membership'].sort().join()
    && value.id === id && iso(value.startedAt) && value.timeZone === 'Europe/Moscow' && value.membership === 'NEW_LK_RESERVATIONS_ONLY';
  const admission = (ctx, globalContext, now = Date.now()) => {
    const cutoff = startedAt(globalContext);
    if (!cutoff) return !isNew(ctx.counterKey, ctx.inventoryId);
    if (!Object.hasOwn(inventories, ctx.counterKey)) return true;
    return isNew(ctx.counterKey, ctx.inventoryId) && globalContext.get('summer_subscription_sales_20260909_enabled') === true
      && (!ctx.counterEpoch || (validDescriptor(ctx.counterEpoch) && ctx.counterEpoch.startedAt === cutoff))
      && now >= Date.parse(cutoff);
  };
  return { id, cutoffKey, inventories, previous, iso, startedAt, isNew, activeInventory, descriptor, validDescriptor, admission };
}
export const subscriptionCounterEpoch = createSubscriptionCounterEpoch();
export function subscriptionCounterEpochSource() {
  return '// BEGIN generated subscriptionCounterEpoch\n' + createSubscriptionCounterEpoch.toString()
    + '\nconst subscriptionCounterEpoch = createSubscriptionCounterEpoch();\n// END generated subscriptionCounterEpoch\n';
}

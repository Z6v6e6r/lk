// BEGIN generated subscriptionCounterEpoch
function createSubscriptionCounterEpoch() {
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
const subscriptionCounterEpoch = createSubscriptionCounterEpoch();
// END generated subscriptionCounterEpoch
// BEGIN generated annualSubscriptionHistory
function parseVivaTimestamp(value, { requireZone = false } = {}) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || (requireZone && !match[8])) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  if (zone && zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4, 6) > 59)) return null;
  const offsetMinutes = !zone || zone === "Z" ? 0
    : (zone[0] === "+" ? 1 : -1) * (+zone.slice(1, 3) * 60 + +zone.slice(4, 6));
  return {
    precision: fraction.length,
    // Only a zoned timestamp denotes an instant.
    nanoseconds: zone ? BigInt(date.getTime() - offsetMinutes * 60_000) * 1_000_000n
      + BigInt(fraction.padEnd(9, "0")) : null,
  };
}
function matchesVivaPaymentDeadline(localValue, providerValue) {
  const local = parseVivaTimestamp(localValue, { requireZone: true });
  const provider = parseVivaTimestamp(providerValue, { requireZone: true });
  if (!local || !provider) return false;
  if (local.nanoseconds === provider.nanoseconds) return true;
  // The saved creation response can have nanoseconds; the transaction GET
  // serializes microseconds. Permit only that loss, not general millisecond drift.
  const difference = local.nanoseconds - provider.nanoseconds;
  return local.precision === 9 && provider.precision === 6
    && difference >= 0n && difference < 1_000n;
}
function assertVivaRefundProof(proof, { refundSumMinor, transactionRefundedAt } = {}) {
  if (proof?.kind !== "VIVA_REFUND_ENTITY_LINK_V1"
    || !Number.isSafeInteger(proof.refundSumMinor) || proof.refundSumMinor <= 0
    || !parseVivaTimestamp(proof.transactionRefundedAt, { requireZone: true })
    || !parseVivaTimestamp(proof.subscriptionRefundedAt)
    || (refundSumMinor !== undefined && proof.refundSumMinor !== refundSumMinor)
    || (transactionRefundedAt !== undefined && proof.transactionRefundedAt !== transactionRefundedAt)) {
    throw Error("Viva refund proof mismatch");
  }
  return proof;
}
function buildVivaRefundProof(transaction, subscription) {
  const proof = {
    kind: "VIVA_REFUND_ENTITY_LINK_V1",
    refundSumMinor: transaction?.refundSum,
    transactionRefundedAt: transaction?.refundedAt,
    subscriptionRefundedAt: subscription?.refundedAt,
  };
  if (subscription?.refundSum !== proof.refundSumMinor) throw Error("refund subscription amount mismatch");
  assertVivaRefundProof(proof);
  return proof;
}
function createAnnualSubscriptionHistory({ parseVivaTimestamp, matchesVivaPaymentDeadline, buildVivaRefundProof }) {
  const products = {
    network_friendship: { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', inventoryId: 'network_friendship_12m_2026_v1', totalLimit: 100 },
    piter_friendship: { productId: '8bf334ba-3050-4017-b40a-7eef2db1eb16', inventoryId: 'piter_friendship_12m_2026_v1', totalLimit: 400 },
  };
  const epochInventories = { network_friendship: 'network_friendship_12m_20260910_epoch', piter_friendship: 'piter_friendship_12m_20260910_epoch' };
  const isEpoch = ledger => !!epochInventories[ledger?.counterKey] && ledger.inventoryId === epochInventories[ledger.counterKey];
  const fail = message => { throw Error(`ANNUAL_HISTORY_${message}`); };
  const text = x => typeof x === 'string' && x.trim() === x && x ? x : null;
  const integer = x => Number.isSafeInteger(x) && x >= 0;
  const stable = x => JSON.stringify((function sort(v) {
    return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  })(x));
  const exactId = values => {
    const ids = values.filter(v => v !== undefined && v !== null).map(text);
    if (!ids.length || ids.some(v => !v || v !== ids[0])) fail('IDENTITY_CONFLICT');
    return ids[0];
  };
  const phone = x => {
    const n = String(x || '').replace(/\D/g, '');
    return n.length === 10 ? `7${n}` : n.length === 11 ? (n[0] === '8' ? `7${n.slice(1)}` : n) : null;
  };
  const date = x => {
    const parsed = parseVivaTimestamp(x, { requireZone: true });
    if (!parsed) fail('TIMESTAMP_INVALID');
    return new Date(Number(parsed.nanoseconds / 1_000_000n) + 3 * 3600_000).toISOString().slice(0, 10);
  };
  const active = r => ['CLAIMED', 'DISPATCHING', 'PAYMENT_PENDING', 'PROVIDER_UNKNOWN'].includes(r.state);
  const counted = f => f.state === 'PAID' && f.amountMinor > 0;

  function observe(transaction, { productId, subscriptions = [], clientId: snapshotClientId, localRow = null, requireInstance = true, allowFailed = false } = {}) {
    const t = transaction;
    const transactionId = exactId([t?.id, t?.uuid, t?.transactionId]);
    const clientId = exactId([t.clientId, t.client?.id, t.client?.uuid, t.client?.clientId]);
    const lines = t.products;
    if (!Array.isArray(lines) || lines.length !== 1) fail('PRODUCT_LINES_INVALID');
    const line = lines[0];
    if (exactId([line.id, line.uuid, line.productId, line.product?.id, t.productId]) !== productId
      || line.count !== 1 || !integer(line.cost) || !integer(line.discount)
      || line.discount > line.cost || t.sum !== line.cost || t.discount !== line.discount
      || t.toPay !== line.cost - line.discount) fail('FINANCIAL_FACTS_INVALID');
    const amountMinor = line.cost - line.discount;
    const providerStatus = exactId([t.status, t.state, t.paymentStatus]);
    const state = ['REFUND', 'REFUNDED'].includes(providerStatus) ? 'REFUNDED' : providerStatus;
    const failed = allowFailed && ['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(state);
    if (!['PAID', 'UNPAID', 'REFUNDED'].includes(state) && !failed) fail('PROVIDER_STATE_UNSUPPORTED');
    const noRefund = (t.refundSum == null || t.refundSum === 0) && !t.refundedAt
      && (line.refunded == null || line.refunded === false);
    if (failed && (t.paymentDate || !noRefund)) fail('FAILED_FACTS_INVALID');
    if (state === 'UNPAID' && (t.paymentDate || !noRefund
      || !parseVivaTimestamp(t.paymentDueDate, { requireZone: true }))) fail('UNPAID_FACTS_INVALID');
    if (state === 'PAID' && (!noRefund
      || !parseVivaTimestamp(t.paymentDate, { requireZone: true }))) fail('PAID_FACTS_INVALID');
    const phones = [t.clientPhone, t.client?.phone, t.client?.mobile, t.client?.phoneNumber].filter(v => v != null).map(phone);
    if (phones.some(v => !v || v !== phones[0])) fail('CLIENT_PHONE_CONFLICT');
    const clientPhone = phones[0] || null;
    if (localRow) {
      if (!text(localRow.paymentRef) || localRow.transactionId !== transactionId || localRow.productId !== productId
        || localRow.requestFingerprint || localRow.amountMinor !== amountMinor
        || localRow.providerProductCostMinor !== line.cost || localRow.discountMinor !== line.discount
        || (!text(localRow.clientId) && !phone(localRow.clientPhone))
        || (localRow.clientId && localRow.clientId !== clientId)
        || (localRow.clientPhone && phone(localRow.clientPhone) !== clientPhone)
        || (state === 'UNPAID' && !matchesVivaPaymentDeadline(localRow.expiresAt, t.paymentDueDate))) fail('LOCAL_FACTS_MISMATCH');
    }
    const linked = subscriptions.filter(s => [s.transactionId, s.transactionUuid, s.transaction?.id, s.transaction?.uuid].includes(transactionId));
    let subscriptionId = null, refundProof = null;
    if (linked.length || (state !== 'UNPAID' && (requireInstance || state === 'REFUNDED'))) {
      if (linked.length !== 1 || snapshotClientId !== clientId) fail('INSTANCE_LINK_INVALID');
      const s = linked[0];
      if (exactId([s.transactionId, s.transactionUuid, s.transaction?.id, s.transaction?.uuid]) !== transactionId
        || exactId([s.productId, s.subscriptionProductId, s.product?.id, s.product?.uuid]) !== productId
        || [s.clientId, s.client?.id, s.client?.uuid, s.client?.clientId].filter(v => v != null).some(v => v !== clientId)) fail('INSTANCE_IDENTITY_INVALID');
      subscriptionId = exactId([s.subscriptionId, s.clientSubscriptionId, s.id, s.uuid]);
      const ss = exactId([s.status, s.subscriptionStatus, s.state]);
      if (state === 'PAID' && !['NEW', 'ACTIVE', 'FINISHED', 'EXPIRED'].includes(ss)) fail('INSTANCE_STATUS_INVALID');
      if (state === 'REFUNDED') {
        if (ss !== 'REFUNDED' || !integer(t.refundSum) || t.refundSum > amountMinor || s.refundSum !== t.refundSum) fail('REFUND_FACTS_INVALID');
        if (amountMinor > 0) refundProof = buildVivaRefundProof(t, s);
        else {
          if (t.refundSum !== 0 || !parseVivaTimestamp(t.refundedAt, { requireZone: true })
            || !parseVivaTimestamp(s.refundedAt)) fail('FREE_RETURN_INVALID');
          refundProof = { kind: 'VIVA_FREE_ISSUE_RETURN_V1', refundSumMinor: 0,
            transactionRefundedAt: t.refundedAt, subscriptionRefundedAt: s.refundedAt };
        }
      }
    }
    return { transactionId, productId, clientId, clientPhone, amountMinor, costMinor: line.cost,
      discountMinor: line.discount, state, paidAt: t.paymentDate || null,
      paidDate: t.paymentDate ? date(t.paymentDate) : null, paymentDueDate: t.paymentDueDate || null,
      subscriptionId, refundProof };
  }

  const factIdentity = f => stable([f.transactionId, f.productId, f.clientId, f.clientPhone,
    f.amountMinor, f.costMinor, f.discountMinor, f.paymentDueDate]);
  const validFact = f => {
    if (!f || !text(f.transactionId) || !text(f.productId) || !text(f.clientId)
      || (f.clientPhone !== null && phone(f.clientPhone) !== f.clientPhone)
      || ![f.amountMinor, f.costMinor, f.discountMinor].every(integer)
      || f.amountMinor + f.discountMinor !== f.costMinor
      || !['PAID', 'UNPAID', 'REFUNDED'].includes(f.state)
      || (f.paymentDueDate !== null && !parseVivaTimestamp(f.paymentDueDate, { requireZone: true }))
      || (f.paidAt !== null && (!parseVivaTimestamp(f.paidAt, { requireZone: true }) || date(f.paidAt) !== f.paidDate))) return false;
    if (f.state === 'UNPAID') return f.paidAt === null && f.paidDate === null && f.refundProof === null && !!f.paymentDueDate;
    if (!text(f.subscriptionId)) return false;
    if (f.state === 'PAID') return !!f.paidAt && f.refundProof === null;
    const p = f.refundProof;
    return p && p.kind === (f.amountMinor > 0 ? 'VIVA_REFUND_ENTITY_LINK_V1' : 'VIVA_FREE_ISSUE_RETURN_V1')
      && integer(p.refundSumMinor) && p.refundSumMinor <= f.amountMinor
      && (f.amountMinor > 0 ? p.refundSumMinor > 0 : p.refundSumMinor === 0)
      && !!parseVivaTimestamp(p.transactionRefundedAt, { requireZone: true })
      && !!parseVivaTimestamp(p.subscriptionRefundedAt);
  };
  const projectionFor = (entry, fact, observedAt) => entry.localRowId ? {
    rowId: entry.localRowId, paymentRef: entry.paymentRef, state: 'PENDING', fields: {
      status: fact.state, updatedAt: observedAt, lastCheckedAt: observedAt,
      annualHistorySettlementId: `${fact.transactionId}:${fact.state}`,
      ...(fact.state === 'PAID' ? { paidAt: fact.paidAt } : {
        refundedAt: fact.refundProof.transactionRefundedAt, refundSumMinor: fact.refundProof.refundSumMinor,
        refundedSubscriptionId: fact.subscriptionId, annualHistoryRefundProof: fact.refundProof,
      }),
    },
  } : null;
  function current(ledger) {
    const map = new Map(ledger.history.entries.map(e => [e.transactionId, e.fact]));
    for (const s of ledger.history.settlements) map.set(s.transactionId, s.fact);
    return map;
  }
  function counts(ledger, dailyDate = ledger.dailyDate) {
    const facts = [...current(ledger).values()];
    const paidCount = facts.filter(counted).length + ledger.reservations.filter(r => r.state === 'PAID').length;
    const reservedCount = ledger.reservations.filter(active).length;
    return { paidCount, reservedCount, takenCount: paidCount + reservedCount,
      dailyBaselinePaidCount: facts.filter(f => counted(f) && f.paidDate === dailyDate).length,
      dailyPaidCount: facts.filter(f => counted(f) && f.paidDate === dailyDate).length
        + ledger.reservations.filter(r => r.state === 'PAID' && r.dailyDate === dailyDate).length,
      dailyReservedCount: ledger.reservations.filter(r => active(r) && r.dailyDate === dailyDate).length };
  }
  const admissionReady = ledger => validate(ledger) && ledger.ready === true
    && !pendingProjection(ledger)
    && ledger.history.entries.every(e => !e.lastAttemptAt || e.lastCheckedAt >= e.lastAttemptAt);
  function validate(ledger) {
    try {
      const epoch = isEpoch(ledger);
      const base = products[ledger?.counterKey];
      const spec = base && (epoch ? { ...base, inventoryId: epochInventories[ledger.counterKey] } : base);
      if (!spec || ledger._id !== `inventory:${spec.inventoryId}` || ledger.inventoryId !== spec.inventoryId
        || ledger.schemaVersion !== 3 || typeof ledger.ready !== 'boolean' || !integer(ledger.revision)
        || !/^[a-f0-9]{64}$/.test(ledger.baselineDigest || '')
        || !parseVivaTimestamp(ledger.baselineCapturedAt, { requireZone: true })
        || ledger.history?.version !== 1 || ledger.history.accountingScope !== (epoch ? 'NEW_EPOCH_RESERVATIONS_ONLY' : 'ALL_PROVIDER_PAID')
        || !Array.isArray(ledger.history.entries) || !Array.isArray(ledger.history.settlements)
        || !Array.isArray(ledger.reservations) || !Array.isArray(ledger.legacyPaymentRefs)) return false;
      if (epoch && (ledger.history.entries.length || ledger.history.settlements.length || ledger.legacyPaymentRefs.length
        || ledger.history.openingPaidCount !== 0 || ledger.epoch?.id !== 'subscription-sales-20260910'
        || ledger.epoch.timeZone !== 'Europe/Moscow' || ledger.epoch.membership !== 'NEW_LK_RESERVATIONS_ONLY'
        || !parseVivaTimestamp(ledger.epoch.startedAt, { requireZone: true })
        || Object.keys(ledger.epoch).sort().join() !== ['id','startedAt','timeZone','membership'].sort().join())) return false;
      const entries = ledger.history.entries, ids = new Set(), refs = new Set(), localIds = new Set();
      for (const e of entries) {
        if (!text(e.transactionId) || ids.has(e.transactionId) || !text(e.ref) || refs.has(e.ref)
          || !validFact(e.fact) || e.fact.transactionId !== e.transactionId || e.fact.productId !== spec.productId
          || !['LOCAL', 'PROVIDER_ONLY'].includes(e.source)
          || (e.source === 'LOCAL' ? (!text(e.localRowId) || localIds.has(e.localRowId) || !text(e.paymentRef))
            : e.localRowId !== null || e.paymentRef !== null)) return false;
        if (e.source === 'LOCAL') {
          const r = e.localPreimage;
          if (!r || r._id !== e.localRowId || r.paymentRef !== e.paymentRef || e.ref !== e.paymentRef
            || r.transactionId !== e.transactionId || r.productId !== spec.productId
            || r.counterKey !== ledger.counterKey || r.inventoryId !== ledger.inventoryId || r.requestFingerprint
            || r.amountMinor !== e.fact.amountMinor || r.providerProductCostMinor !== e.fact.costMinor || r.discountMinor !== e.fact.discountMinor
            || (!r.clientId && !phone(r.clientPhone)) || (r.clientId && r.clientId !== e.fact.clientId)
            || (r.clientPhone && phone(r.clientPhone) !== e.fact.clientPhone)) return false;
        } else if (e.localPreimage !== null || e.ref !== `viva-legacy:${spec.productId}:${e.transactionId}`) return false;
        ids.add(e.transactionId); refs.add(e.ref); if (e.localRowId) localIds.add(e.localRowId);
      }
      const initialRefs = entries.filter(e => counted(e.fact)).map(e => e.ref).sort();
      if (stable(initialRefs) !== stable([...ledger.legacyPaymentRefs].sort())
        || ledger.history.openingPaidCount !== initialRefs.length
        || !integer(ledger.quotaAdjustment)
        || (ledger.counterKey === 'piter_friendship'
          ? ledger.history.openingPaidCount + ledger.quotaAdjustment !== 52 : ledger.quotaAdjustment !== 0)) return false;
      const seenSettlements = new Set(), seenTerminal = new Map(entries.map(e => [e.transactionId, e.fact]));
      for (const s of ledger.history.settlements) {
        const before = seenTerminal.get(s.transactionId);
        const entry = entries.find(e => e.transactionId === s.transactionId);
        if (!before || !validFact(s.fact) || seenSettlements.has(s.id) || s.id !== `${s.transactionId}:${s.fact.state}`
          || factIdentity(before) !== factIdentity(s.fact)
          || before.state === 'REFUNDED' || s.fact.state === 'UNPAID'
          || (before.state === s.fact.state)
          || !parseVivaTimestamp(s.observedAt, { requireZone: true })) return false;
        const projection = projectionFor(entry, s.fact, s.observedAt);
        if (projection && s.projection?.state === 'DONE') projection.state = 'DONE';
        if (stable(projection) !== stable(s.projection)) return false;
        seenSettlements.add(s.id); seenTerminal.set(s.transactionId, s.fact);
      }
      const intents = new Set(), reservationRefs = new Set();
      for (const r of ledger.reservations) {
        if (!text(r.paymentRef) || reservationRefs.has(r.paymentRef) || refs.has(r.paymentRef)
          || r.saleRecord?.inventoryLedgerSchemaVersion !== 3
          || !['CLAIMED', 'DISPATCHING', 'PAYMENT_PENDING', 'PROVIDER_UNKNOWN', 'PAID', 'FAILED'].includes(r.state)) return false;
        if (epoch && (r.saleRecord.inventoryId !== ledger.inventoryId || r.saleRecord.counterKey !== ledger.counterKey
          || stable(r.saleRecord.counterEpoch) !== stable(ledger.epoch) || !parseVivaTimestamp(r.createdAt, { requireZone: true })
          || Date.parse(r.createdAt) < Date.parse(ledger.epoch.startedAt))) return false;
        reservationRefs.add(r.paymentRef);
        if (r.transactionId) { if (!text(r.transactionId) || ids.has(r.transactionId)) return false; ids.add(r.transactionId); }
        if (active(r)) { if (!text(r.intentFingerprint) || intents.has(r.intentFingerprint)) return false; intents.add(r.intentFingerprint); }
      }
      const c = counts(ledger);
      if (['paidCount', 'reservedCount', 'takenCount'].some(k => !integer(ledger[k]) || ledger[k] !== c[k])) return false;
      return ledger.counterKey !== 'network_friendship' || (/^\d{4}-\d{2}-\d{2}$/.test(ledger.dailyDate)
        && ['dailyBaselinePaidCount', 'dailyPaidCount', 'dailyReservedCount'].every(k => integer(ledger[k]) && ledger[k] === c[k]));
    } catch { return false; }
  }

  function settle(ledger, fact, observedAt) {
    if (!validate(ledger) || !validFact(fact) || !parseVivaTimestamp(observedAt, { requireZone: true })) fail('LEDGER_INVALID');
    const entry = ledger.history.entries.find(e => e.transactionId === fact.transactionId);
    const previous = current(ledger).get(fact.transactionId);
    if (!entry || factIdentity(previous) !== factIdentity(fact)) fail('WATCH_IDENTITY_DRIFT');
    if (previous.subscriptionId && fact.subscriptionId !== previous.subscriptionId) fail('INSTANCE_DRIFT');
    if (previous.paidAt && fact.paidAt !== previous.paidAt) fail('PAYMENT_DATE_DRIFT');
    if (previous.state === 'REFUNDED' && fact.state !== 'REFUNDED') fail('STALE_PROVIDER_STATE');
    if (fact.state === 'UNPAID' && previous.state !== 'UNPAID') fail('STALE_PROVIDER_STATE');
    const next = JSON.parse(JSON.stringify(ledger));
    const watch = next.history.entries.find(e => e.transactionId === fact.transactionId);
    watch.lastCheckedAt = observedAt;
    if (fact.state !== previous.state) {
      const id = `${fact.transactionId}:${fact.state}`;
      const projection = projectionFor(entry, fact, observedAt);
      next.history.settlements.push({ id, transactionId: fact.transactionId, fact, observedAt, projection });
    } else if (previous.paidAt !== fact.paidAt || stable(previous.refundProof) !== stable(fact.refundProof)) fail('TERMINAL_FACT_DRIFT');
    Object.assign(next, counts(next)); next.revision++; next.updatedAt = observedAt;
    if (!validate(next)) fail('SETTLEMENT_POSTIMAGE_INVALID');
    return next;
  }
  function pendingProjection(ledger) {
    return ledger.history.settlements.find(s => s.projection?.state === 'PENDING') || null;
  }
  return { products, observe, validate, counts, current, settle, pendingProjection, counted, date, stable, factIdentity, admissionReady };
}
const annualHistory = createAnnualSubscriptionHistory({ parseVivaTimestamp, matchesVivaPaymentDeadline, buildVivaRefundProof });
// END generated annualSubscriptionHistory
// BEGIN generated hubLk1SaleContract
function normalizeHubSalePolicy(value) {
  try { if (typeof value === 'string') value = JSON.parse(value); } catch { return null; }
  const keys = ['productId', 'maxActiveBookings', 'freeGameMinutesPerDay', 'gameOverageDiscountPercent', 'groupTrainingDiscountPercent', 'tournamentDiscountPercent'];
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join() !== [...keys].sort().join()
    || value.productId !== 'db7a5250-7369-4f43-8ac5-9111be24bc74'
    || keys.slice(1).some(k => !Number.isSafeInteger(value[k]) || value[k] < 0)
    || value.maxActiveBookings < 1 || keys.slice(3).some(k => value[k] > 100)) return null;
  return Object.fromEntries(keys.map(k => [k, value[k]]));
}
function normalizeFrozenHubSale(value) {
  const policy = normalizeHubSalePolicy(value?.policy);
  if (!value || value.mode !== 'LK1_VIVA_PRODUCT_NEXT_DAY_V1'
    || !['ALL_BOOKINGS', 'SUBSCRIPTION_BENEFIT_ONLY'].includes(value.bookingUsageScope) || !policy
    || !/^sha256:[a-f0-9]{64}$/.test(value.sourceDigest || '')
    || Object.keys(value).sort().join() !== ['mode', 'policy', 'sourceDigest', 'bookingUsageScope'].sort().join()) return null;
  return { mode: value.mode, policy, sourceDigest: value.sourceDigest, bookingUsageScope: value.bookingUsageScope };
}
function readHubLk1Sale(globalContext) {
  if (globalContext.get('summer_subscription_hub_lk1_sales_enabled') !== true
    || globalContext.get('summer_subscription_sales_20260909_enabled') !== true) return null;
  const policy = normalizeHubSalePolicy(globalContext.get('subscriptions_lk1_product_policy'));
  const receipt = normalizeFrozenHubSale(globalContext.get('subscriptions_lk1_hub_sale_runtime'));
  if (!policy || !receipt || JSON.stringify(policy) !== JSON.stringify(receipt.policy)) return null;
  return receipt;
}
const hubLk1Sale = readHubLk1Sale(global);
const piterNextDaySale = global.get("summer_subscription_piter_next_day_sales_20260909_enabled") === true && global.get("summer_subscription_sales_20260909_enabled") === true;
// END generated hubLk1SaleContract
const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const DEFAULT_RESERVATION_MINUTES = 30;
const DEFAULT_PLAN_KEY = "sport";
const AB_LETO_INVENTORY_ID = "ab_leto_2026_50_v1";
const AB_LETO_DAILY_DROP_START_HOUR = 10;
const AB_LETO_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
const AB_LETO_DAILY_DROP_COUNTER_KEYS = new Set(["friendship", "ra"]);
const PLAN_DEFAULTS = {
  friendship: {
    counterKey: "friendship",
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productName: "Лето.Падел.Дружба",
  },
  sport: {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productName: "Лето.Падел.Спорт",
  },
};
const DIRECT_COUNTER_DEFAULTS = {
  academy: {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productName: "Лето.Падел.Академия",
  },
  ra: {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productName: "Лето.Падел.РА",
  },
  energy5: {
    counterKey: "energy5",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
    productName: "Энергия-5",
  },
};
const SIRIUS_FRIENDSHIP_DEFAULTS = {
  counterKey: "sirius_friendship",
  saleType: "summer_campaign",
  planKey: "friendship",
  campaignKey: "summer_padel_sirius_friendship_2026",
};
const REGIONAL_FRIENDSHIP_CONFIGS = {
  kotelniki_friendship: {
    inventoryId: "kotelniki_friendship_12m_2026_v1",
    productName: "Падел.Дружба.Котельники",
  },
  network_friendship: {
    inventoryId: "network_friendship_12m_2026_v1",
    productName: "Падел.Дружба.ХАБ",
  },
  piter_friendship: {
    inventoryId: "piter_friendship_12m_2026_v1",
    productName: "Падел.Дружба.Питер",
  },
};

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const readVivaServiceEnv = (key) => {
  try {
    return typeof env !== "undefined" && env && typeof env.get === "function"
      ? toStr(env.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const readVivaServiceGlobal = (key) => {
  try {
    return typeof global !== "undefined" && global && typeof global.get === "function"
      ? toStr(global.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const buildVivaServiceTokenRequestBody = () => {
  const configuredBody = readVivaServiceEnv("VIVACRM_TOKEN_REQUEST_BODY")
    || readVivaServiceGlobal("vivacrm_token_request_body");
  if (configuredBody) return configuredBody;
  const username = readVivaServiceEnv("VIVA_SERVICE_USERNAME");
  const password = readVivaServiceEnv("VIVA_SERVICE_PASSWORD");
  if (!username || !password) return null;
  const clientId = readVivaServiceEnv("VIVA_SERVICE_CLIENT_ID") || "React-auth-dev";
  return [
    ["grant_type", "password"],
    ["client_id", clientId],
    ["username", username],
    ["password", password],
  ].map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&");
};


const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const toInt = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const parsed = Number(text.replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "friendship" || normalized === "sport") return normalized;
  return null;
};

const normalizeCounterKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "academy"
    || normalized === "energy5"
    || normalized === "friendship"
    || normalized === "kotelniki_friendship"
    || normalized === "network_friendship"
    || normalized === "piter_friendship"
    || normalized === "ra"
    || normalized === "sirius_friendship"
    || normalized === "sport"
  ) {
    return normalized;
  }
  return null;
};

const readGlobalFirst = (keys) => {
  for (const key of keys) {
    const value = toStr(global.get(key));
    if (value) return value;
  }
  return null;
};

const resolveDailyDropDate = (now = new Date(Date.now())) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const localDay = Date.UTC(year, month - 1, day);
  const dropDay = hour >= AB_LETO_DAILY_DROP_START_HOUR
    ? localDay
    : localDay - 24 * 60 * 60 * 1000;
  return new Date(dropDay).toISOString().slice(0, 10);
};

const readAbLetoInventoryId = (counterKey = null) => {
  const epochId = subscriptionCounterEpoch.activeInventory(counterKey, null, global);
  if (epochId) return epochId;
  const baseInventoryId = readGlobalFirst(["summer_subscription_inventory_id"])
    || AB_LETO_INVENTORY_ID;
  const normalizedCounterKey = String(counterKey || "").trim().toLowerCase();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(normalizedCounterKey)) {
    return baseInventoryId;
  }
  return `${baseInventoryId}_${normalizedCounterKey}_${resolveDailyDropDate()}`;
};

const readSummerPlanConfig = (planKey) => {
  const base = PLAN_DEFAULTS[planKey] || PLAN_DEFAULTS[DEFAULT_PLAN_KEY];
  if (planKey === "sport") {
    return {
      counterKey: "sport",
      inventoryId: readAbLetoInventoryId(planKey),
      saleType: "summer_campaign",
      planKey: "sport",
      campaignKey:
        readGlobalFirst(["summer_subscription_sport_campaign_key", "summer_subscription_campaign_key"])
        || base.campaignKey,
      productId:
        readGlobalFirst(["summer_subscription_sport_product_id", "summer_subscription_product_id"])
        || base.productId,
      productName:
        readGlobalFirst(["summer_subscription_sport_product_name", "summer_subscription_product_name"])
        || base.productName,
    };
  }
  return {
    counterKey: "friendship",
    inventoryId: readAbLetoInventoryId(planKey),
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey:
      readGlobalFirst(["summer_subscription_friendship_campaign_key"])
      || base.campaignKey,
    productId:
      readGlobalFirst(["summer_subscription_friendship_product_id"])
      || base.productId,
    productName:
      readGlobalFirst(["summer_subscription_friendship_product_name"])
      || base.productName,
  };
};

const readSiriusFriendshipConfig = (friendshipPlan) => ({
  counterKey: "sirius_friendship",
  inventoryId: null,
  saleType: "summer_campaign",
  planKey: "friendship",
  campaignKey:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_campaign_key",
      "summer_subscription_friendship_sirius_campaign_key",
    ])
    || SIRIUS_FRIENDSHIP_DEFAULTS.campaignKey,
  productId:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_id",
      "summer_subscription_friendship_sirius_product_id",
    ])
    || friendshipPlan.productId,
  productName:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_name",
      "summer_subscription_friendship_sirius_product_name",
    ])
    || friendshipPlan.productName,
});

const readDirectCounterConfig = (counterKey) => {
  const base = DIRECT_COUNTER_DEFAULTS[counterKey];
  if (!base) return null;
  return {
    counterKey,
    inventoryId: readAbLetoInventoryId(counterKey),
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId:
      readGlobalFirst([`summer_subscription_${counterKey}_product_id`])
      || base.productId,
    productName:
      readGlobalFirst([`summer_subscription_${counterKey}_product_name`])
      || base.productName,
    unlimited: counterKey === "academy" || counterKey === "energy5",
  };
};

const readRegionalFriendshipConfig = (counterKey) => ({
  counterKey,
  inventoryId: subscriptionCounterEpoch.activeInventory(counterKey, readGlobalFirst([`summer_subscription_${counterKey}_inventory_id`]) || REGIONAL_FRIENDSHIP_CONFIGS[counterKey].inventoryId, global),
  saleType: "tiered_direct_product",
  planKey: null,
  campaignKey: null,
  productId: null,
  productName: REGIONAL_FRIENDSHIP_CONFIGS[counterKey].productName,
  unlimited: false,
});

const buildCounterConfigMap = () => {
  const friendship = readSummerPlanConfig("friendship");
  return {
    academy: readDirectCounterConfig("academy"),
    energy5: readDirectCounterConfig("energy5"),
    friendship,
    kotelniki_friendship: readRegionalFriendshipConfig("kotelniki_friendship"),
    network_friendship: readRegionalFriendshipConfig("network_friendship"),
    piter_friendship: readRegionalFriendshipConfig("piter_friendship"),
    ra: readDirectCounterConfig("ra"),
    sirius_friendship: readSiriusFriendshipConfig(friendship),
    sport: readSummerPlanConfig("sport"),
  };
};

const resolveHttpTimeoutMs = () => {
  const raw = toInt(global.get("summer_subscription_http_timeout_ms"), 20000);
  return Math.max(3000, Math.min(120000, raw));
};

const resolveReservationMinutes = () => {
  const raw = toInt(global.get("summer_subscription_reservation_minutes"), DEFAULT_RESERVATION_MINUTES);
  return Math.max(5, Math.min(360, raw));
};

const failMsg = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, response, response];
};

const resolveCounterFromRecord = (record, configMap) => {
  const recordCounterKey = normalizeCounterKey(record?.counterKey);
  if (recordCounterKey && configMap[recordCounterKey]) {
    return configMap[recordCounterKey];
  }

  const recordCampaignKey = toStr(record?.campaignKey);
  if (recordCampaignKey) {
    const byCampaign = Object.values(configMap).find((counter) => toStr(counter?.campaignKey) === recordCampaignKey);
    if (byCampaign) return byCampaign;
  }

  const recordProductId = toStr(record?.productId);
  if (recordProductId) {
    const byProduct = Object.values(configMap).find((counter) => toStr(counter?.productId) === recordProductId);
    if (byProduct) return byProduct;
  }

  const recordPlanKey = normalizePlanKey(record?.planKey);
  if (recordPlanKey === "friendship") return configMap.friendship;
  if (recordPlanKey === "sport") return configMap.sport;
  return null;
};

const scoreRecord = (record, ctx, configMap) => {
  let score = 0;
  const recordCounter = resolveCounterFromRecord(record, configMap);
  const recordCounterKey = toStr(recordCounter?.counterKey) || normalizeCounterKey(record?.counterKey);
  const recordInventoryId = toStr(record?.inventoryId);
  const recordCampaignKey = toStr(record?.campaignKey);
  const recordPlanKey = normalizePlanKey(record?.planKey);
  const recordProductId = toStr(record?.productId);

  if (recordCounterKey && recordCounterKey === normalizeCounterKey(ctx.counterKey)) score += 500;
  if (recordInventoryId && recordInventoryId === toStr(ctx.inventoryId)) score += 600;
  if (recordCampaignKey && recordCampaignKey === toStr(ctx.campaignKey)) score += 400;
  if (recordPlanKey && recordPlanKey === normalizePlanKey(ctx.planKey)) score += 250;
  if (recordProductId && recordProductId === toStr(ctx.productId)) score += 200;
  score += toTs(record?.updatedAt) ?? toTs(record?.createdAt) ?? 0;
  return score;
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "confirm") {
  return failMsg(500, "Summer subscription confirm context is missing");
}

const configMap = buildCounterConfigMap();
const docs = rows
  .filter((item) => item && typeof item === "object")
  .sort((left, right) => scoreRecord(right, ctx, configMap) - scoreRecord(left, ctx, configMap));

const record = docs[0] || null;
if (!record) {
  return failMsg(404, "Платеж не найден", {
    counterKey: ctx.counterKey || null,
    campaignKey: ctx.campaignKey || null,
    paymentRef: ctx.paymentRef,
  });
}

if (ctx.annualHistoryJob === true && ctx.reconcile === true && record.documentType === 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1') {
  const spec = annualHistory.products[record.counterKey];
  if (!spec || record.inventoryId !== spec.inventoryId || record.productId !== spec.productId || !toStr(record.transactionId)) return null;
  ctx.counterKey = record.counterKey; ctx.inventoryId = record.inventoryId; ctx.productId = record.productId;
  ctx.transactionId = record.transactionId; ctx.clientId = record.clientId;
  ctx.paymentRef = record.paymentRef; ctx.annualHistoryRowId = record.localRowId;
  ctx.annualHistoryCandidate = true; ctx.step = "token_confirm"; ctx.httpRequestTimeoutMs = resolveHttpTimeoutMs();
  msg.method = "POST"; msg.url = TOKEN_URL; msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.httpRequestTimeout = ctx.httpRequestTimeoutMs; msg.payload = buildVivaServiceTokenRequestBody();
  if (!msg.payload) return failMsg(503, "Сервисная авторизация Viva не настроена", { code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED" });
  return [msg, null, null];
}
if (ctx.annualHistoryLedger === true && ctx.reconcile === true) {
  if (!annualHistory.validate(record)) return failMsg(503, "История годовых требует сверки", { code: "ANNUAL_HISTORY_LEDGER_INVALID" });
  ctx.counterKey = record.counterKey; ctx.inventoryId = record.inventoryId;
  const pending = annualHistory.pendingProjection(record);
  if (pending) {
    ctx.step = "annual_history_resume";
    return [null, null, null, msg];
  }
  const watch = [...record.history.entries].sort((a,b) => String(a.lastAttemptAt || a.lastCheckedAt).localeCompare(String(b.lastAttemptAt || b.lastCheckedAt)))[0];
  if (!watch) return null;
  ctx.transactionId = watch.transactionId; ctx.productId = watch.fact.productId;
  ctx.clientId = watch.fact.clientId; ctx.annualHistoryCandidate = true;
  ctx.annualHistoryRowId = watch.localRowId; ctx.paymentRef = watch.paymentRef;
  ctx.step = "token_confirm"; ctx.httpRequestTimeoutMs = resolveHttpTimeoutMs();
  msg.method = "POST"; msg.url = TOKEN_URL;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
  msg.payload = buildVivaServiceTokenRequestBody();
  if (!msg.payload) return failMsg(503, "Сервисная авторизация Viva не настроена", { code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED" });
  return [msg, null, null];
}

if (record.hubLk1Sale != null && !normalizeFrozenHubSale(record.hubLk1Sale)) {
  return failMsg(503, "Сохранённые правила продажи ХАБ требуют сверки", { code: "HUB_FROZEN_SALE_MODE_INVALID" });
}
const recordCounter = resolveCounterFromRecord(record, configMap);
ctx.counterKey = toStr(ctx.counterKey) || toStr(recordCounter?.counterKey) || normalizeCounterKey(record.counterKey);
ctx.inventoryId = toStr(record.inventoryId) || toStr(ctx.inventoryId) || toStr(recordCounter?.inventoryId) || null;
ctx.saleType = toStr(ctx.saleType) || toStr(recordCounter?.saleType) || null;
ctx.campaignKey = toStr(ctx.campaignKey) || toStr(record.campaignKey) || toStr(recordCounter?.campaignKey) || null;
ctx.planKey = normalizePlanKey(ctx.planKey) || normalizePlanKey(record.planKey) || normalizePlanKey(recordCounter?.planKey);
ctx.transactionId = toStr(record.transactionId) || null;
ctx.clientPhone = toStr(record.clientPhone) || null;
ctx.clientId = toStr(record.clientId) || null;
ctx.studioId = toStr(record.studioId) || null;
ctx.productId = toStr(record.productId) || toStr(recordCounter?.productId) || null;
ctx.productName = toStr(record.productName) || toStr(recordCounter?.productName) || null;
ctx.toPayMinor = Number.isFinite(Number(record.toPayMinor)) ? Number(record.toPayMinor) : null;
ctx.expectedAmountMinor = Number.isInteger(record.amountMinor) ? record.amountMinor : null;
ctx.requestFingerprint = toStr(record.requestFingerprint);
if (record.inventoryLedgerSchemaVersion !== undefined && record.inventoryLedgerSchemaVersion !== 3) {
  return failMsg(503, "Формат сохранённой продажи требует сверки", { code: "ANNUAL_SALE_SCHEMA_INVALID" });
}
ctx.inventoryLedgerSchemaVersion = record.inventoryLedgerSchemaVersion;
ctx.counterEpoch = record.counterEpoch;
if (subscriptionCounterEpoch.isNew(ctx.counterKey, ctx.inventoryId)
  && (!subscriptionCounterEpoch.validDescriptor(ctx.counterEpoch)
    || (["network_friendship", "piter_friendship"].includes(ctx.counterKey)
      && (!ctx.requestFingerprint || record.inventoryLedgerSchemaVersion !== 3)))) return failMsg(503, "Сохранённый период платежа требует сверки", { code: "COUNTER_EPOCH_FROZEN_SALE_INVALID" });

ctx.providerAttemptedAt = toStr(record.providerAttemptedAt);
ctx.dispatchGeneration = Number.isInteger(record.dispatchGeneration) && record.dispatchGeneration >= 0
  ? record.dispatchGeneration
  : 0;
ctx.saleRecord = {
  ...(ctx.counterEpoch ? { counterEpoch: ctx.counterEpoch } : {}),
  ...(record.inventoryLedgerSchemaVersion === 3 ? { inventoryLedgerSchemaVersion: 3 } : {}),
  counterKey: ctx.counterKey,
  inventoryId: ctx.inventoryId,
  paymentRef: ctx.paymentRef,
  requestFingerprint: ctx.requestFingerprint,
  clientPhone: ctx.clientPhone,
  clientId: ctx.clientId,
  studioId: ctx.studioId,
  batchIndex: Number.isInteger(record.batchIndex) ? record.batchIndex : null,
  batchSize: Number.isInteger(record.batchSize) ? record.batchSize : null,
  productId: ctx.productId,
  productName: ctx.productName,
  amountMinor: ctx.expectedAmountMinor,
  providerProductCostMinor: Number.isInteger(record.providerProductCostMinor)
    ? record.providerProductCostMinor
    : null,
  discountMinor: Number.isInteger(record.discountMinor) ? record.discountMinor : null,
  unlimited: record.unlimited === true,
  releasePhase: toStr(record.releasePhase),
  releaseStartDate: toStr(record.releaseStartDate),
  totalLimit: Number.isInteger(record.totalLimit) ? record.totalLimit : null,
  launchLimit: Number.isInteger(record.launchLimit) ? record.launchLimit : 0,
  dailyLimit: Number.isInteger(record.dailyLimit) ? record.dailyLimit : 0,
  dailyDropDate: toStr(record.dailyDropDate),
  saleType: ctx.saleType,
  planKey: ctx.planKey,
  campaignKey: ctx.campaignKey,
  trainerQrCode: toStr(record.trainerQrCode),
  referralToken: toStr(record.referralToken),
  referralVisitId: toStr(record.referralVisitId),
  productType: toStr(record.productType) || "SUBSCRIPTION",
  providerActivationDays: Number.isInteger(record.providerActivationDays) ? record.providerActivationDays : null,
  providerAutoActivationDate: toStr(record.providerAutoActivationDate),
  providerLifecycleMode: toStr(record.providerLifecycleMode),
  activationNotBeforeDate: toStr(record.activationNotBeforeDate),
  providerValidityDays: Number.isInteger(record.providerValidityDays) ? record.providerValidityDays : null,
  providerVisits: Number.isInteger(record.providerVisits) ? record.providerVisits : null,
  managedSaleBinding: record.managedSaleBinding && typeof record.managedSaleBinding === "object"
    ? { ...record.managedSaleBinding }
    : null,
  managedSaleReadinessCheckedAt: toStr(record.managedSaleReadinessCheckedAt),
  managedSaleProviderScope: record.managedSaleProviderScope && typeof record.managedSaleProviderScope === "object"
    ? { ...record.managedSaleProviderScope }
    : null,
  hubLk1Sale: normalizeFrozenHubSale(record.hubLk1Sale),
  managedBindingState: toStr(record.managedBindingState),
  managedProviderObservedAt: toStr(record.managedProviderObservedAt),
  managedProviderInstance: record.managedProviderInstance && typeof record.managedProviderInstance === "object"
    ? { ...record.managedProviderInstance }
    : null,
  clientSubscriptionId: toStr(record.clientSubscriptionId),
  providerTransactionStatus: toStr(record.providerTransactionStatus),
  dispatchGeneration: ctx.dispatchGeneration,
  providerAttemptedAt: ctx.providerAttemptedAt,
  paidAt: toStr(record.paidAt),
  successUrl: toStr(record.successUrl),
  failUrl: toStr(record.failUrl),
  createdAt: toStr(record.createdAt) || new Date().toISOString(),
};
ctx.hubLk1Sale = ctx.saleRecord.hubLk1Sale;
ctx.providerLifecycleMode = ctx.saleRecord.providerLifecycleMode;
ctx.managedSaleBinding = ctx.saleRecord.managedSaleBinding;
ctx.managedSaleReadinessCheckedAt = ctx.saleRecord.managedSaleReadinessCheckedAt;
ctx.managedSaleProviderScope = ctx.saleRecord.managedSaleProviderScope;
ctx.managedBindingState = ctx.saleRecord.managedBindingState;
ctx.managedProviderObservedAt = ctx.saleRecord.managedProviderObservedAt;
ctx.managedProviderInstance = ctx.saleRecord.managedProviderInstance;
ctx.clientSubscriptionId = ctx.saleRecord.clientSubscriptionId;
ctx.providerTransactionStatus = ctx.saleRecord.providerTransactionStatus;
ctx.totalLimit = ctx.saleRecord.totalLimit;
ctx.dailyLimit = ctx.saleRecord.dailyLimit;
ctx.dailyDropDate = ctx.saleRecord.dailyDropDate;
if (ctx.counterKey === "network_friendship" && ctx.requestFingerprint
  && (!(ctx.totalLimit > 0) || !(ctx.dailyLimit > 0)
    || ctx.dailyLimit > ctx.totalLimit
    || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.dailyDropDate || ""))) {
  return failMsg(503, "Лимиты сохранённой продажи требуют сверки", {
    code: "HUB_CONFIRM_SALE_LIMITS_INVALID",
  });
}
ctx.unlimited = record.unlimited === true || recordCounter?.unlimited === true;
ctx.reservationMinutes = resolveReservationMinutes();
ctx.httpRequestTimeoutMs = resolveHttpTimeoutMs();

// Only a saved ledger watch can authorize settlement. Missing fingerprints
// select a read-only lookup; they never authorize a count or a sale upsert.
if (subscriptionCounterEpoch.startedAt(global) && subscriptionCounterEpoch.previous[ctx.counterKey] === ctx.inventoryId && !ctx.requestFingerprint) {
  ctx.legacyEpochCandidate = true; ctx.legacyEpochRowId = record._id;
} else if (annualHistory.products[ctx.counterKey] && !ctx.requestFingerprint) {
  ctx.annualHistoryCandidate = true; ctx.annualHistoryRowId = record._id;
}
const currentStatus = String(record.status || "").trim().toUpperCase();
if (currentStatus === "DISPATCH_REPAIRING") {
  const repairProviderAttemptedAt = toStr(record.repairProviderAttemptedAt);
  const repairableFence = (
    (ctx.counterKey === "piter_friendship" || ctx.counterKey === "network_friendship")
    && toStr(ctx.requestFingerprint)
    && ctx.dispatchGeneration > 0
    && !toStr(ctx.providerAttemptedAt)
    && toTs(repairProviderAttemptedAt) !== null
  );
  if (!repairableFence) {
    return failMsg(503, "Repair fence попытки Viva требует ручной сверки", {
      code: "PITER_DISPATCH_REPAIR_FENCE_INVALID",
    });
  }
  ctx.providerAttemptedAt = repairProviderAttemptedAt;
  ctx.dispatchRepairOnly = true;
  ctx.step = "piter_dispatch_repair_sale_find";
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [record];
  return [null, null, null, msg];
}
if (currentStatus === "PAID" && ctx.reconcile !== true
  && !(ctx.counterKey === "piter_friendship" && ctx.requestFingerprint)) {
  const response = Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      planKey: normalizePlanKey(ctx.planKey),
      planType: normalizePlanKey(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: "PAID",
      paid: true,
      updatedAt: toStr(record.updatedAt) || toStr(record.createdAt) || new Date().toISOString(),
    },
  });
  return [null, response, response];
}

if (!ctx.transactionId) {
  const recoverableAtomicProviderAttempt = (
    (ctx.counterKey === "piter_friendship" || ctx.counterKey === "network_friendship")
    && (currentStatus === "DISPATCHING" || currentStatus === "PROVIDER_UNKNOWN")
    && toStr(ctx.requestFingerprint)
    && toStr(ctx.clientId)
    && toStr(ctx.productId)
    && toStr(ctx.studioId)
    && Number.isInteger(ctx.expectedAmountMinor)
    && ctx.expectedAmountMinor > 0
    && toTs(ctx.providerAttemptedAt) !== null
  );
  if (recoverableAtomicProviderAttempt) {
    ctx.step = "token_confirm";
    msg._summerSubscriptionCtx = ctx;
    msg.method = "POST";
    msg.url = TOKEN_URL;
    msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
    msg.payload = buildVivaServiceTokenRequestBody();
    if (!msg.payload) {
      return failMsg(503, "Сервисная авторизация Viva не настроена", {
        code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
      });
    }
    return [msg, null, null];
  }
  const response = Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      planKey: normalizePlanKey(ctx.planKey),
      planType: normalizePlanKey(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId: null,
      status: currentStatus || "PAYMENT_PENDING",
      paid: false,
      updatedAt: new Date().toISOString(),
    },
  });
  return [null, response, response];
}

ctx.step = "token_confirm";
msg._summerSubscriptionCtx = ctx;

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
msg.payload = buildVivaServiceTokenRequestBody();
if (!msg.payload) {
  return failMsg(503, "Сервисная авторизация Viva не настроена", {
    code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
  });
}

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "confirm_resolve_record",
    counterKey: toStr(ctx.counterKey),
    planKey: normalizePlanKey(ctx.planKey),
    campaignKey: ctx.campaignKey,
    paymentRef: ctx.paymentRef,
    transactionId: ctx.transactionId,
    vivaTimeoutMs: ctx.httpRequestTimeoutMs,
  },
});

return [msg, null, debugMsg];

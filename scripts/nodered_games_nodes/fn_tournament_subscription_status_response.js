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
const DEFAULT_TOTAL_LIMIT = 100;
const MAX_TOTAL_LIMIT = 1000;
const SIRIUS_FRIENDSHIP_DEFAULT_LIMIT = 100;
const AB_LETO_INVENTORY_ID = "ab_leto_2026_50_v1";
const AB_LETO_DAILY_DROP_LIMIT = 5;
const AB_LETO_DAILY_DROP_START_HOUR = 10;
const AB_LETO_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
const AB_LETO_DAILY_DROP_COUNTER_KEYS = new Set(["friendship", "ra"]);
const AB_LETO_LEGACY_STAGED_RELEASE_START_DATE = "2026-08-01";
const AB_LETO_LEGACY_STAGED_INVENTORY_ID = "ab_leto_2026_100_then_7_v1";
const AB_LETO_LEGACY_STAGED_LAUNCH_LIMIT = 100;
const AB_LETO_STAGED_RELEASE_START_DATE = "2026-09-03";
const AB_LETO_STAGED_INVENTORY_ID = "ab_leto_2026_150_v2";
const AB_LETO_STAGED_LAUNCH_LIMIT = 150;
const AB_LETO_STAGED_DAILY_DROP_LIMIT = 7;
const AB_LETO_STAGED_RA_DAILY_DROP_LIMIT = 10;
const AB_LETO_STAGED_RELEASE_ACTIVATION_KEY = "summer_subscription_ab_leto_20260903_release_enabled";
// Enabled only by the reviewed sales configuration operation, after provider price readback.
const SALES_QUOTAS_20260909_ENABLED = global.get("summer_subscription_sales_20260909_enabled") === true;
// Change only new HAB purchase prices; quota and admission flags remain independent.
const HUB_PRICE_98000_ENABLED = !!subscriptionCounterEpoch.startedAt(global) || SALES_QUOTAS_20260909_ENABLED
  || global.get("summer_subscription_network_friendship_price_98000_enabled") === true;
const SALES_QUOTAS_20260909_START = "2026-09-09T07:00:00.000Z";
// The daily annual seat count is configuration, not code: read it from the same
// style of global the other subscription limits use, and keep the current
// epoch default when it is absent. All four counter nodes must agree, so they
// share this exact expression.
const NETWORK_FRIENDSHIP_DAILY_LIMIT_DEFAULT = (SALES_QUOTAS_20260909_ENABLED || subscriptionCounterEpoch.startedAt(global)) ? 1 : 10;
const NETWORK_FRIENDSHIP_DAILY_LIMIT = (() => {
  const configured = Number(String(global.get("summer_subscription_network_friendship_daily_limit") ?? "").trim());
  if (!Number.isFinite(configured) || configured < 1) return NETWORK_FRIENDSHIP_DAILY_LIMIT_DEFAULT;
  return Math.max(1, Math.floor(configured));
})();
const DEFAULT_RESERVATION_MINUTES = 30;
const MANAGED_SALE_COMPATIBILITY = {
  adapterId: "LK_REGIONAL_BOOKING_GATEWAY",
  contractVersion: 1,
  capabilityDigest: "sha256:f1e00751ba2ef19b1945964f2ee90d2d88dbf11121fdb75dfe573b6b12f31791",
};
const NETWORK_FRIENDSHIP_PROVIDER_SCOPE = {
  kind: "STATION_SET",
  scopeId: "station-set:469c42f52aeda36c921660ab7eff8a89421953fbf1136af9cb6951612d26c877",
};
// Piter sales temporarily use the proven legacy lifecycle. This does not enable
// managed usage policy; only the annual checkout readiness flag is reopened.
const MANAGED_SALE_BLOCKED_COUNTER_KEYS = new Set([
  "kotelniki_friendship",
  "network_friendship",
  "piter_friendship",
]);
if (hubLk1Sale) MANAGED_SALE_BLOCKED_COUNTER_KEYS.delete("network_friendship");
if (piterNextDaySale) MANAGED_SALE_BLOCKED_COUNTER_KEYS.delete("piter_friendship");
const DEFAULT_PLAN_KEY = "sport";
const DEFAULT_VISIBLE_COUNTER_KEYS = ["friendship", "sport", "academy", "ra", "energy5"];
const AB_LETO_TOTAL_LIMIT_DEFAULTS = {
  academy: 125,
  friendship: AB_LETO_DAILY_DROP_LIMIT,
  ra: AB_LETO_DAILY_DROP_LIMIT,
  sport: 132,
};
const PLAN_DEFAULTS = {
  friendship: {
    counterKey: "friendship",
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productName: "Лето.Падел.Дружба",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productCostMinor: 980000,
  },
  sport: {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productName: "Лето.Падел.Спорт",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productCostMinor: 1980000,
  },
};
const DIRECT_COUNTER_DEFAULTS = {
  energy5: {
    counterKey: "energy5",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Энергия-5",
    productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
    productCostMinor: 1980000,
  },
  academy: {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Лето.Падел.Академия",
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productCostMinor: 2380000,
  },
  ra: {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Лето.Падел.РА",
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productCostMinor: 2380000,
  },
};
const MANUAL_PAID_COUNT_DEFAULTS = {
  academy: 4,
  ra: 37,
  sport: 38,
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
    batchSize: 50,
    tierPricesMinor: [1980000, 2380000, 3680000, 5680000],
    productName: "Падел.Дружба.Котельники",
    bindingLabel: "Котельники",
    launchEnabled: false,
    providerProductId: null,
    providerProductCostMinor: null,
  },
  network_friendship: {
    inventoryId: "network_friendship_12m_2026_v1",
    batchSize: 100,
    tierPricesMinor: [HUB_PRICE_98000_ENABLED ? 9800000 : 5680000],
    productName: "Падел.Дружба.ХАБ",
    bindingLabel: "ХАБ",
    launchEnabled: true,
    providerProductId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
    providerProductName: "Падел.Дружба.ХАБ — годовая",
    providerProductCostMinor: HUB_PRICE_98000_ENABLED ? 9800000 : 5680000,
    dailyCapEnabled: true,
    dailyLimit: NETWORK_FRIENDSHIP_DAILY_LIMIT,
  },
  piter_friendship: {
    inventoryId: "piter_friendship_12m_2026_v1",
    batchSize: 100,
    tierPricesMinor: [1980000, 2380000, 3680000, 5680000],
    productName: "Падел.Дружба.Питер",
    bindingLabel: "Питер",
    launchEnabled: true,
    providerProductId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    providerProductName: "Падел.Дружба.Питер — годовая",
    providerProductCostMinor: 5680000,
  },
};

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const resolvePendingDeadlineTs = (doc, reservationMinutes) => {
  const explicitDeadlineTs = [toTs(doc?.expiresAt), toTs(doc?.paymentExpiresAt)]
    .filter((timestamp) => timestamp != null);
  if (explicitDeadlineTs.length > 0) return Math.max(...explicitDeadlineTs);
  const createdAtTs = toTs(doc?.createdAt);
  return createdAtTs == null ? null : createdAtTs + reservationMinutes * 60 * 1000;
};

const toInt = (value, fallback) => {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const toMoneyMinor = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.round(parsed));
};

const toPlanLimit = (value, fallback = DEFAULT_TOTAL_LIMIT) => {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  const limit = Math.floor(parsed);
  if (limit <= 0) return fallback;
  return Math.min(limit, MAX_TOTAL_LIMIT);
};

const getDefaultTotalLimit = (counterKey) => (
  AB_LETO_TOTAL_LIMIT_DEFAULTS[counterKey] || DEFAULT_TOTAL_LIMIT
);

const toBool = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
};

const normalizeStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "PAYMENT_PENDING";
  const hasStatusToken = (token) => status
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .some((part) => part === token || part.startsWith(token));
  if (hasStatusToken("PAID") || hasStatusToken("SUCCESS") || hasStatusToken("COMPLETE")) return "PAID";
  if (status.includes("FAIL") || status.includes("CANCEL") || status.includes("REJECT")) return "FAILED";
  if (status.includes("EXPIRE")) return "EXPIRED";
  return "PAYMENT_PENDING";
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

const readManualPaidCount = (counterKey) => {
  const normalized = normalizeCounterKey(counterKey);
  if (!normalized) return 0;
  return toInt(
    global.get(`summer_subscription_${normalized}_manual_paid_count`),
    MANUAL_PAID_COUNT_DEFAULTS[normalized] || 0,
  );
};

const readGlobalFirst = (keys) => {
  for (const key of keys) {
    const value = toStr(global.get(key));
    if (value) return value;
  }
  return null;
};

const managedSaleReadinessConfig = () => {
  const apiBase = readGlobalFirst(["subscriptions_runtime_api_base_url"]);
  const integrationToken = readGlobalFirst(["subscriptions_sale_readiness_integration_token"]);
  if (!apiBase || !integrationToken) return null;
  return { apiBase: apiBase.replace(/\/+$/, ""), integrationToken };
};

const isManagedReadinessResponse = (payload) => payload && typeof payload === "object"
  && payload.schemaVersion === 1
  && payload.ready === true
  && payload.provider === "VIVA"
  && payload.providerProductId === REGIONAL_FRIENDSHIP_CONFIGS.network_friendship.providerProductId
  && payload.providerScope?.kind === NETWORK_FRIENDSHIP_PROVIDER_SCOPE.kind
  && payload.providerScope?.scopeId === NETWORK_FRIENDSHIP_PROVIDER_SCOPE.scopeId
  && payload.requiredCompatibility?.adapterId === MANAGED_SALE_COMPATIBILITY.adapterId
  && payload.requiredCompatibility?.contractVersion === MANAGED_SALE_COMPATIBILITY.contractVersion
  && payload.requiredCompatibility?.capabilityDigest === MANAGED_SALE_COMPATIBILITY.capabilityDigest
  && payload.instanceProjector?.status === "CURRENT"
  && payload.binding && typeof payload.binding === "object"
  && toStr(payload.binding.mappingId)
  && Number.isInteger(payload.binding.mappingRevision)
  && toStr(payload.binding.subscriptionTypeId)
  && toStr(payload.binding.publicationId)
  && Number.isInteger(payload.binding.policyVersion)
  && /^sha256:[a-f0-9]{64}$/.test(toStr(payload.binding.policyDigest) || "")
  && toStr(payload.binding.fenceId)
  && Number.isInteger(payload.binding.fenceRevision)
  && /^sha256:[a-f0-9]{64}$/.test(toStr(payload.binding.fenceDigest) || "")
  && toStr(payload.binding.releaseProgramId)
  && Number.isInteger(payload.binding.releaseProgramRevision)
  && toStr(payload.binding.releasePhaseId)
  && /^sha256:[a-f0-9]{64}$/.test(toStr(payload.binding.projectorReconciliationDigest) || "");

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

const resolveNextDailyDropAt = (completedAtTs) => {
  if (!Number.isFinite(completedAtTs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(completedAtTs));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dropTs = Date.parse(`${fields.year}-${fields.month}-${fields.day}T10:00:00+03:00`);
  return new Date(completedAtTs < dropTs ? dropTs : dropTs + 24 * 60 * 60 * 1000).toISOString();
};

const resolveMoscowDate = (now = new Date(Date.now())) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

const resolveAbLetoStagedRelease = (now = new Date(Date.now())) => {
  const moscowDate = resolveMoscowDate(now);
  if (
    global.get(AB_LETO_STAGED_RELEASE_ACTIVATION_KEY) === true
    && moscowDate >= AB_LETO_STAGED_RELEASE_START_DATE
  ) {
    return {
      inventoryId: AB_LETO_STAGED_INVENTORY_ID,
      launchLimit: AB_LETO_STAGED_LAUNCH_LIMIT,
      releaseStartDate: AB_LETO_STAGED_RELEASE_START_DATE,
    };
  }
  if (moscowDate >= AB_LETO_LEGACY_STAGED_RELEASE_START_DATE) {
    return {
      inventoryId: AB_LETO_LEGACY_STAGED_INVENTORY_ID,
      launchLimit: AB_LETO_LEGACY_STAGED_LAUNCH_LIMIT,
      releaseStartDate: AB_LETO_LEGACY_STAGED_RELEASE_START_DATE,
    };
  }
  return null;
};

const isAbLeto20260903ReleaseActive = () => (
  resolveAbLetoStagedRelease()?.inventoryId === AB_LETO_STAGED_INVENTORY_ID
);

const readAbLetoInventoryId = (counterKey = null) => {
  const epochId = subscriptionCounterEpoch.activeInventory(counterKey, null, global);
  if (epochId) return epochId;
  const baseInventoryId = readGlobalFirst(["summer_subscription_inventory_id"])
    || AB_LETO_INVENTORY_ID;
  const normalizedCounterKey = String(counterKey || "").trim().toLowerCase();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(normalizedCounterKey)) {
    return baseInventoryId;
  }
  const stagedRelease = resolveAbLetoStagedRelease();
  // A new allocation, not a reset of paid/pending records in the previous inventory.
  // Frozen confirmations keep their original inventory even after a late payment.
  if (normalizedCounterKey === "ra" && SALES_QUOTAS_20260909_ENABLED
    && stagedRelease?.inventoryId === AB_LETO_STAGED_INVENTORY_ID
    && Date.now() >= Date.parse(SALES_QUOTAS_20260909_START)) {
    return "ab_leto_20260909_daily_v3_ra";
  }
  if (stagedRelease) {
    return `${stagedRelease.inventoryId}_${normalizedCounterKey}`;
  }
  return `${baseInventoryId}_${normalizedCounterKey}_${resolveDailyDropDate()}`;
};

const withAbLetoStagedRelease = (counter) => {
  const counterKey = String(counter?.counterKey || "").trim().toLowerCase();
  const stagedRelease = resolveAbLetoStagedRelease();
  if (subscriptionCounterEpoch.isNew(counterKey, counter?.inventoryId)) {
    return Object.assign({}, counter, { stagedRelease: true,
      forcedDailyDropStartsAt: subscriptionCounterEpoch.startedAt(global),
      releaseStartDate: resolveMoscowDate(new Date(subscriptionCounterEpoch.startedAt(global))),
      launchLimit: AB_LETO_STAGED_LAUNCH_LIMIT, dailyLimit: counterKey === "ra" ? 10 : 7,
      dailyDropDate: resolveDailyDropDate(), totalLimit: AB_LETO_STAGED_LAUNCH_LIMIT });
  }
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(counterKey) || !stagedRelease) {
    return counter;
  }
  const resumedDaily = (SALES_QUOTAS_20260909_ENABLED || !!subscriptionCounterEpoch.startedAt(global))
    && stagedRelease.inventoryId === AB_LETO_STAGED_INVENTORY_ID;
  return Object.assign({}, counter, {
    stagedRelease: true,
    forcedDailyDropStartsAt: resumedDaily ? SALES_QUOTAS_20260909_START : null,
    releaseStartDate: stagedRelease.releaseStartDate,
    launchLimit: stagedRelease.launchLimit,
    dailyLimit: counterKey === "ra"
      ? AB_LETO_STAGED_RA_DAILY_DROP_LIMIT
      : AB_LETO_STAGED_DAILY_DROP_LIMIT,
    dailyDropDate: resolveDailyDropDate(),
    totalLimit: stagedRelease.launchLimit,
  });
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
      productName:
        readGlobalFirst(["summer_subscription_sport_product_name", "summer_subscription_product_name"])
        || base.productName,
      productId:
        readGlobalFirst(["summer_subscription_sport_product_id", "summer_subscription_product_id"])
        || base.productId,
      productCostMinor: toMoneyMinor(
        global.get("summer_subscription_sport_product_cost_minor")
          ?? global.get("summer_subscription_product_cost_minor"),
        base.productCostMinor,
      ),
      manualPaidCount: 0,
      totalLimit: toPlanLimit(
        global.get("summer_subscription_sport_limit"),
        getDefaultTotalLimit("sport"),
      ),
    };
  }

  return withAbLetoStagedRelease({
    counterKey: "friendship",
    inventoryId: readAbLetoInventoryId(planKey),
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey:
      readGlobalFirst(["summer_subscription_friendship_campaign_key"])
      || base.campaignKey,
    productName:
      readGlobalFirst(["summer_subscription_friendship_product_name"])
      || base.productName,
    productId:
      readGlobalFirst(["summer_subscription_friendship_product_id"])
      || base.productId,
    productCostMinor: toMoneyMinor(
      global.get("summer_subscription_friendship_product_cost_minor"),
      base.productCostMinor,
    ),
    manualPaidCount: 0,
    totalLimit: toPlanLimit(global.get("summer_subscription_friendship_limit"), getDefaultTotalLimit("friendship")),
  });
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
  productName:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_name",
      "summer_subscription_friendship_sirius_product_name",
    ])
    || friendshipPlan.productName,
  productId:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_id",
      "summer_subscription_friendship_sirius_product_id",
    ])
    || friendshipPlan.productId,
  productCostMinor: toMoneyMinor(
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_cost_minor",
      "summer_subscription_friendship_sirius_product_cost_minor",
    ]),
    friendshipPlan.productCostMinor,
  ),
  manualPaidCount: readManualPaidCount("sirius_friendship"),
  totalLimit: toPlanLimit(
    readGlobalFirst([
      "summer_subscription_sirius_friendship_limit",
      "summer_subscription_friendship_sirius_limit",
    ]),
    SIRIUS_FRIENDSHIP_DEFAULT_LIMIT,
  ),
});

const readRegionalFriendshipConfig = (counterKey) => {
  const regional = REGIONAL_FRIENDSHIP_CONFIGS[counterKey];
  if (!regional) return null;
  const providerProductId = regional.launchEnabled
    ? readGlobalFirst([`summer_subscription_${counterKey}_product_id`]) || regional.providerProductId
    : null;
  const providerProductName = readGlobalFirst([`summer_subscription_${counterKey}_product_name`])
    || regional.providerProductName
    || regional.productName;
  const providerProductCostMinor = toMoneyMinor(
    global.get(`summer_subscription_${counterKey}_product_cost_minor`),
    regional.providerProductCostMinor,
  );
  const tiers = regional.tierPricesMinor.map((priceMinor, index) => {
    const tierNumber = index + 1;
    return {
      batchIndex: tierNumber,
      batchSize: regional.batchSize,
      priceMinor,
      productId: regional.launchEnabled
        ? readGlobalFirst([`summer_subscription_${counterKey}_tier_${tierNumber}_product_id`]) || providerProductId
        : null,
      productName: readGlobalFirst([`summer_subscription_${counterKey}_tier_${tierNumber}_product_name`])
        || providerProductName,
      providerProductCostMinor,
    };
  });
  const dailyCapEnabled = regional.dailyCapEnabled === true && (isAbLeto20260903ReleaseActive() || !!subscriptionCounterEpoch.startedAt(global));
  return {
    counterKey,
    inventoryId: subscriptionCounterEpoch.activeInventory(counterKey, readGlobalFirst([`summer_subscription_${counterKey}_inventory_id`]) || regional.inventoryId, global),
    saleType: "tiered_direct_product",
    planKey: null,
    campaignKey: null,
    productId: null,
    productName: tiers[0].productName,
    productCostMinor: providerProductCostMinor,
    manualPaidCount: 0,
    totalLimit: regional.batchSize * tiers.length,
    batchSize: regional.batchSize,
    dailyCapEnabled,
    dailyLimit: dailyCapEnabled ? regional.dailyLimit : 0,
    dailyDropDate: dailyCapEnabled ? resolveMoscowDate() : null,
    tiers,
  };
};

const readDirectCounterConfig = (counterKey) => {
  const base = DIRECT_COUNTER_DEFAULTS[counterKey];
  if (!base) return null;
  const unlimited = counterKey === "academy" || counterKey === "energy5";
  return withAbLetoStagedRelease({
    counterKey,
    inventoryId: readAbLetoInventoryId(counterKey),
    unlimited,
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName:
      readGlobalFirst([`summer_subscription_${counterKey}_product_name`])
      || base.productName,
    productId:
      readGlobalFirst([`summer_subscription_${counterKey}_product_id`])
      || base.productId,
    productCostMinor: toMoneyMinor(
      global.get(`summer_subscription_${counterKey}_product_cost_minor`),
      base.productCostMinor,
    ),
    manualPaidCount: 0,
    totalLimit: unlimited
      ? 0
      : toPlanLimit(global.get(`summer_subscription_${counterKey}_limit`), getDefaultTotalLimit(counterKey)),
  });
};

const buildCounterConfigMap = () => {
  const friendship = readSummerPlanConfig("friendship");
  const sport = readSummerPlanConfig("sport");
  const siriusFriendship = readSiriusFriendshipConfig(friendship);
  const academy = readDirectCounterConfig("academy");
  const energy5 = readDirectCounterConfig("energy5");
  const ra = readDirectCounterConfig("ra");
  const kotelnikiFriendship = readRegionalFriendshipConfig("kotelniki_friendship");
  const networkFriendship = readRegionalFriendshipConfig("network_friendship");
  const piterFriendship = readRegionalFriendshipConfig("piter_friendship");

  return {
    academy,
    energy5,
    friendship,
    kotelniki_friendship: kotelnikiFriendship,
    network_friendship: networkFriendship,
    piter_friendship: piterFriendship,
    ra,
    sirius_friendship: siriusFriendship,
    sport,
  };
};

const createCounterState = (counter) => {
  const counterKey = toStr(counter?.counterKey);
  const managedSaleReady = !MANAGED_SALE_BLOCKED_COUNTER_KEYS.has(counterKey);
  const totalLimit = Math.max(0, Math.floor(Number(counter?.totalLimit) || 0));
  const productCostMinor = Number(counter?.productCostMinor);
  const priceMinor = Number.isFinite(productCostMinor) ? Math.max(0, Math.round(productCostMinor)) : null;
  const configuredManualPaidCount = Number(counter?.manualPaidCount);
  const manualPaidCount = Number.isFinite(configuredManualPaidCount)
    ? Math.max(0, Math.floor(configuredManualPaidCount))
    : readManualPaidCount(counter?.counterKey);
  return {
    counterKey,
    inventoryId: toStr(counter?.inventoryId),
    unlimited: counter?.unlimited === true,
    saleType: toStr(counter?.saleType),
    planKey: normalizePlanKey(counter?.planKey),
    campaignKey: toStr(counter?.campaignKey),
    productId: toStr(counter?.productId),
    productName: toStr(counter?.productName),
    stagedRelease: counter?.stagedRelease === true,
    dailyCapEnabled: counter?.dailyCapEnabled === true,
    releaseStartDate: toStr(counter?.releaseStartDate),
    releasePhase: null,
    dailyDropActive: false,
    launchLimit: Math.max(0, Math.floor(Number(counter?.launchLimit) || 0)),
    launchPaidCount: 0,
    launchReservedCount: 0,
    launchRemainingCount: 0,
    launchCompletedAt: null,
    dailyLimit: Math.max(0, Math.floor(Number(counter?.dailyLimit) || 0)),
    dailyDropDate: toStr(counter?.dailyDropDate),
    dailyDropStartsAt: null,
    forcedDailyDropStartsAt: toStr(counter?.forcedDailyDropStartsAt),
    totalLimit,
    paidCount: manualPaidCount,
    reservedCount: 0,
    takenCount: manualPaidCount,
    remainingCount: Math.max(totalLimit - manualPaidCount, 0),
    canPurchase: managedSaleReady
      && (counter?.unlimited === true || totalLimit - manualPaidCount > 0),
    managedSaleReady,
    managedSaleError: managedSaleReady
      ? null
      : "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE",
    bindingReady: true,
    bindingError: null,
    batchSize: Math.max(0, Math.floor(Number(counter?.batchSize) || 0)),
    batchIndex: 0,
    batchCount: Array.isArray(counter?.tiers) ? counter.tiers.length : 0,
    batchRemainingCount: 0,
    _tiers: Array.isArray(counter?.tiers) ? counter.tiers : [],
    providerProductCostMinor: null,
    discountMinor: null,
    priceMinor,
    price: priceMinor == null ? null : priceMinor / 100,
    updatedAt: null,
    _lastUpdatedAtTs: null,
    _dailyPaidCount: 0,
    _dailyReservedCount: 0,
    _launchPaidTimestamps: [],
    _stagedRows: [],
    inventoryTotalLimit: totalLimit,
    inventoryPaidCount: manualPaidCount,
    inventoryReservedCount: 0,
    inventoryRemainingCount: Math.max(totalLimit - manualPaidCount, 0),
  };
};

const matchesConfiguredProduct = (doc, configuredProductId) => {
  const expectedProductId = toStr(configuredProductId);
  if (!expectedProductId || !doc || typeof doc !== "object") return true;

  const docProductId = toStr(doc.productId);
  if (!docProductId) return true;
  return docProductId === expectedProductId;
};

const matchesCounterRecord = (doc, counter) => {
  if (!doc || typeof doc !== "object" || !counter || typeof counter !== "object") return false;

  const inventoryId = toStr(counter.inventoryId);
  if (inventoryId) {
    return toStr(doc.inventoryId) === inventoryId
      && normalizeCounterKey(doc.counterKey) === normalizeCounterKey(counter.counterKey);
  }
  if (!matchesConfiguredProduct(doc, counter.productId)) return false;

  const rowCounterKey = normalizeCounterKey(doc.counterKey);
  const rowCampaignKey = toStr(doc.campaignKey);
  const rowProductId = toStr(doc.productId);

  if (counter.saleType === "summer_campaign") {
    if (rowCampaignKey && rowCampaignKey === toStr(counter.campaignKey)) {
      return true;
    }
    return rowCounterKey === normalizeCounterKey(counter.counterKey);
  }

  if (rowCounterKey && rowCounterKey === normalizeCounterKey(counter.counterKey)) {
    return true;
  }
  return Boolean(rowProductId && rowProductId === toStr(counter.productId));
};

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : {};
let managedReadinessPayload = null;
let managedReadinessAttempted = ctx._managedSaleReadinessAttempted === true;
let rows = Array.isArray(msg.payload) ? msg.payload : [];
if (managedReadinessAttempted && Array.isArray(ctx._managedSaleStatusRows)) {
  managedReadinessPayload = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
  rows = ctx._managedSaleStatusRows;
  delete ctx._managedSaleStatusRows;
}
const configMap = buildCounterConfigMap();
const configuredCounters = Array.isArray(ctx.counters) && ctx.counters.length > 0
  ? ctx.counters
  : Array.isArray(ctx.plans) && ctx.plans.length > 0
    ? ctx.plans
  : DEFAULT_VISIBLE_COUNTER_KEYS
    .map((counterKey) => configMap[counterKey])
    .filter((counter) => Boolean(counter));

const needsNetworkReadiness = !hubLk1Sale && configuredCounters.some(
  (counter) => normalizeCounterKey(counter?.counterKey) === "network_friendship"
    && !MANAGED_SALE_BLOCKED_COUNTER_KEYS.has("network_friendship")
);
if (needsNetworkReadiness && !managedReadinessAttempted) {
  const config = managedSaleReadinessConfig();
  if (config) {
    ctx._managedSaleReadinessAttempted = true;
    ctx._managedSaleStatusRows = rows;
    msg._summerSubscriptionCtx = ctx;
    msg.method = "POST";
    msg.url = `${config.apiBase}/internal/subscriptions/sale-readiness`;
    msg.headers = {
      "Content-Type": "application/json",
      "X-Subscriptions-Integration-Token": config.integrationToken,
      "X-Correlation-Id": `lk-sale-status:${Date.now()}`,
    };
    msg.requestTimeout = Math.max(
      3000,
      Math.min(20000, toInt(global.get("subscriptions_sale_readiness_timeout_ms"), 5000)),
    );
    msg.payload = {
      provider: "VIVA",
      providerProductId: REGIONAL_FRIENDSHIP_CONFIGS.network_friendship.providerProductId,
      providerScopeKind: NETWORK_FRIENDSHIP_PROVIDER_SCOPE.kind,
      providerScopeId: NETWORK_FRIENDSHIP_PROVIDER_SCOPE.scopeId,
      requiredAdapterId: MANAGED_SALE_COMPATIBILITY.adapterId,
      requiredContractVersion: MANAGED_SALE_COMPATIBILITY.contractVersion,
      requiredCapabilityDigest: MANAGED_SALE_COMPATIBILITY.capabilityDigest,
    };
    const debugMsg = Object.assign({}, msg, {
      payload: { action: "managed_sale_status_readiness_request", counterKey: "network_friendship" },
    });
    delete debugMsg.headers;
    delete debugMsg.url;
    delete debugMsg.req;
    delete debugMsg.res;
    return [null, debugMsg, msg];
  }
}

const statesByCounterKey = {};
const countersOrder = [];
configuredCounters.forEach((counter) => {
  const counterKey = normalizeCounterKey(counter?.counterKey);
  if (!counterKey || statesByCounterKey[counterKey]) return;
  statesByCounterKey[counterKey] = createCounterState(counter);
  countersOrder.push(counterKey);
});

if (statesByCounterKey.network_friendship) {
  const ready = Boolean(hubLk1Sale) || !MANAGED_SALE_BLOCKED_COUNTER_KEYS.has("network_friendship")
    && typeof msg.statusCode === "number"
    && Number.isInteger(msg.statusCode) && msg.statusCode >= 200 && msg.statusCode < 300
    && !msg.error
    && isManagedReadinessResponse(managedReadinessPayload) === true;
  statesByCounterKey.network_friendship.managedSaleReady = ready;
  statesByCounterKey.network_friendship.managedSaleError = ready
    ? null
    : "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE";
}

if (countersOrder.length === 0) {
  DEFAULT_VISIBLE_COUNTER_KEYS.forEach((counterKey) => {
    const fallbackCounter = configMap[counterKey];
    if (!fallbackCounter || statesByCounterKey[counterKey]) return;
    statesByCounterKey[counterKey] = createCounterState(fallbackCounter);
    countersOrder.push(counterKey);
  });
}

const singleCounter = ctx.singleCounter === true;
const selectedCounterFromPlan = (() => {
  const planKey = normalizePlanKey(ctx.selectedPlanKey);
  if (planKey === "sport") return "sport";
  if (planKey === "friendship") {
    return toStr(ctx.selectedCampaignKey) === toStr(configMap.sirius_friendship?.campaignKey)
      ? "sirius_friendship"
      : "friendship";
  }
  return null;
})();
const selectedCounterKey = normalizeCounterKey(ctx.selectedCounterKey)
  || selectedCounterFromPlan
  || countersOrder[0]
  || "sport";
const now = Date.now();
const reservationMinutes = Math.max(
  5,
  Math.min(360, toInt(ctx.reservationMinutes, DEFAULT_RESERVATION_MINUTES)),
);
const docs = rows.filter((item) => item && typeof item === "object");
const piterLedger = docs.find((item) => (
  item?._id === `inventory:${subscriptionCounterEpoch.activeInventory("piter_friendship", "piter_friendship_12m_2026_v1", global)}`
  && item?.counterKey === "piter_friendship"
  && item?.inventoryId === subscriptionCounterEpoch.activeInventory("piter_friendship", "piter_friendship_12m_2026_v1", global)
));
const piterState = statesByCounterKey.piter_friendship;
const piterLegacyRefs = Array.isArray(piterLedger?.legacyPaymentRefs)
  ? piterLedger.legacyPaymentRefs.map(toStr)
  : [];
const piterReservations = Array.isArray(piterLedger?.reservations) ? piterLedger.reservations : [];
const piterReservationRefs = piterReservations.map((item) => toStr(item?.paymentRef));
const piterTransactionIds = piterReservations.map((item) => toStr(item?.transactionId)).filter(Boolean);
const piterActiveIntentFingerprints = piterReservations
  .filter((item) => ["CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN"].includes(item?.state))
  .map((item) => toStr(item?.intentFingerprint));
const piterLedgerRowsValid = Array.isArray(piterLedger?.legacyPaymentRefs)
  && Array.isArray(piterLedger?.reservations)
  && piterLegacyRefs.every(Boolean)
  && piterReservationRefs.every(Boolean)
  && piterReservations.every((item) => [
    "CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN", "PAID", "FAILED",
  ].includes(item?.state))
  && new Set(piterLegacyRefs).size === piterLegacyRefs.length
  && new Set(piterReservationRefs).size === piterReservationRefs.length
  && new Set(piterTransactionIds).size === piterTransactionIds.length
  && piterActiveIntentFingerprints.every(Boolean)
  && new Set(piterActiveIntentFingerprints).size === piterActiveIntentFingerprints.length
  && !piterReservationRefs.some((item) => piterLegacyRefs.includes(item))
  && piterLedger?.paidCount === piterLegacyRefs.length
    + piterReservations.filter((item) => item?.state === "PAID").length
  && piterLedger?.reservedCount === piterReservations.filter((item) => (
    ["CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN"].includes(item?.state)
  )).length;
const piterQuotaAdjustment = [2, 3].includes(piterLedger?.schemaVersion) ? piterLedger.quotaAdjustment : 0;
const piterQuotaValid = Number.isSafeInteger(piterQuotaAdjustment) && piterQuotaAdjustment >= 0
  && (piterLedger?.schemaVersion === 2
    ? [50, 52].includes(piterLegacyRefs.length + piterQuotaAdjustment)
    : !Object.prototype.hasOwnProperty.call(piterLedger || {}, "quotaAdjustment"));
if (piterState && piterLedger?.ready === true
  && ((piterLedger.schemaVersion === 3 && annualHistory.validate(piterLedger)
    && (!subscriptionCounterEpoch.isNew(piterState.counterKey, piterState.inventoryId)
      || piterLedger.epoch?.startedAt === subscriptionCounterEpoch.startedAt(global))) || ([1, 2].includes(piterLedger.schemaVersion)
  && piterQuotaValid
  && Number.isInteger(piterLedger.revision)
  && piterLedger.revision >= 0
  && Number.isInteger(piterLedger.paidCount)
  && piterLedger.paidCount >= 0
  && Number.isInteger(piterLedger.reservedCount)
  && piterLedger.reservedCount >= 0
  && Number.isInteger(piterLedger.takenCount)
  && piterLedger.takenCount >= 0
  && piterLedger.takenCount === piterLedger.paidCount + piterLedger.reservedCount
  && piterLedger.takenCount + piterQuotaAdjustment <= piterState.totalLimit
  && /^[a-f0-9]{64}$/.test(toStr(piterLedger.baselineDigest) || "")
  && Number.isFinite(Date.parse(toStr(piterLedger.baselineCapturedAt) || ""))
  && piterLedgerRowsValid))) {
  piterState.paidCount = piterLedger.paidCount;
  piterState.quotaAdjustment = piterQuotaAdjustment;
  piterState.reservedCount = piterLedger.reservedCount;
  piterState.takenCount = piterLedger.takenCount;
  piterState.remainingCount = Math.max(piterState.totalLimit - piterLedger.takenCount, 0);
  const requiresNextDayRelease = piterLedger.schemaVersion === 3 || (piterLedger.schemaVersion === 2 && piterLegacyRefs.length + piterQuotaAdjustment === 52);
  piterState.managedSaleReady = (!requiresNextDayRelease || piterNextDaySale)
    && (piterLedger.schemaVersion !== 3 || annualHistory.admissionReady(piterLedger));
  piterState.managedSaleError = piterState.managedSaleReady ? null : "PITER_NEXT_DAY_SALES_RELEASE_DISABLED";
  piterState._lastUpdatedAtTs = toTs(piterLedger.updatedAt) ?? toTs(piterLedger.baselineCapturedAt);
} else if (piterState) {
  piterState.managedSaleReady = false;
  piterState.managedSaleError = "PITER_ATOMIC_LEDGER_NOT_READY";
}

const hubLedger = docs.find((item) => (
  item?._id === `inventory:${subscriptionCounterEpoch.activeInventory("network_friendship", "network_friendship_12m_2026_v1", global)}`
  && item?.counterKey === "network_friendship"
  && item?.inventoryId === subscriptionCounterEpoch.activeInventory("network_friendship", "network_friendship_12m_2026_v1", global)
));
const hubState = statesByCounterKey.network_friendship;
const hubLegacyRefs = Array.isArray(hubLedger?.legacyPaymentRefs)
  ? hubLedger.legacyPaymentRefs.map(toStr)
  : [];
const hubReservations = Array.isArray(hubLedger?.reservations) ? hubLedger.reservations : [];
const hubReservationRefs = hubReservations.map((item) => toStr(item?.paymentRef));
const hubTransactionIds = hubReservations.map((item) => toStr(item?.transactionId)).filter(Boolean);
const hubActiveReservations = hubReservations.filter((item) => (
  ["CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN"].includes(item?.state)
));
const hubActiveIntentFingerprints = hubActiveReservations.map((item) => toStr(item?.intentFingerprint));
const hubDailyPaidReservations = hubReservations.filter((item) => (
  item?.state === "PAID" && item?.dailyDate === hubLedger?.dailyDate
)).length;
const hubDailyActiveReservations = hubActiveReservations.filter((item) => (
  item?.dailyDate === hubLedger?.dailyDate
)).length;
const hubLedgerRowsValid = Array.isArray(hubLedger?.legacyPaymentRefs)
  && Array.isArray(hubLedger?.reservations)
  && hubLegacyRefs.every(Boolean)
  && hubReservationRefs.every(Boolean)
  && hubReservations.every((item) => [
    "CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN", "PAID", "FAILED",
  ].includes(item?.state))
  && new Set(hubLegacyRefs).size === hubLegacyRefs.length
  && new Set(hubReservationRefs).size === hubReservationRefs.length
  && new Set(hubTransactionIds).size === hubTransactionIds.length
  && hubActiveIntentFingerprints.every(Boolean)
  && new Set(hubActiveIntentFingerprints).size === hubActiveIntentFingerprints.length
  && !hubReservationRefs.some((item) => hubLegacyRefs.includes(item))
  && hubLedger?.paidCount === hubLegacyRefs.length
    + hubReservations.filter((item) => item?.state === "PAID").length
  && hubLedger?.reservedCount === hubActiveReservations.length
  && hubLedger?.dailyPaidCount === hubLedger?.dailyBaselinePaidCount + hubDailyPaidReservations
  && hubLedger?.dailyReservedCount === hubDailyActiveReservations;
const hubLedgerValid = Boolean(hubState && hubLedger?.ready === true
  && ((hubLedger.schemaVersion === 3 && annualHistory.validate(hubLedger)
    && (!subscriptionCounterEpoch.isNew(hubState.counterKey, hubState.inventoryId)
      || hubLedger.epoch?.startedAt === subscriptionCounterEpoch.startedAt(global))) || (hubLedger.schemaVersion === 1
  && Number.isInteger(hubLedger.revision) && hubLedger.revision >= 0
  && Number.isInteger(hubLedger.paidCount) && hubLedger.paidCount >= 0
  && Number.isInteger(hubLedger.reservedCount) && hubLedger.reservedCount >= 0
  && Number.isInteger(hubLedger.takenCount) && hubLedger.takenCount >= 0
  && hubLedger.takenCount === hubLedger.paidCount + hubLedger.reservedCount
  && hubLedger.takenCount <= hubState.inventoryTotalLimit
  && /^\d{4}-\d{2}-\d{2}$/.test(toStr(hubLedger.dailyDate) || "")
  && Number.isInteger(hubLedger.dailyBaselinePaidCount) && hubLedger.dailyBaselinePaidCount >= 0
  && Number.isInteger(hubLedger.dailyPaidCount) && hubLedger.dailyPaidCount >= 0
  && Number.isInteger(hubLedger.dailyReservedCount) && hubLedger.dailyReservedCount >= 0
  && hubLedger.dailyDate <= hubState.dailyDropDate
  && hubLedger.dailyPaidCount + hubLedger.dailyReservedCount <= (hubLedger.dailyDate < hubState.dailyDropDate
    ? hubState.inventoryTotalLimit : hubState.dailyLimit)
  && /^[a-f0-9]{64}$/.test(toStr(hubLedger.baselineDigest) || "")
  && Number.isFinite(Date.parse(toStr(hubLedger.baselineCapturedAt) || ""))
  && hubLedgerRowsValid)));
if (hubState && hubLedgerValid) {
  if (hubLedger.schemaVersion === 3 && !annualHistory.admissionReady(hubLedger)) {
    hubState.managedSaleReady = false; hubState.managedSaleError = "ANNUAL_HISTORY_RECHECK_REQUIRED";
  }
  hubState.paidCount = hubLedger.paidCount;
  hubState.reservedCount = hubLedger.reservedCount;
  hubState.takenCount = hubLedger.takenCount;
  hubState.remainingCount = Math.max(hubState.inventoryTotalLimit - hubLedger.takenCount, 0);
  // Project rollover on GET; only the atomic purchase CAS may mutate the ledger.
  hubState._dailyPaidCount = hubLedger.schemaVersion === 3 ? annualHistory.counts(hubLedger, hubState.dailyDropDate).dailyPaidCount : hubLedger.dailyDate === hubState.dailyDropDate ? hubLedger.dailyPaidCount : 0;
  hubState._dailyReservedCount = hubLedger.schemaVersion === 3 ? annualHistory.counts(hubLedger, hubState.dailyDropDate).dailyReservedCount : hubLedger.dailyDate === hubState.dailyDropDate ? hubLedger.dailyReservedCount : 0;
  hubState.inventoryPaidCount = hubLedger.paidCount;
  hubState.inventoryReservedCount = hubLedger.reservedCount;
  hubState.inventoryRemainingCount = Math.max(hubState.inventoryTotalLimit - hubLedger.takenCount, 0);
  hubState._lastUpdatedAtTs = toTs(hubLedger.updatedAt) ?? toTs(hubLedger.baselineCapturedAt);
} else if (hubState) {
  hubState.managedSaleReady = false;
  hubState.managedSaleError = "HUB_ATOMIC_LEDGER_NOT_READY";
}

for (const doc of docs) {
  const matchedCounterKey = countersOrder.find((counterKey) => {
    const state = statesByCounterKey[counterKey];
    return matchesCounterRecord(doc, state);
  });
  if (!matchedCounterKey) continue;

  const state = statesByCounterKey[matchedCounterKey];
  if ((matchedCounterKey === "piter_friendship" && piterLedger)
    || (matchedCounterKey === "network_friendship" && hubLedger)) continue;
  const normalizedStatus = normalizeStatus(doc.status);
  const status = normalizedStatus === "PAID_PENDING_INSTANCE_BINDING" ? "PAID" : normalizedStatus;
  const releasePhase = toStr(doc.releasePhase) === "daily" ? "daily" : "launch";
  const pendingDeadlineTs = resolvePendingDeadlineTs(doc, reservationMinutes);
  const eventTs = status === "PAID"
    ? (toTs(doc.paidAt) ?? toTs(doc.updatedAt) ?? toTs(doc.createdAt))
    : (toTs(doc.createdAt) ?? toTs(doc.updatedAt));
  const updatedAtTs = toTs(doc.updatedAt) ?? toTs(doc.createdAt);
  if (updatedAtTs != null) {
    if (state._lastUpdatedAtTs == null || updatedAtTs > state._lastUpdatedAtTs) {
      state._lastUpdatedAtTs = updatedAtTs;
    }
  }

  if (!state.campaignKey) state.campaignKey = toStr(doc.campaignKey);
  if (!state.planKey) state.planKey = normalizePlanKey(doc.planKey);
  if (!state.productId) state.productId = toStr(doc.productId);
  if (!state.productName) state.productName = toStr(doc.productName);

  if (state.priceMinor == null) {
    const amountMinor = Number(doc.amountMinor);
    if (Number.isFinite(amountMinor) && amountMinor >= 0) {
      state.priceMinor = Math.max(0, Math.round(amountMinor));
      state.price = state.priceMinor / 100;
    }
  }

  if (status === "PAID") {
    if (state.stagedRelease) {
      state._stagedRows.push({
        status,
        releasePhase,
        dailyDropDate: toStr(doc.dailyDropDate),
        eventTs,
      });
      if (releasePhase === "launch") {
        state.launchPaidCount += 1;
        if (eventTs != null) state._launchPaidTimestamps.push(eventTs);
      }
      continue;
    }
    state.paidCount += 1;
    if (
      state.dailyCapEnabled
      && eventTs != null
      && resolveMoscowDate(new Date(eventTs)) === state.dailyDropDate
    ) {
      state._dailyPaidCount += 1;
    }
    continue;
  }

  const isPending = status === "PAYMENT_PENDING";
  const isActivePending = isPending && pendingDeadlineTs != null && pendingDeadlineTs > now;
  if (isActivePending) {
    if (state.stagedRelease) {
      state._stagedRows.push({
        status,
        releasePhase,
        dailyDropDate: toStr(doc.dailyDropDate),
        eventTs,
      });
      continue;
    }
    state.reservedCount += 1;
    if (
      state.dailyCapEnabled
      && eventTs != null
      && resolveMoscowDate(new Date(eventTs)) === state.dailyDropDate
    ) {
      state._dailyReservedCount += 1;
    }
  }
}

// A paused epoch never falls back to an older allocation.
for (const state of Object.values(statesByCounterKey)) {
  if (!subscriptionCounterEpoch.admission(state, global)) state.canPurchase = false;
}

const plansPayload = (singleCounter ? [selectedCounterKey] : countersOrder)
  .map((counterKey) => {
    const state = statesByCounterKey[counterKey];
    if (!state) return null;
    if (state.stagedRelease) {
      state._launchPaidTimestamps.sort((left, right) => left - right);
      const launchComplete = state.launchPaidCount >= state.launchLimit;
      const launchCompletedAtTs = launchComplete && state._launchPaidTimestamps.length >= state.launchLimit
        ? state._launchPaidTimestamps[state.launchLimit - 1]
        : null;
      state.launchCompletedAt = launchCompletedAtTs == null ? null : new Date(launchCompletedAtTs).toISOString();
      const naturalDailyStart = launchComplete ? resolveNextDailyDropAt(launchCompletedAtTs) : null;
      const forcedDailyStart = toTs(state.forcedDailyDropStartsAt);
      state.dailyDropStartsAt = forcedDailyStart != null
        && (naturalDailyStart == null || forcedDailyStart < Date.parse(naturalDailyStart))
        ? new Date(forcedDailyStart).toISOString() : naturalDailyStart;
      state.dailyDropActive = Boolean(state.dailyDropStartsAt && Date.parse(state.dailyDropStartsAt) <= now);
      const dailyDropStartsAtTs = toTs(state.dailyDropStartsAt);
      state.launchPaidCount = launchComplete ? state.launchLimit : state.launchPaidCount;
      for (const row of state._stagedRows) {
        const isCurrentDailyDrop = row.releasePhase === "daily"
          ? row.dailyDropDate === state.dailyDropDate
          : dailyDropStartsAtTs != null
            && row.eventTs != null
            && row.eventTs >= dailyDropStartsAtTs
            && resolveDailyDropDate(new Date(row.eventTs)) === state.dailyDropDate;
        if (row.status === "PAID") {
          if (isCurrentDailyDrop) state._dailyPaidCount += 1;
          continue;
        }
        if (isCurrentDailyDrop || (state.dailyDropActive && forcedDailyStart != null
          && row.releasePhase === "launch")) state._dailyReservedCount += 1;
        else if (row.releasePhase === "launch") state.launchReservedCount += 1;
      }
      state.releasePhase = state.dailyDropActive ? "daily" : launchComplete ? "daily_pending" : "launch";
      state.launchRemainingCount = Math.max(
        state.launchLimit - state.launchPaidCount - state.launchReservedCount,
        0,
      );
      state.totalLimit = state.dailyDropActive ? state.dailyLimit : state.launchLimit;
      state.paidCount = state.dailyDropActive ? state._dailyPaidCount : state.launchPaidCount;
      state.reservedCount = state.dailyDropActive ? state._dailyReservedCount : state.launchReservedCount;
    }
    const quotaAdjustment = state.counterKey === "piter_friendship" ? state.quotaAdjustment || 0 : 0;
    const inventoryTakenCount = state.paidCount + state.reservedCount + quotaAdjustment;
    state.inventoryTotalLimit = state.totalLimit;
    state.inventoryPaidCount = state.paidCount;
    state.inventoryReservedCount = state.reservedCount;
    state.inventoryRemainingCount = state.unlimited
      ? 0
      : Math.max(state.inventoryTotalLimit - inventoryTakenCount, 0);
    if (state.dailyCapEnabled) {
      state.releasePhase = "daily";
      state.dailyDropActive = true;
      state.totalLimit = state.dailyLimit;
      state.paidCount = state._dailyPaidCount;
      state.reservedCount = state._dailyReservedCount;
    }
    state.takenCount = state.paidCount + state.reservedCount + quotaAdjustment;
    state.remainingCount = state.unlimited
      ? 0
      : state.dailyCapEnabled
        ? Math.min(Math.max(state.totalLimit - state.takenCount, 0), state.inventoryRemainingCount)
        : Math.max(state.totalLimit - state.takenCount, 0);
    const regional = REGIONAL_FRIENDSHIP_CONFIGS[state.counterKey];
    if (regional) {
      const tiers = Array.isArray(state._tiers) ? state._tiers : [];
      const batchSize = Math.max(1, state.batchSize || regional.batchSize);
      const batchIndex = Math.max(1, Math.min(tiers.length || 1, Math.floor(inventoryTakenCount / batchSize) + 1));
      const activeTier = tiers[batchIndex - 1] || null;
      const takenInBatch = Math.max(0, inventoryTakenCount - (batchIndex - 1) * batchSize);
      state.batchSize = state.dailyCapEnabled ? state.dailyLimit : batchSize;
      state.batchIndex = batchIndex;
      state.batchCount = tiers.length;
      state.batchRemainingCount = state.dailyCapEnabled
        ? state.remainingCount
        : state.remainingCount <= 0 ? 0 : Math.max(0, batchSize - takenInBatch);
      state.productId = toStr(activeTier?.productId);
      state.productName = toStr(activeTier?.productName);
      state.priceMinor = Number.isFinite(Number(activeTier?.priceMinor))
        ? Math.max(0, Math.round(Number(activeTier.priceMinor)))
        : null;
      state.providerProductCostMinor = Number.isFinite(Number(activeTier?.providerProductCostMinor))
        ? Math.max(0, Math.round(Number(activeTier.providerProductCostMinor)))
        : null;
      state.discountMinor = state.priceMinor != null && state.providerProductCostMinor != null
        ? state.providerProductCostMinor - state.priceMinor
        : null;
      state.price = state.priceMinor == null ? null : state.priceMinor / 100;
      state.bindingReady = Boolean(
        state.productId
        && state.priceMinor != null
        && state.providerProductCostMinor != null
        && state.discountMinor != null
        && state.discountMinor >= 0
      );
      state.bindingError = state.bindingReady
        ? null
        : `Текущая ценовая партия ${regional.bindingLabel} ещё не подключена к оплате`;
    }
    state.canPurchase = !(["ra", "friendship"].includes(state.counterKey)
      && global.get(`summer_subscription_${state.counterKey}_admission_closed`) === true)
      && (state.unlimited || state.remainingCount > 0)
      && state.bindingReady
      && state.managedSaleReady
      && subscriptionCounterEpoch.admission(state, global);
    state.updatedAt = state._lastUpdatedAtTs == null
      ? new Date().toISOString()
      : new Date(state._lastUpdatedAtTs).toISOString();
    delete state._lastUpdatedAtTs;
    delete state._dailyPaidCount;
    delete state._dailyReservedCount;
    delete state._launchPaidTimestamps;
    delete state._stagedRows;
    delete state._tiers;
    return state;
  })
  .filter((state) => Boolean(state));

const selectedCounter = (plansPayload.find((state) => state.counterKey === selectedCounterKey))
  || plansPayload[0]
  || statesByCounterKey[selectedCounterKey]
  || createCounterState(configMap[selectedCounterKey] || configMap.sport);

const summary = {
  totalLimit: 0,
  paidCount: 0,
  reservedCount: 0,
  takenCount: 0,
  remainingCount: 0,
  canPurchase: false,
  updatedAt: null,
};
let summaryUpdatedTs = null;

plansPayload.forEach((state) => {
  summary.totalLimit += state.totalLimit;
  summary.paidCount += state.paidCount;
  summary.reservedCount += state.reservedCount;
  summary.takenCount += state.takenCount;
  summary.remainingCount += state.remainingCount;
  const ts = toTs(state.updatedAt);
  if (ts != null && (summaryUpdatedTs == null || ts > summaryUpdatedTs)) {
    summaryUpdatedTs = ts;
  }
});
summary.canPurchase = plansPayload.some((state) => state.canPurchase);
summary.updatedAt = summaryUpdatedTs == null
  ? new Date().toISOString()
  : new Date(summaryUpdatedTs).toISOString();

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  counterKey: toStr(selectedCounter.counterKey),
  inventoryId: toStr(selectedCounter.inventoryId),
  saleType: toStr(selectedCounter.saleType),
  unlimited: selectedCounter.unlimited === true,
  planKey: normalizePlanKey(selectedCounter.planKey),
  planType: normalizePlanKey(selectedCounter.planKey),
  campaignKey: toStr(selectedCounter.campaignKey),
  productId: toStr(selectedCounter.productId),
  productName: toStr(selectedCounter.productName),
  totalLimit: toInt(selectedCounter.totalLimit, 0),
  paidCount: toInt(selectedCounter.paidCount, 0),
  reservedCount: toInt(selectedCounter.reservedCount, 0),
  takenCount: toInt(selectedCounter.takenCount, 0),
  quotaAdjustment: toInt(selectedCounter.quotaAdjustment, 0),
  remainingCount: toInt(selectedCounter.remainingCount, 0),
  canPurchase: toBool(selectedCounter.canPurchase) ?? false,
  bindingReady: toBool(selectedCounter.bindingReady) ?? true,
  bindingError: toStr(selectedCounter.bindingError),
  managedSaleReady: toBool(selectedCounter.managedSaleReady) ?? true,
  managedSaleError: toStr(selectedCounter.managedSaleError),
  dailyCapEnabled: selectedCounter.dailyCapEnabled === true,
  inventoryTotalLimit: toInt(selectedCounter.inventoryTotalLimit, 0),
  inventoryPaidCount: toInt(selectedCounter.inventoryPaidCount, 0),
  inventoryReservedCount: toInt(selectedCounter.inventoryReservedCount, 0),
  inventoryRemainingCount: toInt(selectedCounter.inventoryRemainingCount, 0),
  batchSize: toInt(selectedCounter.batchSize, 0),
  batchIndex: toInt(selectedCounter.batchIndex, 0),
  batchCount: toInt(selectedCounter.batchCount, 0),
  batchRemainingCount: toInt(selectedCounter.batchRemainingCount, 0),
  providerProductCostMinor: Number.isFinite(Number(selectedCounter.providerProductCostMinor))
    ? Math.max(0, Math.round(Number(selectedCounter.providerProductCostMinor)))
    : null,
  discountMinor: Number.isFinite(Number(selectedCounter.discountMinor))
    ? Math.max(0, Math.round(Number(selectedCounter.discountMinor)))
    : null,
  releasePhase: toStr(selectedCounter.releasePhase),
  dailyDropActive: selectedCounter.dailyDropActive === true,
  releaseStartDate: toStr(selectedCounter.releaseStartDate),
  launchLimit: toInt(selectedCounter.launchLimit, 0),
  launchPaidCount: toInt(selectedCounter.launchPaidCount, 0),
  launchReservedCount: toInt(selectedCounter.launchReservedCount, 0),
  launchRemainingCount: toInt(selectedCounter.launchRemainingCount, 0),
  launchCompletedAt: toStr(selectedCounter.launchCompletedAt),
  dailyLimit: toInt(selectedCounter.dailyLimit, 0),
  dailyDropDate: toStr(selectedCounter.dailyDropDate),
  dailyDropStartsAt: toStr(selectedCounter.dailyDropStartsAt),
  priceMinor: selectedCounter.priceMinor == null ? null : Math.max(0, Math.round(Number(selectedCounter.priceMinor) || 0)),
  price: selectedCounter.price == null ? null : Number(selectedCounter.price),
  updatedAt: toStr(selectedCounter.updatedAt) || new Date().toISOString(),
  plans: plansPayload,
  summary,
};

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "status_response",
    mode: singleCounter ? "single" : "aggregate",
    counterKey: msg.payload.counterKey,
    planKey: msg.payload.planKey,
    campaignKey: msg.payload.campaignKey,
    summary,
  },
});

return [msg, debugMsg, null];

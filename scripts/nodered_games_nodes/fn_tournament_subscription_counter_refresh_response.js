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
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const REGIONAL_FRIENDSHIP_CONFIGS = {
  kotelniki_friendship: { batchSize: 50, bindingLabel: "Котельники" },
  network_friendship: { batchSize: 100, bindingLabel: "ХАБ" },
  piter_friendship: { batchSize: 100, bindingLabel: "Питер" },
};
const MANAGED_FRIENDSHIP_COUNTER_KEYS = new Set(Object.keys(REGIONAL_FRIENDSHIP_CONFIGS));

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

const resolveNextDailyDropAt = (completedAtTs) => {
  if (!Number.isFinite(completedAtTs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(completedAtTs));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dropTs = Date.parse(`${fields.year}-${fields.month}-${fields.day}T10:00:00+03:00`);
  return new Date(completedAtTs < dropTs ? dropTs : dropTs + 24 * 60 * 60 * 1000).toISOString();
};

const resolveDailyDropDate = (timestamp) => {
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const localDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const dropDay = Number(parts.hour) >= 10 ? localDay : localDay - 24 * 60 * 60 * 1000;
  return new Date(dropDay).toISOString().slice(0, 10);
};

const resolveMoscowDate = (timestamp) => {
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
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

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "friendship" || normalized === "sport") return normalized;
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
    return Boolean(rowCounterKey && rowCounterKey === normalizeCounterKey(counter.counterKey));
  }

  if (rowCounterKey && rowCounterKey === normalizeCounterKey(counter.counterKey)) {
    return true;
  }
  return Boolean(rowProductId && rowProductId === toStr(counter.productId));
};

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "refresh_counters") {
  return null;
}

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const counters = Array.isArray(ctx.counters) ? ctx.counters.filter((counter) => counter && typeof counter === "object") : [];
const refreshedAt = toStr(ctx.refreshedAt) || new Date().toISOString();
const nowTs = Date.now();
const reservationMinutes = Math.max(
  5,
  Math.min(360, Number(ctx.reservationMinutes) || 30),
);

const states = counters.map((counter) => {
  const counterKey = toStr(counter.counterKey);
  const managedSaleReady = !MANAGED_FRIENDSHIP_COUNTER_KEYS.has(counterKey);
  const totalLimit = Math.max(0, Math.floor(Number(counter.totalLimit) || 0));
  const manualPaidCount = Math.max(0, Math.floor(Number(counter.manualPaidCount) || 0));
  return {
    counterKey,
    inventoryId: toStr(counter.inventoryId),
    unlimited: counter.unlimited === true,
    saleType: toStr(counter.saleType),
    planKey: normalizePlanKey(counter.planKey),
    campaignKey: toStr(counter.campaignKey),
    productId: toStr(counter.productId),
    productName: toStr(counter.productName),
    stagedRelease: counter.stagedRelease === true,
    dailyCapEnabled: counter.dailyCapEnabled === true,
    releaseStartDate: toStr(counter.releaseStartDate),
    releasePhase: null,
    dailyDropActive: false,
    launchLimit: Math.max(0, Math.floor(Number(counter.launchLimit) || 0)),
    launchPaidCount: 0,
    launchReservedCount: 0,
    launchRemainingCount: 0,
    launchCompletedAt: null,
    dailyLimit: Math.max(0, Math.floor(Number(counter.dailyLimit) || 0)),
    dailyDropDate: toStr(counter.dailyDropDate),
    dailyDropStartsAt: null,
    forcedDailyDropStartsAt: toStr(counter?.forcedDailyDropStartsAt),
    totalLimit,
    paidCount: manualPaidCount,
    reservedCount: 0,
    takenCount: manualPaidCount,
    remainingCount: Math.max(0, totalLimit - manualPaidCount),
    canPurchase: managedSaleReady
      && (counter.unlimited === true || totalLimit - manualPaidCount > 0),
    managedSaleReady,
    managedSaleError: managedSaleReady
      ? null
      : "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE",
    bindingReady: true,
    bindingError: null,
    batchSize: Math.max(0, Math.floor(Number(counter.batchSize) || 0)),
    batchIndex: 0,
    batchCount: Array.isArray(counter.tiers) ? counter.tiers.length : 0,
    batchRemainingCount: 0,
    _tiers: Array.isArray(counter.tiers) ? counter.tiers : [],
    providerProductCostMinor: null,
    discountMinor: null,
    priceMinor: Number.isFinite(Number(counter.productCostMinor)) ? Math.max(0, Math.round(Number(counter.productCostMinor))) : null,
    price: Number.isFinite(Number(counter.productCostMinor)) ? Math.round(Number(counter.productCostMinor)) / 100 : null,
    updatedAt: refreshedAt,
    sourceUpdatedAt: null,
    _lastUpdatedAtTs: null,
    _dailyPaidCount: 0,
    _dailyReservedCount: 0,
    _launchPaidTimestamps: [],
    _stagedRows: [],
    inventoryTotalLimit: totalLimit,
    inventoryPaidCount: manualPaidCount,
    inventoryReservedCount: 0,
    inventoryRemainingCount: Math.max(0, totalLimit - manualPaidCount),
  };
});

// Epoch annual counters project their canonical ledger once. Sale documents
// remain reconciliation projections and must never double count the ledger.
for (const state of states) {
  if (!subscriptionCounterEpoch.isNew(state.counterKey, state.inventoryId)
    || !["network_friendship", "piter_friendship"].includes(state.counterKey)) continue;
  const matches = rows.filter(row => row?._id === `inventory:${state.inventoryId}`);
  const ledger = matches[0];
  state._epochAnnual = true;
  const valid = matches.length === 1 && annualHistory.validate(ledger)
    && ledger.counterKey === state.counterKey && ledger.inventoryId === state.inventoryId
    && subscriptionCounterEpoch.validDescriptor(ledger.epoch)
    && ledger.epoch.startedAt === subscriptionCounterEpoch.startedAt(global);
  state.managedSaleReady = Boolean(valid && annualHistory.admissionReady(ledger)
    && (state.counterKey === "network_friendship" ? hubLk1Sale : piterNextDaySale));
  state.managedSaleError = state.managedSaleReady ? null : "COUNTER_EPOCH_LEDGER_OR_ADMISSION_UNAVAILABLE";
  if (!valid) continue;
  const counts = annualHistory.counts(ledger, state.dailyDropDate);
  state.paidCount = counts.paidCount; state.reservedCount = counts.reservedCount;
  state.quotaAdjustment = ledger.quotaAdjustment;
  state._dailyPaidCount = counts.dailyPaidCount; state._dailyReservedCount = counts.dailyReservedCount;
  state._lastUpdatedAtTs = toTs(ledger.updatedAt);
}

rows.forEach((doc) => {
  const state = states.find((candidate) => matchesCounterRecord(doc, candidate));
  if (!state || state._epochAnnual) return;

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

  if (!state.planKey) state.planKey = normalizePlanKey(doc.planKey);
  if (!state.campaignKey) state.campaignKey = toStr(doc.campaignKey);
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
      return;
    }
    state.paidCount += 1;
    if (
      state.dailyCapEnabled
      && eventTs != null
      && resolveMoscowDate(eventTs) === state.dailyDropDate
    ) {
      state._dailyPaidCount += 1;
    }
    return;
  }

  const isPending = status === "PAYMENT_PENDING";
  const isActivePending = isPending && pendingDeadlineTs != null && pendingDeadlineTs > nowTs;
  if (isActivePending) {
    if (state.stagedRelease) {
      state._stagedRows.push({
        status,
        releasePhase,
        dailyDropDate: toStr(doc.dailyDropDate),
        eventTs,
      });
      return;
    }
    state.reservedCount += 1;
    if (
      state.dailyCapEnabled
      && eventTs != null
      && resolveMoscowDate(eventTs) === state.dailyDropDate
    ) {
      state._dailyReservedCount += 1;
    }
  }
});

const updateMessages = states.map((state) => {
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
    state.dailyDropActive = Boolean(state.dailyDropStartsAt && Date.parse(state.dailyDropStartsAt) <= nowTs);
    const dailyDropStartsAtTs = toTs(state.dailyDropStartsAt);
    state.launchPaidCount = launchComplete ? state.launchLimit : state.launchPaidCount;
    for (const row of state._stagedRows) {
      const isCurrentDailyDrop = row.releasePhase === "daily"
        ? row.dailyDropDate === state.dailyDropDate
        : dailyDropStartsAtTs != null
          && row.eventTs != null
          && row.eventTs >= dailyDropStartsAtTs
          && resolveDailyDropDate(row.eventTs) === state.dailyDropDate;
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
  const quotaAdjustment = state.quotaAdjustment || 0;
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
  state.canPurchase = (state.unlimited || state.remainingCount > 0)
    && state.bindingReady
    && state.managedSaleReady
    && subscriptionCounterEpoch.admission(state, global)
    && !(["ra", "friendship"].includes(state.counterKey)
      && global.get(`summer_subscription_${state.counterKey}_admission_closed`) === true);
  state.sourceUpdatedAt = state._lastUpdatedAtTs == null
    ? null
    : new Date(state._lastUpdatedAtTs).toISOString();
  delete state._lastUpdatedAtTs;
  delete state._dailyPaidCount;
  delete state._dailyReservedCount;
  delete state._launchPaidTimestamps;
  delete state._stagedRows;
  delete state._tiers;
  delete state._epochAnnual;

  return {
    query: state.inventoryId
      ? { inventoryId: state.inventoryId, counterKey: state.counterKey }
      : { counterKey: state.counterKey },
    payload: {
      $set: state,
      $setOnInsert: {
        createdAt: refreshedAt,
      },
    },
  };
});

return [updateMessages];

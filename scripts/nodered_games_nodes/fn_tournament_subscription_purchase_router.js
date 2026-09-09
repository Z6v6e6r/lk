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
      const spec = products[ledger?.counterKey];
      if (!spec || ledger._id !== `inventory:${spec.inventoryId}` || ledger.inventoryId !== spec.inventoryId
        || ledger.schemaVersion !== 3 || typeof ledger.ready !== 'boolean' || !integer(ledger.revision)
        || !/^[a-f0-9]{64}$/.test(ledger.baselineDigest || '')
        || !parseVivaTimestamp(ledger.baselineCapturedAt, { requireZone: true })
        || ledger.history?.version !== 1 || ledger.history.accountingScope !== 'ALL_PROVIDER_PAID'
        || !Array.isArray(ledger.history.entries) || !Array.isArray(ledger.history.settlements)
        || !Array.isArray(ledger.reservations) || !Array.isArray(ledger.legacyPaymentRefs)) return false;
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
const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const REGIONAL_ANNUAL_TIME_ZONE = "Europe/Moscow";
const MANAGED_SALE_COMPATIBILITY = {
  adapterId: "LK_REGIONAL_BOOKING_GATEWAY",
  contractVersion: 1,
  capabilityDigest: "sha256:f1e00751ba2ef19b1945964f2ee90d2d88dbf11121fdb75dfe573b6b12f31791",
};
const NETWORK_FRIENDSHIP_PROVIDER_SCOPE = {
  kind: "STATION_SET",
  scopeId: "station-set:469c42f52aeda36c921660ab7eff8a89421953fbf1136af9cb6951612d26c877",
};
const REGIONAL_ANNUAL_LIFECYCLE = {
  network_friendship: {
    activationNotBeforeDate: "2026-10-01",
    validityDays: 365,
    visits: 365,
  },
  piter_friendship: {
    activationNotBeforeDate: "2026-10-01",
    validityDays: 365,
    visits: 365,
  },
};

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const pickId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.id) || toStr(value.uuid);
};

const normalizePaymentMethod = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  if (["CARD", "CASH", "DEPOSIT", "WIDGET", "SUBSCRIPTION", "SMS"].includes(raw)) return raw;
  return null;
};

const resolveTransactionPaymentMethod = (ctx) => {
  const explicit = normalizePaymentMethod(ctx?.transactionPaymentMethod || ctx?.paymentMethod);
  if (explicit) return explicit;
  return "SMS";
};

const buildRecordQuery = (ctx) => {
  const paymentRef = toStr(ctx?.paymentRef);
  const counterKey = toStr(ctx?.counterKey);
  const inventoryId = toStr(ctx?.inventoryId);
  const saleType = toStr(ctx?.saleType);
  const campaignKey = toStr(ctx?.campaignKey);
  const productId = toStr(ctx?.productId);
  const query = {};

  if (paymentRef) {
    query.paymentRef = paymentRef;
  }
  if (inventoryId) {
    query.inventoryId = inventoryId;
  }

  const conditions = [];
  if (counterKey) {
    conditions.push({ counterKey });
  }
  if (saleType === "summer_campaign" && campaignKey) {
    conditions.push({ campaignKey });
  }
  if (saleType === "direct_product" && productId) {
    conditions.push({ productId });
  }

  if (conditions.length === 1) {
    Object.assign(query, conditions[0]);
  } else if (conditions.length > 1) {
    query.$or = conditions;
  }

  return query;
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, null, response, response];
};

const adminRequest = (ctx, method, path, payload) => {
  const timeoutMs = Math.max(3000, Math.min(120000, Math.floor(Number(ctx.httpRequestTimeoutMs) || 20000)));
  ctx.httpRequestTimeoutMs = timeoutMs;
  msg._summerSubscriptionCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.httpRequestTimeout = timeoutMs;
  msg.payload = payload;
  return [msg, null, null, null];
};

const readManagedGlobal = (key) => {
  try {
    return toStr(global.get(key));
  } catch (_error) {
    return null;
  }
};
const isAtomicSaleCounter = (counterKey) => (
  counterKey === "piter_friendship" || counterKey === "network_friendship"
);

const cupRequest = (ctx, path, token, payload) => {
  const apiBase = readManagedGlobal("subscriptions_runtime_api_base_url");
  if (!apiBase || !token) return null;
  msg._summerSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = `${apiBase.replace(/\/+$/, "")}${path}`;
  msg.headers = {
    "Content-Type": "application/json",
    "X-Subscriptions-Integration-Token": token,
    "Idempotency-Key": `lk-sale-bind:${ctx.paymentRef}`,
    "X-Correlation-Id": `lk-sale:${ctx.paymentRef}`,
  };
  msg.httpRequestTimeout = Math.max(
    3000,
    Math.min(20000, Math.floor(Number(ctx.httpRequestTimeoutMs) || 10000)),
  );
  msg.payload = payload;
  return [msg, null, null, null];
};

const exactClientSubscriptionId = (value) => {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value)) {
    const direct = toStr(value.clientSubscriptionId);
    if (direct) return direct;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = exactClientSubscriptionId(nested);
    if (found) return found;
  }
  return null;
};

const matchesExactManagedReadiness = (payload, ctx) => {
  const binding = payload?.binding;
  return payload && typeof payload === "object"
    && payload.schemaVersion === 1
    && payload.ready === true
    && payload.provider === "VIVA"
    && payload.providerProductId === ctx.productId
    && payload.providerScope?.kind === NETWORK_FRIENDSHIP_PROVIDER_SCOPE.kind
    && payload.providerScope?.scopeId === NETWORK_FRIENDSHIP_PROVIDER_SCOPE.scopeId
    && payload.requiredCompatibility?.adapterId === MANAGED_SALE_COMPATIBILITY.adapterId
    && payload.requiredCompatibility?.contractVersion === MANAGED_SALE_COMPATIBILITY.contractVersion
    && payload.requiredCompatibility?.capabilityDigest === MANAGED_SALE_COMPATIBILITY.capabilityDigest
    && payload.instanceProjector?.status === "CURRENT"
    && binding && typeof binding === "object"
    && toStr(binding.mappingId)
    && Number.isInteger(binding.mappingRevision)
    && toStr(binding.subscriptionTypeId)
    && toStr(binding.publicationId)
    && Number.isInteger(binding.policyVersion)
    && /^sha256:[a-f0-9]{64}$/.test(toStr(binding.policyDigest) || "")
    && toStr(binding.fenceId)
    && Number.isInteger(binding.fenceRevision)
    && /^sha256:[a-f0-9]{64}$/.test(toStr(binding.fenceDigest) || "")
    && toStr(binding.releaseProgramId)
    && Number.isInteger(binding.releaseProgramRevision)
    && toStr(binding.releasePhaseId)
    && /^sha256:[a-f0-9]{64}$/.test(toStr(binding.projectorReconciliationDigest) || "");
};

const providerSubscriptionProductId = (record) => toStr(
  record?.productId
  || record?.subscriptionProductId
  || record?.product?.id
  || record?.subscription?.id
);

const providerSubscriptionHomeStationId = (record) => toStr(
  record?.homeStationId
  || record?.stationId
  || record?.studioId
  || record?.homeStation?.id
  || record?.station?.id
  || record?.studio?.id
);

const strictProviderInstant = (record, keys) => {
  for (const key of keys) {
    const value = toStr(record?.[key]);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
};

const normalizeManagedProviderInstance = (record, ctx) => {
  if (!record || typeof record !== "object") return null;
  const clientSubscriptionId = toStr(record.clientSubscriptionId);
  if (!clientSubscriptionId || clientSubscriptionId !== ctx.clientSubscriptionId) return null;
  if (providerSubscriptionProductId(record) !== ctx.productId) return null;
  const rawStatus = normalizeTransactionStatus(
    record.status || record.state || record.subscriptionStatus || record.lifecycleState,
  );
  const isActive = ["ACTIVE", "ACTIVATED"].includes(rawStatus);
  const isPending = ["PENDING_ACTIVATION", "NOT_ACTIVE", "CREATED", "PAID"].includes(rawStatus)
    || (rawStatus === "NEW" && normalizeFrozenHubSale(ctx.hubLk1Sale) !== null);
  if (!isActive && !isPending) return null;
  const purchasedAt = strictProviderInstant(record, [
    "purchasedAt", "purchaseDate", "paidAt", "createdAt",
  ]);
  const activeFrom = strictProviderInstant(record, ["activeFrom", "activationDate", "activatedAt"]);
  const activeTo = strictProviderInstant(record, ["activeTo", "expirationDate", "expiresAt"]);
  const homeStationId = providerSubscriptionHomeStationId(record);
  if (!purchasedAt || !homeStationId) return null;
  if (isActive && (!activeFrom || !activeTo)) return null;
  if (!isActive && (activeFrom || activeTo)) return null;
  return {
    providerSubscriptionState: isActive ? "ACTIVE" : "PENDING_ACTIVATION",
    purchasedAt,
    activeFrom: isActive ? activeFrom : null,
    activeTo: isActive ? activeTo : null,
    homeStationId,
  };
};

const managedBindingPending = (ctx, code) => {
  const nowIso = new Date().toISOString();
  const providerObservedAt = toStr(ctx.managedProviderObservedAt)
    || toStr(ctx.saleRecord?.managedProviderObservedAt)
    || nowIso;
  const projection = {
    statusCode: 202,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "5" },
    response: {
      ok: true,
      paid: true,
      status: "PENDING_INSTANCE_BINDING",
      retryable: true,
      counterKey: toStr(ctx.counterKey),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
    },
    set: {
        status: "PAID_PENDING_INSTANCE_BINDING",
        paidAt: toStr(ctx.saleRecord?.paidAt) || nowIso,
        lastCheckedAt: nowIso,
        updatedAt: nowIso,
        managedBindingState: "PENDING_INSTANCE_BINDING",
        managedBindingErrorCode: toStr(code) || "MANAGED_SUBSCRIPTION_INSTANCE_BINDING_UNAVAILABLE",
        managedProviderObservedAt: providerObservedAt,
        managedProviderInstance: ctx.managedProviderInstance && typeof ctx.managedProviderInstance === "object"
          ? { ...ctx.managedProviderInstance }
          : null,
        clientSubscriptionId: toStr(ctx.clientSubscriptionId),
        providerTransactionStatus: toStr(ctx.providerTransactionStatus),
    },
  };
  ctx.step = "managed_sale_projection_start";
  ctx.managedSaleProjection = projection;
  delete ctx.token;
  delete ctx.vivaTokenRequestBody;
  delete ctx.providerHeaders;
  delete ctx.providerPayload;
  const atomicMsg = Object.assign({}, msg, { _summerSubscriptionCtx: ctx, payload: null });
  delete atomicMsg.headers;
  delete atomicMsg.url;
  delete atomicMsg.method;
  delete atomicMsg.req;
  delete atomicMsg.res;
  delete atomicMsg.statusCode;
  return [null, null, null, null, atomicMsg];
};

const extractList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return value.content;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length === 11 ? digits : null;
};

const piterProductLineMatches = (line, productId) => Boolean(line && typeof line === "object" && [
  line.id,
  line.uuid,
  line.productId,
  line.subscriptionId,
  line.product?.id,
  line.product?.uuid,
].some((value) => toStr(value) === productId));

const piterProviderFactsMatch = (ctx, transaction) => {
  if (ctx.inventoryLedgerSchemaVersion === 3) {
    try {
      const facts = annualHistory.observe(transaction, { productId: ctx.productId, requireInstance: false, allowFailed: true });
      return facts.amountMinor === ctx.expectedAmountMinor
        && facts.costMinor === ctx.saleRecord?.providerProductCostMinor && facts.discountMinor === ctx.saleRecord?.discountMinor
        && (ctx.clientId ? facts.clientId === ctx.clientId : Boolean(ctx.clientPhone))
        && (!ctx.clientPhone || facts.clientPhone === normalizePhone(ctx.clientPhone));
    } catch { return false; }
  }

  const expectedProductId = toStr(ctx.productId);
  const expectedAmountMinor = Number.isInteger(ctx.expectedAmountMinor) ? ctx.expectedAmountMinor : null;
  const expectedDiscountMinor = Number.isInteger(ctx.saleRecord?.discountMinor)
    ? ctx.saleRecord.discountMinor
    : Number.isInteger(ctx.discountMinor) ? ctx.discountMinor : null;
  const expectedProviderCostMinor = Number.isInteger(ctx.saleRecord?.providerProductCostMinor)
    ? ctx.saleRecord.providerProductCostMinor
    : Number.isInteger(ctx.providerProductCostMinor) ? ctx.providerProductCostMinor : null;
  const allProductLines = extractList(transaction?.products);
  const productLines = allProductLines.filter((line) => piterProductLineMatches(line, expectedProductId));
  const storedClientId = toStr(ctx.clientId);
  const storedPhone = normalizePhone(ctx.clientPhone);
  const providerClientId = toStr(transaction?.clientId)
    || toStr(transaction?.client?.id)
    || toStr(transaction?.client?.uuid)
    || toStr(transaction?.client?.clientId);
  const providerPhone = normalizePhone(
    transaction?.clientPhone
    || transaction?.client?.phone
    || transaction?.client?.mobile
    || transaction?.client?.phoneNumber,
  );
  const clientMatches = Boolean(storedClientId || storedPhone)
    && (!storedClientId || storedClientId === providerClientId)
    && (!storedPhone || storedPhone === providerPhone);
  return Boolean(
    expectedProductId
    && Number.isInteger(expectedAmountMinor) && expectedAmountMinor > 0
    && Number.isInteger(expectedDiscountMinor) && expectedDiscountMinor >= 0
    && Number.isInteger(expectedProviderCostMinor)
    && expectedAmountMinor + expectedDiscountMinor === expectedProviderCostMinor
    && toNum(transaction?.sum) === expectedAmountMinor
    && allProductLines.length === 1 && productLines.length === 1
    && toNum(productLines[0]?.discount) === expectedDiscountMinor
    && clientMatches
  );
};

const buildQuery = (entries) => entries
  .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  .join("&");

const addExactIds = (target, value, objectKeys) => {
  const values = Array.isArray(value) ? value : [value];
  values.forEach((candidate) => {
    if (candidate && typeof candidate === "object") {
      for (const key of objectKeys) {
        const id = toStr(candidate[key]);
        if (id) target.add(id);
      }
      return;
    }
    const id = toStr(candidate);
    if (id) target.add(id);
  });
};

const exactTransactionIds = (transaction) => {
  const ids = new Set();
  for (const key of ["transactionId", "transactionUuid", "id", "uuid"]) {
    addExactIds(ids, transaction?.[key], ["transactionId", "transactionUuid", "id", "uuid"]);
  }
  addExactIds(ids, transaction?.transaction, ["transactionId", "transactionUuid", "id", "uuid"]);
  return [...ids];
};

const exactTransactionClientIds = (transaction) => {
  const ids = new Set();
  addExactIds(ids, transaction?.clientId, ["id", "uuid", "clientId"]);
  addExactIds(ids, transaction?.client, ["id", "uuid", "clientId"]);
  return [...ids];
};

const exactTransactionProductIds = (transaction) => {
  const ids = new Set();
  addExactIds(ids, transaction?.productId, ["id", "uuid", "productId", "subscriptionId"]);
  addExactIds(ids, transaction?.subscriptionProductId, ["id", "uuid", "productId", "subscriptionId"]);
  const products = Array.isArray(transaction?.products) ? transaction.products : [];
  products.forEach((product) => {
    addExactIds(ids, product, ["id", "uuid", "productId", "subscriptionId"]);
    addExactIds(ids, product?.product, ["id", "uuid", "productId", "subscriptionId"]);
  });
  return [...ids];
};

const exactTransactionStudioIds = (transaction) => {
  const ids = new Set();
  for (const key of ["studioId", "stationId", "paymentStudioId"]) {
    addExactIds(ids, transaction?.[key], ["id", "uuid", "studioId", "stationId"]);
  }
  for (const key of ["studio", "station", "paymentStudio"]) {
    addExactIds(ids, transaction?.[key], ["id", "uuid", "studioId", "stationId"]);
  }
  return [...ids];
};

const transactionCreateTs = (transaction) => {
  for (const key of ["createDate", "createdAt", "createdDate"]) {
    const timestamp = toTs(transaction?.[key]);
    if (timestamp !== null) return timestamp;
  }
  return null;
};

const transactionOriginalAmountMinor = (transaction) => {
  const values = [
    transaction?.sum,
    transaction?.sumMinor,
    transaction?.amount,
    transaction?.amountMinor,
    transaction?.totalAmount,
    transaction?.totalAmountMinor,
  ]
    .map((value) => toNum(value))
    .filter((value) => value !== null)
    .map((value) => Math.max(0, Math.round(value)));
  const unique = [...new Set(values)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return null;

  const status = normalizeTransactionStatus(
    transaction?.status || transaction?.state || transaction?.paymentStatus,
  );
  if (isExplicitlyPaidPiterTransaction(transaction)) return null;
  const toPayMinor = toNum(transaction?.toPay ?? transaction?.toPayMinor);
  if (toPayMinor === null || isExplicitlyFailedPiterTransaction(transaction)) return null;
  return Math.max(0, Math.round(toPayMinor));
};

const isRecoverableOpenTransaction = (transaction) => [
  "UNPAID",
  "PAYMENT_PENDING",
  "PENDING",
  "CREATED",
  "WAITING",
  "WAITING_FOR_PAYMENT",
].includes(normalizeTransactionStatus(
  transaction?.status || transaction?.state || transaction?.paymentStatus,
));

const resolveMoscowDate = (timestamp) => {
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REGIONAL_ANNUAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const recoveryCandidateMatches = (transaction, ctx) => {
  const transactionIds = exactTransactionIds(transaction);
  const clientIds = exactTransactionClientIds(transaction);
  const productIds = exactTransactionProductIds(transaction);
  const studioIds = exactTransactionStudioIds(transaction);
  const attemptedAtTs = toTs(ctx.providerAttemptedAt);
  const createdAtTs = transactionCreateTs(transaction);
  const expectedAmountMinor = Number(ctx.expectedAmountMinor);
  const schema3 = ctx.inventoryLedgerSchemaVersion === 3;
  const providerAmountMinor = schema3 ? transaction?.toPay : transactionOriginalAmountMinor(transaction);
  const beforeMs = 60 * 1000;
  const afterMs = Math.max(180 * 1000, Number(ctx.httpRequestTimeoutMs) + 120 * 1000);
  return transactionIds.length === 1
    && (isRecoverableOpenTransaction(transaction) || (schema3 && isExplicitlyPaidPiterTransaction(transaction)))
    && (!schema3 || piterProviderFactsMatch(ctx, transaction))
    && clientIds.length === 1
    && clientIds[0] === toStr(ctx.clientId)
    && productIds.length === 1
    && productIds[0] === toStr(ctx.productId)
    && toStr(ctx.studioId)
    && studioIds.length === 1
    && studioIds[0] === toStr(ctx.studioId)
    && Number.isInteger(expectedAmountMinor)
    && expectedAmountMinor > 0
    && providerAmountMinor === expectedAmountMinor
    && attemptedAtTs !== null
    && createdAtTs !== null
    && createdAtTs >= attemptedAtTs - beforeMs
    && createdAtTs <= attemptedAtTs + afterMs;
};

const startMissingTransactionRecovery = (ctx) => {
  const attemptedAtTs = toTs(ctx.providerAttemptedAt);
  const beforeMs = 60 * 1000;
  const afterMs = Math.max(180 * 1000, Number(ctx.httpRequestTimeoutMs) + 120 * 1000);
  const dateFrom = resolveMoscowDate(attemptedAtTs === null ? null : attemptedAtTs - beforeMs);
  const dateTo = resolveMoscowDate(attemptedAtTs === null ? null : attemptedAtTs + afterMs);
  if (!toStr(ctx.clientId)
    || !toStr(ctx.productId)
    || !toStr(ctx.studioId)
    || !Number.isInteger(Number(ctx.expectedAmountMinor))
    || Number(ctx.expectedAmountMinor) <= 0
    || !dateFrom
    || !dateTo) return null;
  const query = buildQuery([
    ["clientIds", ctx.clientId],
    ["productIds", ctx.productId],
    ["dateFrom", dateFrom],
    ["dateTo", dateTo],
    ["page", 0],
    ["size", 100],
    ["sort", "createDate,desc"],
  ]);
  ctx.step = "confirm_recovery_list";
  ctx.transactionRecoveryDateFrom = dateFrom;
  ctx.transactionRecoveryDateTo = dateTo;
  return adminRequest(ctx, "GET", `/transactions?${query}`);
};

const normalizeProductType = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (
    raw === "SERVICE"
    || raw === "ADVANCE_SUB_SERVICE"
    || raw === "BOOKING_PAYMENT"
    || raw === "FULL_PAYMENT_SERVICE"
    || raw === "SUBSCRIPTION"
  ) return raw;
  return "SUBSCRIPTION";
};

const normalizeProduct = (value) => {
  if (!value || typeof value !== "object") return null;
  const id = pickId(value);
  if (!id) return null;
  return {
    id,
    name: toStr(value.name || value.title || value.displayName) || "Абонемент",
    type: normalizeProductType(value.productType || value.type),
    costMinor: Math.max(0, Math.round(toNum(value.cost) ?? 0)),
    reportedProductType: String(value.productType || value.type || "").trim().toUpperCase() || null,
    activationDays: Number.isInteger(value.activationDays) ? value.activationDays : null,
    validityDays: Number.isInteger(value.validityDays) ? value.validityDays : null,
    visits: Number.isInteger(value.visits) ? value.visits : null,
    raw: value,
  };
};

const resolveLocalDate = (now = new Date(Date.now())) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REGIONAL_ANNUAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const addLocalDateDays = (localDate, days) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate || ""))) return null;
  if (!Number.isInteger(days) || days < 0) return null;
  const [year, month, day] = localDate.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
};

const regionalAnnualLifecycleEvidence = (counterKey, product, now = new Date(Date.now())) => {
  const expected = REGIONAL_ANNUAL_LIFECYCLE[counterKey];
  if (!expected) return null;
  const purchaseDate = resolveLocalDate(now);
  const projectedAutoActivationDate = addLocalDateDays(purchaseDate, product.activationDays);
  // New LK1 HAB purchases use provider-native next-day activation. The legacy
  // CUP/Piter branch below retains its frozen October lifecycle.
  if ((counterKey === "network_friendship" && normalizeFrozenHubSale(ctx.hubLk1Sale))
    || (counterKey === "piter_friendship" && piterNextDaySale && ctx.providerLifecycleMode === "VIVA_NEXT_DAY_V1")) {
    return {
      compatible: product.reportedProductType === "SUBSCRIPTION" && product.activationDays === 1
        && product.validityDays === 365 && product.visits === 365 && projectedAutoActivationDate !== null,
      purchaseDate, projectedAutoActivationDate, activationNotBeforeDate: projectedAutoActivationDate,
      activationDays: product.activationDays, validityDays: product.validityDays, visits: product.visits,
      reportedProductType: product.reportedProductType,
    };
  }
  const compatible = (
    product.reportedProductType === "SUBSCRIPTION"
    && Number.isInteger(product.activationDays)
    && product.activationDays >= 0
    && product.validityDays === expected.validityDays
    && product.visits === expected.visits
    && purchaseDate <= expected.activationNotBeforeDate
    && projectedAutoActivationDate !== null
    && projectedAutoActivationDate >= expected.activationNotBeforeDate
  );
  return {
    compatible,
    purchaseDate,
    projectedAutoActivationDate,
    activationNotBeforeDate: expected.activationNotBeforeDate,
    activationDays: product.activationDays,
    validityDays: product.validityDays,
    visits: product.visits,
    reportedProductType: product.reportedProductType,
  };
};

const buildConfiguredProduct = (ctx) => {
  const id = toStr(ctx.productId);
  if (!id) return null;
  return {
    id,
    name: toStr(ctx.productName) || "Абонемент",
    type: "SUBSCRIPTION",
    costMinor: Math.max(0, Math.round(toNum(ctx.productCostMinor) ?? 0)),
    raw: null,
  };
};

const toStringArray = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => toStr(item))
      .filter((item) => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => toStr(item))
      .filter((item) => Boolean(item));
  }
  return [];
};

const normalizeName = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/\s+/g, " ");

const uniqueStrings = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = toStr(item);
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const computeProductScore = (productNameNormalized, targetNamesNormalized) => {
  let score = 0;
  for (const target of targetNamesNormalized) {
    if (!target) continue;
    if (productNameNormalized === target) {
      score = Math.max(score, 220);
      continue;
    }
    if (productNameNormalized.includes(target)) {
      score = Math.max(score, 170);
      continue;
    }
    if (target.includes(productNameNormalized) && productNameNormalized.length >= 6) {
      score = Math.max(score, 120);
      continue;
    }

    const targetTokens = target
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 || token.includes("🎾"));
    if (targetTokens.length > 0) {
      let tokenHits = 0;
      for (const token of targetTokens) {
        if (productNameNormalized.includes(token)) tokenHits += 1;
      }
      if (tokenHits > 0) {
        score = Math.max(score, 70 + tokenHits * 20);
      }
    }
  }

  if (productNameNormalized.includes("акцион")) score += 10;
  if (productNameNormalized.includes("🎾") || productNameNormalized.includes("теннис")) score += 5;

  return score;
};

const pickTargetProduct = (products, ctx) => {
  const configuredId = toStr(ctx.productId);
  if (configuredId) {
    const byId = products.find((item) => item.id === configuredId);
    if (byId) return byId;
    if (ctx.saleType === "tiered_direct_product") return null;
    const configuredProduct = buildConfiguredProduct(ctx);
    if (configuredProduct) return configuredProduct;
  }

  const targetNames = uniqueStrings([
    ...toStringArray(ctx.productAliases),
    ctx.productName,
  ]);
  const targetNamesNormalized = targetNames.map((name) => normalizeName(name)).filter((name) => Boolean(name));
  if (targetNamesNormalized.length === 0) return null;

  let best = null;
  let bestScore = -1;
  for (const product of products) {
    const normalized = normalizeName(product.name);
    const score = computeProductScore(normalized, targetNamesNormalized);
    if (score > bestScore) {
      best = product;
      bestScore = score;
    }
  }

  if (!best) return null;
  return bestScore >= 80 ? best : null;
};

const isLikelyPaymentUrl = (value) => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  return /(pay|tbank|tinkoff|payment|checkout|bank|acquir)|([?&](payment|transaction|order|invoice)=)/i.test(text);
};

const extractPaymentUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return null;
    return isLikelyPaymentUrl(text) ? text : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractPaymentUrl(item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  for (const key of ["paymentUrl", "redirectUrl", "paymentLink", "checkoutUrl", "cardPaymentUrl", "paymentPageUrl"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["url", "link"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["data", "payload", "result", "transaction", "transactionStatus", "cardPaymentStatus", "payment", "paymentInfo", "cardPaymentInfo"]) {
    const nested = extractPaymentUrl(value[key]);
    if (nested) return nested;
  }

  return null;
};

const pickPaymentDeadline = (ctx, payload) => {
  const direct = [
    toStr(payload?.paymentDueDate),
    toStr(payload?.paymentDeadline),
    toStr(payload?.paymentDeadlineAt),
    toStr(payload?.expiresAt),
  ].find((value) => Boolean(value));
  if (direct) return direct;

  const ttlMinutes = Math.max(5, Math.min(360, Math.floor(Number(ctx.reservationMinutes) || 30)));
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
};

const normalizeTransactionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "UNKNOWN";
  return status;
};

const hasStatusToken = (status, token) => status
  .split(/[^A-Z0-9]+/)
  .filter(Boolean)
  .some((part) => part === token || part.startsWith(token));

const isPaidTransaction = (payload) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  if (
    hasStatusToken(status, "PAID")
    || hasStatusToken(status, "SUCCESS")
    || hasStatusToken(status, "COMPLETE")
    || hasStatusToken(status, "APPROV")
  ) return true;

  const toPay = toNum(payload?.toPay);
  if (toPay != null && Math.round(toPay) <= 0 && !extractPaymentUrl(payload)) return true;
  return false;
};

const isFailedTransaction = (payload) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  return (
    hasStatusToken(status, "FAIL")
    || hasStatusToken(status, "CANCEL")
    || hasStatusToken(status, "REJECT")
    || hasStatusToken(status, "EXPIRE")
  );
};

// Piter capacity can only become paid on an explicit provider terminal status.
// A zero outstanding balance is not proof that a transaction was paid.
const isExplicitlyPaidPiterTransaction = (payload) => [
  "PAID", "SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "APPROVED",
].includes(normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus));
const isExplicitlyFailedPiterTransaction = (payload, saleContext = null) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  if (["FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"].includes(status)) return true;
  if (saleContext?.inventoryLedgerSchemaVersion === 3) return false;
  if (["REFUND", "REFUNDED"].includes(status)) {
    const refundSum = toNum(payload?.refundSum);
    return refundSum != null && Math.round(refundSum) > 0
      && Boolean(toStr(payload?.refundedAt))
      && Number.isFinite(Date.parse(toStr(payload?.refundedAt)));
  }
  if (status !== "UNPAID") return false;
  const paymentDueDate = toStr(payload?.paymentDueDate);
  const paymentDueTs = paymentDueDate ? Date.parse(paymentDueDate) : Number.NaN;
  const refundSum = toNum(payload?.refundSum);
  const toPay = toNum(payload?.toPay);
  return Number.isFinite(paymentDueTs)
    && paymentDueTs <= Date.now()
    && toPay != null
    && Math.round(toPay) > 0
    && !toStr(payload?.paymentDate)
    && !toStr(payload?.refundedAt)
    && !(refundSum != null && Math.round(refundSum) > 0);
};

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx) {
  return fail(500, "Summer subscription context is missing");
}

if (String(ctx.step || "").startsWith("annual_history_")) return [null, null, null, null, msg];

if (["ra", "friendship"].includes(ctx.counterKey)
  && ["token_purchase", "load_products"].includes(ctx.step)
  && global.get(`summer_subscription_${ctx.counterKey}_admission_closed`) === true) {
  return fail(503, "Продажа подписки временно закрыта", { code: "SUBSCRIPTION_ADMISSION_CLOSED" });
}

// Piter-only release: do not admit new HUB checkout continuations. Provider
// results and existing paid/pending confirmation/binding recovery stay routable.
if (toStr(ctx.counterKey) === "network_friendship"
  && ["managed_sale_readiness", "token_purchase", "load_products"].includes(ctx.step)
  && (!hubLk1Sale || JSON.stringify(normalizeFrozenHubSale(ctx.hubLk1Sale)) !== JSON.stringify(hubLk1Sale))) {
  return fail(503, "Новые продажи ХАБ не включены в этот выпуск", {
    code: "HUB_NEW_SALES_RELEASE_DISABLED", counterKey: "network_friendship",
  });
}

if (ctx.step === "managed_sale_readiness") {
  if (!isOk(msg.statusCode) || !matchesExactManagedReadiness(msg.payload, ctx)) {
    return fail(503, "Контур managed-продажи ХАБ не готов", {
      code: "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE",
      counterKey: toStr(ctx.counterKey),
      readinessStatusCode: Number(msg.statusCode) || null,
    });
  }
  ctx.managedSaleBinding = { ...msg.payload.binding };
  ctx.managedSaleReadinessCheckedAt = toStr(msg.payload.checkedAt);
  ctx.managedSaleProviderScope = { ...NETWORK_FRIENDSHIP_PROVIDER_SCOPE };
  if (!toStr(ctx.vivaTokenRequestBody)) {
    return fail(503, "Сервисная авторизация Viva не настроена", {
      code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
    });
  }
  ctx.step = "token_purchase";
  msg._summerSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
  msg.payload = ctx.vivaTokenRequestBody;
  return [msg, null, null, null];
}

if (ctx.step === "token_purchase") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(502, "Viva token error", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  ctx.token = msg.payload.access_token;
  ctx.step = "load_products";
  return adminRequest(ctx, "GET", "/products/subscriptions?size=500");
}

if (ctx.step === "load_products") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Failed to load Viva subscriptions", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  const products = extractList(msg.payload)
    .map((item) => normalizeProduct(item))
    .filter((item) => Boolean(item));

  if (products.length === 0) {
    return fail(502, "Viva returned no subscriptions", msg.payload || null);
  }

  const targetProduct = pickTargetProduct(products, ctx);
  if (!targetProduct) {
    const requestedName = toStr(ctx.productName) || "Абонемент";
    return fail(404, `Не найден абонемент ${requestedName}`, {
      requestedPlanKey: toStr(ctx.planKey),
      requestedName,
      requestedId: ctx.productId,
      requestedAliases: toStringArray(ctx.productAliases),
      availableProducts: products.map((item) => ({ id: item.id, name: item.name })),
    });
  }

  const configuredProductCostMinor = Number.isFinite(Number(ctx.productCostMinor))
    ? Math.max(0, Math.round(Number(ctx.productCostMinor)))
    : null;
  const configuredPriceMinor = Number.isFinite(Number(ctx.priceMinor))
    ? Math.max(0, Math.round(Number(ctx.priceMinor)))
    : null;
  const isTieredDirectProduct = ctx.saleType === "tiered_direct_product";
  if (
    isTieredDirectProduct
    && (
      configuredProductCostMinor == null
      || configuredPriceMinor == null
      || targetProduct.costMinor !== configuredProductCostMinor
      || configuredPriceMinor > targetProduct.costMinor
    )
  ) {
    return fail(503, "Цена Viva-продукта не соответствует ценовой партии", {
      counterKey: toStr(ctx.counterKey),
      batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
      productId: targetProduct.id,
      expectedProductCostMinor: configuredProductCostMinor,
      actualProductCostMinor: targetProduct.costMinor,
      priceMinor: configuredPriceMinor,
    });
  }

  const lifecycleEvidence = regionalAnnualLifecycleEvidence(ctx.counterKey, targetProduct);
  if (lifecycleEvidence && !lifecycleEvidence.compatible) {
    return fail(503, "Параметры активации Viva-продукта не соответствуют годовому предложению", {
      code: "REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE",
      counterKey: toStr(ctx.counterKey),
      productId: targetProduct.id,
      ...lifecycleEvidence,
    });
  }

  const priceMinor = isTieredDirectProduct ? configuredPriceMinor : targetProduct.costMinor;
  const discountMinor = isTieredDirectProduct ? targetProduct.costMinor - priceMinor : 0;
  ctx.productId = targetProduct.id;
  ctx.productName = targetProduct.name;
  ctx.productType = targetProduct.type;
  ctx.providerProductCostMinor = targetProduct.costMinor;
  ctx.productCostMinor = priceMinor;
  ctx.priceMinor = priceMinor;
  ctx.discountMinor = discountMinor;
  if (lifecycleEvidence) {
    ctx.providerActivationDays = lifecycleEvidence.activationDays;
    ctx.providerAutoActivationDate = lifecycleEvidence.projectedAutoActivationDate;
    ctx.activationNotBeforeDate = lifecycleEvidence.activationNotBeforeDate;
    ctx.providerValidityDays = lifecycleEvidence.validityDays;
    ctx.providerVisits = lifecycleEvidence.visits;
  }

  const transactionPayload = {
    clientPhone: ctx.clientPhone.startsWith("+") ? ctx.clientPhone : `+${ctx.clientPhone}`,
    paymentMethod: resolveTransactionPaymentMethod(ctx),
    products: [
      {
        id: targetProduct.id,
        count: 1,
        customAmount: null,
        type: targetProduct.type,
        discount: discountMinor,
      },
    ],
    offlineTillId: null,
    deposit: 0,
    ...(ctx.studioId ? { studioId: ctx.studioId } : {}),
    ...(ctx.successUrl ? { successUrl: ctx.successUrl } : {}),
    ...(ctx.failUrl ? { failUrl: ctx.failUrl } : {}),
  };

  ctx.step = "create_transaction";
  ctx.transactionPayload = transactionPayload;
  const request = adminRequest(ctx, "POST", "/transactions", transactionPayload);
  if (isAtomicSaleCounter(ctx.counterKey)) {
    ctx.step = "piter_reserve_start";
    ctx.providerMethod = request[0].method;
    ctx.providerUrl = request[0].url;
    ctx.providerHeaders = request[0].headers;
    ctx.providerPayload = request[0].payload;
    return [null, null, null, null, request[0]];
  }
  return request;
}

if (ctx.step === "create_transaction") {
  if (!isOk(msg.statusCode)) {
    if (isAtomicSaleCounter(ctx.counterKey)) {
      ctx.step = "piter_provider_result";
      ctx.providerResult = {
        ok: false,
        transactionId: null,
        paymentUrl: null,
        response: {
          ok: false,
          status: "PROVIDER_UNKNOWN",
          paymentRef: ctx.paymentRef,
          message: "Результат запроса Viva неоднозначен; автоматический повтор запрещён.",
        },
      };
      msg._summerSubscriptionCtx = ctx;
      return [null, null, null, null, msg];
    }
    const errorMessage = String(
      msg.payload?.message
      || msg.payload?.error
      || msg.payload?.details?.message
      || "",
    ).toLowerCase();
    if (errorMessage.includes("payment method") && errorMessage.includes("not implemented")) {
      const currentMethod = normalizePaymentMethod(ctx.transactionPayload?.paymentMethod);
      const fallbackMap = {
        SMS: "CARD",
        SUBSCRIPTION: "CARD",
        WIDGET: "CARD",
        CARD: "CASH",
      };
      const fallbackMethod = currentMethod ? fallbackMap[currentMethod] || null : null;
      if (fallbackMethod && fallbackMethod !== currentMethod) {
        const retryPayload = Object.assign({}, ctx.transactionPayload, { paymentMethod: fallbackMethod });
        ctx.transactionPayload = retryPayload;
        return adminRequest(ctx, "POST", "/transactions", retryPayload);
      }
    }
    return fail(msg.statusCode || 502, "Failed to create Viva transaction", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  const transactionId = pickId(msg.payload);
  const paymentUrl = extractPaymentUrl(msg.payload);
  const toPayMinor = Math.max(0, Math.round(toNum(msg.payload?.toPay) ?? 0));
  if (isAtomicSaleCounter(ctx.counterKey) && !transactionId) {
    ctx.step = "piter_provider_result";
    ctx.providerResult = {
      ok: false,
      response: { ok: false, status: "PROVIDER_UNKNOWN", paymentRef: ctx.paymentRef,
        message: "Viva не вернула подтверждённый идентификатор транзакции." },
    };
    return [null, null, null, null, msg];
  }
  if (
    ctx.saleType === "tiered_direct_product"
    && toPayMinor !== Math.max(0, Math.round(Number(ctx.priceMinor) || 0))
  ) {
    if (isAtomicSaleCounter(ctx.counterKey)) {
      ctx.step = "piter_provider_result";
      ctx.providerResult = {
        ok: false,
        transactionId,
        paymentUrl,
        response: { ok: false, status: "PROVIDER_UNKNOWN", paymentRef: ctx.paymentRef,
          message: "Viva вернула сумму, не совпадающую с атомарно зафиксированной ценой." },
      };
      msg._summerSubscriptionCtx = ctx;
      return [null, null, null, null, msg];
    }
    return fail(502, "Viva вернула неверную сумму к оплате", {
      counterKey: toStr(ctx.counterKey),
      batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
      productId: toStr(ctx.productId),
      expectedToPayMinor: Math.max(0, Math.round(Number(ctx.priceMinor) || 0)),
      actualToPayMinor: toPayMinor,
      transactionId: pickId(msg.payload),
    });
  }
  if (!paymentUrl && toPayMinor > 0) {
    if (isAtomicSaleCounter(ctx.counterKey)) {
      ctx.step = "piter_provider_result";
      ctx.providerResult = {
        ok: false,
        transactionId,
        paymentUrl: null,
        response: { ok: false, status: "PROVIDER_UNKNOWN", paymentRef: ctx.paymentRef,
          message: "Viva создала транзакцию без подтверждённой ссылки оплаты." },
      };
      msg._summerSubscriptionCtx = ctx;
      return [null, null, null, null, msg];
    }
    return fail(502, "Viva transaction has no paymentUrl", {
      transactionId,
      response: msg.payload || null,
    });
  }

  const expiresAt = pickPaymentDeadline(ctx, msg.payload);
  const nowIso = new Date().toISOString();

  const reservationRecord = {
    counterKey: toStr(ctx.counterKey),
    inventoryId: toStr(ctx.inventoryId),
    unlimited: ctx.unlimited === true,
    releasePhase: toStr(ctx.releasePhase),
    releaseStartDate: toStr(ctx.releaseStartDate),
    launchLimit: Math.max(0, Math.floor(Number(ctx.launchLimit) || 0)),
    dailyLimit: Math.max(0, Math.floor(Number(ctx.dailyLimit) || 0)),
    dailyDropDate: toStr(ctx.dailyDropDate),
    batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
    batchSize: Math.max(0, Math.floor(Number(ctx.batchSize) || 0)),
    saleType: toStr(ctx.saleType),
    planKey: toStr(ctx.planKey),
    campaignKey: ctx.campaignKey,
    paymentRef: ctx.paymentRef,
    transactionId,
    clientPhone: ctx.clientPhone,
    clientId: ctx.clientId || null,
    trainerQrCode: toStr(ctx.trainerQrCode),
    referralToken: toStr(ctx.referralToken),
    referralVisitId: toStr(ctx.referralVisitId),
    productId: ctx.productId,
    productName: ctx.productName,
    productType: ctx.productType || "SUBSCRIPTION",
    amountMinor: Math.max(0, Math.round(Number(ctx.productCostMinor) || 0)),
    providerProductCostMinor: Math.max(0, Math.round(Number(ctx.providerProductCostMinor) || 0)),
    discountMinor: Math.max(0, Math.round(Number(ctx.discountMinor) || 0)),
    providerActivationDays: Number.isInteger(ctx.providerActivationDays)
      ? ctx.providerActivationDays
      : null,
    providerAutoActivationDate: toStr(ctx.providerAutoActivationDate),
    providerLifecycleMode: toStr(ctx.providerLifecycleMode),
    activationNotBeforeDate: toStr(ctx.activationNotBeforeDate),
    providerValidityDays: Number.isInteger(ctx.providerValidityDays)
      ? ctx.providerValidityDays
      : null,
    providerVisits: Number.isInteger(ctx.providerVisits) ? ctx.providerVisits : null,
    managedSaleBinding: ctx.counterKey === "network_friendship" && ctx.managedSaleBinding
      ? { ...ctx.managedSaleBinding }
      : null,
    managedSaleReadinessCheckedAt: ctx.counterKey === "network_friendship"
      ? toStr(ctx.managedSaleReadinessCheckedAt)
      : null,
    managedSaleProviderScope: ctx.counterKey === "network_friendship"
      ? { ...NETWORK_FRIENDSHIP_PROVIDER_SCOPE }
      : null,
    hubLk1Sale: normalizeFrozenHubSale(ctx.hubLk1Sale),
    managedBindingState: ctx.counterKey === "network_friendship" ? "AWAITING_PAYMENT" : null,
    toPayMinor,
    status: "PAYMENT_PENDING",
    paymentUrl,
    expiresAt,
    successUrl: ctx.successUrl || null,
    failUrl: ctx.failUrl || null,
    updatedAt: nowIso,
  };

  const dbMsg = Object.assign({}, msg, {
    query: buildRecordQuery(ctx),
    payload: {
      $set: reservationRecord,
      $setOnInsert: {
        createdAt: nowIso,
      },
    },
  });

  const responseMsg = Object.assign({}, msg, {
    statusCode: 201,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      unlimited: ctx.unlimited === true,
      releasePhase: toStr(ctx.releasePhase),
      dailyDropActive: ctx.dailyDropActive === true,
      dailyDropDate: toStr(ctx.dailyDropDate),
      batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
      batchSize: Math.max(0, Math.floor(Number(ctx.batchSize) || 0)),
      batchRemainingBefore: Math.max(0, Math.floor(Number(ctx.batchRemainingBefore) || 0)),
      batchRemainingAfterReservation: Math.max(0, Math.floor(Number(ctx.batchRemainingBefore) || 0) - 1),
      planKey: toStr(ctx.planKey),
      planType: toStr(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId,
      paymentUrl,
      paymentExpiresAt: expiresAt,
      productId: ctx.productId,
      productName: ctx.productName,
      priceMinor: Math.max(0, Math.round(Number(ctx.priceMinor) || 0)),
      discountMinor: Math.max(0, Math.round(Number(ctx.discountMinor) || 0)),
      toPayMinor,
      toPay: toPayMinor / 100,
      remainingBefore: Math.max(0, Math.floor(Number(ctx.remainingBefore) || 0)),
      remainingAfterReservation: Math.max(0, Math.floor(Number(ctx.remainingBefore) || 0) - 1),
      status: "PAYMENT_PENDING",
    },
  });

  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "purchase_transaction_created",
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      paymentRef: ctx.paymentRef,
      transactionId,
      toPayMinor,
      productId: ctx.productId,
    },
  });

  if (isAtomicSaleCounter(ctx.counterKey)) {
    ctx.step = "piter_provider_result";
    ctx.providerResult = {
      ok: true,
      transactionId,
      paymentUrl,
      expiresAt,
      toPayMinor,
      response: responseMsg.payload,
    };
    msg._summerSubscriptionCtx = ctx;
    return [null, null, null, null, msg];
  }

  return [null, dbMsg, responseMsg, debugMsg];
}

if (ctx.step === "token_confirm") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(502, "Viva token error", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  ctx.token = msg.payload.access_token;
  if (ctx.annualHistoryCandidate === true && ctx.transactionId) {
    ctx.step = "annual_history_begin";
    return [null, null, null, null, msg];
  }
  if (!ctx.transactionId) {
    const recoveryRequest = startMissingTransactionRecovery(ctx);
    if (!recoveryRequest) {
      return fail(503, "Транзакция Viva требует ручной сверки", {
        code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_CONTEXT_INCOMPLETE",
        paymentRef: ctx.paymentRef,
      });
    }
    return recoveryRequest;
  }

  ctx.step = "confirm_lookup";
  return adminRequest(
    ctx,
    "GET",
    `/transactions/${encodeURIComponent(ctx.transactionId)}`,
  );
}

if (ctx.step === "confirm_recovery_list") {
  if (!isOk(msg.statusCode)) {
    return fail(503, "Не удалось проверить транзакции Viva по клиенту", {
      code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_UNAVAILABLE",
      paymentRef: ctx.paymentRef,
      statusCode: Number(msg.statusCode) || null,
    });
  }

  const transactions = extractList(msg.payload)
    .filter((item) => item && typeof item === "object");
  const totalPages = msg.payload?.totalPages;
  const pageNumber = msg.payload?.number;
  const totalElements = msg.payload?.totalElements;
  const numberOfElements = msg.payload?.numberOfElements;
  const completeFirstPage = Number.isInteger(totalPages)
    && totalPages >= 0
    && totalPages <= 1
    && Number.isInteger(pageNumber)
    && pageNumber === 0
    && msg.payload?.last === true
    && Number.isInteger(totalElements)
    && totalElements === transactions.length
    && Number.isInteger(numberOfElements)
    && numberOfElements === transactions.length
    && totalPages === (transactions.length > 0 ? 1 : 0);
  const incompletePage = !completeFirstPage;
  if (incompletePage) {
    return fail(503, "Список транзакций Viva требует постраничной сверки", {
      code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_INCOMPLETE",
      paymentRef: ctx.paymentRef,
    });
  }

  const matches = transactions.filter((transaction) => recoveryCandidateMatches(transaction, ctx));
  if (matches.length !== 1) {
    return fail(503, "Транзакция Viva не определена однозначно", {
      code: matches.length === 0
        ? "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_NOT_FOUND"
        : "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_AMBIGUOUS",
      paymentRef: ctx.paymentRef,
      matchCount: matches.length,
    });
  }

  const transactionId = exactTransactionIds(matches[0])[0];
  ctx.transactionId = transactionId;
  ctx.transactionRecovered = true;
  ctx.transactionRecoveredAt = new Date().toISOString();
  ctx.step = "confirm_lookup";
  return adminRequest(ctx, "GET", `/transactions/${encodeURIComponent(transactionId)}`);
}

if (ctx.step === "managed_sale_instance_readback" && ctx.inventoryLedgerSchemaVersion === 3) {
  ctx.schema3HubDiscovery = { transaction: ctx.schema3HubTransaction, clientId: ctx.clientId,
    page: 0, rows: [], afterLedger: true };
  ctx.step = "schema3_hub_instance_discovery";
}

// New ledgers require an exact issued instance before recording a HAB payment.
// The canonical transaction endpoint does not expose clientSubscriptionId.
if (ctx.step === "schema3_hub_instance_discovery") {
  const discovery = ctx.schema3HubDiscovery;
  const page = msg.payload;
  const rows = page?.content;
  const validPage = discovery && ctx.inventoryLedgerSchemaVersion === 3
    && ctx.counterKey === "network_friendship" && isOk(msg.statusCode)
    && Array.isArray(rows) && rows.every(row => row && typeof row === "object")
    && page.number === discovery.page && Number.isInteger(page.totalPages)
    && page.totalPages >= 0 && page.totalPages <= 50
    && Number.isInteger(page.totalElements) && page.totalElements >= 0
    && page.numberOfElements === rows.length && rows.length <= 200
    && (page.totalPages === 0 ? page.totalElements === 0 && discovery.page === 0
      : discovery.page < page.totalPages)
    && page.last === (discovery.page >= page.totalPages - 1)
    && (discovery.page === 0 || (page.totalPages === discovery.totalPages
      && page.totalElements === discovery.totalElements));
  if (!validPage) return fail(503, "Экземпляр подписки Viva требует сверки", { code: "HUB_INSTANCE_DISCOVERY_INCOMPLETE" });
  discovery.totalPages = page.totalPages;
  discovery.totalElements = page.totalElements;
  discovery.rows.push(...rows);
  if (discovery.rows.length > page.totalElements) return fail(503, "Экземпляр подписки Viva требует сверки", { code: "HUB_INSTANCE_DISCOVERY_INCOMPLETE" });
  if (!page.last) {
    discovery.page++;
    return adminRequest(ctx, "GET", `/clients/${encodeURIComponent(discovery.clientId)}/subscriptions?includeFinished=true&size=200&page=${discovery.page}`);
  }
  if (discovery.rows.length !== page.totalElements) return fail(503, "Экземпляр подписки Viva требует сверки", { code: "HUB_INSTANCE_DISCOVERY_INCOMPLETE" });
  try {
    const fact = annualHistory.observe(discovery.transaction, { productId: ctx.productId,
      clientId: discovery.clientId, subscriptions: discovery.rows });
    if (fact.state !== "PAID" || fact.transactionId !== ctx.transactionId
      || fact.clientId !== discovery.clientId || !piterProviderFactsMatch(ctx, discovery.transaction)) throw Error("INSTANCE_MISMATCH");
    const previous = ctx.schema3HubInstance;
    if (discovery.afterLedger && previous?.subscriptionId !== fact.subscriptionId) throw Error("INSTANCE_DRIFT");
    ctx.schema3HubInstance = { transactionId: fact.transactionId, clientId: fact.clientId,
      productId: fact.productId, subscriptionId: fact.subscriptionId };
    ctx.schema3HubTransaction = discovery.transaction;
    if (discovery.afterLedger) {
      const record = discovery.rows.find(r => [r.subscriptionId, r.clientSubscriptionId, r.id, r.uuid].includes(fact.subscriptionId));
      const activeFrom = strictProviderInstant(record, ["activationDate"]);
      const activeTo = strictProviderInstant(record, ["expirationDate"]);
      const state = normalizeTransactionStatus(record?.status);
      if (!normalizeFrozenHubSale(ctx.hubLk1Sale)
        || !["NEW", "ACTIVE", "FINISHED", "EXPIRED"].includes(state)
        || (state !== "NEW" && (!activeFrom || !activeTo))
        || (record.activationDate && !activeFrom) || (record.expirationDate && !activeTo)) throw Error("INSTANCE_DATES");
      ctx.schema3HubReadback = { providerSubscriptionState: state === "NEW" ? "PENDING_ACTIVATION" : state,
        purchasedAt: fact.paidAt, activeFrom, activeTo };
    }
    msg.payload = discovery.transaction;
    ctx.step = discovery.afterLedger ? "managed_sale_instance_readback" : "confirm_lookup";
    delete ctx.schema3HubDiscovery;
  } catch {
    return fail(503, "Экземпляр подписки Viva требует сверки", { code: "HUB_INSTANCE_DISCOVERY_MISMATCH" });
  }
}

if (ctx.step === "confirm_lookup") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Failed to fetch Viva transaction", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  if (ctx.transactionRecovered === true && !recoveryCandidateMatches(msg.payload, ctx)) {
    return fail(503, "Транзакция Viva не прошла повторную проверку", {
      code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_GET_MISMATCH",
      paymentRef: ctx.paymentRef,
    });
  }

  if (ctx.annualHistoryCandidate === true) {
    ctx.annualHistoryTransaction = msg.payload;
    ctx.step = "annual_history_transaction";
    return [null, null, null, null, msg];
  }
  const nowIso = new Date().toISOString();
  const isPiter = ctx.counterKey === "piter_friendship";
  const isManagedAnnual = isPiter || ctx.counterKey === "network_friendship";
  const paid = isManagedAnnual ? isExplicitlyPaidPiterTransaction(msg.payload) : isPaidTransaction(msg.payload);
  // Piter's offline legacy reconciliation rules must not change HUB inventory
  // semantics: expired UNPAID/refund evidence is not an automatic HUB release.
  const failed = !paid && (isPiter
    ? isExplicitlyFailedPiterTransaction(msg.payload, ctx)
    : ctx.counterKey === "network_friendship"
      ? ["FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"].includes(
        normalizeTransactionStatus(msg.payload?.status || msg.payload?.state || msg.payload?.paymentStatus),
      )
      : isFailedTransaction(msg.payload));
  const nextStatus = paid ? "PAID" : failed ? "FAILED" : "PAYMENT_PENDING";
  if (isManagedAnnual) {
    const providerToPay = toNum(msg.payload?.toPay);
    const expectedAmount = ctx.expectedAmountMinor;
    const validAmount = Number.isInteger(expectedAmount) && expectedAmount > 0
      && Number.isInteger(providerToPay) && providerToPay >= 0
      && (paid ? providerToPay === (ctx.inventoryLedgerSchemaVersion === 3 ? expectedAmount : 0)
        : failed ? (providerToPay === 0 || providerToPay === expectedAmount)
          : providerToPay === expectedAmount);
    if (!toStr(ctx.transactionId) || pickId(msg.payload) !== ctx.transactionId
      || !validAmount || !piterProviderFactsMatch(ctx, msg.payload)) {
      return fail(503, "Подтверждение Viva требует сверки; состояние покупки не изменено", {
        code: isPiter ? "PITER_CONFIRM_PROVIDER_MISMATCH" : "HUB_CONFIRM_PROVIDER_MISMATCH",
        paymentRef: ctx.paymentRef,
      });
    }
  }
  const expiresAt = pickPaymentDeadline(ctx, msg.payload);
  if (ctx.counterKey === "network_friendship" && paid) {
    if (ctx.inventoryLedgerSchemaVersion === 3 && !normalizeFrozenHubSale(ctx.hubLk1Sale)) {
      return fail(503, "Экземпляр подписки Viva требует сверки", { code: "HUB_SCHEMA3_FROZEN_LK1_RECEIPT_REQUIRED" });
    }
    const providerClientId = ctx.inventoryLedgerSchemaVersion === 3
      ? annualHistory.observe(msg.payload, { productId: ctx.productId, requireInstance: false }).clientId
      : toStr(msg.payload?.providerClientId || msg.payload?.clientId || msg.payload?.client?.id);
    const verified = ctx.schema3HubInstance;
    if (ctx.inventoryLedgerSchemaVersion === 3 && (!verified
      || verified.transactionId !== ctx.transactionId || verified.clientId !== providerClientId
      || verified.productId !== ctx.productId || !toStr(verified.subscriptionId))) {
      delete ctx.schema3HubInstance;
      ctx.schema3HubDiscovery = { transaction: msg.payload, clientId: providerClientId, page: 0, rows: [] };
      ctx.step = "schema3_hub_instance_discovery";
      return adminRequest(ctx, "GET", `/clients/${encodeURIComponent(providerClientId)}/subscriptions?includeFinished=true&size=200&page=0`);
    }
    const clientSubscriptionId = ctx.inventoryLedgerSchemaVersion === 3
      ? verified.subscriptionId : exactClientSubscriptionId(msg.payload);
    if (!clientSubscriptionId
      || !providerClientId
      || (toStr(ctx.clientId) && toStr(ctx.clientId) !== providerClientId)
      || (!normalizeFrozenHubSale(ctx.hubLk1Sale)
        && (!ctx.managedSaleBinding || typeof ctx.managedSaleBinding !== "object"))) {
      return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_PROVIDER_INSTANCE_ID_UNAVAILABLE");
    }
    ctx.clientSubscriptionId = clientSubscriptionId;
    ctx.clientId = providerClientId;
    ctx.providerTransactionStatus = normalizeTransactionStatus(
      msg.payload?.status || msg.payload?.state || msg.payload?.paymentStatus,
    );
    ctx.providerTransactionObservedAt = nowIso;
    // Preserve transaction facts before adminRequest replaces msg.payload.
    ctx.confirmResult = {
      nextStatus,
      transactionId: pickId(msg.payload),
      paid,
      failed,
      expiresAt,
      paymentUrl: extractPaymentUrl(msg.payload),
      toPayMinor: Math.max(0, Math.round((toNum(msg.payload?.toPay) ?? Number(ctx.toPayMinor)) || 0)),
      response: null,
      reconcile: ctx.reconcile === true,
    };
    const readbackRequest = adminRequest(
      ctx,
      "GET",
      `/clients/${encodeURIComponent(ctx.clientId)}/subscriptions?${ctx.inventoryLedgerSchemaVersion === 3
        ? "includeFinished=true&size=200&page=0" : "size=200"}`,
    );
    ctx.step = "piter_confirm_result";
    ctx.providerMethod = readbackRequest[0].method;
    ctx.providerUrl = readbackRequest[0].url;
    ctx.providerHeaders = readbackRequest[0].headers;
    ctx.providerPayload = readbackRequest[0].payload;
    msg._summerSubscriptionCtx = ctx;
    return [null, null, null, null, msg];
  }
  const dbQuery = buildRecordQuery(ctx);

  const dbMsg = Object.assign({}, msg, {
    query: dbQuery,
    payload: {
      $set: {
        status: nextStatus,
        updatedAt: nowIso,
        lastCheckedAt: nowIso,
        paymentUrl: extractPaymentUrl(msg.payload),
        expiresAt,
        toPayMinor: Math.max(0, Math.round((toNum(msg.payload?.toPay) ?? Number(ctx.toPayMinor)) || 0)),
        paidAt: paid ? nowIso : null,
      },
    },
  });

  const responseMsg = ctx.reconcile === true ? null : Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      planKey: toStr(ctx.planKey),
      planType: toStr(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: nextStatus,
      paid,
      failed,
      paymentUrl: extractPaymentUrl(msg.payload),
      expiresAt,
      updatedAt: nowIso,
    },
  });

  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "confirm_lookup_done",
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: nextStatus,
    },
  });

  if (isAtomicSaleCounter(ctx.counterKey)) {
    ctx.step = "piter_confirm_result";
    ctx.confirmResult = {
      nextStatus,
      transactionId: pickId(msg.payload),
      paid,
      failed,
      expiresAt,
      paymentUrl: extractPaymentUrl(msg.payload),
      toPayMinor: Math.max(0, Math.round((toNum(msg.payload?.toPay) ?? Number(ctx.toPayMinor)) || 0)),
      response: responseMsg?.payload || null,
      reconcile: ctx.reconcile === true,
    };
    msg._summerSubscriptionCtx = ctx;
    return [null, null, null, null, msg];
  }

  return [null, dbMsg, responseMsg, debugMsg];
}

if (ctx.step === "managed_sale_instance_readback") {
  if (!isOk(msg.statusCode)) {
    return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_PROVIDER_READBACK_UNAVAILABLE");
  }
  const exactRecord = extractList(msg.payload).find(
    (item) => toStr(item?.clientSubscriptionId) === ctx.clientSubscriptionId,
  );
  const providerInstance = ctx.inventoryLedgerSchemaVersion === 3
    ? ctx.schema3HubReadback : normalizeManagedProviderInstance(exactRecord, ctx);
  if (!providerInstance) {
    return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_PROVIDER_INSTANCE_UNCONFIRMED");
  }
  const frozenLk1Sale = normalizeFrozenHubSale(ctx.hubLk1Sale);
  if (frozenLk1Sale) {
    const nowIso = new Date().toISOString();
    ctx.step = "managed_sale_projection_start";
    ctx.managedSaleProjection = {
      statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8" },
      response: { ok: true, paid: true, status: "PAID", managedBindingState: "LK1_VIVA_CONFIRMED",
        counterKey: ctx.counterKey, inventoryId: ctx.inventoryId, paymentRef: ctx.paymentRef,
        transactionId: ctx.transactionId, clientSubscriptionId: ctx.clientSubscriptionId, updatedAt: nowIso },
      set: { status: "PAID", paidAt: toStr(ctx.saleRecord?.paidAt) || providerInstance.purchasedAt,
        lastCheckedAt: nowIso, updatedAt: nowIso, managedBindingState: "LK1_VIVA_CONFIRMED",
        managedBindingErrorCode: null, clientSubscriptionId: ctx.clientSubscriptionId,
        hubLk1Sale: frozenLk1Sale,
        providerSubscriptionState: providerInstance.providerSubscriptionState,
        providerPurchasedAt: providerInstance.purchasedAt,
        providerActivationDate: providerInstance.activeFrom,
        providerExpirationDate: providerInstance.activeTo,
        providerExpectedActivationDate: addLocalDateDays(resolveLocalDate(new Date(providerInstance.purchasedAt)), 1) },
    };
    delete ctx.token; delete ctx.vivaTokenRequestBody; delete ctx.providerHeaders; delete ctx.providerPayload;
    const next = { _summerSubscriptionCtx: ctx, payload: null, req: msg.req, res: msg.res, _msgid: msg._msgid };
    return [null, null, null, null, next];
  }
  const bindingToken = readManagedGlobal("subscriptions_sale_binding_integration_token");
  const binding = ctx.managedSaleBinding;
  const scope = ctx.managedSaleProviderScope;
  if (!bindingToken || !binding || !scope
    || scope.kind !== NETWORK_FRIENDSHIP_PROVIDER_SCOPE.kind
    || scope.scopeId !== NETWORK_FRIENDSHIP_PROVIDER_SCOPE.scopeId) {
    return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_SALE_BINDING_NOT_CONFIGURED");
  }
  ctx.managedProviderInstance = providerInstance;
  ctx.managedProviderObservedAt = toStr(ctx.saleRecord?.managedProviderObservedAt)
    || providerInstance.purchasedAt;
  ctx.step = "managed_sale_binding_confirm";
  const request = cupRequest(
    ctx,
    "/internal/subscriptions/sale-bindings/confirm",
    bindingToken,
    {
      provider: "VIVA",
      providerProductId: ctx.productId,
      providerScopeKind: scope.kind,
      providerScopeId: scope.scopeId,
      providerClientId: ctx.clientId,
      clientSubscriptionId: ctx.clientSubscriptionId,
      providerTransactionId: ctx.transactionId,
      providerTransactionStatus: ctx.providerTransactionStatus,
      providerSubscriptionState: providerInstance.providerSubscriptionState,
      homeStationId: providerInstance.homeStationId,
      purchasePriceMinor: ctx.expectedAmountMinor,
      purchasedAt: providerInstance.purchasedAt,
      activeFrom: providerInstance.activeFrom,
      activeTo: providerInstance.activeTo,
      providerObservedAt: ctx.managedProviderObservedAt,
      requiredAdapterId: MANAGED_SALE_COMPATIBILITY.adapterId,
      requiredContractVersion: MANAGED_SALE_COMPATIBILITY.contractVersion,
      requiredCapabilityDigest: MANAGED_SALE_COMPATIBILITY.capabilityDigest,
      expectedMappingId: binding.mappingId,
      expectedMappingRevision: binding.mappingRevision,
      expectedSubscriptionTypeId: binding.subscriptionTypeId,
      expectedPublicationId: binding.publicationId,
      expectedPolicyVersion: binding.policyVersion,
      expectedPolicyDigest: binding.policyDigest,
      expectedFenceId: binding.fenceId,
      expectedFenceRevision: binding.fenceRevision,
      expectedFenceDigest: binding.fenceDigest,
      expectedProjectorReconciliationDigest: binding.projectorReconciliationDigest,
      expectedReleaseProgramId: binding.releaseProgramId,
      expectedReleaseProgramRevision: binding.releaseProgramRevision,
      expectedReleasePhaseId: binding.releasePhaseId,
    },
  );
  return request || managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_SALE_BINDING_NOT_CONFIGURED");
}

if (ctx.step === "managed_sale_binding_confirm") {
  const body = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
  const bound = isOk(msg.statusCode)
    && body?.schemaVersion === 1
    && body?.state === "BOUND"
    && body?.clientSubscriptionId === ctx.clientSubscriptionId
    && toStr(body?.subscriptionInstanceId);
  if (!bound) {
    const code = toStr(body?.error?.code)
      || toStr(body?.code)
      || "MANAGED_SUBSCRIPTION_INSTANCE_BINDING_UNAVAILABLE";
    return managedBindingPending(ctx, code);
  }
  const nowIso = new Date().toISOString();
  const providerInstance = ctx.managedProviderInstance || {};
  ctx.step = "managed_sale_projection_start";
  ctx.managedSaleProjection = {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    response: {
      ok: true,
      paid: true,
      status: "PAID",
      managedBindingState: "BOUND",
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      updatedAt: nowIso,
    },
    set: {
        status: "PAID",
        paidAt: toStr(ctx.saleRecord?.paidAt) || toStr(providerInstance.purchasedAt) || nowIso,
        lastCheckedAt: nowIso,
        updatedAt: nowIso,
        managedBindingState: "BOUND",
        managedBindingErrorCode: null,
        subscriptionInstanceId: body.subscriptionInstanceId,
        clientSubscriptionId: ctx.clientSubscriptionId,
        managedPolicyVersion: Number(body.policyVersion),
    },
  };
  delete ctx.token;
  delete ctx.vivaTokenRequestBody;
  delete ctx.providerHeaders;
  delete ctx.providerPayload;
  const atomicMsg = Object.assign({}, msg, { _summerSubscriptionCtx: ctx, payload: null });
  delete atomicMsg.headers;
  delete atomicMsg.url;
  delete atomicMsg.method;
  delete atomicMsg.req;
  delete atomicMsg.res;
  delete atomicMsg.statusCode;
  return [null, null, null, null, atomicMsg];
}

return fail(500, "Unsupported summer subscription step", {
  step: ctx.step,
  action: ctx.action,
});

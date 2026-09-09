import { parseVivaTimestamp, matchesVivaPaymentDeadline, buildVivaRefundProof, assertVivaRefundProof } from './vivaHistoricalEvidence.mjs';

// This factory is also embedded in Node-RED. Keep the financial/state contract
// identical in the offline preparation and the runtime settlement path.
export function createAnnualSubscriptionHistory({ parseVivaTimestamp, matchesVivaPaymentDeadline, buildVivaRefundProof }) {
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

export const annualHistory = createAnnualSubscriptionHistory({ parseVivaTimestamp, matchesVivaPaymentDeadline, buildVivaRefundProof });
export function annualHistoryRuntimeSource() {
  return '// BEGIN generated annualSubscriptionHistory\n'
    + [parseVivaTimestamp, matchesVivaPaymentDeadline, assertVivaRefundProof, buildVivaRefundProof, createAnnualSubscriptionHistory].map(f => f.toString()).join('\n')
    + '\nconst annualHistory = createAnnualSubscriptionHistory({ parseVivaTimestamp, matchesVivaPaymentDeadline, buildVivaRefundProof });\n'
    + '// END generated annualSubscriptionHistory\n';
}

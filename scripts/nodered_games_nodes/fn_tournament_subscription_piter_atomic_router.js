// BEGIN generated annualSubscriptionHistoryRouter
function runAnnualHistory({ msg, ctx, annualHistory, ledgerFind, ledgerUpdate, saleUpdate, fail, response }) {
  if (!String(ctx.step || '').startsWith('annual_history_')) return undefined;
  const rejected = code => fail(503, 'История годовой подписки требует сверки', code);
  const oneLedger = () => {
    const list = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
    const matches = list.filter(x => x?._id === `inventory:${ctx.inventoryId}`);
    if (matches.length !== 1 || !annualHistory.validate(matches[0])
      || matches[0].counterKey !== ctx.counterKey) throw Error('LEDGER_INVALID');
    return matches[0];
  };
  const findRow = (projection, step) => {
    ctx.step = step; ctx.historyProjection = projection;
    msg.payload = { _id: projection.rowId };
    return [msg, null, null, null, null];
  };
  const exactFilter = doc => ({ _id: doc._id, $expr: { $eq: ['$$ROOT', { $literal: doc }] } });
  const providerRead = () => {
    ctx.step = 'annual_history_instances';
    msg.method = 'GET';
    msg.url = `https://api.vivacrm.ru/api/v1/clients/${encodeURIComponent(ctx.historyWatch.fact.clientId)}/subscriptions?includeFinished=true&size=200&page=${ctx.historyInstancePage}`;
    msg.headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };
    msg.httpRequestTimeout = ctx.httpRequestTimeoutMs; msg.payload = '';
    return [null, null, null, null, msg];
  };
  const transactionRead = () => {
    ctx.step = 'annual_history_transaction_readback';
    msg.method = 'GET'; msg.url = `https://api.vivacrm.ru/api/v1/transactions/${encodeURIComponent(ctx.transactionId)}`;
    msg.headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };
    msg.httpRequestTimeout = ctx.httpRequestTimeoutMs; msg.payload = '';
    return [null, null, null, null, msg];
  };
  const startProjection = ledger => {
    const settlement = annualHistory.pendingProjection(ledger);
    if (!settlement) return ctx.reconcile === true ? [null, null, null, null, null]
      : response(200, { ok: true, status: annualHistory.current(ledger).get(ctx.transactionId)?.state || 'PAYMENT_PENDING' });
    ctx.historySettlementId = settlement.id;
    ctx.historyWatch = ledger.history.entries.find(e => e.transactionId === settlement.transactionId);
    return findRow(settlement.projection, 'annual_history_projection_find');
  };
  const rowMatches = row => {
    const original = ctx.historyWatch?.localPreimage;
    return original && row && ['_id', 'inventoryId', 'counterKey', 'paymentRef', 'transactionId',
      'productId', 'amountMinor', 'providerProductCostMinor', 'discountMinor', 'clientId', 'clientPhone', 'expiresAt']
      .every(k => annualHistory.stable(row[k]) === annualHistory.stable(original[k]))
      && !row.requestFingerprint;
  };
  const projectionMatches = row => rowMatches(row) && Object.entries(ctx.historyProjection.fields)
    .every(([k,v]) => annualHistory.stable(row[k]) === annualHistory.stable(v));
  try {
    if (ctx.step === 'annual_history_begin') return ledgerFind(ctx, 'annual_history_attempt');
    if (ctx.step === 'annual_history_attempt') {
      const ledger = oneLedger();
      if (annualHistory.pendingProjection(ledger)) return startProjection(ledger);
      const watch = ledger.history.entries.find(e => e.transactionId === ctx.transactionId);
      if (!watch || watch.localRowId !== (ctx.annualHistoryRowId || null)
        || watch.paymentRef !== (ctx.paymentRef || null) || watch.fact.productId !== ctx.productId || !ctx.token) return rejected('ANNUAL_HISTORY_WATCH_MISMATCH');
      const history = JSON.parse(JSON.stringify(ledger.history));
      ctx.historyAttemptAt = new Date().toISOString();
      history.entries.find(e => e.transactionId === ctx.transactionId).lastAttemptAt = ctx.historyAttemptAt;
      ctx.step = 'annual_history_attempt_ack';
      return ledgerUpdate(ctx, exactFilter(ledger), { $set: { history }, $inc: { revision: 1 } }, { upsert: false });
    }
    if (ctx.step === 'annual_history_attempt_ack') return ledgerFind(ctx, 'annual_history_attempt_readback');
    if (ctx.step === 'annual_history_attempt_readback') {
      const ledger = oneLedger(), watch = ledger.history.entries.find(e => e.transactionId === ctx.transactionId);
      if (watch?.lastAttemptAt !== ctx.historyAttemptAt) return rejected('ANNUAL_HISTORY_ATTEMPT_NOT_PROVEN');
      return transactionRead();
    }
    if (ctx.step === 'annual_history_transaction_readback') {
      if (!(msg.statusCode >= 200 && msg.statusCode < 300)) return rejected('ANNUAL_HISTORY_TRANSACTION_UNAVAILABLE');
      ctx.annualHistoryTransaction = msg.payload; ctx.historyObservedAt = new Date().toISOString();
      return ledgerFind(ctx, 'annual_history_watch');
    }
    if (['annual_history_transaction', 'annual_history_resume'].includes(ctx.step)) {
      ctx.historyObservedAt = new Date().toISOString();
      return ledgerFind(ctx, ctx.step === 'annual_history_resume' ? 'annual_history_recover' : 'annual_history_watch');
    }
    if (ctx.step === 'annual_history_recover') return startProjection(oneLedger());
    if (ctx.step === 'annual_history_watch') {
      const ledger = oneLedger();
      if (annualHistory.pendingProjection(ledger)) return startProjection(ledger);
      const watch = ledger.history.entries.find(e => e.transactionId === ctx.transactionId);
      if (!watch || watch.localRowId !== (ctx.annualHistoryRowId || null)
        || watch.paymentRef !== (ctx.paymentRef || null)
        || watch.fact.productId !== ctx.productId || !ctx.token) return rejected('ANNUAL_HISTORY_WATCH_MISMATCH');
      ctx.historyWatch = watch;
      if (ctx.annualHistoryTransaction?.status === 'UNPAID') {
        ctx.historySubscriptions = [];
        return ledgerFind(ctx, 'annual_history_settle');
      }
      ctx.historySubscriptions = []; ctx.historyInstancePage = 0;
      return providerRead();
    }
    if (ctx.step === 'annual_history_instances') {
      const p = msg.payload;
      if (!(msg.statusCode >= 200 && msg.statusCode < 300) || !Array.isArray(p?.content)
        || p.number !== ctx.historyInstancePage || !Number.isSafeInteger(p.totalPages) || p.totalPages < 0
        || p.totalPages > 50 || !Number.isSafeInteger(p.totalElements) || p.totalElements < 0
        || p.numberOfElements !== p.content.length || p.last !== (p.number >= p.totalPages - 1)
        || (ctx.historyInstancePage > 0 && (p.totalPages !== ctx.historyInstancePages || p.totalElements !== ctx.historyInstanceTotal))) {
        return rejected('ANNUAL_HISTORY_INSTANCE_SNAPSHOT_INCOMPLETE');
      }
      ctx.historyInstancePages = p.totalPages; ctx.historyInstanceTotal = p.totalElements;
      ctx.historySubscriptions.push(...p.content);
      if (!p.last) { ctx.historyInstancePage++; return providerRead(); }
      if (ctx.historySubscriptions.length !== p.totalElements) return rejected('ANNUAL_HISTORY_INSTANCE_COUNT_MISMATCH');
      return ledgerFind(ctx, 'annual_history_settle');
    }
    if (ctx.step === 'annual_history_settle') {
      const ledger = oneLedger();
      if (annualHistory.pendingProjection(ledger)) return startProjection(ledger);
      const watch = ledger.history.entries.find(e => e.transactionId === ctx.transactionId);
      if (!watch || annualHistory.stable(watch) !== annualHistory.stable(ctx.historyWatch)
        || Date.now() - Date.parse(ctx.historyObservedAt) > 300_000) return rejected('ANNUAL_HISTORY_OBSERVATION_DRIFT');
      const fact = annualHistory.observe(ctx.annualHistoryTransaction, { productId: ctx.productId,
        subscriptions: ctx.historySubscriptions, clientId: watch.fact.clientId, localRow: watch.localPreimage });
      const next = annualHistory.settle(ledger, fact, ctx.historyObservedAt);
      ctx.historyExpected = next; ctx.step = 'annual_history_settlement_ack';
      return ledgerUpdate(ctx, exactFilter(ledger), { $set: Object.fromEntries(Object.entries(next).filter(([k]) => k !== '_id')) }, { upsert: false });
    }
    if (ctx.step === 'annual_history_settlement_ack') return ledgerFind(ctx, 'annual_history_settlement_readback');
    if (ctx.step === 'annual_history_settlement_readback') {
      const ledger = oneLedger();
      const expected = ctx.historyExpected;
      const wanted = expected.history.entries.find(e => e.transactionId === ctx.transactionId);
      const actual = ledger.history.entries.find(e => e.transactionId === ctx.transactionId);
      if (!actual || actual.lastCheckedAt < wanted.lastCheckedAt
        || !expected.history.settlements.every(s => ledger.history.settlements.some(x => x.id === s.id
          && annualHistory.stable(x.fact) === annualHistory.stable(s.fact)))) return rejected('ANNUAL_HISTORY_SETTLEMENT_NOT_PROVEN');
      return startProjection(ledger);
    }
    if (ctx.step === 'annual_history_projection_find') {
      const list = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
      if (list.length !== 1 || !rowMatches(list[0])) return rejected('ANNUAL_HISTORY_LOCAL_PREIMAGE_DRIFT');
      const row = list[0];
      if (projectionMatches(row)) return ledgerFind(ctx, 'annual_history_projection_complete');
      if (row.status === 'REFUNDED' && ctx.historyProjection.fields.status !== 'REFUNDED') return rejected('ANNUAL_HISTORY_REFUND_CONFLICT');
      ctx.step = 'annual_history_projection_ack';
      return saleUpdate(ctx, exactFilter(row), { $set: ctx.historyProjection.fields }, { upsert: false });
    }
    if (ctx.step === 'annual_history_projection_ack') return findRow(ctx.historyProjection, 'annual_history_projection_readback');
    if (ctx.step === 'annual_history_projection_readback') {
      const list = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
      if (list.length !== 1 || !projectionMatches(list[0])) return rejected('ANNUAL_HISTORY_PROJECTION_NOT_PROVEN');
      return ledgerFind(ctx, 'annual_history_projection_complete');
    }
    if (ctx.step === 'annual_history_projection_complete') {
      const ledger = oneLedger();
      const settlement = ledger.history.settlements.find(s => s.id === ctx.historySettlementId);
      if (!settlement || annualHistory.stable(settlement.projection?.fields) !== annualHistory.stable(ctx.historyProjection.fields)) return rejected('ANNUAL_HISTORY_PROJECTION_DRIFT');
      if (settlement.projection.state === 'DONE') return startProjection(ledger);
      const history = JSON.parse(JSON.stringify(ledger.history));
      history.settlements.find(s => s.id === settlement.id).projection.state = 'DONE';
      ctx.step = 'annual_history_projection_done_ack';
      return ledgerUpdate(ctx, exactFilter(ledger), { $set: { history, updatedAt: new Date().toISOString() }, $inc: { revision: 1 } }, { upsert: false });
    }
    if (ctx.step === 'annual_history_projection_done_ack') return ledgerFind(ctx, 'annual_history_recover');
    return rejected('ANNUAL_HISTORY_STEP_UNKNOWN');
  } catch { return rejected('ANNUAL_HISTORY_PROOF_INVALID'); }
}
// END generated annualSubscriptionHistoryRouter
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
const PITER_COUNTER_KEY = "piter_friendship";
const PITER_INVENTORY_ID = "piter_friendship_12m_2026_v1";
const HUB_COUNTER_KEY = "network_friendship";
const HUB_INVENTORY_ID = "network_friendship_12m_2026_v1";

const toStr = (value) => value == null ? null : (String(value).trim() || null);
const UPDATE_ACK_KEYS = ["acknowledged", "matchedCount", "modifiedCount", "upsertedCount", "upsertedId"];
const hasExactAckKeys = (value) => (
  value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\n") === [...UPDATE_ACK_KEYS].sort().join("\n")
);
const exactUpdateAck = (value) => Boolean(
  hasExactAckKeys(value)
  && value.acknowledged === true
  && Number.isInteger(value.matchedCount) && value.matchedCount === 1
  && Number.isInteger(value.modifiedCount) && value.modifiedCount === 1
  && Number.isInteger(value.upsertedCount) && value.upsertedCount === 0
  && (value.upsertedId === null || value.upsertedId === undefined)
);
const exactUpsertAck = (value) => Boolean(
  hasExactAckKeys(value)
  && value.acknowledged === true
  && Number.isInteger(value.matchedCount) && value.matchedCount === 0
  && Number.isInteger(value.modifiedCount) && value.modifiedCount === 0
  && Number.isInteger(value.upsertedCount) && value.upsertedCount === 1
  && value.upsertedId !== null && value.upsertedId !== undefined
);
const rows = (value) => Array.isArray(value) ? value : (value ? [value] : []);
const isHub = (ctx) => ctx?.counterKey === HUB_COUNTER_KEY && ctx?.inventoryId === HUB_INVENTORY_ID;
const isPiter = (ctx) => ctx?.counterKey === PITER_COUNTER_KEY && ctx?.inventoryId === PITER_INVENTORY_ID;
const ledgerId = (ctx) => `inventory:${ctx.inventoryId}`;
const saleId = (ctx) => `${isPiter(ctx) ? "piter" : "hub"}-sale:${ctx.inventoryId}:${ctx.paymentRef}`;
const dispatchGeneration = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const generationFilter = (value) => dispatchGeneration(value) === 0 ? { $in: [null, 0] } : dispatchGeneration(value);
const fail = (status, error, code, details = null) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: Object.assign({ code }, details || {}) };
  return [null, null, null, msg, null];
};
const response = (status, payload) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = payload;
  return [null, null, null, msg, null];
};
const ledgerFind = (ctx, step = "piter_ledger_find") => {
  ctx.step = step;
  msg._summerSubscriptionCtx = ctx;
  msg.payload = { _id: ledgerId(ctx) };
  return [msg, null, null, null, null];
};
const saleFind = (ctx, step) => {
  ctx.step = step;
  msg._summerSubscriptionCtx = ctx;
  msg.payload = { _id: saleId(ctx) };
  return [msg, null, null, null, null];
};
const ledgerUpdate = (ctx, filter, update, options = {}) => {
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [filter, update, Object.assign({ upsert: false }, options)];
  return [null, msg, null, null, null];
};
const saleUpdate = (ctx, filter, update, options = {}) => {
  // Mongo rejects a field mentioned in both $setOnInsert and another operator,
  // even for updates of an existing document. Mutable projection fields belong
  // to the explicit operator; preserve only immutable insert defaults here.
  if (update.$setOnInsert) {
    const mutablePaths = Object.entries(update)
      .filter(([operator]) => operator !== "$setOnInsert")
      .flatMap(([, fields]) => Object.keys(fields));
    update.$setOnInsert = Object.fromEntries(Object.entries(update.$setOnInsert)
      .filter(([key]) => !mutablePaths.some((field) => (
        field === key || field.startsWith(`${key}.`) || key.startsWith(`${field}.`)
      ))));
  }
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [filter, update, Object.assign({ upsert: true }, options)];
  return [null, null, msg, null, null];
};
const provider = (ctx) => {
  msg._summerSubscriptionCtx = ctx;
  msg.method = ctx.providerMethod;
  msg.url = ctx.providerUrl;
  msg.headers = ctx.providerHeaders;
  msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
  msg.payload = ctx.providerPayload;
  return [null, null, null, null, msg];
};
const fingerprint = (ctx) => [
  toStr(ctx.inventoryId), toStr(ctx.counterKey), toStr(ctx.paymentRef),
  toStr(ctx.clientPhone), toStr(ctx.clientId),
].join("\n");
const intentFingerprint = (ctx) => [
  toStr(ctx.inventoryId), toStr(ctx.counterKey), toStr(ctx.clientPhone), toStr(ctx.clientId),
].join("\n");
const ACTIVE_RESERVATION_STATES = ["CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN"];
const ledgerIsStructurallyValid = (ledger, totalLimit, ctx) => {
  if (ledger?.schemaVersion === 3) return annualHistory.validate(ledger)
    && ledger.inventoryId === ctx.inventoryId && ledger.counterKey === ctx.counterKey;
  if (!(ledger && typeof ledger.ready === "boolean"
    && (ledger.schemaVersion === 1 || (isPiter(ctx) && [2, 3].includes(ledger.schemaVersion)))
    && Number.isInteger(ledger.revision) && ledger.revision >= 0
    && Number.isInteger(ledger.paidCount) && ledger.paidCount >= 0
    && Number.isInteger(ledger.reservedCount) && ledger.reservedCount >= 0
    && Number.isInteger(ledger.takenCount) && ledger.takenCount >= 0
    && ledger.takenCount === ledger.paidCount + ledger.reservedCount
    && ledger.takenCount <= totalLimit
    && /^[a-f0-9]{64}$/.test(toStr(ledger.baselineDigest) || "")
    && Number.isFinite(Date.parse(toStr(ledger.baselineCapturedAt) || ""))
    && Array.isArray(ledger.legacyPaymentRefs)
    && Array.isArray(ledger.reservations))) return false;
  const legacyRefs = ledger.legacyPaymentRefs.map(toStr);
  const quotaAdjustment = [2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : 0;
  if ((ledger.schemaVersion === 1 && Object.prototype.hasOwnProperty.call(ledger, "quotaAdjustment"))
    || !Number.isSafeInteger(quotaAdjustment) || quotaAdjustment < 0
    || ([2, 3].includes(ledger.schemaVersion) && ![50, 52].includes(legacyRefs.length + quotaAdjustment))
    || ledger.takenCount + quotaAdjustment > totalLimit) return false;
  const reservationRefs = ledger.reservations.map((item) => toStr(item?.paymentRef));
  if (legacyRefs.some((item) => !item) || reservationRefs.some((item) => !item)) return false;
  if (ledger.reservations.some((item) => ![
    "CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN", "PAID", "FAILED",
  ].includes(item?.state))) return false;
  if (new Set(legacyRefs).size !== legacyRefs.length
    || new Set(reservationRefs).size !== reservationRefs.length
    || reservationRefs.some((item) => legacyRefs.includes(item))) return false;
  const paidReservations = ledger.reservations.filter((item) => item?.state === "PAID").length;
  const activeReservations = ledger.reservations.filter((item) => ACTIVE_RESERVATION_STATES.includes(item?.state)).length;
  const activeIntentFingerprints = ledger.reservations
    .filter((item) => ACTIVE_RESERVATION_STATES.includes(item?.state))
    .map((item) => toStr(item?.intentFingerprint));
  const transactionIds = ledger.reservations.map((item) => toStr(item?.transactionId)).filter(Boolean);
  const baseValid = ledger.paidCount === legacyRefs.length + paidReservations
    && ledger.reservedCount === activeReservations
    && activeIntentFingerprints.every(Boolean)
    && new Set(activeIntentFingerprints).size === activeIntentFingerprints.length
    && new Set(transactionIds).size === transactionIds.length;
  if (!baseValid || !isHub(ctx)) return baseValid;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toStr(ledger.dailyDate) || "")
    || !Number.isInteger(ledger.dailyBaselinePaidCount) || ledger.dailyBaselinePaidCount < 0
    || !Number.isInteger(ledger.dailyPaidCount) || ledger.dailyPaidCount < 0
    || !Number.isInteger(ledger.dailyReservedCount) || ledger.dailyReservedCount < 0
    || ledger.dailyPaidCount + ledger.dailyReservedCount > (ledger.dailyDate < ctx.dailyDropDate
      ? totalLimit : Math.max(0, Number(ctx.dailyLimit) || 0))) {
    return false;
  }
  const dailyPaidReservations = ledger.reservations.filter((item) => (
    item?.state === "PAID" && item?.dailyDate === ledger.dailyDate
  )).length;
  const dailyActiveReservations = ledger.reservations.filter((item) => (
    ACTIVE_RESERVATION_STATES.includes(item?.state) && item?.dailyDate === ledger.dailyDate
  )).length;
  return ledger.dailyPaidCount === ledger.dailyBaselinePaidCount + dailyPaidReservations
    && ledger.dailyReservedCount === dailyActiveReservations;
};
const ledgerIsPurchaseReady = (ledger, totalLimit, ctx) => (
  ledger?.ready === true && ledgerIsStructurallyValid(ledger, totalLimit, ctx)
    && (ledger.schemaVersion !== 3 || annualHistory.admissionReady(ledger))
);
const saleInsert = (ctx, nowIso) => ({
      ...(ctx.ledgerSchemaVersion === 3 ? { inventoryLedgerSchemaVersion: 3 } : {}),
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: ctx.clientPhone,
      clientId: ctx.clientId || null,
      studioId: toStr(ctx.studioId),
      batchIndex: ctx.batchIndex,
      batchSize: ctx.batchSize,
      productId: ctx.productId,
      productName: ctx.productName,
      amountMinor: ctx.priceMinor,
      providerProductCostMinor: ctx.productCostMinor,
      discountMinor: ctx.discountMinor,
      unlimited: ctx.unlimited === true,
      releasePhase: toStr(ctx.releasePhase),
      releaseStartDate: toStr(ctx.releaseStartDate),
      totalLimit: Number.isInteger(ctx.totalLimit) ? ctx.totalLimit : null,
      launchLimit: Math.max(0, Math.floor(Number(ctx.launchLimit) || 0)),
      dailyLimit: Math.max(0, Math.floor(Number(ctx.dailyLimit) || 0)),
      dailyDropDate: toStr(ctx.dailyDropDate),
      saleType: toStr(ctx.saleType),
      planKey: toStr(ctx.planKey),
      campaignKey: toStr(ctx.campaignKey),
      trainerQrCode: toStr(ctx.trainerQrCode),
      referralToken: toStr(ctx.referralToken),
      referralVisitId: toStr(ctx.referralVisitId),
      productType: ctx.productType || "SUBSCRIPTION",
      providerActivationDays: Number.isInteger(ctx.providerActivationDays) ? ctx.providerActivationDays : null,
      providerAutoActivationDate: toStr(ctx.providerAutoActivationDate),
      providerLifecycleMode: toStr(ctx.providerLifecycleMode),
      activationNotBeforeDate: toStr(ctx.activationNotBeforeDate),
      providerValidityDays: Number.isInteger(ctx.providerValidityDays) ? ctx.providerValidityDays : null,
      providerVisits: Number.isInteger(ctx.providerVisits) ? ctx.providerVisits : null,
      managedSaleBinding: ctx.managedSaleBinding && typeof ctx.managedSaleBinding === "object"
        ? { ...ctx.managedSaleBinding }
        : null,
      managedSaleReadinessCheckedAt: toStr(ctx.managedSaleReadinessCheckedAt),
      managedSaleProviderScope: ctx.managedSaleProviderScope && typeof ctx.managedSaleProviderScope === "object"
        ? { ...ctx.managedSaleProviderScope }
        : null,
      hubLk1Sale: normalizeFrozenHubSale(ctx.hubLk1Sale),
      managedBindingState: isHub(ctx) ? "AWAITING_PAYMENT" : null,
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
      providerAttemptedAt: toStr(ctx.providerAttemptedAt),
      successUrl: ctx.successUrl || null,
      failUrl: ctx.failUrl || null,
      createdAt: ctx.reservationCreatedAt || nowIso,
});
const projectSale = (ctx, result, nextStep) => {
  const nowIso = new Date().toISOString();
  ctx.step = nextStep;
  const filter = {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  };
  if (nextStep === "piter_provider_sale_ack") {
    filter.status = "DISPATCHING";
    filter.providerAttemptedAt = toStr(ctx.providerAttemptedAt);
    filter.dispatchGeneration = dispatchGeneration(ctx.dispatchGeneration);
  }
  return saleUpdate(ctx, filter, {
    $setOnInsert: ctx.saleRecord || saleInsert(ctx, nowIso),
    $set: {
      status: result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN",
      transactionId: result.transactionId || null,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor ?? null,
      providerAttemptedAt: toStr(ctx.providerAttemptedAt),
      updatedAt: nowIso,
    },
  }, nextStep === "piter_provider_sale_ack" ? { upsert: false } : {});
};
const persistClaimedSale = (ctx, nextStep = "piter_claimed_sale_ack") => {
  const nowIso = new Date().toISOString();
  const generation = dispatchGeneration(ctx.dispatchGeneration);
  ctx.step = nextStep;
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
    $or: [
      { status: { $exists: false } },
      { status: null },
      { status: "CLAIMED", dispatchGeneration: generationFilter(generation) },
      { status: "DISPATCH_REPAIRING", dispatchGeneration: generation },
    ],
  }, {
    $setOnInsert: ctx.saleRecord || saleInsert(ctx, nowIso),
    $set: {
      status: "CLAIMED",
      dispatchGeneration: generation,
      providerAttemptedAt: null,
      updatedAt: nowIso,
    },
    $unset: { dispatchRepairStartedAt: "", repairProviderAttemptedAt: "" },
  });
};
const saleProjectionMatches = (record, ctx, expectedStatus, result = {}) => Boolean(
  record
  && record._id === saleId(ctx)
  && record.requestFingerprint === ctx.requestFingerprint
  && record.status === expectedStatus
  && record.amountMinor === (ctx.expectedAmountMinor ?? ctx.priceMinor)
  && (ctx.ledgerSchemaVersion !== 3 || record.inventoryLedgerSchemaVersion === 3)
  && toStr(record.providerLifecycleMode) === toStr(ctx.providerLifecycleMode)
  && (!isHub(ctx) || (
    (record.hubLk1Sale == null || normalizeFrozenHubSale(record.hubLk1Sale) !== null)
    && (ctx.hubLk1Sale == null || normalizeFrozenHubSale(ctx.hubLk1Sale) !== null)
    && JSON.stringify(normalizeFrozenHubSale(record.hubLk1Sale)) === JSON.stringify(normalizeFrozenHubSale(ctx.hubLk1Sale))
  ))
  && (expectedStatus !== "PAYMENT_PENDING" || (toStr(result.transactionId) && toStr(result.paymentUrl)))
  && (result.transactionId == null || record.transactionId === result.transactionId)
  && (result.paymentUrl == null || record.paymentUrl === result.paymentUrl)
  && (result.providerAttemptedAt == null || record.providerAttemptedAt === result.providerAttemptedAt)
);
const finishProviderProjection = () => {
  const result = ctx.providerResult || {};
  if (!result.ok) return response(503, result.response);
  return response(ctx.saleResponseStatus || 201, result.response);
};
const finishConfirmProjection = () => {
  if (ctx.confirmResult?.reconcile === true) return [null, null, null, null, null];
  return response(200, ctx.confirmResult?.response || { ok: true, status: ctx.confirmResult?.nextStatus });
};
const quotaCustodyFilter = (ctx) => ([2, 3].includes(ctx.ledgerSchemaVersion)
  && (!(isPiter(ctx) || ctx.ledgerSchemaVersion === 3) || !Number.isSafeInteger(ctx.ledgerQuotaAdjustment) || ctx.ledgerQuotaAdjustment < 0)
  ? null : {
  schemaVersion: ctx.ledgerSchemaVersion ?? 1,
  quotaAdjustment: [2, 3].includes(ctx.ledgerSchemaVersion)
    ? ctx.ledgerQuotaAdjustment : { $exists: false },
});
const ledgerQuotaMatches = (ledger, ctx) => ledger?.schemaVersion === (ctx.ledgerSchemaVersion ?? 1)
  && ([2, 3].includes(ctx.ledgerSchemaVersion)
    ? (isPiter(ctx) || ctx.ledgerSchemaVersion === 3) && ledger.quotaAdjustment === ctx.ledgerQuotaAdjustment
    : !Object.prototype.hasOwnProperty.call(ledger || {}, "quotaAdjustment"));
const dispatchClaim = (ctx) => {
  const custody = quotaCustodyFilter(ctx);
  if (!custody) return fail(503, "Состояние квоты изменилось", "PITER_ATOMIC_QUOTA_CUSTODY_INVALID");
  ctx.step = "piter_dispatch_ack";
  const nowIso = new Date().toISOString();
  const previousGeneration = dispatchGeneration(ctx.dispatchGeneration);
  const nextGeneration = previousGeneration + 1;
  ctx.dispatchGeneration = nextGeneration;
  ctx.providerAttemptedAt = nowIso;
  return ledgerUpdate(ctx, {
    _id: ledgerId(ctx), ready: true,
    ...custody,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      state: "CLAIMED",
      dispatchGeneration: generationFilter(previousGeneration),
    } },
  }, {
    $set: {
      "reservations.$.state": "DISPATCHING",
      "reservations.$.dispatchGeneration": nextGeneration,
      "reservations.$.updatedAt": nowIso,
      "reservations.$.providerAttemptedAt": nowIso,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
};
const resetDispatchAfterFence = (ctx) => {
  if (ctx.ledgerSchemaVersion === undefined) return ledgerFind(ctx, "piter_dispatch_repair_quota_find");
  const custody = quotaCustodyFilter(ctx);
  if (!custody) return fail(503, "Состояние квоты изменилось", "PITER_ATOMIC_QUOTA_CUSTODY_INVALID");
  ctx.step = "piter_dispatch_repair_ack";
  const nowIso = new Date().toISOString();
  return ledgerUpdate(ctx, {
    _id: ledgerId(ctx),
    ready: true,
    ...custody,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      state: "DISPATCHING",
      providerAttemptedAt: ctx.providerAttemptedAt,
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
    } },
  }, {
    $set: {
      "reservations.$.state": "CLAIMED",
      "reservations.$.updatedAt": nowIso,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
};

const ctx = msg._summerSubscriptionCtx;
if (!ctx || (!isPiter(ctx) && !isHub(ctx))) {
  return fail(500, "Regional atomic sale context is missing", "REGIONAL_ATOMIC_CONTEXT_MISSING");
}

const historyResult = runAnnualHistory({ msg, ctx, annualHistory, ledgerFind, ledgerUpdate, saleUpdate, fail, response });
if (historyResult !== undefined) return historyResult;

// Keep the live baseline's HUB admission closed, including stale server-side
// purchase continuations. Do not gate provider results, confirmations or the
// durable dispatch-repair/projection paths for previously accepted payments.
if (ctx.counterKey === "network_friendship" && [
  "piter_reserve_start", "piter_ledger_find", "hub_daily_reset_ack", "piter_reserve_ack",
  "piter_dispatch_claim", "piter_claimed_sale_ack", "piter_claimed_sale_readback",
  "piter_dispatch_ack", "piter_dispatch_sale_ack", "piter_dispatch_sale_readback",
].includes(ctx.step) && (!hubLk1Sale
  || JSON.stringify(normalizeFrozenHubSale(ctx.hubLk1Sale)) !== JSON.stringify(hubLk1Sale))) {
  return fail(503, "Новые продажи ХАБ не включены в этот выпуск", "HUB_NEW_SALES_RELEASE_DISABLED");
}

if (ctx.step === "piter_reserve_start") return ledgerFind(ctx);

if (ctx.step === "piter_ledger_find") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit, ctx)) {
    return fail(503, "Продажа Питера ещё не активирована", "PITER_ATOMIC_LEDGER_NOT_READY");
  }
  ctx.ledgerSchemaVersion = ledger.schemaVersion;
  ctx.ledgerQuotaAdjustment = [2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : null;
  if (isHub(ctx) && ledger.dailyDate > ctx.dailyDropDate) {
    return fail(409, "Запрос относится к уже закрытому дневному окну", "HUB_DAILY_CAP_STALE_REQUEST", {
      ledgerDailyDate: ledger.dailyDate,
      requestDailyDate: ctx.dailyDropDate,
    });
  }
  if (isHub(ctx) && ledger.dailyDate < ctx.dailyDropDate) {
    ctx.step = "hub_daily_reset_ack";
    return ledgerUpdate(ctx, {
      _id: ledgerId(ctx), ready: true, revision: ledger.revision,
      schemaVersion: ledger.schemaVersion, quotaAdjustment: ledger.schemaVersion === 3 ? 0 : { $exists: false },
      dailyDate: ledger.dailyDate,
      dailyPaidCount: ledger.dailyPaidCount,
      dailyReservedCount: ledger.dailyReservedCount,
    }, {
      $set: {
        dailyDate: ctx.dailyDropDate,
        dailyBaselinePaidCount: ledger.schemaVersion === 3 ? annualHistory.counts(ledger, ctx.dailyDropDate).dailyBaselinePaidCount : 0,
        dailyPaidCount: ledger.schemaVersion === 3 ? annualHistory.counts(ledger, ctx.dailyDropDate).dailyPaidCount : 0,
        dailyReservedCount: ledger.schemaVersion === 3 ? annualHistory.counts(ledger, ctx.dailyDropDate).dailyReservedCount : 0,
        updatedAt: new Date().toISOString(),
      },
      $inc: { revision: 1 },
    });
  }
  let requestFingerprint = fingerprint(ctx);
  const currentIntentFingerprint = intentFingerprint(ctx);
  if (ledger.legacyPaymentRefs.includes(ctx.paymentRef)) {
    return fail(409, "paymentRef уже использован до переключения продаж", "PITER_LEGACY_PAYMENT_REF_ALREADY_USED");
  }
  let existing = ledger.reservations.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!existing) {
    existing = ledger.reservations.find((item) => (
      item?.intentFingerprint === currentIntentFingerprint && ACTIVE_RESERVATION_STATES.includes(item?.state)
    ));
    if (existing) {
      ctx.requestedPaymentRef = ctx.paymentRef;
      ctx.paymentRef = existing.paymentRef;
      requestFingerprint = existing.requestFingerprint;
    }
  }
  if (existing) {
    if (isPiter(ctx)) {
      const savedLifecycle = toStr(existing.saleRecord?.providerLifecycleMode);
      if (["CLAIMED", "DISPATCHING"].includes(existing.state) && savedLifecycle !== toStr(ctx.providerLifecycleMode)) {
        return fail(503, "Условия сохранённой продажи изменились", "PITER_FROZEN_LIFECYCLE_DRIFT");
      }
      ctx.providerLifecycleMode = savedLifecycle;
    }
    if (isHub(ctx)) {
      const storedSaleMode = normalizeFrozenHubSale(existing.saleRecord?.hubLk1Sale);
      if (["CLAIMED", "DISPATCHING"].includes(existing.state) && (!storedSaleMode
        || JSON.stringify(storedSaleMode) !== JSON.stringify(normalizeFrozenHubSale(ctx.hubLk1Sale)))) {
        return fail(503, "Замороженные правила продажи ХАБ изменились", "HUB_FROZEN_SALE_MODE_DRIFT");
      }
      ctx.hubLk1Sale = storedSaleMode;
    }
    if (existing.requestFingerprint !== requestFingerprint) {
      return fail(409, "paymentRef уже связан с другой покупкой", "PITER_PAYMENT_REF_CONFLICT");
    }
    if (existing.state === "PAYMENT_PENDING" && existing.paymentUrl) {
      ctx.requestFingerprint = requestFingerprint;
      ctx.clientPhone = existing.clientPhone;
      ctx.clientId = existing.clientId || null;
      ctx.batchIndex = existing.batchIndex;
      ctx.batchSize = existing.batchSize;
      ctx.productId = existing.productId;
      ctx.productName = existing.productName;
      ctx.priceMinor = existing.priceMinor;
      ctx.productCostMinor = existing.providerProductCostMinor;
      ctx.discountMinor = existing.discountMinor;
      ctx.reservationCreatedAt = existing.createdAt;
      ctx.saleRecord = existing.saleRecord;
      ctx.providerResult = {
        ok: true,
        transactionId: existing.transactionId,
        paymentUrl: existing.paymentUrl,
        expiresAt: existing.expiresAt,
        toPayMinor: existing.toPayMinor,
        response: Object.assign({ ok: true, replayed: true }, existing.response || {}, {
        paymentRef: existing.paymentRef,
        transactionId: existing.transactionId,
        paymentUrl: existing.paymentUrl,
        status: "PAYMENT_PENDING",
        }),
      };
      ctx.saleResponseStatus = 200;
      return projectSale(ctx, ctx.providerResult, "piter_replay_sale_ack");
    }
    if (existing.state === "CLAIMED") {
      if (ledger.ready !== true) {
        return fail(503, "Продажа Питера остановлена", "PITER_ATOMIC_LEDGER_NOT_READY");
      }
      const providerLine = Array.isArray(ctx.providerPayload?.products) ? ctx.providerPayload.products[0] : null;
      const frozenProductId = toStr(existing.productId);
      const frozenProviderCostMinor = Math.max(0, Math.round(Number(existing.providerProductCostMinor)));
      if (!providerLine || !frozenProductId || toStr(providerLine.id) !== frozenProductId
        || Math.max(0, Math.round(Number(ctx.providerProductCostMinor))) !== frozenProviderCostMinor
        || !Number.isInteger(existing.priceMinor) || existing.priceMinor <= 0
        || !Number.isInteger(existing.discountMinor) || existing.discountMinor < 0
        || existing.discountMinor !== frozenProviderCostMinor - existing.priceMinor) {
        return fail(503, "Замороженная ценовая партия требует сверки", "PITER_CLAIMED_TIER_DRIFT");
      }
      ctx.requestFingerprint = requestFingerprint;
      ctx.clientPhone = existing.clientPhone;
      ctx.clientId = existing.clientId || null;
      ctx.batchIndex = existing.batchIndex;
      ctx.batchSize = existing.batchSize;
      ctx.productId = frozenProductId;
      ctx.productName = existing.productName;
      ctx.priceMinor = existing.priceMinor;
      ctx.productCostMinor = frozenProviderCostMinor;
      ctx.discountMinor = existing.discountMinor;
      ctx.reservationCreatedAt = existing.createdAt;
      ctx.saleRecord = existing.saleRecord;
      ctx.studioId = toStr(existing.saleRecord?.studioId) || toStr(ctx.studioId);
      ctx.dispatchGeneration = dispatchGeneration(existing.dispatchGeneration);
      ctx.providerAttemptedAt = toStr(existing.providerAttemptedAt);
      providerLine.id = frozenProductId;
      providerLine.discount = existing.discountMinor;
      return persistClaimedSale(ctx);
    }
    if (existing.state === "DISPATCHING") {
      ctx.requestFingerprint = requestFingerprint;
      ctx.clientPhone = existing.clientPhone;
      ctx.clientId = existing.clientId || null;
      ctx.batchIndex = existing.batchIndex;
      ctx.batchSize = existing.batchSize;
      ctx.productId = existing.productId;
      ctx.productName = existing.productName;
      ctx.priceMinor = existing.priceMinor;
      ctx.productCostMinor = existing.providerProductCostMinor;
      ctx.discountMinor = existing.discountMinor;
      ctx.reservationCreatedAt = existing.createdAt;
      ctx.saleRecord = existing.saleRecord;
      ctx.studioId = toStr(existing.saleRecord?.studioId) || toStr(ctx.studioId);
      ctx.dispatchGeneration = dispatchGeneration(existing.dispatchGeneration);
      ctx.providerAttemptedAt = toStr(existing.providerAttemptedAt);
      return saleFind(ctx, "piter_dispatch_repair_sale_find");
    }
    return fail(503, "Предыдущая попытка оплаты требует сверки", "PITER_ACTIVE_PURCHASE_UNRESOLVED", {
      paymentRef: existing.paymentRef,
      status: existing.state, message: "Попытка оплаты уже обрабатывается; повторный запрос в Viva не выполняется.",
    });
  }
  if (!ledgerIsPurchaseReady(ledger, ctx.totalLimit, ctx)) {
    return fail(503, "Продажа Питера остановлена", "PITER_ATOMIC_LEDGER_NOT_READY");
  }
  const quotaTakenCount = ledger.takenCount + ([2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : 0);
  if (quotaTakenCount >= ctx.totalLimit) {
    return fail(409, "Лимит абонементов исчерпан", "PITER_INVENTORY_EXHAUSTED", {
      totalLimit: ctx.totalLimit, takenCount: quotaTakenCount,
    });
  }
  if (isHub(ctx)
    && ledger.dailyPaidCount + ledger.dailyReservedCount >= ctx.dailyLimit) {
    return fail(409, "Дневной лимит подписок исчерпан", "HUB_DAILY_INVENTORY_EXHAUSTED", {
      dailyDate: ledger.dailyDate,
      dailyLimit: ctx.dailyLimit,
      dailyTakenCount: ledger.dailyPaidCount + ledger.dailyReservedCount,
    });
  }
  const tiers = Array.isArray(ctx.tiers) ? ctx.tiers : [];
  const batchSize = Math.max(1, Math.floor(Number(ctx.batchSize) || 100));
  const batchIndex = Math.max(1, Math.min(tiers.length || 1, Math.floor(quotaTakenCount / batchSize) + 1));
  const activeTier = tiers[batchIndex - 1];
  if (!activeTier || !toStr(activeTier.productId) || !Number.isFinite(Number(activeTier.priceMinor))) {
    return fail(503, "Ценовая партия Питера не настроена", "PITER_ATOMIC_TIER_NOT_READY", { batchIndex });
  }
  ctx.batchSize = batchSize;
  ctx.batchIndex = batchIndex;
  ctx.batchRemainingBefore = Math.max(0, batchSize - (quotaTakenCount - (batchIndex - 1) * batchSize));
  const atomicProductId = toStr(activeTier.productId);
  const atomicProviderCostMinor = Math.max(0, Math.round(Number(activeTier.providerProductCostMinor)));
  const validatedProviderCostMinor = Math.max(0, Math.round(Number(ctx.providerProductCostMinor)));
  const providerLine = Array.isArray(ctx.providerPayload?.products) ? ctx.providerPayload.products[0] : null;
  if (!providerLine || toStr(providerLine.id) !== atomicProductId
    || validatedProviderCostMinor !== atomicProviderCostMinor) {
    return fail(503, "Ценовая партия изменилась до резервирования", "PITER_ATOMIC_TIER_DRIFT", { batchIndex });
  }
  ctx.productId = atomicProductId;
  ctx.productName = toStr(activeTier.productName);
  ctx.priceMinor = Math.max(0, Math.round(Number(activeTier.priceMinor)));
  ctx.productCostMinor = atomicProviderCostMinor;
  ctx.discountMinor = ctx.productCostMinor - ctx.priceMinor;
  providerLine.discount = ctx.discountMinor;
  ctx.remainingBefore = Math.max(0, ctx.totalLimit - quotaTakenCount);
  const nowIso = new Date().toISOString();
  ctx.ledgerRevision = ledger.revision;
  ctx.requestFingerprint = requestFingerprint;
  ctx.intentFingerprint = currentIntentFingerprint;
  ctx.saleRecord = saleInsert(ctx, nowIso);
  ctx.step = "piter_reserve_ack";
  const reservation = {
    paymentRef: ctx.paymentRef,
    requestFingerprint,
    intentFingerprint: currentIntentFingerprint,
    state: "CLAIMED",
    clientPhone: ctx.clientPhone,
    clientId: ctx.clientId || null,
    batchIndex: ctx.batchIndex,
    batchSize: ctx.batchSize,
    priceMinor: ctx.priceMinor,
    productId: ctx.productId,
    productName: ctx.productName,
    providerProductCostMinor: ctx.productCostMinor,
    discountMinor: ctx.discountMinor,
    dailyDate: isHub(ctx) ? ctx.dailyDropDate : null,
    dispatchGeneration: 0,
    saleRecord: ctx.saleRecord,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const reserveFilter = {
    _id: ledgerId(ctx), ready: true, revision: ledger.revision,
    takenCount: ledger.takenCount,
    schemaVersion: ledger.schemaVersion,
    quotaAdjustment: [2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : { $exists: false },
    $and: [
      { "reservations.paymentRef": { $ne: ctx.paymentRef } },
      { reservations: { $not: { $elemMatch: {
        intentFingerprint: currentIntentFingerprint, state: { $in: ACTIVE_RESERVATION_STATES },
      } } } },
    ],
  };
  if (isHub(ctx)) {
    reserveFilter.dailyDate = ctx.dailyDropDate;
    reserveFilter.dailyPaidCount = ledger.dailyPaidCount;
    reserveFilter.dailyReservedCount = ledger.dailyReservedCount;
  }
  const reserveInc = { revision: 1, reservedCount: 1, takenCount: 1 };
  if (isHub(ctx)) reserveInc.dailyReservedCount = 1;
  return ledgerUpdate(ctx, reserveFilter, {
    $inc: reserveInc,
    $push: { reservations: reservation },
    $set: { updatedAt: nowIso },
  }, { upsert: false });
}

if (ctx.step === "hub_daily_reset_ack") {
  if (!exactUpdateAck(msg.payload)) {
    ctx.atomicRetryCount = Number(ctx.atomicRetryCount || 0) + 1;
    if (ctx.atomicRetryCount > 3) {
      return fail(409, "Не удалось переключить дневной лимит", "HUB_DAILY_CAP_CAS_CONFLICT");
    }
  }
  return ledgerFind(ctx);
}

if (ctx.step === "piter_reserve_ack") {
  if (!exactUpdateAck(msg.payload)) {
    ctx.atomicRetryCount = Number(ctx.atomicRetryCount || 0) + 1;
    if (ctx.atomicRetryCount > 3) {
      return fail(409, "Не удалось зафиксировать место, повторите попытку", "PITER_CAPACITY_CAS_CONFLICT");
    }
    return ledgerFind(ctx);
  }
  return persistClaimedSale(ctx);
}

if (ctx.step === "piter_dispatch_claim") {
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_claimed_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_claimed_sale_readback");
  }
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_claimed_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "CLAIMED")
    || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(record?.providerAttemptedAt)) {
    return fail(503, "Резервация не подтверждена sale record", "PITER_CLAIMED_SALE_NOT_DURABLE");
  }
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_dispatch_repair_sale_find") {
  const record = rows(msg.payload)[0];
  const generation = dispatchGeneration(ctx.dispatchGeneration);
  const previousGeneration = Math.max(0, generation - 1);
  if (saleProjectionMatches(record, ctx, "DISPATCH_REPAIRING")
    && dispatchGeneration(record?.dispatchGeneration) === generation
    && !toStr(record?.providerAttemptedAt)) {
    return resetDispatchAfterFence(ctx);
  }
  if (!saleProjectionMatches(record, ctx, "CLAIMED")
    || dispatchGeneration(record?.dispatchGeneration) !== previousGeneration
    || toStr(record?.providerAttemptedAt)) {
    return fail(503, "Предыдущая попытка оплаты требует сверки", "PITER_ACTIVE_PURCHASE_UNRESOLVED", {
      paymentRef: ctx.paymentRef,
      status: "DISPATCHING",
    });
  }
  ctx.step = "piter_dispatch_repair_fence_ack";
  const nowIso = new Date().toISOString();
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
    status: "CLAIMED",
    providerAttemptedAt: null,
    dispatchGeneration: generationFilter(previousGeneration),
  }, {
    $set: {
      status: "DISPATCH_REPAIRING",
      dispatchGeneration: generation,
      dispatchRepairStartedAt: nowIso,
      repairProviderAttemptedAt: ctx.providerAttemptedAt,
      updatedAt: nowIso,
    },
  }, { upsert: false });
}

if (ctx.step === "piter_dispatch_repair_quota_find") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const reservation = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || (isHub(ctx) ? 100 : 400), ctx)
    || !reservation || reservation.requestFingerprint !== ctx.requestFingerprint
    || reservation.state !== "DISPATCHING"
    || dispatchGeneration(reservation.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(reservation.providerAttemptedAt) !== toStr(ctx.providerAttemptedAt)) {
    return fail(503, "Квота попытки оплаты требует сверки", "PITER_DISPATCH_REPAIR_QUOTA_INVALID");
  }
  ctx.ledgerSchemaVersion = ledger.schemaVersion;
  ctx.ledgerQuotaAdjustment = [2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : null;
  return resetDispatchAfterFence(ctx);
}

if (ctx.step === "piter_dispatch_repair_fence_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "piter_dispatch_repair_fence_readback");
  }
  return resetDispatchAfterFence(ctx);
}

if (ctx.step === "piter_dispatch_repair_fence_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "DISPATCH_REPAIRING")
    || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(record?.providerAttemptedAt)) {
    return fail(503, "Repair fence попытки Viva требует сверки", "PITER_DISPATCH_REPAIR_FENCE_NOT_DURABLE");
  }
  return resetDispatchAfterFence(ctx);
}

if (ctx.step === "piter_dispatch_repair_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return ledgerFind(ctx, "piter_dispatch_repair_ledger_readback");
  }
  return persistClaimedSale(
    ctx,
    ctx.dispatchRepairOnly === true
      ? "piter_dispatch_repair_claimed_sale_ack"
      : "piter_claimed_sale_ack",
  );
}

if (ctx.step === "piter_dispatch_repair_ledger_readback") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const reservation = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!ledgerQuotaMatches(ledger, ctx) || !reservation
    || reservation.requestFingerprint !== ctx.requestFingerprint
    || reservation.state !== "CLAIMED"
    || dispatchGeneration(reservation.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(reservation.providerAttemptedAt) !== toStr(ctx.providerAttemptedAt)) {
    return fail(503, "Состояние попытки Viva требует сверки", "PITER_DISPATCH_REPAIR_NOT_DURABLE");
  }
  return persistClaimedSale(
    ctx,
    ctx.dispatchRepairOnly === true
      ? "piter_dispatch_repair_claimed_sale_ack"
      : "piter_claimed_sale_ack",
  );
}

if (ctx.step === "piter_dispatch_repair_claimed_sale_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "piter_dispatch_repair_claimed_sale_readback");
  }
  return [null, null, null, null, null];
}

if (ctx.step === "piter_dispatch_repair_claimed_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "CLAIMED")
    || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(record?.providerAttemptedAt)
    || toStr(record?.dispatchRepairStartedAt)
    || toStr(record?.repairProviderAttemptedAt)) {
    return fail(503, "Repair состояния Viva не подтверждён", "PITER_DISPATCH_REPAIR_NOT_DURABLE");
  }
  return [null, null, null, null, null];
}

if (ctx.step === "piter_dispatch_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return fail(409, "Попытка оплаты уже запущена", "PITER_PROVIDER_ATTEMPT_ALREADY_CLAIMED");
  }
  const nowIso = new Date().toISOString();
  ctx.step = "piter_dispatch_sale_ack";
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
    status: "CLAIMED",
    providerAttemptedAt: null,
    dispatchGeneration: generationFilter(dispatchGeneration(ctx.dispatchGeneration) - 1),
  }, {
    $set: {
      status: "DISPATCHING",
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
      providerAttemptedAt: ctx.providerAttemptedAt,
      updatedAt: nowIso,
    },
  }, { upsert: false });
}

if (ctx.step === "piter_dispatch_sale_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "piter_dispatch_sale_readback");
  }
  ctx.step = "create_transaction";
  return provider(ctx);
}

if (ctx.step === "piter_dispatch_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "DISPATCHING", {
    providerAttemptedAt: ctx.providerAttemptedAt,
  }) || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)) {
    return fail(503, "Попытка Viva не подтверждена хранилищем", "PITER_DISPATCH_SALE_NOT_DURABLE");
  }
  ctx.step = "create_transaction";
  return provider(ctx);
}

if (ctx.step === "piter_provider_result") {
  const custody = quotaCustodyFilter(ctx);
  if (!custody) return fail(503, "Состояние квоты изменилось", "PITER_ATOMIC_QUOTA_CUSTODY_INVALID");
  const result = ctx.providerResult || {};
  const nowIso = new Date().toISOString();
  ctx.step = "piter_provider_ledger_ack";
  const resultFilter = {
    _id: ledgerId(ctx),
    ...custody,
    $and: [{ reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef, requestFingerprint: ctx.requestFingerprint, state: "DISPATCHING",
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
    } } }],
  };
  if (toStr(result.transactionId)) resultFilter.$and.push({ reservations: { $not: { $elemMatch: {
    transactionId: result.transactionId, paymentRef: { $ne: ctx.paymentRef },
  } } } });
  if (ctx.ledgerSchemaVersion === 3 && toStr(result.transactionId)) {
    resultFilter["history.entries.transactionId"] = { $ne: result.transactionId };
  }
  return ledgerUpdate(ctx, resultFilter, {
    $set: {
      "reservations.$.state": result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN",
      "reservations.$.updatedAt": nowIso,
      "reservations.$.transactionId": result.transactionId || null,
      "reservations.$.paymentUrl": result.paymentUrl || null,
      "reservations.$.response": result.response || null,
      "reservations.$.expiresAt": result.expiresAt || null,
      "reservations.$.toPayMinor": result.toPayMinor ?? null,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
}

if (ctx.step === "piter_provider_ledger_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return fail(503, "Результат Viva требует сверки", "PITER_PROVIDER_RESULT_NOT_DURABLE");
  }
  const result = ctx.providerResult || {};
  return projectSale(ctx, result, "piter_provider_sale_ack");
}

if (ctx.step === "piter_provider_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_provider_sale_readback");
  }
  return finishProviderProjection();
}

if (ctx.step === "piter_provider_sale_readback") {
  const record = rows(msg.payload)[0];
  const result = ctx.providerResult || {};
  const expectedStatus = result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN";
  if (!saleProjectionMatches(record, ctx, expectedStatus, result)) {
    return fail(503, "Результат оплаты не подтверждён хранилищем", "PITER_PROVIDER_SALE_NOT_DURABLE");
  }
  return finishProviderProjection();
}

if (ctx.step === "piter_replay_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_replay_sale_readback");
  }
  return response(ctx.saleResponseStatus || 200, ctx.providerResult?.response || { ok: true, replayed: true });
}

if (ctx.step === "piter_replay_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "PAYMENT_PENDING", ctx.providerResult || {})) {
    return fail(503, "Проекция покупки не восстановлена", "PITER_REPLAY_SALE_NOT_DURABLE");
  }
  return response(ctx.saleResponseStatus || 200, ctx.providerResult?.response || { ok: true, replayed: true });
}

if (ctx.step === "piter_confirm_result") {
  const result = ctx.confirmResult || {};
  if (!toStr(ctx.requestFingerprint)) {
    if (result.reconcile === true) return [null, null, null, null, null];
    return fail(503, "Legacy-платёж Питера требует отдельной сверки", "PITER_LEGACY_CONFIRM_REQUIRES_RECONCILIATION");
  }
  const expectedAmount = ctx.expectedAmountMinor;
  const validStatus = ["PAID", "FAILED", "PAYMENT_PENDING"].includes(result.nextStatus);
  const validAmount = Number.isInteger(expectedAmount) && expectedAmount > 0
    && Number.isInteger(result.toPayMinor) && result.toPayMinor >= 0
    && (result.nextStatus === "PAID" ? result.toPayMinor === (ctx.inventoryLedgerSchemaVersion === 3 ? expectedAmount : 0)
      : result.nextStatus === "FAILED" ? [0, expectedAmount].includes(result.toPayMinor)
        : result.toPayMinor === expectedAmount);
  if (!validStatus || !validAmount || !toStr(ctx.transactionId) || result.transactionId !== ctx.transactionId) {
    return fail(503, "Подтверждение оплаты требует сверки", "PITER_CONFIRM_PROVIDER_MISMATCH");
  }
  return ledgerFind(ctx, "piter_confirm_validate");
}

if (ctx.step === "piter_confirm_validate") {
  const result = ctx.confirmResult || {};
  const expectedAmount = ctx.expectedAmountMinor;
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const existing = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  const recoveredTransaction = ctx.transactionRecovered === true
    && existing
    && !toStr(existing.transactionId);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || 400, ctx)
    || !existing
    || (ledger.schemaVersion === 3 && (existing.saleRecord?.inventoryLedgerSchemaVersion !== 3 || ctx.inventoryLedgerSchemaVersion !== 3))
    || (ledger.schemaVersion !== 3 && ctx.inventoryLedgerSchemaVersion === 3)
    || existing.requestFingerprint !== ctx.requestFingerprint
    || dispatchGeneration(existing.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || (!recoveredTransaction && existing.transactionId !== ctx.transactionId)
    || existing.priceMinor !== ctx.expectedAmountMinor
    || !(["PAYMENT_PENDING", "PROVIDER_UNKNOWN"].includes(existing.state)
      || (recoveredTransaction && existing.state === "DISPATCHING")
      || existing.state === result.nextStatus)) {
    return fail(503, "Atomic ledger не прошёл проверку перед подтверждением", "PITER_CONFIRM_LEDGER_INVALID");
  }
  ctx.ledgerSchemaVersion = ledger.schemaVersion;
  ctx.ledgerQuotaAdjustment = [2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : null;
  const nowIso = new Date().toISOString();
  ctx.step = "piter_confirm_ledger_ack";
  const inc = { revision: 1 };
  if (result.nextStatus === "PAID") {
    inc.reservedCount = -1;
    inc.paidCount = 1;
    if (isHub(ctx) && existing.dailyDate === ledger.dailyDate) {
      inc.dailyReservedCount = -1;
      inc.dailyPaidCount = 1;
    }
  } else if (result.nextStatus === "FAILED") {
    inc.reservedCount = -1;
    inc.takenCount = -1;
    if (isHub(ctx) && existing.dailyDate === ledger.dailyDate) {
      inc.dailyReservedCount = -1;
    }
  }
  const confirmFilter = {
    _id: ledgerId(ctx),
    ready: ledger.ready,
    schemaVersion: ledger.schemaVersion,
    quotaAdjustment: [2, 3].includes(ledger.schemaVersion) ? ledger.quotaAdjustment : { $exists: false },
    revision: ledger.revision,
    paidCount: ledger.paidCount,
    reservedCount: ledger.reservedCount,
    takenCount: ledger.takenCount,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      transactionId: recoveredTransaction ? { $in: [null, ""] } : ctx.transactionId,
      dispatchGeneration: generationFilter(ctx.dispatchGeneration),
      priceMinor: expectedAmount,
      state: { $in: recoveredTransaction
        ? ["DISPATCHING", "PROVIDER_UNKNOWN"]
        : ["PAYMENT_PENDING", "PROVIDER_UNKNOWN"] },
    } },
  };
  if (recoveredTransaction) {
    confirmFilter.$and = [{ reservations: { $not: { $elemMatch: {
      transactionId: ctx.transactionId,
      paymentRef: { $ne: ctx.paymentRef },
    } } } }];
  }
  if (ledger.schemaVersion === 3) confirmFilter["history.entries.transactionId"] = { $ne: ctx.transactionId };
  return ledgerUpdate(ctx, confirmFilter, {
    $set: {
      "reservations.$.state": result.nextStatus,
      "reservations.$.transactionId": ctx.transactionId,
      "reservations.$.updatedAt": nowIso,
      "reservations.$.paymentUrl": result.paymentUrl || null,
      "reservations.$.paidAt": result.nextStatus === "PAID" ? nowIso : null,
      updatedAt: nowIso,
    },
    $inc: inc,
  });
}

if (ctx.step === "piter_confirm_ledger_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return ledgerFind(ctx, "piter_confirm_replay_find");
  }
  const result = ctx.confirmResult || {};
  if (isHub(ctx) && result.nextStatus === "PAID") {
    ctx.step = "managed_sale_instance_readback";
    return provider(ctx);
  }
  ctx.step = "piter_confirm_sale_ack";
  const nowIso = new Date().toISOString();
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $setOnInsert: ctx.saleRecord || {
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: ctx.clientPhone,
      clientId: ctx.clientId || null,
      productId: ctx.productId,
      productName: ctx.productName,
      amountMinor: ctx.expectedAmountMinor,
      createdAt: nowIso,
    },
    $set: {
      status: result.nextStatus,
      transactionId: ctx.transactionId,
      transactionRecoveredAt: toStr(ctx.transactionRecoveredAt),
      paidAt: result.paid ? nowIso : null,
      lastCheckedAt: nowIso,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor,
      updatedAt: nowIso,
    },
  });
}

if (ctx.step === "piter_confirm_replay_find") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const existing = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || 400, ctx)
    || !ledgerQuotaMatches(ledger, ctx)
    || !existing
    || existing.requestFingerprint !== ctx.requestFingerprint
    || dispatchGeneration(existing.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || existing.transactionId !== ctx.transactionId
    || existing.priceMinor !== ctx.expectedAmountMinor
    || existing.state !== ctx.confirmResult?.nextStatus) {
    return fail(503, "Atomic ledger не подтвердил результат оплаты", "PITER_CONFIRM_LEDGER_NOT_DURABLE");
  }
  const result = ctx.confirmResult || {};
  if (isHub(ctx) && result.nextStatus === "PAID") {
    ctx.step = "managed_sale_instance_readback";
    return provider(ctx);
  }
  const nowIso = new Date().toISOString();
  ctx.step = "piter_confirm_sale_ack";
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $setOnInsert: existing.saleRecord || {
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: existing.clientPhone,
      clientId: existing.clientId || null,
      batchIndex: existing.batchIndex,
      batchSize: existing.batchSize,
      productId: existing.productId,
      productName: existing.productName,
      amountMinor: existing.priceMinor,
      createdAt: existing.createdAt || nowIso,
    },
    $set: {
      status: result.nextStatus,
      transactionId: ctx.transactionId,
      transactionRecoveredAt: toStr(ctx.transactionRecoveredAt),
      paidAt: result.paid ? existing.paidAt || nowIso : null,
      lastCheckedAt: nowIso,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor,
      updatedAt: nowIso,
    },
  });
}

if (ctx.step === "piter_confirm_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_confirm_sale_readback");
  }
  return finishConfirmProjection();
}

if (ctx.step === "piter_confirm_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, ctx.confirmResult?.nextStatus, {
    ...ctx.confirmResult, transactionId: ctx.transactionId,
  })) {
    return fail(503, "Результат оплаты не подтверждён sale record", "PITER_CONFIRM_SALE_NOT_DURABLE");
  }
  return finishConfirmProjection();
}

const managedProjectionMatches = (record, projection) => {
  if (!record || typeof record !== "object" || !projection?.set) return false;
  return Object.entries(projection.set).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === "object") {
      return JSON.stringify(actual) === JSON.stringify(expected);
    }
    return actual === expected;
  });
};

const finishManagedProjection = () => {
  const projection = ctx.managedSaleProjection || {};
  if (ctx.reconcile === true) return [null, null, null, null, null];
  msg.statusCode = Number(projection.statusCode) || 503;
  msg.headers = projection.headers || { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = projection.response || {
    error: "Результат подписки требует сверки",
    details: { code: "MANAGED_SALE_PROJECTION_RESPONSE_MISSING" },
  };
  delete msg.url;
  delete msg.method;
  return [null, null, null, msg, null];
};

if (ctx.step === "managed_sale_projection_start") {
  if (!isHub(ctx)
    || !toStr(ctx.paymentRef)
    || !toStr(ctx.requestFingerprint)
    || !ctx.managedSaleProjection?.set) {
    return fail(503, "Проекция продажи не подготовлена", "MANAGED_SALE_PROJECTION_INVALID");
  }
  ctx.step = "managed_sale_projection_ack";
  return ledgerUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $set: ctx.managedSaleProjection.set,
  });
}

if (ctx.step === "managed_sale_projection_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "managed_sale_projection_readback");
  }
  return finishManagedProjection();
}

if (ctx.step === "managed_sale_projection_readback") {
  const record = rows(msg.payload)[0];
  if (!managedProjectionMatches(record, ctx.managedSaleProjection)) {
    return fail(503, "Проекция продажи не подтверждена хранилищем",
      "MANAGED_SALE_PROJECTION_NOT_DURABLE");
  }
  return finishManagedProjection();
}

return fail(500, "Unsupported Piter atomic sale step", "PITER_ATOMIC_STEP_UNSUPPORTED", { step: ctx.step });

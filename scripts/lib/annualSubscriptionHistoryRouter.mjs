// Embedded in the existing atomic router; no extra HTTP endpoint or provider
// write route. A ledger settlement is authoritative; its saved projection is
// replayed after process/message loss before the next observation is admitted.
export function runAnnualHistory({ msg, ctx, annualHistory, ledgerFind, ledgerUpdate, saleUpdate, fail, response }) {
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

export const annualHistoryRouterSource = () => '// BEGIN generated annualSubscriptionHistoryRouter\n'
  + runAnnualHistory.toString() + '\n// END generated annualSubscriptionHistoryRouter\n';

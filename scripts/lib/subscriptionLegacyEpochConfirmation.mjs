// Excluded old purchases still receive confirmations. This route has no ledger
// helper and no provider-write operation. Native BSON preimages come from Mongo.
export function runLegacyEpochConfirmation({ msg, ctx, annualHistory, epoch, saleUpdate, response, fail }) {
  if (!String(ctx.step || '').startsWith('legacy_epoch_')) return undefined;
  const reject = code => fail(503, 'Существующий платёж требует сверки', code);
  const list = p => Array.isArray(p) ? p : p ? [p] : [];
  const idKey = id => typeof id === 'string' ? `string:${id}`
    : ['ObjectId', 'ObjectID'].includes(id?._bsontype) && typeof id.toHexString === 'function' ? `objectId:${id.toHexString()}` : null;
  const query = () => ({ inventoryId: ctx.inventoryId, paymentRef: ctx.paymentRef, transactionId: ctx.transactionId });
  const read = step => { ctx.step = step; msg.payload = query(); return [msg, null, null, null, null]; };
  const rowFrom = payload => {
    const matches = list(payload);
    if (matches.length !== 1) throw Error('ROW_CARDINALITY');
    const row = matches[0], spec = annualHistory.products[ctx.counterKey];
    if (!spec || epoch.previous[ctx.counterKey] !== ctx.inventoryId || row.inventoryId !== ctx.inventoryId
      || row.counterKey !== ctx.counterKey || row.productId !== spec.productId || row.productId !== ctx.productId
      || row.paymentRef !== ctx.paymentRef || row.transactionId !== ctx.transactionId || row.requestFingerprint
      || !idKey(row._id) || !['PAID','PAYMENT_PENDING','PROVIDER_UNKNOWN','REFUNDED','FAILED'].includes(row.status)
      || (ctx.legacyEpochIdKey && idKey(row._id) !== ctx.legacyEpochIdKey)) throw Error('ROW_IDENTITY');
    return row;
  };
  const provider = (step, path) => {
    ctx.step = step; msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru/api/v1' + path;
    msg.headers = { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' };
    msg.httpRequestTimeout = ctx.httpRequestTimeoutMs; msg.payload = '';
    return [null, null, null, null, msg];
  };
  const readInstances = () => provider('legacy_epoch_instances', `/clients/${encodeURIComponent(ctx.legacyEpochClientId)}/subscriptions?includeFinished=true&size=200&page=${ctx.legacyEpochPage}`);
  const done = row => ctx.reconcile === true ? [null,null,null,null,null]
    : response(200, { ok: true, status: row.status, paymentRef: row.paymentRef, transactionId: row.transactionId });
  const matchesFields = (row, fields) => Object.entries(fields).every(([key, value]) => annualHistory.stable(row[key]) === annualHistory.stable(value));
  try {
    if (ctx.legacyEpochCandidate !== true || !ctx.token || !ctx.transactionId
      || epoch.previous[ctx.counterKey] !== ctx.inventoryId) return reject('LEGACY_EPOCH_SCOPE_INVALID');
    if (ctx.step === 'legacy_epoch_begin') return read('legacy_epoch_row');
    if (ctx.step === 'legacy_epoch_row') {
      const row = rowFrom(msg.payload); ctx.legacyEpochIdKey = idKey(row._id);
      return provider('legacy_epoch_transaction', `/transactions/${encodeURIComponent(ctx.transactionId)}`);
    }
    if (ctx.step === 'legacy_epoch_transaction') {
      if (!(msg.statusCode >= 200 && msg.statusCode < 300) || msg.payload?.id !== ctx.transactionId) return reject('LEGACY_EPOCH_TRANSACTION_UNAVAILABLE');
      ctx.legacyEpochTransaction = msg.payload;
      const ids = [msg.payload.clientId, msg.payload.client?.id, msg.payload.client?.uuid, msg.payload.client?.clientId].filter(v => v != null);
      if (!ids.length || ids.some(id => typeof id !== 'string' || !id || id !== ids[0])) return reject('LEGACY_EPOCH_CLIENT_INVALID');
      ctx.legacyEpochClientId = ids[0]; ctx.legacyEpochSubscriptions = []; ctx.legacyEpochPage = 0;
      if (msg.payload.status === 'UNPAID') return read('legacy_epoch_compare');
      return readInstances();
    }
    if (ctx.step === 'legacy_epoch_instances') {
      const p = msg.payload;
      if (!(msg.statusCode >= 200 && msg.statusCode < 300) || !Array.isArray(p?.content)
        || p.number !== ctx.legacyEpochPage || !Number.isSafeInteger(p.totalElements) || p.totalElements < 0
        || !Number.isSafeInteger(p.totalPages) || p.totalPages < 0 || p.totalPages > 50
        || p.totalPages !== Math.ceil(p.totalElements / 200) || p.numberOfElements !== p.content.length
        || p.content.length > 200 || p.last !== (p.number >= p.totalPages - 1)
        || (!p.last && p.content.length !== 200)
        || (ctx.legacyEpochPage > 0 && (p.totalPages !== ctx.legacyEpochPages || p.totalElements !== ctx.legacyEpochTotal))) return reject('LEGACY_EPOCH_INSTANCE_PAGES_INVALID');
      ctx.legacyEpochPages = p.totalPages; ctx.legacyEpochTotal = p.totalElements;
      ctx.legacyEpochSubscriptions.push(...p.content);
      if (!p.last) { ctx.legacyEpochPage++; return readInstances(); }
      const ids = ctx.legacyEpochSubscriptions.map(s => s.subscriptionId || s.clientSubscriptionId || s.id || s.uuid);
      if (ids.length !== p.totalElements || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return reject('LEGACY_EPOCH_INSTANCE_COVERAGE_INVALID');
      return read('legacy_epoch_compare');
    }
    if (ctx.step === 'legacy_epoch_compare') {
      const row = rowFrom(msg.payload);
      const fact = annualHistory.observe(ctx.legacyEpochTransaction, { productId: ctx.productId,
        clientId: ctx.legacyEpochClientId, subscriptions: ctx.legacyEpochSubscriptions, localRow: row });
      if ((row.status === 'REFUNDED' && fact.state !== 'REFUNDED') || (row.status === 'PAID' && fact.state === 'UNPAID')) return reject('LEGACY_EPOCH_STALE_PROVIDER_STATE');
      if (fact.state === 'UNPAID') return done(row);
      const fields = fact.state === 'PAID' ? { status: 'PAID', paidAt: fact.paidAt, clientSubscriptionId: fact.subscriptionId }
        : { status: 'REFUNDED', refundedAt: fact.refundProof.transactionRefundedAt,
          refundSumMinor: fact.refundProof.refundSumMinor, refundedSubscriptionId: fact.subscriptionId,
          annualHistoryRefundProof: fact.refundProof };
      if (matchesFields(row, fields)) return done(row);
      ctx.legacyEpochFields = fields; ctx.step = 'legacy_epoch_write_ack';
      return saleUpdate(ctx, { _id: row._id, $expr: { $eq: ['$$ROOT', { $literal: row }] } },
        { $set: { ...fields, updatedAt: new Date().toISOString() } }, { upsert: false });
    }
    if (ctx.step === 'legacy_epoch_write_ack') return read('legacy_epoch_readback');
    if (ctx.step === 'legacy_epoch_readback') {
      const row = rowFrom(msg.payload);
      if (!ctx.legacyEpochFields || !matchesFields(row, ctx.legacyEpochFields)) return reject('LEGACY_EPOCH_CAS_NOT_CONFIRMED');
      return done(row);
    }
    return reject('LEGACY_EPOCH_STEP_INVALID');
  } catch { return reject('LEGACY_EPOCH_EVIDENCE_INVALID'); }
}
export function legacyEpochConfirmationSource() {
  return '// BEGIN generated legacyEpochConfirmation\n' + runLegacyEpochConfirmation.toString()
    + '\n// END generated legacyEpochConfirmation\n';
}

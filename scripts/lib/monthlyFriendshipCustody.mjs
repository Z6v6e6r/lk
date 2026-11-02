// Concrete monthly Friendship custody. This is not the annual tier/quota kernel.
// Callers own actor verification, complete inventory reads and the existing monthly
// limit calculation. Only an acknowledged exact CAS may authorize provider POST.
export function createMonthlyFriendshipCustody() {
  const kind = 'MONTHLY_FRIENDSHIP_CUSTODY_V1';
  const hasControls = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const text = x => typeof x === 'string' && x.length > 0 && x.length <= 256 && x.trim() === x && !hasControls(x);
  const iso = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)
    && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
  const integer = x => Number.isSafeInteger(x) && x >= 0;
  const stable = x => JSON.stringify((function sort(v) {
    return Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  })(x));
  const fail = code => { throw Error('MONTHLY_FRIENDSHIP_' + code); };
  const states = ['CLAIMED', 'DISPATCHING', 'PROVIDER_UNKNOWN', 'PAYMENT_PENDING', 'PAID'];
  const id = (tenantId, inventoryId) => 'monthly-friendship:' + encodeURIComponent(tenantId) + ':' + encodeURIComponent(inventoryId);
  const clean = value => JSON.parse(JSON.stringify(value));
  const keys = (value, expected) => value && !Array.isArray(value) && typeof value === 'object'
    && Object.keys(value).sort().join() === expected.split(',').sort().join();
  const scope = value => text(value?.tenant_id) && text(value?.inventoryId) && value.counterKey === 'friendship';
  const requestValid = r => keys(r, 'tenant_id,inventoryId,counterKey,paymentRef,clientId,clientPhone,productId,campaignKey,productName,amountMinor,providerProductCostMinor,discountMinor,releasePhase,dailyDropDate,counterEpoch,providerPayload') && scope(r) && text(r.paymentRef) && text(r.clientId) && text(r.clientPhone)
    && /^\+[1-9][0-9]{7,14}$/.test(r.clientPhone)
    && text(r.productId) && text(r.campaignKey) && text(r.productName)
    && [r.amountMinor, r.providerProductCostMinor, r.discountMinor].every(integer)
    && r.amountMinor > 0 && r.amountMinor + r.discountMinor === r.providerProductCostMinor
    && (r.counterEpoch === null || (keys(r.counterEpoch, 'id,startedAt,timeZone,membership')
      && r.counterEpoch.id === 'subscription-sales-20260910' && iso(r.counterEpoch.startedAt)
      && r.counterEpoch.timeZone === 'Europe/Moscow' && r.counterEpoch.membership === 'NEW_LK_RESERVATIONS_ONLY'))
    && [null, 'launch', 'daily'].includes(r.releasePhase)
    && (r.releasePhase !== 'daily' || /^\d{4}-\d{2}-\d{2}$/.test(r.dailyDropDate))
    && r.providerPayload && stable(Object.keys(r.providerPayload).sort()) === stable(['clientPhone','deposit','offlineTillId','paymentMethod','products', ...(r.providerPayload.successUrl === undefined ? [] : ['successUrl']), ...(r.providerPayload.failUrl === undefined ? [] : ['failUrl']), ...(r.providerPayload.studioId === undefined ? [] : ['studioId']), ...(r.providerPayload.promoCode === undefined ? [] : ['promoCode'])].sort())
    && r.providerPayload.clientPhone === r.clientPhone && r.providerPayload.deposit === 0 && r.providerPayload.offlineTillId === null
    && ['CARD','WIDGET','SMS','SUBSCRIPTION'].includes(r.providerPayload.paymentMethod)
    && ['successUrl','failUrl'].every(k => r.providerPayload[k] === undefined || (typeof r.providerPayload[k] === 'string' && r.providerPayload[k].length <= 2048))
    && Array.isArray(r.providerPayload.products) && r.providerPayload.products.length === 1
    && keys(r.providerPayload.products[0], r.providerPayload.promoCode === undefined ? 'id,count,type,customAmount,discount' : 'id,count,type,customAmount')
    && r.providerPayload.products[0].id === r.productId && r.providerPayload.products[0].count === 1
    && r.providerPayload.products[0].type === 'SUBSCRIPTION' && r.providerPayload.products[0].customAmount === null
    && (r.providerPayload.promoCode === undefined
      ? r.providerPayload.products[0].discount === r.discountMinor
      : text(r.providerPayload.promoCode) && r.providerPayload.products[0].discount === undefined);
  const operationValid = o => keys(o, 'request,state,generation,createdAt,updatedAt,attemptedAt,transactionId,subscriptionId,confirmedAt,paidAt,paymentUrl,expiresAt') && requestValid(o?.request) && states.includes(o.state) && iso(o.createdAt) && iso(o.updatedAt)
    && integer(o.generation) && (o.state === 'CLAIMED' ? o.generation === 0 : o.generation === 1)
    && (o.state === 'CLAIMED' ? o.attemptedAt === null : iso(o.attemptedAt))
    && (['PAYMENT_PENDING','PAID'].includes(o.state) ? text(o.transactionId)
      : o.state === 'PROVIDER_UNKNOWN' ? o.transactionId === null || text(o.transactionId) : o.transactionId === null)
    && (o.paymentUrl === null && o.expiresAt === null ? o.state !== 'PAYMENT_PENDING'
      : ['PAYMENT_PENDING','PAID'].includes(o.state) && paymentUrl(o.paymentUrl) && iso(o.expiresAt) && Date.parse(o.expiresAt) > Date.parse(o.attemptedAt))
    && (o.state === 'PAID' ? text(o.subscriptionId) && iso(o.confirmedAt) && typeof o.paidAt === 'string' && Number.isFinite(Date.parse(o.paidAt))
      : o.subscriptionId === null && o.confirmedAt === null && o.paidAt === null);
  const validate = l => {
    if (!keys(l, '_id,documentType,schemaVersion,tenant_id,counterKey,inventoryId,revision,operations,createdAt,updatedAt') || !scope(l) || l.documentType !== kind || l.schemaVersion !== 1 || l._id !== id(l.tenant_id, l.inventoryId)
      || !integer(l.revision) || !Array.isArray(l.operations) || l.operations.length > 2000
      || !iso(l.createdAt) || !iso(l.updatedAt) || !l.operations.every(o => operationValid(o)
        && o.request.tenant_id === l.tenant_id && o.request.inventoryId === l.inventoryId)
      || new Set(l.operations.map(o => o.request.paymentRef)).size !== l.operations.length
      || new Set(l.operations.filter(o => o.transactionId).map(o => o.transactionId)).size !== l.operations.filter(o => o.transactionId).length
      || new Set(l.operations.filter(o => o.subscriptionId).map(o => o.subscriptionId)).size !== l.operations.filter(o => o.subscriptionId).length
      || stable(l).length > 4_000_000) return false;
    return true;
  };
  const assert = l => { if (!validate(l)) fail('LEDGER_INVALID'); return l; };
  const initial = (s, now) => {
    if (!scope(s) || !iso(now)) fail('SCOPE_INVALID');
    return { _id: id(s.tenant_id, s.inventoryId), documentType: kind, schemaVersion: 1,
      tenant_id: s.tenant_id, counterKey: 'friendship', inventoryId: s.inventoryId,
      revision: 0, operations: [], createdAt: now, updatedAt: now };
  };
  const lookup = (l, paymentRef) => { assert(l); return l.operations.find(o => o.request.paymentRef === paymentRef) || null; };
  const finish = (l, operation, now) => {
    if (!iso(now) || Date.parse(now) < Date.parse(l.updatedAt)) fail('CLOCK_INVALID');
    const next = clean(l); const index = next.operations.findIndex(o => o.request.paymentRef === operation.request.paymentRef);
    if (index < 0) next.operations.push(clean(operation)); else next.operations[index] = clean(operation);
    next.revision++; next.updatedAt = now; assert(next);
    // Full immutable preimage, not just revision, fences drift/corruption and ABA.
    return { query: clean(l), update: { $set: { operations: next.operations, revision: next.revision, updatedAt: now } }, next };
  };
  const reserve = (l, request, capacity, now) => {
    assert(l);
    if (!requestValid(request) || request.tenant_id !== l.tenant_id || request.inventoryId !== l.inventoryId) fail('REQUEST_INVALID');
    const existing = lookup(l, request.paymentRef);
    if (existing) {
      if (stable(existing.request) !== stable(request)) fail('IDEMPOTENCY_CONFLICT');
      return { existing: clean(existing) };
    }
    // An ambiguous earlier purchase cannot be bypassed with a new key, quote or price.
    if (l.operations.some(o => o.request.clientId === request.clientId && o.state !== 'PAID')) fail('CLIENT_PURCHASE_PENDING');
    if (capacity?.ledgerRevision !== l.revision || capacity?.inventoryId !== l.inventoryId
      || capacity?.counterKey !== 'friendship' || !integer(capacity.remaining) || capacity.remaining < 1) fail('CAPACITY_UNAVAILABLE');
    return finish(l, { request: clean(request), state: 'CLAIMED', generation: 0, createdAt: now, updatedAt: now,
      attemptedAt: null, transactionId: null, subscriptionId: null, confirmedAt: null, paidAt: null,
      paymentUrl: null, expiresAt: null }, now);
  };
  const dispatch = (l, request, now) => {
    const o = lookup(l, request.paymentRef);
    if (!o || stable(o.request) !== stable(request)) fail('BINDING_CONFLICT');
    if (o.state !== 'CLAIMED' || o.generation !== 0) return { existing: clean(o) };
    return { ...finish(l, { ...o, state: 'DISPATCHING', generation: 1, attemptedAt: now, updatedAt: now }, now),
      dispatchPaymentRef: request.paymentRef };
  };
  const acknowledgedDispatch = (mutation, ack) => {
    if (!validate(mutation?.query) || !validate(mutation?.next) || !text(mutation.dispatchPaymentRef)
      || ack?.acknowledged !== true || ack.matchedCount !== 1 || ack.modifiedCount !== 1) return false;
    const before = lookup(mutation.query, mutation.dispatchPaymentRef), after = lookup(mutation.next, mutation.dispatchPaymentRef);
    if (before?.state !== 'CLAIMED' || before.generation !== 0 || after?.state !== 'DISPATCHING' || after.generation !== 1) return false;
    return stable(dispatch(mutation.query, before.request, after.attemptedAt)) === stable(mutation);
  };
  const paymentUrl = value => {
    if (typeof value !== 'string' || value.length > 4096 || (/[\s\\]/u.test(value) || hasControls(value))) return false;
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash
      && !!u.hostname && !/^\[|^[\d.]+$/.test(u.hostname) && !['localhost','localhost.localdomain'].includes(u.hostname)
      && !u.hostname.endsWith('.localhost') && !u.hostname.endsWith('.local'); } catch { return false; }
  };
  const normalizedResponse = response => ({
    statusCode: Number.isInteger(response?.statusCode) && response.statusCode >= 100 && response.statusCode < 600 ? response.statusCode : 0,
    transactionId: Number.isInteger(response?.statusCode) && response.statusCode >= 200 && response.statusCode < 300
      && text(response?.transactionId) ? response.transactionId : null,
    amountMinor: integer(response?.amountMinor) ? response.amountMinor : null,
    paymentUrl: paymentUrl(response?.paymentUrl) ? response.paymentUrl : null,
    expiresAt: iso(response?.expiresAt) ? response.expiresAt : null,
  });
  const observation = (l, request, response) => {
    const o = lookup(l, request.paymentRef);
    if (!o || stable(o.request) !== stable(request) || o.generation !== 1 || !iso(o.attemptedAt)) fail('OBSERVATION_BINDING_INVALID');
    return { _id: l._id + ':provider:' + encodeURIComponent(request.paymentRef), documentType: 'MONTHLY_FRIENDSHIP_PROVIDER_OBSERVATION_V1',
      tenant_id: l.tenant_id, ownerLedgerId: l._id, request: clean(request), generation: o.generation,
      attemptedAt: o.attemptedAt, response: normalizedResponse(response) };
  };
  const observationMatches = (value, l, request) => {
    try { return stable(value) === stable(observation(l, request, value.response)); } catch { return false; }
  };
  const result = (l, request, response, now) => {
    const o = lookup(l, request.paymentRef);
    if (!o || stable(o.request) !== stable(request) || o.generation !== 1) fail('BINDING_CONFLICT');
    if (!['DISPATCHING','PROVIDER_UNKNOWN'].includes(o.state)) return { existing: clean(o) };
    const valid = Number.isInteger(response?.statusCode) && response.statusCode >= 200 && response.statusCode < 300 && text(response.transactionId)
      && response.amountMinor === request.amountMinor && paymentUrl(response.paymentUrl) && iso(response.expiresAt)
      && Date.parse(response.expiresAt) > Date.parse(o.attemptedAt);
    const candidate = Number.isInteger(response?.statusCode) && response.statusCode >= 200 && response.statusCode < 300 && text(response.transactionId) ? response.transactionId : null;
    if (o.transactionId && candidate && o.transactionId !== candidate) fail('TRANSACTION_CONFLICT');
    return finish(l, { ...o, state: valid ? 'PAYMENT_PENDING' : 'PROVIDER_UNKNOWN',
      transactionId: candidate || o.transactionId, paymentUrl: valid ? response.paymentUrl : null,
      expiresAt: valid ? response.expiresAt : null, updatedAt: now }, now);
  };
  const confirm = (l, paymentRef, transaction, snapshot, observe, now) => {
    const o = lookup(l, paymentRef);
    if (!o?.transactionId || !['PROVIDER_UNKNOWN','PAYMENT_PENDING','PAID'].includes(o.state)) fail('TRANSACTION_UNKNOWN');
    if (snapshot?.complete !== true || snapshot.clientId !== o.request.clientId || !Array.isArray(snapshot.subscriptions)
      || snapshot.rowCount !== snapshot.subscriptions.length || !integer(snapshot.pages) || snapshot.pages < 1 || snapshot.pages > 50) fail('INSTANCE_SNAPSHOT_INCOMPLETE');
    const fact = observe(transaction, { productId: o.request.productId, clientId: o.request.clientId,
      subscriptions: snapshot.subscriptions, requireInstance: true });
    if (fact.state !== 'PAID' || fact.transactionId !== o.transactionId || fact.clientId !== o.request.clientId
      || fact.amountMinor !== o.request.amountMinor || fact.costMinor !== o.request.providerProductCostMinor
      || fact.discountMinor !== o.request.discountMinor || !text(fact.subscriptionId)
      || Date.parse(fact.paidAt) < Date.parse(o.attemptedAt)) fail('ISSUANCE_MISMATCH');
    if (o.state === 'PAID') {
      if (o.subscriptionId !== fact.subscriptionId || o.paidAt !== fact.paidAt) fail('ISSUANCE_CONFLICT');
      return { existing: clean(o) };
    }
    return finish(l, { ...o, state: 'PAID', subscriptionId: fact.subscriptionId, confirmedAt: now, paidAt: fact.paidAt, updatedAt: now }, now);
  };
  // Only verified ledger rows supply a permanent hold; projections are never counted twice.
  const countingRows = (rows, s) => {
    if (!Array.isArray(rows) || !scope(s)) fail('INVENTORY_READ_INVALID');
    const ledgers = rows.filter(r => r?._id === id(s.tenant_id, s.inventoryId));
    if (ledgers.length !== 1) fail('LEDGER_UNAVAILABLE');
    const l = assert(ledgers[0]);
    const projected = rows.filter(r => r?.monthlyCustody?.ledgerId === l._id);
    if (new Set(projected.map(r => r.paymentRef)).size !== projected.length) fail('DUPLICATE_PROJECTION');
    for (const row of projected) {
      const o = lookup(l, row.paymentRef);
      if (!o) fail('ORPHAN_PROJECTION');
      if (['tenant_id','inventoryId','counterKey','clientId','clientPhone','productId','amountMinor','providerProductCostMinor','discountMinor'].some(k => row[k] !== o.request[k])
        || (row.transactionId != null && row.transactionId !== o.transactionId)
        || (row.clientSubscriptionId != null && row.clientSubscriptionId !== o.subscriptionId)
        || (row.status === 'PAID' && o.state !== 'PAID')) fail('PROJECTION_CONFLICT');
    }
    return [...rows.filter(r => r !== l && !projected.includes(r)), ...l.operations.map(o => ({
      ...o.request, _id: l._id + ':' + o.request.paymentRef, status: o.state === 'PAID' ? 'PAID' : 'PAYMENT_PENDING',
      monthlyCustodyHold: o.state !== 'PAID', createdAt: o.createdAt, updatedAt: o.updatedAt,
      paidAt: o.paidAt, expiresAt: o.expiresAt, monthlyCustody: { ledgerId: l._id },
    }))];
  };
  return { kind, stable, id, initial, validate, lookup, reserve, dispatch, acknowledgedDispatch, result, confirm, countingRows, paymentUrl, observation, observationMatches };
}
export const monthlyFriendshipCustody = createMonthlyFriendshipCustody();
export const monthlyFriendshipCustodyRuntimeSource = () => createMonthlyFriendshipCustody.toString() + '\nconst monthlyFriendshipCustody = createMonthlyFriendshipCustody();\n';

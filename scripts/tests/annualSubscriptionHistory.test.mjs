import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { annualHistory, annualHistoryRuntimeSource } from '../lib/annualSubscriptionHistory.mjs';
import { buildAnnualSubscriptionOpening } from '../lib/annualSubscriptionOpening.mjs';
import { runAnnualHistory } from '../lib/annualSubscriptionHistoryRouter.mjs';
import { syncAnnualHistory } from '../sync_annual_subscription_history.mjs';
import { buildHistoryMaintenanceMutation, validateHistoryMaintenanceGrant, assertHistoryMaintenanceCustody,
  assertHistoryDeployLease, historyDigest } from '../lib/subscriptionHistoryMaintenanceContract.mjs';
import { loadSubscriptionSalesConfiguration } from '../lib/subscriptionSalesConfiguration.mjs';

const now = '2026-09-09T18:14:00.000Z';
// Synthetic phone assembled explicitly to keep fixture values out of PII-pattern scans.
const FIXTURE_PHONE = '+7' + '9990000000';
function fixture({ counterKey = 'network_friendship', paid = 18, unpaid = 2, localPaid = 4 } = {}) {
  const spec = annualHistory.products[counterKey];
  const tx = [], clients = [], rows = [];
  for (let i = 0; i < paid + unpaid; i++) {
    const id = `fixture-tx-${i}`, clientId = `fixture-client-${i}`, state = i < paid ? 'PAID' : 'UNPAID';
    const t = { id, status: state, products: [{ id: spec.productId, cost: 5680000, discount: 3700000, count: 1 }],
      sum: 5680000, discount: 3700000, toPay: 1980000, refundSum: 0, refundedAt: null,
      paymentDate: state === 'PAID' ? '2026-09-08T10:00:00+03:00' : null,
      paymentDueDate: '2026-09-08T11:00:00.123456+03:00', client: { id: clientId, phone: FIXTURE_PHONE } };
    tx.push(t);
    const subscriptions = state === 'PAID' ? [{ subscriptionId: `fixture-sub-${i}`, transactionId: id,
      product: { id: spec.productId }, status: 'ACTIVE', refundSum: 0, refundedAt: null }] : [];
    clients.push({ clientId, complete: true, pagination: { complete: true, pages: 1, rowCount: subscriptions.length }, subscriptions });
    if (i < localPaid || i === paid) rows.push({ _id: `fixture-row-${i}`, paymentRef: `fixture-payment-${i}`,
      inventoryId: spec.inventoryId, counterKey, productId: spec.productId, transactionId: id,
      clientId, clientPhone: FIXTURE_PHONE, amountMinor: 1980000, providerProductCostMinor: 5680000,
      discountMinor: 3700000, expiresAt: '2026-09-08T11:00:00.123456319+03:00',
      status: state === 'PAID' ? 'PAID' : 'PAYMENT_PENDING', createdAt: '2026-09-08T10:00:00.000Z' });
  }
  const envelope = (source, query, key, list) => ({ formatVersion: 1, capturedAt: now, source, query,
    complete: true, pagination: { complete: true, pages: 1, rowCount: list.length }, [key]: list });
  return { counterKey, accountingScope: 'ALL_PROVIDER_PAID', now,
    ledgerEvidence: envelope('MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES', { inventoryId: spec.inventoryId }, 'rows', rows),
    crossInventoryEvidence: envelope('MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES', { transactionId: { $in: tx.map(t => t.id).sort() } }, 'rows', structuredClone(rows)),
    providerEvidence: envelope('VIVA_TRANSACTIONS', { productId: spec.productId }, 'transactions', tx),
    subscriptionEvidence: envelope('VIVA_CLIENT_SUBSCRIPTIONS', { clientIds: clients.map(c => c.clientId).sort(), includeFinished: true }, 'clients', clients),
    productEvidence: { source: 'VIVA_PRODUCT', capturedAt: now, product: { id: spec.productId,
      productType: 'SUBSCRIPTION', cost: counterKey === 'network_friendship' ? 9800000 : 5680000, activationDays: 1, validityDays: 365, visits: 365 } },
    runtimeBinding: { kind: 'ANNUAL_HISTORY_RUNTIME_BINDING_V1', capturedAt: now, salesFlagsOff: true,
      flowSha256: 'a'.repeat(64), publicationDigest: 'b'.repeat(64) } };
}
function late(f, i, state = 'PAID') {
  const t = structuredClone(f.providerEvidence.transactions[i]); t.status = state;
  t.paymentDate = '2026-09-09T20:00:00+03:00';
  const s = { subscriptionId: `fixture-sub-${i}`, transactionId: t.id, product: { id: t.products[0].id }, status: 'ACTIVE' };
  if (state === 'REFUND') { t.refundSum = 1000000; t.refundedAt = '2026-09-09T20:30:00+03:00';
    s.status = 'REFUNDED'; s.refundSum = t.refundSum; s.refundedAt = '2026-09-09T20:30:04.123456'; }
  return { t, s, fact: annualHistory.observe(t, { productId: t.products[0].id, subscriptions: [s], clientId: t.client.id }) };
}

test('HAB includes 18 real paid facts and no fake reservations or sale inserts', () => {
  const plan = buildAnnualSubscriptionOpening(fixture());
  assert.equal(plan.document.paidCount, 18); assert.equal(plan.summary.remaining, 82);
  assert.equal(plan.summary.providerOnlyPaid, 14); assert.equal(plan.summary.dailyRemaining, 1);
  assert.deepEqual(plan.document.reservations, []); assert.equal(plan.executionAuthorized, false);
  assert.equal(plan.document.ready, false); assert.equal(plan.document.history.entries.length, 20);
  assert.equal(plan.document.history.entries.filter(e => e.source === 'PROVIDER_ONLY').every(e => e.localRowId === null), true);
});
test('Piter freezes B42 plus adjustment10 and late PAID reduces the first batch remaining', () => {
  const f = fixture({ counterKey: 'piter_friendship', paid: 42, localPaid: 40 });
  const ledger = buildAnnualSubscriptionOpening(f).document;
  assert.equal(ledger.quotaAdjustment, 10);
  const next = annualHistory.settle(ledger, late(f, 42).fact, now);
  assert.equal(next.paidCount, 43); assert.equal(next.quotaAdjustment, 10);
  assert.equal(100 - next.takenCount - next.quotaAdjustment, 47);
  assert.equal(next.history.openingPaidCount, 42);
  assert.equal(annualHistory.settle(next, late(f, 42).fact, now).paidCount, 43);
  assert.equal(next.history.settlements[0].projection.rowId, 'fixture-row-42');
});
test('late payments survive closed readiness, daily and total overflow', () => {
  const f = fixture({ paid: 100, localPaid: 4 }), ledger = buildAnnualSubscriptionOpening(f).document;
  const first = annualHistory.settle(ledger, late(f, 100).fact, now);
  const second = annualHistory.settle(first, late(f, 101).fact, now);
  assert.equal(second.ready, false); assert.equal(second.paidCount, 102);
  assert.equal(second.dailyPaidCount, 2); assert.equal(annualHistory.validate(second), true);
  assert.equal(second.history.settlements[1].projection, null);
});
test('expired UNPAID stays watched and never changes local status or creates a settlement', () => {
  const f = fixture(), ledger = buildAnnualSubscriptionOpening(f).document;
  const e = ledger.history.entries.find(e => e.kind === 'UNPAID_WATCH');
  const next = annualHistory.settle(ledger, e.fact, now);
  assert.equal(next.history.settlements.length, 0); assert.equal(next.paidCount, 18);
  assert.equal(next.history.entries.find(x => x.transactionId === e.transactionId).localPreimage.status, 'PAYMENT_PENDING');
});
test('refund removes one paid fact, preserves raw independent dates and cannot be undone by stale PAID', () => {
  const f = fixture(), ledger = buildAnnualSubscriptionOpening(f).document;
  const paid = annualHistory.settle(ledger, late(f, 18).fact, now);
  const refund = annualHistory.settle(paid, late(f, 18, 'REFUND').fact, now);
  assert.equal(refund.paidCount, 18); assert.equal(refund.dailyPaidCount, 0);
  assert.equal(refund.history.settlements.at(-1).fact.refundProof.subscriptionRefundedAt, '2026-09-09T20:30:04.123456');
  assert.throws(() => annualHistory.settle(refund, late(f, 18).fact, now), /STALE_PROVIDER_STATE/);
});
test('canonical IDs collide across inventory, baseline and reservations', () => {
  const f = fixture(); f.crossInventoryEvidence.rows.push({ ...f.ledgerEvidence.rows[0], _id: 'foreign', inventoryId: 'foreign' });
  f.crossInventoryEvidence.pagination.rowCount++;
  assert.throws(() => buildAnnualSubscriptionOpening(f), /CROSS_INVENTORY_COLLISION/);
  const ledger = buildAnnualSubscriptionOpening(fixture()).document;
  ledger.reservations.push({ paymentRef: 'new-ref', state: 'PAID', transactionId: 'fixture-tx-0' });
  ledger.paidCount++; ledger.takenCount++;
  assert.equal(annualHistory.validate(ledger), false);
});
test('scope, freshness, pagination and current product price fail closed', () => {
  for (const mutate of [f => delete f.accountingScope, f => { f.accountingScope = 'LOCAL_ONLY'; },
    f => { f.now = '2026-09-09T18:20:00.000Z'; }, f => { f.providerEvidence.pagination.complete = false; },
    f => { f.productEvidence.product.cost = 5680000; }, f => { f.subscriptionEvidence.clients.pop(); }]) {
    const f = fixture(); mutate(f); assert.throws(() => buildAnnualSubscriptionOpening(f));
  }
});
test('wrong client, conflicting product aliases, amounts, duplicate instances and refund links rejected', () => {
  for (const mutate of [x => { x.t.clientId = 'other'; }, x => { x.t.products[0].productId = 'other'; },
    x => { x.t.toPay = 0; }, x => { x.s.product.id = 'other'; }, x => { x.s.transactionId = 'other'; }]) {
    const x = late(fixture(), 18); mutate(x);
    assert.throws(() => annualHistory.observe(x.t, { productId: annualHistory.products.network_friendship.productId,
      subscriptions: [x.s], clientId: x.t.client.id }));
  }
  const x = late(fixture(), 18);
  assert.throws(() => annualHistory.observe(x.t, { productId: x.t.products[0].id, subscriptions: [x.s, x.s], clientId: x.t.client.id }));
});
test('generated runtime uses exactly the same contract', () => {
  syncAnnualHistory({ check: true });
  const runtime = vm.runInNewContext(annualHistoryRuntimeSource() + '\nannualHistory;');
  const ledger = buildAnnualSubscriptionOpening(fixture()).document;
  assert.equal(runtime.validate(ledger), true);
  for (const file of ['confirm_resolve', 'status_response', 'purchase_router', 'piter_atomic_router', 'reconcile_query', 'reconcile_record']) {
    new vm.Script(`(function(msg,node,context,flow,global,env){${fs.readFileSync(new URL(`../nodered_games_nodes/fn_tournament_subscription_${file}.js`, import.meta.url), 'utf8')}\n})`);
  }
});

test('router recovers a lost ledger ACK and lost sale ACK after all message state is discarded', () => {
  const f = fixture(); let ledger = buildAnnualSubscriptionOpening(f).document;
  const paid = late(f, 18); ledger = annualHistory.settle(ledger, paid.fact, now);
  // The ledger write succeeded but its ACK and process were lost.
  let row = structuredClone(f.ledgerEvidence.rows.at(-1));
  let ctx = { counterKey: f.counterKey, inventoryId: ledger.inventoryId, reconcile: true, step: 'annual_history_recover' };
  const writes = [];
  function run(payload) {
    const msg = { payload };
    return runAnnualHistory({ msg, ctx, annualHistory,
      ledgerFind: (c, step) => { c.step = step; return { findLedger: true }; },
      ledgerUpdate: (c, filter, update, options) => { writes.push({ filter, update, options, target: 'ledger' }); return { updateLedger: true }; },
      saleUpdate: (c, filter, update, options) => { writes.push({ filter, update, options, target: 'sale' }); return { updateSale: true }; },
      fail: (_status, _message, code) => { throw Error(code); }, response: (_status, body) => body });
  }
  run([ledger]); assert.equal(ctx.step, 'annual_history_projection_find');
  run([row]); assert.equal(writes.at(-1).options.upsert, false);
  assert.equal(writes.at(-1).filter._id, row._id);
  const originalAmount = row.amountMinor; Object.assign(row, writes.at(-1).update.$set);
  // Sale projection succeeded, its ACK was lost, and a fresh scheduler resumes.
  ctx = { counterKey: f.counterKey, inventoryId: ledger.inventoryId, reconcile: true, step: 'annual_history_recover' };
  run([ledger]); run([row]); assert.equal(ctx.step, 'annual_history_projection_complete');
  run([ledger]); Object.assign(ledger, writes.at(-1).update.$set); ledger.revision++;
  run({}); run([ledger]);
  assert.equal(ledger.paidCount, 19); assert.equal(annualHistory.pendingProjection(ledger), null);
  assert.equal(row.amountMinor, originalAmount); assert.equal(row._id, 'fixture-row-18');
  assert.equal(writes.filter(w => w.target === 'sale').length, 1);
});

test('durable projection cannot change identity, amount, allowed fields or normalized fact', () => {
  const f = fixture(), ledger = annualHistory.settle(buildAnnualSubscriptionOpening(f).document, late(f, 18).fact, now);
  for (const mutate of [s => { s.projection.fields.amountMinor = 1; }, s => { s.projection.rowId = 'foreign'; },
    s => { s.projection.state = 'unknown'; }, s => { s.fact.amountMinor = -1; }, s => { s.fact.clientId = 'foreign'; },
    s => { s.fact.refundProof = {}; }, s => { s.fact.paidDate = '2026-09-08'; }]) {
    const bad = structuredClone(ledger); mutate(bad.history.settlements[0]); assert.equal(annualHistory.validate(bad), false);
  }
});
test('strict refund and all explicit client aliases are checked', () => {
  for (const change of [x => { x.t.refundSum = -1; }, x => { x.t.refundSum = '0'; },
    x => { x.t.products[0].refunded = true; }, x => { x.s.client = { id: 'foreign' }; },
    x => { x.t.clientPhone = '+7' + '9991111111'; }]) {
    const x = late(fixture(), 18); change(x);
    assert.throws(() => annualHistory.observe(x.t, { productId: x.t.products[0].id, subscriptions: [x.s], clientId: x.t.client.id }));
  }
});
const nodeRun = (name, msg, globals = {}) => new Function('msg', 'global', 'env', fs.readFileSync(new URL(`../nodered_games_nodes/fn_tournament_subscription_${name}.js`, import.meta.url), 'utf8'))(msg, { get: k => globals[k] }, { get: k => k === 'VIVACRM_TOKEN_REQUEST_BODY' ? 'fixture-auth' : undefined });
test('legacy PAID acknowledgement works with no schema3 ledger and closed flags', () => {
  const row = fixture().ledgerEvidence.rows[0];
  const out = nodeRun('confirm_resolve', { payload: [row], _summerSubscriptionCtx: {
    action: 'confirm', step: 'resolve_record', paymentRef: row.paymentRef, counterKey: row.counterKey } });
  assert.equal(out[1].statusCode, 200); assert.equal(out[1].payload.status, 'PAID');
});
test('atomic provider attachment rejects canonical history IDs in the Mongo CAS', () => {
  const out = nodeRun('piter_atomic_router', { _summerSubscriptionCtx: { step: 'piter_provider_result',
    counterKey: 'piter_friendship', inventoryId: annualHistory.products.piter_friendship.inventoryId,
    ledgerSchemaVersion: 3, ledgerQuotaAdjustment: 10, paymentRef: 'new', requestFingerprint: 'fingerprint',
    providerResult: { transactionId: 'fixture-tx-1', ok: true } } });
  assert.deepEqual(out[1].payload[0]['history.entries.transactionId'], { $ne: 'fixture-tx-1' });
});
test('attempt cursor rotates after a failed watch and expansion stays before the rate limiter', () => {
  const f = fixture({ paid: 45, unpaid: 2 }), ledger = buildAnnualSubscriptionOpening(f).document;
  const first = ledger.history.entries[0]; first.lastAttemptAt = '2026-09-09T18:15:00.000Z'; ledger.ready = true;
  assert.equal(annualHistory.admissionReady(ledger), false);
  const out = nodeRun('reconcile_expand', { payload: [ledger, ...f.ledgerEvidence.rows] });
  assert.equal(out.payload.length, 40); assert.equal(out.payload.some(j => j.transactionId === first.transactionId), false);
  assert.equal(out.payload.every(j => j.documentType === 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1'), true);
  const prepared = nodeRun('reconcile_record', { payload: out.payload[0] });
  const token = nodeRun('confirm_resolve', prepared);
  const lookup = nodeRun('purchase_router', { ...token[0], statusCode: 200, payload: { access_token: 'fixture-token' } });
  assert.equal(lookup[4]._summerSubscriptionCtx.step, 'annual_history_begin');
  const found = nodeRun('piter_atomic_router', lookup[4]);
  assert.deepEqual(found[0].payload, { _id: ledger._id });
});
test('configuration persists by reload and permits selective annual and RA/friendship stops', () => {
  const config = { kind: 'SUBSCRIPTION_SALES_CONFIGURATION_V1', revision: 4,
    common: true, hub: true, piter: true, raClosed: false, friendshipClosed: false };
  const fresh = c => { const map = new Map(); const result = loadSubscriptionSalesConfiguration(JSON.stringify(c), { set: (k,v) => map.set(k,v) }); return { map, result }; };
  assert.deepEqual(fresh(config), fresh(config));
  for (const target of ['hub', 'piter']) {
    const result = fresh({ ...config, [target]: false });
    assert.equal(result.result.valid, true); assert.equal(result.map.get('summer_subscription_sales_20260909_enabled'), true);
    assert.equal(result.map.get('summer_subscription_ra_admission_closed'), false);
  }
  assert.equal(fresh({ ...config, injected: true }).result.valid, false);
  assert.equal(fresh({ ...config, common: 'true' }).result.valid, false);
});
test('activation checks immutable local mapping and preserves frozen baseline and quota', () => {
  const opening = buildAnnualSubscriptionOpening(fixture());
  const before = [...fixture().ledgerEvidence.rows, opening.document];
  const result = buildHistoryMaintenanceMutation({ opening, documents: before, action: 'activate', now });
  assert.equal(result.after.at(-1).ready, true); assert.equal(result.after.at(-1).paidCount, 18);
  const altered = structuredClone(before); altered.at(-1).history.entries.find(e => e.source === 'LOCAL').localRowId = 'foreign';
  assert.throws(() => buildHistoryMaintenanceMutation({ opening, documents: altered, action: 'activate', now }));
  assert.throws(() => buildHistoryMaintenanceMutation({ opening, documents: before, action: 'seed', now }));
});
test('maintenance grant rejects wider actions, expired windows and custody drift', () => {
  const hashKeys = ['packetDigest', 'preimageDigest', 'postimageDigest', 'crossInventoryDigest', 'deployLeaseDigest',
    'publicationDigest', 'flowSha256', 'hostIdentitySha256', 'mongoIdentitySha256', 'runtimeDefinitionDigest'];
  const expected = { operationId: 'fixture-operation-1', action: 'seed', inventoryId: annualHistory.products.network_friendship.inventoryId,
    ...Object.fromEntries(hashKeys.map(k => [k, 'a'.repeat(64)])) };
  const grant = { ...expected, kind: 'ANNUAL_HISTORY_MAINTENANCE_GRANT_V1', issuedAt: now, expiresAt: '2026-09-09T18:18:00.000Z' };
  assert.equal(validateHistoryMaintenanceGrant(grant, expected, { now }), grant);
  for (const mutation of [g => { g.action = 'start'; }, g => { g.providerPostAllowed = true; },
    g => { g.postimageDigest = 'b'.repeat(64); }, g => { g.expiresAt = now; }]) {
    const bad = structuredClone(grant); mutation(bad); assert.throws(() => validateHistoryMaintenanceGrant(bad, expected, { now }));
  }
  const initialRuntime = { status: 'stopped', pid: 0, restartCount: 1, salesFlagsOff: true, definitionDigest: expected.runtimeDefinitionDigest };
  const quiescence = { kind: 'ANNUAL_HISTORY_QUIESCENCE_V1', operationId: expected.operationId,
    inventoryId: expected.inventoryId, hostIdentitySha256: expected.hostIdentitySha256, mongoIdentitySha256: expected.mongoIdentitySha256,
    externalWritersPaused: true, runtimeStopped: true, checkedAt: now, expiresAt: grant.expiresAt };
  const proof = { grant, expected, initialRuntime, currentRuntime: initialRuntime, publicationDigest: expected.publicationDigest,
    flowSha256: expected.flowSha256, quiescence, lockHeld: true, now };
  assert.doesNotThrow(() => assertHistoryMaintenanceCustody(proof));
  for (const change of [p => { p.lockHeld = false; }, p => { p.currentRuntime.definitionDigest = 'b'.repeat(64); },
    p => { p.currentRuntime.restartCount++; }, p => { p.quiescence.externalWritersPaused = false; }]) {
    const bad = structuredClone(proof); bad.currentRuntime = { ...bad.currentRuntime }; change(bad);
    assert.throws(() => assertHistoryMaintenanceCustody(bad));
  }
});
test('maintenance does not steal an active or unresolved deployment lease', () => {
  const lease = { formatVersion: 2, phase: 'soaking', deploymentId: 'fixture-deploy', token: 'fixture-token',
    acquiredAtMs: Date.parse(now) - 20000, expiresAtMs: Date.parse(now) - 10000,
    sourceSha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64) };
  assert.equal(assertHistoryDeployLease(lease, now), historyDigest(lease));
  assert.equal(assertHistoryDeployLease(null, now), historyDigest(null));
  for (const change of [l => { l.expiresAtMs = Date.parse(now) + 10000; }, l => { l.phase = 'applying'; },
    l => { l.phase = 'rollback-restart-required'; }, l => { l.formatVersion = 1; }]) {
    const bad = structuredClone(lease); change(bad); assert.throws(() => assertHistoryDeployLease(bad, now));
  }
});

test('new schema3 Piter confirms canonical charged amounts and retains expired UNPAID', () => {
  const f = fixture({ counterKey: 'piter_friendship', paid: 42, localPaid: 40 });
  const x = late(f, 42); x.t.id = 'fixture-new-atomic-transaction';
  const context = { step: 'confirm_lookup', counterKey: f.counterKey, inventoryId: annualHistory.products.piter_friendship.inventoryId,
    inventoryLedgerSchemaVersion: 3, transactionId: x.t.id, productId: x.t.products[0].id, clientId: x.t.client.id,
    clientPhone: FIXTURE_PHONE, expectedAmountMinor: 1980000, paymentRef: 'fixture-new-payment',
    requestFingerprint: 'fixture-fingerprint', dispatchGeneration: 0,
    saleRecord: { inventoryLedgerSchemaVersion: 3, providerProductCostMinor: 5680000, discountMinor: 3700000 } };
  const paid = nodeRun('purchase_router', { statusCode: 200, payload: x.t, _summerSubscriptionCtx: structuredClone(context) });
  assert.equal(paid[4]._summerSubscriptionCtx.confirmResult.nextStatus, 'PAID');
  assert.equal(paid[4]._summerSubscriptionCtx.confirmResult.toPayMinor, 1980000);
  const lookup = nodeRun('piter_atomic_router', paid[4]);
  assert.equal(lookup[0]._summerSubscriptionCtx.step, 'piter_confirm_validate');
  const ledger = buildAnnualSubscriptionOpening(f).document;
  ledger.reservations.push({ paymentRef: context.paymentRef, transactionId: x.t.id, state: 'PAYMENT_PENDING',
    intentFingerprint: 'fixture-intent', requestFingerprint: context.requestFingerprint, priceMinor: 1980000,
    dispatchGeneration: 0, saleRecord: { inventoryLedgerSchemaVersion: 3 } });
  Object.assign(ledger, annualHistory.counts(ledger));
  const update = nodeRun('piter_atomic_router', { ...lookup[0], payload: [ledger] });
  assert.equal(update[1].payload[1].$inc.paidCount, 1); assert.equal(update[1].payload[0].ready, false);
  const badContext = { ...lookup[0]._summerSubscriptionCtx, inventoryLedgerSchemaVersion: undefined, step: 'piter_confirm_validate' };
  const bad = nodeRun('piter_atomic_router', { payload: [ledger], _summerSubscriptionCtx: badContext });
  assert.equal(bad[3].statusCode, 503);
  const unpaid = { ...x.t, status: 'UNPAID', paymentDate: null };
  const pending = nodeRun('purchase_router', { statusCode: 200, payload: unpaid, _summerSubscriptionCtx: structuredClone(context) });
  assert.equal(pending[4]._summerSubscriptionCtx.confirmResult.nextStatus, 'PAYMENT_PENDING');
  for (const change of [t => { t.toPay = 0; }, t => { t.sum = 1980000; }, t => { t.clientId = 'foreign'; },
    t => { t.refundSum = 1; }, t => { t.status = 'REFUND'; t.refundedAt = now; t.refundSum = 1; }]) {
    const t = structuredClone(x.t); change(t);
    const denied = nodeRun('purchase_router', { statusCode: 200, payload: t, _summerSubscriptionCtx: structuredClone(context) });
    assert.equal(denied[2].statusCode, 503);
  }
});
test('activation recovery reconstructs the same timestamp after execution-time drift', () => {
  const f = fixture(), opening = buildAnnualSubscriptionOpening(f), documents = [...f.ledgerEvidence.rows, opening.document];
  const actual = buildHistoryMaintenanceMutation({ opening, documents, action: 'activate', now: '2026-09-09T18:15:00.000Z' });
  const recovered = buildHistoryMaintenanceMutation({ opening, documents, action: 'activate', now });
  assert.deepEqual(actual.after, recovered.after);
});

test('schema3 HAB finds one exact issued instance across complete pages before any payment CAS', () => {
  const f = fixture(), x = late(f, 18);
  x.s.activationDate = '2026-09-10T00:00:00'; x.s.expirationDate = '2027-09-10T00:00:00';
  const ctx = { step: 'confirm_lookup', counterKey: f.counterKey, inventoryId: annualHistory.products[f.counterKey].inventoryId, inventoryLedgerSchemaVersion: 3,
    transactionId: x.t.id, productId: x.t.products[0].id, clientId: x.t.client.id, clientPhone: FIXTURE_PHONE,
    expectedAmountMinor: 1980000, paymentRef: 'fixture-new-payment', hubLk1Sale: JSON.parse(fs.readFileSync(new URL('../annual_subscription_history_binding.json', import.meta.url))).hubEvidence.receipt,
    saleRecord: { inventoryLedgerSchemaVersion: 3, providerProductCostMinor: 5680000, discountMinor: 3700000 } };
  const start = () => nodeRun('purchase_router', { statusCode: 200, payload: structuredClone(x.t), _summerSubscriptionCtx: structuredClone(ctx) });
  const request = start();
  assert.equal(request[0].method, 'GET'); assert.match(request[0].url, /includeFinished=true&size=200&page=0$/);
  assert.equal(Boolean(request[4]), false);
  const page = (rows, number = 0, totalPages = 1, totalElements = rows.length) => ({ content: rows,
    number, totalPages, totalElements, numberOfElements: rows.length, last: number === totalPages - 1 });
  const run = (request, payload) => nodeRun('purchase_router', { ...request[0], statusCode: 200, payload });
  const next = run(request, page([{ ...x.s, subscriptionId: 'unrelated', transactionId: 'unrelated' }], 0, 2, 2));
  assert.equal(next[0].method, 'GET'); assert.match(next[0].url, /page=1$/); assert.equal(Boolean(next[4]), false);
  const linked = run(next, page([x.s], 1, 2, 2));
  assert.equal(linked[4]._summerSubscriptionCtx.step, 'piter_confirm_result');
  assert.equal(linked[4]._summerSubscriptionCtx.clientSubscriptionId, x.s.subscriptionId);
  assert.equal(linked[4]._summerSubscriptionCtx.confirmResult.nextStatus, 'PAID');
  const ack = nodeRun('piter_atomic_router', { payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null },
    _summerSubscriptionCtx: { ...linked[4]._summerSubscriptionCtx, step: 'piter_confirm_ledger_ack' } });
  assert.ok(ack[4], JSON.stringify(ack));
  assert.match(ack[4].url, /includeFinished=true&size=200&page=0$/);
  const postPage = nodeRun('purchase_router', { ...ack[4], statusCode: 200,
    payload: page([{ ...x.s, subscriptionId: 'unrelated', transactionId: 'unrelated' }], 0, 2, 2) });
  assert.match(postPage[0].url, /page=1$/);
  const projected = run(postPage, page([x.s], 1, 2, 2));
  assert.equal(projected[4]._summerSubscriptionCtx.step, 'managed_sale_projection_start');
  assert.equal(projected[4]._summerSubscriptionCtx.managedSaleProjection.set.managedBindingState, 'LK1_VIVA_CONFIRMED');
  assert.equal(projected[4]._summerSubscriptionCtx.managedSaleProjection.set.clientSubscriptionId, x.s.subscriptionId);
  assert.equal(projected[4]._summerSubscriptionCtx.managedSaleProjection.set.providerExpectedActivationDate, '2026-09-10');
  for (const payload of [page([]), page([x.s, x.s]), page([{ ...x.s, clientId: 'foreign' }]),
    page([{ ...x.s, transactionId: 'foreign' }]), { ...page([x.s]), totalElements: 2 },
    { ...page([x.s]), number: 1 }, { content: [x.s] }]) {
    const denied = run(start(), payload);
    assert.equal(Boolean(denied[4]), false); assert.equal(denied[2].statusCode, 503);
  }
});

test('schema3 missing-transaction recovery matches canonical discounted PAID and rejects changed facts', () => {
  const f = fixture({ counterKey: 'piter_friendship', paid: 42, localPaid: 40 }), x = late(f, 42);
  x.t.createDate = now; x.t.studioId = 'fixture-studio';
  const ctx = { step: 'confirm_recovery_list', counterKey: f.counterKey, inventoryLedgerSchemaVersion: 3,
    productId: x.t.products[0].id, clientId: x.t.client.id, clientPhone: FIXTURE_PHONE,
    studioId: x.t.studioId, providerAttemptedAt: now, httpRequestTimeoutMs: 30000,
    expectedAmountMinor: 1980000, paymentRef: 'fixture-payment',
    saleRecord: { inventoryLedgerSchemaVersion: 3, providerProductCostMinor: 5680000, discountMinor: 3700000 } };
  const run = t => nodeRun('purchase_router', { statusCode: 200, payload: { content: [t], number: 0,
    totalPages: 1, totalElements: 1, numberOfElements: 1, last: true }, _summerSubscriptionCtx: structuredClone(ctx) });
  const found = run(x.t); assert.equal(found[0].method, 'GET');
  assert.equal(found[0]._summerSubscriptionCtx.transactionId, x.t.id);
  for (const change of [t => { t.toPay = 0; }, t => { t.sum = 1980000; }, t => { t.studioId = 'foreign'; },
    t => { t.products[0].discount--; }, t => { t.refundSum = 1; }]) {
    const t = structuredClone(x.t); change(t); assert.equal(run(t)[2].statusCode, 503);
  }
});

test('maintenance dry-run rebuilds both products and rejects stale evidence and runtime drift', async () => {
  const { runAnnualHistoryMaintenance } = await import('../manage_annual_subscription_history.mjs');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const binding = JSON.parse(fs.readFileSync(new URL('../annual_subscription_history_binding.json', import.meta.url)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annual-history-fixture-'));
  try {
    for (const key of ['network_friendship', 'piter_friendship']) {
      const evidence = fixture({ counterKey: key, paid: key === 'network_friendship' ? 18 : 42 });
      evidence.runtimeBinding.flowSha256 = binding.candidateSha256;
      const opening = buildAnnualSubscriptionOpening(evidence);
      const packetFile = path.join(dir, 'packet.json'), ledgerFile = path.join(dir, 'rows.json');
      for (const action of ['reconcile-refunds', 'seed', 'activate']) {
        const packet = { kind: 'ANNUAL_HISTORY_MAINTENANCE_PACKET_V1', preparedAt: now, evidence, action, operationId: 'fixture-operation-1' };
        fs.writeFileSync(packetFile, JSON.stringify(packet), { mode: 0o600 });
        fs.writeFileSync(ledgerFile, JSON.stringify([...evidence.ledgerEvidence.rows, ...(action === 'activate' ? [opening.document] : [])]), { mode: 0o600 });
        const options = { packetFile, ledgerFile, action, apply: false };
        const result = await runAnnualHistoryMaintenance(options, { now: () => now });
        assert.equal(result.mutationPerformed, false); assert.equal(result.executionAuthorized, false);
        assert.equal(result.mutationCount, action === 'reconcile-refunds' ? 0 : 1);
        await assert.rejects(runAnnualHistoryMaintenance(options, { now: () => '2026-09-09T18:20:00.000Z' }));
        packet.evidence.runtimeBinding.flowSha256 = '0'.repeat(64);
        fs.writeFileSync(packetFile, JSON.stringify(packet));
        await assert.rejects(runAnnualHistoryMaintenance(options, { now: () => now }), /reviewed runtime candidate/);
        evidence.runtimeBinding.flowSha256 = binding.candidateSha256;
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('annual candidate binds every changed source and rejects a foreign flow before composition', async () => {
  const { createHash } = await import('node:crypto');
  const { buildAnnualHistoryCandidate } = await import('../prepare_annual_subscription_history_candidate.mjs');
  const binding = JSON.parse(fs.readFileSync(new URL('../annual_subscription_history_binding.json', import.meta.url)));
  for (const target of [...binding.targets, binding.expander]) {
    const source = fs.readFileSync(new URL(`../nodered_games_nodes/${target.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), target.sourceTextSha256);
  }
  assert.throws(() => buildAnnualHistoryCandidate({ liveBytes: Buffer.from('[]'), sourceTexts: {}, binding }), /preimage drift/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSubscriptionPaymentPolling } from '../lib/subscriptionPaymentPolling.mjs';
import { syncPaymentPolling } from '../sync_subscription_payment_polling.mjs';
import { buildPaymentPollingCandidate, readPollingSources, pollingGeneration } from '../prepare_subscription_payment_polling_candidate.mjs';

const policy = createSubscriptionPaymentPolling();
const start = Date.parse('2026-09-14T06:00:00.000Z');
const row = (extra = {}) => ({ _id: 'fixture-sale', status: 'PAYMENT_PENDING', transactionId: 'fixture-transaction',
  paymentRef: 'fixture-ref', createdAt: new Date(start).toISOString(), paymentUrl: 'https://fixture.invalid/pay', ...extra });
const clone = value => structuredClone(value);
const source = name => fs.readFileSync(new URL(`../nodered_games_nodes/fn_tournament_subscription_${name}.js`, import.meta.url), 'utf8');
export function runPollingNode(name, msg, { now = start, ...extra } = {}) {
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  return vm.runInNewContext(`(function(msg,node,context,global,env){${source(name)}\n})(msg,node,context,global,env)`, {
    msg, Date: FixedDate, URL, URLSearchParams, node: {}, context: {},
    global: { get: () => undefined }, env: { get: () => 'fixture-auth' }, ...extra });
}
const admission = (record, reconcile = true) => ({ _paymentPollingRecord: clone(record),
  _summerSubscriptionCtx: { action: 'confirm', reconcile }, payload: [clone(record)] });

test('20 minutes OR ten attempts, equality boundaries and malformed dates fail closed', () => {
  assert.equal(policy.state(row(), start + 1_199_999).closed, false);
  assert.equal(policy.state(row(), start + 1_200_000).closed, true);
  assert.equal(policy.state(row({ paymentPolling: { checks: 9 } }), start).closed, false);
  assert.equal(policy.state(row({ paymentPolling: { checks: 10 } }), start).reason, 'PAYMENT_CHECK_LIMIT');
  for (const createdAt of [undefined, null, 'invalid', '2026-09-14T06:00:00', new Date(start + 1).toISOString()]) {
    assert.equal(policy.plan(row({ createdAt }), { now: start }).dispatch, false);
  }
  assert.equal(policy.state(row({ paymentPolling: { checks: -1 } }), start).closed, true);
});
test('ten actual admissions persist across restarts; a lost response consumes its attempt', () => {
  const saved = row();
  for (let i = 0; i < 10; i++) {
    const p = createSubscriptionPaymentPolling(); // no process-local attempt state
    const plan = p.plan(saved, { now: start + i * 120_000 });
    assert.equal(plan.dispatch, true);
    saved.paymentPolling = plan.value;
    assert.equal(p.plan(saved, { now: start + i * 120_000 + 1 }).dispatch, false);
  }
  assert.equal(saved.paymentPolling.checks, 10);
  assert.equal(saved.paymentPolling.status, 'FAILED');
  assert.equal(policy.plan(saved, { now: start + 20 * 60_000 }).dispatch, false);
  assert.equal(saved.status, 'PAYMENT_PENDING');
  const paid = policy.response({ status: 'PAID', paid: true }, saved);
  assert.equal(paid.status, 'PAID');
});
test('archive keeps provider deadline and financial state, slow readback never reopens checkout', () => {
  const saved = row({ expiresAt: '2026-09-14T09:00:00.000Z' });
  const expired = policy.plan(saved, { now: start + 20 * 60_000, recovery: true });
  assert.equal(expired.dispatch, false);
  saved.paymentPolling = expired.value;
  assert.equal(saved.status, 'PAYMENT_PENDING');
  assert.equal(saved.expiresAt, '2026-09-14T09:00:00.000Z');
  const later = start + 80 * 60_000;
  assert.equal(policy.plan(saved, { now: later, recovery: false }).dispatch, false);
  const recovery = policy.plan(saved, { now: later, recovery: true });
  assert.equal(recovery.dispatch, true); assert.equal(recovery.value.checks, 0);
  assert.equal(recovery.value.recoveryChecks, 1);
  const body = policy.response({ status: 'PAYMENT_PENDING', response: { paymentUrl: saved.paymentUrl } }, saved, later);
  assert.equal(body.status, 'FAILED'); assert.equal(body.paymentUrl, null); assert.equal(body.response, undefined);
  assert.equal(policy.response({ status: 'PAID', paid: true }, saved, later).paid, true);
});
test('gate requires a no-upsert acknowledged CAS before dispatch; concurrent claims have one preimage', () => {
  const first = runPollingNode('poll_admit', admission(row()));
  const second = runPollingNode('poll_admit', admission(row()));
  assert.deepEqual(JSON.parse(JSON.stringify(first[0].payload)), JSON.parse(JSON.stringify(second[0].payload)));
  const [filter, update, options] = first[0].payload;
  assert.equal(filter._id, 'fixture-sale'); assert.equal(filter.status, 'PAYMENT_PENDING');
  assert.equal(filter.paymentPolling.$exists, false); assert.equal(options.upsert, false);
  assert.equal(options.includeResultMetadata, false); assert.equal(options.returnDocument, 'after');
  assert.deepEqual(Object.keys(update.$set), ['paymentPolling']);
  assert.equal(runPollingNode('poll_ack', { ...second[0], payload: null }), null);
  const updated = row({ paymentPolling: clone(update.$set.paymentPolling) });
  const ack = runPollingNode('poll_ack', { ...first[0], payload: updated });
  assert.equal(ack[0]._paymentPollingAdmitted, true);
  assert.equal(ack[0].payload[0].paymentPolling.checks, 1);
  const unproven = runPollingNode('poll_ack', { ...runPollingNode('poll_admit', admission(row(), false))[0], payload: null });
  assert.equal(unproven[1].statusCode, 409);
  const error = runPollingNode('poll_ack', { ...first[0], _summerSubscriptionCtx: { reconcile: false }, error: { message: 'fixture timeout' } });
  assert.equal(error[0], null); assert.equal(error[1].statusCode, 503);
  const drift = runPollingNode('poll_ack', { ...first[0], _summerSubscriptionCtx: { reconcile: false }, payload: row({ paymentPolling: { checks: 2 } }) });
  assert.equal(drift[1].statusCode, 409);
});
test('confirm cannot bypass admission; a cached archived response never requests Viva', () => {
  const request = { payload: [row()], _summerSubscriptionCtx: { action: 'confirm', paymentRef: 'fixture-ref' } };
  const selected = runPollingNode('confirm_resolve', request);
  assert.ok(selected[4]); assert.equal(selected[0], null);
  const stopped = runPollingNode('confirm_resolve', { ...selected[4], _paymentPollingAdmitted: true,
    _paymentPollingStopped: true, payload: [row({ paymentPolling: { checks: 10, status: 'FAILED' } })] });
  assert.equal(stopped[0], null); assert.equal(stopped[1].payload.status, 'FAILED'); assert.equal(stopped[1].payload.paymentUrl, null);
});
test('binding and dispatch recovery claim a cooldown without consuming checkout attempts', () => {
  for (const status of ['PAID_PENDING_INSTANCE_BINDING', 'DISPATCH_REPAIRING', 'DISPATCHING']) {
    const out = runPollingNode('poll_admit', admission(row({ status, createdAt: '2020-01-01T00:00:00.000Z' })));
    assert.ok(out[0]); assert.equal(out[0]._paymentPollingClaim.value.checks, 0);
    assert.equal(out[0]._paymentPollingClaim.value.nextCheckAt, new Date(start + 120_000).toISOString());
    assert.equal(out[0]._paymentPollingClaim.dispatch, true);
  }
  assert.ok(runPollingNode('poll_admit', admission(row({ status: 'PAID' })))[1]);
});
test('history CAS archives metadata without changing fact, local preimage or ledger quota', () => {
  const fact = { state: 'UNPAID', productId: 'fixture-product' };
  const job = { _id: 'fixture-ledger', transactionId: 'fixture-history',
    documentType: 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1', pollingFact: fact,
    pollingRow: { status: 'UNPAID', transactionId: 'fixture-history', createdAt: row().createdAt } };
  const out = runPollingNode('poll_admit', admission(job), { now: start + 20 * 60_000 });
  assert.equal(out[0]._paymentPollingClaim.dispatch, false);
  assert.deepEqual(Object.keys(out[0].payload[1].$set), ['history.entries.$.paymentPolling']);
  assert.equal(out[0].payload[0]['history.entries'].$elemMatch.fact.state, 'UNPAID');
});
test('large legacy backlog and multiple ledgers expand to at most60, with history budget20', () => {
  const docs = Array.from({ length: 679 }, (_, i) => row({ _id: `sale-${i}`, transactionId: `tx-${i}` }));
  const ledger = n => ({ _id: `ledger-${n}`, schemaVersion: 3, history: { version: 1,
    entries: Array.from({ length: 100 }, (_, i) => ({ transactionId: `history-${n}-${i}`, fact: { state: 'UNPAID' } })) }, documentType: 'HUB_ATOMIC_INVENTORY_LEDGER' });
  const expanded = runPollingNode('reconcile_expand', { payload: [ledger(1), ledger(2), ...docs] });
  assert.equal(expanded.payload.length, 60);
  assert.equal(expanded.payload.filter(d => d.documentType === 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1').length, 20);
  for (const d of expanded.payload) assert.equal(d.history, undefined);
});
test('dispatcher holds one batch across overlapping ticks and emits only single records', () => {
  const values = new Map(), timers = [], sent = []; let done = 0;
  const runtime = { context: { get: k => values.get(k), set: (k,v) => values.set(k,v) },
    node: { send: m => sent.push(m), done: () => done++ }, setTimeout: f => timers.push(f) };
  const input = { payload: Array.from({ length: 679 }, (_, i) => row({ _id: `sale-${i}` })), query: { huge: true } };
  runPollingNode('reconcile_dispatch', input, runtime);
  for (let i = 0; i < 100; i++) runPollingNode('reconcile_dispatch', input, runtime);
  assert.equal(timers.length, 1); assert.equal(sent.length, 1);
  while (timers.length) timers.shift()();
  assert.equal(sent.length, 60); assert.equal(done, 1); assert.equal(values.get('batchActive'), false);
  assert.equal(sent.every(m => Object.keys(m).join() === 'payload' && !Array.isArray(m.payload)), true);
  runPollingNode('reconcile_dispatch', { payload: [row()] }, runtime);
  assert.equal(sent.length, 61);
});
test('Mongo4 query passes cursor options before materializing results', () => {
  const prepared = runPollingNode('reconcile_query', {});
  const calls = [];
  const collection = { find: (...args) => { calls.push(args); return { toArray: () => [] }; } };
  // Installed mongodb4 v3.4 dispatches these payload arguments verbatim.
  collection.find(...prepared.payload).toArray();
  assert.equal(calls[0][1].limit, 60);
  assert.deepEqual(Object.keys(calls[0][1].sort), ['paymentPolling.nextCheckAt', '_id']);
  assert.equal(prepared.limit, undefined);
});
test('generated copies and candidate source hashes are exact', () => {
  syncPaymentPolling({ check: true });
  const texts = readPollingSources();
  for (const target of [...pollingGeneration.targets, ...pollingGeneration.additions]) assert.ok(texts[target.fileName]);
  assert.throws(() => buildPaymentPollingCandidate({ liveBytes: Buffer.from('[]'), sourceTexts: texts }), /missing/);
});

test('focused candidate proves old queue has no other input and adds a scoped Mongo error route', async () => {
  const { createHash } = await import('node:crypto');
  const hash = x => createHash('sha256').update(x).digest('hex');
  const texts = readPollingSources(), generation = clone(pollingGeneration);
  const tab = 'fixture-tab', original = 'return msg;';
  const graph = [ { id: tab, type: 'tab', disabled: false }, { id: 'fixture-mongo', type: 'mongodb4-client' },
    { id: 'ab1e202650000003', type: 'mongodb4', z: tab, clientNode: 'fixture-mongo', collection: 'lk_tournament_subscription_sales', operation: 'find', wires: [['annual_history_expand_20260909']] },
    { id: 'ab1e202650000004', type: 'split', z: tab, wires: [['ab1e202650000005']] },
    { id: 'ab1e202650000005', type: 'delay', z: tab, wires: [['ab1e202650000006']] },
    { id: 'ab1e202650000006', type: 'function', z: tab, wires: [['ca022fd14027a5b0']] },
    ...['fdc3f25f39199546', '10fe94a32b8adc35', '03cc3ac17f7e154a'].map(id => ({ id, type: 'function', z: tab, wires: [[]] })),
  ];
  for (const t of generation.targets) {
    t.preimageSha256 = hash(original);
    t.candidateSha256 = hash(texts[t.fileName]); // this fixture supplies its own generation

    graph.push({ id: t.id, type: 'function', z: tab, func: original, outputs: t.id === 'ca022fd14027a5b0' ? 4 : 1,
      wires: t.id === 'ab1e202650000002' ? [['ab1e202650000003']]
        : t.id === 'annual_history_expand_20260909' ? [['ab1e202650000004']]
          : t.id === 'ca022fd14027a5b0' ? [['fdc3f25f39199546'], ['10fe94a32b8adc35'], ['03cc3ac17f7e154a'], ['piter_atomic_router_20260903']] : [[]] });
  }
  for (const t of generation.additions) t.candidateSha256 = hash(texts[t.fileName]);
  const build = input => buildPaymentPollingCandidate({ liveBytes: Buffer.from(JSON.stringify(input)), sourceTexts: texts, generation });
  const built = build(graph), candidate = JSON.parse(built.candidateBytes);
  assert.equal(built.report.addedNodeIds.length, 5);
  const catcher = candidate.find(n => n.type === 'catch');
  assert.deepEqual(catcher.scope, ['subscription_poll_cas_20260914']);
  assert.deepEqual(catcher.wires, [['subscription_poll_ack_20260914']]);
  assert.deepEqual(candidate.find(n => n.id === 'annual_history_expand_20260909').wires, [['subscription_poll_dispatch_20260914']]);
  for (const target of ['ab1e202650000004', 'ab1e202650000005', 'ab1e202650000006']) {
    assert.throws(() => build([...graph, { id: 'foreign', type: 'function', wires: [[target]] }]), /incoming edge drift/);
  }
  const badClient = clone(graph); badClient.find(n => n.id === 'fixture-mongo').type = 'unknown';
  assert.throws(() => build(badClient), /client drift/);
  const foreign = clone(graph); foreign.find(n => n.id === generation.targets[0].id).func += '\n// foreign';
  assert.throws(() => build(foreign), /source drift/);
});


test('explicit no-transaction archives survive foreground admission and preserve recovery', () => {
  for (const status of ['PAYMENT_PENDING', 'PROVIDER_UNKNOWN']) {
    for (const transactionId of [undefined, null, '']) {
      const saved = row({ status, transactionId, createdAt: undefined,
        paymentPolling: { status: 'FAILED', checks: 0, reason: 'LEGACY_MISSING_TRANSACTION_ID',
          archivedAt: new Date(start).toISOString(), nextCheckAt: new Date(start + policy.recoveryMs).toISOString() } });
      const preimage = clone(saved), later = start + policy.recoveryMs;
      assert.deepEqual(policy.plan(saved, { now: later }), { dispatch: false, value: null });
      assert.deepEqual(saved, preimage);
      const recovery = policy.plan(saved, { now: later, recovery: true });
      assert.equal(recovery.dispatch, true);
      assert.equal(recovery.value.status, 'FAILED');
      assert.equal(recovery.value.checks, 0);
      assert.equal(recovery.value.recoveryChecks, 1);
      assert.equal(recovery.value.archivedAt, preimage.paymentPolling.archivedAt);
      assert.equal(recovery.value.nextCheckAt, new Date(later + policy.recoveryMs).toISOString());
      const next = { ...saved, paymentPolling: recovery.value };
      const stopped = runPollingNode('poll_admit', admission(next, false), { now: later + policy.recoveryMs });
      assert.equal(stopped[0], null);
      assert.equal(stopped[1]._paymentPollingStopped, true);
      const response = runPollingNode('confirm_resolve', stopped[1], { now: later + policy.recoveryMs });
      assert.equal(response[0], null);
      assert.equal(response[1].payload.status, 'FAILED');
      assert.equal(response[1].payload.archived, true);
      assert.equal(response[1].payload.paymentUrl, null);
      const paid = { ...next, status: 'PAID', transactionId: 'late-provider-transaction' };
      assert.equal(policy.response({ status: 'PAID', paid: true }, paid).paid, true);
    }
  }
});

test('unarchived missing-transaction recovery is not treated as an expired checkout', () => {
  const saved = row({ status: 'PROVIDER_UNKNOWN', transactionId: null, createdAt: undefined });
  const recovery = policy.plan(saved, { now: start, recovery: true });
  assert.equal(recovery.dispatch, true);
  assert.equal(recovery.value.status, 'ACTIVE');
  assert.equal(recovery.value.checks, 0);
  assert.equal(recovery.value.nextCheckAt, new Date(start + policy.intervalMs).toISOString());
});


test('archive successor pins match current sources without rewriting the original generation', async () => {
  const { createHash } = await import('node:crypto');
  const { newestReviewedSourceSha256 } = await import('../lib/subscriptionSourceGenerationPins.mjs');
  const archive = JSON.parse(fs.readFileSync(new URL('../subscription_payment_archive_generation.json', import.meta.url)));
  const oldTargets = [...pollingGeneration.targets, ...pollingGeneration.additions];
  assert.equal(archive.targets.length, 4);
  for (const target of archive.targets) {
    assert.equal(target.preimageSha256, oldTargets.find(t => t.fileName === target.fileName).candidateSha256);
    assert.equal(target.candidateSha256, createHash('sha256').update(fs.readFileSync(new URL('../nodered_games_nodes/' + target.fileName, import.meta.url))).digest('hex'));
    assert.equal(newestReviewedSourceSha256(target.fileName), target.candidateSha256);
  }
});


test('missing-transaction terminal response maps an explicit archive after recovery admission', () => {
  const saved = row({ transactionId: null, paymentPolling: { status: 'FAILED', checks: 0,
    reason: 'LEGACY_MISSING_TRANSACTION_ID', archivedAt: new Date(start).toISOString() } });
  const response = runPollingNode('confirm_resolve', { _paymentPollingAdmitted: true,
    payload: [saved], _summerSubscriptionCtx: { action: 'confirm', paymentRef: saved.paymentRef } });
  assert.equal(response[0], null);
  assert.equal(response[1].payload.status, 'FAILED');
  assert.equal(response[1].payload.archived, true);
  assert.equal(response[1].payload.paymentUrl, null);
});

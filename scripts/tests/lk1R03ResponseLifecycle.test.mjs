import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';
import { patchR03ResponseSources, r03Generation } from '../patch_lk1_r03_response_sources.mjs';
import { buildExactGraphContract, validateExactGraphContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const source = name => fs.readFileSync(new URL(`../nodered_games_nodes/fn_tournament_subscription_${name}.js`, import.meta.url), 'utf8');
const baseline = '504d008502c9f40c96526b761b4e3de0a31f01dc';
const r03CandidateRevision = 'bfa2073f44ec8f1dad7518a60550f46d0687933f';
const r03SourceTexts = Object.fromEntries(r03Generation.targets.map(target => [target.source,
  execFileSync('git', ['show', `${r03CandidateRevision}:scripts/${target.source}`], { encoding: 'utf8' })]));
const now = Date.parse('2026-10-24T06:00:00.000Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function run(name, msg, { code = source(name) } = {}) {
  const warnings = [], sent = [], state = new Map();
  const result = new Function('msg', 'node', 'context', 'global', 'env', 'Date', 'setTimeout', code)(msg,
    { warn: text => warnings.push(JSON.parse(text)), send: m => sent.push(m), done() {} },
    { get: key => state.get(key), set: (key, value) => state.set(key, value) },
    { get() {} }, { get() {} }, FixedDate,
    () => { throw Error('Unexpected timer in a single synthetic job'); });
  return { result, warnings, sent };
}
function handles() {
  const req = { method: 'POST', fixture: true };
  const res = { headersSent: false, setHeader() {}, end() {} };
  req.res = res; res.req = req; // real handles are not JSON/structuredClone data
  return { req, res };
}
// Mirror the documented RED.util.cloneMessage contract: preserve HTTP handles.
// This is a local edge model, not a claim about installed mongodb4 internals.
function cloneMessage(msg) {
  const { req, res, ...data } = msg;
  const copy = structuredClone(data);
  if (Object.hasOwn(msg, 'req')) copy.req = req;
  if (Object.hasOwn(msg, 'res')) copy.res = res;
  return copy;
}
function mongoResult(msg, payload) {
  const next = cloneMessage(msg);
  next.payload = payload;
  return next;
}
const context = extra => ({ action: 'confirm', counterKey: 'fixture-counter',
  paymentRef: 'fixture-payment', ...extra });
const warning = { event: 'subscription_confirm_background_failed',
  code: 'SUBSCRIPTION_CONFIRM_BACKGROUND_FAILED', statusCode: 503 };
const detachedLedger = () => ({ _id: 'fixture-ledger', schemaVersion: 3,
  documentType: 'PITER_ATOMIC_INVENTORY_LEDGER', counterKey: 'piter_friendship',
  inventoryId: 'fixture-inventory', revision: 1, history: { version: 1 } });
function ledgerJourney(code) {
  const job = run('reconcile_dispatch', { payload: [detachedLedger()] }).sent[0];
  assert.deepEqual(Object.keys(job), ['payload']);
  assert.equal(job.req, undefined); assert.equal(job.res, undefined);
  const prepared = run('reconcile_record', cloneMessage(job)).result;
  assert.equal(prepared._summerSubscriptionCtx.reconcile, true);
  const admission = run('confirm_resolve', prepared, { code }).result;
  assert.ok(admission[4]); assert.equal(admission[1], null);
  const claim = run('poll_admit', cloneMessage(admission[4])).result;
  assert.ok(claim[0]); assert.equal(claim[2], undefined);
  const [filter, update, options] = claim[0].payload;
  assert.equal(filter._id, 'fixture-ledger'); assert.equal(options.upsert, false);
  const saved = { ...detachedLedger(), paymentPolling: update.$set.paymentPolling };
  const ack = run('poll_ack', mongoResult(claim[0], saved)).result;
  assert.equal(ack[0]._paymentPollingAdmitted, true);
  return run('confirm_resolve', cloneMessage(ack[0]), { code });
}

test('baseline reproduces detached dispatcher -> reconcile -> CAS -> confirm HTTP without res', () => {
  const code = execFileSync('git', ['show', `${baseline}:scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js`], { encoding: 'utf8' });
  const { result } = ledgerJourney(code);
  assert.equal(result[1].res, undefined); // the actual HTTP response node would warn
  assert.equal(result[1].statusCode, 503);
  assert.equal(result[1].payload.details.code, 'ANNUAL_HISTORY_LEDGER_INVALID');
});

test('background ledger validation preserves CAS but never reaches HTTP/provider output', () => {
  const { result, warnings } = ledgerJourney(source('confirm_resolve'));
  assert.equal(result[0], null); assert.equal(result[1], null);
  assert.equal(result[2].statusCode, 503);
  assert.equal(result[2].payload.details.code, 'ANNUAL_HISTORY_LEDGER_INVALID');
  assert.deepEqual(warnings, [warning]);
});

test('background error paths suppress only HTTP and emit fixed safe diagnostics', () => {
  for (const [payload, error, statusCode] of [[null, null, 503], [[], null, 404],
    [[null], null, 503], [[], { message: 'fixture-private-body' }, 503]]) {
    const msg = { payload, error, url: 'https://fixture.invalid/private',
      _summerSubscriptionCtx: context({ reconcile: true }), _paymentPollingAdmitted: true };
    const { result, warnings } = run('confirm_resolve', msg);
    assert.equal(result[0], null); assert.equal(result[1], null);
    assert.equal(result[2].statusCode, statusCode);
    assert.deepEqual(warnings, [{ ...warning, statusCode }]);
    assert.ok(!JSON.stringify(warnings).includes('fixture-private'));
    assert.ok(!JSON.stringify(warnings).includes('fixture-payment'));
  }
});

test('background no-transaction cached result retains internal output without HTTP or warning', () => {
  const record = { status: 'FAILED', paymentRef: 'fixture-payment' };
  const { result, warnings } = run('confirm_resolve', { payload: [record],
    _paymentPollingAdmitted: true, _summerSubscriptionCtx: context({ reconcile: true }) });
  assert.equal(result[0], null); assert.equal(result[1], null);
  assert.equal(result[2].statusCode, 200); assert.equal(result[2].payload.status, 'FAILED');
  assert.deepEqual(warnings, []);
});

test('foreground error and cached success retain exact circular req/res through modeled edges', () => {
  for (const reconcile of [undefined, false, 'true']) {
    for (const payload of [[], null, [{ status: 'PAID' }], [{ status: 'FAILED' }]]) {
      const original = { ...handles(), payload, _paymentPollingAdmitted: true,
        _summerSubscriptionCtx: context({ reconcile }) };
      const { result, warnings } = run('confirm_resolve', mongoResult(original, payload));
      assert.equal(result[1].res, original.res); assert.equal(result[1].req, original.req);
      assert.equal(result[2], result[1]); assert.deepEqual(warnings, []);
      const code = execFileSync('git', ['show', `${baseline}:scripts/nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js`], { encoding: 'utf8' });
      const before = run('confirm_resolve', mongoResult(original, payload), { code }).result;
      assert.deepEqual(result, before);
    }
  }
});

test('explicit background ownership suppresses HTTP even if a handle was accidentally retained', () => {
  const { result } = run('confirm_resolve', { ...handles(), payload: [],
    _summerSubscriptionCtx: context({ reconcile: true }) });
  assert.equal(result[1], null); assert.equal(result[2].statusCode, 404);
});

test('missing foreground handle/context is not silently reclassified as background', () => {
  const { result, warnings } = run('confirm_resolve', { payload: [] });
  assert.equal(result[1].statusCode, 500); assert.deepEqual(warnings, []);
});

const tokenFailure = reconcile => ({ payload: { error: 'fixture-private-provider-body' },
  statusCode: 503, _summerSubscriptionCtx: context({ reconcile, step: 'token_confirm' }) });
test('baseline provider-error continuation also reproduces background HTTP without res', () => {
  const code = execFileSync('git', ['show', `${baseline}:scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js`], { encoding: 'utf8' });
  const { result } = run('purchase_router', tokenFailure(true), { code });
  assert.equal(result[2].res, undefined); assert.equal(result[2].statusCode, 502);
});
test('provider-error background continuation keeps internal failure but emits no HTTP or write', () => {
  const { result, warnings } = run('purchase_router', tokenFailure(true));
  assert.deepEqual(result.slice(0, 3), [null, null, null]);
  assert.equal(result[3].statusCode, 502);
  assert.deepEqual(warnings, [{ event: 'subscription_router_background_failed',
    code: 'SUBSCRIPTION_ROUTER_BACKGROUND_FAILED', statusCode: 502 }]);
  assert.ok(!JSON.stringify(warnings).includes('fixture-private'));
});
test('foreground provider-error continuation keeps original status, body and handles', () => {
  const original = { ...handles(), ...tokenFailure(false) };
  const after = run('purchase_router', cloneMessage(original));
  const code = execFileSync('git', ['show', `${baseline}:scripts/nodered_games_nodes/fn_tournament_subscription_purchase_router.js`], { encoding: 'utf8' });
  const before = run('purchase_router', cloneMessage(original), { code });
  assert.deepEqual(after.result, before.result); assert.deepEqual(after.warnings, []);
  assert.equal(after.result[2].res, original.res); assert.equal(after.result[2].req, original.req);
});

test('all nine response parents preserve foreground HTTP handles on their response edges', () => {
  for (const [name, port, extra] of [
    ['confirm_prepare', 1, {}], ['purchase_prepare', 1, {}],
    ['purchase_limit', 1, {}], ['purchase_router', 2, {}],
    ['confirm_resolve', 1, {}], ['piter_atomic_error', 0, {}],
    ['piter_atomic_router', 3, {}],
    ['poll_ack', 1, { _summerSubscriptionCtx: context({ reconcile: false }) }],
    ['poll_admit', 2, { _paymentPollingRecord: { status: 'PAYMENT_PENDING' },
      _summerSubscriptionCtx: context({ reconcile: false }) }],
  ]) {
    const original = { ...handles(), payload: {}, ...extra };
    const { result } = run(name, mongoResult(original, original.payload));
    assert.ok(result?.[port], name);
    assert.equal(result[port].res, original.res, name);
    assert.equal(result[port].req, original.req, name);
  }
});

test('existing atomic and poll guards remain silent on explicit background response edges', () => {
  for (const [name, port, extra] of [
    ['piter_atomic_error', 0, {}],
    ['piter_atomic_router', 3, { _summerSubscriptionCtx: context({ reconcile: true }) }],
    ['poll_ack', 1, {}],
    ['poll_admit', 2, { _paymentPollingRecord: { status: 'PAYMENT_PENDING' } }],
  ]) {
    const { result } = run(name, { payload: [], _summerSubscriptionCtx: context({ reconcile: true }), ...extra });
    assert.ok(result === null || result[port] === null || result[port] === undefined, name);
  }
});


test('HTTP input cannot opt into background suppression through a client payload', () => {
  const msg = { ...handles(), payload: { paymentRef: 'fixture-payment', reconcile: true,
    _summerSubscriptionCtx: { reconcile: true } } };
  const prepared = run('confirm_prepare', msg).result[0];
  assert.ok(prepared); assert.equal(prepared._summerSubscriptionCtx.reconcile, undefined);
  const failed = run('confirm_resolve', mongoResult(prepared, [])).result[1];
  assert.equal(failed.statusCode, 404); assert.equal(failed.res, msg.res);
});

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const committed = file => execFileSync('git', ['show', `${baseline}:scripts/${file}`], { encoding: 'utf8' });
function graphFixture() {
  const functions = [...r03Generation.responseParents, ...r03Generation.backgroundAnchors]
    .map(t => ({ id: t.id, z: 'fixture-tab', type: 'function', outputs: t.outputs,
      wires: structuredClone(t.wires), func: committed(t.source) }));
  const graph = [{ id: 'fixture-tab', type: 'tab', disabled: false },
    { id: '10fe94a32b8adc35', z: 'fixture-tab', type: 'http response', wires: [] }, ...functions,
    { id: 'fixture-unrelated', type: 'http in', url: '/fixture', wires: [[]] }];
  const known = new Set(graph.map(n => n.id));
  for (const n of functions) for (const port of n.wires) for (const id of port) {
    if (!known.has(id)) { graph.push({ id, z: 'fixture-tab', type: 'fixture', wires: [] }); known.add(id); }
  }
  return graph;
}

test('successor binds nine response parents and dispatcher anchors, changing only two funcs', () => {
  const original = graphFixture(), before = structuredClone(original);
  const candidate = patchR03ResponseSources(original, { sourceTexts: r03SourceTexts });
  assert.deepEqual(original, before); assert.equal(candidate.length, original.length);
  const changed = [];
  for (let i = 0; i < candidate.length; i++) {
    assert.equal(candidate[i].id, original[i].id);
    assert.deepEqual({ ...candidate[i], func: original[i].func }, { ...original[i], func: original[i].func });
    if (candidate[i].func !== original[i].func) changed.push(candidate[i].id);
  }
  assert.deepEqual(changed.sort(), r03Generation.targets.map(t => t.id).sort());
  const liveBytes = Buffer.from(JSON.stringify(original));
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'fixture-r03-response', allowedChanges: changed.map(id => ({ id, fields: ['func'] })), allowedAdditionIds: [] });
  validateExactGraphContract({ liveBytes, candidateBytes, contract });
  assert.throws(() => patchR03ResponseSources(candidate), /FUNCTION_PREIMAGE_CHANGED/);
});

test('successor fails closed on source/graph/ownership drift without mutating input', () => {
  for (const mutate of [
    g => g.push({ ...g[2] }),
    g => g.splice(g.findIndex(n => n.id === r03Generation.targets[0].id), 1),
    g => { g.find(n => n.id === 'subscription_poll_dispatch_20260914').func += '\n'; },
    g => { g.find(n => n.id === 'subscription_poll_ack_20260914').wires = [[], []]; },
    g => g.push({ id: 'fixture-foreign-parent', type: 'function', wires: [['10fe94a32b8adc35']] }),
    g => { g.find(n => n.id === '10fe94a32b8adc35').type = 'debug'; },
    g => { g.find(n => n.id === 'fixture-tab').disabled = true; },
    g => { g.find(n => n.id === 'ca022fd14027a5b0').d = true; },
  ]) {
    const graph = graphFixture(); mutate(graph); const before = structuredClone(graph);
    assert.throws(() => patchR03ResponseSources(graph, { sourceTexts: r03SourceTexts }), /FLOW_SHAPE_INVALID|FUNCTION_PREIMAGE_CHANGED|FUNCTION_GRAPH_CHANGED|RESPONSE_/);
    assert.deepEqual(graph, before);
  }
});

test('successor source pins are exact while the deployed predecessor generation stays frozen', async () => {
  const { newestReviewedSourceSha256 } = await import('../lib/subscriptionSourceGenerationPins.mjs');
  assert.equal(sha(fs.readFileSync(new URL('../lk1_error_source_generation.json', import.meta.url))),
    '42886b8b3467bb01521e8b6a1180420055b7a435aabad899bc3a156e5d927123');
  assert.equal(r03Generation.targets.length, 2); assert.equal(r03Generation.historicalCausesClosed, false);
  for (const target of r03Generation.targets) {
    assert.equal(sha(committed(target.source)), target.preimageSha256);
    assert.equal(sha(r03SourceTexts[target.source]), target.candidateSha256);
    const promo = JSON.parse(fs.readFileSync(new URL('../subscription_friendship_promo_generation.json', import.meta.url)));
    const successor = promo.targets.find(item => item.id === target.id);
    if (successor) assert.equal(successor.preimageSha256, target.candidateSha256);
    const currentHash = successor?.candidateSha256 ?? target.candidateSha256;
    assert.equal(sha(fs.readFileSync(new URL('../' + target.source, import.meta.url))), currentHash);
    assert.equal(newestReviewedSourceSha256(target.fileName), currentHash);
  }
});


test('historical R03 patch refuses an unbound newer promo source by default', () => {
  const graph = graphFixture(), before = structuredClone(graph);
  assert.throws(() => patchR03ResponseSources(graph), /FUNCTION_CANDIDATE_CHANGED/);
  assert.deepEqual(graph, before);
});

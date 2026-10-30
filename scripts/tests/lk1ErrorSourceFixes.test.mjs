import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { PITER_ATOMIC_ERROR_SOURCE } from '../lib/piterAtomicTopologyContract.mjs';
import { patchLk1ErrorSources, LK1_ERROR_SOURCE_TARGETS } from '../patch_lk1_error_sources.mjs';

const source = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const files = {
  bitrix: 'nodered_bitrix_nodes/fn_deal_list_result.js',
  purchase: 'nodered_games_nodes/fn_tournament_subscription_purchase_router.js',
  atomic: 'nodered_games_nodes/fn_tournament_subscription_piter_atomic_router.js',
  catch: 'nodered_games_nodes/fn_tournament_subscription_piter_atomic_error.js',
  confirm: 'nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js',
};
function run(key, msg) {
  const warnings = [];
  const result = new Function('msg', 'node', 'global', 'env', source(files[key]))(msg,
    { warn: text => warnings.push(JSON.parse(text)) }, { get() {} }, { get() {} });
  return { result, warnings };
}
const context = (extra = {}) => ({ action: 'confirm', counterKey: 'network_friendship',
  inventoryId: 'network_friendship_12m_2026_v1', paymentRef: 'fixture-sale',
  transactionId: 'fixture-transaction', requestFingerprint: 'fixture-fingerprint',
  clientSubscriptionId: 'fixture-subscription', ...extra });
const ack = () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null });
const responseRef = () => ({ headersSent: false, fixture: true });
function binding({ bound = false, reconcile = false } = {}) {
  const res = responseRef(), req = { fixture: true };
  const msg = { req, res, statusCode: bound ? 200 : 503,
    payload: bound ? { schemaVersion: 1, state: 'BOUND', clientSubscriptionId: 'fixture-subscription',
      subscriptionInstanceId: 'fixture-instance', policyVersion: 2 } : { error: { code: 'FIXTURE_UNAVAILABLE' } },
    _summerSubscriptionCtx: context({ step: 'managed_sale_binding_confirm', reconcile,
      managedProviderInstance: { purchasedAt: '2026-10-01T00:00:00.000Z' } }) };
  const ports = run('purchase', msg).result;
  assert.deepEqual(ports.slice(0, 4), [null, null, null, null]);
  return { msg: ports[4], req, res };
}

test('R05 rejects missing/malformed/failed upstream without emitting a false empty report', () => {
  const sensitive = 'fixture-private-provider-body';
  for (const [statusCode, payload, error, reason] of [
    [200, {}, null, 'result_shape'], [200, null, null, 'result_shape'],
    [200, { result: null }, null, 'result_shape'], [200, { result: {} }, null, 'result_shape'],
    [200, { result: sensitive }, null, 'result_shape'], [200, { result: [null] }, null, 'record_shape'],
    [200, { result: [] , error: sensitive }, null, 'provider_error'],
    [403, { result: [] }, null, 'upstream_status'], [500, { result: [] }, null, 'upstream_status'],
    [undefined, { result: [] }, null, 'upstream_status'], [200, { result: [] }, { message: sensitive }, 'transport_error'],
  ]) {
    const msg = { statusCode, payload, error, url: sensitive, user: sensitive };
    const { result, warnings } = run('bitrix', msg);
    assert.equal(result, null);
    assert.equal(msg.payload, payload);
    assert.deepEqual(warnings, [{ event: 'bitrix_deal_list_failed', code: 'BITRIX_DEAL_LIST_RESPONSE_INVALID',
      reason, upstreamStatus: statusCode ?? null }]);
    assert.ok(!JSON.stringify(warnings).includes(sensitive));
  }
});

test('R05 preserves valid empty result and deal ID mapping on the original message', () => {
  for (const result of [[], [{ ID: 'fixture-deal-a' }, { ID: 'fixture-deal-b' }]]) {
    const msg = { statusCode: 200, payload: { result } };
    const checked = run('bitrix', msg);
    assert.equal(checked.result, msg);
    assert.deepEqual(msg.payload, result.map(row => row.ID));
    assert.deepEqual(checked.warnings, []);
  }
});

test('R03 full pending/bound foreground chain retains original response through durable ACK', () => {
  for (const bound of [false, true]) {
    const { msg, req, res } = binding({ bound });
    assert.equal(msg.req, req); assert.equal(msg.res, res);
    const write = run('atomic', msg).result[1];
    assert.equal(write.req, req); assert.equal(write.res, res);
    assert.ok(Array.isArray(write.payload));
    assert.equal(write._summerSubscriptionCtx.step, 'managed_sale_projection_ack');
    write.payload = ack();
    const { result, warnings } = run('atomic', write);
    assert.deepEqual(result.slice(0, 3), [null, null, null]);
    assert.equal(result[4], null);
    assert.equal(result[3].res, res); assert.equal(result[3].req, req);
    assert.equal(result[3].statusCode, bound ? 200 : 202);
    assert.equal(result[3].payload.status, bound ? 'PAID' : 'PENDING_INSTANCE_BINDING');
    assert.deepEqual(warnings, []);
  }
});

test('R03 uncertain ACK waits for readback; match/error keeps foreground response ownership', () => {
  for (const matches of [false, true]) {
    const { msg, res } = binding();
    const write = run('atomic', msg).result[1];
    write.payload = { acknowledged: true, matchedCount: 1 };
    const lookup = run('atomic', write).result;
    assert.equal(lookup[3], null);
    const read = lookup[0]; assert.equal(read.res, res);
    read.payload = matches ? [{ ...read._summerSubscriptionCtx.managedSaleProjection.set }] : [];
    const out = run('atomic', read).result;
    assert.equal(out[3].res, res); assert.equal(out[4], null);
    assert.equal(out[3].statusCode, matches ? 202 : 503);
  }
});

test('R03 background projection success and failures emit no HTTP output or provider replay', () => {
  for (const bound of [false, true]) {
    const { msg } = binding({ bound, reconcile: true });
    assert.equal(msg.req, undefined); assert.equal(msg.res, undefined);
    const write = run('atomic', msg).result[1]; write.payload = ack();
    assert.deepEqual(run('atomic', write).result, [null, null, null, null, null]);
  }
  for (const step of ['fixture_unsupported_step', 'managed_sale_projection_start', 'managed_sale_projection_readback']) {
    const { result, warnings } = run('atomic', { payload: [],
      _summerSubscriptionCtx: context({ reconcile: true, step, token: 'fixture-private' }) });
    assert.deepEqual(result, [null, null, null, null, null]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].event, 'subscription_atomic_background_failed');
    assert.deepEqual(Object.keys(warnings[0]).sort(), ['code', 'event', 'statusCode']);
    assert.ok(!JSON.stringify(warnings).includes('fixture-private'));
  }
});

test('R03 foreground projection validation failure still returns a visible error', () => {
  const res = responseRef();
  const out = run('atomic', { res, _summerSubscriptionCtx: context({ step: 'managed_sale_projection_start' }) }).result;
  assert.equal(out[3].res, res); assert.equal(out[3].statusCode, 503);
});

test('H06 storage errors and malformed result shapes return503, never not-found or provider output', () => {
  for (const [payload, error] of [[undefined, { message: 'fixture-private-error' }], [[], { message: 'fixture-private-error' }],
    [undefined, null], [null, null], [{}, null], [[null], null], [[[]], null]]) {
    const res = responseRef();
    const { result, warnings } = run('confirm', { res, payload, error,
      _summerSubscriptionCtx: context() });
    assert.equal(result[0], null); assert.equal(result[1].res, res);
    assert.equal(result[1].statusCode, 503);
    assert.equal(result[1].payload.details.code, 'SUBSCRIPTION_CONFIRM_READ_FAILED');
    assert.ok(result.slice(3).every(x => x === null));
    assert.ok(!JSON.stringify(result[1].payload).includes('fixture-private-error'));
    assert.deepEqual(warnings, []);
  }
});

test('H06 proven empty successful read remains404; valid paid cached row retains its path', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 22) });
  const res = responseRef();
  const empty = run('confirm', { res, payload: [], _summerSubscriptionCtx: context() }).result;
  assert.equal(empty[1].statusCode, 404); assert.equal(empty[1].res, res); assert.equal(empty[0], null);
  const msg = { res, payload: [{ status: 'PAID', counterKey: 'network_friendship',
    inventoryId: 'network_friendship_12m_2026_v1', paymentRef: 'fixture-sale' }],
    _summerSubscriptionCtx: context(), _paymentPollingAdmitted: true };
  const valid = run('confirm', msg).result;
  const beforeSource = execFileSync('git', ['show', `${baseline}:scripts/${files.confirm}`], { encoding: 'utf8' });
  const reference = new Function('msg', 'node', 'global', 'env', beforeSource)(
    structuredClone({ ...msg, payload: [{ status: 'PAID', counterKey: 'network_friendship',
      inventoryId: 'network_friendship_12m_2026_v1', paymentRef: 'fixture-sale' }],
      _summerSubscriptionCtx: context(), _paymentPollingAdmitted: true }),
    { warn() {} }, { get() {} }, { get() {} });
  assert.deepEqual(valid, reference);
});

// This immutable commit is the inspected tracked preimage, not a live-flow export.
const baseline = 'da033cb9085b771acf31d20d3845fab49e566823';
function flowFixture() {
  return [{ id: 'fixture-unrelated', type: 'http in', method: 'get', url: '/fixture', wires: [[]] },
    ...LK1_ERROR_SOURCE_TARGETS.map(target => ({ id: target.id, type: 'function', name: 'fixture source', outputs: 5,
      wires: [[], [], [], [], []], func: target.id === '4cc92586174530d5'
        ? 'let id_array = [];\n\nfor (let i = 0; i < msg.payload.result.length; i++) {\n\n    id_array.push(msg.payload.result[i].ID);\n\n}\n\nmsg.payload = id_array\n\nreturn msg;'
        : target.id === 'piter_atomic_error_20260903' ? PITER_ATOMIC_ERROR_SOURCE
        : execFileSync('git', ['show', `${baseline}:scripts/${target.source}`], { encoding: 'utf8' }) }))];
}

// Exercise the immutable older patch with its immutable candidate sources. Newer
// generations must not silently rebind this historical release helper.
const historicalCandidateRevision = '504d008502c9f40c96526b761b4e3de0a31f01dc';
function historicalCandidateSource(target) {
  return execFileSync('git', ['show', `${historicalCandidateRevision}:scripts/${target.source}`], { encoding: 'utf8' });
}
function useHistoricalCandidates(t) {
  const original = fs.readFileSync;
  const sources = new Map(LK1_ERROR_SOURCE_TARGETS.map(target => [
    new URL(`../${target.source}`, import.meta.url).pathname, historicalCandidateSource(target),
  ]));
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const key = file instanceof URL ? file.pathname : String(file);
    return sources.has(key) ? sources.get(key) : original(file, ...args);
  });
}

test('offline source binding changes exactly five function bodies and preserves input/graph', t => {
  useHistoricalCandidates(t);
  const flow = flowFixture(), before = structuredClone(flow);
  const sourceTexts = Object.fromEntries(LK1_ERROR_SOURCE_TARGETS.map(target => [target.source,
    execFileSync('git', ['show', `504d008502c9f40c96526b761b4e3de0a31f01dc:scripts/${target.source}`], { encoding: 'utf8' })]));
  const candidate = patchLk1ErrorSources(flow, { sourceTexts });
  assert.deepEqual(flow, before); assert.equal(candidate.length, flow.length);
  for (let i = 0; i < candidate.length; i++) {
    assert.deepEqual({ ...candidate[i], func: flow[i].func }, { ...flow[i], func: flow[i].func });
    if (i > 0) assert.equal(candidate[i].func, sourceTexts[LK1_ERROR_SOURCE_TARGETS[i - 1].source]);
  }
  assert.throws(() => patchLk1ErrorSources(candidate), /FUNCTION_PREIMAGE_CHANGED/);
});

test('offline source binding rejects missing/duplicate/type/preimage drift without mutating input', t => {
  useHistoricalCandidates(t);
  for (const mutate of [flow => flow.pop(), flow => flow.push({ ...flow[1] }),
    flow => { flow[1].func += '\n// drift'; }, flow => { flow[1].type = 'http request'; }]) {
    const flow = flowFixture(); mutate(flow); const before = structuredClone(flow);
    assert.throws(() => patchLk1ErrorSources(flow, { sourceTexts: Object.fromEntries(LK1_ERROR_SOURCE_TARGETS.map(target => [target.source,
      execFileSync('git', ['show', `504d008502c9f40c96526b761b4e3de0a31f01dc:scripts/${target.source}`], { encoding: 'utf8' })])) }), /FLOW_SHAPE_INVALID|FUNCTION_PREIMAGE_CHANGED/);
    assert.deepEqual(flow, before);
  }
});


test('R03 Mongo catch preserves foreground503 and internal output, suppressing only background HTTP', () => {
  for (const reconcile of [false, true]) {
    const res = responseRef(), req = { fixture: true };
    const msg = { res, req, error: { message: 'fixture-private-error' },
      _summerSubscriptionCtx: context({ reconcile }) };
    const { result, warnings } = run('catch', msg);
    assert.equal(result[1], msg);
    assert.equal(result[1].statusCode, 503);
    if (reconcile) {
      assert.equal(result[0], null);
      assert.deepEqual(warnings, [{ event: 'subscription_atomic_background_failed',
        code: 'PITER_ATOMIC_MONGO_ERROR', statusCode: 503 }]);
      assert.ok(!JSON.stringify(warnings).includes('fixture-private-error'));
    } else {
      assert.equal(result[0], msg); assert.equal(result[0].res, res); assert.equal(result[0].req, req);
      assert.deepEqual(warnings, []);
    }
  }
});


test('historical error-source patch refuses the newer Friendship promo generation', () => {
  const flow = flowFixture(), before = structuredClone(flow);
  assert.throws(() => patchLk1ErrorSources(flow), /FUNCTION_CANDIDATE_CHANGED/);
  assert.deepEqual(flow, before);
});

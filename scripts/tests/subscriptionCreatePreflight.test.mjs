import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { patchSources, replaceOnce, IDS, SOURCE_SHA } from '../patch_live_subscription_create_preflight.mjs';

const fixture = process.env.LK_SUBSCRIPTION_CREATE_LIVE_FIXTURE;
let sources;
if (fixture) {
  const raw = fs.readFileSync(fixture);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), SOURCE_SHA);
  const flow = JSON.parse(raw);
  sources = patchSources(Object.fromEntries(Object.entries(IDS).map(([key, id]) => [key, flow.find(n => n.id === id).func])));
}
const liveTest = (name, fn) => test(name, { skip: !fixture && 'Requires exact private live source fixture' }, fn);
const run = (key, msg, values = {}) => new Function('msg', 'global', 'env', 'node', sources[key])(
  structuredClone(msg), { get: key => ({ vivacrm_access_token: 'fixture-token', ...values })[key], set() {} },
  { get: () => undefined }, { warn() {} },
);
function initial() {
  return { statusCode: 200, req: { headers: { authorization: 'Bearer fixture', 'idempotency-key': 'fixture-create-1' } },
    _splitCtx: { action: 'create', step: 'subscription_create_preflight_complete', subscriptionCreatePreflightDone: true,
      paymentMode: 'subscription', clientSubscriptionId: 'fixture-subscription', token: 'fixture-token',
      roomId: 'fixture-room', studioId: 'fixture-studio', date: '2026-09-10', fromTime: '17:00', toTime: '19:00' } };
}
// Enter from the actual server function immediately before exercise creation.
function start() {
  const source = sources.split.replace('if (ctx.step === "token") {', `if (ctx.step === "fixture_before_create") return continueSplitAfterVerifiedPrice(ctx);\nif (ctx.step === "token") {`);
  const msg = initial(); msg._splitCtx.step = 'fixture_before_create'; delete msg._splitCtx.subscriptionCreatePreflightDone;
  return new Function('msg', 'global', 'env', 'node', source)(msg,
    { get: () => undefined, set() {} }, { get: () => undefined }, {})[3];
}
function subscriptionStage() {
  const started = start();
  const response = run('gateway', { ...started, statusCode: 200, payload: { id: 'fixture-client', phone: '+79990000001' } });
  assert.equal(response[0].method, 'GET');
  assert.match(response[0].url, /\/subscriptions\?/);
  return response[0];
}
function eligibleSubscription(overrides = {}) {
  return { id: 'fixture-subscription', name: 'Лето Падел Дружба', status: 'ACTIVE', expirationDate: '2100-01-01',
    visitsLeft: 100, hasStudioLimitation: false, hasTypeLimitation: true, availableTypes: [{id: '1613'}],
    hasDirectionLimitation: false, ...overrides };
}
function eligibleHistory() {
  let msg = subscriptionStage();
  let out = run('gateway', { ...msg, statusCode: 200, payload: [eligibleSubscription()] });
  assert.equal(out[0].method, 'GET'); assert.match(out[0].url, /bookings/);
  out = run('gateway', { ...out[0], statusCode: 200, payload: [] });
  assert.equal(out[0]._subscriptionBooking.step, 'history_bookings');
  return out[0];
}

test('source transformation rejects missing and duplicate anchors', () => {
  assert.throws(() => replaceOnce('a', 'b', 'c'), /anchor drift/);
  assert.throws(() => replaceOnce('aa', 'a', 'c'), /anchor drift/);
  assert.equal(replaceOnce('axb', 'x', 'y'), 'ayb');
});

liveTest('subscription create starts authenticated GET before any exercise POST', () => {
  const msg = start(); assert.equal(msg.method, 'GET'); assert.match(msg.url, /\/profile$/);
  assert.equal(msg._subscriptionBooking.caller, 'split_create_readonly_preflight');
  assert.equal(msg._splitCtx.exerciseId, undefined);
});
liveTest('eligible preflight reads history, performs no Mongo write, creates once then rechecks actual exercise', () => {
  const passed = run('gateway', { ...eligibleHistory(), statusCode: 200, payload: [] });
  assert.equal(passed[4].payload.state, 'CREATE_PREFLIGHT_PASSED');
  assert.ok(passed.slice(0, 4).every(n => n === null));
  const finalized = run('finalize', passed[4]);
  assert.equal(finalized[0]._splitCtx.subscriptionGuardDone, undefined);
  const create = run('split', finalized[0]);
  assert.equal(create[0].method, 'POST'); assert.match(create[0].url, /\/exercises$/);
  const created = run('split', { ...create[0], statusCode: 201, payload: { id: 'fixture-created' } });
  assert.equal(created[3].method, 'GET'); assert.match(created[3].url, /\/profile$/);
  assert.equal(created[3]._subscriptionBooking.exerciseId, 'fixture-created');
  assert.equal(created[3]._subscriptionBooking.caller, 'split');
});
liveTest('daily conflict preserves original 409 and never creates an exercise', () => {
  const failed = run('gateway', { ...eligibleHistory(), statusCode: 200, payload: [{
    id: 'fixture-existing', paymentType: 'SUBSCRIPTION', clientSubscriptionId: 'fixture-subscription',
    exerciseId: 'fixture-other', exerciseDate: '2026-09-10', exerciseDirection: { id: 4588 }, exerciseType: { id: 1613 },
  }] });
  assert.equal(failed[4].statusCode, 409);
  const finalized = run('finalize', failed[4]); assert.equal(finalized[0], null);
  assert.equal(finalized[1].statusCode, 409); assert.equal(finalized[1]._splitCtx.exerciseId, undefined);
});
for (const [name, payload] of Object.entries({ unknown: {}, absent: [], duplicate: [{ id: 'fixture-subscription' }, { id: 'fixture-subscription' }],
  truncated: { content: [{ id: 'fixture-subscription' }], totalElements: 2 },
  contradictory: { content: [{ id: 'fixture-subscription' }], totalElements: 1, number: 1 }, malformed: [null] })) {
  liveTest(`${name} subscription list fails before CREATE`, () => {
    const failed = run('gateway', { ...subscriptionStage(), statusCode: 200, payload });
    assert.ok(failed[4].statusCode >= 400); assert.equal(run('finalize', failed[4])[0], null);
  });
}
liveTest('forged success or changed operation/target cannot resume CREATE', () => {
  const passed = run('gateway', { ...eligibleHistory(), statusCode: 200, payload: [] })[4];
  for (const mutate of [m => m._splitCtx.roomId = 'other', m => m._subscriptionBooking.operationId = 'other',
    m => m._splitCtx.exerciseId = 'already-created', m => m._splitCtx.clientSubscriptionId = 'other']) {
    const msg = structuredClone(passed); mutate(msg);
    const result = run('finalize', msg); assert.equal(result[0], null); assert.equal(result[1].statusCode, 409);
  }
});
liveTest('late denial and pending result preserve exact identity and never enter compensation', () => {
  for (const [status, payload] of [[409, { error: 'denied', details: { code: 'ORIGINAL' } }], [202, { state: 'PENDING_CONFIRMATION' }], [503, { error: 'unknown' }]]) {
    const msg = { statusCode: status, payload, _subscriptionBooking: { caller: 'split', exerciseId: 'fixture-created' },
      _splitCtx: { action: 'create', ownsExercise: true, exerciseId: 'fixture-created' } };
    const out = run('finalize', msg); assert.equal(out[0], null); assert.equal(out[1].statusCode, status);
    assert.equal(out[1].payload.details.reconciliationRequired, true);
    assert.equal(out[1].payload.details.exerciseId, 'fixture-created');
    if (status === 409) assert.equal(out[1].payload.details.code, 'ORIGINAL');
  }
});
liveTest('JOIN and direct gateway callers retain original terminal response', () => {
  for (const caller of ['split', 'http']) {
    const msg = { statusCode: 409, payload: { error: 'denied' }, _subscriptionBooking: { caller, exerciseId: 'existing' },
      _splitCtx: { action: 'join', ownsExercise: false, exerciseId: 'existing' } };
    const out = run('finalize', msg); assert.equal(out[0], null); assert.deepEqual(out[1].payload, msg.payload);
  }
});
liveTest('preflight cannot reach Mongo outputs even on unexpected write-stage entry', () => {
  const msg = eligibleHistory(); msg._subscriptionBooking.step = 'operation_find';
  const out = run('gateway', { ...msg, statusCode: 200, payload: [] });
  assert.equal(out[4].payload.details.code, 'SUBSCRIPTION_CREATE_PREFLIGHT_WRITE_BLOCKED');
  assert.ok(out.slice(0, 4).every(n => n === null));
});

for (const [name, overrides] of Object.entries({
  expired: { status: 'EXPIRED' }, expiredDate: { expirationDate: '2026-08-31' },
  held: { status: 'HOLD' }, refunded: { status: 'REFUNDED' }, noVisits: { visitsLeft: 0 },
  wrongDirection: { hasDirectionLimitation: true, availableDirections: [{id: '999'}] },
  wrongStudio: { hasStudioLimitation: true, availableStudios: [{id: 'elsewhere'}] },
  unknownStatus: { status: 'UNRECOGNIZED' }, malformedRestrictions: { availableTypes: {} },
})) liveTest(`${name} is rejected before creating a Viva exercise`, () => {
  const result = run('gateway', { ...subscriptionStage(), statusCode: 200, payload: [eligibleSubscription(overrides)] });
  assert.equal(result[4].statusCode, 409);
  assert.equal(run('finalize', result[4])[0], null);
});

liveTest('NEW first-use subscription remains eligible without an expiry date', () => {
  const result = run('gateway', { ...subscriptionStage(), statusCode: 200,
    payload: [eligibleSubscription({ status: 'NEW', activationDate: null, expirationDate: null })] });
  assert.equal(result[0]._subscriptionBooking.step, 'active_bookings');
});
for (const name of ['Падел.Дружба.Питер — 12 месяцев', 'Падел.Дружба.ХАБ — 12 месяцев']) {
  liveTest(`${name} retains current compatibility rules without enabling managed enforcement`, () => {
    const out = run('gateway', { ...subscriptionStage(), statusCode: 200, payload: [eligibleSubscription({ name })] });
    assert.equal(out[0]._subscriptionBooking.step, 'active_bookings');
  });
}
const managedGlobals = {
  subscriptions_managed_enforcement_product_ids: ['8bf334ba-3050-4017-b40a-7eef2db1eb16'],
  subscriptions_runtime_api_base_url: 'https://runtime.invalid/api',
  subscriptions_runtime_context_integration_token: 'fixture-integration',
};
function managedStart() {
  return run('gateway', { ...subscriptionStage(), statusCode: 200, payload: [eligibleSubscription({
    name: 'Падел.Дружба.Питер — 12 месяцев', productId: '8bf334ba-3050-4017-b40a-7eef2db1eb16',
  })] }, managedGlobals)[0];
}
liveTest('managed preflight permits only existing read-only runtime-context POST', () => {
  const out = managedStart(); assert.equal(out.method, 'POST');
  assert.equal(out.url, 'https://runtime.invalid/api/internal/subscriptions/runtime-context');
  assert.deepEqual(out.payload, { clientSubscriptionId: 'fixture-subscription' });
  const unavailable = run('gateway', { ...out, statusCode: 503, payload: {} }, managedGlobals);
  assert.equal(unavailable[4].payload.details.code, 'MANAGED_SUBSCRIPTION_RUNTIME_CONTEXT_UNAVAILABLE');
});
liveTest('accepted managed policy completes preflight without reserve, activation or booking writes', () => {
  const msg = managedStart();
  msg._subscriptionBooking.step = 'managed_policy_decision';
  msg._subscriptionBooking.managedRuntime = { policy: { policyVersion: 1 } };
  const result = run('gateway', { ...msg, _managedSubscriptionPolicyDecision: {
    eligible: true, policyVersion: 1, usageUnits: 1, benefit: { kind: 'FREE_ENTITLEMENT' },
  } }, managedGlobals);
  assert.equal(result[4].payload.state, 'CREATE_PREFLIGHT_PASSED');
  assert.ok(result.slice(0, 4).every(n => n === null));
});
liveTest('first-use activation POST is blocked even on unexpected post-booking entry', () => {
  const msg = managedStart();
  msg._subscriptionBooking.step = 'operation_confirm';
  msg._subscriptionBooking.managedActivationRequired = true;
  msg._subscriptionBooking.confirmedBookingId = 'fixture-booking';
  msg._subscriptionBooking.managedRuntime = { subscriptionInstanceId: 'fixture-instance' };
  const result = run('gateway', { ...msg, payload: { matchedCount: 1 } }, {
    ...managedGlobals, subscriptions_activation_integration_token: 'fixture-activation-1234567890123456789012345',
  });
  assert.equal(result[4].payload.details.code, 'SUBSCRIPTION_CREATE_PREFLIGHT_WRITE_BLOCKED');
  assert.ok(result.slice(0, 4).every(n => n === null));
});

// The builder tests use isolated copies of the pinned fixture, never server files.
import os from 'node:os';
import path from 'node:path';
import { buildCandidate, runBuild } from '../patch_live_subscription_create_preflight.mjs';
function copiedWorkspace(mutate = () => {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'preflight-builder-test-'));
  fs.chmodSync(root, 0o700);
  const input = path.join(root, 'input'); fs.mkdirSync(input, { mode: 0o700 });
  const raw = fs.readFileSync(fixture);
  const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(fixture), 'source.flow.meta.json')));
  const sourcePath = path.join(input, 'source.flow.json');
  meta.localSourcePath = sourcePath;
  const state = { raw, meta }; mutate(state);
  fs.writeFileSync(sourcePath, state.raw, { mode: 0o600 });
  fs.writeFileSync(path.join(input, 'source.flow.meta.json'), JSON.stringify(state.meta), { mode: 0o600 });
  return root;
}
liveTest('builder is deterministic, changes only three func fields and writes private artifacts', () => {
  const workspace = copiedWorkspace();
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'preflight-output-test-'));
  try {
    const first = buildCandidate(workspace), second = buildCandidate(workspace);
    assert.deepEqual(first, second); assert.equal(first.changes.length, 3);
    const original = JSON.parse(fs.readFileSync(fixture));
    for (let i = 0; i < original.length; i++) assert.deepEqual({ ...first.flow[i], func: original[i].func }, { ...original[i], func: original[i].func });
    const a = runBuild(workspace, path.join(parent, 'a')), b = runBuild(workspace, path.join(parent, 'b'));
    assert.equal(a.candidateSha256, b.candidateSha256);
    assert.equal(fs.statSync(path.join(parent, 'a')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(parent, 'a/candidate.json')).mode & 0o777, 0o600);
    assert.throws(() => runBuild(workspace, path.join(parent, 'a')), /external output/);
    assert.throws(() => runBuild(workspace, path.join(process.cwd(), 'must-not-be-created')), /external output/);
    fs.symlinkSync(parent, path.join(parent, 'link'));
    assert.throws(() => runBuild(workspace, path.join(parent, 'link/out')), /external output/);
  } finally { fs.rmSync(workspace, { recursive: true }); fs.rmSync(parent, { recursive: true }); }
});
liveTest('builder rejects changed SHA with consistent metadata and stale source', () => {
  for (const [mutate, expected] of [
    [state => { state.raw = Buffer.from(state.raw.toString() + '\n'); state.meta.sourceSha256 = crypto.createHash('sha256').update(state.raw).digest('hex'); }, /Live flow changed/],
    [state => state.meta.pulledAt = '2000-01-01T00:00:00Z', /stale/],
  ]) {
    const workspace = copiedWorkspace(mutate);
    try { assert.throws(() => buildCandidate(workspace), expected); }
    finally { fs.rmSync(workspace, { recursive: true }); }
  }
});

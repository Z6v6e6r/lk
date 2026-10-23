import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { composeOwnerCompatibility } from '../prepare_booked_operation_owner_compatibility.mjs';
import { graftOwnerFunctions, statements } from '../lib/bookedOperationOwnerCompatibility.mjs';
import { managedRuntimeResponse, entitlementDecision } from './helpers/subscriptionBookingManagedFixtures.mjs';

const fixture = process.env.LK1_BOOKED_OWNER_COMPATIBILITY_FIXTURE;
const source = fixture ? fs.readFileSync(fixture) : null;
const packet = source ? composeOwnerCompatibility(source, 'fixture-booked-owner-compatibility') : null;
const input = source ? JSON.parse(source.toString()) : null;
const ids = {
  router: 'lk_subscription_booking_router_20260804',
  prepare: 'lk_subscription_booking_prepare_20260804',
  options: 'lk_subscription_booking_options_20260804',
  finalize: 'lk_subscription_booking_finalize_20260804',
};
const scoped = (name, fn) => test(name, { skip: !packet && 'Requires a private exact-preimage fixture; never committed' }, fn);
const actor = '00000000-0000-4000-8000-000000000001';
const sub = '00000000-0000-4000-8000-000000000002';
const product = '8bf334ba-3050-4017-b40a-7eef2db1eb16';
const ack = { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
const env = {
  vivacrm_access_token: 'fixture-svc',
  subscriptions_runtime_environment: 'PROD',
  subscriptions_runtime_api_base_url: 'https://padlhub.su/api',
  subscriptions_runtime_context_integration_token: 'fixture-context-token-long-enough-for-test',
  subscriptions_entitlement_integration_token: 'fixture-entitlement-token-long-enough-for-test',
  subscriptions_managed_enforcement_product_ids: [product],
};
function context(step, overrides = {}) {
  const runtime = managedRuntimeResponse({ clientSubscriptionId: sub });
  const decision = entitlementDecision({ action: 'JOIN_GAME' });
  return { caller: 'http', step, tenantKey: 'iSkq6G', operationId: 'fixture-join-operation',
    authHeader: 'Bearer fixture-actor-token', actorClientId: actor, actorPhone: '70000000000',
    clientSubscriptionId: sub, exerciseId: 'exercise-target', operationKey: 'fixture-canonical-claim',
    managedAction: 'JOIN_GAME', managedEnvironment: 'PROD', planKey: 'piter_friendship', managedActivationRequired: false,
    managedEnforcement: { enabled: true, environment: 'PROD', exactProductId: product },
    managedTarget: { stationId: decision.target.stationId, externalEventTypeId: decision.target.eventTypeId,
      productTypeId: null, durationMinutes: decision.target.durationMinutes, startsAt: decision.target.startsAt },
    managedRuntime: { subscriptionInstanceId: runtime.subscriptionInstanceId,
      policyDigest: runtime.policyDigest, policy: runtime.policy, instance: runtime.instance, evidence: runtime.evidence },
    ...overrides };
}
function execute(name, msg, globals = env) {
  const node = packet.candidate.find(row => row.id === ids[name]);
  return new Function('msg', 'global', 'node', 'env', node.func)(msg,
    { get: key => globals[key], set: (key, value) => { globals[key] = value; } }, { warn() {}, error() {} }, { get() {} });
}
function startReserve(overrides = {}) {
  const msg = { _subscriptionBooking: context('managed_runtime_recheck', overrides), statusCode: 200,
    payload: managedRuntimeResponse({ clientSubscriptionId: sub }) };
  const out = execute('router', msg);
  assert.equal(out[0]?.method, 'POST');
  assert.match(out[0].url, /\/internal\/subscriptions\/entitlements\/reserve$/);
  return msg;
}
function finishReserve(msg) {
  msg.statusCode = 200;
  msg.payload = { schemaVersion: 1, subscriptionInstanceId: msg._subscriptionBooking.managedRuntime.subscriptionInstanceId,
    aggregateRevision: 1, outcome: 'RESERVED', operationId: 'fixture-entitlement-operation',
    operationState: 'RESERVED', replayed: false, blockers: [], decision: entitlementDecision({ action: 'JOIN_GAME' }) };
  const bound = execute('router', msg);
  assert.equal(bound[3]?._subscriptionBooking.step, 'operation_entitlement_bind');
  assert.equal(bound[3].payload[1].$set.managedEntitlementState, 'RESERVED');
  msg.payload = { ...ack };
  return execute('router', msg);
}

test('unknown whole-flow input and unpinned function bodies are rejected', () => {
  assert.throws(() => composeOwnerCompatibility(Buffer.from('[]'), 'fixture'), /whole-flow preimage drift/);
  assert.throws(() => graftOwnerFunctions([]), /preimage drift/);
});
test('statement identities refuse syntax drift and duplicate declarations', () => {
  assert.throws(() => statements('const a = ;'), /syntax drift/);
  assert.throws(() => statements('var a=1; var a=2;'), /Duplicate/);
});

scoped('exact composition is deterministic and preserves all other nodes and product topology', () => {
  const repeated = composeOwnerCompatibility(source, 'fixture-booked-owner-compatibility');
  assert.ok(repeated.candidateBytes.equals(packet.candidateBytes));
  assert.equal(packet.candidate.length, input.length + 17);
  assert.equal(packet.contract.allowedAdditions.length, 17);
  assert.equal(packet.receiver.invariants.brokenWireCount, 0);
  assert.equal(packet.receiver.executionEnabledByDefault, false);
  const changed = packet.candidate.slice(0, input.length).filter((row, i) => !isDeepStrictEqual(row, input[i]));
  assert.equal(changed.length, 6);
  for (const row of changed) {
    const before = input.find(node => node.id === row.id);
    const fields = packet.contract.allowedChanges.find(change => change.id === row.id).fields;
    assert.deepEqual(Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key))),
      Object.fromEntries(Object.entries(before).filter(([key]) => !fields.includes(key))));
  }
  const router = packet.candidate.find(row => row.id === ids.router);
  assert.equal(router.outputs, 8);
  assert.deepEqual(router.wires[7], ['lk_subscription_product_router_20260907']);
  assert.ok(packet.reports[0].protectedStatements >= 150);
});

scoped('all installed standalone trial, identity, plan and product wrappers remain byte-identical', () => {
  const before = statements(input.find(row => row.id === ids.router).func);
  const after = new Map(statements(packet.candidate.find(row => row.id === ids.router).func).map(row => [row.key, row]));
  const protectedRows = before.filter(row => /^(?:var|fn):(trial|TRIAL|identity|lk1|LK1|isTopokraty|isProTraining)/.test(row.key));
  assert.ok(protectedRows.length > 80);
  for (const row of protectedRows) assert.equal(after.get(row.key)?.body, row.body, row.key);
});

scoped('owner probe is credential-free and does not inspect state; normal CORS remains 204', () => {
  const normal = execute('options', { req: { method: 'OPTIONS', headers: {} } });
  assert.equal(normal[0].statusCode, 204);
  const msg = { req: { method: 'OPTIONS', headers: { 'x-booked-operation-owner-contract': '1' } } };
  const probe = execute('options', msg);
  const out = execute('router', probe[1], new Proxy({}, { get() { throw new Error('probe read state'); } }));
  assert.equal(out[4].statusCode, 200);
  assert.deepEqual(out[4].payload, { contractVersion: 1, owner: 'LK1_SUBSCRIPTION_BOOKING_OWNER', policy: 'ATOMIC_MANAGED_V1' });
});

scoped('profile rejection cannot reserve or book', () => {
  const rejected = execute('router', { _subscriptionBooking: context('profile'), statusCode: 401, payload: {} });
  assert.equal(rejected[4].statusCode, 401);
  assert.equal(rejected[0], null); assert.equal(rejected[2], null); assert.equal(rejected[3], null);
});

scoped('foreign product identity, duplicate owned records and conflicting subscription aliases stop before writes', () => {
  const row = { subscriptionId: sub, clientSubscriptionId: sub, productId: product,
    product: { id: product, name: 'Fixture Piter' }, name: 'Fixture Piter', purchaseDate: '2026-09-01',
    clientId: actor, status: 'ACTIVE', visitsLeft: 10 };
  const startsAt = new Date(Date.now() + 14 * 86400000).toISOString();
  for (const kind of ['foreign-actor', 'duplicate', 'alias-conflict']) {
    const owned = kind === 'duplicate' ? [{ ...row }, { ...row }]
      : [{ ...row, ...(kind === 'alias-conflict' ? { clientSubId: 'foreign-subscription' } : {}) }];
    const msg = { _subscriptionBooking: context('exercise', {
      lk1ProductIdentity: { tenantKey: 'iSkq6G', actorClientId: kind === 'foreign-actor' ? 'foreign-actor' : actor,
        subscriptionId: sub, productId: product, name: 'Fixture Piter', purchaseDate: row.purchaseDate, subscription: row },
    }), statusCode: 200, payload: { id: 'exercise-target', directionId: 4588, typeId: 1613,
      studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b', roomId: 'fixture-room',
      timeFrom: startsAt, timeTo: new Date(Date.parse(startsAt) + 3600000).toISOString(),
      availableClientSubscriptions: owned } };
    const out = execute('router', msg);
    assert.equal(out[0], null, kind); assert.equal(out[2], null, kind); assert.equal(out[3], null, kind);
    assert.equal(out[4]?.statusCode, 409, kind);
  }
});

scoped('preaccept rereads the exact exercise before entitlement reserve', () => {
  const msg = { _subscriptionBooking: context('operation_preaccept'), payload: { ...ack } };
  const out = execute('router', msg);
  assert.equal(out[0]?.method, 'GET');
  assert.match(out[0].url, /\/exercises\/exercise-target$/);
  assert.equal(msg._subscriptionBooking.step, 'exercise_recheck');
});

scoped('fresh recheck rejects newly duplicated subscriptions and conflicting fallback aliases before reserve', () => {
  const row = { subscriptionId: sub, clientSubscriptionId: sub, productId: product,
    product: { id: product, name: 'Fixture Piter' }, name: 'Fixture Piter', purchaseDate: '2026-09-01',
    clientId: actor, status: 'ACTIVE', visitsLeft: 10 };
  for (const step of ['exercise', 'exercise_recheck']) {
    for (const duplicate of [false, true]) {
      const conflicting = { ...row, subscriptionId: undefined, clientSubscriptionId: undefined, id: sub, uuid: 'foreign-instance' };
      const ctx = context(step, { productRecheckReady: true, lk1ProductIdentity: {
        tenantKey: 'iSkq6G', actorClientId: actor, subscriptionId: sub, productId: product,
        name: 'Fixture Piter', purchaseDate: row.purchaseDate, subscription: row,
      } });
      const from = new Date(Date.now() + 14 * 86400000).toISOString();
      const msg = { _subscriptionBooking: ctx, statusCode: 200, payload: {
        id: 'exercise-target', directionId: 4588, typeId: 1613, studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'fixture-room', timeFrom: from, timeTo: new Date(Date.parse(from) + 3600000).toISOString(),
        availableClientSubscriptions: duplicate ? [{ ...row }, { ...row }] : [conflicting],
      } };
      const out = execute('router', msg);
      assert.equal(out[0], null); assert.equal(out[2], null);
      if (step === 'exercise') assert.equal(out[4].statusCode, 409);
      else {
        assert.equal(out[3].payload[1].$set.state, 'FAILED');
        assert.equal(ctx.step, 'operation_fail');
        assert.equal(out[3].payload[1].$set.managedEntitlementOperationId, undefined);
      }
    }
  }
});

scoped('canonical prospective caller and installed readonly caller execute their own target branch exactly once', () => {
  const rows = statements(packet.candidate.find(row => row.id === ids.router).func);
  const branch = rows.filter(row => row.key.startsWith('if:ctx.step === "prospective_subscriptions"'))
    .map(row => row.body).join('\n');
  assert.equal(rows.filter(row => row.key.startsWith('if:ctx.step === "prospective_subscriptions"')).length, 2);
  const prefix = `
    const isObj = value => value && typeof value === 'object' && !Array.isArray(value);
    const toStr = value => value == null ? null : String(value).trim() || null;
    const normalizeId = toStr;
    const finiteDate = value => Number.isFinite(Date.parse(value)) ? new Date(value) : null;
    const isHttpOk = status => status >= 200 && status < 300;
    const hasBookingListShape = value => Array.isArray(value.content);
    const hasCompleteBookingList = value => value.totalElements === value.content.length;
    const finishError = (_ctx, statusCode, message, details) => ({ statusCode, message, details });
    const findOwnedSubscriptions = exercise => exercise.availableClientSubscriptions;
    const findOwnedSubscription = exercise => exercise.availableClientSubscriptions[0];
    const identityBound = () => true;
  `;
  const startsAt = '2027-01-10T12:00:00.000Z';
  const owned = { subscriptionId: sub };
  const body = () => ({ content: [owned], totalElements: 1, number: 0, totalPages: 1, last: true });
  const canonicalCtx = { caller: 'split_create_preflight', step: 'prospective_subscriptions',
    clientSubscriptionId: sub, exerciseId: 'exercise-target', prospectiveTarget: {
      resolutionSource: 'SERVER', eventId: 'exercise-target', stationId: 'fixture-station', roomId: 'fixture-room',
      category: 'open_game', externalEventTypeId: 'viva:direction:4588:type:1613', startsAt, durationMinutes: 60,
    } };
  const canonicalMsg = { statusCode: 200, payload: body() };
  const canonical = new Function('msg', 'ctx', prefix + `
    const extractItems = value => value.content;
    const identitySelected = () => { throw new Error('legacy branch executed'); };
    const preflightAvailability = { filterSplitEligibleSubscriptions() { throw new Error('legacy branch executed'); } };
    ${branch}\nreturn { msg, ctx };`)(canonicalMsg, canonicalCtx);
  assert.equal(canonical.ctx.step, 'exercise');
  assert.equal(canonical.msg.payload.timeFrom, startsAt);
  assert.equal(canonical.msg.payload.source, undefined);
  const legacyCtx = { caller: 'split_create_readonly_preflight', step: 'prospective_subscriptions',
    clientSubscriptionId: sub, exerciseId: 'exercise-target', lk1ProductIdentity: {}, prospectiveTarget: {
      source: 'SPLIT_SERVER_CREATE_CONTEXT', timeFrom: startsAt,
      timeTo: '2027-01-10T13:00:00.000Z', roomId: 'fixture-room', studioId: 'fixture-station', directionId: 4588, typeId: 1613,
    } };
  const legacyMsg = { statusCode: 200, payload: body() };
  const legacy = new Function('msg', 'ctx', prefix + `
    const extractItems = () => { throw new Error('canonical branch executed'); };
    const identitySelected = value => value.content[0];
    const preflightAvailability = { filterSplitEligibleSubscriptions: selected => selected };
    ${branch}\nreturn { msg, ctx };`)(legacyMsg, legacyCtx);
  assert.equal(legacy.ctx.step, 'exercise');
  assert.equal(legacy.msg.payload.source, 'SPLIT_SERVER_CREATE_CONTEXT');
  assert.equal(legacy.ctx.lk1ProductIdentity.subscription.subscriptionId, sub);
});

scoped('trial guard runs before preaccept and entitlement reserve', () => {
  const msg = { _subscriptionBooking: context('operation_insert', { trialExercise: { id: 'exercise-target' } }),
    payload: { acknowledged: true, insertedId: 'fixture-canonical-claim' } };
  const out = execute('router', msg, { ...env, trial_group_visit_policy: {
    mode: 'enforce', version: 'trial-group-v1', historyContract: 'viva-self-history-attendance-v1',
  } });
  assert.equal(out[3], null);
  assert.equal(out[0]?.method, 'GET');
  assert.equal(msg._subscriptionBooking.step, 'trial_visit_history');
});

scoped('managed reserve is durably bound before the sole Admin booking request with separate credentials', () => {
  const msg = startReserve();
  assert.equal(msg.headers.Authorization, 'Bearer fixture-actor-token');
  assert.ok(msg.headers['X-Subscriptions-Integration-Token']);
  const out = finishReserve(msg);
  assert.equal(out[0]?.method, 'POST');
  assert.match(out[0].url, /\/api\/v2\/exercises\/exercise-target\/bookings$/);
  assert.equal(out[0].headers.Authorization, 'Bearer fixture-svc');
  assert.equal(out[0].headers['X-Subscriptions-Integration-Token'], undefined);
  assert.equal(out[0].payload.clientSubscriptionId, sub);
  assert.equal(out[0].payload.clientId, actor);
});

scoped('unknown bind ACK and environment drift after reserve keep custody without booking', () => {
  const msg = startReserve();
  msg.statusCode = 200;
  msg.payload = { schemaVersion: 1, subscriptionInstanceId: 'subscription-instance-1', aggregateRevision: 1,
    outcome: 'RESERVED', operationId: 'fixture-entitlement-operation', operationState: 'RESERVED',
    replayed: false, blockers: [], decision: entitlementDecision({ action: 'JOIN_GAME' }) };
  execute('router', msg);
  msg.payload = { acknowledged: false };
  const unknown = execute('router', msg);
  assert.equal(unknown[4].statusCode, 202); assert.equal(unknown[0], null);
  const drift = { _subscriptionBooking: context('operation_entitlement_bind', {
    managedEntitlementOperationId: 'fixture-entitlement-operation' }), payload: { ...ack } };
  const stopped = execute('router', drift, { ...env, subscriptions_runtime_environment: 'DEV' });
  assert.equal(stopped[4].statusCode, 202); assert.equal(stopped[0], null);
});

scoped('provider timeout/5xx never releases entitlement or redispatches a booking', () => {
  for (const statusCode of [0, 408, 500, 503]) {
    const msg = { _subscriptionBooking: context('booking_create', {
      managedEntitlementOperationId: 'fixture-entitlement-operation' }), statusCode, error: { message: 'fixture timeout' }, payload: {} };
    const out = execute('router', msg);
    assert.equal(out[4].statusCode, 202); assert.equal(out[0], null); assert.equal(out[3], null);
    assert.equal(msg._subscriptionBooking.entitlementReleaseNext, undefined);
  }
});

scoped('ambiguous entitlement reserve stays pending without binding, release or provider booking', () => {
  for (const reply of [
    { statusCode: 0, error: { message: 'fixture timeout' }, payload: {} },
    { statusCode: 408, payload: {} }, { statusCode: 503, payload: {} },
    { statusCode: 200, payload: 'malformed' },
    { statusCode: 200, payload: { schemaVersion: 1, subscriptionInstanceId: 'foreign-instance', aggregateRevision: 1 } },
    { statusCode: 200, payload: { schemaVersion: 1, subscriptionInstanceId: 'subscription-instance-1', aggregateRevision: 1,
      outcome: 'RESERVED', operationId: 'fixture-entitlement-operation', operationState: 'RESERVED', replayed: false,
      blockers: [], decision: { ...entitlementDecision({ action: 'JOIN_GAME' }), action: 'CREATE_GAME' } } },
  ]) {
    const msg = { _subscriptionBooking: context('managed_entitlement_reserve'), ...reply };
    const out = execute('router', msg);
    assert.equal(out[4]?.statusCode, 202); assert.equal(out[0], null); assert.equal(out[3], null);
  }
});

scoped('malformed provider success cannot confirm or release without exact readback', () => {
  const msg = { _subscriptionBooking: context('booking_create', {
    managedEntitlementOperationId: 'fixture-entitlement-operation' }), statusCode: 200, payload: {} };
  const accepted = execute('router', msg);
  assert.equal(accepted[3]?._subscriptionBooking.step, 'operation_accept');
  msg.payload = { ...ack };
  const read = execute('router', msg);
  assert.equal(read[0]?.method, 'GET');
  msg.statusCode = 200; msg.payload = { content: [], totalElements: 0, number: 0, last: true, totalPages: 0 };
  const pending = execute('router', msg);
  assert.equal(pending[4]?.statusCode, 202); assert.equal(pending[0], null); assert.equal(pending[3], null);
});

scoped('exact managed confirmation is persisted before participation can become CONFIRMED', () => {
  const msg = { _subscriptionBooking: context('operation_confirm', {
    managedEntitlementOperationId: 'fixture-entitlement-operation', confirmedBookingId: 'fixture-booking' }), payload: { ...ack } };
  const confirm = execute('router', msg);
  assert.match(confirm[0].url, /\/entitlements\/confirm$/);
  msg.statusCode = 200;
  msg.payload = { schemaVersion: 1, outcome: 'CONFIRMED', operationId: 'fixture-entitlement-operation',
    subscriptionInstanceId: 'subscription-instance-1', operationState: 'CONFIRMED', aggregateRevision: 2 };
  const persist = execute('router', msg);
  assert.equal(persist[3]?._subscriptionBooking.step, 'operation_entitlement_confirm');
  assert.equal(persist[3].payload[1].$set.managedEntitlementState, 'CONFIRMED');
  msg.payload = { ...ack };
  const done = execute('router', msg);
  assert.equal(done[4].payload.state, 'CONFIRMED');
});

scoped('wrong or partial confirmation and required activation stay pending without release', () => {
  for (const extra of [{ operationId: 'foreign-operation' }, { operationState: 'RESERVED' }, { subscriptionInstanceId: 'foreign-instance' }]) {
    const msg = { _subscriptionBooking: context('managed_entitlement_confirm', {
      managedEntitlementOperationId: 'fixture-entitlement-operation', confirmedBookingId: 'fixture-booking' }), statusCode: 200,
    payload: { schemaVersion: 1, outcome: 'CONFIRMED', operationId: 'fixture-entitlement-operation', subscriptionInstanceId: 'subscription-instance-1',
      operationState: 'CONFIRMED', aggregateRevision: 2, ...extra } };
    const out = execute('router', msg);
    assert.equal(out[4].statusCode, 202); assert.equal(out[0], null); assert.equal(out[3], null);
  }
  const activation = { _subscriptionBooking: context('operation_entitlement_confirm', {
    managedEntitlementOperationId: 'fixture-entitlement-operation', managedEntitlementConfirmed: true,
    managedActivationRequired: true, confirmedBookingId: 'fixture-booking' }), payload: { ...ack } };
  const pending = execute('router', activation, { ...env, subscriptions_activation_integration_token: undefined });
  assert.notEqual(pending[4]?.payload.state, 'CONFIRMED');
});

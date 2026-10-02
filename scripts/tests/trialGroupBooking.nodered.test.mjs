import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { patchTrialGroupBookingSource, trialGroupCheckoutSource } from '../lib/trialGroupSources.mjs';
import { TRIAL_GROUP_HISTORY_CONTRACT } from '../lib/trialGroupEligibility.mjs';

const base = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const gateway = patchTrialGroupBookingSource(base);
const policy = { version: 'trial-group-v1', mode: 'enforce', historyContract: TRIAL_GROUP_HISTORY_CONTRACT };
const run = (source, msg, configured = policy) => new Function('msg', 'global', 'node', 'env', source)(msg,
  { get: key => key === 'trial_group_visit_policy' ? configured : undefined }, { warn() {} }, { get: () => 'fixture' });
const checkout = trialGroupCheckoutSource();
const exercise = () => ({ id: 'fixture-event', type: { id: 1755 }, direction: { id: 4971 },
  studio: { id: 'fixture-station' }, timeFrom: new Date(Date.now() + 86400000).toISOString(),
  timeTo: new Date(Date.now() + 90000000).toISOString(), availableClientSubscriptions: [{ id: 'fixture-sub' }] });
const history = (count = 0) => ({ content: Array.from({ length: count }, (_, id) => ({
  id: `fixture-booking-${id}`, exerciseId: `past-event-${id}`, clientId: 'fixture-actor', visitConfirmed: true,
  timeTo: new Date(Date.now() - 86400000).toISOString(),
})), number: 0, totalElements: count, totalPages: 1, last: true });
function reply(msg, payload, statusCode = 200, source = checkout, configured = policy) {
  delete msg.error; msg.payload = payload; msg.statusCode = statusCode;
  return run(source, msg, configured);
}
function begin(action = 'checkout', extra = {}, savedRows = []) {
  const msg = { req: { headers: { authorization: 'Bearer fixture' }, query: { operationId: 'fixture-operation' } },
    payload: { action, exerciseId: 'fixture-event', productId: 'fixture-product', source: 'one-time', ...extra } };
  assert.equal(run(checkout, msg)[0], msg);
  assert.match(msg.url, /\/profile$/);
  const profile = reply(msg, { id: 'fixture-actor', phone: 'fixture-phone' });
  if (action === 'checkout') { assert.ok(profile[1]); reply(msg, savedRows); }
  if (savedRows.length === 0) assert.match(msg.url, /\/exercises\/fixture-event$/);
  return msg;
}
function acceptedInsert() {
  const msg = begin(); reply(msg, exercise()); reply(msg, history(2));
  const out = reply(msg, [{ id: 'fixture-product', productType: 'SERVICE', name: 'Fixture service', cost: 100 }]);
  assert.ok(out[0]); assert.equal(msg._subscriptionBooking.step, 'checkout_exercise_recheck');
  assert.ok(reply(msg, msg._subscriptionBooking.exercise)[2]); return msg;
}
function subscriptionAttempt(payload = []) {
  return { _subscriptionBooking: { step: 'operation_find', caller: 'http', action: 'book', tenantKey: 'fixture',
    operationKey: 'fixture-key', operationId: 'fixture-operation', managedEnforcement: { enabled: false },
    category: 'group_training', serviceDate: '2030-10-03', limitMode: 'event', trackedDailyLimit: false,
    actorClientId: 'fixture-actor', authHeader: 'Bearer fixture', exerciseId: 'fixture-event', clientSubscriptionId: 'fixture-sub',
    trialExercise: exercise(), trialRequestedAt: new Date().toISOString() }, statusCode: 200, payload };
}
test('new subscription reservation is checked before Mongo insert or provider write', () => {
  const msg = subscriptionAttempt();
  assert.ok(run(gateway, msg)[0]); assert.equal(msg._subscriptionBooking.step, 'trial_visit_history');
  const denied = reply(msg, history(3), 200, gateway);
  assert.ok(denied[4]); assert.equal(msg.statusCode, 409);
  assert.equal(msg.payload.details.code, 'TRIAL_TRAINING_VISIT_LIMIT_EXCEEDED');
  assert.equal(denied[1], null); assert.equal(denied[2], null); assert.equal(denied[3], null);
});
test('allowed subscription resumes exact insert and rechecks before preaccept', () => {
  const msg = subscriptionAttempt();
  run(gateway, msg); const insert = reply(msg, history(2), 200, gateway);
  assert.equal(msg._subscriptionBooking.trialVisitEvidence.count, 2);
  assert.equal(msg._subscriptionBooking.step, 'operation_insert'); assert.ok(insert[2]);
  assert.equal(msg.payload._id, 'fixture-key');
  const second = reply(msg, { acknowledged: true, insertedId: 'fixture-key' }, 200, gateway);
  assert.ok(second[0]); assert.equal(msg._subscriptionBooking.step, 'trial_visit_history');
  const preaccept = reply(msg, history(2), 200, gateway);
  assert.ok(preaccept[3]); assert.equal(msg._subscriptionBooking.step, 'operation_preaccept');
  assert.match(gateway, /const preparePreaccept = \(ctx\) => \{\n\s+if \(ctx.trialExercise/);
  assert.throws(() => patchTrialGroupBookingSource(gateway), /already installed/);
});
test('legacy pending-operation replay does not re-evaluate attendance or dispatch another write', () => {
  const msg = subscriptionAttempt([{ _id: 'fixture-key', operationId: 'fixture-operation', state: 'PENDING_CONFIRMATION',
    pendingUntil: new Date(Date.now() + 86400000).toISOString(), clientSubscriptionId: 'fixture-sub' }]);
  const out = run(gateway, msg);
  assert.ok(out[4]); assert.equal(msg.statusCode, 202);
  assert.equal(msg._subscriptionBooking.trialVisitGate, undefined);
});
test('disabled rule leaves existing non-trial gateway path intact', () => {
  const initial = { _subscriptionBooking: { step: 'exercise', caller: 'http', action: 'book', tenantKey: 'fixture',
    actorClientId: 'fixture-actor', authHeader: 'Bearer fixture', exerciseId: 'fixture-event', clientSubscriptionId: 'fixture-sub' },
  statusCode: 200, payload: { ...exercise(), type: { id: 605 }, direction: { id: 1000 } } };
  const before = structuredClone(initial), after = structuredClone(initial);
  run(base, before, undefined); run(gateway, after, undefined);
  assert.deepEqual(after, before);
});
test('checkout reconstructs actor and target; refuses 3 visits before any persistence/POST', () => {
  const msg = begin('checkout', { clientId: 'other', visits: 0, category: 'other', skip: true, customAmount: 0 });
  assert.equal(msg._subscriptionBooking.actorClientId, 'fixture-actor');
  assert.equal(msg._subscriptionBooking.skip, undefined);
  reply(msg, exercise()); const out = reply(msg, history(3));
  assert.equal(msg.statusCode, 409); assert.ok(out[4]);
  assert.ok(out.every((value, index) => index === 4 || value === null));
});
test('check action is read-only and uncertain history cannot become zero visits', () => {
  for (const payload of [[], { content: [] }, history(3)]) {
    const msg = begin('check'); reply(msg, exercise()); reply(msg, payload);
    assert.ok([409, 503].includes(msg.statusCode));
  }
  const msg = begin('check'); reply(msg, exercise()); const out = reply(msg, history(2));
  assert.equal(msg.payload.eligible, true); assert.equal(msg.payload.count, 2); assert.ok(out[4]);
});
test('paginated history is fetched fully; metadata drift fails closed', () => {
  const msg = begin('check'); reply(msg, exercise());
  const first = history(1); first.totalElements = 2; first.totalPages = 2; first.last = false;
  assert.ok(reply(msg, first)[0]); assert.match(msg.url, /page=1$/);
  const second = history(1); second.number = 1; second.totalPages = 2; second.totalElements = 3;
  reply(msg, second); assert.equal(msg.statusCode, 503);
});
test('page overlap and changed page totals cannot hide a third visit', () => {
  for (const overlap of [true, false]) {
    const msg = begin('check'); reply(msg, exercise());
    const first = history(2); first.totalElements = 3; first.totalPages = 2; first.last = false;
    reply(msg, first);
    const second = history(1); second.content[0] = first.content[1]; second.number = 1;
    second.totalPages = overlap ? 2 : 3; second.totalElements = 3; second.last = overlap;
    reply(msg, second); assert.equal(msg.statusCode, 503);
  }
});
test('POST requires majority insert ACK; no identity or bearer persists', () => {
  const msg = acceptedInsert(); const [doc, options] = msg.payload;
  assert.equal(doc.state, 'ATTEMPTING'); assert.equal(options.writeConcern.w, 'majority');
  assert.doesNotMatch(JSON.stringify(doc), /Bearer|fixture-phone|authHeader/);
  const failed = structuredClone(msg);
  assert.ok(reply(failed, { acknowledged: false })[1]);
  assert.equal(failed.method, 'GET');
  const out = reply(msg, { acknowledged: true, insertedId: doc._id });
  assert.ok(out[0]); assert.equal(msg.method, 'POST');
  assert.equal(msg.payload.clientPhone, 'fixture-phone');
  assert.equal(msg.payload.products[0].customAmount, undefined);
  assert.equal(msg.payload.products[0].discount, undefined);
});
test('timeout and malformed POST outcome stay pending and replay never POSTs again', () => {
  const msg = acceptedInsert(); const doc = msg.payload[0];
  reply(msg, { acknowledged: true, insertedId: doc._id });
  const out = reply(msg, {}, 504); assert.ok(out[4]); assert.equal(msg.statusCode, 202);
  const retry = begin('checkout', {}, [doc]); assert.equal(retry.statusCode, 202); assert.equal(retry.method, 'GET');
});
test('duplicate insert races read the winner, rather than dispatching a second POST', () => {
  const msg = acceptedInsert(); const doc = msg.payload[0];
  msg.error = { code: 11000 }; msg.payload = undefined;
  assert.ok(run(checkout, msg)[1]);
  reply(msg, [doc]); assert.equal(msg.statusCode, 202);
});
test('verified transaction ID persists before response; replay readback bypasses new attendance', () => {
  const msg = acceptedInsert(); const doc = msg.payload[0];
  reply(msg, { acknowledged: true, insertedId: doc._id });
  const saved = reply(msg, { id: 'fixture-transaction' }, 200);
  assert.ok(saved[3]); assert.equal(msg.payload[1].$set.transactionId, 'fixture-transaction');
  reply(msg, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }); assert.match(msg.url, /\/status$/);
  const result = reply(msg, { id: 'fixture-transaction', toPay: 100, cardPaymentInfo: { paymentUrl: 'https://pay.example.test/fixture' } });
  assert.ok(result[4]); assert.equal(msg.payload.id, 'fixture-transaction');
  const retry = begin('checkout', {}, [{ ...doc, state: 'CREATED', transactionId: 'fixture-transaction' }]);
  assert.match(retry.url, /\/status$/); assert.equal(retry._subscriptionBooking.trialVisitGate, undefined);
  reply(retry, { clientId: 'other' }); assert.equal(retry.statusCode, 202);
});
test('shadow reports without blocking; configuration drift never bypasses the gate', () => {
  const shadow = { ...policy, mode: 'shadow' };
  const msg = begin('check'); reply(msg, exercise());
  reply(msg, history(0), 200, checkout, shadow);
  assert.equal(msg.statusCode, 503);
  const observed = begin('check'); reply(observed, exercise(), 200, checkout, shadow);
  reply(observed, history(3), 200, checkout, shadow);
  assert.equal(observed.payload.eligible, true); assert.equal(observed.payload.count, 3);
});
test('new target or policy drift before the first durable write stops checkout', () => {
  for (const change of ['target', 'policy']) {
    const msg = begin(); reply(msg, exercise()); reply(msg, history(0));
    reply(msg, [{ id: 'fixture-product', type: 'SERVICE', name: 'Fixture service' }]);
    const target = structuredClone(msg._subscriptionBooking.exercise);
    if (change === 'target') target.isCancelled = true;
    const out = reply(msg, target, 200, checkout, change === 'policy' ? { ...policy, mode: 'off' } : policy);
    assert.ok(out[4]); assert.equal(msg.statusCode, 409); assert.equal(out[2], null);
  }
});
test('policy change after insert cannot dispatch a transaction', () => {
  const msg = acceptedInsert(); const doc = msg.payload[0];
  const out = reply(msg, { acknowledged: true, insertedId: doc._id }, 200, checkout, { ...policy, mode: 'off' });
  assert.ok(out[4]); assert.equal(msg.statusCode, 202); assert.equal(out[0], null);
});
test('wrong event/product or missing auth cannot dispatch a provider write', () => {
  const unauth = { req: { headers: {} }, payload: { exerciseId: 'fixture-event' } };
  run(checkout, unauth); assert.equal(unauth.statusCode, 401);
  const msg = begin(); reply(msg, { ...exercise(), type: { id: 605 }, direction: { id: 1000 } });
  assert.equal(msg.statusCode, 409);
  const badProduct = begin(); reply(badProduct, exercise()); reply(badProduct, history(0));
  reply(badProduct, [{ id: 'fixture-product', type: 'SUBSCRIPTION', name: 'Bad' }]); assert.equal(badProduct.statusCode, 409);
});

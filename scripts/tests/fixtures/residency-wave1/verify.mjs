import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const port = process.env.RESIDENCY_STAND_LK_PORT ?? '24641';
assert(/^[1-9][0-9]{3,4}$/.test(port));
const origin = 'http://127.0.0.1:' + port;
const exerciseId = '4c9f00aa-d286-4a48-ad29-98757bd0ca87';
const target = { targetKind: 'GROUP_TRAINING_RESIDENCY_PURCHASE', exerciseId };
const quotePath = '/lk/subscriptions/game-price-preview';
const checkoutPath = '/__stand/residency-checkout';

async function send(path, { player = 'first', data, trace } = {}) {
  const headers = { authorization: 'Bearer fixture-' + player };
  if (data !== undefined) headers['content-type'] = 'application/json';
  if (trace) headers['x-stand-trace'] = trace;
  const res = await fetch(origin + path, {
    method: data === undefined ? 'GET' : 'POST', headers, redirect: 'error',
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.json() };
}

async function preview(player) {
  const trace = randomUUID();
  const reply = await send(quotePath, { player, trace, data: { target } });
  const resolved = await send('/__stand/trace/' + trace);
  assert.equal(resolved.status, 200);
  return { ...reply, reads: resolved.body };
}

const { body: info } = await send('/__stand/info');
const first = await preview('first');
assert.equal(first.status, 200);
assert.deepEqual(first.reads, ['PROFILE_FIXTURE', 'EXERCISE_FIXTURE', 'SUBSCRIPTIONS_FIXTURE', 'TARIFF_FIXTURE',
  'RESIDENCY_CARD_FIXTURE', 'CUP_POLICY_HTTP']);
const q = first.body.residencyPurchaseQuote;
assert.equal(q.exerciseId, exerciseId);
assert.equal(q.policyDigest, info.policy.policyDigest);
assert.equal(q.publicationId, info.policy.publicationId);
assert.equal(q.policyVersion, info.policy.policyVersion);
assert.equal(q.existingResidency, 'NONE');
assert.deepEqual([
  q.participationBaseMinor, q.discountPercent, q.participationDiscountMinor, q.participationToPayMinor, q.residencyMinor, q.totalMinor,
], [550000, 50, 275000, 275000, 79000, 354000]);
const ttlMs = q.expiresAt - first.body.serverTimeMs;
assert(ttlMs > 0 && ttlMs <= 30000);

const active = await preview('active');
const unavailable = await preview('unavailable');
for (const [result, status, code] of [
  [active, 409, 'RESIDENCY_PURCHASE_HISTORY_EXISTS'],
  [unavailable, 503, 'PRICE_PREVIEW_SUBSCRIPTIONS_INCOMPLETE'],
]) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { error: { code } });
  assert.deepEqual(result.reads, ['PROFILE_FIXTURE', 'EXERCISE_FIXTURE', 'SUBSCRIPTIONS_FIXTURE']);
}

const operationId = 'wave1-' + randomUUID();
const request = { operationId, exerciseId, acceptedQuote: q, consentAccepted: true };
const evidencePath = checkoutPath + '/' + operationId + '/evidence';
const getEvidence = async (player = 'first') => {
  const { status, body } = await send(evidencePath, { player });
  assert.equal(status, 200);
  return body;
};
const stats = evidence => [
  evidence.journalRows, evidence.providerOrderCount, evidence.createCalls, evidence.droppedResponses, evidence.lookupCalls,
];

const changed = await send(checkoutPath, { data: { ...request, acceptedQuote: { ...q, totalMinor: q.totalMinor + 1 } } });
assert.deepEqual(changed, { status: 409, body: { error: { code: 'COMPOSITE_QUOTE_CHANGED' } } });
assert.deepEqual(stats(await getEvidence()), [0, 0, 0, 0, 0]);

const attempt = await send(checkoutPath, { data: request });
assert.equal(attempt.status, 202);
assert.equal(attempt.body.state, 'PENDING_CONFIRMATION');
assert.equal(attempt.body.providerOrderId, null);
assert.equal(attempt.body.quote.totalMinor, q.totalMinor);
const lost = await getEvidence();
assert.equal(lost.persistedState, 'SUBMITTING');
assert.deepEqual(stats(lost), [1, 1, 1, 1, 0]);

const retry = await send(checkoutPath, { data: request });
assert.equal(retry.status, 200);
assert.equal(retry.body.state, 'CREATED');
assert.equal(retry.body.providerOrderId, lost.providerOrders[0].providerOrderId);
const recovered = await getEvidence();
assert.equal(recovered.persistedState, 'CREATED');
assert.deepEqual(stats(recovered), [1, 1, 1, 1, 1]);
assert.deepEqual(recovered.providerOrders, lost.providerOrders);
assert.deepEqual(recovered.providerOrders[0].lines, [
  { role: 'PARTICIPATION', productId: q.participationProductId, count: 1,
    costMinor: 550000, discountMinor: 275000, exerciseId },
  { role: 'RESIDENCY', productId: q.residencyProductId, count: 1,
    costMinor: 79000, discountMinor: 0, exerciseId: null },
]);

assert.deepEqual(await send(checkoutPath, { data: request }), retry);
const conflict = await send(checkoutPath, { data: { ...request, acceptedQuote: { ...q, totalMinor: q.totalMinor + 1 } } });
assert.deepEqual(conflict, { status: 409, body: { error: { code: 'COMPOSITE_OPERATION_CONFLICT' } } });
assert.deepEqual(stats(await getEvidence()), [1, 1, 1, 1, 1]);
assert.deepEqual(stats(await getEvidence('active')), [0, 0, 0, 0, 0]);

console.log(JSON.stringify({
  result: 'PASS', at: new Date().toISOString(), stand: info,
  quote: { ...first, expiresAtIso: new Date(q.expiresAt).toISOString(), ttlMs },
  active, unavailable, changed, conflict, operationId,
  afterDroppedResponse: { checkout: attempt, journal: lost },
  afterRetry: { checkout: retry, journal: recovered },
  repeated: 'Same receipt; no further create or lookup',
}, null, 2));

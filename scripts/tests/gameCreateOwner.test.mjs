import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OwnerHarness, matches } from './helpers/gameCreateOwnerHarness.mjs';
import { planHungClaimRelease } from '../lib/hungClaimRelease.mjs';
const canonical = h => [...h.rows.values()].find(r => r.managedCreateBinding);
const outer = h => [...h.rows.values()].find(r => r.kind === 'GAME_CREATE_ADMISSION');
const stop = Symbol('simulated process loss');
test('paired fixture: actual LK producer is accepted by actual CUP contract and its reserve result completes original owner', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/quarter-create-owner-v1.json', import.meta.url), 'utf8'));
  const h = new OwnerHarness();
  assert.deepEqual(h.admission, fixture.admission);
  h.runtime.policyDigest = fixture.cup.policyDigest;
  h.expectations = fixture.cup.preflight.expectations;
  h.decision = fixture.cup.reserve.decision;
  const r = h.execute();
  assert.deepEqual(h.targetInput, fixture.targetIntake);
  assert.equal(r.payload.operation.status, 'CONFIRMED');
  assert.equal(r.payload.operation.receipt.entitlement.policyDigest, fixture.cup.policyDigest);
  assert.equal(r.payload.operation.receipt.entitlement.reservedUnits, fixture.cup.reserve.decision.usageUnits);
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 1);
});
function crashAt(h, step, lane = 'gateway') {
  h.onMongo = (msg, actual) => {
    if (actual === lane && (msg._subscriptionBooking?.step === step || msg._gameCreateOwner?.step === step)) throw stop;
  };
  assert.throws(() => h.execute(), e => e === stop);
  delete h.onMongo;
}
test('actual owner entry persists original ID before sole organizer POST and returns separate immutable receipt/current observation', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => {
    if (msg.method === 'POST' && msg.url.endsWith('/bookings')) {
      assert.equal(canonical(h).providerCreateReceipt.exerciseId, 'exercise:original');
      assert.equal(canonical(h).state, 'PENDING_CONFIRMATION');
    }
  };
  const r = h.execute();
  assert.equal(r.payload.operation.status, 'CONFIRMED');
  assert.equal(r.payload.registration.status, 'CONFIRMED');
  const receipt = structuredClone(r.payload.operation.receipt);
  h.now += 1000;
  assert.deepEqual(h.execute({ mode: 'read' }).payload.operation.receipt, receipt);
  assert.deepEqual(h.execute({ recoveryOnly: true }).payload.operation.receipt, receipt);
  assert.deepEqual([h.providerCreates, h.bookingCreates, h.reserveCalls, h.confirmCalls], [1, 1, 1, 1]);
  assert.deepEqual(h.diagnostics, []);
  assert.equal(JSON.stringify([...h.rows.values()]).includes('synthetic-create-actor-token'), false);
  assert.equal(JSON.stringify([...h.rows.values()]).includes('synthetic-create-admin-token'), false);
});
test('reserve ACK loss replays immutable expectations without reprice, target intake, or new reserve identity', () => {
  const h = new OwnerHarness(); let lost = false;
  h.onHttp = msg => { if (!lost && msg.url.endsWith('/entitlements/reserve')) { lost = true; msg.error = { code: 'ETIMEDOUT' }; } };
  h.execute(); assert.equal(h.providerCreates, 0);
  const original = structuredClone(outer(h).binding);
  const targetReads = h.trace.filter(x => x.url.endsWith('/canonical-targets')).length;
  delete h.onHttp;
  const result = h.execute({ recoveryOnly: true });
  assert.equal(result.payload.operation.status, 'CONFIRMED');
  assert.deepEqual(outer(h).binding, original);
  assert.equal(h.trace.filter(x => x.url.endsWith('/canonical-targets')).length, targetReads);
  assert.equal(h.reserveCalls, 2); assert.equal(h.providerCreates, 1);
});
test('expired original capsule after reserve ACK loss atomically aborts UNUSED reserve before signed compensation', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.url.endsWith('/entitlements/reserve')) msg.error = { code: 'ETIMEDOUT' }; };
  h.execute(); delete h.onHttp; h.now += 61000;
  const result = h.execute({ recoveryOnly: true });
  assert.notEqual(result.payload.operation?.status, 'CONFIRMED');
  assert.equal(h.providerCreates, 0); assert.equal(h.bookingCreates, 0);
  assert.equal(canonical(h).state, 'RELEASED');
  assert.equal(result.payload.operation.status, 'REJECTED');
  assert.equal(result.payload.operation.receipt.schemaVersion, 2);
  assert.equal(result.payload.operation.receipt.reason, 'PRECREATE_EXPIRED_NOT_DISPATCHED');
  assert.equal(h.releaseCalls, 1);
});
test('durable attempt with process loss before original response ID can never repeat CREATE', () => {
  const h = new OwnerHarness(); crashAt(h, 'operation_precreated_attempt');
  assert.equal(canonical(h).state, 'PRECREATE_ATTEMPTING');
  for (let n = 0; n < 2; n++) h.execute({ recoveryOnly: true });
  assert.equal(h.providerCreates, 0); assert.equal(h.bookingCreates, 0);
});
for (const status of [409, 500, 200]) test('unattributable provider response remains UNKNOWN and is never adopted: ' + status, () => {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.url.endsWith('/api/v1/exercises') && msg.method === 'POST') {
    msg.statusCode = status; if (status === 200) msg.payload = { id: 'exercise:one', exerciseId: 'exercise:other' };
  } };
  h.execute(); delete h.onHttp;
  h.execute({ recoveryOnly: true });
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 0);
  assert.equal(canonical(h).providerCreateReceipt, undefined);
});
test('same-process lost CREATE-ID CAS ACK rereads exact receipt before organizer continuation', () => {
  const h = new OwnerHarness();
  h.onMongo = msg => { if (msg._subscriptionBooking?.step === 'quarter_create_response_ack') msg.error = { code: 'ACK_LOST' }; };
  assert.equal(h.execute().payload.operation.status, 'CONFIRMED');
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 1);
});
test('lost process after durable original CREATE ID recovers only that ID, without repeating CREATE', () => {
  const h = new OwnerHarness(); crashAt(h, 'quarter_create_response_ack');
  assert.equal(canonical(h).providerCreateReceipt.exerciseId, 'exercise:original');
  assert.equal(h.bookingCreates, 0);
  assert.equal(h.execute({ recoveryOnly: true }).payload.operation.status, 'CONFIRMED');
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 1);
});
test('actor expiry during original POST preserves ID custody but requires fresh actor for organizer mutation', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.url.endsWith('/api/v1/exercises') && msg.method === 'POST') h.now += 121000; };
  h.execute(); delete h.onHttp;
  assert.equal(canonical(h).providerCreateReceipt.exerciseId, 'exercise:original');
  assert.equal(h.bookingCreates, 0);
  assert.equal(h.execute({ recoveryOnly: true }).payload.operation.status, 'CONFIRMED');
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 1);
});
test('organizer ACK loss never adopts an unbound matching booking or repeats the booking POST', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.method === 'POST' && msg.url.endsWith('/bookings')) msg.error = { code: 'ETIMEDOUT' }; };
  h.execute(); delete h.onHttp;
  const r = h.execute({ recoveryOnly: true });
  assert.notEqual(r.payload.operation?.status, 'CONFIRMED');
  assert.equal(h.bookingCreates, 1); assert.equal(h.providerCreates, 1);
});
test('missing original operation on recovery/read never creates outer or canonical state', () => {
  const h = new OwnerHarness();
  h.execute({ recoveryOnly: true }); h.execute({ mode: 'read' });
  assert.equal(h.rows.size, 0); assert.equal(h.trace.length, 0);
});
test('original receipt remains historical while cancellation/contradictory identity makes current observation UNKNOWN', () => {
  const h = new OwnerHarness(); const receipt = h.execute().payload.operation.receipt;
  h.onHttp = msg => { if (msg.url.endsWith('/bookings?size=1000')) msg.payload[0].client = { id: 'foreign-client' }; };
  let r = h.execute({ mode: 'read' });
  assert.deepEqual(r.payload.operation.receipt, receipt); assert.equal(r.payload.registration.status, 'UNKNOWN');
  h.onHttp = msg => { if (msg.url.endsWith('/exercises/exercise%3Aoriginal')) msg.payload.cancelled = true; };
  r = h.execute({ mode: 'read' });
  assert.deepEqual(r.payload.operation.receipt, receipt); assert.equal(r.payload.registration.status, 'UNKNOWN');
});
for (const name of ['subscriptions_target_ingest_integration_token', 'subscriptions_runtime_api_base_url']) test('missing required purpose configuration refuses before target write: ' + name, () => {
  const h = new OwnerHarness(); delete h.globals[name]; h.execute();
  assert.equal(h.trace.some(x => x.url.endsWith('/canonical-targets')), false);
  assert.equal(h.providerCreates, 0);
});
test('foreign instance state and changed same-key capsule fail before provider dispatch', () => {
  const h = new OwnerHarness(); h.runtime.instance.state = 'PENDING_ACTIVATION'; h.execute();
  assert.equal(h.trace.some(x => x.url.endsWith('/canonical-targets')), false);
  const changed = structuredClone(h.admission); changed.target.expectedRevision++;
  assert.equal(h.execute({ body: changed }).statusCode, 400);
  assert.equal(h.providerCreates, 0);
});
test('financial body uses whole-court evidence once, one quarter entitlement and one organizer spot for exactly 60 minutes', () => {
  const h = new OwnerHarness(), requests = [], provider = h.provider.bind(h);
  h.provider = (msg, lane) => { requests.push({ url: msg.url, method: msg.method, body: structuredClone(msg.payload) }); return provider(msg, lane); };
  assert.equal(h.execute().payload.operation.status, 'CONFIRMED');
  const target = requests.find(r => r.url.endsWith('/canonical-targets')).body;
  assert.equal(target.price.amountMinor, h.preparation.pricing.courtWindowPriceMinor);
  assert.equal(target.price.amountMinor, h.decision.money.basePriceMinor * 4);
  const create = requests.find(r => r.url.endsWith('/api/v1/exercises')).body;
  assert.deepEqual(create, { directionId: 4588, typeId: 1613, timeFrom: '2035-04-02T12:00:00+03:00',
    timeTo: '2035-04-02T13:00:00+03:00', maxClientsCount: 4, roomId: h.claims.provider_room_id, trainers: [], requirements: [] });
  const book = requests.find(r => r.method === 'POST' && r.url.endsWith('/bookings')).body;
  assert.deepEqual(JSON.parse(JSON.stringify(book)), { clientId: h.claims.provider_client_id, paymentType: 'SUBSCRIPTION',
    clientSubscriptionId: h.claims.provider_client_subscription_id, customFields: [], spot: 1, count: 1 });
  assert.equal(canonical(h).managedDecision.money.basePriceMinor, h.preparation.pricing.quarterPriceMinor);
  assert.equal(canonical(h).managedDecision.money.finalPriceMinor, 0);
  assert.equal(canonical(h).managedDecision.usageUnits, 1);
  assert.equal(requests.some(r => /payment|refund|client-subscriptions/.test(r.url)), false);
});
test('concurrent original admission while winner holds observation/dispatch never gains a second writer', () => {
  const h = new OwnerHarness(); let competing;
  h.onMongo = msg => { if (!competing && msg._gameCreateOwner?.step === 'claimed_observation') {
    competing = true; const result = h.execute(); assert.notEqual(result.payload.operation?.status, 'CONFIRMED');
  } };
  assert.equal(h.execute().payload.operation.status, 'CONFIRMED');
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 1);
});
test('stale CREATE attempt CAS nonce cannot dispatch or replace current canonical generation', () => {
  const h = new OwnerHarness();
  h.onBeforeMongo = msg => { if (msg._subscriptionBooking?.step === 'operation_precreated_attempt') {
    canonical(h).state = 'PRECREATE_ATTEMPTING'; canonical(h).providerCreateAttemptId = 'another-attempt';
  } };
  h.execute(); assert.equal(h.providerCreates, 0); assert.equal(canonical(h).providerCreateAttemptId, 'another-attempt');
});
test('CUP confirm loss is pending until same operation confirms; no second CREATE/booking and no receipt from reserve alone', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.url.endsWith('/entitlements/confirm')) msg.error = { code: 'ACK_LOST' }; };
  const r = h.execute(); assert.notEqual(r.payload.operation?.status, 'CONFIRMED');
  assert.equal(canonical(h).state, 'CONFIRMED');
  delete h.onHttp;
  assert.equal(h.execute({ recoveryOnly: true }).payload.operation.status, 'CONFIRMED');
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 1); assert.equal(h.reserveCalls, 1);
});
test('corrupt persisted authority never reaches reserve or private receipt', () => {
  const h = new OwnerHarness(); crashAt(h, 'operation_precreated_attempt');
  const original = structuredClone([...h.rows.values()]);
  outer(h).binding.targetInput.price.amountMinor *= 4;
  const r = h.execute({ recoveryOnly: true });
  assert.equal(r.statusCode, 409); assert.equal(h.providerCreates, 0);
  assert.equal(canonical(h).state, original.find(x => x.managedCreateBinding).state);
});
test('capability absence, wrong actual route, expired actor and wrong read intent refuse without any database or provider mutation', () => {
  for (const change of [
    m => { m.req.originalUrl = '/lk/integrations/v1/game-create-preparations'; },
    m => { m.req.method = 'GET'; },
    m => { m.req.headers['x-subscription-actor-token'] = 'foreign-token'; },
    m => { m.payload.untrusted = true; },
  ]) {
    const h = new OwnerHarness(), msg = h.message(); change(msg);
    const result = h.invokeOwner('verify', msg);
    assert.ok(result[1]); assert.equal(h.rows.size, 0); assert.equal(h.trace.length, 0);
  }
  const h = new OwnerHarness();
  const body = { contractVersion: 1, operationId: h.claims.operation_id, admissionRequestSha256: 'sha256:' + 'f'.repeat(64) };
  const message = h.message({ mode: 'read', body });
  assert.ok(h.invokeOwner('verify', message)[0]); // Own signed READ hash is valid; original admission remains a separate check.
  h.execute();
  const result = h.execute({ mode: 'read', body });
  assert.equal(result.statusCode, 409);
});
test('definite original CREATE refusal enters existing durable compensation without repeating provider POST', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = { code: 'SYNTHETIC_REJECTED' }; } };
  h.execute();
  assert.equal(h.providerCreates, 1); assert.equal(h.bookingCreates, 0);
  assert.equal(canonical(h).state, 'RELEASED'); assert.equal(h.releaseCalls, 1);
  assert.equal(h.execute({ recoveryOnly: true }).payload.operation.status, 'REJECTED');
  assert.equal(h.providerCreates, 1); assert.equal(h.releaseCalls, 1);
});
test('durable rejected receipt precedes canonical reclaim; old retry/read returns original history after a new CREATE', () => {
  const old = new OwnerHarness();
  old.onHttp = msg => { if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = {}; } };
  const receipt = old.execute().payload.operation.receipt;
  assert.equal(receipt.outcome, 'REJECTED');
  const next = new OwnerHarness({ key: 'synthetic-explicit-replacement-key', revision: 2 }); next.rows = old.rows;
  const response = next.execute(); assert.equal(response.payload.operation.status, 'CONFIRMED');
  assert.equal(next.providerCreates, 1); assert.equal(next.bookingCreates, 1);
  assert.equal(canonical(next).operationId, next.claims.operation_id);
  assert.deepEqual(old.execute({ recoveryOnly: true }).payload.operation.receipt, receipt);
  assert.deepEqual(old.execute({ mode: 'read' }).payload.operation.receipt, receipt);
  assert.equal(canonical(next).operationId, next.claims.operation_id);
});
function rejectedHarness({ beforeReceipt = false } = {}) {
  const h = new OwnerHarness();
  h.onHttp = msg => { if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = {}; } };
  if (beforeReceipt) h.onBeforeMongo = msg => { if (msg._gameCreateOwner?.step === 'completed_ack') throw stop; };
  if (beforeReceipt) assert.throws(() => h.execute(), e => e === stop); else h.execute();
  delete h.onBeforeMongo; return h;
}
test('release timeout/no APPLIED readback cannot produce rejected proof or enable replacement', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => {
    if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = {}; }
    if (msg.url.endsWith('/entitlements/release')) msg.error = { code: 'ETIMEDOUT' };
    if (msg.url.endsWith('/entitlements/readback')) msg.payload.compensationState = 'NONE';
  };
  assert.notEqual(h.execute().payload.operation?.status, 'REJECTED');
  const next = new OwnerHarness({ key: 'synthetic-denied-replacement', revision: 2 }); next.rows = h.rows;
  next.execute(); assert.equal(next.providerCreates, 0); assert.equal(next.reserveCalls, 0);
  assert.equal(canonical(h).state, 'PRECREATE_RECONCILIATION_REQUIRED');
});
test('canonical release without persisted outer receipt cannot be reclaimed; same-operation replay finalizes exact proof first', () => {
  const h = rejectedHarness({ beforeReceipt: true }); assert.equal(canonical(h).state, 'RELEASED');
  const next = new OwnerHarness({ key: 'synthetic-before-receipt-key', revision: 2 }); next.rows = h.rows;
  next.execute(); assert.equal(next.reserveCalls, 0); assert.equal(next.providerCreates, 0);
  assert.equal(h.execute({ recoveryOnly: true }).payload.operation.status, 'REJECTED');
});
test('lost rejected-receipt ACK rereads stable terminal proof; lost reclaim ACK rereads exact new original operation', () => {
  const old = new OwnerHarness();
  old.onHttp = msg => { if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = {}; } };
  old.onMongo = msg => { if (msg._gameCreateOwner?.step === 'completed_ack') msg.error = { code: 'LOST_RECEIPT_ACK' }; };
  const receipt = old.execute().payload.operation.receipt; assert.equal(receipt.outcome, 'REJECTED');
  const next = new OwnerHarness({ key: 'synthetic-reclaim-ack-key', revision: 2 }); next.rows = old.rows;
  next.onMongo = msg => { if (msg._subscriptionBooking?.step === 'operation_reclaim') msg.error = { code: 'LOST_RECLAIM_ACK' }; };
  assert.equal(next.execute().payload.operation.status, 'CONFIRMED');
  assert.deepEqual(old.execute({ mode: 'read' }).payload.operation.receipt, receipt);
});
test('two new operations racing on released preimage only one reclaims; old retry cannot touch winner', () => {
  const old = rejectedHarness(), first = new OwnerHarness({ key: 'synthetic-replacement-one', revision: 2 }), second = new OwnerHarness({ key: 'synthetic-replacement-two', revision: 3 });
  first.rows = old.rows; second.rows = old.rows; let competing = false;
  first.onBeforeMongo = msg => { if (msg._subscriptionBooking?.step === 'operation_reclaim' && !competing) {
    competing = true; assert.equal(second.execute().payload.operation.status, 'CONFIRMED');
    assert.equal(old.execute({ recoveryOnly: true }).payload.operation.status, 'REJECTED');
  } };
  first.execute(); assert.equal(first.providerCreates, 0); assert.equal(first.reserveCalls, 0);
  assert.equal(second.providerCreates, 1); assert.equal(canonical(second).operationId, second.claims.operation_id);
});
for (const corrupt of [
  row => { row.providerCreateReceipt = { exerciseId: 'exercise:already-created' }; },
  row => { row.exerciseId = 'exercise:already-created'; },
  row => { row.managedCreateReleaseProof.readback.compensationState = 'NONE'; },
  row => { row.precreateRejection.actorClientId = 'foreign-actor'; },
  row => { row.managedCreateBinding.identity.userId = '22222222-2222-4222-8222-222222222222'; },
]) test('reclaim refuses altered original authority: ' + corrupt.toString(), () => {
  const old = rejectedHarness(); corrupt(canonical(old));
  const next = new OwnerHarness({ key: 'synthetic-refused-reclaim', revision: 2 }); next.rows = old.rows;
  next.execute(); assert.equal(next.providerCreates, 0); assert.equal(next.reserveCalls, 0);
});
test('canonical persistence error suppresses diagnostics and final reply removes actor/provider transport context', () => {
  const h = new OwnerHarness(); let captured;
  h.onBeforeMongo = msg => { if (msg._subscriptionBooking?.step === 'operation_precreated_attempt') { captured = structuredClone(msg); throw stop; } };
  assert.throws(() => h.execute(), e => e === stop);
  captured.error = { message: 'synthetic failure with private context' };
  const failed = h.invokeOwner('mongoError', captured);
  const returned = h.invokeOwner('finalize', failed)[1];
  returned._gameCreateOwnerReply = { code: 'GAME_CREATE_OWNER_RECONCILIATION_REQUIRED' };
  const response = h.invokeOwner('response', returned);
  assert.deepEqual(h.diagnostics, []);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(response), /synthetic-create-actor-token|synthetic-create-admin-token|_subscriptionBooking|_gameCreateOwner|actor_token_sha256|ownerBookingReadback/);
});
for (const kind of ['foreign-actor', 'cancelled-exercise', 'read-timeout']) test('original ID recovery refuses organizer mutation on ' + kind, () => {
  const h = new OwnerHarness(); crashAt(h, 'quarter_create_response_ack');
  const original = structuredClone(canonical(h).providerCreateReceipt);
  h.onHttp = msg => {
    if (kind === 'foreign-actor' && msg.url.endsWith('/profile')) msg.payload.id = 'foreign-client';
    if (kind === 'cancelled-exercise' && msg.url.endsWith('/exercises/exercise%3Aoriginal')) msg.payload.isCancelled = true;
    if (kind === 'read-timeout' && msg.url.endsWith('/profile')) msg.error = { code: 'ETIMEDOUT' };
  };
  const response = h.execute({ recoveryOnly: true });
  assert.notEqual(response.payload.operation?.status, 'CONFIRMED');
  assert.equal(h.bookingCreates, 0); assert.equal(h.providerCreates, 1);
  assert.deepEqual(canonical(h).providerCreateReceipt, original);
});
test('post-TTL definite rejection reads already applied CUP release without signing a new stale rejection', () => {
  const h = new OwnerHarness();
  h.onHttp = msg => {
    if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = {}; }
    if (msg.url.endsWith('/entitlements/readback')) msg.error = { code: 'READBACK_LOST' };
  };
  h.execute(); assert.equal(canonical(h).state, 'PRECREATE_RECONCILIATION_REQUIRED');
  const observedAt = canonical(h).precreateRejection.observedAt;
  delete h.onHttp; h.now += 61000;
  const r = h.execute({ recoveryOnly: true }); assert.equal(r.payload.operation.status, 'REJECTED');
  assert.equal(r.payload.operation.receipt.providerRejectedAt, observedAt);
  assert.equal(h.releaseCalls, 1); assert.equal(h.providerCreates, 1);
});
test('outer journal has no legacy daily/leave/visit/reconcile selector fields or BSON TTL dates', () => {
  const h = new OwnerHarness(); h.execute(); const row = outer(h);
  for (const key of ['state', 'tenantKey', 'actorClientId', 'clientSubscriptionId', 'exerciseId', 'serviceDate', 'lk1']) assert.equal(Object.hasOwn(row, key), false);
  const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_split_leave_daily_limit_find.js', import.meta.url), 'utf8');
  const query = new Function('msg', source)({ _splitLeaveCtx: { targetClientId: h.claims.provider_client_id,
    exerciseId: 'exercise:original', initialBookingIds: ['booking:original'] } })[0].payload;
  assert.equal(matches(row, query), false);
  assert.equal(planHungClaimRelease({ operation: row, bookings: [], now: new Date(h.now + 86400000).toISOString() }).releasable, false);
  const inspect = value => { assert.equal(value instanceof Date, false); if (value && typeof value === 'object') Object.values(value).forEach(inspect); };
  inspect(row);
});

function expiredUnused() {
  const h = new OwnerHarness(); crashAt(h, 'operation_entitlement_bind'); h.now += 61000; return h;
}
test('unused expiry CAS and release/outer ACK loss retain one immutable receipt across late retry and new reclaim', () => {
  const h = expiredUnused();
  h.onMongo = msg => { if (['quarter_unused_abort_ack', 'quarter_unused_release_ack'].includes(msg._subscriptionBooking?.step)
    || msg._gameCreateOwner?.step === 'completed_ack') { msg.error = { code: 'LOST_ACK' }; msg.payload = undefined; } };
  h.onHttp = msg => { if (msg.url.endsWith('/entitlements/release')) msg.error = { code: 'LOST_RELEASE_ACK' }; };
  const r = h.execute({ recoveryOnly: true }).payload;
  assert.equal(r.operation.status, 'REJECTED'); assert.equal(r.operation.receipt.schemaVersion, 2);
  const receipt = structuredClone(r.operation.receipt); assert.equal(h.providerCreates, 0); assert.equal(h.bookingCreates, 0);
  assert.equal(receipt.capsuleExpiresAt, h.preparation.expiresAt);
  assert.equal(receipt.abortedAt, canonical(h).quarterPrecreateAbort.abortedAt);
  h.now += 120000; delete h.onMongo; delete h.onHttp;
  assert.deepEqual(h.execute({ recoveryOnly: true }).payload.operation.receipt, receipt);
  assert.deepEqual(h.execute({ mode: 'read' }).payload.operation.receipt, receipt);
  assert.equal(h.releaseCalls, 1);
  const next = new OwnerHarness({ key: 'new-after-unused-expiry', revision: 2, now: h.now }); next.rows = h.rows;
  assert.equal(next.execute().payload.operation.status, 'CONFIRMED');
  assert.equal(canonical(next).quarterPrecreateAbort, undefined);
  assert.deepEqual(h.execute({ recoveryOnly: true }).payload.operation.receipt, receipt);
});
test('crash after abort CAS before release recovers only exact durable marker with a fresh proof after TTL', () => {
  const h = expiredUnused(); h.onMongo = msg => { if (msg._subscriptionBooking?.step === 'quarter_unused_abort_ack') throw stop; };
  assert.throws(() => h.execute({ recoveryOnly: true }), e => e === stop);
  const marker = structuredClone(canonical(h).quarterPrecreateAbort); assert.equal(h.releaseCalls, 0);
  delete h.onMongo; h.now += 120000;
  const r = h.execute({ recoveryOnly: true }); assert.equal(r.payload.operation.status, 'REJECTED');
  assert.deepEqual(canonical(h).quarterPrecreateAbort, marker); assert.equal(h.providerCreates, 0);
});
test('attempt winner always remains UNKNOWN and cannot be inferred unused after expiry', () => {
  const h = new OwnerHarness(); crashAt(h, 'operation_precreated_attempt'); h.now += 120000;
  h.execute({ recoveryOnly: true }); assert.equal(h.releaseCalls, 0); assert.equal(h.providerCreates, 0);
  assert.equal(canonical(h).state, 'PRECREATE_ATTEMPTING');
});
for (const key of ['providerCreateAttemptId','providerCreateReceipt','bookingId','upstreamBookingId','upstreamAttemptedAt',
  'precreateRecoveryTarget','precreateRecoveredAt','precreatedEntitlementReserved','confirmedAt',
  'precreateReconciliationRequiredAt','precreateReconciliationCode','pendingUntil','acceptedAt','releaseBookingId','managedSelfLeaveCancellation','managedSelfLeaveReceipt'])
  test('unused expiry refuses any present evidence: '+key, () => {
    const h = expiredUnused(); canonical(h)[key] = null;
    h.execute({ recoveryOnly: true }); assert.equal(h.releaseCalls, 0); assert.equal(canonical(h).state, 'PRECREATE_RESERVED');
  });
test('unsigned mode, foreign immutable marker, and pending CUP compensation never authorize terminal rejection', () => {
  for (const kind of ['unsigned', 'marker', 'cup']) {
    const h = expiredUnused();
    h.onMongo = msg => { if (msg._subscriptionBooking?.step === 'quarter_unused_abort_ack') {
      if (kind === 'marker') canonical(h).quarterPrecreateAbort.usageOperationId = 'usage:foreign';
      if (kind === 'unsigned') h.globals.subscriptions_owner_evidence_enabled = false;
    } };
    if (kind === 'cup') h.onHttp = msg => { if (msg.url.endsWith('/entitlements/readback')) msg.payload.compensationState = 'PENDING'; };
    const r = h.execute({ recoveryOnly: true }); assert.notEqual(r.payload.operation?.status, 'REJECTED');
    assert.equal(canonical(h).state, 'PRECREATE_ABORTING'); assert.equal(h.providerCreates, 0);
  }
});

test('actual unused expiry producer emits exact frozen schema2 parity fixture',()=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/quarter-create-expired-v2.json',import.meta.url),'utf8'));
 const h=new OwnerHarness();crashAt(h,'operation_entitlement_bind');h.now+=61000;
 h.onBeforeMongo=msg=>{if(msg._subscriptionBooking?.step==='quarter_unused_abort_ack')
   msg.payload[1][0].$set.quarterPrecreateAbort.$mergeObjects[0].$literal.abortId=fixture.receipt.abortId;};
 const result=h.execute({recoveryOnly:true});
 assert.deepEqual(result.payload.operation.receipt,fixture.receipt);
 assert.equal(h.providerCreates,0);assert.equal(h.bookingCreates,0);
});

for (const corrupt of ['missing-digest','usage','abort','abortedAt','rejectedAt'])
test('schema2 terminal checksum denies partial corruption without canonical repair: '+corrupt,()=>{
 const h=new OwnerHarness();crashAt(h,'operation_entitlement_bind');h.now+=61000;
 const original=h.execute({recoveryOnly:true}).payload.operation.receipt;
 const row=outer(h);assert.match(row.rejectionReceiptSha256,/^sha256:[a-f0-9]{64}$/);
 if(corrupt==='missing-digest') delete row.rejectionReceiptSha256;
 if(corrupt==='usage') row.rejectionReceipt.entitlement.usageOperationId='usage:foreign';
 if(corrupt==='abort') row.rejectionReceipt.abortId='11111111-1111-4111-8111-000000000081';
 if(corrupt==='abortedAt') row.rejectionReceipt.abortedAt=original.capsuleExpiresAt;
 if(corrupt==='rejectedAt') {h.now+=1000;row.rejectionReceipt.rejectedAt=new Date(h.now).toISOString();}
 const releaseCount=h.releaseCalls;
 assert.equal(h.execute({mode:'read'}).payload.operation.status,'UNKNOWN');
 assert.equal(h.execute({recoveryOnly:true}).payload.operation.status,'UNKNOWN');
 const next=new OwnerHarness({key:'synthetic-denied-reclaim',revision:2,now:h.now});
 for(const row of h.rows.values())next.rows.set(row._id,structuredClone(row));
 next.execute();assert.equal(next.reserveCalls,0);assert.equal(next.providerCreates,0);
 assert.equal(h.releaseCalls,releaseCount);assert.equal(h.providerCreates,0);
});
test('schema2 terminal reordered keys and lost outer ACK preserve checksum and allow exact later reclaim',()=>{
 const h=new OwnerHarness();crashAt(h,'operation_entitlement_bind');h.now+=61000;
 h.onMongo=(msg,lane)=>{if(lane==='router'&&msg._gameCreateOwner?.step==='completed_ack') {msg.error={code:'lost'};msg.payload=undefined;}};
 const result=h.execute({recoveryOnly:true});delete h.onMongo;
 assert.equal(result.payload.operation.status,'REJECTED');
 const row=outer(h), digest=row.rejectionReceiptSha256;
 const reverse=x=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).reverse().map(([k,v])=>[k,reverse(v)])):x;
 row.rejectionReceipt=reverse(row.rejectionReceipt);
 assert.deepEqual(h.execute({mode:'read'}).payload.operation.receipt,result.payload.operation.receipt);
 assert.equal(row.rejectionReceiptSha256,digest);
 const next=new OwnerHarness({key:'synthetic-reordered-reclaim',revision:2,now:h.now});
 for(const row of h.rows.values())next.rows.set(row._id,structuredClone(row));
 assert.equal(next.execute().payload.operation.status,'CONFIRMED');
 assert.equal(h.execute({recoveryOnly:true}).payload.operation.status,'REJECTED');
});

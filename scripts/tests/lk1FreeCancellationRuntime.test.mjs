import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFreeCancellation, applyFreeCancellationOwnedSource } from '../patch_live_lk1_free_cancellation.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { runLk1FreeCancellationJob } from '../lib/lk1FreeCancellationWorker.mjs';
import { lk1FreeReturnedOperation } from '../lib/lk1FreeCancellation.mjs';
import { fixture, jobOf } from './fixtures/lk1FreeCancellationFixtures.mjs';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const prepared = applyFreeCancellationOwnedSource(read('../nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js'),
  'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js');
const prepare = new Function('msg', 'node', 'global', 'env', prepared);
const host = { get() {} }, node = { warn() {}, error() {} };
function prepareMessage(body = {}) {
  const msg = { req: { method: 'POST', headers: { authorization: 'Bearer fixture-actor-token' },
    query: { operationId: 'fixture-cancel-request' } }, payload: { action: 'cancel-free', bookingId: 'booking', ...body } };
  return prepare(msg, node, host, host);
}
test('prepared public action carries only an authenticated exact-booking intent', () => {
  const out = prepareMessage(); assert.ok(out[0]);
  assert.equal(out[0]._subscriptionBooking.action, 'cancel-free');
  assert.equal(out[0]._subscriptionBooking.actorClientId, undefined);
  assert.equal(out[0].method, 'GET'); assert.match(out[0].url, /\/profile$/);
  for (const body of [{ actorClientId: 'other' }, { returnVerified: true }, { baseline: {} },
    { managedSelfLeave: {} }, { freeCancellationJob: {} }]) {
    assert.equal(prepareMessage(body)[1].statusCode, 400);
  }
});
const livePath = process.env.LK1_FREE_CANCEL_LIVE_SOURCE
  || '/private/tmp/lk1-free-visit-cancel-release-20261111/live-final/input/source.flow.json';
const liveAvailable = fs.existsSync(livePath);
let flow, router, finalizer, fingerprint;
if (liveAvailable) {
  const built = composeFreeCancellation(fs.readFileSync(livePath)); flow = JSON.parse(built.candidateBytes);
  const body = flow.find(n => n.id === 'lk_subscription_booking_router_20260804').func;
  router = new Function('msg', 'node', 'global', 'env', 'flow', body);
  finalizer = new Function('msg', 'node', 'global', 'env', 'flow', flow.find(n => n.id === 'lk_subscription_booking_finalize_20260804').func);
  fingerprint = new Function(extractSubscriptionPricePreviewSource({ source: body, roots: ['lk1Fingerprint'] }).source + ';return lk1Fingerprint;')();
}
const skip = !liveAvailable && 'private live source is not exported to Git/CI';
const product = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
function runtimeFixture() {
  const f = fixture(); f.db.rows.delete(f.op._id); f.op.tenantKey = 'iSkq6G';
  f.op._id = `lk1-product:${JSON.stringify(['iSkq6G', f.op.actorClientId, f.op.operationId])}`;
  f.op.createdAt = new Date(Date.now() - 20000).toISOString(); f.op.updatedAt = new Date(Date.now() - 10000).toISOString();
  f.op.lk1.rule = { productId: product, maxActiveBookings: 8, freeGameMinutesPerDay: 120,
    gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  f.op.lk1.target = { ...f.op.lk1.target, resolutionSource: 'SERVER', directionId: 5280, currency: 'RUB',
    priceSource: 'VIVA_EXISTING_TARIFF', basePriceMinor: 400000, durationMinutes: 90, stationId: 'station', roomId: 'room',
    externalEventTypeId: 'viva:direction:5280:type:1013' };
  f.op.lk1.purchaseDate = '2026-11-01';
  f.op.lk1.fingerprint = fingerprint({ ...f.op, caller: 'http', managedAction: 'BOOK_TOURNAMENT' }, f.op.lk1);
  f.db.rows.set(f.op._id, structuredClone(f.op)); f.sub.product.id = product;
  const token = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url') + '.fixture';
  f.host = { get: key => key === 'vivacrm_access_token' ? token : undefined };
  return f;
}
function execute(msg, f) { return router(msg, node, f.host, host, host); }
async function pipeline(f, options = {}) {
  let msg = prepareMessage()[0];
  msg.statusCode = 200; msg.payload = { id: 'actor', phone: '70000000000' }; msg.responseUrl = msg.url;
  for (let hop = 0; hop < 100; hop++) {
    const ports = execute(msg, f), port = ports.findIndex(Boolean); msg = ports[port];
    assert.notEqual(port, 7, 'cancel-free must not enter product identity with an empty subscription');
    if (port === 4) return finalizer(msg, node, f.host, host, host)[1];
    if (port === 0) {
      const u = new URL(msg.url), expected = msg.url;
      const result = await f.provider.request({ method: msg.method, path: u.pathname + u.search, body: msg.payload });
      msg.payload = result.payload; msg.statusCode = result.status; msg.responseUrl = options.badProvenance ? 'https://other.invalid/' : expected;
    } else if (port === 1) { msg.payload = await f.db.find(msg.payload).limit(1001).toArray(); }
    else if (port === 3) { const [q, c, o] = msg.payload; msg.payload = await f.db.updateOne(q, c, o); }
    else throw Error('unexpected port ' + port);
  }
  throw Error('pipeline hop limit');
}
test('actual prepare/profile/router/Mongo/HTTP/finalizer cancels a native free booking', { skip }, async () => {
  const f = runtimeFixture(), result = await pipeline(f);
  assert.equal(result.statusCode, 200); assert.equal(result.payload.state, 'RELEASED');
  assert.equal(jobOf(f).phase, 'DONE'); assert.ok(lk1FreeReturnedOperation(f.db.rows.get(f.op._id)));
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 1);
});
test('actual actor route refuses stale tokens and foreign HTTP response provenance before accepting work', { skip }, async () => {
  const f = runtimeFixture(); f.host = { get: key => key === 'vivacrm_access_token' ? 'invalid-expired-token' : undefined };
  const expired = await pipeline(f); assert.equal(expired.statusCode, 503); assert.notEqual(expired.payload.accepted, true);
  assert.equal([...f.db.rows.values()].filter(r => r.kind === 'LK1_FREE_CANCEL_JOB_V1').length, 0);
  const g = runtimeFixture(), foreign = await pipeline(g, { badProvenance: true });
  assert.equal(foreign.statusCode, 503); assert.notEqual(foreign.payload.accepted, true);
  assert.equal(g.provider.calls.filter(c => c.method === 'PUT').length, 0);
});
test('actual queue survives a closed browser and finishes through the same worker state machine', { skip }, async () => {
  const f = runtimeFixture(), original = f.provider.request.bind(f.provider);
  f.provider.request = async e => e.path.endsWith('/cancel') && e.method === 'GET'
    ? { status: 503, payload: null } : original(e);
  const pending = await pipeline(f); assert.equal(pending.statusCode, 202); assert.equal(pending.payload.accepted, true);
  f.provider.request = original;
  const result = await runLk1FreeCancellationJob({ job: structuredClone(jobOf(f)), operations: f.db, provider: f.provider });
  assert.equal(result.state, 'RELEASED'); assert.equal(jobOf(f).phase, 'DONE');
});
test('returned native proof permits exact HTTP successor and daily guard takeover', { skip }, async () => {
  const f = runtimeFixture(); await pipeline(f); const old = f.db.rows.get(f.op._id);
  const ctx = { ...f.op, action: 'book', caller: 'http', managedAction: 'BOOK_TOURNAMENT', actorPhone: '70000000000',
    step: 'lk1_ingress_operation_find', lk1IngressReplay: true };
  delete ctx.lk1;
  const released = execute({ _subscriptionBooking: ctx, payload: [old] }, f)[4];
  assert.equal(released.statusCode, 409); assert.equal(released.payload.details.nextOperationId, 'lk-subscription-fixture:rejoin:1');
  const child = { ...ctx, operationId: released.payload.details.nextOperationId, operationKey: 'new-operation' };
  const lookup = execute({ _subscriptionBooking: child, payload: [] }, f)[1]; assert.deepEqual(lookup.payload, { _id: old._id });
  const fresh = execute({ ...lookup, payload: [old] }, f); assert.ok(fresh[7], 'successor enters fresh instance verification');
  const guardCtx = { ...ctx, operationId: 'lk-subscription-other', operationKey: 'new-operation', exerciseId: 'another-exercise',
    step: 'lk1_daily_visit_owner', lk1: { ...f.op.lk1, dailyVisitPolicyVersion: 1 },
    lk1DailyVisitPrevious: { _id: 'daily-guard', kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: old._id, ownerOperationId: old.operationId } };
  const takeover = execute({ _subscriptionBooking: guardCtx, payload: [old] }, f)[3];
  assert.equal(guardCtx.step, 'lk1_daily_visit_takeover'); assert.equal(takeover.payload[0].ownerOperationKey, old._id);
});
test('actual finalizer preserves a cancellation prewrite refusal and exact booking lookup excludes ancestors', { skip }, () => {
  const f = runtimeFixture(), ctx = { ...f.op, caller: 'http', action: 'book', step: 'lk1_free_cancel_booking_gate', lk1: f.op.lk1 };
  const out = execute({ _subscriptionBooking: ctx, payload: [{ kind: 'LK1_FREE_CANCEL_JOB_V1' }] }, f)[4];
  assert.equal(finalizer(out, node, f.host, host, host)[1].statusCode, 409);
  const body = flow.find(n => n.id === 'lk_subscription_booking_router_20260804').func;
  assert.match(body, /\$or: \[\{ bookingId: ctx\.releaseBookingId \}, \{ upstreamBookingId: ctx\.releaseBookingId \}\]/);
});

import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const run = (file, msg) => vm.runInNewContext('(function(){' + fs.readFileSync('scripts/nodered_games_nodes/' + file, 'utf8') + '\n})()',
  { msg, global: { get: () => 'fixture-service-token' }, node: { warn() {} }, Buffer });
function prepare() {
  return { _splitLeaveCtx: { step: 'authorize_leave', mode: 'ORGANIZER_TARGET', gameId: 'game', actorClientId: 'actor',
    legacyRequestedClientId: 'member', legacyRequestedBookingIds: ['current-booking'], operationId: 'request' },
  payload: [{ id: 'game', updatedAt: '2099-11-10T10:00:00Z', organizer: { id: 'actor' },
    participants: [{ id: 'actor' }, { id: 'member', status: 'CONFIRMED' }],
    booking: { exerciseId: 'exercise', durationMinutes: 120 }, metadata: { splitPayment: {
      vivaExerciseId: 'exercise', payments: [{ clientId: 'member', bookingId: 'old-booking', status: 'LEFT' }] } } }] };
}
test('current organizer may discover replacement for a stored member, without trusting supplied IDs', () => {
  const msg = prepare(); const out = run('fn_split_leave_authorize.js', msg);
  assert.ok(out[3]); assert.equal(msg._splitLeaveCtx.targetClientId, 'member');
  assert.equal(msg._splitLeaveCtx.organizerBookingDiscovery, true);
  assert.equal(msg._splitLeaveCtx.membershipVersion, null);
  assert.equal(msg._splitLeaveCtx.subscriptionVisitCount, null, 'never guess two visits from two hours');
  assert.equal(msg._splitLeaveCtx.initialBookingIds.length, 0);
});
for (const change of [m => m._splitLeaveCtx.actorClientId = 'attacker', m => m._splitLeaveCtx.legacyRequestedClientId = 'stranger',
  m => m.payload[0].participants[1].status = 'CANCELLED', m => m._splitLeaveCtx.legacyRequestedClientId = 'actor']) {
  test('discovery cannot widen organizer or member authority', () => {
    const m = prepare(); change(m); const out = run('fn_split_leave_authorize.js', m); assert.equal(out[0], null); assert.ok(m.statusCode >= 400);
  });
}
test('provider replacement gets a new membership generation before durable start', () => {
  const m = prepare(); run('fn_split_leave_authorize.js', m);
  m._splitLeaveCtx.step = 'verify_active'; m.statusCode = 200;
  m.payload = { content: [{ id: 'current-booking', client: { id: 'member' }, exerciseId: 'exercise', isCancelled: false }], last: true, totalElements: 1 };
  const out = run('fn_split_leave_router.js', m);
  assert.ok(out[4]); assert.deepEqual(Array.from(m._splitLeaveCtx.initialBookingIds), ['current-booking']);
  assert.match(m._splitLeaveCtx.operationId, /^organizer-leave:game:actor:member:/);
});
test('multiple current bookings cannot be silently cancelled as one member generation', () => {
  const m = prepare(); run('fn_split_leave_authorize.js', m); m._splitLeaveCtx.step = 'verify_active'; m.statusCode = 200;
  m.payload = { content: ['one', 'two'].map(id => ({ id, client: { id: 'member' }, exerciseId: 'exercise', isCancelled: false })), last: true, totalElements: 2 };
  const out = run('fn_split_leave_router.js', m); assert.equal(out[0], null); assert.equal(m.statusCode, 409);
});
for (const method of ['SERVICE', 'CURRENCY', 'DEPOSIT']) {
  test(`replacement discovery cannot inherit legacy ${method} refund authority`, () => {
    const m = prepare(); run('fn_split_leave_authorize.js', m);
    const c = m._splitLeaveCtx;
    Object.assign(c, { step: 'cancel_probe', currentBookingId: 'current-booking', currentClientId: 'member',
      requestedRefundMethod: method, subscriptionVisitCount: 1, clientSubscriptionId: 'instance', bookingResults: [] });
    m.statusCode = 200; m.payload = { cancellationOptions: method === 'SERVICE'
      ? { subscription: { available: true } } : method === 'CURRENCY'
        ? { money: { available: true, refundSum: 5000 } } : { deposit: { available: true, refundSum: 5000 } } };
    let out = run('fn_split_leave_router.js', m);
    if (method === 'SERVICE') {
      assert.equal(m.method, 'GET'); m.statusCode = 200;
      m.payload = { content: [{ subscriptionId: 'instance', visitsLeft: 29,
        bookings: [{ id: 'current-booking', isCancelled: false }] }] };
      out = run('fn_split_leave_router.js', m);
    }
    assert.equal(out[0], null); assert.equal(m.statusCode, 409);
    assert.equal(m.payload.code, 'NEEDS_PROVIDER_RETURN_PROOF');
    assert.notEqual(m.method, 'PUT'); assert.notEqual(m.method, 'DELETE');
  });
}
test('missing exact consumption count cannot be inferred from game duration', () => {
  const m = prepare(); run('fn_split_leave_authorize.js', m);
  Object.assign(m._splitLeaveCtx, { step: 'cancel_probe', currentBookingId: 'current-booking',
    currentClientId: 'member', bookingResults: [] });
  m.statusCode = 200; m.payload = { cancellationOptions: { subscription: { available: true } } };
  const out = run('fn_split_leave_router.js', m);
  assert.equal(out[0], null); assert.equal(m.payload.code, 'NEEDS_VISIT_COUNT');
});

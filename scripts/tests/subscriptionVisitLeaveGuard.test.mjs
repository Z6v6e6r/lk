import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_split_leave_daily_limit_route.js', import.meta.url), 'utf8');
const execute = msg => new Function('msg', source)(structuredClone(msg));
const operation = { _id: 'fixture:claim', state: 'CONFIRMED', bookingId: 'fixture:booking' };
const request = state => ({ _splitLeaveCtx: { operationId: 'fixture:leave', gameId: 'fixture:game',
  targetClientId: 'fixture:client', exerciseId: 'fixture:exercise', initialBookingIds: ['fixture:booking'],
  subscriptionReturnState: state }, payload: [operation] });
test('pending visit return removes cancelled membership without releasing daily minutes', () => {
  const output = execute(request('RETURN_PENDING'));
  assert.equal(output[0], null, 'no RELEASED update'); assert.ok(output[1], 'continue local roster cleanup');
  assert.equal(output[1]._splitLeaveCtx.dailyLimitReleaseOutcome, 'RETURN_PENDING');
});
test('verified retry releases the same allowance and avoids another roster mutation', () => {
  const message = request('RETURN_VERIFIED'); message._splitLeaveCtx.localAlreadyApplied = true;
  const output = execute(message);
  assert.ok(output[0]); assert.equal(output[0].payload[1].$set.state, 'RELEASED');
  assert.equal(output[0].payload[0]._id, operation._id);
  assert.equal(output[0].payload[1].$set.releaseBookingId, operation.bookingId);
});
test('money-only cancellation retains existing release behavior', () => {
  assert.equal(execute(request(null))[0].payload[1].$set.state, 'RELEASED');
});
test('failed or malformed allowance reads stay pending instead of being treated as no operation', () => {
  for (const extra of [{ error: { code: 'fixture' } }, { payload: {} }, { payload: undefined }]) {
    const output = execute({ ...request('RETURN_VERIFIED'), ...extra });
    assert.equal(output[0], null); assert.equal(output[1], null);
    assert.equal(output[3].payload.reason, 'daily_limit_read_unavailable');
  }
});
test('wrong booking remains rejected even while waiting for visit return', () => {
  const message = request('RETURN_PENDING'); message.payload = [{ ...operation, bookingId: 'fixture:other' }];
  assert.equal(execute(message)[3].payload.reason, 'daily_limit_booking_mismatch');
});

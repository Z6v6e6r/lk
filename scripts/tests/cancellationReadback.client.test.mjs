import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
const utils = fs.readFileSync('src/utils/bookingCancellation.ts', 'utf8');
const pure = stripTypeScriptTypes(utils).replace(/^export /gm, '');
const { resolve, failure } = new Function(pure + ';return {resolve:resolveBookingCancellationVerification,failure:bookingCancellationFailureMessage};')();
function verifier(fetch, proof = () => false) {
  const body = source.slice(source.indexOf('export async function apiVerifyBookingCancellation'),
    source.indexOf('export async function apiFetchBookingCancellationOptions'));
  return new Function('apiFetchBookings', 'nativeSubscriptionCancellationVerified', 'readAuthToken',
    'resolveBookingCancellationVerification', stripTypeScriptTypes(body).replace(/^export /, '')
    + ';return apiVerifyBookingCancellation;')(fetch, proof, () => 'fixture', resolve);
}
test('session-bound native return proof wins over stale projections without another read or write', async () => {
  const result = await verifier(async () => { throw Error('stale lists must not override exact native proof'); },
    (id, token) => id === 'booking' && token === 'fixture')('booking');
  assert.equal(result.data.state, 'cancelled'); assert.equal(result.error, null);
});
const page = (content, number = 0, pages = 1, total = content.length) => ({ data: {
  content, totalPages: pages, totalElements: total, pageable: { pageNumber: number } }, error: null, status: 200 });
test('readback follows fresh pagination and never misses a later cancelled booking', async () => {
  const calls = [], result = await verifier(async (history, options) => {
    calls.push({ history, ...options });
    if (!history) return page([]);
    return options.page === 1 ? page([{ id: 'booking', isCancelled: true }], 1, 2, 2)
      : page([{ id: 'other', isCancelled: true }], 0, 2, 2);
  })('booking', { attempts: 1 });
  assert.equal(result.data.state, 'cancelled');
  assert.equal(calls.length, 3); assert.ok(calls.every(c => c.fresh === true));
});
for (const history of [
  page([{ id: 'booking', isCancelled: true }], 0, 21),
  page([{ id: 'booking', isCancelled: true }], 0, 1, 3),
  page([{ id: 'booking', isCancelled: true }, { id: 'booking', isCancelled: true }]),
  { data: null, status: 503, error: { status: 503, message: 'unavailable' } },
]) test('incomplete evidence never declares cancellation or asks for another DELETE', async () => {
  const result = await verifier(async h => h ? history : page([]))('booking', { attempts: 1 });
  assert.equal(result.data.state, 'unverified'); assert.equal(result.data.reason, 'INCOMPLETE_EVIDENCE');
  assert.match(result.error.message, /повторная отмена пока не требуется/);
});
test('contradictory snapshots and aliases never become success', async () => {
  const result = await verifier(async h => page([{ id: 'booking', isCancelled: h }]))('booking', { attempts: 1 });
  assert.equal(result.data.reason, 'CONFLICTING_EVIDENCE');
  assert.equal(resolve('booking', [], [{ id: 'booking', bookingId: 'different', isCancelled: true }]).state, 'unverified');
  assert.equal(resolve('', [], [{ isCancelled: true }]).state, 'unverified');
});
function execute(cancel, verify, release = async () => { throw Error('unexpected release'); }) {
  const dialog = fs.readFileSync('src/components/cabinet/BookingCancellationDialog.tsx', 'utf8');
  const body = dialog.slice(dialog.indexOf('async function defaultExecuteAction'), dialog.indexOf('export function BookingCancellationDialog'));
  return new Function('apiCancelBooking', 'apiVerifyBookingCancellation', 'apiReleaseSubscriptionBookingClaim',
    'bookingCancellationFailureMessage', stripTypeScriptTypes(body) + ';return defaultExecuteAction;')(cancel, verify, release, failure);
}
const action = { id: 'none', successMessage: 'cancelled' };
test('original provider refusal survives a later active projection', async () => {
  let deletes = 0;
  const out = await execute(async () => { deletes++; return { status: 422, error: { message: 'Original refusal' } }; },
    async () => ({ data: { state: 'active' }, error: { message: 'Generic active projection' } }))('booking', action);
  assert.equal(out.ok, false); assert.equal(out.message, 'Original refusal'); assert.equal(deletes, 1);
});
test('lost DELETE response is reconciled by GET without a second cancellation', async () => {
  let deletes = 0, reads = 0;
  const out = await execute(async () => { deletes++; return { status: null, error: { message: 'network' } }; },
    async () => { reads++; return { data: { state: 'cancelled' }, error: null }; })('booking', action);
  assert.equal(out.ok, true); assert.equal(deletes, 1); assert.equal(reads, 1);
});
test('accepted asynchronous cancellation shows pending, without refund success or duplicate requests', async () => {
  const out = await execute(async () => ({ status: 202, error: null }),
    async () => { throw Error('must wait for durable job'); })('booking', { id: 'subscription', successMessage: 'visit returned' });
  assert.equal(out.state, 'RETRY_REQUIRED'); assert.doesNotMatch(out.message, /visit returned/);
});
test('cancelled readback after unknown money outcome cannot claim a completed refund', async () => {
  const out = await execute(async () => ({ status: 503, error: { message: 'unknown' } }),
    async () => ({ data: { state: 'cancelled' }, error: null }))('booking', { id: 'card', successMessage: 'money refunded' });
  assert.equal(out.state, 'RETRY_REQUIRED'); assert.match(out.message, /Статус возврата ещё проверяется/);
  assert.doesNotMatch(out.message, /money refunded/);
});

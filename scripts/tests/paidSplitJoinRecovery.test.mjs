import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { composePaidJoinRouter } from '../patch_live_paid_join_recovery.mjs';

const raw = readFileSync(new URL('../nodered_games_nodes/fn_split_router.js', import.meta.url), 'utf8');
const source = process.env.PAID_JOIN_FIXTURE_FLOW
  ? JSON.parse(readFileSync(process.env.PAID_JOIN_FIXTURE_FLOW)).find(node => node.id === '8f7bd5b482fe9763').func
  : composePaidJoinRouter(raw, 5);
const runRouter = new Function('msg', 'env', 'global', 'node', source);
const user = 'actor-fixture';
const profilePhone = String(7).padEnd(11, '1');
const target = 'game-fixture';
const exercise = 'exercise-fixture';
const booking = 'booking-fixture';
const transaction = 'transaction-fixture';
const product = 'product-fixture';
const firstRef = 'first-payment-fixture';
const link = 'https://pay.vivacrm.ru/synthetic-checkout';
const fixtureNow = Date.now();
const future = () => new Date(fixtureNow + 600_000).toISOString();
const past = () => new Date(fixtureNow - 600_000).toISOString();
const admitted = (rest = {}) => ({
  action: 'join', step: 'token', paymentMode: 'one_time', paidJoinTenant: null,
  gameId: target, exerciseId: exercise, clientId: user, clientPhone: profilePhone,
  userAuthHeader: 'Bearer fixture', paymentRef: firstRef, roomId: 'room-fixture', studioId: 'studio-fixture',
  exactCourtPriceVerified: true, shareAmount: 1200, shareAmountMinor: 120000, totalAmount: 4800, shareCount: 4,
  ...rest,
});
const game = (rest = {}) => ({
  _id: 'local-document-fixture', id: target, status: 'PAID', tenantKey: null, updatedAt: past(),
  booking: { vivaExerciseId: exercise, timeFromIso: future() },
  settings: { isPrivate: false }, organizer: { id: 'owner-fixture' },
  participants: [{ id: 'owner-fixture' }, { id: 'existing-fixture' }], waitlist: [],
  metadata: { splitPayment: { enabled: true, vivaExerciseId: exercise, payments: [] } },
  ...rest,
});
const checkout = (rest = {}) => ({
  ok: true, exerciseId: exercise, bookingId: booking, transactionId: transaction,
  productId: product, paymentRef: firstRef, paymentUrl: link, toPayMinor: 120000,
  toPay: 1200, deadlineAt: future(), ...rest,
});
const providerBooking = (rest = {}) => ({
  id: booking, client: { id: user }, exerciseId: exercise, isCancelled: false, paymentType: 'ON_PLACE',
  visitConfirmed: false, ...rest,
});
const providerTransaction = (rest = {}) => ({
  id: transaction, client: { id: user }, products: [{ id: product, paymentBookingIds: [booking], discount: 880000 }],
  status: 'UNPAID', paymentDate: null, deposit: 0, toPay: 120000,
  cardPaymentInfo: { status: 'NEW', paymentUrl: link }, paymentDueDate: future(), ...rest,
});
const row = (rest = {}) => ({
  _id: JSON.stringify([null, target, exercise, user]), tenant: null,
  gameId: target, exerciseId: exercise, clientId: user, bookingId: booking,
  attempt: firstRef, state: 'CHECKOUT_READY', checkout: checkout(), ...rest,
});
const ack = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
const page = (...content) => ({ content, totalElements: content.length, last: true });

function harness(ctx = admitted(), enabled = true) {
  const store = new Map();
  const env = { get: (name) => name === 'LK_PAID_SPLIT_JOIN_RECOVERY_ENABLED' && enabled ? '1' : '' };
  const global = { get: key => store.get(key), set: (key, value) => store.set(key, value) };
  return (body, statusCode = 200, error) => runRouter({
    _splitCtx: ctx, payload: body, statusCode, ...(error ? { error } : {}),
  }, env, global, { warn() {}, error() {} });
}
function db(out, operation, targetCollection) {
  assert.equal(out[0], null, 'storage and provider cannot dispatch together');
  assert.equal(out[5]?.operation, operation);
  assert.equal(out[5]?._paidJoinCollection, targetCollection);
  return out[5].payload;
}
function upstream(out, method, end) {
  assert.equal(out[0]?.method, method);
  assert.ok(out[0].url.endsWith(end), out[0].url);
  assert.equal(out[5], undefined);
}
function stop(out, status = 409) {
  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, status);
  assert.equal(out[2], undefined, 'failure must not reach legacy debug');
  assert.equal(out[5], undefined);
}
function authenticate(call) {
  upstream(call({ access_token: 'service-fixture' }), 'GET', '/profile');
  db(call({ id: user, phone: profilePhone }), 'findOne', 'journal');
}
function admitNew(call) {
  authenticate(call);
  db(call(null), 'find', 'games');
  upstream(call([game()]), 'GET', '/bookings?showCancelled=false&page=0&size=100');
  upstream(call(page()), 'GET', '/rooms/room-fixture');
  return db(call({ id: 'room-fixture' }), 'insertOne', 'journal');
}

test('normal checkout can return 201 only after durable claim, booking, invoice and fresh game write', () => {
  const ctx = admitted();
  const call = harness(ctx);
  const [claim, opts] = admitNew(call);
  assert.equal(claim.state, 'BOOKING_REQUESTED');
  assert.deepEqual(opts.writeConcern, { w: 'majority', j: true });
  upstream(call({ acknowledged: true, insertedId: row()._id }), 'POST', '/exercises/exercise-fixture/bookings');
  upstream(call(providerBooking(), 201), 'GET', '/bookings/booking-fixture');
  const [bookingFilter, bookingWrite] = db(call(providerBooking()), 'updateOne', 'journal');
  assert.equal(bookingFilter.state, 'BOOKING_REQUESTED');
  assert.equal(bookingWrite.$set.bookingId, booking);
  upstream(call(ack), 'POST', '/products/available/by-booking');
  const [invoiceFilter, invoiceWrite, invoiceOptions] = db(call([
    { id: product, name: '1/4 игры', type: 'SERVICE', format: 'BOOKING_PAYMENT', cost: 1000000 },
  ]), 'updateOne', 'journal');
  assert.equal(invoiceFilter.state, 'BOOKING_CREATED');
  assert.equal(invoiceWrite.$set.state, 'TRANSACTION_REQUESTED');
  assert.equal(invoiceOptions.writeConcern.w, 'majority');
  upstream(call(ack), 'POST', '/transactions');
  const [checkoutFilter, result] = db(call(providerTransaction(), 201), 'updateOne', 'journal');
  assert.equal(checkoutFilter.state, 'TRANSACTION_REQUESTED');
  assert.equal(result.$set.checkout.transactionId, transaction);
  upstream(call(ack), 'GET', '/transactions/transaction-fixture');
  upstream(call(providerTransaction()), 'GET', '/bookings/booking-fixture');
  db(call(providerBooking()), 'find', 'games');
  const [filter, gameWrite] = db(call([game()]), 'updateOne', 'games');
  assert.equal(filter.participants.length, 2);
  assert.equal(gameWrite.$set.participants, undefined);
  assert.equal(gameWrite.$set['metadata.splitPayment.payments'][0].bookingId, booking);
  assert.deepEqual(gameWrite.$set.waitlist.map(player => player.status), ['PENDING']);
  const out = call(ack);
  assert.equal(out[1].statusCode, 201);
  assert.equal(out[1].payload.checkoutStored, true);
  assert.equal(out[1].payload.paymentRef, firstRef);
  assert.equal(out[2], undefined);
});

test('concurrent or unacknowledged first claims do not call Viva writes', () => {
  const call = harness();
  admitNew(call);
  stop(call(null, 200, { code: 11000 }));
  const unacknowledged = harness();
  admitNew(unacknowledged);
  stop(unacknowledged({ acknowledged: false }));
});

test('rejects foreign actor before reading the private journal', () => {
  const call = harness();
  upstream(call({ access_token: 'service-fixture' }), 'GET', '/profile');
  stop(call({ id: 'other-fixture', phone: profilePhone }), 403);
});

test('capacity, archived game, or conflicting roster cannot write a booking on a fresh attempt', () => {
  for (const bad of [game({ archived: true }), game({ participants: [{ id: user }] }), game({ status: 'CANCELLED' }),
    game({ settings: { isPrivate: true } })]) {
    const call = harness();
    authenticate(call);
    db(call(null), 'find', 'games');
    stop(call([bad]));
  }
  const call = harness();
  authenticate(call);
  db(call(null), 'find', 'games');
  upstream(call([game()]), 'GET', '/bookings?showCancelled=false&page=0&size=100');
  stop(call(page(providerBooking())));
});

test('lost response or projection conflict replays exact checkout without repeating Viva writes', () => {
  const call = harness(admitted({ paymentRef: 'different-retry-fixture' }));
  authenticate(call);
  upstream(call(row()), 'GET', '/transactions/transaction-fixture');
  upstream(call(providerTransaction()), 'GET', '/bookings/booking-fixture');
  db(call(providerBooking()), 'find', 'games');
  db(call([game()]), 'updateOne', 'games');
  db(call({ acknowledged: true, matchedCount: 0 }), 'find', 'games');
  const concurrent = game({ participants: [{ id: 'owner-fixture' }, { id: 'sibling-fixture' }] });
  const [filter] = db(call([concurrent]), 'updateOne', 'games');
  assert.equal(filter.participants[1].id, 'sibling-fixture');
  const out = call(ack);
  assert.equal(out[1].payload.paymentRef, firstRef);
  assert.equal(out[1].payload.paymentUrl, link);
});

test('reconciles a lost transaction reply using the exact booking and complete transaction list', () => {
  const call = harness(admitted({ paymentRef: 'retry-fixture' }));
  authenticate(call);
  upstream(call(row({ state: 'TRANSACTION_REQUESTED', checkout: null, expectedAmountMinor: 120000, expectedProductId: product, expectedDiscountMinor: 880000 })),
    'GET', '/transactions?size=100&page=0');
  const [filter, write] = db(call(page(providerTransaction())), 'updateOne', 'journal');
  assert.equal(filter.attempt, firstRef);
  assert.equal(write.$set.checkout.transactionId, transaction);
  upstream(call(ack), 'GET', '/transactions/transaction-fixture');
});

test('ambiguous booking or transaction histories hold rather than submit again', () => {
  const bookingUnknown = harness();
  authenticate(bookingUnknown);
  stop(bookingUnknown(row({ state: 'BOOKING_REQUESTED', bookingId: null, checkout: null })));

  for (const history of [
    { ...page(providerTransaction()), last: false },
    page(providerTransaction(), providerTransaction({ id: 'other-invoice' })),
    page(providerTransaction({ products: [{ id: product, paymentBookingIds: ['different-booking'] }] })),
  ]) {
    const call = harness();
    authenticate(call);
    upstream(call(row({ state: 'TRANSACTION_REQUESTED', checkout: null, expectedAmountMinor: 120000, expectedProductId: product, expectedDiscountMinor: 880000 })),
      'GET', '/transactions?size=100&page=0');
    stop(call(history));
  }
});

test('expiry requires a closed payment and exact cancelled booking before one new generation', () => {
  const expired = checkout({ deadlineAt: past() });
  const closed = providerTransaction({
    paymentDueDate: expired.deadlineAt,
    cardPaymentInfo: { status: 'REJECTED', declineOutcome: 'EXPIRED', paymentUrl: link },
  });
  for (const contradictory of [
    { state: 'PAID' }, { paidAmountMinor: 1 }, { possibleDoublePayment: true },
    { cardPaymentStatus: { status: 'AUTHORIZED' } },
    { products: [{ id: product, paymentBookingIds: [booking, 'foreign-booking'] }] },
  ]) {
    const call = harness();
    authenticate(call);
    upstream(call(row({ checkout: expired })), 'GET', '/transactions/transaction-fixture');
    stop(call({ ...closed, ...contradictory }));
  }
  for (const badBooking of [providerBooking({ visitConfirmed: true }),
    providerBooking({ isCancelled: true, clientSubscriptionId: 'subscription-fixture' }),
    providerBooking({ isCancelled: true, amountDue: { paidKopecks: 120000 } })]) {
    const call = harness();
    authenticate(call);
    upstream(call(row({ checkout: expired })), 'GET', '/transactions/transaction-fixture');
    upstream(call(closed), 'GET', '/bookings/booking-fixture');
    stop(call(badBooking));
  }
  const call = harness(admitted({ paymentRef: 'new-attempt-fixture' }));
  authenticate(call);
  upstream(call(row({ checkout: expired })), 'GET', '/transactions/transaction-fixture');
  upstream(call(closed), 'GET', '/bookings/booking-fixture');
  db(call(providerBooking({ isCancelled: true })), 'find', 'games');
  upstream(call([game()]), 'GET', '/bookings?showCancelled=false&page=0&size=100');
  upstream(call(page()), 'GET', '/rooms/room-fixture');
  const [filter, update] = db(call({ id: 'room-fixture' }), 'updateOne', 'journal');
  assert.equal(filter.state, 'CHECKOUT_READY');
  assert.equal(filter.attempt, firstRef);
  assert.equal(update.$set.attempt, 'new-attempt-fixture');
  stop(call({ acknowledged: true, matchedCount: 0 }));
});

test('flag off keeps the original route and subscription/create do not enter paid JOIN', () => {
  const disabled = harness(admitted(), false);
  upstream(disabled({ access_token: 'service-fixture' }), 'GET', '/rooms/room-fixture');
  const create = harness(admitted({ action: 'create' }));
  upstream(create({ access_token: 'service-fixture' }), 'GET', '/rooms/room-fixture');
});

test('late recovery makes an expired invoice visible to cleanup without returning its URL', () => {
  const expired = checkout({ deadlineAt: past() });
  const call = harness();
  authenticate(call);
  upstream(call(row({ checkout: expired })), 'GET', '/transactions/transaction-fixture');
  upstream(call(providerTransaction({ paymentDueDate: expired.deadlineAt, cardPaymentInfo: { status: 'REJECTED', declineOutcome: 'EXPIRED' } })),
    'GET', '/bookings/booking-fixture');
  db(call(providerBooking()), 'find', 'games');
  const [, pending] = db(call([game()]), 'updateOne', 'games');
  const [saved] = pending.$set['metadata.splitPayment.payments'];
  assert.equal(saved.bookingId, booking);
  assert.equal(saved.transactionId, transaction);
  assert.equal(saved.paymentUrl, null);
  assert.equal(saved.deadlineAt, expired.deadlineAt);
  stop(call(ack));
});

test('changing game visibility cannot bypass an existing stored attempt', () => {
  const call = harness(admitted({ paidJoinScope: false }));
  authenticate(call);
  upstream(call(row()), 'GET', '/transactions/transaction-fixture');
  upstream(call(providerTransaction()), 'GET', '/bookings/booking-fixture');
  db(call(providerBooking()), 'find', 'games');
  stop(call([game({ settings: { isPrivate: true } })]));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { addTournamentPaymentStatus } from '../prepare_friendship2_tournament_payment_status_release.mjs';

const nodes = new URL('../nodered_subscription_booking_nodes/', import.meta.url);
const candidatePath = process.env.FRIENDSHIP2_TOURNAMENT_FLOW_FIXTURE;
const candidate = candidatePath ? JSON.parse(fs.readFileSync(candidatePath, 'utf8')) : null;
const compile = (name) => (msg, globals) => new Function('msg', 'global', 'node', candidate
  ? candidate.find(node => node.id === `lk_subscription_booking_${name}_20260804`).func
  : addTournamentPaymentStatus(fs.readFileSync(new URL(`fn_subscription_booking_${name}.js`, nodes), 'utf8'), name))(msg, globals, {});
const prepare = compile('prepare');
const route = compile('router');
const globalContext = { get: (key) => key === 'vivacrm_access_token' ? 'fixture-service-credential' : undefined };
const exerciseId = '02ed9526-6687-485e-9992-5e7e7f93870f';
const bookingId = '99999999-2222-4444-8888-999999999999';
const actorClientId = 'fixture-actor';
const stationId = '42c6d4df-833d-480a-bdc8-986716569884';
const productId = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
const paymentUrl = 'https://pay.vivacrm.ru/fixture-only';
const operationId = 'lk-subscription-fixture';
const merchantTransactionId = 'fixture-transaction';
const amount = 200_000;
const now = Date.now();
const iso = (delta) => new Date(now + delta * 60_000).toISOString();

const row = {
  _id: `lk1-product:${JSON.stringify(['iSkq6G', actorClientId, operationId])}`,
  tenantKey: 'iSkq6G', actorClientId, exerciseId, bookingId, operationId,
  category: 'tournament', state: 'CONFIRMED',
  lk1: {
    rule: { productId },
    target: { eventId: exerciseId, stationId, category: 'TOURNAMENT', durationMinutes: 120, startsAt: iso(120) },
    decision: { subscriptionVisitCount: 0, benefit: { kind: 'PERCENT_DISCOUNT', finalPriceMinor: amount } },
    transactionId: merchantTransactionId,
    transactionIntent: { actorClientId, bookingId, studioId: stationId, chargeMinor: amount },
    checkout: { transactionId: merchantTransactionId, paymentUrl, toPayMinor: amount },
  },
};
const booking = { id: bookingId, exercise: { id: exerciseId }, client: { id: actorClientId },
  paymentType: 'ON_PLACE', cancelled: false, isCancelled: false, visitConfirmed: false };
const transaction = { id: merchantTransactionId, status: 'UNPAID', toPay: amount, client: { id: actorClientId },
  createDate: iso(-1), paymentDueDate: iso(19), cardPaymentInfo: { status: 'NEW', paymentUrl } };

function oneOutput(outputs, index) {
  assert.equal(outputs.filter(Boolean).length, 1);
  assert.ok(outputs[index], `expected output ${index}`);
  return outputs[index];
}

function run({ rows = [row], seat = booking, charge = transaction, expect = 'PAYMENT_PENDING',
  wantUrl = null, auth = true } = {}) {
  const incoming = { req: { method: 'POST', headers: auth ? { authorization: 'Bearer fixture-user' } : {} },
    payload: { action: 'tournament-payment-status', exerciseId, bookingId } };
  const ingress = prepare(incoming);
  if (!auth) return assert.equal(oneOutput(ingress, 1).statusCode, 401);
  const profile = oneOutput(ingress, 0);
  assert.equal(profile.method, 'GET');
  assert.match(profile.url, /\/profile$/);
  assert.equal(profile._subscriptionBooking.step, 'tournament_payment_profile');
  const lookup = oneOutput(route({ ...profile, statusCode: 200, payload: { id: actorClientId, phone: '70000000000' } }, globalContext), 1);
  assert.equal(lookup.payload.actorClientId, actorClientId);
  assert.equal(lookup.payload.exerciseId, exerciseId);
  assert.equal(lookup.payload.bookingId, bookingId);
  assert.equal(lookup.payload['lk1.rule.productId'], productId);
  let result = route({ ...lookup, payload: rows }, globalContext);
  if (result[0]) {
    const readBooking = oneOutput(result, 0);
    assert.equal(readBooking.method, 'GET');
    assert.ok(readBooking.url.endsWith(`/clients/${actorClientId}/bookings/${bookingId}`));
    result = route({ ...readBooking, statusCode: 200, payload: seat }, globalContext);
  }
  if (result[0]) {
    const readTransaction = oneOutput(result, 0);
    assert.equal(readTransaction.method, 'GET');
    assert.ok(readTransaction.url.endsWith(`/transactions/${seat.transactionId ?? merchantTransactionId}`));
    result = route({ ...readTransaction, statusCode: 200, payload: charge }, globalContext);
  }
  const response = oneOutput(result, 4);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.payload.status, expect);
  assert.equal(response.payload.bookingId, bookingId);
  assert.equal(response.payload.exerciseId, exerciseId);
  assert.equal(response.payload.paymentUrl ?? null, wantUrl);
  if (wantUrl) assert.equal(response.payload.paymentExpiresAt, iso(19));
}

test('Нагатинская Премиум, 120 minutes, ₽2,000: open existing bill without writing again', () => {
  run({ wantUrl: paymentUrl });
});

test('expired and rejected bills remain pending without a payment link', () => {
  run({ charge: { ...transaction, createDate: iso(-60), paymentDueDate: iso(-40) } });
  run({ charge: { ...transaction, cardPaymentInfo: { ...transaction.cardPaymentInfo, status: 'REJECTED' } } });
  run({ charge: { ...transaction, cardPaymentStatus: { status: 'REJECTED' } } });
  run({ charge: { ...transaction, paidAt: iso(-1) } });
  run({ rows: [{ ...row, lk1: { ...row.lk1, unpaidCancellation: { phase: 'INTENT' } } }] });
});

test('paid, replacement payment and cancellation beat old unpaid state', () => {
  run({ charge: { ...transaction, status: 'PAID', cardPaymentInfo: { status: 'CONFIRMED' } }, expect: 'REGISTERED' });
  run({ seat: { ...booking, paymentType: 'ONE_TIME', transactionId: 'replacement' },
    charge: { ...transaction, id: 'replacement', status: 'PAID', cardPaymentInfo: { status: 'CONFIRMED' } }, expect: 'REGISTERED' });
  run({ seat: { ...booking, cancelled: true, isCancelled: true }, expect: 'NONE' });
});

test('no disclosure or checkout on missing identity, conflicting bindings, duplicates or wrong price', () => {
  run({ auth: false });
  run({ rows: [], expect: 'NOT_APPLICABLE' });
  run({ rows: [row, row], expect: 'UNAVAILABLE' });
  run({ rows: [{ ...row, actorClientId: 'other-actor' }], expect: 'UNAVAILABLE' });
  run({ seat: { ...booking, exerciseId: 'different-exercise' }, expect: 'UNAVAILABLE' });
  run({ charge: { ...transaction, transactionId: 'different-transaction' }, expect: 'UNAVAILABLE' });
  run({ charge: { ...transaction, toPay: 400_000 }, expect: 'UNAVAILABLE' });
  run({ charge: { ...transaction, products: [{ pricingDetails: [{ clientBookingId: 'other-booking' }] }] },
    expect: 'UNAVAILABLE' });
  run({ charge: { ...transaction, cardPaymentInfo: { status: 'NEW', paymentUrl: 'https://pay.vivacrm.ru.example.test/fixture-only' } } });
});

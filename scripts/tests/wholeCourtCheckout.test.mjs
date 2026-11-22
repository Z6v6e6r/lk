import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import * as url from 'node:url';
import {
  composeWholeCourtCheckout,
  wholeCourtCheckoutSource,
} from '../patch_nodered_whole_court_checkout.mjs';
import { gameCreateServiceTable } from '../lib/gameCreatePreparationSource.mjs';

const verify = new Function(
  'msg',
  'env',
  'global',
  'nodeCrypto',
  'nodeUrl',
  wholeCourtCheckoutSource('verify'),
);
const router = new Function(
  'msg',
  'env',
  'global',
  'nodeCrypto',
  'nodeUrl',
  wholeCourtCheckoutSource('router'),
);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const actorToken = 'synthetic-user-bearer';
const now = Date.now();
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const draftId = '33333333-3333-4333-8333-333333333333';
const providerClientId = 'synthetic-client';
const prefix = '/lk/integrations/v1/whole-court-checkout';
const stamp = (ms) => new Date(now + ms).toISOString();
const hash = (value) => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const target = {
  actorId,
  providerClientId,
  tenantId,
  stationId: Object.keys(gameCreateServiceTable)[0],
  roomId: 'synthetic-room',
  startsAt: '2035-04-02T10:00:00.000Z',
  endsAt: '2035-04-02T11:00:00.000Z',
  amountMinor: 320000,
};
const checkoutUrl = 'https://pay.vivacrm.ru/synthetic-checkout';
const payment = {
  transactionId: 'synthetic-transaction',
  bookingIds: ['synthetic-booking'],
  exerciseId: 'synthetic-exercise',
  paymentUrl: checkoutUrl,
};
const idFor = (digest) => {
  const bytes = Buffer.from(
    hash(
      'booked-operation-admission:v1\0lk2-api\0' + tenantId + '\0' + actorId + '\0' + digest,
    ).slice(7, 39),
    'hex',
  );
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};

function request(
  mode,
  { key = 'synthetic-key', changeBody = {}, changeClaims = {}, changeHeaders = {} } = {},
) {
  const path = prefix + '/' + mode;
  const digest = hash(key);
  const body = {
    contractVersion: 1,
    action: 'CREATE_GAME',
    operationId: idFor(digest),
    draftId,
    stationId: target.stationId,
    roomId: target.roomId,
    startsAt: target.startsAt,
    endsAt: target.endsAt,
    amountMinor: target.amountMinor,
    currency: 'RUB',
    ...changeBody,
  };
  const sec = Math.floor(now / 1000);
  const claims = {
    iss: 'lk2-test',
    aud: 'lk1-owner-test',
    sub: actorId,
    iat: sec,
    nbf: sec,
    exp: sec + 60,
    jti: '44444444-4444-4444-8444-444444444444',
    sid: '55555555-5555-4555-8555-555555555555',
    contract_version: 1,
    caller: 'lk2-api',
    scope: 'game-create.whole-court.' + mode,
    method: 'POST',
    path,
    tenant_id: tenantId,
    tenant_key: 'iSkq6G',
    provider: 'VIVA',
    provider_client_id: providerClientId,
    operation_id: body.operationId,
    request_sha256: hash('whole-court:' + mode + ':v1\0' + JSON.stringify(body)),
    correlation_id: 'synthetic-correlation',
    idempotency_key_sha256: digest,
    actor_token_sha256: hash(actorToken),
    actor_token_expires_at: stamp(120000),
    ...changeClaims,
  };
  const pack = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input =
    pack({ alg: 'RS256', typ: 'phub-subscription-runtime-actor-delegation+jwt', kid: 'test-key' }) +
    '.' +
    pack(claims);
  const jwt =
    input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  const headers = {
    'content-type': 'application/json',
    'x-subscription-actor-delegation': jwt,
    'x-subscription-actor-token': actorToken,
    'x-correlation-id': 'synthetic-correlation',
    ...changeHeaders,
  };
  return { req: { originalUrl: path, method: 'POST', headers, body }, payload: body };
}

class Harness {
  calls = [];
  rows = new Map();
  status = 'WAITING';
  payStatusCode = 200;
  dropAck;
  impossibleClaimAck = false;
  changePayment = {};
  changeTransaction = {};
  price = target.amountMinor;
  profileId = providerClientId;

  constructor(extra = {}) {
    this.env = {
      get: (name) =>
        ({
          LK1_WHOLE_COURT_CHECKOUT_ENABLED: 'true',
          LK1_WHOLE_COURT_CHECKOUT_TARGET: JSON.stringify(target),
          LK1_BOOKED_OPERATION_RECEIVER_ENABLED: 'true',
          BOOKED_OPERATION_EXECUTION_ENABLED: 'true',
          LK2_BOOKED_OPERATION_DELEGATION_ISSUER: 'lk2-test',
          LK2_BOOKED_OPERATION_DELEGATION_AUDIENCE: 'lk1-owner-test',
          LK2_BOOKED_OPERATION_DELEGATION_KEY_ID: 'test-key',
          LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM: publicKey.export({
            type: 'spki',
            format: 'pem',
          }),
          ...extra,
        })[name],
    };
    this.global = {
      get: (name) =>
        ({
          vivacrm_access_token: 'synthetic-admin-bearer',
          vivacrm_token_expires_at: now + 300000,
        })[name],
    };
  }

  start(mode, options) {
    const [accepted, denied] = verify(request(mode, options), this.env, this.global, crypto, url);
    return denied ? [null, null, null, denied] : this.route(accepted);
  }

  route(msg) {
    return router(msg, this.env, this.global, crypto, url);
  }

  advance(output) {
    const [find, write, http] = output;
    if (find) {
      const row = this.rows.get(find.payload._id);
      return this.route({ ...find, payload: row ? [structuredClone(row)] : [] });
    }
    if (write) {
      const [filter, update, options] = write.payload;
      assert.equal(options.writeConcern.w, 'majority');
      let row = this.rows.get(filter._id);
      let result = { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      if (!row && options.upsert) {
        row = { _id: filter._id, ...structuredClone(update.$setOnInsert) };
        this.rows.set(row._id, row);
        result = { ...result, upsertedCount: 1, upsertedId: row._id };
      } else if (row && Object.entries(filter).every(([key, value]) => row[key] === value)) {
        Object.assign(row, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete row[key];
        result.matchedCount = 1;
      }
      return this.route({
        ...write,
        payload:
          this.impossibleClaimAck && write._wholeCourt.phase === 'claimed'
            ? { ...result, matchedCount: 1 }
            : result,
        ...(this.dropAck === write._wholeCourt.phase
          ? { error: { message: 'synthetic ack lost' } }
          : {}),
      });
    }
    assert.ok(http);
    assert.equal(http.followRedirects, false);
    assert.equal(http.maxRedirects, 0);
    assert.equal(http.headers['X-Correlation-ID'], 'synthetic-correlation');
    this.calls.push({ method: http.method, url: http.url, payload: http.payload });
    let payload;
    if (http.url.endsWith('/profile')) payload = { id: this.profileId };
    else if (http.url.includes('/price?')) payload = { total: this.price, currency: 'RUB' };
    else if (http.url.endsWith('/pay')) payload = { ...payment, ...this.changePayment };
    else if (http.url.endsWith('/transactions/' + payment.transactionId + '/status'))
      payload = { transactionStatus: this.status };
    else if (http.url.endsWith('/transactions/' + payment.transactionId)) {
      payload = {
        id: payment.transactionId,
        status: this.status,
        currency: 'RUB',
        toPay: target.amountMinor,
        client: { id: providerClientId },
        exercise: { id: payment.exerciseId },
        products: [{ bookingIds: payment.bookingIds }],
        paymentDueDate: stamp(180000),
        ...this.changeTransaction,
      };
    } else assert.fail('unexpected HTTP target: ' + http.url);
    return this.route({
      ...http,
      statusCode: http.method === 'POST' ? this.payStatusCode : 200,
      responseUrl: http.url,
      payload,
    });
  }

  finish(output) {
    for (let i = 0; i < 20; i++) {
      if (output[3]) return output[3];
      output = this.advance(output);
    }
    assert.fail('unbounded checkout flow');
  }

  run(mode, options) {
    return this.finish(this.start(mode, options));
  }
  posts() {
    return this.calls.filter((call) => call.method === 'POST');
  }
}

test('concurrent reserve, same checkout, exact paid receipt, no second Viva POST', () => {
  const h = new Harness();
  // Let both requests read that the row is absent and fetch the price before either wins the claim.
  const beforeClaim = (output) => {
    while (output[1]?._wholeCourt.phase !== 'claimed') output = h.advance(output);
    return output;
  };
  const first = beforeClaim(h.start('reserve'));
  const second = beforeClaim(h.start('reserve'));
  const result = h.finish(first);
  assert.equal(result.payload.status, 'AWAITING_PAYMENT');
  assert.equal(result.payload.paymentUrl, checkoutUrl);
  assert.deepEqual(h.finish(second).payload, result.payload);
  assert.equal(h.posts().length, 1);
  assert.equal(result.headers['X-Correlation-ID'], 'synthetic-correlation');
  const pay = h.posts()[0].payload;
  assert.match(pay.baseRedirectUrl, /\/games\/new\?paymentReturn=/);
  assert.equal(pay.successUrl, pay.baseRedirectUrl);
  assert.equal(pay.failUrl, pay.baseRedirectUrl);
  assert.equal(pay.timeFrom, '2035-04-02T13:00:00+03:00');
  assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
  h.status = 'PAID';
  const confirmed = h.run('confirm');
  assert.equal(confirmed.payload.status, 'CONFIRMED');
  assert.deepEqual(confirmed.payload.receipt, {
    provider: 'VIVA',
    amountMinor: target.amountMinor,
    currency: 'RUB',
    transactionId: payment.transactionId,
    exerciseId: payment.exerciseId,
    bookingId: payment.bookingIds[0],
    confirmedAt: confirmed.payload.receipt.confirmedAt,
  });
  assert.deepEqual(h.run('reserve').payload, confirmed.payload);
  assert.deepEqual(h.run('confirm').payload, confirmed.payload);
  assert.equal(h.rows.size, 3);
  assert.equal(h.run('reserve', { key: 'another-key' }).statusCode, 409);
  assert.equal(h.posts().length, 1);
  assert.equal(JSON.stringify([...h.rows.values()]).includes(checkoutUrl), false);
  assert.equal(JSON.stringify(confirmed).includes(actorToken), false);
  assert.equal(JSON.stringify(confirmed).includes('synthetic-admin-bearer'), false);
});

test('read never creates, price drift forbids a write, and lost claim ACK never dispatches', () => {
  const h = new Harness();
  assert.equal(h.run('confirm').statusCode, 404);
  h.price++;
  assert.equal(h.run('reserve').payload.code, 'WHOLE_COURT_PRICE_CHANGED');
  assert.deepEqual(
    [...h.rows.values()].map((row) => row.kind),
    ['WHOLE_COURT_CHECKOUT_V1_ADMISSION'],
  );
  h.price--;
  h.dropAck = 'claimed';
  assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
  h.dropAck = undefined;
  assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
  assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
  assert.equal(h.posts().length, 0);
  const impossible = new Harness();
  impossible.impossibleClaimAck = true;
  assert.equal(impossible.run('reserve').payload.status, 'UNKNOWN');
  assert.equal(impossible.posts().length, 0);
});

test('ambiguity, bad links and multiple booking IDs never lead to a replacement payment', () => {
  for (const invalid of [
    { transactionId: undefined },
    { exerciseId: undefined },
    { paymentUrl: 'https://pay.vivacrm.ru@foreign.invalid/payment' },
    { paymentUrl: 'https://pay.vivacrm.ru.foreign.invalid/payment' },
    { bookingIds: ['synthetic-booking', 'extra-booking'] },
  ]) {
    const h = new Harness();
    h.changePayment = invalid;
    assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
    h.changePayment = {};
    assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
    assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
    assert.equal(h.posts().length, 1);
  }
});

test('provider amount, owner, booking, exercise and transaction must match the stored response', () => {
  const h = new Harness();
  h.run('reserve');
  h.status = 'PAID';
  for (const mismatch of [
    { toPay: target.amountMinor + 1 },
    { currency: 'USD' },
    { client: { id: 'another-client' } },
    { exercise: { id: 'another-exercise' } },
    { products: [{ bookingIds: ['another-booking'] }] },
    { id: 'another-transaction' },
    { refundedAmountMinor: 100 },
    { cardPaymentInfo: { status: 'PARTIAL_REFUND' } },
    { refundSum: 1 },
    { refundedAt: stamp(-5000) },
    { transactionRefunds: [{}] },
    { cardPaymentStatus: { status: 'REFUNDED' } },
    { paymentStatus: 'REFUND' },
  ]) {
    h.changeTransaction = mismatch;
    assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
    assert.equal(h.rows.size, 2);
  }
  h.changeTransaction = {};
  assert.equal(h.run('confirm').payload.status, 'CONFIRMED');
  assert.equal(h.posts().length, 1);
});

test('known admin response can omit aliases, but the provider must confirm the original transaction', () => {
  const h = new Harness();
  h.status = 'UNPAID';
  h.changeTransaction = {
    client: undefined,
    exercise: undefined,
    products: undefined,
    currency: undefined,
    status: undefined,
    cardPaymentInfo: { status: 'NEW' },
    paymentDueDate: '2035-04-02T12:00:55.123456789+03:00',
  };
  const checkout = h.run('reserve');
  assert.equal(checkout.payload.expiresAt, '2035-04-02T09:00:55.123Z');
  assert.equal(checkout.payload.paymentUrl, checkoutUrl);
  h.changeTransaction.toPay = 0;
  assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
  h.status = 'REFUND';
  assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
  h.status = 'PAID';
  assert.equal(h.run('confirm').payload.status, 'CONFIRMED');
  const confirmed = [...h.rows.values()].find((row) => row.phase === 'CONFIRMED');
  assert.equal(confirmed.confirmation.providerStatus, 'PAID');
  assert.match(confirmed.evidenceSha256, /^sha256:[a-f0-9]{64}$/);
  confirmed.confirmation.providerStatus = 'REFUND';
  assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
  assert.equal(h.posts().length, 1);
});

test('async carrier IDs are saved for investigation and never treated as a transaction', () => {
  const h = new Harness();
  h.payStatusCode = 202;
  h.changePayment = {
    id: 'opaque-operation-id',
    transactionId: undefined,
    exerciseId: undefined,
    paymentUrl: undefined,
    bookingIds: undefined,
  };
  assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
  const row = [...h.rows.values()].find((record) => record.phase === 'UNRESOLVED');
  assert.equal(row.providerCorrelationId, 'opaque-operation-id');
  assert.equal(row.transactionId, undefined);
  assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
  assert.equal(h.run('confirm').payload.status, 'UNKNOWN');
  assert.equal(h.posts().length, 1);
  assert.ok(!h.calls.some((call) => call.url.includes('/transactions/')));
});

test('original Viva acknowledgement is retained if delegation expires after dispatch', () => {
  const h = new Harness();
  let output = h.start('reserve');
  while (output[2]?.method !== 'POST') output = h.advance(output);
  const dispatch = output[2];
  dispatch._wholeCourt.claims.exp = 1;
  const response = h.finish(h.advance(output));
  assert.equal(response.statusCode, 503);
  assert.equal(
    [...h.rows.values()].find((row) => row.phase === 'HELD').transactionId,
    payment.transactionId,
  );
  assert.equal(h.run('reserve').payload.status, 'AWAITING_PAYMENT');
  assert.equal(h.posts().length, 1);
});

test('expired checkout offers no link and lost receipt acknowledgement is read back', () => {
  const h = new Harness();
  for (const paymentDueDate of [stamp(-1000), '2035-02-30T12:00:00+03:00']) {
    h.changeTransaction = { paymentDueDate };
    assert.equal(h.run('reserve').payload.status, 'UNKNOWN');
  }
  h.status = 'PAID';
  h.dropAck = 'receiptClaimed';
  const result = h.run('confirm');
  assert.equal(result.payload.status, 'CONFIRMED');
  assert.deepEqual(h.run('confirm').payload, result.payload);
  assert.equal(h.posts().length, 1);
});

test('disabled, forged, foreign and out-of-policy requests fail before storage or Viva', () => {
  const disabled = new Harness({ LK1_WHOLE_COURT_CHECKOUT_ENABLED: 'false' });
  assert.equal(disabled.run('reserve').statusCode, 503);
  assert.equal(disabled.calls.length, 0);
  for (const params of [
    { changeClaims: { scope: 'wrong' } },
    { changeClaims: { tenant_key: 'foreign' } },
    { changeBody: { amountMinor: target.amountMinor + 1 } },
    { changeBody: { transactionId: payment.transactionId } },
    { changeHeaders: { 'x-subscription-actor-token': 'synthetic-foreign-bearer' } },
  ]) {
    const h = new Harness();
    assert.ok(h.run('reserve', params).statusCode >= 400);
    assert.equal(h.calls.length, 0);
    assert.equal(h.rows.size, 0);
  }
  const foreign = new Harness();
  foreign.profileId = 'synthetic-foreign-client';
  assert.equal(foreign.run('reserve').payload.code, 'WHOLE_COURT_ACTOR_MISMATCH');
  assert.equal(foreign.posts().length, 0);
});

test('composer uses the approved Mongo anchor and adds only private graph nodes', () => {
  const source = [
    { id: 'lk1tab', type: 'tab' },
    { id: 'lk1mongo', type: 'mongodb4-client' },
    {
      id: 'lk_subscription_booking_find_20260804',
      z: 'lk1tab',
      type: 'mongodb4',
      collection: 'lk_subscription_daily_booking_ops',
      operation: 'find',
      clientNode: 'lk1mongo',
    },
  ];
  const bytes = Buffer.from(JSON.stringify(source));
  const { candidate } = composeWholeCourtCheckout(bytes, 'whole-court-fixture');
  assert.deepEqual(candidate.slice(0, source.length), source);
  assert.deepEqual(
    candidate.filter((n) => n.type === 'http in').map((n) => n.url),
    [prefix + '/reserve', prefix + '/confirm'],
  );
  assert.equal(candidate.filter((n) => n.collection === 'lk_whole_court_checkout_ops').length, 2);
  assert.throws(() =>
    composeWholeCourtCheckout(Buffer.from(JSON.stringify(candidate)), 'whole-court-fixture'),
  );
  assert.throws(() => composeWholeCourtCheckout(Buffer.from('[]'), 'whole-court-fixture'));
});

const mongoUri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if (mongoUri && (process.env.GITHUB_ACTIONS !== 'true' || mongoUri !== 'mongodb://127.0.0.1:27017'))
  throw new Error('Whole-court checkout tests require the isolated CI loopback Mongo service');

test('real Mongo allows only one concurrent provider dispatch', { skip: !mongoUri }, async (t) => {
  const { MongoClient } = await import('mongodb');
  const mongo = new MongoClient(mongoUri, {
    directConnection: true,
    serverSelectionTimeoutMS: 5000,
  });
  const dbName = 'whole_court_checkout_' + crypto.randomUUID().replaceAll('-', '');
  const db = mongo.db(dbName);
  const rows = db.collection('lk_whole_court_checkout_ops');
  t.after(async () => {
    try {
      await db.dropDatabase();
    } finally {
      await mongo.close();
    }
  });
  const h = new Harness();
  const commands = ['original', 'new-key'].map((key) => {
    let output = h.start('reserve', { key });
    while (output[1]?._wholeCourt.phase !== 'claimed') output = h.advance(output);
    return output[1];
  });
  const results = await Promise.allSettled(
    commands.map((message) => rows.updateOne(...message.payload)),
  );
  for (const result of results)
    if (result.status === 'rejected') assert.equal(result.reason.code, 11000);
  const outputs = results.map((result, index) =>
    h.route({
      ...commands[index],
      payload: result.value,
      ...(result.status === 'rejected' ? { error: { code: 11000 } } : {}),
    }),
  );
  assert.equal(outputs.filter((entry) => entry[2]?.method === 'POST').length, 1);
  assert.equal(await rows.countDocuments({}), 1);
});

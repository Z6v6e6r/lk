import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  create: ['fn_split_create_prepare.js', '19a61024273a478f11bff3ff60c4601603c2af5bd7ec8ec08e4b83394ee7bd41', '89e5ef745a785c43f4d1a746060b162b3654af81a075525d3f7c42bc70570a03'],
  join: ['fn_split_join_prepare.js', '70ec2bdfad08c71a1a1ef2d851c07918906573a3802ce9f41765837494c6f462', 'c05c7af19d3014ca48546871ea742ee347760bdd537cab5e6a67b428ee3d1b3e'],
  router: ['fn_split_router.js', 'cf913ca9201506bd1e84da974b6a3b604f76ac885de4202753c891f9460ecd3a', 'f9636b7a765faef32a68434bb452bd944d96ccf95bc6646110916bcc359ef2e5'],
};

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-07-27T12:20:00.000Z'])); }
  static now() { return Date.parse('2026-07-27T12:20:00.000Z'); }
}

function source(key) { return fs.readFileSync(path.join(ROOT, 'scripts/nodered_games_nodes', SOURCES[key][0]), 'utf8'); }
function run(key, msg) {
  const values = {};
  const globalContext = {
    get(name) { return values[name]; },
    set(name, value) { values[name] = value; },
  };
  const env = {
    get(name) {
      if (name === 'VIVA_SERVICE_USERNAME') return 'service@example.test';
      if (name === 'VIVA_SERVICE_PASSWORD') return 'test-password';
      return undefined;
    },
  };
  return new Function('msg', 'Date', 'global', 'env', source(key))(
    msg,
    FixedDate,
    globalContext,
    env,
  );
}

test('split-payment candidates stay pinned against the verified live preimages', () => {
  for (const [key, [, livePreimage, candidate]] of Object.entries(SOURCES)) {
    assert.notEqual(candidate, livePreimage, key);
    assert.equal(crypto.createHash('sha256').update(source(key)).digest('hex'), candidate, key);
  }
});

test('create prepares an open-game four-share payment with bounded deadline', () => {
  const msg = { payload: { date: '2026-08-01', fromTime: '10:00', toTime: '11:30', durationMinutes: 1, studioId: 'studio-1', roomId: 'room-1', clientPhone: '8 960 000 00 01', totalAmount: 10000 } };
  const outputs = run('create', msg);
  assert.equal(outputs.length, 4);
  assert.equal(outputs[0]._splitCtx.vivaDirectionId, 4588);
  assert.equal(outputs[0]._splitCtx.vivaExerciseTypeId, 1613);
  assert.equal(outputs[0]._splitCtx.shareCount, 4);
  assert.equal(outputs[0]._splitCtx.shareAmount, 2500);
  assert.equal(outputs[0]._splitCtx.durationMinutes, 90);
  assert.equal(outputs[0]._splitCtx.subscriptionVisitCount, 2);
  assert.equal(outputs[0]._splitCtx.step, 'pricing_policy');
  assert.equal(outputs[0].method, 'GET');
  assert.match(outputs[0].url, /stationId=/);
  assert.equal(outputs[0].followRedirects, false);
  assert.equal(outputs[0].maxRedirects, 0);
  assert.equal(outputs[0].requestTimeout, 5000);
});

test('subscription create also resolves the exact server-side campaign before Viva mutation', () => {
  const outputs = run('create', {
    payload: {
      date: '2026-08-24',
      fromTime: '18:00',
      toTime: '19:30',
      studioId: 'studio-piter',
      roomId: 'room-piter-1',
      clientPhone: '8 960 000 00 01',
      paymentMode: 'subscription',
      clientSubscriptionId: 'client-subscription-1',
      shareAmount: 1500,
    },
  });
  assert.equal(outputs[0]._splitCtx.paymentMode, 'subscription');
  assert.equal(outputs[0]._splitCtx.step, 'pricing_policy');
  assert.equal(outputs[0].method, 'GET');
  assert.match(outputs[0].url, /forDate=2026-08-24/);
  assert.match(outputs[0].url, /stationId=studio-piter/);
  assert.equal(outputs[0].followRedirects, false);
  assert.equal(outputs[0].maxRedirects, 0);
  assert.equal(outputs[0].requestTimeout, 5000);
});

test('join preserves the participant deadline and detects singles from stored split state', () => {
  const msg = {
    _splitJoinBody: { clientPhone: '+7 960 000 00 02', durationMinutes: 1 },
    payload: [{
      metadata: { splitPayment: { vivaExerciseId: 'exercise-1', shareCount: 2, participantDeadlineAt: '2026-07-27T12:30:00.000Z' } },
      booking: { studioId: 'studio-1', roomId: 'room-1', date: '2026-08-01', timeFrom: '10:00', timeTo: '12:00', durationMinutes: 1 },
      invite: { maxPlayers: 2 },
    }],
  };
  const outputs = run('join', msg);
  assert.equal(outputs[0]._splitCtx.shareCount, 2);
  assert.equal(outputs[0]._splitCtx.deadlineAt, '2026-07-27T12:30:00.000Z');
  assert.equal(outputs[0]._splitCtx.vivaDirectionId, 4588);
  assert.equal(outputs[0]._splitCtx.durationMinutes, 120);
  assert.equal(outputs[0]._splitCtx.step, 'token');
  assert.equal(outputs[0]._splitCtx.pricingPolicy, null);
  assert.match(outputs[0].url, /protocol\/openid-connect\/token$/);
  assert.equal(outputs[0].followRedirects, false);
  assert.equal(outputs[0].maxRedirects, 0);
  assert.equal(outputs[0].requestTimeout, 10000);
});

test('join keeps the stored pricing snapshot and never rereads the current CUP campaign', () => {
  const pricingPolicy = {
    id: 'piter-split-250-per-hour-v1',
    title: 'Питер 250',
    pricingMode: 'PER_PARTICIPANT_HOUR',
    currency: 'RUB',
    twoTeamsHourlyAmount: 500,
    fourPlayersHourlyAmount: 250,
    activeFrom: '2026-08-24',
    activeTo: '2026-09-30',
    version: 'revision-7',
  };
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 05', paymentMode: 'one_time' },
    payload: [{
      metadata: {
        splitPayment: {
          vivaExerciseId: 'exercise-piter',
          shareCount: 4,
          pricingPolicy,
          organizerBookingId: 'booking-organizer-piter',
          payments: [{
            role: 'ORGANIZER',
            transactionId: 'tx-organizer-piter',
            bookingId: 'booking-organizer-piter',
            clientId: 'client-organizer-piter',
            phone: '+7 960 000 00 01',
          }],
        },
      },
      booking: {
        studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'room-piter-1',
        date: '2026-08-24',
        timeFrom: '10:00',
        timeTo: '11:30',
      },
    }],
  });

  assert.equal(outputs[0]._splitCtx.step, 'token');
  assert.deepEqual(outputs[0]._splitCtx.pricingPolicy, pricingPolicy);
  assert.deepEqual(outputs[0]._splitCtx.pricingPolicyProof, {
    transactionId: 'tx-organizer-piter',
    bookingId: 'booking-organizer-piter',
    clientId: 'client-organizer-piter',
    clientPhone: '79600000001',
    expectedAmountMinor: 37500,
  });
  assert.doesNotMatch(outputs[0].url, /split-payment-promo/);
  assert.match(outputs[0].url, /protocol\/openid-connect\/token$/);
  assert.equal(outputs[0].followRedirects, false);
  assert.equal(outputs[0].maxRedirects, 0);
  assert.equal(outputs[0].requestTimeout, 10000);
});

test('join re-resolves the campaign for a subscription-created legacy game without a snapshot', () => {
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 08', paymentMode: 'one_time' },
    payload: [{
      metadata: {
        splitPayment: {
          vivaExerciseId: 'exercise-piter-subscription-legacy',
          shareCount: 4,
          shareAmount: 1500,
          selectedPaymentMode: 'subscription',
        },
      },
      booking: {
        studioId: 'studio-piter',
        roomId: 'room-piter-1',
        date: '2026-08-24',
        timeFrom: '18:00',
        timeTo: '19:30',
      },
    }],
  });

  assert.equal(outputs[0]._splitCtx.step, 'pricing_policy');
  assert.equal(outputs[0]._splitCtx.pricingPolicy, null);
  assert.equal(outputs[0]._splitCtx.pricingPolicyProof, null);
  assert.equal(outputs[0]._splitCtx.shareAmount, 1500);
  assert.match(outputs[0].url, /split-payment-promo/);
  assert.match(outputs[0].url, /forDate=2026-08-24/);
});

test('subscription-created game validates its stored campaign against current CUP policy', () => {
  const pricingPolicy = {
    id: 'piter-split-250-per-hour-v1',
    pricingMode: 'PER_PARTICIPANT_HOUR',
    currency: 'RUB',
    twoTeamsHourlyAmount: 500,
    fourPlayersHourlyAmount: 250,
  };
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 09', paymentMode: 'one_time' },
    payload: [{
      metadata: {
        splitPayment: {
          vivaExerciseId: 'exercise-piter-subscription-policy',
          shareCount: 4,
          selectedPaymentMode: 'subscription',
          pricingPolicy,
        },
      },
      booking: {
        studioId: 'studio-piter',
        roomId: 'room-piter-1',
        date: '2026-08-24',
        timeFrom: '18:00',
        timeTo: '19:30',
      },
    }],
  });

  assert.equal(outputs[0]._splitCtx.step, 'pricing_policy');
  assert.deepEqual(outputs[0]._splitCtx.expectedPricingPolicy, {
    ...pricingPolicy,
    title: null,
    activeFrom: null,
    activeTo: null,
    version: 'piter-split-250-per-hour-v1',
  });
  assert.equal(outputs[0]._splitCtx.pricingPolicyProof, null);
  assert.match(outputs[0].url, /split-payment-promo/);
});

test('join recovers a lost subscription pricing projection only after Viva organizer proof', () => {
  const prepared = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 10', paymentMode: 'one_time' },
    payload: [{
      payment: { paid: true, amount: 0, paymentMethod: 'WIDGET' },
      organizer: { id: 'client-organizer', phone: '+7 960 000 00 01' },
      metadata: {
        splitPayment: {
          enabled: true,
          vivaExerciseId: 'exercise-piter-lost-projection',
          shareCount: 4,
          shareAmount: 2500,
        },
      },
      booking: {
        studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'room-piter-10',
        bookingIds: ['booking-organizer-subscription'],
        date: '2026-08-26',
        timeFrom: '19:00',
        timeTo: '20:30',
      },
    }],
  });

  assert.equal(prepared[0]._splitCtx.step, 'token');
  assert.deepEqual(prepared[0]._splitCtx.legacyPricingRecovery, {
    mode: 'subscription',
    organizerBookingId: 'booking-organizer-subscription',
    organizerClientId: 'client-organizer',
    organizerPhone: '79600000001',
  });

  const bookingLookup = run('router', {
    statusCode: 200,
    payload: { access_token: 'service-token', expires_in: 300 },
    _splitCtx: prepared[0]._splitCtx,
  });
  assert.equal(bookingLookup[0]._splitCtx.step, 'legacy_pricing_booking');
  assert.match(bookingLookup[0].url, /\/exercises\/exercise-piter-lost-projection\/bookings$/);

  const pricingLookup = run('router', {
    statusCode: 200,
    payload: [{
      id: 'booking-organizer-subscription',
      exercise: { id: 'exercise-piter-lost-projection' },
      client: { id: 'client-organizer', phone: '+7 960 000 00 01' },
      clientSubscriptionId: 'client-subscription-organizer',
      paymentType: 'SUBSCRIPTION',
      isCancelled: false,
      cancelled: false,
    }],
    _splitCtx: bookingLookup[0]._splitCtx,
  });
  assert.equal(pricingLookup[0]._splitCtx.step, 'pricing_policy');
  assert.deepEqual(pricingLookup[0]._splitCtx.legacyPricingRecovery, {
    mode: 'subscription',
    organizerBookingId: 'booking-organizer-subscription',
    organizerClientId: 'client-organizer',
    organizerPhone: '+79600000001',
    verified: true,
  });
  assert.match(pricingLookup[0].url, /split-payment-promo/);
  assert.match(pricingLookup[0].url, /forDate=2026-08-26/);

  const priced = run('router', {
    statusCode: 200,
    payload: {
      enabled: true,
      selectedPromoId: 'piter-split-250-per-hour-v1',
      pricingMode: 'PER_PARTICIPANT_HOUR',
      currency: 'RUB',
      shareAmounts: { twoTeams: 500, fourPlayers: 250 },
    },
    _splitCtx: pricingLookup[0]._splitCtx,
  });
  assert.equal(priced[0]._splitCtx.shareAmount, 375);
  assert.equal(priced[0]._splitCtx.pricingPolicy.id, 'piter-split-250-per-hour-v1');
  assert.equal(priced[0]._splitCtx.step, 'token');
});

test('join recovers a directly restored one-time game only after exact organizer payment proof', () => {
  const prepared = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 10', paymentMode: 'one_time' },
    payload: [{
      payment: {
        paid: true,
        amount: 375,
        paidAt: '2026-08-27T06:21:47.210Z',
        paymentMethod: 'WIDGET',
      },
      organizer: { id: 'client-organizer-piter', phone: '+7 960 000 00 01' },
      metadata: {
        recovery: {
          reason: 'missing_lk_record_after_successful_split_create',
          operation: 'direct_guarded_mongo_upsert',
        },
        splitPayment: {
          enabled: true,
          vivaExerciseId: 'exercise-piter-recovered',
          shareCount: 4,
          shareAmount: 375,
          selectedPaymentMode: 'one_time',
          organizerBookingId: 'booking-organizer-piter',
          payments: [{
            role: 'ORGANIZER',
            status: 'PAID',
            amount: 375,
            paidAt: '2026-08-26T07:12:26.000Z',
            bookingId: 'booking-organizer-piter',
            clientId: 'client-organizer-piter',
          }],
        },
      },
      booking: {
        studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'room-piter-10',
        bookingIds: ['booking-organizer-piter'],
        date: '2026-08-30',
        timeFrom: '11:30',
        timeTo: '13:00',
      },
    }],
  });

  assert.equal(prepared[0]._splitCtx.step, 'token');
  assert.deepEqual(prepared[0]._splitCtx.legacyPricingRecovery, {
    mode: 'one_time',
    organizerBookingId: 'booking-organizer-piter',
    organizerClientId: 'client-organizer-piter',
    organizerPhone: '79600000001',
    expectedAmountMinor: 37500,
    paidDate: '2026-08-26',
  });

  const bookingLookup = run('router', {
    statusCode: 200,
    payload: { access_token: 'service-token', expires_in: 300 },
    _splitCtx: prepared[0]._splitCtx,
  });
  assert.equal(bookingLookup[0]._splitCtx.step, 'legacy_pricing_booking');
  assert.match(bookingLookup[0].url, /\/exercises\/exercise-piter-recovered\/bookings$/);

  const transactionLookup = run('router', {
    statusCode: 200,
    payload: [{
      id: 'booking-organizer-piter',
      exercise: { id: 'exercise-piter-recovered' },
      client: { id: 'client-organizer-piter', phone: '+7 960 000 00 01' },
      paymentType: 'ON_PLACE',
      isCancelled: false,
      cancelled: false,
    }],
    _splitCtx: bookingLookup[0]._splitCtx,
  });
  assert.equal(transactionLookup[0]._splitCtx.step, 'legacy_pricing_transaction');
  assert.match(transactionLookup[0].url, /\/transactions\?/);
  assert.match(transactionLookup[0].url, /clientIds=client-organizer-piter/);
  assert.match(transactionLookup[0].url, /dateFrom=2026-08-26/);
  assert.match(transactionLookup[0].url, /dateTo=2026-08-26/);

  const pricingLookup = run('router', {
    statusCode: 200,
    payload: {
      content: [{
        id: 'tx-organizer-piter',
        createDate: '2026-08-26T07:12:26.000Z',
        status: 'PAID',
        toPay: 37500,
        client: { id: 'client-organizer-piter' },
        products: [{ paymentBookingIds: ['booking-organizer-piter'] }],
      }],
    },
    _splitCtx: transactionLookup[0]._splitCtx,
  });
  assert.equal(pricingLookup[0]._splitCtx.step, 'pricing_policy');
  assert.equal(pricingLookup[0]._splitCtx.legacyPricingRecovery.verified, true);
  assert.equal(pricingLookup[0]._splitCtx.legacyPricingRecovery.transactionId, 'tx-organizer-piter');
  assert.match(pricingLookup[0].url, /split-payment-promo/);

  const priced = run('router', {
    statusCode: 200,
    payload: {
      enabled: true,
      selectedPromoId: 'piter-split-250-per-hour-v1',
      pricingMode: 'PER_PARTICIPANT_HOUR',
      currency: 'RUB',
      shareAmounts: { twoTeams: 500, fourPlayers: 250 },
    },
    _splitCtx: pricingLookup[0]._splitCtx,
  });
  assert.equal(priced[0]._splitCtx.shareAmount, 375);
  assert.equal(priced[0]._splitCtx.pricingPolicy.id, 'piter-split-250-per-hour-v1');
  assert.equal(priced[0]._splitCtx.step, 'token');
});

test('directly restored one-time recovery rejects a provider organizer amount mismatch', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: {
      content: [{
        id: 'tx-organizer-wrong-amount',
        createDate: '2026-08-27T07:12:26.000Z',
        status: 'PAID',
        toPay: 150000,
        client: { id: 'client-organizer-piter' },
        products: [{ paymentBookingIds: ['booking-organizer-piter'] }],
      }],
    },
    _splitCtx: {
      step: 'legacy_pricing_transaction',
      action: 'join',
      paymentMode: 'one_time',
      exerciseId: 'exercise-piter-recovered',
      legacyPricingRecovery: {
        mode: 'one_time',
        organizerBookingId: 'booking-organizer-piter',
        organizerClientId: 'client-organizer-piter',
        organizerPhone: '79600000001',
        expectedAmountMinor: 37500,
        paidDate: '2026-08-27',
        bookingVerified: true,
        verified: false,
      },
    },
  });

  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_ORGANIZER_PAYMENT_NOT_CONFIRMED');
  assert.equal(outputs[0], null);
});

test('directly restored recovery rejects conflicting amount fields and nested sibling evidence', () => {
  for (const transaction of [
    {
      id: 'tx-conflicting-amount',
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      toPayMinor: 150000,
      client: { id: 'client-organizer-piter' },
      products: [{ paymentBookingIds: ['booking-organizer-piter'] }],
    },
    {
      id: 'tx-nested-siblings',
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      metadata: {
        unrelatedClient: { client: { id: 'client-organizer-piter' } },
        unrelatedBooking: { paymentBookingIds: ['booking-organizer-piter'] },
      },
    },
    {
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      client: { id: 'client-organizer-piter' },
      products: [{ paymentBookingIds: ['booking-organizer-piter'] }],
    },
    {
      id: 'tx-conflicting-client-alias',
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      client: { id: 'client-organizer-piter', uuid: 'client-other' },
      products: [{ paymentBookingIds: ['booking-organizer-piter'] }],
    },
    {
      id: 'tx-conflicting-booking-alias',
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      client: { id: 'client-organizer-piter' },
      products: [{
        paymentBookingIds: [{ id: 'booking-organizer-piter', bookingId: 'booking-other' }],
      }],
    },
    {
      id: 'tx-conflicting-pricing-detail-alias',
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      client: { id: 'client-organizer-piter' },
      products: [{
        pricingDetails: [{
          clientBookingId: 'booking-organizer-piter',
          bookingId: 'booking-other',
        }],
      }],
    },
    {
      transactionId: 'tx-expected',
      id: 'tx-other',
      createDate: '2026-08-27T07:12:26.000Z',
      status: 'PAID',
      toPay: 37500,
      client: { id: 'client-organizer-piter' },
      products: [{ paymentBookingIds: ['booking-organizer-piter'] }],
    },
  ]) {
    const outputs = run('router', {
      statusCode: 200,
      payload: { content: [transaction] },
      _splitCtx: {
        step: 'legacy_pricing_transaction',
        action: 'join',
        paymentMode: 'one_time',
        exerciseId: 'exercise-piter-recovered',
        legacyPricingRecovery: {
          mode: 'one_time',
          organizerBookingId: 'booking-organizer-piter',
          organizerClientId: 'client-organizer-piter',
          organizerPhone: '79600000001',
          expectedAmountMinor: 37500,
          paidDate: '2026-08-27',
          bookingVerified: true,
          verified: false,
        },
      },
    });

    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 409);
    assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_ORGANIZER_PAYMENT_NOT_CONFIRMED');
  }
});

test('directly restored one-time marker cannot fall back to ordinary pricing with incomplete evidence', () => {
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 10', paymentMode: 'one_time' },
    payload: [{
      payment: { paid: true, amount: 375, paidAt: '2026-08-27T06:21:47.210Z' },
      organizer: { id: 'client-organizer-piter' },
      metadata: {
        recovery: {
          reason: 'missing_lk_record_after_successful_split_create',
          operation: 'direct_guarded_mongo_upsert',
        },
        splitPayment: {
          enabled: true,
          vivaExerciseId: 'exercise-piter-recovered',
          shareCount: 4,
          shareAmount: 375,
          selectedPaymentMode: 'one_time',
          organizerBookingId: 'booking-organizer-piter',
          payments: [{
            role: 'ORGANIZER',
            status: 'PAID',
            amount: 1500,
            paidAt: '2026-08-26T07:12:26.000Z',
            bookingId: 'booking-organizer-piter',
            clientId: 'client-organizer-piter',
          }],
        },
      },
      booking: {
        studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'room-piter-10',
        bookingIds: ['booking-organizer-piter'],
        date: '2026-08-30',
        timeFrom: '11:30',
        timeTo: '13:00',
      },
    }],
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_PRICING_RECOVERY_EVIDENCE_MISSING');
});

test('legacy pricing recovery rejects a malformed enabled CUP response before any Viva mutation', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: {
      enabled: true,
      selectedPromoId: 'piter-split-250-per-hour-v1',
      pricingMode: 'PER_PARTICIPANT_HOUR',
      currency: 'RUB',
      shareAmounts: { twoTeams: 500 },
    },
    _splitCtx: {
      action: 'join',
      step: 'pricing_policy',
      legacyPricingRecovery: { verified: true },
      expectedPricingPolicy: null,
      shareCount: 4,
    },
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 502);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_PRICING_POLICY_INVALID');
  assert.equal(outputs[1].url, undefined);
});

test('an explicit disabled CUP response remains the authoritative no-campaign result', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: { enabled: false, selectedPromoId: null },
    _splitCtx: {
      action: 'join',
      step: 'pricing_policy',
      legacyPricingRecovery: { verified: true },
      expectedPricingPolicy: null,
      shareCount: 4,
    },
  });

  assert.equal(outputs[0]._splitCtx.pricingPolicy, null);
  assert.equal(outputs[0]._splitCtx.step, 'token');
  assert.match(outputs[0].url, /protocol\/openid-connect\/token$/);
});

test('a disabled CUP response cannot simultaneously select a campaign', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: { enabled: false, selectedPromoId: 'contradictory-campaign' },
    _splitCtx: {
      action: 'join',
      step: 'pricing_policy',
      legacyPricingRecovery: { verified: true },
      expectedPricingPolicy: null,
      shareCount: 4,
    },
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 502);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_PRICING_POLICY_INVALID');
  assert.equal(outputs[1].url, undefined);
});

test('legacy pricing recovery fails closed when Viva does not prove the organizer subscription', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: [{
      id: 'booking-organizer-one-time',
      exercise: { id: 'exercise-piter-ambiguous' },
      paymentType: 'ONE_TIME',
      isCancelled: false,
      cancelled: false,
    }],
    _splitCtx: {
      action: 'join',
      step: 'legacy_pricing_booking',
      exerciseId: 'exercise-piter-ambiguous',
      legacyPricingRecovery: {
        organizerBookingId: 'booking-organizer-one-time',
        organizerClientId: 'client-organizer',
      },
    },
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_ORGANIZER_SUBSCRIPTION_NOT_CONFIRMED');
  assert.equal(outputs[1].url, undefined);
});

test('legacy pricing recovery rejects a subscription booking owned by another client', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: [{
      id: 'booking-organizer-subscription',
      exercise: { id: 'exercise-piter-identity-mismatch' },
      client: { id: 'different-client', phone: '+7 960 000 00 99' },
      clientSubscriptionId: 'different-client-subscription',
      paymentType: 'SUBSCRIPTION',
      isCancelled: false,
      cancelled: false,
    }],
    _splitCtx: {
      action: 'join',
      step: 'legacy_pricing_booking',
      exerciseId: 'exercise-piter-identity-mismatch',
      legacyPricingRecovery: {
        organizerBookingId: 'booking-organizer-subscription',
        organizerClientId: 'client-organizer',
        organizerPhone: '79600000001',
      },
    },
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_ORGANIZER_SUBSCRIPTION_NOT_CONFIRMED');
  assert.equal(outputs[1].url, undefined);
});

test('legacy pricing recovery never downgrades a stored client id mismatch to phone-only success', () => {
  const outputs = run('router', {
    statusCode: 200,
    payload: [{
      id: 'booking-organizer-subscription',
      exercise: { id: 'exercise-piter-client-id-mismatch' },
      client: { id: 'different-client', phone: '+7 960 000 00 01' },
      clientSubscriptionId: 'different-client-subscription',
      paymentType: 'SUBSCRIPTION',
      isCancelled: false,
      cancelled: false,
    }],
    _splitCtx: {
      action: 'join',
      step: 'legacy_pricing_booking',
      exerciseId: 'exercise-piter-client-id-mismatch',
      legacyPricingRecovery: {
        organizerBookingId: 'booking-organizer-subscription',
        organizerClientId: 'client-organizer',
        organizerPhone: '79600000001',
      },
    },
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_ORGANIZER_SUBSCRIPTION_NOT_CONFIRMED');
});

test('legacy pricing recovery rejects duplicate provider rows for the exact booking id', () => {
  const shared = {
    id: 'booking-organizer-subscription',
    exercise: { id: 'exercise-piter-duplicate-booking' },
    client: { id: 'client-organizer', phone: '+7 960 000 00 01' },
    clientSubscriptionId: 'client-subscription-organizer',
    paymentType: 'SUBSCRIPTION',
    isCancelled: false,
    cancelled: false,
  };
  const outputs = run('router', {
    statusCode: 200,
    payload: [shared, { ...shared, clientSubscriptionId: 'conflicting-subscription' }],
    _splitCtx: {
      action: 'join',
      step: 'legacy_pricing_booking',
      exerciseId: 'exercise-piter-duplicate-booking',
      legacyPricingRecovery: {
        organizerBookingId: 'booking-organizer-subscription',
        organizerClientId: 'client-organizer',
        organizerPhone: '79600000001',
      },
    },
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_ORGANIZER_SUBSCRIPTION_NOT_CONFIRMED');
});

test('legacy zero-amount game without one organizer booking fails before external payment calls', () => {
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 11', paymentMode: 'one_time' },
    payload: [{
      payment: { paid: true, amount: 0 },
      organizer: { id: 'client-organizer' },
      metadata: {
        splitPayment: {
          enabled: true,
          vivaExerciseId: 'exercise-piter-no-organizer-booking',
          shareCount: 4,
          shareAmount: 2500,
        },
      },
      booking: {
        studioId: 'studio-piter',
        roomId: 'room-piter-1',
        bookingIds: [],
        date: '2026-08-26',
        timeFrom: '19:00',
        timeTo: '20:30',
      },
    }],
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_LEGACY_PRICING_RECOVERY_EVIDENCE_MISSING');
  assert.equal(outputs[1].url, undefined);
});

test('explicit one-time organizer mode never enters legacy subscription recovery', () => {
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 12', paymentMode: 'one_time' },
    payload: [{
      payment: { paid: true, amount: 0 },
      organizer: { id: 'client-organizer' },
      metadata: {
        splitPayment: {
          enabled: true,
          vivaExerciseId: 'exercise-explicit-one-time',
          shareCount: 4,
          shareAmount: 2500,
          selectedPaymentMode: 'one_time',
        },
      },
      booking: {
        studioId: 'studio-ordinary',
        roomId: 'room-ordinary',
        bookingIds: ['booking-organizer-one-time'],
        date: '2026-08-26',
        timeFrom: '19:00',
        timeTo: '20:30',
      },
    }],
  });

  assert.equal(outputs[0]._splitCtx.step, 'token');
  assert.equal(outputs[0]._splitCtx.legacyPricingRecovery, null);
  assert.doesNotMatch(outputs[0].url, /split-payment-promo/);
});

test('join refuses a stored policy without organizer payment evidence', () => {
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 07', paymentMode: 'one_time' },
    payload: [{
      metadata: {
        splitPayment: {
          vivaExerciseId: 'exercise-piter-no-proof',
          shareCount: 4,
          pricingPolicy: {
            id: 'piter-split-250-per-hour-v1',
            pricingMode: 'PER_PARTICIPANT_HOUR',
            currency: 'RUB',
            twoTeamsHourlyAmount: 500,
            fourPlayersHourlyAmount: 250,
          },
        },
      },
      booking: {
        studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'room-piter-1',
        date: '2026-08-24',
        timeFrom: '10:00',
        timeTo: '11:00',
      },
    }],
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_PRICING_POLICY_PROOF_MISSING');
  assert.equal(outputs[1].url, undefined);
});

test('join rejects a malformed stored pricing snapshot before any external request', () => {
  const outputs = run('join', {
    _splitJoinBody: { clientPhone: '+7 960 000 00 06', paymentMode: 'one_time' },
    payload: [{
      metadata: {
        splitPayment: {
          vivaExerciseId: 'exercise-piter-invalid',
          shareCount: 4,
          pricingPolicy: {
            id: 'piter-split-250-per-hour-v1',
            pricingMode: 'PER_PARTICIPANT_HOUR',
            currency: 'RUB',
            fourPlayersHourlyAmount: 1,
          },
        },
      },
      booking: {
        studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
        roomId: 'room-piter-1',
        date: '2026-08-24',
        timeFrom: '10:00',
        timeTo: '11:00',
      },
    }],
  });

  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 409);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_PRICING_POLICY_SNAPSHOT_INVALID');
  assert.equal(outputs[1].url, undefined);
});

test('join ignores browser share count for a stored four-player game', () => {
  const msg = {
    _splitJoinBody: { clientPhone: '+7 960 000 00 03', shareCount: 2, gameFormat: 'singles' },
    payload: [{
      metadata: { splitPayment: { vivaExerciseId: 'exercise-2', shareCount: 4 } },
      booking: { studioId: 'studio-1', roomId: 'room-1', date: '2026-08-01', timeFrom: '10:00', timeTo: '12:00' },
      invite: { maxPlayers: 4 },
    }],
  };
  const outputs = run('join', msg);
  assert.equal(outputs[0]._splitCtx.shareCount, 4);
  assert.equal(outputs[0]._splitCtx.durationMinutes, 120);
  assert.doesNotMatch(outputs[0].url, /split-payment-promo/);
});

test('join never accepts browser location as a substitute for stored game location', () => {
  const outputs = run('join', {
    _splitJoinBody: {
      clientPhone: '+7 960 000 00 04',
      studioId: '1ea77cbf-bc36-49a1-96d6-f35c216a409b',
      roomId: 'room-piter-1',
      date: '2026-08-24',
      paymentMode: 'one_time',
    },
    payload: [{
      metadata: { splitPayment: { vivaExerciseId: 'exercise-legacy' } },
      booking: { studioId: 'studio-stored', date: '2026-08-24', timeFrom: '10:00', timeTo: '11:00' },
    }],
  });
  assert.equal(outputs[1].statusCode, 400);
  assert.equal(outputs[1].payload.details.code, 'SPLIT_GAME_LOCATION_INCOMPLETE');
});

test('router completes a subscription booking without creating a payment transaction', () => {
  const msg = {
    statusCode: 201,
    _splitCtx: {
      action: 'join', step: 'create_booking', paymentRef: 'pay-1', exerciseId: 'exercise-1',
      clientPhone: '79600000002', studioId: 'studio-1', shareCount: 4, shareAmount: 2500,
      oneTimeBaseAmount: 10000, paymentMode: 'subscription', clientSubscriptionId: 'sub-1', deadlineAt: '2026-07-27T12:30:00.000Z',
    },
    payload: { id: 'booking-1', client: { id: 'client-1' }, studio: { id: 'studio-1' } },
  };
  const outputs = run('router', msg);
  assert.equal(outputs[0], null);
  assert.equal(outputs[1].statusCode, 201);
  assert.equal(outputs[1].payload.selectedPaymentMode, 'subscription');
  assert.equal(outputs[1].payload.toPay, 0);
  assert.equal(outputs[1].payload.bookingId, 'booking-1');
});

test('router canonicalizes a stale subscription share from the selected Piter campaign', () => {
  const pricingOut = run('router', {
    statusCode: 200,
    payload: {
      enabled: true,
      selectedPromoId: 'piter-split-250-per-hour-v1',
      pricingMode: 'PER_PARTICIPANT_HOUR',
      currency: 'RUB',
      shareAmounts: { twoTeams: 500, fourPlayers: 250 },
    },
    _splitCtx: {
      step: 'pricing_policy',
      action: 'create',
      paymentMode: 'subscription',
      shareCount: 4,
      durationMinutes: 90,
      shareAmount: 1500,
    },
  });
  assert.equal(pricingOut[0]._splitCtx.shareAmount, 375);
  assert.equal(pricingOut[0]._splitCtx.pricingPolicy.id, 'piter-split-250-per-hour-v1');

  const responseOut = run('router', {
    statusCode: 201,
    payload: {
      id: 'booking-subscription-piter',
      clientSubscriptionId: 'client-subscription-piter',
      client: { id: 'client-piter' },
      studio: { id: 'studio-piter' },
    },
    _splitCtx: {
      ...pricingOut[0]._splitCtx,
      step: 'create_booking',
      paymentRef: 'payment-subscription-piter',
      exerciseId: 'exercise-subscription-piter',
      clientSubscriptionId: 'client-subscription-piter',
      selectedPaymentMode: 'subscription',
      oneTimeBaseAmount: 10000,
    },
  });
  assert.equal(responseOut[1].payload.shareAmount, 375);
  assert.equal(responseOut[1].payload.pricingPolicy.id, 'piter-split-250-per-hour-v1');
});

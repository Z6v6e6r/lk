import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  create: ['fn_split_create_prepare.js', '2daf57341d845cc454db4aba7ea8147daef1faa1311f563a8b5f6c3840b3adc3', '19a61024273a478f11bff3ff60c4601603c2af5bd7ec8ec08e4b83394ee7bd41'],
  join: ['fn_split_join_prepare.js', 'e077708db904b7c319ecb639933637f70028ba35d0daef8f35057e72e61ced60', 'bb9c70f29c31ed1f7b1acc1a3c6e1724bc6584df7570a61f7797604e05d3369d'],
  router: ['fn_split_router.js', 'f0a350a3b39f5ffd3b4745752382dd83ff656380c96ed0496f483e383e139584', '892ad51fcb8f2be2a194661e04f9c775d4345fea153e5dbc3758bd40967101f2'],
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

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  create: ['fn_split_create_prepare.js', '015848c8e0488adf6c23f2d44c48471d5aa27493998a5a0dbb86db9f4c56430a', 'bd8549b41fff84b4404fb95606548affe4858995594a2f6bf42fedd759fafbf4'],
  join: ['fn_split_join_prepare.js', '13e89a54460924495ad280e0651c95dc80c68deedf36ee3b0ec9ebbbf03f0070', '86711b7a968089f1bc0cceb5fcfd742bae2db64cbba8ef6594963b3bee49f0d3'],
  router: ['fn_split_router.js', '624e4a233bcd6cf011cd0f0d61aa48243c6878393f31330d5a218e81003227a1', '3cfc57a3af5f8425bb4de72e4041c4b17398b5db50c304b9a1f23163cdd1eefb'],
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
  assert.equal(outputs[0]._splitCtx.step, 'pricing_policy');
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

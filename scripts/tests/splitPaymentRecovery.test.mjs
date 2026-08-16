import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  create: ['fn_split_create_prepare.js', 'd76e532d8f9d3cba655a4fabadf21635c85ed360a4bfac18534e10fef5661bfa', '015848c8e0488adf6c23f2d44c48471d5aa27493998a5a0dbb86db9f4c56430a'],
  join: ['fn_split_join_prepare.js', '707fdde66c340769a0c68e6e693bda22eb040b715ef33ad109e39c4709cea950', '415a2131acd876a4a973d71f9478c2ccd127dee4d59fbc5043ca77db15b4a0e6'],
  router: ['fn_split_router.js', 'aba5f45ce45208997b188d5292194c49d357452673eee7b937650ec998348a04', '6be5041a581846dc53ecf0ef02c4c7e90adff52b94c4ee0d9ca2ff9d6b82eaad'],
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

test('three split-payment candidates stay pinned separately from verified live preimages', () => {
  for (const [key, [, livePreimage, candidate]] of Object.entries(SOURCES)) {
    assert.notEqual(candidate, livePreimage, key);
    assert.equal(crypto.createHash('sha256').update(source(key)).digest('hex'), candidate, key);
  }
});

test('create prepares an open-game four-share payment with bounded deadline', () => {
  const msg = { payload: { date: '2026-08-01', fromTime: '10:00', toTime: '11:30', roomId: 'room-1', clientPhone: '8 960 000 00 01', totalAmount: 10000 } };
  const outputs = run('create', msg);
  assert.equal(outputs.length, 4);
  assert.equal(outputs[0]._splitCtx.vivaDirectionId, 4588);
  assert.equal(outputs[0]._splitCtx.vivaExerciseTypeId, 1613);
  assert.equal(outputs[0]._splitCtx.shareCount, 4);
  assert.equal(outputs[0]._splitCtx.shareAmount, 2500);
  assert.equal(outputs[0]._splitCtx.subscriptionVisitCount, 2);
});

test('join preserves the participant deadline and detects singles from stored split state', () => {
  const msg = {
    _splitJoinBody: { clientPhone: '+7 960 000 00 02' },
    payload: [{
      metadata: { splitPayment: { vivaExerciseId: 'exercise-1', shareCount: 2, participantDeadlineAt: '2026-07-27T12:30:00.000Z' } },
      booking: { studioId: 'studio-1', timeFrom: '10:00', timeTo: '11:00' },
      invite: { maxPlayers: 2 },
    }],
  };
  const outputs = run('join', msg);
  assert.equal(outputs[0]._splitCtx.shareCount, 2);
  assert.equal(outputs[0]._splitCtx.deadlineAt, '2026-07-27T12:30:00.000Z');
  assert.equal(outputs[0]._splitCtx.vivaDirectionId, 4588);
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

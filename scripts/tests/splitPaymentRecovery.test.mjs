import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = {
  create: ['fn_split_create_prepare.js', 'd76e532d8f9d3cba655a4fabadf21635c85ed360a4bfac18534e10fef5661bfa'],
  join: ['fn_split_join_prepare.js', '707fdde66c340769a0c68e6e693bda22eb040b715ef33ad109e39c4709cea950'],
  router: ['fn_split_router.js', 'd9d6d1f17c12f38b567cf226468caa6780ed3d6e707f55f4af26c066be86b1a4'],
};

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-07-27T12:20:00.000Z'])); }
  static now() { return Date.parse('2026-07-27T12:20:00.000Z'); }
}

function source(key) { return fs.readFileSync(path.join(ROOT, 'scripts/nodered_games_nodes', SOURCES[key][0]), 'utf8'); }
function run(key, msg) { return new Function('msg', 'Date', source(key))(msg, FixedDate); }

test('three split-payment sources exactly match their verified live functions', () => {
  for (const [key, [, expected]] of Object.entries(SOURCES)) {
    assert.equal(crypto.createHash('sha256').update(source(key)).digest('hex'), expected, key);
  }
});

test('create prepares an open-game four-share payment with bounded deadline', () => {
  const msg = { payload: { date: '2026-08-01', fromTime: '10:00', toTime: '11:30', roomId: 'room-1', clientPhone: '8 960 000 00 01', totalAmount: 10000 } };
  const outputs = run('create', msg);
  assert.equal(outputs.length, 3);
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

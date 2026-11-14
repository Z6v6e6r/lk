import assert from 'node:assert/strict';
import test from 'node:test';
import { gameCancellationBegin, gameCancellationStep } from '../lib/gameCancellationReconciliation.mjs';
const at = '2099-11-11T12:00:00Z';
function fixture() {
  const game = { id: 'game', status: 'PAID', archived: false, updatedAt: at, revision: 2,
    organizer: { id: 'actor' }, participants: [{ id: 'actor' }],
    booking: { exerciseId: 'exercise', bookingIds: ['booking'] },
    metadata: { splitPayment: { organizerBookingId: 'booking', vivaExerciseId: 'exercise', payments: [] } },
    payment: { paid: true, amount: 2500, receipt: 'historical' } };
  const booking = { id: 'booking', client: { id: 'actor' }, exerciseId: 'exercise', isCancelled: true, cancelled: true };
  return { game, booking, rows: [booking], writes: [], mutate: null, apply: true };
}
async function drive(f, actorClientId = 'actor') {
  const begun = gameCancellationBegin({ gameId: 'game', actorClientId }); let effect = begun.effect;
  for (let i = 0; i < 30; i++) {
    if (effect.kind === 'reply') return effect;
    let input;
    if (effect.kind === 'find') input = { payload: [structuredClone(f.game)] };
    if (effect.kind === 'http') {
      assert.equal(effect.method, 'GET'); input = { status: 200, payload: effect.path.includes('/exercises/')
        ? f.page || { content: f.rows, last: true, totalElements: f.rows.length } : f.booking };
    }
    if (effect.kind === 'update') {
      f.writes.push(effect); f.mutate?.();
      if (f.apply && f.game.updatedAt === effect.query.updatedAt && !f.game.membershipMutation) {
        f.game.status = effect.change.$set.status; f.game.archived = true;
        f.game.metadata.cancellationReconciliation = effect.change.$set['metadata.cancellationReconciliation'];
      }
      input = { payload: { acknowledged: true, matchedCount: f.apply ? 1 : 0 } };
    }
    effect = gameCancellationStep(begun.state, input, at);
  }
  throw Error('HOP_LIMIT');
}
test('confirmed cancellation reconciles local PAID game and retains payment history', async () => {
  const f = fixture(), payment = structuredClone(f.game.payment);
  assert.equal((await drive(f)).payload.state, 'CANCELLED');
  assert.equal(f.writes.length, 1); assert.deepEqual(f.game.payment, payment);
  assert.deepEqual(f.writes[0].options.writeConcern, { w: 'majority', j: true });
});
for (const mutate of [f => f.booking.isCancelled = false, f => f.rows.push({ id: 'replacement', isCancelled: false }),
  f => f.booking.client.id = 'foreign', f => f.page = { content: f.rows, last: false, totalElements: 201 },
  f => f.rows = [{ ...f.booking, exerciseId: 'foreign' }],
  f => f.rows = [{ ...f.booking, bookingId: 'foreign' }],
  f => f.rows = [{ ...f.booking, client: { id: 'foreign' } }],
  f => f.game.membershipMutation = { operationKey: 'leave' }]) {
  test('active, foreign, incomplete or fenced evidence cannot archive a game', async () => {
    const f = fixture(); mutate(f); assert.notEqual((await drive(f)).payload.state, 'CANCELLED'); assert.equal(f.writes.length, 0);
  });
}
test('unrelated authenticated user cannot inspect or reconcile a game', async () => {
  const f = fixture(); assert.equal((await drive(f, 'stranger')).status, 403); assert.equal(f.writes.length, 0);
});
test('concurrent membership update wins over cancellation projection', async () => {
  const f = fixture(); f.mutate = () => f.game.membershipMutation = { operationKey: 'new-join' };
  assert.equal((await drive(f)).payload.state, 'UNVERIFIED'); assert.equal(f.game.status, 'PAID');
});
test('lost Mongo acknowledgement is verified by exact persisted proof', async () => {
  const f = fixture(); f.apply = false; assert.equal((await drive(f)).payload.state, 'UNVERIFIED');
});

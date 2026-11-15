import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareExistingBookingLink, bookingLinkDigest } from '../prepare_existing_booking_link.mjs';

const now = '2099-11-15T16:00:00.000Z';
function fixture() {
  const expected = { tenantKey: 'tenant', gameId: 'game', actorClientId: 'actor',
    bookingId: 'existing-booking', exerciseId: 'exercise', clientSubscriptionId: 'subscription', operationId: 'operation' };
  const booking = { id: expected.bookingId, client: { id: 'actor', phone: '70000000001' }, exerciseId: 'exercise',
    clientSubscriptionId: 'subscription', paymentType: 'SUBSCRIPTION', isCancelled: false, cancelled: false,
    exerciseDate: '2099-11-17T22:00:00+03:00', exerciseDateTo: '2099-11-18T00:00:00+03:00',
    room: { id: 'room' }, studio: { id: 'studio' } };
  const operation = { _id: 'operation-key', ...expected, state: 'CONFIRMED',
    createdAt: now, confirmedAt: now, serviceDate: '2099-11-17',
    lk1: { rule: { productId: 'product' }, target: { category: 'GAME', eventId: 'exercise',
      startsAt: booking.exerciseDate, durationMinutes: 120, roomId: 'room', stationId: 'studio' },
    decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 },
      gameMinutes: { localDate: '2099-11-17', freeMinutes: 120, paidOverageMinutes: 0 } } } };
  return { observedAt: now, expected, booking, operation,
    subscription: { subscriptionId: 'subscription', product: { id: 'product' }, status: 'ACTIVE',
      expirationDate: '2099-12-01', visitsLeft: 25, visitsTotal: 30, bookings: [booking] },
    guard: { _id: 'lk1-daily-visit:["tenant","subscription","2099-11-17"]', kind: 'LK1_DAILY_VISIT_V1',
      tenantKey: 'tenant', clientSubscriptionId: 'subscription', serviceDate: '2099-11-17',
      ownerOperationKey: 'operation-key', ownerOperationId: 'operation' },
    game: { _id: 'mongo-id', id: 'game', status: 'PAID', updatedAt: now, revision: 3,
      organizer: { id: 'organizer' }, participants: [{ id: 'organizer', status: 'CONFIRMED' },
        { id: 'actor', status: 'CONFIRMED', source: 'ADMIN' }], waitlist: [],
      booking: { date: '2099-11-17', exerciseId: 'exercise', roomId: 'room', studioId: 'studio',
        timeFromIso: booking.exerciseDate, timeToIso: booking.exerciseDateTo, bookingIds: ['organizer-booking'] },
      metadata: { untouched: 'keep', splitPayment: { enabled: true, status: 'ACTIVE',
        payments: [{ clientId: 'organizer', bookingId: 'organizer-booking', status: 'PAID' }] } },
      audit: { events: [{ type: 'existing-event' }] } },
    reads: { startedAt: now, subscriptionsComplete: true, gameComplete: true, gameMatches: 1, bookingStatus: 200, subscriptionStatus: 200,
      operationsComplete: true, operationMatches: 1, guardMatches: 1,
      linkedGames: { complete: true, bookingId: 'existing-booking', gameIds: [] } } };
}
function applySet(game, update) {
  const post = structuredClone(game);
  for (const [key, value] of Object.entries(update.$set || {})) {
    const parts = key.split('.'); const last = parts.pop(); let row = post;
    for (const part of parts) row = row[part];
    row[last] = structuredClone(value);
  }
  return post;
}

test('offline proposal links the confirmed booking without changing roster, organizer, provider or visits', () => {
  const evidence = fixture(), before = structuredClone(evidence);
  const p = prepareExistingBookingLink(evidence, now);
  assert.equal(p.status, 'PREPARED_REVIEW_ONLY');
  assert.equal(p.providerWrites, 0); assert.equal(p.operationWrites, 0); assert.equal(p.guardWrites, 0);
  assert.deepEqual(evidence, before);
  const post = applySet(evidence.game, p.command.update);
  for (const key of ['organizer', 'participants', 'waitlist', 'booking', 'audit']) assert.deepEqual(post[key], before.game[key]);
  assert.equal(post.metadata.untouched, 'keep');
  assert.deepEqual(post.metadata.bookingIds, ['existing-booking']);
  assert.deepEqual(post.metadata.splitPayment.bookingIds, ['existing-booking']);
  const payment = post.metadata.splitPayment.payments.at(-1);
  assert.equal(payment.status, 'PAID'); assert.equal(payment.amountMinor, 0);
  for (const key of ['paymentRef', 'transactionId', 'paymentUrl']) assert.equal(Object.hasOwn(payment, key), false);
  assert.equal(post.revision, 4);
  assert.deepEqual(p.command.filter.participants.$eq, before.game.participants);
  assert.deepEqual(p.command.filter.metadata.$eq, before.game.metadata);
  assert.equal(p.command.filter._id, undefined);
  assert.equal(p.command.filter.$expr.$eq[1], Object.keys(before.game).length);
  assert.equal(p.command.options.upsert, false);
  assert.deepEqual(p.rollback.filter.metadata.$eq, post.metadata);
  assert.equal(p.postimageSha256, bookingLinkDigest(post));
  assert.equal(p.rollback.update.$unset['metadata.bookingIds'], '');
});

test('already complete link yields no command and no duplicate payment', () => {
  const e = fixture(), p = prepareExistingBookingLink(e, now);
  e.game = applySet(e.game, p.command.update);
  assert.equal(prepareExistingBookingLink(e, now).status, 'ALREADY_LINKED');
  assert.equal(prepareExistingBookingLink(e, now).command, null);
});

for (const [name, mutate, code] of [
  ['stale evidence', e => { e.observedAt = '2099-11-15T15:58:59Z'; }, 'EVIDENCE_STALE'],
  ['incomplete game lookup', e => { e.reads.gameMatches = 2; }, 'READ_RECEIPTS_INCOMPLETE'],
  ['active membership mutation', e => { e.game.membershipMutation = null; }, 'GAME_NOT_STABLE'],
  ['unconfirmed operation', e => { e.operation.state = 'PREPARED'; }, 'OPERATION_NOT_CONFIRMED'],
  ['paid decision', e => { e.operation.lk1.decision.benefit.finalPriceMinor = 100; }, 'ZERO_COST_RECEIPT_INVALID'],
  ['released benefit', e => { e.operation.lk1.seatRelease = {}; }, 'ZERO_COST_RECEIPT_INVALID'],
  ['wrong provider owner', e => { e.booking = { ...e.booking, client: { id: 'other' } }; }, 'PROVIDER_BOOKING_MISMATCH'],
  ['cancelled provider booking', e => { e.booking = { ...e.booking, cancelled: true }; }, 'PROVIDER_BOOKING_MISMATCH'],
  ['wrong provider subscription', e => { e.booking = { ...e.booking, clientSubscriptionId: 'other' }; }, 'PROVIDER_BOOKING_MISMATCH'],
  ['missing consumption', e => { e.subscription.bookings = []; }, 'CONSUMPTION_NOT_PROVEN'],
  ['missing product identity', e => { delete e.subscription.product; delete e.operation.lk1.rule; }, 'SUBSCRIPTION_MISMATCH'],
  ['different guard owner', e => { e.guard.ownerOperationId = 'other'; }, 'GUARD_OWNER_MISMATCH'],
  ['different game exercise', e => { e.game.booking.exerciseId = 'other'; }, 'GAME_BOOKING_MISMATCH'],
  ['absent participant', e => { e.game.participants.pop(); }, 'PARTICIPANT_NOT_UNIQUE'],
  ['duplicate participant', e => { e.game.participants.push({ id: 'actor' }); }, 'PARTICIPANT_NOT_UNIQUE'],
  ['conflicting participant booking', e => { e.game.participants[1].bookingId = 'other'; }, 'PARTICIPANT_BOOKING_CONFLICT'],
  ['conflicting participant viva booking', e => { e.game.participants[1].vivaBookingId = 'other'; }, 'PARTICIPANT_BOOKING_CONFLICT'],
  ['participant identity aliases conflict', e => { e.game.participants[1].userId = 'other'; }, 'IDENTITY_ALIAS_CONFLICT'],
  ['phone identity conflicts with client ID', e => { e.game.participants.push({ id: 'other', phone: '70000000001' }); }, 'IDENTITY_ALIAS_CONFLICT'],
  ['phone-only waitlist duplicate', e => { e.game.waitlist.push({ phone: '70000000001' }); }, 'PARTICIPANT_NOT_UNIQUE'],
  ['participant booking in organizer array', e => { e.game.booking.bookingIds.push('existing-booking'); }, 'BOOKING_IN_ORGANIZER_REFERENCES'],
  ['participant booking in organizer split alias', e => { e.game.metadata.splitPayment.organizerBookingId = 'existing-booking'; }, 'BOOKING_IN_ORGANIZER_REFERENCES'],
  ['same-game other participant booking', e => { e.game.participants.push({ id: 'other', bookingId: 'existing-booking' }); }, 'ROSTER_BOOKING_CONFLICT'],
  ['same-game other waitlist booking', e => { e.game.waitlist.push({ id: 'other', vivaBookingId: 'existing-booking' }); }, 'ROSTER_BOOKING_CONFLICT'],
  ['organizer row booking alias', e => { e.game.organizer.vivaBookingId = 'existing-booking'; }, 'ROSTER_BOOKING_CONFLICT'],
  ['incomplete duplicate lookup', e => { e.reads.linkedGames.complete = false; }, 'OTHER_GAME_BINDING_UNRESOLVED'],
  ['booking linked elsewhere', e => { e.reads.linkedGames.gameIds = ['other-game']; }, 'OTHER_GAME_BINDING_UNRESOLVED'],
  ['pending payment', e => { e.game.metadata.splitPayment.payments.push({ clientId: 'actor', bookingId: 'existing-booking', status: 'PAYMENT_PENDING' }); }, 'PAYMENT_BINDING_CONFLICT'],
  ['conflicting client payment', e => { e.game.metadata.splitPayment.payments.push({ clientId: 'actor', bookingId: 'other-booking', status: 'PAID' }); }, 'PAYMENT_BINDING_CONFLICT'],
  ['conflicting legacy player payment', e => { e.game.metadata.splitPayment.payments.push({ playerId: 'actor', bookingId: 'other-booking', status: 'PAYMENT_PENDING' }); }, 'PAYMENT_BINDING_CONFLICT'],
  ['conflicting legacy user payment', e => { e.game.metadata.splitPayment.payments.push({ userId: 'actor', bookingId: 'other-booking', status: 'PAYMENT_PENDING' }); }, 'PAYMENT_BINDING_CONFLICT'],
  ['conflicting phone-only payment', e => { e.game.metadata.splitPayment.payments.push({ phone: '70000000001', bookingId: 'other-booking', status: 'PAYMENT_PENDING' }); }, 'PAYMENT_BINDING_CONFLICT'],
  ['conflicting payment identity aliases', e => { e.game.metadata.splitPayment.payments.push({ clientId: 'actor', userId: 'other' }); }, 'IDENTITY_ALIAS_CONFLICT'],
  ['invalid payment booking array', e => { e.game.metadata.splitPayment.payments.push({ clientId: 'other', bookingIds: 'existing-booking' }); }, 'PAYMENT_REFERENCES_INVALID'],
]) test(`proposal refuses ${name}`, () => {
  const e = fixture(); mutate(e);
  assert.throws(() => prepareExistingBookingLink(e, now), new RegExp(`^Error: ${code}$`));
});

test('CLI has no apply mode and writes only a private external proposal', () => {
  const cli = 'scripts/prepare_existing_booking_link.mjs';
  assert.notEqual(spawnSync(process.execPath, [cli, '--apply'], { encoding: 'utf8' }).status, 0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-link-proposal-'));
  fs.chmodSync(dir, 0o700);
  const e = fixture(), time = Date.now();
  e.observedAt = new Date(time).toISOString();
  e.reads.startedAt = e.observedAt;
  e.operation.createdAt = e.operation.confirmedAt = e.observedAt;
  e.game.updatedAt = e.observedAt;
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'proposal.json');
  fs.writeFileSync(input, JSON.stringify(e), { mode: 0o600 });
  const result = spawnSync(process.execPath, [cli, '--input', input, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(JSON.parse(result.stdout).databaseWrites, 0);
  assert.equal(result.stdout.includes('existing-booking'), false);
  assert.notEqual(spawnSync(process.execPath, [cli, '--input', input, '--output', output]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [cli, '--input', input, '--output', 'public-proposal.json']).status, 0);
  fs.mkdirSync(path.join(dir, '.git'));
  assert.notEqual(spawnSync(process.execPath, [cli, '--input', input, '--output', path.join(dir, 'unsafe-proposal.json')]).status, 0);
});

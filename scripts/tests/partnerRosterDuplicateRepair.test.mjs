import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planPartnerDuplicateRepair, repairPartnerDuplicate, verifyPartnerDuplicateRepair } from '../repair_partner_roster_duplicate.mjs';
const fixture = () => {
  const scope = { gameId: 'game-a', membershipId: 'member-a', bookingId: 'booking-a', operationId: 'operation-a', technicalClientId: 'technical-a' };
  const named = { id: 'partner:member-a', membershipId: 'member-a', name: 'Named participant', source: 'PARTNER_API', status: 'CONFIRMED' };
  const game = { _id: 'document-a', id: 'game-a', tenantKey: 'tenant-a', status: 'PAID', updatedAt: 'version-a',
    participants: [{ id: 'organizer-a', source: 'ORGANIZER' }, named, { id: 'technical-a', source: 'ADMIN', status: 'CONFIRMED' }],
    payments: [{ playerId: named.id, membershipId: 'member-a', membershipGeneration: 1, bookingId: 'booking-a', status: 'PAID', settlementSource: 'EXTERNAL_PARTNER', amountMinor: 100, currency: 'TEST' }],
    resultRosterSnapshot: { preserved: true }, metadata: { splitPayment: { preserved: true } } };
  const membership = { _id: 'member-a', membershipId: 'member-a', state: 'ACTIVE', gameDocumentId: game._id, tenantKey: game.tenantKey, gameId: game.id,
    bookingId: 'booking-a', exerciseId: 'exercise-a', technicalVivaClientId: 'technical-a', clientId: 'partner-client-a', generation: 1, operationId: 'operation-a' };
  const operation = { _id: 'operation-a', state: 'COMPLETED', action: 'ADD_MEMBER', membershipId: 'member-a', gameId: game.id, tenantKey: game.tenantKey, clientId: membership.clientId };
  const vivaRoster = { complete: true, exerciseId: 'exercise-a', readAt: new Date().toISOString(), bookings: [{ id: 'booking-a', client: { id: 'technical-a' }, exercise: { id: 'exercise-a' }, isCancelled: false, cancellationDate: null, paymentType: 'ON_PLACE' }] };
  return { game, membership, operation, vivaRoster, scope };
};

test('repair removes only technical row and restores canonical booking fields without touching payments', () => {
  const input = fixture(); const before = structuredClone(input); const plan = planPartnerDuplicateRepair(input);
  assert.equal(plan.removedCount, 1);
  assert.equal(plan.afterCount, 2);
  assert.deepEqual(plan.nextParticipants[0], input.game.participants[0]);
  assert.deepEqual(plan.nextParticipants[1], { ...input.game.participants[1], vivaBookingId: 'booking-a', membershipGeneration: 1 });
  assert.deepEqual(input, before);
});

test('repair fails on cancellation, shared technical client, incomplete provider page or another exercise', () => {
  for (const mutate of [
    (i) => { i.vivaRoster.complete = false; },
    (i) => { i.vivaRoster.bookings[0].isCancelled = true; },
    (i) => { i.vivaRoster.bookings.push({ ...i.vivaRoster.bookings[0], id: 'other-booking' }); },
    (i) => { i.vivaRoster.bookings[0].exercise.id = 'other-exercise'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planPartnerDuplicateRepair(input)); }
});

test('repair rejects mismatched membership, payment, named participant and completed operation', () => {
  for (const mutate of [
    (i) => { i.membership.state = 'REMOVAL_PENDING'; },
    (i) => { i.membership.gameDocumentId = 'wrong-document'; },
    (i) => { i.operation.state = 'VIVA_PENDING'; },
    (i) => { i.game.payments[0].bookingId = 'wrong-booking'; },
    (i) => { i.game.payments[0].status = 'LEFT'; },
    (i) => { i.game.participants[1].vivaBookingId = 'wrong-booking'; },
    (i) => { i.game.participants[2].membershipId = 'another-member'; },
    (i) => { i.game.participants.push({ ...i.game.participants[2] }); },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planPartnerDuplicateRepair(input)); }
});

test('repair stops for a result-bearing game, organizer technical row or invalid revision', () => {
  for (const mutate of [
    (i) => { i.game.resultId = 'result-a'; },
    (i) => { i.game.metadata.matchResult = { status: 'DRAFT' }; },
    (i) => { i.game.organizer = { id: 'technical-a' }; },
    (i) => { i.game.revision = -1; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planPartnerDuplicateRepair(input)); }
});

test('postcheck detects payment or Partner state drift and preserves snapshots', () => {
  const input = fixture(); const plan = planPartnerDuplicateRepair(input);
  const after = { ...input.game, participants: plan.nextParticipants, revision: plan.nextRevision, updatedAt: 'version-b' };
  const args = { before: input.game, after, membershipBefore: input.membership, membershipAfter: input.membership, operationBefore: input.operation, operationAfter: input.operation, plan };
  assert.equal(verifyPartnerDuplicateRepair(args), true);
  assert.throws(() => verifyPartnerDuplicateRepair({ ...args, after: { ...after, payments: [] } }));
  assert.throws(() => verifyPartnerDuplicateRepair({ ...args, membershipAfter: { ...input.membership, state: 'REMOVED' } }));
});

function database(input, matchedCount = 1) {
  let game = structuredClone(input.game); let writes = 0; let commits = 0; let aborts = 0; let active = false;
  const db = { collection: (name) => name === 'lk_games' ? {
    find: () => ({ limit: () => ({ toArray: async () => [game] }) }),
    updateOne: async (_query, update) => { writes++; if (matchedCount === 1) game = { ...game, ...update.$set }; return { acknowledged: true, matchedCount, modifiedCount: matchedCount }; },
  } : { findOne: async () => name === 'lk_partner_game_memberships' ? input.membership : input.operation } };
  const client = { startSession: () => ({ startTransaction: () => { active = true; }, commitTransaction: async () => { commits++; active = false; }, inTransaction: () => active, abortTransaction: async () => { aborts++; active = false; }, endSession: async () => {} }) };
  return { db, client, counters: () => ({ writes, commits, aborts }) };
}

test('dry-run performs no writes, backup creation or transaction', async () => {
  const input = fixture(); const mock = database(input);
  const receipt = await repairPartnerDuplicate({ ...mock, scope: input.scope, readVivaRoster: async () => input.vivaRoster });
  assert.equal(receipt.mode, 'dry-run');
  assert.deepEqual(mock.counters(), { writes: 0, commits: 0, aborts: 0 });
});

test('apply requires exact dry-run hash and writes a private backup and postcheck', async () => {
  const input = fixture(); const mock = database(input); const plan = planPartnerDuplicateRepair(input);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-roster-repair-test-'));
  try {
    const backupDirectory = path.join(fs.realpathSync(temp), 'backup');
    const receipt = await repairPartnerDuplicate({ ...mock, scope: input.scope, readVivaRoster: async () => input.vivaRoster, apply: true, verifyQuiescence: async () => true, expectedPreimageHash: plan.preimageHash, backupDirectory });
    assert.equal(receipt.verified, true);
    assert.equal(fs.statSync(path.join(backupDirectory, 'preimage.bson')).mode & 0o777, 0o600);
    assert.deepEqual(mock.counters(), { writes: 1, commits: 1, aborts: 0 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('CAS conflict aborts once without automatic retries or provider mutations', async () => {
  const input = fixture(); const mock = database(input, 0); const plan = planPartnerDuplicateRepair(input);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-roster-repair-conflict-'));
  try {
    await assert.rejects(repairPartnerDuplicate({ ...mock, scope: input.scope, readVivaRoster: async () => input.vivaRoster, apply: true, verifyQuiescence: async () => true, expectedPreimageHash: plan.preimageHash, backupDirectory: path.join(fs.realpathSync(temp), 'backup') }), /CAS repair/);
    assert.deepEqual(mock.counters(), { writes: 1, commits: 0, aborts: 1 });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});


test('repair rejects missing lifecycle, conflicting payment type, old provider proof and unpaused apply', async () => {
  for (const mutate of [
    (i) => { delete i.vivaRoster.bookings[0].isCancelled; delete i.vivaRoster.bookings[0].cancellationDate; },
    (i) => { i.vivaRoster.bookings[0].paymentType = 'PREPAID'; },
    (i) => { i.vivaRoster.bookings[0].cancelled = true; },
    (i) => { i.vivaRoster.bookings[0].active = false; },
    (i) => { i.vivaRoster.bookings[0].status = 'CANCELLED'; },
    (i) => { i.vivaRoster.bookings[0].cancelled = 'true'; },
    (i) => { i.vivaRoster.readAt = '2000-01-01T00:00:00Z'; },
    (i) => { i.membership.technicalVivaClientId = 'other-client'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => planPartnerDuplicateRepair(input)); }
  const input = fixture(); const mock = database(input);
  await assert.rejects(repairPartnerDuplicate({ ...mock, scope: input.scope, readVivaRoster: async () => input.vivaRoster, apply: true }), /drained/);
  assert.equal(mock.counters().writes, 0);
});

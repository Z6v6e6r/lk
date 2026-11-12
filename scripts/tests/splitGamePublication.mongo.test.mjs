import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { runPublicationBatch } from '../split_game_publication_worker.mjs';
import { normalizePublicationIntent, normalizeBookingContract, publishConfirmedOperation } from '../lib/splitGamePublication.mjs';

const uri = process.env.SPLIT_PUBLICATION_TEST_MONGO_URI;
test('Mongo replica: concurrent workers, commit loss/restart and cancellation are atomic', { skip: !uri }, async () => {
  // This URI is accepted only for a disposable local fixture, never a shared database.
  const u = new URL(uri); assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname));
  const client = new MongoClient(uri); await client.connect();
  const db = client.db('split_publication_fixture_' + process.pid);
  try {
    const games = db.collection('lk_games'), operations = db.collection('lk_subscription_daily_booking_ops');
    await games.createIndex({ tenantKey: 1, id: 1 }, { unique: true });
    const c = { timeFrom: '2030-11-12T18:00:00+03:00', timeTo: '2030-11-12T19:00:00+03:00', maxClientsCount: 4, roomId: 'fixture-room' };
    const intent = normalizePublicationIntent({ version: 1, settings: { isPrivate: true, ratingGame: false, minRating: null, maxRating: null },
      gameTitle: 'Fixture', participantComment: null, joinPrice: null, studioName: null, roomName: null, gameFormat: 'doubles' });
    const bookingContract = normalizeBookingContract({ masterServiceId: 'fixture-master', subServiceIds: ['fixture-service'], shareAmountMinor: 250000 });
    const operation = { _id: 'fixture-op-key', state: 'CONFIRMED', operationId: 'fixture-operation', tenantKey: 'fixture', actorClientId: 'fixture-actor',
      clientSubscriptionId: 'fixture-sub', bookingId: 'fixture-booking', upstreamBookingId: 'fixture-booking', exerciseId: 'fixture-exercise',
      category: 'open_game', confirmedAt: '2030-11-12T10:00:00Z', lk1: { createPayload: c,
        target: { category: 'GAME', eventId: 'fixture-exercise', roomId: c.roomId, stationId: 'fixture-studio', durationMinutes: 60, startsAt: c.timeFrom },
        decision: { benefit: { finalPriceMinor: 0 }, subscriptionVisitCount: 1 }, publication: { version: 1, state: 'PENDING',
          intent, intentJson: JSON.stringify(intent), actorPhone: '79990000000', actorClientId: 'fixture-actor', tenantKey: 'fixture',
          operationId: 'fixture-operation', createPayloadJson: JSON.stringify(c), bookingContract, bookingContractJson: JSON.stringify(bookingContract) } } };
    await operations.insertOne(operation);
    const transaction = async execute => {
      const session = client.startSession();
      try { return await session.withTransaction(() => execute(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); }
      finally { await session.endSession(); }
    };
    await assert.rejects(runPublicationBatch(db, { apply: true }), /TRANSACTION_REQUIRED/);
    await Promise.all(Array.from({ length: 8 }, () => runPublicationBatch(db, { apply: true, tenantKey: 'fixture', withTransaction: transaction })));
    assert.equal(await games.countDocuments({}), 1);
    assert.equal((await operations.findOne({ _id: operation._id })).lk1.publication.state, 'PUBLISHED');
    const first = await games.findOne({});
    assert.equal(first.organizer.id, operation.actorClientId); assert.equal(first.settings.isPrivate, true);
    // Roll back both collections on a crash after the publication body, before commit.
    await games.deleteMany({}); await operations.replaceOne({ _id: operation._id }, operation);
    await assert.rejects(transaction(async session => {
      await publishConfirmedOperation({ operations, games, operation, apply: true, session });
      throw new Error('fixture-crash-before-commit');
    }), /fixture-crash/);
    assert.equal(await games.countDocuments({}), 0);
    assert.equal((await operations.findOne({ _id: operation._id })).lk1.publication.state, 'PENDING');
    await runPublicationBatch(db, { apply: true, tenantKey: 'fixture', withTransaction: transaction });
    assert.equal(await games.countDocuments({}), 1);
    // A released operation is not resurrected by a stale worker observation.
    await games.deleteMany({}); await operations.replaceOne({ _id: operation._id }, { ...operation, state: 'RELEASED' });
    await assert.rejects(transaction(session => publishConfirmedOperation({ operations, games, operation, apply: true, session })), /OPERATION_CHANGED/);
    assert.equal(await games.countDocuments({}), 0);
  } finally { await db.dropDatabase(); await client.close(); }
});

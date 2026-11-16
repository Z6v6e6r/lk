import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { initializeCupPlayerLevel } from '../lib/cupPlayerLevel.mjs';
import { prepareFprStarts } from '../lib/fprStartBootstrap.mjs';
const uri = process.env.FPR_LEVEL_TEST_MONGO_URI;
const options = { skip: uri ? false : 'Requires isolated loopback replica set', timeout: 60000 };
async function fixture(run) {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//);
  const client = new MongoClient(uri), name = 'test_cup_level_' + crypto.randomBytes(8).toString('hex'), db = client.db(name);
  try {
    await client.connect();
    for (const collection of ['player_rating_state', 'player_ratings']) {
      await db.collection(collection).createIndex({ clientId: 1 }, { unique: true });
      await db.collection(collection).createIndex({ playerKey: 1 }, { unique: true });
    }
    await db.collection('rating_events').createIndex({ idempotencyKey: 1 }, { unique: true });
    await run(db, client);
  } finally { assert.match(name, /^test_cup_level_[a-f0-9]{16}$/); await db.dropDatabase(); await client.close(); }
}
const input = { clientId: 'synthetic', name: 'Synthetic Player', ratingNumeric: 3.12345 };
test('competing first assignments commit one baseline, never a default or provider task', options, async () => fixture(async (db, client) => {
  const results = await Promise.allSettled([initializeCupPlayerLevel(db, client, input), initializeCupPlayerLevel(db, client, { ...input, ratingNumeric: 4 })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await db.collection('rating_events').countDocuments(), 1);
  const current = await db.collection('player_rating_state').findOne({ clientId: input.clientId });
  assert.ok([3.12345, 4].includes(current.ratingNumeric));
  const repeated = await initializeCupPlayerLevel(db, client, { ...input, ratingNumeric: current.ratingNumeric });
  assert.equal(repeated.ratingNumeric, current.ratingNumeric);
  assert.equal(await db.collection('rating_projection_outbox').countDocuments(), 0);
}));
test('FPR starts are read-only, retain exact precision and refuse unrated or orphaned identities', options, async () => fixture(async (db, client) => {
  await initializeCupPlayerLevel(db, client, input);
  const before = await db.collection('player_rating_state').find({}).toArray(); let providerCalls = 0;
  const provider = async () => { providerCalls++; throw Error('unexpected provider read'); };
  const result = await prepareFprStarts(db, client, ['synthetic'], 'host', provider);
  assert.equal(result.states[0].ratingNumeric, 3.12345); assert.deepEqual(result.initialized, []);
  await assert.rejects(prepareFprStarts(db, client, ['synthetic', 'new-player'], 'host', provider), /FPR_START_LEVEL_REQUIRED/);
  await db.collection('player_ratings').insertOne({ clientId: 'legacy', playerKey: 'client:legacy', ratingNumeric: 6 });
  await assert.rejects(prepareFprStarts(db, client, ['legacy'], 'host', provider), /FPR_START_INVALID_CANONICAL/);
  assert.deepEqual(await db.collection('player_rating_state').find({}).toArray(), before); assert.equal(providerCalls, 0);
}));
test('partial first assignment rolls back state and immutable event together', options, async () => fixture(async (db, client) => {
  const broken = { collection(name) { const collection = db.collection(name); if (name !== 'player_ratings') return collection;
    return new Proxy(collection, { get(target, key) { if (key === 'insertOne') return async () => { throw Error('synthetic transactional failure'); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } }); } };
  await assert.rejects(initializeCupPlayerLevel(broken, client, input), /synthetic transactional failure/);
  assert.equal(await db.collection('rating_events').countDocuments(), 0); assert.equal(await db.collection('player_rating_state').countDocuments(), 0);
}));
test('phone-key-only orphan history cannot acquire a second baseline', options, async () => fixture(async (db, client) => {
  await db.collection('rating_events').insertOne({ id: 'old', idempotencyKey: 'old', player: { key: 'phone:70000000001' } });
  await assert.rejects(initializeCupPlayerLevel(db, client, { ...input, phone: '70000000001' }), /LEVEL_IDENTITY_CONFLICT/);
  assert.equal(await db.collection('player_rating_state').countDocuments(), 0); assert.equal(await db.collection('rating_events').countDocuments(), 1);
}));

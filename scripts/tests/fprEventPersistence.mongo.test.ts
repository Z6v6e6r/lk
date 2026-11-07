import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { buildFprNodeFunction } from '../nodered_fpr6x25.mjs';
import { createFprState, fprProjection } from '../../src/components/tournaments/fpr6x25.ts';
const uri = process.env.FPR_EVENT_TEST_MONGO_URI;
const legacy = fs.readFileSync('scripts/nodered_games_nodes/fn_tournament_prepare.js', 'utf8');
// The installed monthly wrapper uses the args-envelope/$replaceWith shape.
// Reproduce that public shape without checking in a production flow snapshot.
const monthly = legacy.replace('return [msg, null];', () => `msg._tournamentGuardedUpsert = true;
msg.payload = [msg.query, [{ $replaceWith: { $cond: [ { $eq: ["$params.finished", true] }, "$$ROOT", { $mergeObjects: ["$$ROOT", { $literal: msg.payload.$set }, { createdAt: { $ifNull: ["$createdAt", { $literal: msg.payload.$setOnInsert.createdAt }] } }] } ] } }]];
return [msg, null];`);
const prepare = new Function('msg', buildFprNodeFunction(monthly, 'prepare'));
const ack = new Function('msg', buildFprNodeFunction(fs.readFileSync('scripts/nodered_games_nodes/fn_tournament_save_ack.js', 'utf8'), 'create_ack'));
function fpr(id: string, source = id) {
  const now = new Date(Date.now() - 1000).toISOString();
  const state = createFprState({ tournamentId: id, players: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `Synthetic ${i}`, level: 3, leaguePlace: i + 1, leaguePoints: i })), courts: ['Synthetic court'], leagueSource: 'Synthetic', now, endsAt: new Date(Date.now() + 3600000).toISOString(), reserveAllowed: true,
    communityRating: { policy: 'community-tournament-v1', communityId: 'synthetic', communityName: 'Synthetic', period: 'all', sourceExerciseId: source, snapshotUpdatedAt: null, publicationId: null } });
  return { tournamentId: id, tournamentType: 'fpr_6x25', organizer: { id: 'synthetic' }, participants: state.players, createdAt: now, ...fprProjection(state, { sourceExerciseId: source }) };
}

test('real Mongo event persistence: retry, generic/FPR race, legacy alias and overwrite protection', { skip: uri ? false : 'Set FPR_EVENT_TEST_MONGO_URI to isolated local Mongo', timeout: 60000 }, async () => {
  assert.match(uri!, /^mongodb:\/\/127\.0\.0\.1:/, 'test must use isolated loopback Mongo');
  const client = new MongoClient(uri!);
  const db = client.db(`test_fpr_event_${crypto.randomUUID().replaceAll('-', '')}`);
  try {
    await client.connect();
    const coll = db.collection('tournaments');
    // Only _id is unique, matching the production prerequisite.
    const run = async (body: Record<string, unknown>) => {
      const [msg, error] = prepare({ payload: structuredClone(body) });
      assert.equal(error, null);
      const prepared = msg;
      const [filter, update] = Array.isArray(prepared.payload) ? prepared.payload : [prepared.query, prepared.payload];
      const options = { upsert: true };
      try {
        prepared.payload = await coll.updateOne(filter, update, options);
        return ack(prepared);
      } catch (error) {
        assert.equal((error as { code?: number }).code, 11000, String(error));
        return { statusCode: 409 };
      }
    };
    const doc = fpr('source-one');
    assert.equal((await run(doc)).statusCode, 200);
    assert.equal((await run(doc)).statusCode, 409);
    assert.equal(await coll.countDocuments({ tournamentId: 'source-one' }), 1);
    const stored = await coll.findOne({ tournamentId: 'source-one' });
    assert.equal(stored?._id, 'tournament:source-one');
    assert.equal((await run({ tournamentId: 'source-one', tournamentType: 'mexicano', params: { finished: false }, participants: [] })).statusCode, 409);
    assert.deepEqual(await coll.findOne({ tournamentId: 'source-one' }), stored);

    // Ordinary existing events and finalized events are never replaced by FPR.
    await run({ tournamentId: 'ordinary', tournamentType: 'americano', params: { finished: true }, participants: [] });
    const ordinary = await coll.findOne({ tournamentId: 'ordinary' });
    assert.equal((await run(fpr('ordinary'))).statusCode, 409);
    assert.deepEqual(await coll.findOne({ tournamentId: 'ordinary' }), ordinary);
    assert.equal((await run({ tournamentId: 'ordinary', tournamentType: 'mexicano', participants: [] })).statusCode, 409);

    // Existing fpr-ID remains the only physical record; source create resumes it.
    const old = fpr('fpr-11111111-2222-4333-8444-555555555555', 'legacy-source');
    await coll.insertOne({ ...old, _id: 'legacy-fpr-document' } as never);
    assert.equal((await run(fpr('legacy-source'))).statusCode, 409);
    assert.equal((await run({ tournamentId: 'legacy-source', tournamentType: 'americano', participants: [] })).statusCode, 409);
    assert.equal(await coll.countDocuments({ $or: [{ tournamentId: 'legacy-source' }, { 'params.sourceExerciseId': 'legacy-source' }] }), 1);

    const cached = fpr('fpr-22222222-2222-4333-8444-555555555555', 'source-one');
    assert.equal((await run(cached)).statusCode, 409);
    assert.equal(await coll.countDocuments({ 'params.sourceExerciseId': 'source-one' }), 1);

    for (let i = 0; i < 15; i++) {
      const id = `race-${i}`;
      const oldClient = fpr('fpr-' + crypto.randomUUID(), id);
      const replies = await Promise.all([run(fpr(id)), run(oldClient), run({ tournamentId: id, tournamentType: 'mexicano', participants: [] }), run(fpr(id))]);
      assert.equal(await coll.countDocuments({ $or: [{ tournamentId: id }, { 'params.sourceExerciseId': id }] }), 1);
      const winner = await coll.findOne({ _id: `tournament:${id}` } as never);
      assert.equal(winner?._id, `tournament:${id}`);
      assert.ok(replies.some(r => r.statusCode === 200));
    }
  } finally { await db.dropDatabase(); await client.close(); }
});

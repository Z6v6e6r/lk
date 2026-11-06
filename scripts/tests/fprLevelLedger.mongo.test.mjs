import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { ratingFixture } from './helpers/fprRatingFixture.ts';
import { fprProjection, applyFprCommand } from '../../src/components/tournaments/fpr6x25.ts';
import { loadFprLevelContext, buildFprPlayerPlan, applyFprPlayerPlan, processFprProjectionOutbox, processFprLevelLedger, projectFprLevelResults, fprLevelHash } from '../lib/fprLevelLedger.mjs';
import { readFprLevelIdentityHistory } from '../lib/fprLevelIdentity.mjs';
import { loadIdentityEvents } from '../game_result_rating_worker.mjs';
import { replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { loadEventsForIdentity, projectIdentityState, processTournamentLedger } from '../rating_worker.mjs';
const uri = process.env.FPR_LEVEL_TEST_MONGO_URI;
const now = '2026-11-05T10:00:00.000Z';
const config = { enabled: true, unratedStartLevel: 1 };

test('isolated replica-set: atomic apply, retry, CAS drift, rollback, later game and fresh provider frontier',
  { skip: uri ? false : 'Run scripts/run_fpr_level_mongo_tests.mjs', timeout: 60000 }, async () => {
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//);
    const client = new MongoClient(uri);
    const dbName = `test_fpr_level_${crypto.randomBytes(8).toString('hex')}`;
    const db = client.db(dbName);
    const originalFetch = globalThis.fetch;
    try {
      await client.connect();
      await db.collection('player_rating_state').createIndex({ playerKey: 1 }, { unique: true });
      await db.collection('rating_events').createIndex({ idempotencyKey: 1 }, { unique: true });
      const state = ratingFixture(8, 7);
      const document = { _id: 'synthetic', tournamentId: state.tournamentId, tournamentType: 'fpr_6x25',
        participants: state.players, updatedAt: now, ...fprProjection(state, { sourceExerciseId: 'synthetic-source' }) };
      await db.collection('tournaments').insertOne(document);
      const initial = { _id: 'initial', id: 'initial', idempotencyKey: 'initial', schemaVersion: 1, eventType: 'RATING_INITIAL_IMPORTED',
        occurredAt: '2026-11-01T09:00:00Z', createdAt: '2026-11-01T09:00:00Z',
        player: { key: 'client:p0', clientId: 'p0', phoneNorm: null, name: 'Synthetic' }, actor: {}, source: { domain: 'IMPORT' },
        change: { before: null, delta: null, after: 2, gradeBefore: null, gradeAfter: 'D' }, formula: null, projectionIntent: { viva: 'NONE' } };
      const game = { ...initial, _id: 'game', id: 'game', idempotencyKey: 'game', eventType: 'GAME_RESULT_SUBMITTED_APPLIED',
        occurredAt: '2026-11-02T09:00:00Z', createdAt: '2026-11-02T09:00:00Z', source: { domain: 'GAME_RESULT', sourceId: 'game-source' },
        change: { before: 2, delta: 0.03, after: 2.03, gradeBefore: 'D', gradeAfter: 'D' } };
      await db.collection('rating_events').insertMany([initial, game]);
      const old = { _id: 'canonical', playerKey: 'client:p0', clientId: 'p0', name: 'Synthetic', phoneNorm: null,
        ratingNumeric: 2.03, rating: 'D', lastEventId: 'game', updatedAt: '2026-11-02T09:00:00Z', identityAliases: { clientIds: ['p0'], phoneNorms: [] } };
      await db.collection('player_rating_state').insertOne(old);
      await db.collection('player_ratings').insertOne({ ...old, _id: 'compatible' });
      let context = await loadFprLevelContext(db, config);
      const beforeSource = fprLevelHash(await db.collection('tournaments').findOne({ _id: document._id }));
      const dry = await buildFprPlayerPlan(db, 'p0', context, now);
      assert.equal(dry.events.filter(e => e.source.domain === 'TOURNAMENT').length, 1);
      const result = await applyFprPlayerPlan(db, client, 'p0', context, now, dry.fingerprint);
      assert.equal(result.events, dry.events.length);
      const after = await db.collection('player_rating_state').findOne({ _id: old._id });
      const expected = context.ratings.get('synthetic-source').standings.find(p => p.id === 'p0').ratingAfter + 0.03;
      assert.equal(after.ratingNumeric, Number(expected.toFixed(5)), 'later game is preserved');
      const fencedSource = await db.collection('tournaments').findOne({ _id: document._id });
      assert.equal(fencedSource.fprLevelLedgerFence.policy, 'fpr-ordinary-level-v1');
      delete fencedSource.fprLevelLedgerFence;
      assert.equal(beforeSource, fprLevelHash(fencedSource));
      assert.equal(await db.collection('rating_projection_outbox').countDocuments({ fprProjection: true }), 1);
      assert.equal((await applyFprPlayerPlan(db, client, 'p0', context, now)).events, 0);
      assert.equal(await db.collection('rating_projection_outbox').countDocuments({ fprProjection: true }), 1);

      const settledContext = { ...context, ratings: new Map([...context.ratings].map(([id, result]) =>
        [id, { ...result, standings: result.standings.filter(row => row.id === 'p0') }])) };
      const settledDryRun = await processFprLevelLedger(db, client, { context: settledContext, config, nowIso: now, dryRun: true });
      assert.equal(settledDryRun.players, 1);
      assert.equal(settledDryRun.events, 0);
      assert.equal(settledDryRun.changed, 0, 'an idempotent outer dry-run reports a finite zero');
      assert.equal(settledDryRun.projections, 0);

      // Old phone-only events remain visible to both subsequent ordinary projectors.
      const aliasBaseline = { ...initial, _id: 'alias-base', id: 'alias-base', idempotencyKey: 'alias-base',
        player: { ...initial.player, key: 'phone:70000000001', clientId: null, phoneNorm: '70000000001' } };
      const aliasGame = { ...game, _id: 'alias-game', id: 'alias-game', idempotencyKey: 'alias-game', player: aliasBaseline.player };
      await db.collection('rating_events').insertMany([aliasBaseline, aliasGame]);
      await db.collection('player_rating_state').insertOne({ ...old, _id: 'alias-state', playerKey: 'client:p4', clientId: 'p4',
        phoneNorm: '70000000002', lastEventId: aliasGame.id,
        identityAliases: { clientIds: ['p4'], phoneNorms: ['70000000001', '70000000002'], playerKeys: ['phone:70000000001'] } });
      const aliasPlan = await buildFprPlayerPlan(db, 'p4', context, now);
      await applyFprPlayerPlan(db, client, 'p4', context, now, aliasPlan.fingerprint);
      const identity = { playerKey: 'client:p4', clientId: 'p4', phoneNorm: '70000000002' };
      const projected = await db.collection('player_rating_state').findOne({ clientId: 'p4' });
      for (const reader of [loadEventsForIdentity, loadIdentityEvents]) {
        assert.equal(replayPlayerRatingEvents(await reader(db, identity)).ratingNumeric, projected.ratingNumeric);
      }
      await projectIdentityState(db, identity, now, false);
      assert.deepEqual((await db.collection('player_rating_state').findOne({ clientId: 'p4' })).identityAliases.playerKeys, ['phone:70000000001']);
      const nextGame = { ...game, _id: 'alias-next-game', id: 'alias-next-game', idempotencyKey: 'alias-next-game',
        occurredAt: '2026-11-06T09:00:00Z', createdAt: '2026-11-06T09:00:00Z', player: { ...initial.player, key: 'client:p4', clientId: 'p4' },
        change: { ...game.change, delta: 0.02 } };
      await db.collection('rating_events').insertOne(nextGame);
      for (const reader of [loadEventsForIdentity, loadIdentityEvents]) {
        assert.equal(replayPlayerRatingEvents(await reader(db, identity)).ratingNumeric, Number((projected.ratingNumeric + 0.02).toFixed(5)));
      }
      await db.collection('player_rating_state').insertOne({ playerKey: 'client:conflict', clientId: 'conflict', phoneNorm: '70000000001' });
      await assert.rejects(readFprLevelIdentityHistory(db, 'p4'), /PHONE_IDENTITY_CONFLICT/);
      await db.collection('player_rating_state').deleteOne({ clientId: 'conflict' });
      await db.collection('player_rating_state').insertOne({ playerKey: 'client:conflict', clientId: 'conflict', identityAliases: { playerKeys: ['client:p4'] } });
      await assert.rejects(readFprLevelIdentityHistory(db, 'p4'), /KEY_ALIAS_CONFLICT/);
      await db.collection('player_rating_state').deleteOne({ clientId: 'conflict' });
      // Keep the remaining dispatcher checks scoped to p0.
      await db.collection('rating_projection_outbox').updateMany({ clientId: 'p4' }, { $set: { status: 'SUPERSEDED' } });

      // A stale frozen preview never overwrites a newer canonical update.
      const p1Initial = { ...initial, _id: 'initial-p1', id: 'initial-p1', idempotencyKey: 'initial-p1',
        player: { ...initial.player, clientId: 'p1', key: 'client:p1' }, change: { ...initial.change, after: 2.1 } };
      await db.collection('rating_events').insertOne(p1Initial);
      await db.collection('player_rating_state').insertOne({ playerKey: 'client:p1', clientId: 'p1', ratingNumeric: 2.1, rating: 'D', lastEventId: 'initial-p1' });
      const p1 = await buildFprPlayerPlan(db, 'p1', context, now);
      await db.collection('rating_events').insertOne({ ...p1Initial, _id: 'manual', id: 'manual', idempotencyKey: 'manual',
        occurredAt: now, createdAt: now, change: { ...initial.change, after: 3 } });
      await db.collection('player_rating_state').updateOne({ clientId: 'p1' }, { $set: { ratingNumeric: 3, rating: 'C', lastEventId: 'manual' } });
      await assert.rejects(applyFprPlayerPlan(db, client, 'p1', context, now, p1.fingerprint), /PREIMAGE_CHANGED/);
      assert.equal(await db.collection('rating_events').countDocuments({ 'player.clientId': 'p1', 'source.fprProtocolId': { $exists: true } }), 0);

      // Fail after inserting events inside a transaction: no events/state/outbox may escape.
      const injected = { collection(name) {
        const collection = db.collection(name);
        if (name !== 'player_ratings') return collection;
        return new Proxy(collection, { get(target, property) {
          if (property === 'insertOne') return async () => { throw new Error('INJECTED_TRANSACTION_FAILURE'); };
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
      } };
      await assert.rejects(applyFprPlayerPlan(injected, client, 'p2', context, now), /INJECTED_TRANSACTION_FAILURE/);
      assert.equal(await db.collection('rating_events').countDocuments({ 'player.clientId': 'p2' }), 0);
      assert.equal(await db.collection('player_rating_state').countDocuments({ clientId: 'p2' }), 0);
      assert.equal(await db.collection('rating_projection_outbox').countDocuments({ clientId: 'p2' }), 0);

      // A legacy empty source is protected from ordinary REOPENED compensation.
      await db.collection('tournaments').insertOne({ tournamentId: 'synthetic-source', tournamentType: 'mexicano', updatedAt: now,
        params: { finished: false }, standings: [{ id: 'p0', name: 'Synthetic', ratingBefore: 2, ratingAfter: 2.1, ratingDelta: 0.1 }] });
      const ordinary = await processTournamentLedger(db, { sinceIso: '2026-10-01T00:00:00Z', notBeforeIso: '2026-10-01T00:00:00Z',
        nowIso: now, dryRun: false, excludedTournamentIds: context.protectedIds });
      assert.equal(ordinary.eventsPlanned, 0);
      assert.equal(ordinary.reopened, 0);

      // Provider delivery reads current canonical state, rather than sending a stale historical payload.
      let sends = 0;
      const latest = Number((after.ratingNumeric + 0.02).toFixed(5));
      await db.collection('player_rating_state').updateOne({ _id: old._id }, { $set: { ratingNumeric: latest, lastEventId: 'new-game' } });
      globalThis.fetch = async () => { sends++; throw new Error('Must not send stale payload'); };
      assert.equal((await processFprProjectionOutbox(db, 'http://127.0.0.1/synthetic', now, false)).superseded, 1);
      assert.equal(sends, 0);
      for (const ack of [{ ok: false }, { ok: true, projectionStatus: 'PENDING' },
        { ok: true, projectionStatus: 'SYNCED', clientId: 'wrong', levelNumeric: latest.toFixed(5) }]) {
        globalThis.fetch = async () => new Response(JSON.stringify(ack), { status: 200 });
        assert.equal((await processFprProjectionOutbox(db, 'http://127.0.0.1/synthetic', now, false)).synced, 0);
        await db.collection('rating_projection_outbox').updateMany({ fprProjection: true, status: 'FAILED_RETRYABLE' }, { $set: { nextAttemptAt: now } });
      }
      globalThis.fetch = async (_url, options) => {
        const payload = JSON.parse(options.body);
        assert.equal(payload.nextRating, latest);
        assert.equal(payload.levelNumeric, latest.toFixed(5));
        sends++; return new Response(JSON.stringify({ ok: true, projectionStatus: 'SYNCED', clientId: payload.clientId, levelNumeric: payload.levelNumeric }), { status: 200 });
      };
      assert.equal((await processFprProjectionOutbox(db, 'http://127.0.0.1/synthetic', now, false)).synced, 1);
      assert.equal(sends, 1);
      const compatibility = await db.collection('player_ratings').findOne({ clientId: 'p0' });
      assert.equal(compatibility.ratingNumeric, after.ratingNumeric);

      // A live source correction after the snapshot read must conflict with the write fence.
      let raced = false;
      const concurrent = { collection(name) {
        const collection = db.collection(name);
        if (name !== 'tournaments') return collection;
        return new Proxy(collection, { get(target, property) {
          if (property === 'findOne') return async (...args) => {
            const snapshot = await target.findOne(...args);
            if (!raced) {
              raced = true;
              const original = document.params.fpr6x25;
              const match = original.attempts[0].matches[0];
              const corrected = applyFprCommand(original, { id: 'synthetic-concurrent-correction', expectedRevision: original.revision,
                action: 'correct_score', matchId: match.id, score1: 1, score2: 24, confirmed1: true, confirmed2: true, reason: 'synthetic correction' }, now);
              await db.collection('tournaments').updateOne({ _id: document._id }, { $set: { ...fprProjection(corrected, document.params), updatedAt: now } });
            }
            return snapshot;
          };
          const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
      } };
      await assert.rejects(applyFprPlayerPlan(concurrent, client, 'p3', context, now), /SOURCE_CHANGED/);
      assert.equal(await db.collection('rating_events').countDocuments({ 'player.clientId': 'p3' }), 0);
      assert.equal(await db.collection('player_rating_state').countDocuments({ clientId: 'p3' }), 0);
      assert.equal(await db.collection('rating_projection_outbox').countDocuments({ clientId: 'p3' }), 0);
    } finally {
      globalThis.fetch = originalFetch;
      assert.match(dbName, /^test_fpr_level_[a-f0-9]{16}$/);
      await db.dropDatabase();
      await client.close();
    }
  });


test('historical level snapshots need no new award and retain sports, state and provider queues',
  { skip: uri ? false : 'Run scripts/run_fpr_level_mongo_tests.mjs', timeout: 60000 }, async () => {
    const client = new MongoClient(uri);
    const dbName = `test_fpr_level_${crypto.randomBytes(8).toString('hex')}`;
    const db = client.db(dbName);
    try {
      await client.connect();
      const state = ratingFixture(4, 6);
      const document = { _id: 'historical-snapshot', tournamentId: state.tournamentId, tournamentType: 'fpr_6x25',
        participants: state.players, ...fprProjection(state, { sourceExerciseId: 'synthetic-source' }) };
      await db.collection('tournaments').insertOne(document);
      let context = await loadFprLevelContext(db, config);
      await applyFprPlayerPlan(db, client, 'p0', context, now);
      await projectFprLevelResults(db, context, now, false);
      await applyFprPlayerPlan(db, client, 'p1', context, now);
      await processFprLevelLedger(db, client, { context, config, nowIso: now, dryRun: false });
      let stored = await db.collection('tournaments').findOne({ _id: document._id });
      assert.ok(stored.fprLevelResults.rows.every(r => r.status === 'applied'));
      const expectedRows = stored.fprLevelResults.rows;
      const sportsBefore = fprLevelHash({ ...stored, fprLevelLedgerFence: null, fprLevelResults: null });
      const eventsBefore = await db.collection('rating_events').countDocuments();
      const outboxesBefore = await db.collection('rating_projection_outbox').find({}).toArray();
      const statesBefore = await db.collection('player_rating_state').find({}).toArray();
      await db.collection('tournaments').updateOne({ _id: document._id }, { $unset: { fprLevelResults: '' } });
      context = await loadFprLevelContext(db, config);
      const backfill = await processFprLevelLedger(db, client, { context, config, nowIso: now, dryRun: false });
      assert.equal(backfill.events, 0); assert.equal(backfill.changed, 0); assert.equal(backfill.projections, 0);
      assert.equal(backfill.resultsProjection.updated, 1);
      stored = await db.collection('tournaments').findOne({ _id: document._id });
      assert.deepEqual(stored.fprLevelResults.rows, expectedRows);
      assert.equal(fprLevelHash({ ...stored, fprLevelLedgerFence: null, fprLevelResults: null }), sportsBefore);
      assert.equal(await db.collection('rating_events').countDocuments(), eventsBefore);
      assert.deepEqual(await db.collection('rating_projection_outbox').find({}).toArray(), outboxesBefore);
      assert.deepEqual(await db.collection('player_rating_state').find({}).toArray(), statesBefore);
      const unchanged = await projectFprLevelResults(db, context, '2026-11-05T11:00:00Z', false);
      assert.equal(unchanged.updated, 0, 'even a frozen older context must not rewrite identical rows');

      const award = await db.collection('rating_events').findOne({ 'source.domain': 'TOURNAMENT', 'player.clientId': 'p0' });
      await db.collection('rating_events').updateOne({ _id: award._id }, { $set: { 'source.applyToState': false } });
      context = await loadFprLevelContext(db, config);
      await projectFprLevelResults(db, context, now, false);
      assert.equal((await db.collection('tournaments').findOne({ _id: document._id })).fprLevelResults.rows.find(r => r.id === 'p0').status, 'pending');
      await db.collection('rating_events').updateOne({ _id: award._id }, { $unset: { 'source.applyToState': '' } });
      const duplicate = { ...award, _id: 'duplicate-award', id: 'duplicate-award', idempotencyKey: 'duplicate-award' };
      await db.collection('rating_events').insertOne(duplicate);
      await projectFprLevelResults(db, context, now, false);
      assert.equal((await db.collection('tournaments').findOne({ _id: document._id })).fprLevelResults.rows.find(r => r.id === 'p0').status, 'pending');
      await db.collection('rating_events').deleteOne({ _id: duplicate._id });
      await db.collection('rating_events').updateOne({ _id: award._id }, { $set: { 'source.sourceRevision': 'wrong-revision' } });
      await projectFprLevelResults(db, context, now, false);
      assert.equal((await db.collection('tournaments').findOne({ _id: document._id })).fprLevelResults.rows.find(r => r.id === 'p0').status, 'pending');
      await db.collection('tournaments').insertOne({ _id: 'legacy-source', tournamentId: 'synthetic-source', tournamentType: 'mexicano', params: { finished: false } });
      context = await loadFprLevelContext(db, config);
      await db.collection('tournaments').updateOne({ _id: 'legacy-source' }, { $set: { ratingExclusions: [{ playerId: 'p0', scopes: ['level'], auditId: 'synthetic', reason: 'private', recordedAt: now }] } });
      const skipped = await projectFprLevelResults(db, context, '2026-11-05T12:00:00Z', false);
      assert.equal(skipped.sourceChanged, 1);
    } finally { await db.dropDatabase(); await client.close(); }
  });

test('canonical correction cohort shares one transaction: mid-cohort abort, commit, display and zero retry',
  {skip:uri?false:'Run scripts/run_fpr_level_mongo_tests.mjs',timeout:60000},async()=>{
    const {fprCorrectionSourceHash}=await import('../lib/fprLevelLedger.mjs');
    const client=new MongoClient(uri),db=client.db(`test_fpr_correction_${crypto.randomBytes(8).toString('hex')}`);
    try{
      await client.connect();const state=ratingFixture(8,7);
      const document={_id:'synthetic',tournamentId:state.tournamentId,tournamentType:'fpr_6x25',participants:state.players,
        ...fprProjection(state,{sourceExerciseId:'synthetic-source'})};
      await db.collection('tournaments').insertOne(document);
      let context=await loadFprLevelContext(db,config);
      for(const p of state.players)await applyFprPlayerPlan(db,client,p.id,context,now);
      const backup={};for(const name of ['tournaments','rating_events','player_rating_state','player_ratings','rating_projection_outbox'])
        backup[name]=await db.collection(name).find({}).toArray();
      const correction={version:1,policy:'cup-canonical-start-correction-v1',operationId:'synthetic',previewSha256:'a'.repeat(64),
        sourceSha256:fprCorrectionSourceHash(document),legacySha256:null,rows:state.players.map(p=>({id:p.id,start:p.level+0.5,orderedAfterSourceIds:[]}))};
      for(const abort of [true,false]){
        const session=client.startSession();session.startTransaction();
        try{
          await db.collection('tournaments').updateOne({_id:document._id},{$set:{fprCanonicalStartCorrection:correction}},{session});
          context=await loadFprLevelContext(db,config,session);
          for(const p of state.players){
            await applyFprPlayerPlan(db,client,p.id,context,'2026-11-06T10:00:00Z',null,session);
            if(abort&&p.id===state.players[1].id)throw Error('synthetic failure midway');
          }
          await session.commitTransaction();
        }catch(e){await session.abortTransaction();if(!abort)throw e;}finally{await session.endSession();}
        if(abort)for(const [name,rows]of Object.entries(backup))assert.deepEqual(await db.collection(name).find({}).toArray(),rows);
      }
      context=await loadFprLevelContext(db,config);
      for(const p of state.players)assert.equal((await buildFprPlayerPlan(db,p.id,context,'2026-11-06T11:00:00Z')).events.length,0);
      await projectFprLevelResults(db,context,'2026-11-06T11:00:00Z',false);
      const stored=await db.collection('tournaments').findOne({_id:document._id});
      assert.deepEqual(stored.params.fpr6x25,state);
      assert.ok(stored.fprLevelResults.rows.every(r=>r.status==='applied'&&r.before===state.players.find(p=>p.id===r.id).level+0.5));
      // Non-rating host metadata must not invalidate a durable correction input.
      await db.collection('tournaments').updateOne({_id:document._id},{$set:{updatedAt:'later', 'params.broadcast':{enabled:true}}});
      assert.equal((await loadFprLevelContext(db,config)).ambiguous.length,0);
      // A rating source edit blocks only this source and never re-awards the frozen values.
      await db.collection('tournaments').updateOne({_id:document._id},{$set:{'params.K':0.9}});
      const stale=await loadFprLevelContext(db,config);assert.deepEqual(stale.ambiguous,['synthetic-source']);
      assert.equal((await buildFprPlayerPlan(db,'p0',stale,now)).events.length,0);
    }finally{await db.dropDatabase();await client.close();}
  });

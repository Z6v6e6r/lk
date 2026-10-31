import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { smTransition, smFence, smAdmission, smClaim, smConfirmation } from '../lib/stationMembershipLifetime.mjs';
import { community, admissionBody, confirmationBody, uid, run } from './helpers/stationMembershipOwnerHarness.mjs';
const ci = process.env.GITHUB_ACTIONS === 'true', uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if (ci && uri !== 'mongodb://127.0.0.1:27017') throw Error('STATION_MONGO_REQUIRES_EXISTING_CI_FIXTURE');
if (!ci && uri) throw Error('STATION_MONGO_REFUSES_LOCAL_OR_SHARED_TARGET');
const options = { skip: !ci ? 'Existing CI-owned Mongo8 only; no local provisioning' : false };
async function fixture(t) {
  const { MongoClient } = await import('mongodb');
  const clients = Array.from({ length: 4 }, () => new MongoClient(uri, { serverSelectionTimeoutMS: 3000 }));
  const name = 'r1_station_lifetime_' + crypto.randomUUID().replaceAll('-', '');
  await Promise.all(clients.map(c => c.connect()));
  t.after(async () => { try { await clients[0].db(name).dropDatabase(); } finally { await Promise.all(clients.map(c => c.close())); } });
  const dbs = clients.map(c => c.db(name)); await dbs[0].collection('lk_communities').insertOne(community()); return dbs;
}
async function transition(db, state) {
  const c = await db.collection('lk_communities').findOne({ id: 'station-community' });
  return db.collection('lk_communities').updateOne({ id: c.id, ...smFence(c) }, { $set: { members: [], stationMembershipLifetime: smTransition(c, 'player-a', state) } });
}
test('physical admission first-wins / LEFT race / new registration / old-generation replay / ban', options, async t => {
  const db = await fixture(t), request = admissionBody();
  const results = await Promise.all(db.map(d => run(d, 'admission', request)));
  assert.ok(results.every(r => r.statusCode === 200));
  assert.equal(await db[0].collection('lk_station_membership_admissions').countDocuments(), 1);
  const a = results[0].payload;
  await transition(db[1], 'LEFT');
  assert.equal((await run(db[2], 'confirmation', confirmationBody(a))).payload.reason, 'MEMBERSHIP_EPOCH_CHANGED');
  const b = (await run(db[3], 'admission', admissionBody(2))).payload;
  assert.equal((await run(db[0], 'confirmation', confirmationBody(b))).payload.reason, 'GENERATION_ALREADY_CLAIMED');
  assert.equal((await run(db[1], 'confirmation', confirmationBody(b, 81))).payload.outcome, 'ENROLLED');
  await transition(db[2], 'BANNED');
  assert.equal((await run(db[3], 'admission', admissionBody(3))).payload.admission.reason, 'MEMBERSHIP_BLOCKED');
});
test('physical stale community CAS cannot erase LEFT and admission snapshot cannot refresh after leave', options, async t => {
  const db = await fixture(t), actor = { tenantId: uid(22), canonicalUserId: uid(20), playerId: 'player-a', providerMappingId: uid(23) };
  const c = await db[0].collection('lk_communities').findOne({ id: 'station-community' });
  const a = smAdmission([c], actor, admissionBody()), claim = smClaim(a, { confirmation: { generationId: uid(80), activityId: uid(90) } });
  const mutation = smConfirmation([c], a, claim);
  await transition(db[1], 'LEFT');
  const result = await db[2].collection('lk_communities').updateOne(mutation.filter, mutation.update);
  assert.equal(result.matchedCount, 0);
  const current = await db[3].collection('lk_communities').findOne({ id: c.id });
  assert.equal(current.stationMembershipLifetime.players[0].state, 'LEFT');
  const raced = await run(db[0], 'admission', admissionBody(), { async after({ step }) { if (step === 'admission_select') await transition(db[1], 'LEFT'); } });
  assert.equal((await run(db[2], 'confirmation', confirmationBody(raced.payload))).payload.reason, 'MEMBERSHIP_EPOCH_CHANGED');
});
test('physical claim and community ACK ambiguity, with leave between applied write and readback', options, async t => {
  const db = await fixture(t), a = (await run(db[0], 'admission', admissionBody())).payload;
  const noClaim = await run(db[1], 'confirmation', confirmationBody(a), { before({ step }) { if (step === 'claim_write') return { skip: true, payload: null, error: {} }; } });
  assert.equal(noClaim.statusCode, 503);
  assert.equal(await db[2].collection('lk_station_membership_generation_claims').countDocuments(), 0);
  const noWrite = await run(db[1], 'confirmation', confirmationBody(a), { before({ step }) { if (step === 'community_write') return { skip: true, payload: null, error: {} }; } });
  assert.equal(noWrite.statusCode, 503);
  assert.equal((await db[2].collection('lk_communities').findOne({ id: 'station-community' })).members.length, 0);
  const applied = await run(db[3], 'confirmation', confirmationBody(a), { after({ step, msg }) { if (['claim_write','community_write'].includes(step)) msg.error = {}; } });
  assert.equal(applied.payload.outcome, 'ENROLLED');
  await transition(db[0], 'LEFT');
  const b = (await run(db[1], 'admission', admissionBody(2))).payload;
  const left = await run(db[2], 'confirmation', confirmationBody(b, 81), { async after({ step, msg }) { if (step === 'community_write') { await transition(db[3], 'LEFT'); msg.error = {}; } } });
  assert.equal(left.payload.outcome, 'NOT_ENROLLED');
  assert.equal((await db[0].collection('lk_communities').findOne({ id: 'station-community' })).members.length, 0);
});

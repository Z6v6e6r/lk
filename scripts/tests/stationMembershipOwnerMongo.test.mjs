import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { protectStationCreate } from '../lib/stationMembershipCreateGuard.mjs';
import { stationOwnerIds } from '../patch_nodered_station_membership_owner.mjs';
import { smTransition, smFence, smAdmission, smClaim, smConfirmation } from '../lib/stationMembershipLifetime.mjs';
import { buildStationMembershipMutation, communityPolicyEvent } from '../lib/communityPolicyProjection.mjs';
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
  const dbs = clients.map(c => c.db(name)); const document=community(); delete document._id; await dbs[0].collection('lk_communities').insertOne(document); return dbs;
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
  await run(db[0],'admission',admissionBody());
  const c = await db[0].collection('lk_communities').findOne({ id: 'station-community' });
  const a = smAdmission([c], actor, admissionBody()), claim = smClaim(a, { confirmation: { generationId: uid(80), activityId: uid(90) } });
  const mutation = smConfirmation([c], a, claim);
  await transition(db[1], 'LEFT');
  const result = await db[2].collection('lk_communities').updateOne(mutation.filter, mutation.update);
  assert.equal(result.matchedCount, 0);
  const current = await db[3].collection('lk_communities').findOne({ id: c.id });
  assert.equal(current.stationMembershipLifetime.players[0].state, 'LEFT');
  const raced = await run(db[0], 'admission', admissionBody(2), { async after({ step }) { if (step === 'admission_select') await transition(db[1], 'LEFT'); } });
  assert.equal(raced.statusCode,409);
  assert.equal(raced.payload.code,'STATION_ADMISSION_EPOCH_CHANGED');
});
test('physical legacy scan built before adoption cannot return a player after LEFT with flag disabled', options, async t => {
  const db = await fixture(t), collection = db[0].collection('lk_communities');
  const previous = process.env.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED;
  process.env.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED = 'false';
  try {
    await collection.updateOne({ id: 'station-community' }, { $set: { typeSettingsEffectiveAt: '2026-10-21T08:00:00.000Z' } });
    const before = await collection.findOne({ id: 'station-community' });
    const now = '2026-10-21T09:00:00.000Z';
    const event = communityPolicyEvent('GAME', { id: 'old-game', createdAt: now, booking: { studioId: 'station-a' }, participants: [{ id: 'player-a' }] });
    const mutation = buildStationMembershipMutation(before, event, event.players[0], now);
    assert.ok(mutation);
    await transition(db[1], 'LEFT');
    const result = await db[2].collection('lk_communities').updateOne(mutation.filter, mutation.update);
    assert.equal(result.matchedCount, 0);
    const current = await db[3].collection('lk_communities').findOne({ id: 'station-community' });
    assert.equal(current.members.length, 0);
    assert.equal(current.stationMembershipLifetime.players[0].state, 'LEFT');
  } finally { if (previous === undefined) delete process.env.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED; else process.env.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED = previous; }
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
test('physical actual create pipeline preserves protected identity and keeps unadopted flag-off behavior', options, async t => {
  const db=await fixture(t), collection=db[0].collection('lk_communities');
  const source=fs.readFileSync('scripts/patch_nodered_communities_flow.mjs','utf8'),common=source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const graph=protectStationCreate([{id:'create',type:'function',name:'Build community create docs',outputs:6,wires:[['store'],[],[],[],[],[]],func:common+source.split('const fnCreate = `${commonHelpers}')[1].split('\n`;')[0]},
    {id:'store',type:'mongodb4',collection:'lk_communities',operation:'updateOne',clientNode:'unused-fixture-client'}],stationOwnerIds,'unused-fixture-client');
  for (const [enabled,lifetime,type,protectedRow] of [[true,undefined,'STATION',true],[false,{version:1,revision:1,players:[{playerId:'player-a',epoch:1,state:'LEFT'}]},'FRIENDS',true],[false,null,'STATION',true],[false,undefined,'STATION',false]]) {
    const replacement=community(); delete replacement._id;
    await collection.replaceOne({id:'station-community'},{...replacement,communityType:type,...(lifetime===undefined?{}:{stationMembershipLifetime:lifetime})});
    const before=await collection.findOne({id:'station-community'});
    const [write]=new Function('msg','env',graph[0].func)({payload:{id:'station-community',name:'Synthetic',description:'Synthetic',city:'Synthetic',creator:{id:'player-a'}}},{get:()=>String(enabled)});
    const result=await db[1].collection('lk_communities').updateOne(...write.payload);
    const after=await db[2].collection('lk_communities').findOne({id:'station-community'});
    assert.equal(String(after._id),String(before._id));
    if(protectedRow){assert.equal(result.modifiedCount,0);assert.deepEqual(after,before);}
    else {assert.equal(result.modifiedCount,1);assert.equal(after.members[0].id,'player-a');}
  }
});
test('physical candidate before adoption failure retains epoch and Mongo identity through retry/recreation',options,async t=>{
  const db=await fixture(t),body=admissionBody();
  const failed=await run(db[0],'admission',body,{before({step}){if(step==='adoption_write')return {skip:true,error:{},payload:null};}});
  assert.equal(failed.statusCode,503);
  const candidate=await db[1].collection('lk_station_membership_admissions').findOne({operationId:body.operationId});
  assert.equal(candidate.communityIdentity.type,'objectId');
  assert.equal(candidate.membershipEpoch,0);
  await transition(db[1],'LEFT');
  assert.equal((await run(db[2],'admission',body)).payload.code,'STATION_ADMISSION_EPOCH_CHANGED');
  assert.deepEqual(await db[3].collection('lk_station_membership_admissions').findOne({_id:candidate._id}),candidate);
  const fresh=(await run(db[0],'admission',admissionBody(2))).payload;
  await db[1].collection('lk_communities').deleteOne({id:'station-community'}); // fixture-only simulates forbidden foreign deletion
  const replacement=community(); delete replacement._id;
  await db[1].collection('lk_communities').insertOne({...replacement,stationMembershipLifetime:{version:1,revision:0,players:[]}});
  assert.equal((await run(db[2],'confirmation',confirmationBody(fresh,81))).payload.reason,'STATION_IDENTITY_CHANGED');
});
test('physical TRAINING exact kind binding, replay, LEFT and separate GAME generation claim',options,async t=>{
  const db=await fixture(t),game=(await run(db[0],'admission',admissionBody(1))).payload;
  assert.equal((await run(db[1],'confirmation',confirmationBody(game))).payload.outcome,'ENROLLED');
  await transition(db[2],'LEFT');
  const body=admissionBody(2);body.activity.kind='TRAINING';
  const training=(await run(db[3],'admission',body)).payload,confirmation=confirmationBody(training);
  assert.equal((await run(db[0],'confirmation',confirmation)).statusCode,409);
  assert.equal(await db[1].collection('lk_station_membership_generation_claims').countDocuments(),1);
  confirmation.confirmation.kind='TRAINING_REGISTRATION';
  assert.equal((await run(db[0],'confirmation',confirmation)).payload.outcome,'ENROLLED');
  assert.equal((await run(db[1],'confirmation',confirmation)).payload.outcome,'ALREADY_APPLIED');
  assert.equal(await db[2].collection('lk_station_membership_generation_claims').countDocuments(),2);
  await transition(db[2],'LEFT');
  assert.equal((await run(db[3],'confirmation',confirmation)).payload.reason,'MEMBERSHIP_EPOCH_CHANGED');
});

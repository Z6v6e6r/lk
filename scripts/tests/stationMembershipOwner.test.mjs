import test from 'node:test';
import assert from 'node:assert/strict';
import { smTransition, smFence } from '../lib/stationMembershipLifetime.mjs';
import { admissionBody, confirmationBody, community, memoryDb, run, message, environment, uid } from './helpers/stationMembershipOwnerHarness.mjs';
const trainingBody = op => { const body=admissionBody(op); return {...body,activity:{...body.activity,kind:'TRAINING'}}; };
const trainingConfirmation = (admission,generation) => { const body=confirmationBody(admission,generation); return {...body,confirmation:{...body.confirmation,kind:'TRAINING_REGISTRATION'}}; };
async function transition(db, state) {
  const c = await db.collection('lk_communities').findOne({ id: 'station-community' });
  return db.collection('lk_communities').updateOne({ id: c.id, ...smFence(c) }, { $set: { members: [], stationMembershipLifetime: smTransition(c, 'player-a', state) } });
}
test('private scopes, exact payload and default off; background delivery needs no user token', async () => {
  const body = admissionBody(), db = memoryDb();
  for (const override of [{ scope: 'subscription-runtime.booked-operation.admit' }, { fresh_operation: false }, { caller: 'browser' }, { sub: 'player-a' }]) {
    assert.equal((await run(db, 'admission', body, { message: message('admission', body, override) })).statusCode, override.scope ? 403 : 401);
  }
  const swapped = message('admission', body); swapped.payload.stationId = 'other';
  assert.equal((await run(db, 'admission', body, { message: swapped })).statusCode, 400);
  assert.equal((await run(db, 'admission', body, { env: { ...environment, LK_STATION_MEMBERSHIP_LIFETIME_ENABLED: 'false' } })).statusCode, 503);
  const a = (await run(db, 'admission', body)).payload;
  assert.equal((await run(db, 'confirmation', confirmationBody(a))).payload.outcome, 'ENROLLED');
  assert.equal((await run(db, 'confirmation', confirmationBody(a))).payload.outcome, 'ALREADY_APPLIED');
});
test('negative admission stays fixed after a matching community appears; changed request conflicts', async () => {
  const db = memoryDb([]), body = admissionBody();
  const a = (await run(db, 'admission', body)).payload;
  assert.equal(a.admission.reason, 'STATION_COMMUNITY_MISSING');
  db.tables.get('lk_communities').push(community());
  assert.deepEqual((await run(db, 'admission', body)).payload.admission, a.admission);
  assert.equal((await run(db, 'admission', { ...body, stationId: 'other' })).statusCode, 409);
});
test('expired or cross-audience assertions, unsigned actor changes, and extra client identity are rejected', async () => {
  const body = admissionBody(), db = memoryDb(), now = Math.floor(Date.now() / 1000);
  for (const override of [{ aud: 'booked-operation' }, { iat: now - 100, nbf: now - 100, exp: now - 10 }, { sid: undefined }]) {
    assert.equal((await run(db, 'admission', body, { message: message('admission', body, override) })).statusCode, 401);
  }
  const tampered = message('admission', body), parts = tampered.req.headers['x-station-membership-delegation'].split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); claims.provider_client_id = 'another-player';
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
  tampered.req.headers['x-station-membership-delegation'] = parts.join('.');
  assert.equal((await run(db, 'admission', body, { message: tampered })).statusCode, 401);
  assert.equal((await run(db, 'admission', { ...body, playerId: 'client-choice' })).statusCode, 400);
  assert.equal(db.tables.get('lk_station_membership_admissions'), undefined);
});
test('ambiguous station and missing admission fail closed without synthetic enrollment', async () => {
  const db = memoryDb([community(), { ...community(), id: 'second-community' }]);
  const a = (await run(db, 'admission', admissionBody())).payload;
  assert.equal(a.admission.reason, 'STATION_COMMUNITY_AMBIGUOUS');
  assert.equal(a.admission.communityId, null); assert.equal(a.admission.membershipEpoch, null);
  db.tables.get('lk_communities').pop();
  assert.equal((await run(db, 'confirmation', confirmationBody(a))).payload.reason, 'STATION_COMMUNITY_AMBIGUOUS');
  assert.equal((await run(memoryDb(), 'confirmation', confirmationBody(a))).payload.reason, 'ADMISSION_MISSING');
});
test('LEFT blocks old facts; new operation and generation returns, admin removal and BAN prohibit return', async () => {
  const db = memoryDb(), a = (await run(db, 'admission', admissionBody())).payload;
  await transition(db, 'LEFT');
  assert.equal((await run(db, 'confirmation', confirmationBody(a))).payload.reason, 'MEMBERSHIP_EPOCH_CHANGED');
  const b = (await run(db, 'admission', admissionBody(2))).payload;
  assert.equal((await run(db, 'confirmation', confirmationBody(b))).payload.reason, 'GENERATION_ALREADY_CLAIMED');
  assert.equal((await run(db, 'confirmation', confirmationBody(b, 81))).payload.outcome, 'ENROLLED');
  await transition(db, 'REMOVED');
  assert.equal((await run(db, 'admission', admissionBody(3))).payload.admission.reason, 'MEMBERSHIP_BLOCKED');
  await transition(db, 'BANNED');
  assert.equal((await run(db, 'confirmation', confirmationBody(b, 81))).payload.reason, 'MEMBERSHIP_EPOCH_CHANGED');
});
test('claim ACK loss recovers; a claim alone is never membership success', async () => {
  const db = memoryDb(), a = (await run(db, 'admission', admissionBody())).payload;
  const claimNotWritten = await run(db, 'confirmation', confirmationBody(a), { before({ step }) { if (step === 'claim_write') return { skip: true, error: {}, payload: null }; } });
  assert.equal(claimNotWritten.statusCode, 503);
  assert.equal(db.tables.get('lk_communities')[0].members.length, 0);
  const result = await run(db, 'confirmation', confirmationBody(a), { after({ step, msg }) { if (step === 'claim_write') msg.error = { message: 'lost ack' }; } });
  assert.equal(result.payload.outcome, 'ENROLLED');
  const db2 = memoryDb(), a2 = (await run(db2, 'admission', admissionBody())).payload;
  const noWrite = await run(db2, 'confirmation', confirmationBody(a2), { before({ step }) { if (step === 'community_write') return { skip: true, error: {}, payload: null }; } });
  assert.equal(noWrite.statusCode, 503); assert.equal(db2.tables.get('lk_communities')[0].members.length, 0);
  assert.equal((await run(db2, 'confirmation', confirmationBody(a2))).payload.outcome, 'ENROLLED');
});
test('community ACK loss readback and leave between write/readback are honest', async () => {
  const db = memoryDb(), a = (await run(db, 'admission', admissionBody())).payload;
  assert.equal((await run(db, 'confirmation', confirmationBody(a), { after({ step, msg }) { if (step === 'community_write') msg.error = {}; } })).payload.outcome, 'ENROLLED');
  const db2 = memoryDb(), a2 = (await run(db2, 'admission', admissionBody())).payload;
  const result = await run(db2, 'confirmation', confirmationBody(a2), { async after({ step, msg, db }) { if (step === 'community_write') { await transition(db, 'LEFT'); msg.error = {}; } } });
  assert.equal(result.payload.outcome, 'NOT_ENROLLED'); assert.equal(result.payload.reason, 'MEMBERSHIP_EPOCH_CHANGED');
});
test('bounded CAS retries do not overwrite a concurrent leave', async () => {
  const db = memoryDb(), a = (await run(db, 'admission', admissionBody())).payload;
  let changed = false;
  const result = await run(db, 'confirmation', confirmationBody(a), { async before({ step, db }) { if (step === 'community_write' && !changed) { changed = true; await transition(db, 'LEFT'); } } });
  assert.equal(result.payload.reason, 'MEMBERSHIP_EPOCH_CHANGED');
});
test('immutable candidate survives failure before adoption; retry cannot recapture epoch after LEFT', async()=>{
  const db=memoryDb(),body=admissionBody();
  const failed=await run(db,'admission',body,{before({step}){if(step==='adoption_write')return {skip:true,error:{},payload:null};}});
  assert.equal(failed.statusCode,503);
  const candidate=structuredClone(db.tables.get('lk_station_membership_admissions')[0]);
  assert.equal(candidate.membershipEpoch,0);
  assert.equal((await run(db,'confirmation',confirmationBody({operationId:candidate.operationId,admission:candidate}))).payload.reason,'ADOPTION_BARRIER_MISSING');
  await transition(db,'LEFT');
  const retry=await run(db,'admission',body);
  assert.equal(retry.statusCode,409);assert.equal(retry.payload.code,'STATION_ADMISSION_EPOCH_CHANGED');
  assert.deepEqual(db.tables.get('lk_station_membership_admissions'),[candidate]);
  const fresh=(await run(db,'admission',admissionBody(2))).payload;
  assert.equal((await run(db,'confirmation',confirmationBody(fresh,81))).payload.outcome,'ENROLLED');
});
test('adoption ACK loss is read back; deletion/recreation never reuses old admission identity',async()=>{
  const db=memoryDb();
  const a=(await run(db,'admission',admissionBody(),{after({step,msg}){if(step==='adoption_write')msg.error={};}})).payload;
  assert.equal(a.admission.outcome,'ADMITTED');
  assert.equal(db.tables.get('lk_communities')[0].stationMembershipLifetime.revision,0);
  db.tables.set('lk_communities',[{...community(),_id:'replacement-community-object',stationMembershipLifetime:{version:1,revision:0,players:[]}}]);
  assert.equal((await run(db,'admission',admissionBody())).payload.code,'STATION_ADMISSION_IDENTITY_CHANGED');
  assert.equal((await run(db,'confirmation',confirmationBody(a))).payload.reason,'STATION_IDENTITY_CHANGED');
});
test('TRAINING confirmation binds immutable activity kind and id before any generation claim',async()=>{
  const db=memoryDb(),body=trainingBody(1),a=(await run(db,'admission',body)).payload;
  assert.equal(a.admission.outcome,'ADMITTED');
  const correct=trainingConfirmation(a);
  for(const confirmation of [{...correct.confirmation,kind:'GAME_PARTICIPATION'},{...correct.confirmation,activityId:uid(91)}]){
    const denied=await run(db,'confirmation',{...correct,confirmation});
    assert.equal(denied.statusCode,409);assert.equal(denied.payload.code,'STATION_CONFIRMATION_BINDING_CONFLICT');
    assert.equal(db.tables.has('lk_station_membership_generation_claims'),false);
  }
  assert.equal((await run(db,'admission',admissionBody(1))).statusCode,409);
  assert.equal((await run(db,'confirmation',correct)).payload.outcome,'ENROLLED');
  assert.equal((await run(db,'confirmation',correct)).payload.outcome,'ALREADY_APPLIED');
  const cancel=await run(db,'confirmation',{...correct,confirmation:{...correct.confirmation,kind:'TRAINING_CANCELLED'}});
  assert.equal(cancel.statusCode,400);assert.equal(db.tables.get('lk_communities')[0].members.length,1);
});
test('TRAINING retains LEFT/replay/new-registration and admin-block lifetime rules',async()=>{
  const db=memoryDb(),a=(await run(db,'admission',trainingBody(1))).payload;
  assert.equal((await run(db,'confirmation',trainingConfirmation(a))).payload.outcome,'ENROLLED');
  await transition(db,'LEFT');
  assert.equal((await run(db,'confirmation',trainingConfirmation(a))).payload.reason,'MEMBERSHIP_EPOCH_CHANGED');
  const b=(await run(db,'admission',trainingBody(2))).payload;
  assert.equal((await run(db,'confirmation',trainingConfirmation(b))).payload.reason,'GENERATION_ALREADY_CLAIMED');
  assert.equal((await run(db,'confirmation',trainingConfirmation(b,81))).payload.outcome,'ENROLLED');
  await transition(db,'BANNED');
  assert.equal((await run(db,'admission',trainingBody(3))).payload.admission.reason,'MEMBERSHIP_BLOCKED');
});
test('GAME keys/proofs remain compatible and TRAINING has a separate generation namespace',async()=>{
  const db=memoryDb(),game=(await run(db,'admission',admissionBody(1))).payload;
  const gameBody=confirmationBody(game);
  assert.equal((await run(db,'confirmation',gameBody)).payload.outcome,'ENROLLED');
  const oldClaim=structuredClone(db.tables.get('lk_station_membership_generation_claims')[0]);
  assert.equal(oldClaim._id,'v1:'+uid(22)+':station-community:GAME_PARTICIPATION:'+uid(80));
  assert.equal('kind' in db.tables.get('lk_communities')[0].stationMembershipLifetime.players[0].lastApplied,false);
  await transition(db,'LEFT');
  const training=(await run(db,'admission',trainingBody(2))).payload;
  assert.equal((await run(db,'confirmation',trainingConfirmation(training))).payload.outcome,'ENROLLED');
  const claims=db.tables.get('lk_station_membership_generation_claims');
  assert.equal(claims.length,2);assert.deepEqual(claims[0],oldClaim);
  assert.equal(claims[1]._id,'v1:'+uid(22)+':station-community:TRAINING_REGISTRATION:'+uid(80));
  assert.equal(db.tables.get('lk_communities')[0].stationMembershipLifetime.players[0].lastApplied.kind,'TRAINING_REGISTRATION');
  assert.equal((await run(db,'confirmation',{...gameBody,confirmation:{...gameBody.confirmation,kind:'TRAINING_REGISTRATION'}})).statusCode,409);
});
test('missing-member replay proof compares generation kind without upgrading legacy GAME proof',async()=>{
  const db=memoryDb(),training=(await run(db,'admission',trainingBody(1))).payload;
  await run(db,'confirmation',trainingConfirmation(training));
  db.tables.get('lk_communities')[0].members=[]; // foreign roster loss is not a new confirmation
  assert.equal((await run(db,'confirmation',trainingConfirmation(training))).payload.reason,'APPLIED_MEMBER_MISSING');
  const game=(await run(db,'admission',admissionBody(2))).payload;
  assert.equal((await run(db,'confirmation',confirmationBody(game))).payload.outcome,'ENROLLED');
  assert.equal((await run(db,'confirmation',confirmationBody(game))).payload.outcome,'ALREADY_APPLIED');
});

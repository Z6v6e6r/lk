import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {MongoClient} from 'mongodb';
import {buildFprProjectionOutbox,fprLevelHash} from '../lib/fprLevelLedger.mjs';
import {initializeFprStarts as initializeWithoutViva,initializeFprStartsWithViva,prepareFprStarts} from '../lib/fprStartBootstrap.mjs';
import {parseFprVivaStartLevel} from '../lib/fprStartVivaLevel.mjs';
const uri=process.env.FPR_LEVEL_TEST_MONGO_URI;
const now='2026-11-06T14:00:00.000Z';
const verifiedUnrated=async ids=>new Map(ids.map(id=>[id,parseFprVivaStartLevel({id,customFields:[]},id,now)]));
const initializeFprStarts=(db,client,ids,actorId,at)=>initializeFprStartsWithViva(db,client,ids,actorId,verifiedUnrated,{clock:()=>at});
const baseline=(id,after)=>({_id:'base:'+id,id:'base:'+id,idempotencyKey:'base:'+id,schemaVersion:1,eventType:'RATING_INITIAL_IMPORTED',
 occurredAt:now,createdAt:now,player:{key:'client:'+id,clientId:id,name:'Synthetic'},actor:{},source:{domain:'INITIAL_IMPORT'},
 change:{before:null,after,delta:null},formula:null,projectionIntent:{viva:'NONE'}});
test('atomic initial default1, existing full precision, compatibility import, history recovery, retry and named failures',
 {skip:uri?false:'Requires isolated replica set'},async()=>{
 const client=new MongoClient(uri),db=client.db('test_fpr_start_'+crypto.randomBytes(8).toString('hex'));
 try{await client.connect();for(const collection of ['player_rating_state','player_ratings'])await db.collection(collection).createIndex({clientId:1},{unique:true});
 await db.collection('rating_events').createIndex({idempotencyKey:1},{unique:true});
 const existing={_id:'existing',clientId:'existing',playerKey:'client:existing',ownership:'CUP_CANONICAL',ratingNumeric:4.03664,lastEventId:'unchanged'};
 await db.collection('player_rating_state').insertOne(existing);
 await db.collection('player_ratings').insertOne({_id:'compat',clientId:'import',ratingNumeric:3.12345,name:'Synthetic'});
 await db.collection('rating_events').insertOne(baseline('recover',2.34567));
 const first=await initializeFprStarts(db,client,['existing','unrated','import','recover'],'host',now);
 assert.equal(first.initialized.length,3);assert.deepEqual(first.states.map(s=>s.ratingNumeric),[4.03664,1,3.12345,2.34567]);
 assert.deepEqual(await db.collection('player_rating_state').findOne({_id:'existing'}),existing);
 assert.equal(await db.collection('rating_events').countDocuments(),3);
 assert.equal(await db.collection('rating_projection_outbox').countDocuments({fprProjection:true}),3);
 assert.equal((await initializeFprStarts(db,client,['unrated','import','recover'],'host',now)).initialized.length,0);
 assert.equal(await db.collection('rating_events').countDocuments(),3);
 // A later invalid participant must abort an earlier candidate default.
 await db.collection('player_ratings').insertOne({_id:'invalid',clientId:'invalid',ratingNumeric:'broken'});
 await assert.rejects(initializeFprStarts(db,client,['would-be-default','invalid'],'host',now),e=>e.message==='FPR_START_INVALID_LEVEL'&&e.playerId==='invalid');
 assert.equal(await db.collection('player_rating_state').countDocuments({clientId:'would-be-default'}),0);
 // Orphan delta history must not be hidden by a new baseline.
 await db.collection('rating_events').insertOne({...baseline('orphan',2),_id:'orphan',id:'orphan',idempotencyKey:'orphan',eventType:'GAME_RESULT_SUBMITTED_APPLIED',change:{before:2,after:2.1,delta:.1}});
 await assert.rejects(initializeFprStarts(db,client,['orphan'],'host',now),e=>e.message==='FPR_START_HISTORY_INVALID'&&e.playerId==='orphan');
 assert.equal(await db.collection('player_rating_state').countDocuments({clientId:'orphan'}),0);
 // A grade must not be silently replaced by default1 when numeric is blank/zero.
 await db.collection('player_ratings').insertOne({_id:'letter',clientId:'letter',ratingNumeric:0,rating:'C'});
 await assert.rejects(initializeFprStarts(db,client,['letter'],'host',now),e=>e.message==='FPR_START_INVALID_LEVEL'&&e.playerId==='letter');
 // Explicit recorded old keys recover immutable history rather than seed compatibility.
 await db.collection('player_ratings').insertOne({_id:'old-key',clientId:'old-key',ratingNumeric:4,identityAliases:{playerKeys:['legacy:old-key']}});
 const oldKeyEvent=baseline('old-key',3.22222);oldKeyEvent.player={key:'legacy:old-key',clientId:null,name:'Synthetic'};
 await db.collection('rating_events').insertOne(oldKeyEvent);
 assert.equal((await initializeFprStarts(db,client,['old-key'],'host',now)).states[0].ratingNumeric,3.22222);
 // Foreign immutable client identity must not be merged through a stored phone.
 await db.collection('player_ratings').insertOne({_id:'phone-owner',clientId:'phone-owner',phoneNorm:'test-phone'});
 const foreign=baseline('foreign',3);foreign.player.phoneNorm='test-phone';await db.collection('rating_events').insertOne(foreign);
 await assert.rejects(initializeFprStarts(db,client,['phone-owner'],'host',now),e=>e.message==='FPR_START_IDENTITY_CONFLICT');
 // Fault after earlier writes rolls back the whole roster.
 const target='will-fail-last',eventId='rating_evt:fpr_roster_bootstrap:'+fprLevelHash('client:'+target);
 const collision=buildFprProjectionOutbox({clientId:target,playerKey:'client:'+target,ratingNumeric:1,lastEventId:eventId},now);
 await db.collection('rating_projection_outbox').insertOne({_id:collision._id,marker:'synthetic collision'});
 await assert.rejects(initializeFprStarts(db,client,['partial-first',target],'host',now));
 assert.equal(await db.collection('player_rating_state').countDocuments({clientId:{$in:['partial-first',target]}}),0);
 assert.equal(await db.collection('rating_events').countDocuments({'player.clientId':{$in:['partial-first',target]}}),0);
 // Exact-ID baseline with an unverified phone binding cannot hide phone-only deltas.
 const phoneBase=baseline('ledger-phone',2);phoneBase.player.phoneNorm='uncovered-phone';
 const phoneDelta={...baseline('phone-delta',2.1),eventType:'GAME_RESULT_SUBMITTED_APPLIED',
   player:{key:'phone:uncovered-phone',clientId:null,phoneNorm:'uncovered-phone'},change:{before:2,after:2.1,delta:.1}};
 await db.collection('rating_events').insertMany([phoneBase,phoneDelta]);
 await assert.rejects(initializeFprStarts(db,client,['ledger-phone'],'host',now),e=>e.message==='FPR_START_HISTORY_INVALID');
 await db.collection('player_ratings').insertOne({_id:'secondary',clientId:'secondary',ratingNumeric:'',rating:'3.5'});
 assert.equal((await initializeFprStarts(db,client,['secondary'],'host',now)).states[0].ratingNumeric,3.5);
 // Concurrent requests resolve to one baseline/state; transaction retries are idempotent.
 const other=new MongoClient(uri);await other.connect();try{
  const both=await Promise.all([initializeFprStarts(db,client,['concurrent'],'host',now),initializeFprStarts(other.db(db.databaseName),other,['concurrent'],'host',now)]);
  assert.equal(both.reduce((n,r)=>n+r.initialized.length,0),1);
  assert.equal(await db.collection('rating_events').countDocuments({'player.clientId':'concurrent'}),1);
 }finally{await other.close();}
 // Recorded alias collision must fail the complete roster.
 await db.collection('player_rating_state').insertOne({_id:'alias-owner',clientId:'owner',playerKey:'client:owner',ownership:'CUP_CANONICAL',ratingNumeric:2,lastEventId:'base',identityAliases:{clientIds:['one','two']}});
 await assert.rejects(initializeFprStarts(db,client,['one','two'],'host',now),e=>e.message==='FPR_START_IDENTITY_CONFLICT'&&e.playerId==='two');
 }finally{await db.dropDatabase();await client.close();}
});

test('missing CUP imports verified Viva numeric, defaults only on verified empty fields, and fails whole roster closed',
 {skip:uri?false:'Requires isolated replica set'},async()=>{
 const client=new MongoClient(uri),db=client.db('test_fpr_viva_'+crypto.randomBytes(8).toString('hex'));
 try{
  await client.connect();
  for(const name of ['player_rating_state','player_ratings'])await db.collection(name).createIndex({clientId:1},{unique:true});
  await db.collection('rating_events').createIndex({idempotencyKey:1},{unique:true});
  await assert.rejects(initializeWithoutViva(db,client,['missing'],'host',now),e=>e.message==='FPR_START_VIVA_REQUIRED');
  assert.equal(await db.collection('rating_events').countDocuments(),0);
  let calls=0;
  const reader=async ids=>{
   calls++;assert.deepEqual(ids,['rated','unrated']);
   return new Map(ids.map(id=>[id,parseFprVivaStartLevel({id,customFields:id==='rated'
    ?[{id:'eabfe27b-3f72-4496-9185-1a2ec6e6465e',value:['3.65432']}]:[]},id,now)]));
  };
  const first=await initializeFprStartsWithViva(db,client,['rated','unrated'],'host',reader,{clock:()=>now});
  assert.deepEqual(first.states.map(s=>s.ratingNumeric),[3.65432,1]);assert.equal(calls,1);
  const event=await db.collection('rating_events').findOne({'player.clientId':'rated'});
  assert.equal(event.source.initialSource,'VIVA_NUMERIC');assert.match(event.source.providerEvidence.sha256,/^[a-f0-9]{64}$/);
  await initializeFprStartsWithViva(db,client,['rated','unrated'],'host',()=>{throw Error('must not call Viva')},{clock:()=>now});
  assert.equal(await db.collection('rating_events').countDocuments(),2);
  await db.collection('lk_communities').insertOne({id:'synthetic',members:[{id:'unrelated-legacy-key',clientId:'known-local',levelScore:3.2}]});
  await assert.rejects(initializeFprStartsWithViva(db,client,['first-new','known-local'],'host',verifiedUnrated,{clock:()=>now}),
   e=>e.message==='FPR_START_EXISTING_LEVEL_CONFLICT'&&e.playerId==='known-local');
  assert.equal(await db.collection('player_rating_state').countDocuments({clientId:{$in:['first-new','known-local']}}),0);
  await assert.rejects(initializeFprStartsWithViva(db,client,['provider-failure'],'host',async()=>{throw Error('FPR_START_VIVA_UNAVAILABLE')},{clock:()=>now}));
  assert.equal(await db.collection('rating_events').countDocuments(),2);
  const stale=async ids=>new Map(ids.map(id=>[id,parseFprVivaStartLevel({id,customFields:[]},id,'2026-11-06T13:00:00.000Z')]));
  await assert.rejects(initializeFprStartsWithViva(db,client,['stale'],'host',stale,{clock:()=>now}),e=>e.message==='FPR_START_VIVA_REQUIRED');
  assert.equal(await db.collection('rating_events').countDocuments(),2);
  let checks=0;
  await assert.rejects(initializeWithoutViva(db,client,['expired-during-plan'],'host',now,{
   verifiedVivaLevels:await verifiedUnrated(['expired-during-plan']),
   evidenceClock:()=>++checks===1?now:'2026-11-06T14:01:00.000Z',
  }),e=>e.message==='FPR_START_VIVA_REQUIRED');
  assert.equal(await db.collection('rating_events').countDocuments(),2);
 }finally{await db.dropDatabase();await client.close();}
});


test('canonical roster is read-only without flock or Viva; missing players re-read under the data lock',
 {skip:uri?false:'Requires isolated replica set'},async()=>{
 const client=new MongoClient(uri),db=client.db('test_fpr_nonblocking_'+crypto.randomBytes(8).toString('hex'));
 try{
  await client.connect();
  for(const name of ['player_rating_state','player_ratings']){
   await db.collection(name).createIndex({clientId:1},{unique:true});
   await db.collection(name).createIndex({playerKey:1},{unique:true});
  }
  await db.collection('rating_events').createIndex({idempotencyKey:1},{unique:true});
  const canonical={_id:'client:ready',clientId:'ready',playerKey:'client:ready',ownership:'CUP_CANONICAL',ratingNumeric:3.65432,lastEventId:'base:ready'};
  await db.collection('player_rating_state').insertOne(canonical);
  const noCall=()=>{throw Error('must not acquire writer lock or call Viva');};
  const snapshot=await prepareFprStarts(db,client,['ready'],'host',noCall,{clock:()=>now,withWriteLock:noCall});
  assert.equal(snapshot.states[0].ratingNumeric,3.65432);assert.deepEqual(snapshot.initialized,[]);
  assert.deepEqual(await db.collection('player_rating_state').findOne({_id:canonical._id}),canonical);
  assert.equal(await db.collection('rating_events').countDocuments(),0);
  assert.equal(await db.collection('rating_projection_outbox').countDocuments(),0);
  // Simulate a competing writer winning before we obtain the data lock.
  let locks=0;
  const withWriteLock=async work=>{
   locks++;await initializeFprStarts(db,client,['new'],'other-host',now);return work();
  };
  const mixed=await prepareFprStarts(db,client,['ready','new'],'host',noCall,{clock:()=>now,withWriteLock});
  assert.equal(locks,1);assert.equal(mixed.initialized.length,0);
  assert.equal(await db.collection('rating_events').countDocuments({'player.clientId':'new'}),1);
  await db.collection('player_rating_state').updateOne({_id:canonical._id},{$set:{ownership:'VIVA'}});
  await assert.rejects(prepareFprStarts(db,client,['ready'],'host',noCall,{clock:()=>now,withWriteLock:noCall}),/FPR_START_INVALID_CANONICAL/);
  await db.collection('player_rating_state').updateOne({_id:canonical._id},{$set:{ownership:'CUP_CANONICAL',identityAliases:{clientIds:['ready','alias']}}});
  await assert.rejects(prepareFprStarts(db,client,['ready','alias'],'host',noCall,{clock:()=>now,withWriteLock:noCall}),/FPR_START_IDENTITY_CONFLICT/);
  const mixedNew=await prepareFprStarts(db,client,['ready','brand-new'],'host',verifiedUnrated,{clock:()=>now,withWriteLock:work=>work()});
  assert.equal(mixedNew.initialized.length,1);
  assert.equal(await db.collection('rating_projection_outbox').countDocuments(),2);
  await db.collection('player_ratings').insertOne({_id:'bad',clientId:'bad',ratingNumeric:'invalid'});
  await assert.rejects(prepareFprStarts(db,client,['rollback-new','bad'],'host',verifiedUnrated,{clock:()=>now,withWriteLock:work=>work()}),/FPR_START_INVALID_LEVEL/);
  assert.equal(await db.collection('player_rating_state').countDocuments({clientId:'rollback-new'}),0);
 }finally{await db.dropDatabase();await client.close();}
});

import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {MongoClient} from 'mongodb';
import {buildFprProjectionOutbox,processFprProjectionOutbox} from '../lib/fprLevelLedger.mjs';
import {initializeFprStarts,prepareFprStarts} from '../lib/fprStartBootstrap.mjs';
const uri=process.env.FPR_LEVEL_TEST_MONGO_URI;
const now='2026-11-06T14:00:00.000Z';
const baseline=(id,after)=>({_id:'base:'+id,id:'base:'+id,idempotencyKey:'base:'+id,schemaVersion:1,eventType:'RATING_INITIAL_IMPORTED',
 occurredAt:now,createdAt:now,player:{key:'client:'+id,clientId:id,name:'Synthetic'},actor:{},source:{domain:'INITIAL_IMPORT'},
 change:{before:null,after,delta:null},formula:null,projectionIntent:{viva:'NONE'}});
test('keeps canonical precision and atomically restores existing CUP compatibility or ledger evidence',
 {skip:uri?false:'Requires isolated replica set'},async()=>{
 const client=new MongoClient(uri),db=client.db('test_fpr_start_'+crypto.randomBytes(8).toString('hex'));
 try{await client.connect();for(const collection of ['player_rating_state','player_ratings'])await db.collection(collection).createIndex({clientId:1},{unique:true});
 await db.collection('rating_events').createIndex({idempotencyKey:1},{unique:true});
 const existing={_id:'existing',clientId:'existing',playerKey:'client:existing',ownership:'CUP_CANONICAL',ratingNumeric:4.03664,lastEventId:'unchanged'};
 await db.collection('player_rating_state').insertOne(existing);
 await db.collection('player_ratings').insertOne({_id:'compat',clientId:'import',ratingNumeric:3.12345,name:'Synthetic'});
 await db.collection('rating_events').insertOne(baseline('recover',2.34567));
 const first=await initializeFprStarts(db,client,['existing','import','recover'],'host',now);
 assert.equal(first.initialized.length,2);assert.deepEqual(first.states.map(s=>s.ratingNumeric),[4.03664,3.12345,2.34567]);
 assert.deepEqual(await db.collection('player_rating_state').findOne({_id:'existing'}),existing);
 assert.equal(await db.collection('rating_events').countDocuments(),2);
 assert.equal(await db.collection('rating_projection_outbox').countDocuments({}),0);
 assert.equal((await initializeFprStarts(db,client,['import','recover'],'host',now)).initialized.length,0);
 assert.equal(await db.collection('rating_events').countDocuments(),2);
 // An unrated participant fails the whole roster before any write.
 await db.collection('player_ratings').insertOne({_id:'preceding',clientId:'preceding',ratingNumeric:3});
 await assert.rejects(initializeFprStarts(db,client,['preceding','unrated'],'host',now),
  e=>e.message==='FPR_START_LEVEL_REQUIRED'&&e.playerId==='unrated');
 assert.equal(await db.collection('player_rating_state').countDocuments({clientId:{$in:['preceding','unrated']}}),0);
 assert.equal(await db.collection('rating_events').countDocuments(),2);
 assert.equal(await db.collection('rating_projection_outbox').countDocuments(),0);
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
 // A late unique-index collision rolls the entire roster back.
 await db.collection('player_ratings').insertOne({_id:'colliding-compat',clientId:'will-fail-last',ratingNumeric:3});
 await db.collection('player_rating_state').insertOne({_id:'client:will-fail-last',clientId:'other-owner'});
 await assert.rejects(initializeFprStarts(db,client,['preceding','will-fail-last'],'host',now),/FPR_START_PREIMAGE_CHANGED/);
 assert.equal(await db.collection('player_rating_state').countDocuments({clientId:{$in:['preceding','will-fail-last']}}),0);
 assert.equal(await db.collection('rating_events').countDocuments({'player.clientId':{$in:['preceding','will-fail-last']}}),0);
 // Exact-ID baseline with an unverified phone binding cannot hide phone-only deltas.
 const phoneBase=baseline('ledger-phone',2);phoneBase.player.phoneNorm='uncovered-phone';
 const phoneDelta={...baseline('phone-delta',2.1),eventType:'GAME_RESULT_SUBMITTED_APPLIED',
   player:{key:'phone:uncovered-phone',clientId:null,phoneNorm:'uncovered-phone'},change:{before:2,after:2.1,delta:.1}};
 await db.collection('rating_events').insertMany([phoneBase,phoneDelta]);
 await assert.rejects(initializeFprStarts(db,client,['ledger-phone'],'host',now),e=>e.message==='FPR_START_HISTORY_INVALID');
 await db.collection('player_ratings').insertOne({_id:'secondary',clientId:'secondary',ratingNumeric:'',rating:'3.5'});
 assert.equal((await initializeFprStarts(db,client,['secondary'],'host',now)).states[0].ratingNumeric,3.5);
 // Concurrent requests resolve to one baseline/state; transaction retries are idempotent.
 await db.collection('player_ratings').insertOne({_id:'compat-concurrent',clientId:'concurrent',ratingNumeric:2.4321});
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

test('canonical roster is read-only without flock; recoverable players are rechecked under the data lock',
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
  const snapshot=await prepareFprStarts(db,client,['ready'],'host',{clock:()=>now,withWriteLock:noCall});
  assert.equal(snapshot.states[0].ratingNumeric,3.65432);assert.deepEqual(snapshot.initialized,[]);
  assert.deepEqual(await db.collection('player_rating_state').findOne({_id:canonical._id}),canonical);
  assert.equal(await db.collection('rating_events').countDocuments(),0);
  assert.equal(await db.collection('rating_projection_outbox').countDocuments(),0);
  // Simulate a competing writer winning before we obtain the data lock.
  await db.collection('player_ratings').insertOne({_id:'new-compat',clientId:'new',ratingNumeric:2.4});
  let locks=0;
  const withWriteLock=async work=>{
   locks++;await initializeFprStarts(db,client,['new'],'other-host',now);return work();
  };
  const mixed=await prepareFprStarts(db,client,['ready','new'],'host',{clock:()=>now,withWriteLock});
  assert.equal(locks,1);assert.equal(mixed.initialized.length,0);
  assert.equal(await db.collection('rating_events').countDocuments({'player.clientId':'new'}),1);
  await db.collection('player_rating_state').updateOne({_id:canonical._id},{$set:{ownership:'VIVA'}});
  await assert.rejects(prepareFprStarts(db,client,['ready'],'host',{clock:()=>now,withWriteLock:noCall}),/FPR_START_INVALID_CANONICAL/);
  await db.collection('player_rating_state').updateOne({_id:canonical._id},{$set:{ownership:'CUP_CANONICAL',identityAliases:{clientIds:['ready','alias']}}});
  await assert.rejects(prepareFprStarts(db,client,['ready','alias'],'host',{clock:()=>now,withWriteLock:noCall}),/FPR_START_IDENTITY_CONFLICT/);
  await assert.rejects(prepareFprStarts(db,client,['ready','brand-new'],'host',{clock:()=>now,withWriteLock:work=>work()}),
   e=>e.message==='FPR_START_LEVEL_REQUIRED'&&e.playerId==='brand-new');
  assert.equal(await db.collection('rating_projection_outbox').countDocuments(),0);
  await db.collection('player_ratings').insertOne({_id:'bad',clientId:'bad',ratingNumeric:'invalid'});
  await assert.rejects(prepareFprStarts(db,client,['bad'],'host',{clock:()=>now,withWriteLock:work=>work()}),/FPR_START_INVALID_LEVEL/);
  assert.equal(await db.collection('player_rating_state').countDocuments({clientId:'rollback-new'}),0);
 }finally{await db.dropDatabase();await client.close();}
});


test('retired start projections make no provider call while completed FPR projection still dispatches',
 {skip:uri?false:'Requires isolated replica set'},async()=>{
 const client=new MongoClient(uri),db=client.db('test_fpr_start_projection_'+crypto.randomBytes(8).toString('hex'));
 const originalFetch=globalThis.fetch;
 try{
  await client.connect();
  const rosterBoot={clientId:'old',playerKey:'client:old',ratingNumeric:3.5,lastEventId:'rating_evt:fpr_roster_bootstrap:old'};
  const completed={clientId:'result',playerKey:'client:result',ratingNumeric:2,lastEventId:'fpr:result',
   projectedBy:'fpr-canonical-start-bootstrap-v1'};
  const rows=[rosterBoot,completed].map(state=>buildFprProjectionOutbox(state,now));
  await db.collection('player_rating_state').insertMany([
   {...rosterBoot,ratingNumeric:4.2,lastEventId:'cup:admin-changed-level'},completed,
  ]);
  rows[0].status='SENDING';
  rows[0].projectionLeaseOwner='test-expired';
  rows[0].projectionLeaseUntil=now;
  await db.collection('rating_projection_outbox').insertMany(rows);
  const calls=[];
  globalThis.fetch=async (_url,request)=>{
   calls.push(JSON.parse(request.body).clientId);
   return Response.json({ok:true,projectionStatus:'SYNCED',clientId:'result',levelNumeric:2});
  };
  const result=await processFprProjectionOutbox(db,'https://example.invalid/level',now,false);
  assert.deepEqual(calls,['result']);
  assert.deepEqual(result,{scanned:2,synced:1,superseded:1,failed:0});
  assert.equal(await db.collection('rating_projection_outbox').countDocuments({status:'SUPERSEDED',projectionLeaseOwner:{$exists:false}}),1);
 }finally{globalThis.fetch=originalFetch;await db.dropDatabase();await client.close();}
});

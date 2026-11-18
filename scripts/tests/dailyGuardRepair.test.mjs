import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { moneyFixture } from './fixtures/lk1ReconciledCancellationFixtures.mjs';
import { repairJobKey } from '../lib/lk1CancelledVisitRepair.mjs';
import { planDailyGuardRepair, applyDailyGuardRepair } from '../lib/lk1DailyGuardRepair.mjs';
const instant='2099-11-12T12:00:00Z';
function fixture() {
  const f=moneyFixture(),owner=f.op;
  const target={_id:'lk1-product:["fixture","actor","new-operation"]',operationId:'new-operation',
    tenantKey:owner.tenantKey,actorClientId:owner.actorClientId,clientSubscriptionId:owner.clientSubscriptionId,
    exerciseId:'new-exercise',serviceDate:owner.serviceDate,category:'open_game',state:'FAILED',attempts:0,
    failure:{statusCode:409,rawCode:'LK1_DAILY_VISIT_CHANGED'},lk1:{rule:owner.lk1.rule,
      fingerprint:'new-fingerprint',dailyVisitPolicyVersion:1,target:{eventId:'new-exercise',category:'GAME',startsAt:owner.lk1.target.startsAt},
      decision:{eligible:true,subscriptionVisitCount:1}}};
  const guard={_id:'lk1-daily-visit:'+JSON.stringify([owner.tenantKey,owner.clientSubscriptionId,owner.serviceDate]),
    kind:'LK1_DAILY_VISIT_V1',tenantKey:owner.tenantKey,clientSubscriptionId:owner.clientSubscriptionId,
    serviceDate:owner.serviceDate,ownerOperationKey:owner._id,ownerOperationId:owner.operationId};
  const binding={operationKey:owner._id,operationId:owner.operationId,tenantKey:owner.tenantKey,actorClientId:owner.actorClientId,
    clientSubscriptionId:owner.clientSubscriptionId,bookingId:owner.bookingId,exerciseId:owner.exerciseId,
    serviceDate:owner.serviceDate,transactionId:owner.lk1.transactionId,chargeMinor:owner.lk1.checkout.toPayMinor,fingerprint:owner.lk1.fingerprint};
  const other=JSON.stringify([[f.sub.bookings[0].id,f.sub.bookings[0].exerciseId]]);
  const job={_id:repairJobKey(owner),kind:'LK1_CANCELLED_VISIT_REPAIR_V1',phase:'DONE',proof:{schemaVersion:1,method:'SERVICE',
    source:'CANCELLED_BOOKING_VISIT_REPAIR',directAckStatus:200,binding,verifiedAt:instant,
    before:{total:30,left:28,targetPresent:false,other},after:{total:30,left:29,targetPresent:false,other}}};
  const evidence={booking:f.b,transaction:f.tx,subscriptions:f.subscriptions,observedAt:instant};
  return {owner,target,guard,job,...evidence,now:instant,evidence};
}
test('handoff requires a real completed repair, fresh matching provider state and untouched refused target',()=>{
  const f=fixture();assert.equal(planDailyGuardRepair(f).recoverable,true);
  for(const mutate of [f=>{f.job.phase='SERVICE_INTENT'},f=>{f.job.proof.before.targetPresent=true},
    f=>{f.job.proof.binding.transactionId='other'},f=>{f.subscriptions.content[0].visitsLeft--},
    f=>{f.target.state='PREPARED'},f=>{f.target.bookingId='booking'},f=>{f.target.lk1.checkout={}},
    f=>{f.target.actorClientId='other'},f=>{f.target.exerciseId=f.owner.exerciseId},
    f=>{f.target.lk1.target.startsAt='2099-11-14T15:00:00Z'},
    ...['transactionAttemptedAt','transactionIntent','checkout','acceptedAt','correlationId','bookingAttemptedAt'].map(k=>f=>{f.target[k]='present'}),
    f=>{f.target.lk1.fingerprint=''},f=>{delete f.target.lk1.dailyVisitPolicyVersion},
    f=>{f.guard.ownerOperationId='competitor'},f=>{f.guard.recovery={}},f=>{f.owner.dailyGuardRecovery={}}]){
    const c=fixture();mutate(c);assert.equal(planDailyGuardRepair(c).recoverable,false,mutate.toString());
  }
});
function store(f){
  const rows=new Map([f.owner,f.target,f.guard,f.job].map(r=>[r._id,structuredClone(r)])),writes=[];
  const operations={async findOne(q){return structuredClone(rows.get(q._id)||null)},async updateOne(q,u,{session}){
    assert.ok(session);writes.push(q._id);const row=rows.get(q._id);
    if(!row||!isDeepStrictEqual(row,q.$expr.$eq[1].$literal))return{acknowledged:true,matchedCount:0,modifiedCount:0};
    Object.assign(row,structuredClone(u.$set));return{acknowledged:true,matchedCount:1,modifiedCount:1};
  }};
  const session={async withTransaction(fn,opts){assert.equal(opts.writeConcern.w,'majority');const before=structuredClone(rows);
    try{return await fn()}catch(e){rows.clear();for(const [k,v]of before)rows.set(k,v);throw e}}};
  return{rows,writes,operations,session};
}
test('transaction fences owner, target, guard and proof while preserving FAILED and original money',async()=>{
  const f=fixture(),s=store(f),p=planDailyGuardRepair(f);
  const result=await applyDailyGuardRepair({...s,expectedPlan:p,providerEvidence:f.evidence,now:()=>instant});
  assert.equal(result.result,'GUARD_TRANSFERRED_FOR_FRESH_RETRY');assert.equal(s.writes.length,4);
  assert.equal(s.rows.get(f.guard._id).ownerOperationKey,f.target._id);
  assert.equal(s.rows.get(f.target._id).state,'FAILED');assert.equal(s.rows.get(f.target._id).bookingId,undefined);
  assert.deepEqual(s.rows.get(f.owner._id).lk1,f.owner.lk1);
  await assert.rejects(()=>applyDailyGuardRepair({...s,expectedPlan:p,providerEvidence:f.evidence,now:()=>instant}),/HANDOFF_SNAPSHOT_DRIFT/);
});
test('stale evidence and changed target abort before guard transfer',async()=>{
  const f=fixture(),s=store(f),p=planDailyGuardRepair(f);
  await assert.rejects(()=>applyDailyGuardRepair({...s,expectedPlan:p,providerEvidence:f.evidence,now:()=> '2099-11-12T12:01:00Z'}),/HANDOFF_EVIDENCE_STALE/);
  s.rows.get(f.target._id).state='PREPARED';
  await assert.rejects(()=>applyDailyGuardRepair({...s,expectedPlan:p,providerEvidence:f.evidence,now:()=>instant}),/HANDOFF_SNAPSHOT_DRIFT/);
  assert.equal(s.rows.get(f.guard._id).ownerOperationKey,f.owner._id);assert.equal(s.writes.length,0);
});
test('failed later CAS rolls back earlier local markers',async()=>{
  const f=fixture(),s=store(f),p=planDailyGuardRepair(f),update=s.operations.updateOne;
  s.operations.updateOne=(q,u,o)=>q._id===f.guard._id?{acknowledged:true,matchedCount:0,modifiedCount:0}:update(q,u,o);
  await assert.rejects(()=>applyDailyGuardRepair({...s,expectedPlan:p,providerEvidence:f.evidence,now:()=>instant}),/HANDOFF_GUARD_CAS_LOST/);
  assert.equal(s.rows.get(f.owner._id).dailyGuardRecovery,undefined);assert.equal(s.rows.get(f.target._id).dailyGuardRecovery,undefined);
  assert.equal(s.rows.get(f.guard._id).ownerOperationKey,f.owner._id);
});
test('real replica-set transaction: concurrent handoff and rollback preserve all four records',
  {skip:!process.env.LK1_GUARD_REPAIR_TEST_MONGO_URI},async()=>{
    const uri=process.env.LK1_GUARD_REPAIR_TEST_MONGO_URI;
    assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:\d+\/\?directConnection=true$/);
    const {MongoClient}=await import('mongodb'),client=await new MongoClient(uri).connect();
    const db=client.db(`lk1_guard_repair_test_${process.pid}_${Date.now()}`),ops=db.collection('operations');
    const sessions=[client.startSession(),client.startSession()],f=fixture(),p=planDailyGuardRepair(f);
    try{
      assert.ok((await client.db('admin').command({hello:1})).setName,'isolated replica set required');
      await ops.insertMany([f.owner,f.target,f.guard,f.job]);
      const results=await Promise.allSettled(sessions.map(session=>applyDailyGuardRepair({operations:ops,session,expectedPlan:p,providerEvidence:f.evidence,now:()=>instant})));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal((await ops.findOne({_id:f.guard._id})).ownerOperationKey,f.target._id);
      assert.equal((await ops.findOne({_id:f.target._id})).state,'FAILED');
      assert.deepEqual((await ops.findOne({_id:f.owner._id})).lk1,f.owner.lk1);
      await ops.deleteMany({});await ops.insertMany([f.owner,f.target,f.guard,f.job]);
      const wrapper={findOne:(...a)=>ops.findOne(...a),updateOne:(q,u,o)=>q._id===f.guard._id
        ?{acknowledged:true,matchedCount:0,modifiedCount:0}:ops.updateOne(q,u,o)};
      await assert.rejects(()=>applyDailyGuardRepair({operations:wrapper,session:sessions[0],expectedPlan:p,providerEvidence:f.evidence,now:()=>instant}),/HANDOFF_GUARD_CAS_LOST/);
      assert.deepEqual(await ops.findOne({_id:f.owner._id}),f.owner);
      assert.deepEqual(await ops.findOne({_id:f.target._id}),f.target);
      assert.deepEqual(await ops.findOne({_id:f.guard._id}),f.guard);
    }finally{await Promise.all(sessions.map(s=>s.endSession()));await db.dropDatabase();await client.close()}
  });

import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { moneyFixture } from './fixtures/lk1ReconciledCancellationFixtures.mjs';
import { planCancelledVisitRepair, repairCancelledVisit, repairDigest, repairJobKey, repairLockKey } from '../lib/lk1CancelledVisitRepair.mjs';
import { parseCancelledVisitRepairArgs } from '../repair_cancelled_subscription_visit.mjs';
const now = () => '2099-11-12T12:00:00Z';
function setup() {
  const f=moneyFixture();Object.assign(f.b,{isGroup:false,groupPayerBookingId:null,batchId:null});f.sub.visitsLeft--;
  const cancelOptions={bookingId:f.b.id,subscription:{available:true},canCancelExercise:false,refundMethods:[],
    group:null,executor:{available:false},addons:{items:[]},packageAddons:{count:0}};
  const input=()=>({op:f.op,booking:f.b,transaction:f.tx,subscriptions:f.subscriptions,cancelOptions,now:now()});
  const rows=new Map([[f.op._id,structuredClone(f.op)]]),writes=[],receipts=[],calls=[];
  const operations={lostIntentAck:false,async findOne(q){return structuredClone(rows.get(q._id)||null)},async updateOne(q,u,o){
    assert.deepEqual(o.writeConcern,{w:'majority',j:true});writes.push({q,u});
    let row=rows.get(q._id),inserted=false;
    if(!row&&o.upsert){row={_id:q._id,...structuredClone(u.$setOnInsert)};rows.set(q._id,row);inserted=true}
    if(!row||!Object.entries(q).every(([k,v])=>v?.$exists!==undefined?(row[k]!==undefined)===v.$exists:isDeepStrictEqual(row[k],v)))return{acknowledged:true,matchedCount:0,modifiedCount:0};
    const before=structuredClone(row);Object.assign(row,structuredClone(u.$set||{}));
    if(this.lostIntentAck&&u.$set?.phase==='SERVICE_INTENT')return{acknowledged:false};
    return{acknowledged:true,matchedCount:inserted?0:1,modifiedCount:!inserted&&!isDeepStrictEqual(before,row)?1:0};
  }};
  const provider={mode:'OK',reads:0,async booking(){calls.push('GET booking');return structuredClone(f.b)},
    async transaction(){calls.push('GET transaction');return structuredClone(f.tx)},
    async subscriptions(){calls.push('GET subscriptions');this.subscriptionReads=(this.subscriptionReads||0)+1;this.beforeSubscriptions?.(this.subscriptionReads);return structuredClone(f.subscriptions)},
    async cancelOptions(){calls.push('GET options');this.reads++;this.afterOptions?.(this.reads);return structuredClone(cancelOptions)},
    async returnVisit(){calls.push('PUT SERVICE');assert.equal(calls.filter(c=>c==='PUT SERVICE').length,1);
      if(this.mode!=='NO_EFFECT')f.sub.visitsLeft++;
      if(this.mode==='LOST_ACK')throw Error('LOST_ACK');
      return{status:this.mode==='ERROR'?503:200};
    }};
  const invoke=approvedPlanDigest=>repairCancelledVisit({op:f.op,operations,provider,writeReceipt:async(n,v)=>receipts.push({n,v:structuredClone(v)}),now,
    approvedPlanDigest,beforeApply:async()=>{assert.equal(repairDigest(rows.get(f.op._id)),repairDigest(f.op))}});
  return{f,input,rows,operations,provider,receipts,writes,calls,invoke,cancelOptions};
}
test('dry-run proves exactly one visit gap and writes nothing',async()=>{
  const s=setup(),r=await s.invoke();assert.equal(r.result,'DRY_RUN_RECOVERABLE');assert.equal(s.writes.length,0);
  assert.equal(s.calls.length,4);assert.equal(r.plan.before.targetPresent,false);assert.equal(r.plan.after.targetPresent,false);
  assert.equal(r.plan.after.left,r.plan.before.left+1);
});
test('group, addon, executor, counter and payment ambiguity hold the entire repair',()=>{
  const cases=[s=>{s.cancelOptions.group={}},s=>{s.cancelOptions.executor.available=true},s=>{s.cancelOptions.addons.items=[{}]},
    s=>{s.cancelOptions.packageAddons.count=1},s=>{s.cancelOptions.subscription.available=false},s=>{s.f.b.isGroup=true},
    s=>{s.f.sub.visitsLeft--},s=>{s.f.sub.visitsLeft++},s=>{s.f.tx.status='PAID'},s=>{s.f.b.paid=true},
    s=>{s.cancelOptions.executor={available:'true',subscriptionReturns:{count:1}}},
    s=>{s.cancelOptions.executor={available:false,refundSum:-1}},s=>{s.cancelOptions.addons={items:{service:'external'}}},
    s=>{s.cancelOptions.packageAddons={count:'unknown'}}];
  for(const mutate of cases){const s=setup();mutate(s);assert.equal(planCancelledVisitRepair(s.input()).recoverable,false,mutate.toString())}
});
test('shared native subscription lock, direct intent ACK and one SERVICE produce a separate repair proof',async()=>{
  const s=setup(),dry=await s.invoke(),r=await s.invoke(dry.planDigest);
  assert.equal(r.result,'VISIT_RETURN_VERIFIED');assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,1);
  assert.equal(s.rows.get(repairLockKey(s.f.op)).ownerJobKey,repairJobKey(s.f.op));
  const job=s.rows.get(repairJobKey(s.f.op));assert.equal(job.phase,'DONE');
  assert.equal(job.proof.source,'CANCELLED_BOOKING_VISIT_REPAIR');assert.equal(job.proof.before.targetPresent,false);
  assert.equal(job.proof.after.left,job.proof.before.left+1);
  assert.equal(s.rows.get(s.f.op._id).lk1.freeCancellationReturn,undefined);
  assert.deepEqual(s.rows.get(s.f.op._id),s.f.op,'owner money/binding never rewritten');
  assert.ok(s.writes.findIndex(w=>w.u.$set?.phase==='SERVICE_INTENT')<s.writes.findIndex(w=>w.u.$set?.phase==='DONE'));
  const retry=await s.invoke(dry.planDigest);assert.equal(retry.result,'HELD');assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,1);
});
test('native in-flight lock, stale plan and lost intent ACK never dispatch',async()=>{
  for(const mode of ['native','stale','intent']){
    const s=setup(),d=await s.invoke();
    if(mode==='native'){s.rows.set(repairLockKey(s.f.op),{_id:repairLockKey(s.f.op),kind:'LK1_FREE_CANCEL_LOCK_V1',ownerJobKey:'native'});s.rows.set('native',{_id:'native',phase:'CANCEL_INTENT'})}
    if(mode==='stale')s.f.sub.visitsLeft--;
    if(mode==='intent')s.operations.lostIntentAck=true;
    const r=await s.invoke(d.planDigest);assert.equal(r.result,'HELD');assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,0,mode);
  }
});
test('pre-intent drift terminalizes only QUEUED job so native cancellation can take over its lock',async()=>{
  const s=setup(),d=await s.invoke();
  s.provider.beforeSubscriptions=n=>{if(n===3)s.f.sub.visitsLeft--};
  const result=await s.invoke(d.planDigest);
  assert.equal(result.reason,'LOCKED_READBACK_DRIFT');
  assert.equal(s.rows.get(repairJobKey(s.f.op)).phase,'DECLINED');
  assert.equal(s.rows.get(repairJobKey(s.f.op)).intentAt,undefined);
  assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,0);
  assert.equal(s.rows.get(repairLockKey(s.f.op)).ownerJobKey,repairJobKey(s.f.op));
});
test('lost lock insert acknowledgement declines QUEUED without any SERVICE dispatch',async()=>{
  const s=setup(),d=await s.invoke(),update=s.operations.updateOne;
  s.operations.updateOne=async(q,u,o)=>{const r=await update.call(s.operations,q,u,o);
    if(q._id===repairLockKey(s.f.op)&&u.$setOnInsert)throw Error('LOST_LOCK_ACK');return r};
  assert.equal((await s.invoke(d.planDigest)).result,'HELD');
  assert.equal(s.rows.get(repairJobKey(s.f.op)).phase,'DECLINED');
  assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,0);
});
test('two repair invocations sharing the same stable key never dispatch twice',async()=>{
  const s=setup(),d=await s.invoke();const result=await Promise.all([s.invoke(d.planDigest),s.invoke(d.planDigest)]);
  assert.equal(result.filter(r=>r.result==='VISIT_RETURN_VERIFIED').length,1);
  assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,1);
});
test('lost SERVICE response, provider error and wrong counter stay UNKNOWN and are never retried',async()=>{
  for(const mode of ['LOST_ACK','ERROR','NO_EFFECT']){
    const s=setup(),d=await s.invoke();s.provider.mode=mode;
    assert.equal((await s.invoke(d.planDigest)).result,'UNKNOWN');
    assert.equal(s.rows.get(repairJobKey(s.f.op)).phase,'SERVICE_INTENT');
    assert.equal((await s.invoke(d.planDigest)).result,'HELD');assert.equal(s.calls.filter(c=>c==='PUT SERVICE').length,1,mode);
  }
});
test('CLI accepts one private explicit target; unknown/broad scan arguments are rejected',()=>{
  const args=['--operation-key-file','/private/target.json','--output-dir','/private/new-output','--expected-flow-sha256','a'.repeat(64)];
  assert.ok(parseCancelledVisitRepairArgs(args));assert.throws(()=>parseCancelledVisitRepairArgs([...args,'--scan','all']));
  assert.throws(()=>parseCancelledVisitRepairArgs(['--output-dir','relative']));
});

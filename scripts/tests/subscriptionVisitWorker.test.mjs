import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import * as lifecycle from '../lib/subscriptionVisitLifecycle.mjs';
import { runSubscriptionVisitJob, createVivaVisitProvider, cleanupConfirmedVisitLocks } from '../lib/subscriptionVisitWorker.mjs';
const now = () => new Date().toISOString();
const snapshot = () => ({ subscriptionId: 'fixture-sub', product: { id: 'fixture-product' },
  variant: 'BY_VISITS', status: 'ACTIVE', visitsTotal: 365, visitsLeft: 364 });
function operation(suffix = 'a') {
  const op = { _id: `fixture-op-${suffix}`, operationId: `fixture-join-${suffix}`, action: 'JOIN_GAME',
    bookingPaymentType: 'ON_PLACE', state: 'CONFIRMED', tenantKey: 'fixture', actorClientId: 'fixture-actor',
    clientSubscriptionId: 'fixture-sub', exerciseId: 'fixture-exercise', bookingId: `fixture-booking-${suffix}`,
    serviceDate: '2026-09-23', lk1: { rule: { productId: 'fixture-product' },
      target: { category: 'GAME', eventId: 'fixture-exercise' }, decision: { eligible: true, subscriptionVisitCount: 1,
        benefit: { finalPriceMinor: 26250 }, gameMinutes: { localDate: '2026-09-23', freeMinutes: 60 } } } };
  op.lk1.visitJob = lifecycle.createSubscriptionVisitJob(op, now());
  return op;
}
const at = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);
const matches = (o, query) => Object.entries(query).every(([k, v]) => {
  if (v && typeof v === 'object') {
    if ('$exists' in v) return (at(o, k) !== undefined) === v.$exists;
    if ('$in' in v) return v.$in.includes(at(o, k));
  }
  return Array.isArray(at(o,k)) ? at(o,k).includes(v) : at(o, k) === v;
});
class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async findOne(q) { return structuredClone(this.rows.find(o => matches(o, q)) || null); }
  find(q) { return { limit: () => ({ toArray: async () => structuredClone(this.rows.filter(o => matches(o, q))) }) }; }
  async insertOne(o) {
    if (this.rows.some(row => row._id === o._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    this.rows.push(structuredClone(o)); return { acknowledged: true, insertedId: o._id };
  }
  async updateOne(q, update) {
    const o = this.rows.find(row => matches(row, q));
    if (o) for (const [key, v] of Object.entries(update.$set)) {
      const parts = key.split('.'); const last = parts.pop(); let dest = o;
      for (const part of parts) dest = dest[part] ||= {};
      dest[last] = structuredClone(v);
    }
    return { acknowledged: true, matchedCount: o ? 1 : 0, modifiedCount: o ? 1 : 0 };
  }
  async deleteOne(q) { const n = this.rows.length; this.rows = this.rows.filter(o => !matches(o, q)); return { deletedCount: n - this.rows.length }; }
}
function fixture(rows = [operation()]) {
  const operations = new Collection(rows), locks = new Collection();
  const dto = snapshot(); const writes = [];
  const provider = { read: async () => structuredClone(dto), adjust: async intent => {
    writes.push(structuredClone(intent)); dto.visitsTotal += intent.body.value; dto.visitsLeft += intent.body.value;
    return { status: 200, body: structuredClone(dto) };
  } };
  return { operations, locks, provider, writes, dto, run: key => runSubscriptionVisitJob({ operationKey: key || rows[0]._id, operations, locks, provider }) };
}
async function cancel(f, opKey = 'fixture-op-a') {
  const op = await f.operations.findOne({ _id: opKey }); const job = op.lk1.visitJob;
  const proof = { source: 'VIVA_BOOKING_READBACK', operationId: 'fixture-cancel', bookingCancelled: true,
    verifiedAt: now(), moneyRefundState: 'REQUEST_ACCEPTED',
    ...Object.fromEntries(['tenantKey','actorClientId','clientSubscriptionId','exerciseId','bookingId'].map(k => [k, job[k]])) };
  const next = lifecycle.requestVisitReturn(job, proof, now());
  const command = lifecycle.visitJobCas(job, next);
  assert.equal((await f.operations.updateOne(command.query, command.update)).matchedCount, 1);
}
test('P2 direct debit and inverse restore counters; allowance releases only after durable return', async () => {
  const f = fixture();
  assert.equal((await f.run()).state, 'DEBIT_CONFIRMED');
  assert.deepEqual([f.dto.visitsTotal, f.dto.visitsLeft], [364,363]);
  assert.equal((await f.run()).state, 'NOT_PENDING'); assert.equal(f.writes.length, 1);
  await cancel(f);
  assert.equal((await f.run()).state, 'RETURN_CONFIRMED');
  assert.deepEqual([f.dto.visitsTotal, f.dto.visitsLeft], [365,364]);
  assert.equal((await f.operations.findOne({ _id: 'fixture-op-a' })).state, 'CONFIRMED');
  assert.equal((await f.run()).state, 'RELEASED');
  assert.equal((await f.run()).state, 'NOT_PENDING');
  assert.deepEqual(f.writes.map(x => x.body.value), [-1,1]);
});
test('concurrent same-job workers emit exactly one PUT', async () => {
  const f = fixture(); await Promise.all([f.run(),f.run(),f.run()]);
  assert.equal(f.writes.length, 1);
});
test('lost debit reply keeps lock, reserves minutes and never repeats or compensates blindly', async () => {
  const f = fixture([operation(),operation('b')]); const adjust = f.provider.adjust;
  f.provider.adjust = async i => { await adjust(i); throw new Error('reply lost'); };
  assert.equal((await f.run()).state, 'MANUAL_REVIEW');
  await cancel(f); assert.equal((await f.run()).state, 'MANUAL_REVIEW');
  assert.equal((await f.run('fixture-op-b')).state, 'BUSY'); assert.equal(f.writes.length, 1);
  await cleanupConfirmedVisitLocks(f); assert.equal(f.locks.rows.length, 1);
});
test('cancel during in-flight debit schedules exactly its inverse after direct ACK', async () => {
  const f = fixture(); const adjust = f.provider.adjust;
  f.provider.adjust = async intent => { const reply = await adjust(intent); if (intent.body.value === -1) await cancel(f); return reply; };
  assert.equal((await f.run()).state, 'RETURN_PENDING');
  assert.equal((await f.run()).state, 'RETURN_CONFIRMED'); assert.equal((await f.run()).state, 'RELEASED');
  assert.deepEqual(f.writes.map(x => x.body.value),[-1,1]);
});
test('cancel before claim causes no provider mutation', async () => {
  const f = fixture(); await cancel(f); assert.equal((await f.run()).state, 'RELEASED'); assert.equal(f.writes.length,0);
});
test('response mismatch or non-200 is manual; ordinary balance read never supplies an ACK', async () => {
  for (const mutate of [r => { r.body.subscriptionId = 'wrong'; },r => { r.body.product.id = 'wrong'; },
    r => { r.status = 202; },r => { r.body.visitsTotal++; },r => { r.body.visitsLeft--; }]) {
    const f = fixture(); const adjust = f.provider.adjust;
    f.provider.adjust = async i => { const r = await adjust(i); mutate(r); return r; };
    assert.equal((await f.run()).state, 'MANUAL_REVIEW'); assert.equal((await f.run()).state, 'MANUAL_REVIEW');
    assert.equal(f.writes.length,1);
  }
});
test('return timeout retains allowance and never sends a second +1', async () => {
  const f = fixture(); await f.run(); await cancel(f); const adjust = f.provider.adjust;
  f.provider.adjust = async i => { await adjust(i); throw new Error('lost'); };
  assert.equal((await f.run()).state,'MANUAL_REVIEW'); assert.equal((await f.run()).state,'MANUAL_REVIEW');
  assert.equal(f.writes.length,2); assert.equal(f.operations.rows[0].state,'CONFIRMED');
});
test('crash after SENT before PUT is ambiguous and no other worker dispatches it', async () => {
  const f = fixture(); const job = f.operations.rows[0].lk1.visitJob;
  const c = lifecycle.claimVisitLimitMutation(job,snapshot(),now()); await f.operations.updateOne(c.query,c.update);
  assert.equal((await f.run()).state,'MANUAL_REVIEW'); assert.equal(f.writes.length,0);
});
test('stored direct ACK recovery cleans only matching old lock leg', async () => {
  const f = fixture(); await f.run();
  f.locks.rows.push({ _id:'subscription-visit-lock:["fixture","fixture-actor","fixture-sub"]', operationKey:'fixture-op-a',jobId:'subscription-visit:fixture-op-a',leg:'DEBIT' });
  await cleanupConfirmedVisitLocks(f); assert.equal(f.locks.rows.length,0);
});
test('paid leave saves cancellation before roster continuation and preserves allowance', async () => {
  const f = fixture(); await f.run(); const op = structuredClone(f.operations.rows[0]);
  const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_split_leave_daily_limit_route.js',import.meta.url),'utf8');
  const ctx = { operationId:'fixture-cancel', targetClientId:op.actorClientId, exerciseId:op.exerciseId,
    initialBookingIds:[op.bookingId], vivaVerification:'active_absent_history_cancelled',vivaVerifiedAt:now(),
    bookingResults:[{ bookingId:op.bookingId,provisional:'cancel_requested',refundMethod:'CURRENCY' }] };
  const execute = (payload, context=ctx) => new Function('msg','__subscriptionVisitLifecycle',source)({payload:structuredClone(payload),_splitLeaveCtx:structuredClone(context)},lifecycle);
  const out = execute([op]); assert.ok(out[0]); assert.equal(out[1],null);
  assert.equal(out[0].payload[1].$set['lk1.visitJob'].phase,'RETURN_PENDING');
  const ack = await f.operations.updateOne(out[0].payload[0],out[0].payload[1]);
  const ackSource = fs.readFileSync(new URL('../nodered_games_nodes/fn_split_leave_daily_limit_ack.js',import.meta.url),'utf8');
  const continued = new Function('msg',ackSource)({...out[0],payload:ack});
  assert.equal(continued[0]._splitLeaveCtx.dailyLimitReleaseOutcome,'VISIT_RETURN_PENDING');
  assert.equal(f.operations.rows[0].state,'CONFIRMED');
  assert.equal((await f.run()).state,'RETURN_CONFIRMED');assert.equal((await f.run()).state,'RELEASED');
  const denied = execute([op],{...ctx,bookingResults:[]});assert.equal(denied[3].payload.reason,'visit_money_cancel_unverified');
});
test('real loopback HTTP provider sends exact signed deltas once with redirects disabled', async t => {
  const seen=[]; const dto=snapshot();
  const server=http.createServer(async (req,res) => {
    let text='';for await(const chunk of req)text+=chunk;
    seen.push({method:req.method,url:req.url,body:text});
    if(req.method==='PUT'){const delta=JSON.parse(text).value;dto.visitsTotal+=delta;dto.visitsLeft+=delta;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/api/v1/exercises/') ? {content:[{id:'fixture-booking-a',clientId:'fixture-actor',exerciseId:'fixture-exercise',paymentType:'ON_PLACE',isCancelled:false}],last:true} : dto));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const f=fixture();const provider=createVivaVisitProvider({token:async()=> 'fixture-token',baseUrl:`http://127.0.0.1:${server.address().port}`});
  const run=()=>runSubscriptionVisitJob({...f,provider,operationKey:'fixture-op-a'});
  assert.equal((await run()).state,'DEBIT_CONFIRMED');await cancel(f);assert.equal((await run()).state,'RETURN_CONFIRMED');
  assert.deepEqual(seen.filter(r=>r.method==='PUT').map(r=>JSON.parse(r.body)),[{type:'BY_VISITS',value:-1},{type:'BY_VISITS',value:1}]);
  assert.ok(seen.every(r=>r.url.startsWith('/api/v1/clients/fixture-actor/subscriptions/fixture-sub') || r.url.startsWith('/api/v1/exercises/fixture-exercise/bookings?')));
});
test('misbound embedded operation stops before provider I/O', async () => {
  const f=fixture();f.operations.rows[0].actorClientId='foreign';
  await assert.rejects(f.run(),/BINDING_INVALID/);assert.equal(f.writes.length,0);assert.equal(f.locks.rows.length,0);
});
test('Node-RED VM supports generated lifecycle without host structuredClone', async () => {
  const vm=await import('node:vm');const {visitLifecycleRuntimeSource}=await import('../lib/subscriptionVisitRuntimeSource.mjs');
  const context=vm.createContext({operation:JSON.parse(JSON.stringify(operation()))});
  const proof={source:'VIVA_BOOKING_READBACK',operationId:'fixture-cancel',bookingCancelled:true,verifiedAt:now(),moneyRefundState:'REQUEST_ACCEPTED',
    ...Object.fromEntries(['tenantKey','actorClientId','clientSubscriptionId','exerciseId','bookingId'].map(k=>[k,operation()[k]]))};
  context.proof=proof;
  const result=vm.runInContext(visitLifecycleRuntimeSource()+`\n__subscriptionVisitLifecycle.requestVisitReturn(operation.lk1.visitJob, proof, new Date().toISOString()).phase`,context);
  assert.equal(result,'CANCELLED_BEFORE_DEBIT');
});
test('explicit staff NO_RETURN keeps visit while ordinary NONE does not claim money was unpaid', async () => {
  const f=fixture();await f.run();const op=f.operations.rows[0];
  const source=fs.readFileSync(new URL('../nodered_games_nodes/fn_split_leave_daily_limit_route.js',import.meta.url),'utf8');
  const base={operationId:'fixture-cancel',targetClientId:op.actorClientId,exerciseId:op.exerciseId,
    initialBookingIds:[op.bookingId],vivaVerification:'active_absent_history_cancelled',vivaVerifiedAt:now(),
    bookingResults:[{bookingId:op.bookingId,provisional:'cancel_requested',refundMethod:'NONE'}]};
  const run=ctx=>new Function('msg','__subscriptionVisitLifecycle',source)({_splitLeaveCtx:ctx,payload:[op]},lifecycle);
  const staff=run({...base,mode:'STAFF_TARGET',reason:'CUP_STAFF_REMOVAL',requestedRefundMethod:'NONE',staffActorId:'fixture-staff'});
  assert.ok(staff[0]);assert.equal(staff[0]._splitLeaveCtx.dailyLimitReleaseOutcome,'VISIT_RETAINED_BY_STAFF');
  assert.equal(staff[0].payload[1].$set['lk1.visitJob'].returnPolicy.kind,'STAFF_NO_RETURN');
  const normal=run({...base,mode:'SELF'});
  assert.equal(normal[0].payload[1].$set['lk1.visitJob'].cancellation.moneyRefundState,'NO_REFUND_REQUESTED');
});
test('physical Mongo CAS plus loopback HTTP complete debit/cancel/return/release under concurrent workers',
  {skip:!process.env.LK_VISIT_VERIFY_MONGO_URI},async t=>{
    const uri=process.env.LK_VISIT_VERIFY_MONGO_URI;
    assert.match(uri,/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/);
    const {MongoClient}=await import('mongodb');
    const client=new MongoClient(uri,{retryWrites:false,serverSelectionTimeoutMS:5000});await client.connect();
    const db=client.db(`subscription_visit_verify_${process.pid}_${Date.now()}`);
    t.after(async()=>{await db.dropDatabase();await client.close();});
    const operations=db.collection('ops'),locks=db.collection('locks');await operations.insertOne(operation());
    const dto=snapshot(),deltas=[];
    const server=http.createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      if(req.method==='PUT'){const delta=JSON.parse(body).value;deltas.push(delta);dto.visitsTotal+=delta;dto.visitsLeft+=delta;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/api/v1/exercises/') ? {content:[{id:'fixture-booking-a',clientId:'fixture-actor',exerciseId:'fixture-exercise',paymentType:'ON_PLACE',isCancelled:false}],last:true} : dto));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
    const provider=createVivaVisitProvider({baseUrl:`http://127.0.0.1:${server.address().port}`,token:async()=> 'fixture-token'});
    const f={operations,locks,provider};const run=()=>runSubscriptionVisitJob({...f,operationKey:'fixture-op-a'});
    await Promise.all(Array.from({length:8},run));assert.deepEqual(deltas,[-1]);
    assert.equal((await operations.findOne({_id:'fixture-op-a'})).lk1.visitJob.phase,'DEBIT_CONFIRMED');
    await cancel(f);await Promise.all(Array.from({length:8},run));assert.deepEqual(deltas,[-1,1]);
    await run();assert.equal((await operations.findOne({_id:'fixture-op-a'})).state,'RELEASED');
    assert.deepEqual([dto.visitsTotal,dto.visitsLeft],[365,364]);
    assert.equal(await locks.countDocuments(),0);
  });

const externalProof = job => ({source:'VIVA_BOOKING_READBACK',operationId:`viva-cancel:${job.bookingId}`,
  bookingCancelled:true,verifiedAt:now(),moneyRefundState:'EXTERNAL_CANCELLATION',
  ...Object.fromEntries(['tenantKey','actorClientId','clientSubscriptionId','exerciseId','bookingId'].map(k=>[k,job[k]]))});
test('background observer returns own delta after cabinet or cleanup cancellation',async()=>{
  const f=fixture();await f.run();
  f.provider.readCancellation=async job=>externalProof(job);
  const run=()=>runSubscriptionVisitJob({...f,leaveOperations:new Collection(),operationKey:'fixture-op-a'});
  assert.equal((await run()).state,'RETURN_CONFIRMED');assert.equal((await run()).state,'RELEASED');
  assert.deepEqual(f.writes.map(x=>x.body.value),[-1,1]);
});
test('background observer suppresses debit after externally cancelled booking',async()=>{
  const f=fixture();f.provider.readCancellation=async job=>externalProof(job);
  const result=await runSubscriptionVisitJob({...f,leaveOperations:new Collection(),operationKey:'fixture-op-a'});
  assert.equal(result.state,'RELEASED');assert.equal(f.writes.length,0);
});
test('durable staff NO_RETURN blocks observer in the interval before post-cancel hook',async()=>{
  const f=fixture();await f.run();f.provider.readCancellation=async job=>externalProof(job);
  const leaveOperations=new Collection([{_id:'fixture-staff-leave',exerciseId:'fixture-exercise',targetClientId:'fixture-actor',
    bookingIds:['fixture-booking-a'],mode:'STAFF_TARGET',reason:'CUP_STAFF_REMOVAL',requestedRefundMethod:'NONE',state:'STARTED'}]);
  const result=await runSubscriptionVisitJob({...f,leaveOperations,operationKey:'fixture-op-a'});
  assert.equal(result.state,'VISIT_RETAINED_BY_STAFF');assert.equal(f.writes.length,1);
});
test('failed staff-policy read after cancelled booking never returns the visit',async()=>{
  const f=fixture();await f.run();f.provider.readCancellation=async job=>externalProof(job);
  const result=await runSubscriptionVisitJob({...f,leaveOperations:{findOne:async()=>{throw new Error('offline');}},operationKey:'fixture-op-a'});
  assert.equal(result.state,'PRECHECK_REQUIRED');assert.equal(f.writes.length,1);
});
test('provider observer rejects contradictory identities, states and pagination before any delta',async()=>{
  const row=()=>({id:'fixture-booking-a',clientId:'fixture-actor',exerciseId:'fixture-exercise',paymentType:'ON_PLACE',isCancelled:true});
  for(const mutate of [
    p=>{p.content[0].bookingId='foreign';},p=>{p.content[0].client={id:'foreign'};},
    p=>{p.content[0].isCancelled=false;p.content[0].cancelled=true;},
    p=>{p.content[0].isCancelled=false;p.content[0].cancelledAt='not-a-date';},
    p=>{delete p.content[0].isCancelled;},p=>{p.content[0].paymentType='SUBSCRIPTION';},
    p=>{p.totalElements=500;},p=>{p.last=false;},p=>{p.number=1;},p=>{p.totalPages=9;},
    p=>{delete p.last;delete p.totalElements;},
  ]){
    const body={content:[row()],last:true,totalElements:1};mutate(body);
    let writes=0;const f=fixture();const provider=createVivaVisitProvider({token:async()=> 'fixture-token',
      fetchImpl:async(_url,init)=>{if(init.method==='PUT')writes++;return{status:200,json:async()=>body};}});
    const result=await runSubscriptionVisitJob({...f,provider,leaveOperations:new Collection(),operationKey:'fixture-op-a'});
    assert.equal(result.state,'PRECHECK_REQUIRED');assert.equal(writes,0);
  }
});
test('lost database acknowledgment after direct PUT is never recovered by repeating the mutation',async()=>{
  const f=fixture();const update=f.operations.updateOne.bind(f.operations);
  f.operations.updateOne=async(q,u)=>{if(u.$set?.['lk1.visitJob']?.phase==='DEBIT_CONFIRMED')throw new Error('store lost');return update(q,u);};
  await assert.rejects(f.run(),/store lost/);assert.equal(f.writes.length,1);
  assert.equal((await f.run()).state,'MANUAL_REVIEW');assert.equal(f.writes.length,1);
});
test('cancellation winning during subscription precheck prevents stale debit claim',async()=>{
  const f=fixture();f.provider.read=async()=>{await cancel(f);return snapshot();};
  assert.equal((await f.run()).state,'RETRY_STORE');assert.equal(f.writes.length,0);
  assert.equal((await f.run()).state,'RELEASED');
});

// Physical rehearsal: native Node-RED, real MongoDB, loopback HTTP provider.
// Run only in fixture-owned network-none containers; never against a shared DB.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startVisitDev} from './start.mjs';
import {ACTOR,SUBSCRIPTIONS,USER_TOKEN} from './fixture.mjs';
import {verifyPacket} from './packet.mjs';
const file=fileURLToPath(import.meta.url),packet=path.resolve(path.dirname(file),'../..');
verifyPacket(packet);
const scenario=process.argv[2];
if(!scenario){
  const suffix=Date.now().toString(36);
  for(const name of ['mongo_after_booking','happy','unpaid','debit_lost','debit_restart','return_lost','return_restart']){
    const run=spawnSync(process.execPath,[file,name,suffix],{stdio:'inherit'});
    assert.equal(run.status,0,name);
  }
  console.log(JSON.stringify({result:'PASS',runtime:'native Node-RED 4.0.9 + MongoDB 7',externalNetwork:false,scenarios:7}));
}else{
  const group=scenario.replace('_restart','_lost').replace('mongo_after_booking','mongo');
  const config={...JSON.parse(fs.readFileSync(path.join(packet,'config.json'))),database:`lk1_subscription_dev_fixture_verify_${process.argv[3]}_${group}`};
  const app=await startVisitDev({config,flowPath:path.join(packet,'flows.json'),userDir:fs.mkdtempSync('/tmp/visit-nodered-')});
  const api=async(route,body,key='fixture-join-1',auth=true)=>{
    const response=await fetch(`http://127.0.0.1:${config.nodeRedPort}${route}`,{method:body===undefined?'GET':'POST',
      headers:{...(auth?{Authorization:'Bearer '+USER_TOKEN}:{}),'Content-Type':'application/json','Idempotency-Key':key},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
  };
  const join=async(key='fixture-join-1')=>{const r=await api('/lk/games/fixture-game/split/join',{
    paymentMode:'subscription',clientSubscriptionId:SUBSCRIPTIONS[0],clientId:ACTOR,clientPhone:'70000000001',paymentRef:key},key);
    assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.toPayMinor,26250);assert.equal(r.body.gameMinutes.freeMinutes,60);return r.body;};
  const state=()=>app.runtime.state();
  const worker=()=>app.runtime.worker();
  const leave=async()=>{const r=await api('/lk/games/fixture-game/split/leave',{});assert.equal(r.status,200,JSON.stringify(r));return r;};
  try{
    if(scenario==='mongo_after_booking'){
      await api('/dev/control/seed',{});
      const mongo=app.runtime.io.mongo;let injected=false;
      app.runtime.io.mongo=async(msg,collection,operation)=>{
        if(!injected&&msg._subscriptionBooking?.step==='operation_confirm') {injected=true;throw Error('FIXTURE_MONGO_CONFIRM_LOST');}
        return mongo(msg,collection,operation);
      };
      const response=await api('/lk/games/fixture-game/split/join',{paymentMode:'subscription',clientSubscriptionId:SUBSCRIPTIONS[0],
        clientId:ACTOR,clientPhone:'70000000001',paymentRef:'fixture-join-1'});
      assert.equal(injected,true);assert.equal(response.status,202,JSON.stringify(response));
      assert.equal(response.body.details.code,'LK1_BOOKING_PAYMENT_RECONCILIATION_REQUIRED');
      const current=await state();assert.equal(current.provider.bookings.length,1);assert.equal(current.provider.transactions.length,0);
      assert.equal(current.provider.deltas.length,0);
    }else if(scenario.endsWith('restart')){
      const before=await state();assert.equal(before.provider.deltas.length,scenario.startsWith('debit')?1:2);
      await worker();await worker();const after=await state();
      assert.deepEqual(after.provider.deltas,before.provider.deltas);assert.equal(after.locks,1);
      assert.equal(after.operations[0].state,'CONFIRMED');assert.match(after.operations[0].lk1.visitJob.phase,/_UNKNOWN$/);
      assert.equal(after.operations[0].lk1.visitJob.freeMinutes,60);
    }else{
      assert.equal((await api('/dev/control/state',undefined,'unused',false)).status,403);
      await assert.rejects(()=>app.runtime.io.transport({url:'https://example.com',method:'GET',headers:{Authorization:'Bearer '+USER_TOKEN}}),/EGRESS_DENIED/);
      await api('/dev/control/seed',{});
      const first=await join();const replay=await api('/lk/games/fixture-game/split/join',{paymentMode:'subscription',clientSubscriptionId:SUBSCRIPTIONS[0],clientId:ACTOR,clientPhone:'70000000001',paymentRef:'fixture-join-1'});
      assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.body.paymentUrl,first.paymentUrl);assert.equal(replay.body.transactionId,first.transactionId);assert.equal(replay.body.bookingId,first.bookingId);assert.equal(replay.body.toPayMinor,first.toPayMinor);
      assert.equal((await state()).provider.transactions.length,1);
      assert.equal((await state()).provider.bookings.length,1);
      if(scenario!=='unpaid'){
        if(scenario==='happy'){
          await app.runtime.fault('PAY_PROJECTION_LOST');
          await assert.rejects(()=>app.runtime.pay(first.transactionId),/PROJECTION_RETRY/);
          const interrupted=await state();assert.equal(interrupted.provider.transactions[0].paid,true);assert.equal(interrupted.game.participants.length,0);
        }
        await app.runtime.pay(first.transactionId);await app.runtime.pay(first.transactionId);
      }
      if(scenario==='debit_lost')await app.runtime.fault('DEBIT_ACK_LOST');
      await Promise.all([worker(),worker()]);
      let current=await state();assert.equal(current.provider.deltas.length,1);assert.equal(current.provider.subscriptions[0].visitsLeft,364);
      assert.equal(current.provider.subscriptions[1].visitsLeft,365);
      if(scenario==='debit_lost'){
        await worker();current=await state();assert.equal(current.provider.deltas.length,1);assert.equal(current.locks,1);
        assert.equal(current.operations[0].lk1.visitJob.phase,'DEBIT_UNKNOWN');
      }else{
        if(scenario==='unpaid'){
          // No fixture roster exists until payment: exercise external unpaid expiry
          // against this exact synthetic booking, then let worker discover it.
          const res=await fetch(app.runtime.origin+'/end-user/api/v1/iSkq6G/bookings/'+first.bookingId,{method:'DELETE',headers:{Authorization:'Bearer '+USER_TOKEN,'Content-Type':'application/json'},body:'{}'});
          assert.equal(res.status,200);
        }else{await leave();await leave();}
        current=await state();assert.equal(current.game.participants.length,0);
        assert.equal(current.provider.refunds.length,scenario==='unpaid'?0:1);
        if(scenario==='return_lost')await app.runtime.fault('RETURN_ACK_LOST');
        await worker();await worker();await worker();
        current=await state();assert.deepEqual(current.provider.deltas.map(d=>d.value),[-1,1]);
        assert.equal(current.provider.subscriptions[0].visitsLeft,365);
        await assert.rejects(()=>app.runtime.pay(first.transactionId),/PAYMENT_INVALID/);
        if(scenario==='return_lost'){
          assert.equal(current.operations[0].state,'CONFIRMED');assert.equal(current.operations[0].lk1.visitJob.phase,'RETURN_UNKNOWN');assert.equal(current.locks,1);
        }else{
          assert.equal(current.operations[0].state,'RELEASED');assert.equal(current.locks,0);
          const second=await join('fixture-join-2');assert.notEqual(second.bookingId,first.bookingId);
          const before=await state();await assert.rejects(()=>app.runtime.pay(first.transactionId),/PAYMENT_INVALID/);
          assert.deepEqual((await state()).game,before.game);
        }
      }
    }
    const final=await state();console.log(JSON.stringify({scenario,result:'PASS',providerDeltas:final.provider.deltas.map(d=>d.value),
      refunds:final.provider.refunds.length,phases:final.operations.map(o=>[o.state,o.lk1.visitJob?.phase||null]),locks:final.locks}));
  }finally{await app.close();}
}

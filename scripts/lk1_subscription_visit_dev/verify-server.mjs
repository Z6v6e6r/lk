// Run inside fixture-owned network-none Node22 + Mongo container namespace only.
// This exercises the actual foreground server CLI, SIGTERM drain and restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const packet=fs.realpathSync(process.argv[2]);
const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(packet,'manifest.json'))).digest('hex');
const {ACTOR,PHONE,SUBSCRIPTIONS,USER_TOKEN}=await import(path.join(packet,'scripts/lk1_subscription_visit_dev/fixture.mjs'));
const endpoint='http://127.0.0.1:1882';
const api=async(route,body)=>{
  const res=await fetch(endpoint+route,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(10000),
    headers:{Authorization:'Bearer '+USER_TOKEN,'Content-Type':'application/json','Idempotency-Key':'server-verify-join'},
    body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal(res.status,200,route);return res.json();
};
const state=()=>api('/dev/control/state');
const waitFor=async(predicate)=>{const end=Date.now()+75000;let last;
  while(Date.now()<end){try{last=await state();if(predicate(last))return last;}catch{/* Startup may not yet listen. */}
    await new Promise(resolve=>setTimeout(resolve,100));}
  throw Error('SERVER_VERIFY_TIMEOUT:'+JSON.stringify(last?.worker));
};
let child,exit;
const start=async()=>{
  child=spawn(process.execPath,[path.join(packet,'scripts/lk1_subscription_visit_dev/serve.mjs'),'--serve',packet,hash],{stdio:'inherit'});
  exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  await waitFor(s=>s.worker?.enabled===true);
};
const stop=async()=>{child.kill('SIGTERM');const result=await exit;assert.deepEqual(result,{code:0,signal:null});child=undefined;};
try{
  await start();const empty=await state();assert.equal(empty.operations.length,0,'Fresh fixture database required');
  await api('/dev/control/seed',{});
  const joined=await api('/lk/games/fixture-game/split/join',{paymentMode:'subscription',clientSubscriptionId:SUBSCRIPTIONS[0],clientId:ACTOR,clientPhone:PHONE.slice(1),paymentRef:'server-verify-join'});
  assert.equal(joined.toPayMinor,26250);await api('/dev/control/pay',{transactionId:joined.transactionId});
  await waitFor(s=>s.operations[0]?.lk1?.visitJob?.phase==='DEBIT_CONFIRMED');
  await api('/lk/games/fixture-game/split/leave',{});
  const released=await waitFor(s=>s.operations[0]?.state==='RELEASED');
  assert.deepEqual(released.provider.deltas.map(d=>d.value),[-1,1]);assert.equal(released.provider.refunds.length,1);assert.equal(released.game.participants.length,0);
  await stop();await start();const restarted=await waitFor(s=>s.worker.cycles>=2);
  assert.deepEqual(restarted.provider,released.provider);assert.equal(restarted.locks,0);assert.equal(restarted.operations[0].state,'RELEASED');
  await stop();console.log(JSON.stringify({result:'PASS',mode:'serve CLI',checks:['scheduled debit','scheduled return','SIGTERM drain','same-Mongo restart'],externalNetwork:false}));
}finally{if(child){child.kill('SIGTERM');await exit;}}

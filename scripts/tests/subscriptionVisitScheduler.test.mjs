import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisitScheduler} from '../lk1_subscription_visit_dev/scheduler.mjs';
import {settleVisitJobs} from '../lk1_subscription_visit_dev/runtime.mjs';

test('manual triggers share the in-flight scan and stop drains it',async()=>{
  let release,calls=0;
  const s=createVisitScheduler({worker:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  const first=s.runOnce(),replay=s.runOnce();assert.equal(first,replay);
  await Promise.resolve();assert.equal(calls,1);
  let drained=false;const stopping=s.stop().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);assert.equal(s.status().running,true);
  await assert.rejects(s.runOnce(),/STOPPED/);
  release([{state:'MANUAL_REVIEW',reason:'private provider detail'}]);await stopping;
  assert.equal(s.status().cycles,1);assert.deepEqual(s.status().outcomes,{MANUAL_REVIEW:1});
  assert.ok(!JSON.stringify(s.status()).includes('private'));assert.equal(s.status().running,false);
});
test('periodic scan waits for completion; a failed scan does not wedge the worker',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  let calls=0,release;
  const s=createVisitScheduler({intervalMs:1000,worker:async()=>{
    calls++;if(calls===1)throw Error('private error');
    return new Promise(resolve=>{release=resolve;});
  }});
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  context.mock.timers.tick(1000);await flush();assert.equal(calls,1);assert.equal(s.status().errors,1);
  context.mock.timers.tick(1000);await flush();assert.equal(calls,2);
  context.mock.timers.tick(60000);await flush();assert.equal(calls,2);
  release([{state:'RELEASED'}]);await flush();assert.equal(s.status().cycles,1);
  await s.stop();context.mock.timers.tick(60000);await flush();assert.equal(calls,2);
});
test('worker scheduling stays off unless an accepted interval is explicit',async()=>{
  for(const intervalMs of [-1,1,999,60001,NaN,'5000'])assert.throws(()=>createVisitScheduler({worker:()=>[],intervalMs}),/INTERVAL_INVALID/);
  const s=createVisitScheduler({worker:()=>[]});assert.equal(s.status().enabled,false);await s.stop();
});

test('failed sibling job cannot release scan or shutdown while another provider job is active',async()=>{
  let release,calls=0;
  const s=createVisitScheduler({worker:()=>{calls++;return settleVisitJobs([
    Promise.reject(Error('DB_WRITE_FAILED')),
    new Promise(resolve=>{release=resolve;}),
  ]);}});
  const first=s.runOnce();const rejected=assert.rejects(first,/SCAN_FAILED/);
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(s.status().running,true);assert.equal(s.runOnce(),first);assert.equal(calls,1);
  let stopped=false;const drain=s.stop().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);
  release({state:'DEBIT_CONFIRMED'});await rejected;await drain;
  assert.equal(stopped,true);assert.equal(s.status().errors,1);
});

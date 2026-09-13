import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGamesMaintenanceBootstrap, MAINTENANCE_ENTRIES, MAINTENANCE_HTTP, prepareMaintenancePacket } from '../build_games_maintenance_bootstrap.mjs';
const context = () => { let value; return {get:()=>value,set:(_key,next)=>{value=next;}}; };
const fixture = () => [
  { id:'016d6797a530ed0a', type:'function', z:'games', func:'return msg;', outputs:1,wires:[[]] },
  { id:'35f7c89069fc393a', type:'http response', z:'games', wires:[] },
  { id:'lk_split_leave_game_update_20260801', type:'mongodb4', z:'games', operation:'updateOne',collection:'lk_games',clientNode:'mongo-config',wires:[] },
  { id:'mongo-config',type:'mongodb4-client',name:'fixture' },
  ...MAINTENANCE_ENTRIES.map(id=>({id,type:id.includes('inject')||id.includes('scheduler')?'inject':'http in',z:'games',wires:[['router']]})),
  {id:'router',type:'function',z:'games',func:'return msg;',wires:[MAINTENANCE_HTTP]},
  ...MAINTENANCE_HTTP.map(id=>({id,type:'http request',z:'games',wires:[['router']]})),
];
test('bootstrap changes existing wires only and preserves all async node configuration',()=>{
  const source=fixture(), before=structuredClone(source), result=buildGamesMaintenanceBootstrap(source);
  assert.deepEqual(source,before);
  for(const original of source) {
    const after=result.flow.find(n=>n.id===original.id);
    assert.deepEqual({...after,wires:[]},{...original,wires:[]});
  }
  assert.deepEqual(result.flow.find(n=>n.id==='mongo-config'), source.find(n=>n.id==='mongo-config'));
  assert.equal(result.added.length,10);
  for(const id of MAINTENANCE_HTTP) {
    assert.equal(result.flow.some(n=>n.wires?.flat().includes(id)),false,'all provider reentry is held');
    assert.match(result.flow.find(n=>n.id===id).wires[0][0],/_after$/);
  }
});
test('missing nodes and duplicate IDs fail before producing a graph',()=>{
  assert.throws(()=>buildGamesMaintenanceBootstrap(fixture().slice(1)),/Missing/);
  const source=fixture();assert.throws(()=>buildGamesMaintenanceBootstrap([...source,source[0]]),/Duplicate/);
});
test('admission rejects HTTP and silently stops scheduler, regardless of message flags',()=>{
  const run=new Function('msg',fs.readFileSync('scripts/nodered_games_maintenance_nodes/admission.js','utf8'));
  assert.equal(run({maintenanceOpen:true}),null);
  const out=run({req:{},res:{},maintenanceOpen:true});
  assert.equal(out.statusCode,503); assert.equal(out.payload.code,'GAMES_MAINTENANCE');
});
test('collector retains correlation without credentials, PII or arbitrary provider response',()=>{
  const run=new Function('msg','flow','node',"const POINT='provider'; const PHASE='AFTER_PROVIDER';\n"+fs.readFileSync('scripts/nodered_games_maintenance_nodes/capture.js','utf8'));
  const out=run({_msgid:'message',statusCode:200,headers:{Authorization:'do-not-store'},payload:{secret:'do-not-store'},
    _splitCleanupCtx:{gameId:'game',step:'cancel',initialBookingIds:['booking'],phone:'do-not-store',accessToken:'do-not-store'}},context(),{error:()=>{}});
  assert.equal(out.payload[0].state,'RECONCILIATION_REQUIRED');
  assert.deepEqual(out.payload[0].bookingIds,['booking']);
  assert.equal(JSON.stringify(out.payload).includes('do-not-store'),false);
});
test('unknown/error response never establishes successful cancellation',()=>{
  const run=new Function('msg','flow','node',"const POINT='provider'; const PHASE='AFTER_PROVIDER';\n"+fs.readFileSync('scripts/nodered_games_maintenance_nodes/capture.js','utf8'));
  const out=run({error:new Error('timeout'),statusCode:'ETIMEDOUT'},context(),{error:()=>{}});
  assert.equal(out.payload[0].errorObserved,true);assert.equal(out.payload[0].providerStatus,null);
  assert.equal(out.payload[0].state,'RECONCILIATION_REQUIRED');
});
test('packet refuses unreviewed private source, including caller supplied revision',()=>{
  assert.throws(()=>prepareMaintenancePacket(Buffer.from(JSON.stringify(fixture())),'revision'),/Unreviewed live source/);
});
test('incomplete evidence is explicit and each same-clock emission is distinct',()=>{
  const run=new Function('msg','flow','node',"const POINT='provider'; const PHASE='AFTER_PROVIDER';\n"+fs.readFileSync('scripts/nodered_games_maintenance_nodes/capture.js','utf8'));
  const flow=context();const emit=()=>run({_msgid:'same',_splitLeaveCtx:{gameId:'x'.repeat(201),initialBookingIds:Array.from({length:101},(_,i)=>String(i))}},flow,{error:()=>{}}).payload[0];
  const a=emit(),b=emit();assert.notEqual(a._id,b._id);assert.equal(a.originalBookingIdCount,101);
  assert.equal(a.evidenceIncomplete,true);assert.equal(a.bookingIds.length,100);assert.equal(flow.get().pending,2);
});
test('unconfirmed Mongo ack leaves pending and sets sticky unhealthy; confirmed ack cannot clear it',()=>{
  const candidate=buildGamesMaintenanceBootstrap(fixture());
  const fn=candidate.flow.find(n=>n.id.endsWith('_ack'));
  const run=new Function('msg','flow','node',fn.func);const flow=context();
  flow.set('',{pending:2,unhealthy:false});
  run({payload:{acknowledged:false}},flow,{error:()=>{}});
  assert.equal(flow.get().pending,2);assert.equal(flow.get().unhealthy,true);
  run({payload:{acknowledged:true}},flow,{error:()=>{}});
  assert.equal(flow.get().pending,1);assert.equal(flow.get().unhealthy,true);
  assert.ok(candidate.flow.some(n=>n.type==='catch'&&n.scope.includes('games_maintenance_20260913_persist')));
});

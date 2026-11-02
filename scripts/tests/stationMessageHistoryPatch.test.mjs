import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { patchStationMessageHistory,historyNodeIds } from '../lib/stationMessageHistorySource.mjs';
import {historyGraphBase,historyGraph,historyEvaluate,historyReadGraph,historyCommunity,historyMessage,historyLegacy} from './helpers/stationHistoryHarness.mjs';

test('actual composed history graph returns strict v2 after bounded reads and final current ACL',async()=>{
  const visited=[];
  const result=await historyReadGraph({find:async(stage,args)=>{
    visited.push([stage,args]);
    if(stage==='canonical')return [historyMessage(3),historyMessage(2),historyMessage(1)];
    if(stage==='legacy')return [historyLegacy(1)];
    return [historyCommunity()];
  }});
  assert.equal(result.statusCode,200);assert.equal(result.payload.historyVersion,2);
  assert.deepEqual(visited.map(([stage])=>stage),['canonical','legacy','access']);
  assert.equal(visited[0][1][1].limit,3);assert.equal(visited[1][1][1].limit,2001);assert.equal(visited[2][1][1].limit,2);
  assert.equal(result.payload.messages.length,2);assert.equal(result.payload.hasMore,true);
  assert.equal(result._stationHistory,undefined);assert.equal(result._stationHistoryRequest,undefined);
  assert.equal(JSON.stringify(result.payload).includes('legacy-1'),false);
});
test('actual guard blocks unauthenticated, phone-only, LEFT, BAN, changed identity/type and archived final community',async()=>{
  // Synthetic non-routable country-7/area-000 identity, never a real contact export.
  const syntheticPhone='+'+String(7*10**10+1);
  assert.match(syntheticPhone,/^\+\d{11}$/);
  const community={...historyCommunity(),members:[{...historyCommunity().members[0],phone:syntheticPhone}]};
  for(const actor of [undefined,{phone:syntheticPhone},{id:'intruder',phone:syntheticPhone}]) {
    const result=await historyReadGraph({community,actor:actor??null,find:()=>{throw Error('MUST_NOT_READ');}});
    assert.equal(result.statusCode,403);assert.equal(result.payload.messages,undefined);
  }
  for(const changed of [{members:[]},{bannedMembers:[{id:'actor'}]},{_id:'replacement'},{communityType:'FRIENDS'},{archived:true},
    {stationMembershipLifetime:{version:1,revision:1,players:[{playerId:'actor',epoch:1,state:'LEFT'}]}}]) {
    const result=await historyReadGraph({find:async stage=>stage==='canonical'?[historyMessage(1)]:stage==='legacy'?[]:[{...historyCommunity(),...changed}]});
    assert.equal(result.statusCode,403);assert.deepEqual(result.payload,{historyVersion:2,error:'HISTORY_ACCESS_DENIED'});
  }
});
test('actual Mongo failure, malformed response and overflow never emit partial page/debug',async()=>{
  for(const payload of [null,{},Array.from({length:2001},(_,i)=>historyLegacy(i))]) {
    const result=await historyReadGraph({find:async stage=>stage==='canonical'?[historyMessage(1)]:payload});
    assert.equal(result.statusCode,503);assert.equal(result.payload.messages,undefined);
  }
  const flow=historyGraph();
  const result=historyEvaluate(flow,historyNodeIds.router,{error:{message:'synthetic-private-value'},_stationHistory:{stage:'canonical'},payload:[]});
  assert.deepEqual(result.slice(0,2),[null,null]);assert.equal(JSON.stringify(result[2]).includes('synthetic-private-value'),false);
});
test('default v1 prepare/query/render remain characterized, including old equal-time behavior',()=>{
  const base=historyGraphBase(),patched=historyGraph(base);
  const start={req:{method:'GET',params:{communityId:'community'},query:{limit:'1',beforeTs:'2000'},headers:{}},_verifiedCommunityActor:{id:'actor'}};
  const old=structuredClone(start),current=structuredClone(start);
  assert.deepEqual(historyEvaluate(patched,'prepare',current),historyEvaluate(base,'prepare',old));
  old.payload=[historyCommunity()];current.payload=[historyCommunity()];
  const oldQuery=historyEvaluate(base,'query',old),currentQuery=historyEvaluate(patched,'query',current);
  assert.deepEqual(current.payload.recordType,{$ne:'READ_COMMAND'});old.payload.recordType={$ne:'READ_COMMAND'};
  assert.deepEqual(currentQuery,oldQuery);
  old.payload=[historyMessage(1),historyMessage(2)];current.payload=[historyMessage(1),historyMessage(2)];
  assert.deepEqual(historyEvaluate(patched,'render',current),historyEvaluate(base,'render',old));
  assert.equal(current.payload.nextBeforeTs,1000);assert.equal(current.payload.messages.length,1);
  assert.equal(patched.find(node=>node.id==='render').func,base.find(node=>node.id==='render').func.replace(".filter((item) => item && item.archived !== true && (item.stationMessageOwner !== 1 || item.state === 'COMMITTED'))",".filter((item) => item && item.recordType !== 'READ_COMMAND' && item.archived !== true && (item.stationMessageOwner !== 1 || item.state === 'COMMITTED'))"));
  assert.equal(JSON.stringify(patched.filter(node=>!['prepare','query','render',...Object.values(historyNodeIds)].includes(node.id))),JSON.stringify(base.filter(node=>!['prepare','query','render'].includes(node.id))));
});
test('v2 malformed query rejects before a Mongo request; old unknown parameters remain old behavior',()=>{
  const flow=historyGraph();
  const initial=historyEvaluate(flow,'prepare',{req:{params:{communityId:'community'},query:{historyVersion:'2'}}});
  assert.deepEqual(initial[0].payload,[{id:'community',archived:{$ne:true}},{limit:2,maxTimeMS:3000}]);
  assert.equal(initial[2],null);
  for(const query of [{historyVersion:'1'},{historyVersion:'2',beforeId:historyMessage(1).id},{historyVersion:'2',limit:'51'},{historyVersion:'2',beforeTs:'0'}]) {
    const result=historyEvaluate(flow,'prepare',{req:{params:{communityId:'community'},query}});
    assert.equal(result[0],null);assert.equal(result[1].statusCode,400);assert.equal(result[2],null);
  }
});
test('guarded composer rejects graph drift, foreign clients and every reserved pre-existing reference',()=>{
  for(const mutate of [
    flow=>flow.find(n=>n.id==='messages').clientNode='foreign',
    flow=>flow.find(n=>n.id==='query').func='return msg;',
    flow=>flow.find(n=>n.id==='community').operation='aggregate',
    flow=>flow.push({id:'bypass',type:'link out',links:['query']}),
    flow=>flow.push({id:'dangling',scope:[historyNodeIds.canonical]}),
    flow=>flow.push({id:'dangling',z:historyNodeIds.router}),
    flow=>flow.push({id:'dangling',wires:[[historyNodeIds.legacy]]}),
  ]) {const base=historyGraphBase();mutate(base);assert.throws(()=>historyGraph(base));}
  const bytes=JSON.stringify(historyGraphBase());
  assert.throws(()=>patchStationMessageHistory(bytes,{mongoClientId:'mongo',expectedFlowSha256:'0'.repeat(64)}),/PREIMAGE/);
  const valid=crypto.createHash('sha256').update(bytes).digest('hex');
  assert.throws(()=>patchStationMessageHistory(bytes,{mongoClientId:'missing',expectedFlowSha256:valid}),/CLIENT/);
});
test('composer rejects broad or ambiguous observers with the exact updated preimage SHA',()=>{
  for(const type of ['catch','complete']) for(const config of [
    {},{scope:null},{scope:[]},{scope:'all'},{scope:'global'},
    {scope:['prepare']},{scope:['query']},{scope:['community']},
    {scope:['missing']},{scope:['render','render']},{scope:[null]},
    {scope:['render'],target:'all'},{scope:['render'],all:true},
  ]) for(const z of ['tab','other-tab',undefined]) {
    const base=historyGraphBase();base.push({id:'observer',type,z,wires:[['debug']],...config});
    // historyGraph computes SHA from these exact modified bytes, so this proves
    // observer custody validation rather than rejection of a stale input hash.
    assert.throws(()=>historyGraph(base),{message:'HISTORY_OBSERVER_SCOPE_UNSAFE'});
  }
  for(const type of ['catch','complete']) for(const target of Object.values(historyNodeIds)) {
    const base=historyGraphBase();base.push({id:'observer',type,z:'tab',scope:[target],wires:[['debug']]});
    assert.throws(()=>historyGraph(base),{message:'HISTORY_RESERVED_REFERENCE'});
  }
});
test('composer preserves proven unrelated explicitly scoped catch and complete observers',()=>{
  const base=historyGraphBase();
  const observers=[
    {id:'unrelated-catch',type:'catch',z:'tab',scope:['messages'],uncaught:false,wires:[['debug']],name:'Unrelated old read'},
    {id:'unrelated-complete',type:'complete',z:'tab',scope:['render'],wires:[['debug']]},
  ];
  base.push(...observers);
  const patched=historyGraph(base);
  for(const observer of observers)assert.deepEqual(patched.find(node=>node.id===observer.id),observer);
});

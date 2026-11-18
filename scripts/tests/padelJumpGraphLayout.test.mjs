import test from 'node:test';
import assert from 'node:assert/strict';
import observedHttp from './fixtures/communityProfileHttpObservedV1.json' with {type:'json'};
import {createHash} from 'node:crypto';
import {addEventAdmissionRoutes} from '../lib/eventJumpAdmission.mjs';
import {addCommunityPolicyAuth} from '../lib/communityPolicyAuth.mjs';
import {addExhibitionRegistrationRetention} from '../lib/exhibitionRegistrationRetention.mjs';

const admission='community-event-admission-v1';
const auth='community-policy-verified-actor-v1';
const retention='community-exhibition-retention-v1';
const base=()=>[{id:'tab',type:'tab'},{id:'mongo',type:'mongodb4',z:'tab',collection:'lk_communities',operation:'find',clientNode:'synthetic-client',wires:[]}];
const move=(nodes,prefix)=>nodes.map((node,index)=>node.id.startsWith(prefix)?{...node,x:index*20,y:index*30}:node);

test('only the exact observed profile HTTP predecessor restores both pinned config fields',()=>{
  assert.equal(observedHttp.sourceFlowSha256,'f3b860cadac4b0ea74acb5a112daa99adc151f03b83f5dc728634beb0567c78f');
  assert.equal(createHash('sha256').update(JSON.stringify(observedHttp.node)).digest('hex'),'77daa395a3b6df9b26e4f87016f96c5d5c599f859277d2b7a10321e66bd5259e');
  const graph=addCommunityPolicyAuth(addEventAdmissionRoutes(base()));
  const index=graph.findIndex(n=>n.id===auth+'-http'),expected=structuredClone(graph[index]);
  graph[index]=structuredClone(observedHttp.node);
  const result=addCommunityPolicyAuth(graph),upgraded=result.find(n=>n.id===auth+'-http');
  assert.deepEqual(upgraded,{...observedHttp.node,requestTimeout:expected.requestTimeout,followRedirects:false});
  assert.deepEqual(addCommunityPolicyAuth(result),result);
  for(const mutate of [
    value=>{value.url='https://wrong.example.invalid';},
    value=>{value.method='post';},
    value=>{value.senderr=false;},
    value=>{value.followRedirects=true;},
    value=>{value.requestTimeout='10000';},
    value=>{value.headers=[{keyValue:'Authorization',valueValue:'synthetic-canary'}];},
  ]) {
    const changed=structuredClone(graph);mutate(changed[index]);
    assert.throws(()=>addCommunityPolicyAuth(changed),/COMMUNITY_AUTH_SUBFLOW_DRIFT/);
  }
});

test('retention worker preserves editor layout while rejecting writer, clock, audit and scope drift',()=>{
  const graph=move(addExhibitionRegistrationRetention(addEventAdmissionRoutes(base())),retention);
  assert.deepEqual(addExhibitionRegistrationRetention(graph),graph);
  for(const mutate of [
    nodes=>{nodes.find(n=>n.id===retention+'-write').clientNode='foreign';},
    nodes=>{nodes.find(n=>n.id===retention+'-write').collection='foreign';},
    nodes=>{nodes.find(n=>n.id===retention+'-tick').repeat='1';},
    nodes=>{nodes.find(n=>n.id===retention+'-audit').func+='\n// drift';},
    nodes=>{nodes.find(n=>n.id===retention+'-catch').scope=[];},
    nodes=>{nodes.find(n=>n.id===retention+'-plan').libs=[];},
    nodes=>{nodes.find(n=>n.id===retention+'-verify').wires=[['foreign']];},
    nodes=>{nodes.find(n=>n.id===retention+'-write').d=true;},
    nodes=>{nodes.find(n=>n.id===retention+'-plan').y='0';},
  ]) {
    const changed=structuredClone(graph);mutate(changed);
    assert.throws(()=>addExhibitionRegistrationRetention(changed),/EXHIBITION_RETENTION_GRAPH_DRIFT/);
  }
});

test('auth definitions and ingress budget preserve layout without accepting runtime drift',()=>{
  const graph=move(addCommunityPolicyAuth(addEventAdmissionRoutes(base())),auth);
  assert.deepEqual(addCommunityPolicyAuth(graph),graph);
  for(const mutate of [
    nodes=>{nodes.find(n=>n.id===auth+'-prepare').func+='\n// drift';},
    nodes=>{nodes.find(n=>n.id===auth+'-http').followRedirects=true;},
    nodes=>{nodes.find(n=>n.id===auth+'-http').requestTimeout='120000';},
    nodes=>{nodes.find(n=>n.id===auth+'-http-catch').scope=[];},
    nodes=>{nodes.find(n=>n.id===auth+'-prepare').libs=[{var:'unsafe',module:'unsafe'}];},
    nodes=>{nodes.find(n=>n.id===auth+'-prepare').z='foreign';},
    nodes=>{nodes.find(n=>n.id===auth+'-prepare').d=true;},
    nodes=>{nodes.find(n=>n.id===auth+'-prepare').x='0';},
    nodes=>{nodes.find(n=>n.id===auth+'-budget-'+admission+'-in').func+='\n// drift';},
    nodes=>{nodes.find(n=>n.id===auth).out[0].wires[0].id='foreign';},
  ]) {
    const changed=structuredClone(graph);mutate(changed);
    assert.throws(()=>addCommunityPolicyAuth(changed),/COMMUNITY_AUTH_(SUBFLOW|ADMISSION_BUDGET)_DRIFT/);
  }
});

test('admission accepts and preserves only finite editor coordinates after a Node-RED editor save',()=>{
  const graph=move(addEventAdmissionRoutes(base()),admission);
  assert.deepEqual(addEventAdmissionRoutes(graph),graph);
  for(const mutate of [
    nodes=>{nodes.find(n=>n.id===admission+'-prepare').func+='\n// semantic drift';},
    nodes=>{nodes.find(n=>n.id===admission+'-in').wires=[['foreign']];},
    nodes=>{nodes.find(n=>n.id===admission+'-find').clientNode='foreign';},
    nodes=>{nodes.find(n=>n.id===admission+'-prepare').d=true;},
    nodes=>{nodes.find(n=>n.id===admission+'-prepare').x='0';},
    nodes=>{nodes.find(n=>n.id===admission+'-prepare').y=null;},
    nodes=>{nodes.find(n=>n.id===admission+'-prepare').x=Infinity;},
  ]) {
    const changed=structuredClone(graph);mutate(changed);
    assert.throws(()=>addEventAdmissionRoutes(changed),/EVENT_ADMISSION_GRAPH_DRIFT/);
  }
});

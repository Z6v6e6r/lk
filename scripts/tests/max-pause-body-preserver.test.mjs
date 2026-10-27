import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { codePointGraphSha256, createMaxPauseBodyPreserver } from '../nodered_reviewed_flow_deploy/max-pause-body-preserver.mjs';
const ids = ['e75785ffa19c2e20', 'c1ecd06ce451751b'];
const httpId = 'lk_booked_operation_provider_request_20261021';
const rev = 'synthetic-opaque-native-revision';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const request = {url:'http://127.0.0.1:18801/flows', method:'POST', apiVersion:'v2', deploymentType:'nodes'};
function graph() {
 const result = [{id:ids[0],type:'inject',repeat:'5',once:true,unicode:'ёж 🥎'},
  {id:ids[1],type:'inject',d:false,repeat:'5',once:true},
  {id:httpId,type:'http request',requestTimeout:'15000',unknown:{z:['x','y']}}];
 for(let i=0;i<4854;i++) result.push({id:`n${String(i).padStart(4,'0')}`,type:'debug',x:i});
 return result;
}
function seal(sourceGraph=graph()) {return {sourceGraph,expectedSourceCodePointSha256:codePointGraphSha256(sourceGraph),expectedPreRevisionSha256:hash(rev),operationId:'max-pause-rehearsal'};}
function body() {const flows=graph();for(const id of ids) flows.find(n=>n.id===id).d=true;delete flows.find(n=>n.id===httpId).requestTimeout;return {rev,flows};}
const gate=()=>createMaxPauseBodyPreserver(seal());

test('one omitted non-target field is restored with only the two approved disabled flags',()=>{
 const input=body(), before=JSON.stringify(input), out=gate()({request,postBody:input}), parsed=JSON.parse(out.postDataText);
 const expected=graph();for(const id of ids)expected.find(n=>n.id===id).d=true;
 assert.deepEqual(parsed,{rev,flows:expected});assert.equal(JSON.stringify(input),before);
 assert.equal(out.audit.restoredRequestTimeoutCount,1);assert.equal(out.audit.forwardedBodySha256,hash(out.postDataText));
 assert.equal(JSON.stringify(out.audit).includes(rev),false);assert.equal(JSON.stringify(out.audit).includes('ёж'),false);
});
test('an already preserved field is accepted without another change',()=>{
 const input=body();input.flows.find(n=>n.id===httpId).requestTimeout='15000';
 assert.equal(gate()({request,postBody:input}).audit.restoredRequestTimeoutCount,0);
});
test('object-key and top-level node order are immaterial but opaque revision remains exact',()=>{
 const input=body();input.flows.reverse();input.flows=input.flows.map(n=>Object.fromEntries(Object.entries(n).reverse()));
 const out=gate()({request,postBody:input});assert.equal(JSON.parse(out.postDataText).rev,rev);
 assert.equal(out.audit.postBodyCodePointSha256,codePointGraphSha256(JSON.parse(out.postDataText).flows));
});
test('source is cloned when sealed and audit cannot mutate later factory constants',()=>{
 const source=graph(),run=createMaxPauseBodyPreserver(seal(source));source[4].x=999;
 const out=run({request,postBody:body()});out.audit.pausedInjectIds.length=0;
 assert.deepEqual(gate()({request,postBody:body()}).audit.pausedInjectIds,ids);
});
for(const [label,changed] of [
 ['origin',{url:'https://example.test/flows'}], ['port',{url:'http://127.0.0.1:18802/flows'}],
 ['query',{url:request.url+'?force=true'}], ['fragment',{url:request.url+'#force'}],
 ['userinfo',{url:'http://actor@127.0.0.1:18801/flows'}], ['method',{method:'GET'}],
 ['api-version',{apiVersion:'v1'}], ['full-deploy',{deploymentType:'full'}], ['flow-deploy',{deploymentType:'flows'}],
]) test(`request ${label} fails closed and consumes the gate`,()=>{
 const run=gate();assert.throws(()=>run({request:{...request,...changed},postBody:body()}),/REQUEST/);
 assert.throws(()=>run({request,postBody:body()}),/CONSUMED/);
});
for(const [label,mutate] of [
 ['wrong-revision',b=>{b.rev='another-synthetic-revision';}], ['extra-envelope',b=>{b.extra=true;}],
 ['missing-revision',b=>{delete b.rev;}], ['missing-node',b=>{b.flows.pop();}],
 ['extra-node',b=>{b.flows.push({id:'extra',type:'debug'});}], ['duplicate-id',b=>{b.flows[4].id=b.flows[3].id;}],
 ['foreign-node-property',b=>{b.flows[3].x=999;}], ['foreign-field-drop',b=>{delete b.flows[3].type;}],
 ['one-disabled-flag-only',b=>{delete b.flows.find(n=>n.id===ids[1]).d;}],
 ['extra-target-change',b=>{b.flows.find(n=>n.id===ids[0]).repeat='10';}],
 ['null-timeout',b=>{b.flows.find(n=>n.id===httpId).requestTimeout=null;}],
 ['numeric-timeout',b=>{b.flows.find(n=>n.id===httpId).requestTimeout=15000;}],
 ['changed-timeout',b=>{b.flows.find(n=>n.id===httpId).requestTimeout='30000';}],
 ['nested-array-reorder',b=>{b.flows.find(n=>n.id===httpId).unknown.z.reverse();}],
]) test(`payload ${label} is rejected before transmission`,()=>{
 const run=gate(),input=body();mutate(input);assert.throws(()=>run({request,postBody:input}));
 assert.throws(()=>run({request,postBody:body()}),/CONSUMED/);
});
for(const [label,mutate] of [
 ['digest',s=>{s.expectedSourceCodePointSha256='0'.repeat(64);}],
 ['revision-seal',s=>{s.expectedPreRevisionSha256='invalid';}], ['operation-id',s=>{s.operationId='unsafe\nlog';}],
 ['duplicate-source',s=>{s.sourceGraph[4].id=s.sourceGraph[3].id;s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
 ['empty-source-id',s=>{s.sourceGraph[4].id='';s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
 ['already-disabled',s=>{s.sourceGraph[0].d=true;s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
 ['wrong-source-type',s=>{s.sourceGraph[0].type='debug';s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
 ['wrong-source-repeat',s=>{s.sourceGraph[0].repeat='10';s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
 ['wrong-source-once',s=>{s.sourceGraph[0].once=false;s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
 ['wrong-source-timeout',s=>{s.sourceGraph[2].requestTimeout='30000';s.expectedSourceCodePointSha256=codePointGraphSha256(s.sourceGraph);}],
]) test(`sealed ${label} cannot be admitted`,()=>{const input=seal();mutate(input);assert.throws(()=>createMaxPauseBodyPreserver(input));});
test('second valid request is refused',()=>{const run=gate();run({request,postBody:body()});assert.throws(()=>run({request,postBody:body()}),/CONSUMED/);});

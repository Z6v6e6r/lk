import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { patchStationNotificationFeed, notificationFeedIds as ids } from '../lib/stationNotificationFeedSource.mjs';
import { notificationFixture, publications, recipients, eligibility, signedMessage, authEnvironment, feedMemory } from './helpers/stationNotificationHarness.mjs';
const base=()=>[{id:'tab',type:'tab',label:'Synthetic station owner'},{id:'mongo',type:'mongodb4-client'},{id:'legacy',type:'function',z:'tab',func:'return msg;',outputs:1,wires:[[]]}];
function compose(flow=base()){const bytes=JSON.stringify(flow);return patchStationNotificationFeed(bytes,{expectedFlowSha256:crypto.createHash('sha256').update(bytes).digest('hex'),mongoClientId:'mongo',tabId:'tab'});}
const evaluate=(flow,id,msg)=>new Function('msg','env','nodeCrypto',flow.find(n=>n.id===id).func)(msg,{get:k=>authEnvironment[k]},crypto);
async function execute(f,mode,body,change){const flow=compose(),msg=signedMessage(mode,body),db=feedMemory(f.db);let outputs=evaluate(flow,ids[mode+'Begin'],msg);for(let n=0;n<5;n++){if(outputs[3])return outputs[3];const port=outputs.findIndex(Boolean),current=outputs[port];assert.ok(port>=0&&port<=2);const store=flow.find(x=>x.id===[ids.community,ids.messages,ids.events][port]);assert.equal(store.operation,'aggregate');current.payload=await db.collection(store.collection).aggregate(...current.payload).toArray();change?.(current);outputs=evaluate(flow,ids.router,current);}throw Error('feed did not terminate');}
test('additive composer preserves original nodes and executes actual auth/read/router without write outputs',async()=>{
 const old=base(),flow=compose(old);assert.deepEqual(flow.slice(0,old.length),old);assert.equal(flow.filter(n=>n.type==='mongodb4').every(n=>n.operation==='aggregate'),true);
 const f=await notificationFixture();
 for(const [mode,body]of [['publications',publications(f.c)],['recipients',recipients(f.c,f.records[0])],['eligibility',eligibility(f.c,f.records[0])]]){const result=await execute(f,mode,body);assert.equal(result.statusCode,200);assert.equal('_stationNotification' in result,false);assert.equal('error' in result,false);assert.equal(JSON.stringify(result.payload).includes('Synthetic private body'),false);assert.equal(result.headers['Cache-Control'],'no-store');}
});
test('actual composed router drops DB errors and final changed access without debug/body leakage',async()=>{
 const f=await notificationFixture(),body=eligibility(f.c,f.records[0]);const result=await execute(f,'eligibility',body,msg=>{if(msg._stationNotification.step==='events')f.c.archived=true;});assert.equal(result.statusCode,503);assert.equal(JSON.stringify(result.payload).includes('recipient-001'),false);
 const flow=compose(),msg=signedMessage('publications',publications({...f.c,archived:false}));let outputs=evaluate(flow,ids.publicationsBegin,msg);const current=outputs[0];current.error={message:'SENSITIVE Synthetic private body'};current.payload=[];outputs=evaluate(flow,ids.router,current);assert.equal(outputs[3].statusCode,503);assert.equal(JSON.stringify(outputs[3].payload).includes('SENSITIVE'),false);
});
test('reserved wires/links/scopes/z, overlapping routes and broad observers reject with correctly updated SHA',()=>{
 for(const extra of [{id:'x',type:'function',wires:[[ids.router]]},{id:'x',type:'link out',links:[ids.router]},{id:'x',type:'function',z:ids.router},{id:'x',type:'catch',scope:[ids.community]},{id:'x',type:'catch',scope:null},{id:'x',type:'complete',scope:[]},{id:'x',type:'complete'},{id:'x',type:'catch',scope:['legacy'],scopeMode:'all'},{id:'x',type:'http in',method:'post',url:'/lk/internal/station-notifications/v1/:operation'},{id:'x',type:'http in',method:'all',url:'/*'}])assert.throws(()=>compose([...base(),extra]));
 assert.doesNotThrow(()=>compose([...base(),{id:'x',type:'catch',scope:['legacy'],z:'tab',wires:[[]]}]));
 assert.throws(()=>compose(base().map(n=>n.id==='mongo'?{...n,type:'wrong'}:n)),/TARGET/);
});
test('unverified request cannot reach any Mongo output; public LK routes are untouched',async()=>{
 const f=await notificationFixture(),flow=compose(),msg=signedMessage('publications',publications(f.c));delete msg.req.headers['x-station-notification-delegation'];const outputs=evaluate(flow,ids.publicationsBegin,msg);assert.deepEqual(outputs.slice(0,3),[null,null,null]);assert.equal(outputs[3].statusCode,401);assert.equal(flow.filter(n=>n.type==='http in').every(n=>n.url.startsWith('/lk/internal/station-notifications/v1/')),true);
});

test('actual composed final response refuses expired original proof after successful message and event reads',async()=>{
 const f=await notificationFixture();const result=await execute(f,'publications',publications(f.c),msg=>{if(msg._stationNotification.step==='events')msg._stationNotification.deadlineMs=Date.now()-1;});assert.equal(result.statusCode,503);assert.equal('items' in result.payload,false);
});

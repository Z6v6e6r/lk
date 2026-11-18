// LOCAL source-integration only: official HTTP node, owned RED/got stubs, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {addCommunityPolicyAuth, COMMUNITY_AUTH_PREPARE, COMMUNITY_AUTH_RESPONSE} from '../../lib/communityPolicyAuth.mjs';
const native=createRequire(import.meta.url);
const source=fs.readFileSync(new URL('./node-red-4.0.9/21-httprequest.source',import.meta.url),'utf8');
const sourceSha256=crypto.createHash('sha256').update(source).digest('hex');
assert.equal(sourceSha256,'173baaaea541b5a8c00e2aeabfe25fbd1cf899946b53fe785c3fa54abbfacced');
const mode=process.argv[2];assert.ok(['deadline','transport-error'].includes(mode));
const graph=addCommunityPolicyAuth([{id:'in',type:'http in',z:'tab',method:'get',url:'/lk/communities',wires:[['target']]},{id:'target',type:'function',z:'tab',name:'Target',func:'return msg;',wires:[]}]);
const config=graph.find(n=>n.id==='community-policy-verified-actor-v1-http');
let transport='hang', Request;
const calls=[],sends=[],errors=[];
const forbidden=()=>{throw new Error('FIXTURE_NETWORK_OR_UNEXPECTED_PATH');};
const fakeGot=(_url,options)=>{
 calls.push(options);
 return transport==='reject'?Promise.reject(Object.assign(new Error('PRIVATE_TRANSPORT_SENTINEL'),{code:'ETIMEDOUT'})):new Promise(()=>{});
};
const deps={
 './lib/proxyHelper':{getProxyForUrl:()=>null,parseUrl:forbidden},
 'tough-cookie':{CookieJar:class CookieJar{}},'hpagent':{HttpProxyAgent:class{},HttpsProxyAgent:class{}},
 'form-data':class{},'uuid':{v4:()=> 'fixture'},
 'http':{request:forbidden,Agent:class{}},'https':{request:forbidden,Agent:class{}},
 'mustache':{render:forbidden},'cookie':{parse:forbidden,serialize:forbidden},'hash-sum':()=> 'fixture-hash',
 'crypto':native('node:crypto'),'url':native('node:url'),'querystring':native('node:querystring'),
};
const module={exports:{}};
const RED={settings:{},log:{warn:forbidden},_:value=>value,nodes:{
 createNode(node){
  const emitter=new EventEmitter();node.on=emitter.on.bind(emitter);node.emit=emitter.emit.bind(emitter);
  node.credentials={};node.status=()=>{};node.metric=()=>false;node.warn=forbidden;
  // Catch receives an error-time snapshot, not later HTTP-node mutations.
  node.error=(error,msg)=>errors.push({error,msg:structuredClone(msg)});
 },
 registerType(name,ctor){assert.equal(name,'http request');Request=ctor;},getNode:forbidden,
}};
const context=vm.createContext({module,require:name=>{assert.ok(Object.hasOwn(deps,name),'unexpected dependency '+name);return deps[name];},process:{hrtime:process.hrtime,env:{}},Buffer});
const gotModule=new vm.SyntheticModule(['got'],function(){this.setExport('got',fakeGot);},{context});
await gotModule.link(forbidden);await gotModule.evaluate();
new vm.Script(source,{filename:'official-node-red-4.0.9-http-request.js',importModuleDynamically:async name=>{assert.equal(name,'got');return gotModule;}}).runInContext(context);
await module.exports(RED);
const node=new Request(config);
const dispatch=msg=>node.emit('input',msg,result=>sends.push(result),()=>{});
const run=(code,msg)=>vm.runInNewContext('(function(msg){'+code+'\n})(msg)',{msg});
const report={evidence:'LOCAL_OFFICIAL_HTTP_NODE_WITH_STUB_GOT',sourceSha256,providerCalls:0,productionAccess:false};
if(mode==='deadline') {
 dispatch({method:'GET',url:'https://fixture.invalid/profile'});
 assert.equal(calls.at(-1).timeout.request,120000,'negative control: node config alone is ignored');
 for(const original of [{},{requestTimeout:undefined},{requestTimeout:250000}]) {
  const msg={...original,req:{headers:{authorization:'Bearer fixture'}},payload:{kept:true}};
  assert.equal(run(COMMUNITY_AUTH_PREPARE,msg)[0],msg);dispatch(msg);
  const effective=calls.at(-1);
  assert.equal(effective.timeout.request,10000);assert.equal(effective.retry.limit,0);assert.equal(effective.followRedirect,false);
  msg.statusCode=200;msg.payload={id:'fixture-player'};
  const restored=run(COMMUNITY_AUTH_RESPONSE,msg)[0];
  assert.equal(Object.hasOwn(restored,'requestTimeout'),Object.hasOwn(original,'requestTimeout'));
  assert.equal(restored.requestTimeout,original.requestTimeout);
 }
 Object.assign(report,{negativeControlEffectiveTimeout:calls[0].timeout.request,preparedEffectiveTimeout:calls.at(-1).timeout.request,retryLimit:calls.at(-1).retry.limit,followRedirect:calls.at(-1).followRedirect});
} else {
 transport='reject';
 const msg={req:{headers:{authorization:'Bearer fixture'}},statusCode:401,requestTimeout:250000,payload:{kept:true}};
 run(COMMUNITY_AUTH_PREPARE,msg);dispatch(msg);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(errors.length,1);assert.equal(sends.length,0,'senderr:true emits only to Catch');
 const catches=graph.filter(n=>n.type==='catch'&&n.z===config.z&&n.scope?.includes(config.id));
 assert.equal(catches.length,1,'profile transport error must have an owned scoped recovery');
 const recovery=graph.find(n=>n.id===catches[0].wires[0][0]);
 assert.equal(recovery.type,'function');assert.deepEqual(recovery.wires,[['community-policy-verified-actor-v1-response']]);
 const captured=errors[0].msg;captured.error={message:'PRIVATE_TRANSPORT_SENTINEL',source:{id:config.id}};
 const sanitized=run(recovery.func,captured);
 assert.equal(sanitized.statusCode,503);assert.equal(sanitized.payload,null);assert.equal(Object.hasOwn(sanitized,'error'),false);
 const restored=run(COMMUNITY_AUTH_RESPONSE,sanitized)[0];
 assert.equal(restored._communityPolicyAuthFailure,'UNAVAILABLE','stale original401 must not masquerade as invalid credentials');
 assert.equal(restored.requestTimeout,250000);assert.equal(restored.statusCode,401);
 assert.deepEqual(restored.payload,{kept:true});assert.equal(Object.hasOwn(restored,'error'),false);
 Object.assign(report,{nativeErrors:errors.length,nativeErrorSends:sends.length,scopedRecovery:'UNAVAILABLE',restoredTimeout:restored.requestTimeout});
}
console.log(JSON.stringify(report));

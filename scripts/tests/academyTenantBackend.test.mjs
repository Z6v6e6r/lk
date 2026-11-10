import test from 'node:test';
import assert from 'node:assert/strict';
import { academyTenantRuntime as run } from '../lib/academyTenantBackend.mjs';
import { buildAcademyTenantNodes, addAcademyTenantFlow } from '../patch_nodered_academy_flow.mjs';
import { ACADEMY_TENANT_CONTRACT as contract } from '../../src/services/academyTenantContract.ts';
const env={get:()=>undefined};
const issuer='https://kc.vivacrm.ru/realms/clients';
function token(overrides={}){const claims={sub:'fixture-subject',tenant_key:'005JDA',iss:issuer,azp:'widget',scope:'openid',...overrides};return 'fixture.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.fixture';}
function start(action='communities',body={},claims={}){return{req:{method:action==='communities'?'GET':'POST',headers:{authorization:'Bearer '+token(claims),origin:'https://lk-reserve.89-108-64-209.sslip.io'},query:{clientId:'foreign-client',phone:'foreign-phone'}},payload:body};}
function verified(action,body={}){const msg=start(action,body);assert.equal(run('prepare',msg,env,action,contract)[0],msg);msg.statusCode=200;msg.payload={sub:'fixture-subject'};assert.equal(run('userinfo',msg,env,null,contract)[0],msg);msg.statusCode=200;msg.payload={id:'verified-client'};return msg;}
const consent={schemaVersion:1,documentSetVersion:contract.documentSetVersion,documents:contract.documents.map(d=>({...d,accepted:true})),authMethod:'sms',acceptedAtClient:new Date().toISOString()};
test('new tenant rejection filters never authorize a Mongo operation before two provider reads',()=>{
 const msg=start();assert.equal(run('prepare',msg,env,'communities',contract)[0],msg);
 assert.equal(msg.url,issuer+'/protocol/openid-connect/userinfo');assert.equal(msg.requestTimeout,5000);assert.equal(msg.followRedirects,false);
 msg.statusCode=200;msg.payload={sub:'fixture-subject'};run('userinfo',msg,env,null,contract);
 assert.equal(msg.url,'https://api.vivacrm.ru/end-user/api/v1/005JDA/profile');
 assert.equal(msg._academy.clientId,undefined);
});
test('PadlHub, wrong client/issuer, unknown subject and missing scope fail closed',()=>{
 for(const overrides of [{tenant_key:'iSkq6G'},{tenant_key:null},{azp:'other'},{iss:'https://other.invalid'},{sub:''},{scope:'phone'}]){
  const result=run('prepare',start('communities',{},overrides),env,'communities',contract);
  assert.equal(result[0],null);assert.equal(result[1].statusCode,403);assert.equal(result[1].url,undefined);
 }
 const msg=start();msg.req.headers.authorization='Bearer fixture.'+Buffer.from('null').toString('base64url')+'.fixture';
 assert.equal(run('prepare',msg,env,'communities',contract)[1].statusCode,401);
});
test('invalid userinfo and profile never reach a collection, including forged subject hints',()=>{
 for(const status of [401,403,500]){const msg=start();run('prepare',msg,env,'communities',contract);msg.statusCode=status;msg.payload={sub:'fixture-subject'};assert.equal(run('userinfo',msg,env,null,contract)[0],null);}
 const msg=start();run('prepare',msg,env,'communities',contract);msg.statusCode=200;msg.payload={sub:'another'};assert.equal(run('userinfo',msg,env,null,contract)[1].statusCode,403);
 const denied=verified('communities');denied.statusCode=403;assert.equal(run('operation',denied,env,null,contract).slice(0,5).every(x=>x===null),true);
});
test('consents bind canonical Rodina documents to the verified subject and immutable id',()=>{
 const msg=verified('consent',consent),out=run('operation',msg,env,null,contract);
 assert.equal(out[0],msg);assert.equal(out.slice(1).every(x=>x===null),true);
 assert.deepEqual(msg.payload[2],{upsert:true});assert.equal(msg.payload[1].$set,undefined);
 assert.equal(msg.payload[1].$setOnInsert.tenantKey,'005JDA');assert.equal(msg.payload[1].$setOnInsert.clientId,'verified-client');
 assert.equal(msg._academy.authorization,undefined);assert.equal(msg._academy.body,undefined);assert.equal(msg.headers,undefined);
 const again=verified('consent',consent);run('operation',again,env,null,contract);assert.deepEqual(again.payload[0],msg.payload[0]);
 for(const invalid of [{...consent,documentSetVersion:'2026-07-14'},{...consent,documents:[]},{...consent,documents:consent.documents.map(d=>({...d,url:'https://padlhub.ru/docs'}))}])assert.equal(run('operation',verified('consent',invalid),env,null,contract)[5].statusCode,400);
});
test('community scope comes only from provider profile and response excludes membership data',()=>{
 const msg=verified('communities'),out=run('operation',msg,env,null,contract);assert.equal(out[1],msg);
 assert.deepEqual(msg.payload[0],{tenantKey:'005JDA',members:{$elemMatch:{clientId:'verified-client',status:'ACTIVE'}}});
 assert.equal(msg.payload[1].projection.members,undefined);
 msg.payload=[{_id:'fixture-community',name:'Academy',members:[{phone:'private'}],secret:'private'}];const response=run('response',msg,env,null,contract);
 assert.equal(JSON.stringify(response.payload).includes('private'),false);assert.equal(response.payload.total,1);assert.equal(response.headers.Authorization,undefined);
});
test('push upsert and unregister bind both tenant and verified owner without exposing token',()=>{
 const body={token:'fixture-token-with-enough-characters',platform:'android'};
 const a=verified('register',body);assert.equal(run('operation',a,env,null,contract)[2],a);assert.equal(a.payload[0].subject,'fixture-subject');assert.equal(a.payload[0].tenantKey,'005JDA');
 const b=verified('unregister',body);assert.equal(run('operation',b,env,null,contract)[3],b);assert.deepEqual(b.payload[0],a.payload[0]);
 a.payload={acknowledged:true};const response=run('response',a,env,null,contract);assert.equal(JSON.stringify(response).includes(body.token),false);
 assert.equal(run('operation',verified('register',{...body,platform:'unknown'}),env,null,contract)[5].statusCode,400);
});
test('telemetry drops submitted user and arbitrary payload fields',()=>{
 const msg=verified('events',{event:'client_error',user:{phone:'private'},payload:{token:'private'},page:{href:'private'}});
 assert.equal(run('operation',msg,env,null,contract)[4],msg);assert.deepEqual(Object.keys(msg.payload[0]).sort(),['clientId','event','receivedAt','subject','tenantKey']);
});
test('CORS and catch paths are bounded and never echo upstream secrets',()=>{
 const msg=start();msg.req.headers.origin='https://other.invalid';assert.equal(run('prepare',msg,env,'communities',contract)[1].statusCode,403);
 const err=start();err.req.headers.origin='https://other.invalid';err.error={message:'private'};assert.equal(run('error',err,env,null,contract).statusCode,403);assert.equal(err.error,undefined);
});
test('additive module retains foreign nodes, uses isolated collections and refuses route/id drift',()=>{
 const flow=[{id:'mongo-fixture',type:'mongodb4-client'},{id:'foreign',type:'tab',label:'Existing'}],before=JSON.stringify(flow);
 const result=addAcademyTenantFlow(flow,'mongo-fixture');assert.equal(JSON.stringify(flow),before);assert.equal(result[1],flow[1]);
 const own=result.slice(flow.length),ids=new Set(own.map(n=>n.id));assert.equal(ids.size,own.length);
 const list=own.find(n=>n.type==='mongodb4'&&n.collection===contract.collections.communities);assert.equal(list.operation,'find');assert.equal(list.output,'toArray');
 for(const n of own)for(const wire of(n.wires||[]).flat())assert.ok(ids.has(wire));
 assert.deepEqual([...new Set(own.filter(n=>n.type==='mongodb4').map(n=>n.collection))].sort(),Object.values(contract.collections).sort());
 for(const n of own.filter(n=>n.type==='function'))assert.doesNotThrow(()=>new Function('msg','env',n.func));
 assert.equal(addAcademyTenantFlow(result,'mongo-fixture'),result);
 const drift=structuredClone(result);drift.find(n=>n.type==='function').func+='\n// foreign change';assert.throws(()=>addAcademyTenantFlow(drift,'mongo-fixture'),/drifted/);
 assert.throws(()=>addAcademyTenantFlow([...flow,{type:'http in',method:'post',url:contract.namespace+'/events'}],'mongo-fixture'),/collision/);
 assert.throws(()=>buildAcademyTenantNodes(''),/Mongo/);
});

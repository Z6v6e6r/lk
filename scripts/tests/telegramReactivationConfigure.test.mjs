import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, mock } from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePlan, decodeStore, chooseSession, buildUpdate, configure, loopbackRequest, controllerFingerprint, mongoFingerprint } from '../telegram_reactivation/configure_cloud.mjs';

function encrypted(value, secret) {
  const iv = Buffer.alloc(16,7);
  const c = crypto.createCipheriv('aes-256-ctr',crypto.createHash('sha256').update(secret).digest(),iv);
  return {$:iv.toString('hex') + c.update(JSON.stringify(value),'utf8','base64') + c.final('base64')};
}
function fixture() {
  const func='return; // synthetic offline controller';
  const controller={id:'controller',type:'function',z:'target',func,initialize:'',finalize:'',libs:[]};
  const plan={userDir:'/private/offline-fixture',port:1880,adminRoot:'/test',username:'test_operator',
    flowId:'target',controllerId:'controller',controllerHash:controllerFingerprint(controller),mongoId:'mongo',botConfigId:'bot',botId:'1000',database:'fixture'};
  const snapshot={rev:'synthetic-revision',flows:[
    {id:'target',type:'tab',label:'Synthetic',disabled:false,env:[
      {name:'TG_REACTIVATION_SEND_ENABLED',type:'str',value:'false'},
      {name:'TG_REACTIVATION_MONGO_DB',type:'str',value:'fixture'}]},
    controller,
    {id:'button',type:'inject',z:'target',once:false,repeat:'',crontab:''},
    {id:'mongo',type:'mongodb',hostname:'cluster.example.invalid/legacy?retryWrites=true',topology:'dnscluster',connectOptions:'',db:'fixture'},
    {id:'bot',type:'telegram bot'},
    {id:'unrelated',type:'tab',env:[{name:'keep',type:'str',value:'unchanged'}]},
    {id:'global',type:'global-config',env:[]}]};
  const credentials={mongo:{user:'offline user',password:'offline/password'},bot:{token:'1000:'+ 'A'.repeat(32)}};
  plan.mongoHash=mongoFingerprint(snapshot.flows.find(n=>n.id==='mongo'));
  return {plan,snapshot,credentials};
}

test('plan accepts only explicit non-secret target metadata and loopback port',()=>{
  const {plan}=fixture();
  assert.equal(validatePlan(plan),plan);
  for(const extra of [{token:'never'}, {host:'external.invalid'}, {port:0}, {userDir:'relative'},
    {adminRoot:'/x?redirect=y'}, {controllerHash:'missing'}, {flowId:'mongo'}])
    assert.throws(()=>validatePlan({...plan,...extra}),/invalid_setup_plan/);
});

test('encrypted store uses existing core key digest/IV and rejects plaintext or unavailable keys',()=>{
  const clear={mongo:{password:'offline-only-sensitive-sentinel'}};
  const store=encrypted(clear,'existing synthetic key');
  assert.deepEqual(decodeStore(store,['wrong','existing synthetic key']),clear);
  assert.throws(()=>decodeStore(clear,['existing synthetic key']),/encrypted_store_required/);
  assert.throws(()=>decodeStore(store,['wrong']),/^Error: credential_store_unavailable$/);
});

test('only an existing unexpired full-scope session for exact operator is usable',()=>{
  const session={user:'test_operator',scope:'*',accessToken:'offline-bearer',expires:200};
  assert.equal(chooseSession({'offline-bearer':session},'test_operator',100),'offline-bearer');
  for(const value of [null,[],{}, {'offline-bearer':{...session,user:'someone_else'}},
    {'offline-bearer':{...session,scope:'read'}}, {'offline-bearer':{...session,expires:100}},
    {'wrong-key':session}]) assert.throws(()=>chooseSession(value,'test_operator',100),/admin_session_unavailable/);
});

test('update changes only target tab, preserves revision and percent-encodes source credentials',()=>{
  const {plan,snapshot,credentials}=fixture();
  const before=structuredClone(snapshot);
  const result=buildUpdate(snapshot,credentials,plan);
  assert.deepEqual(snapshot,before);
  assert.equal(result.rev,before.rev);
  assert.deepEqual(result.flows.filter(n=>n.id!=='target'),before.flows.filter(n=>n.id!=='target'));
  const target=result.flows.find(n=>n.id==='target');
  assert.deepEqual(Object.keys(target.credentials).sort(),['TG_REACTIVATION_BOT_TOKEN','TG_REACTIVATION_MONGO_URI']);
  const uri=new URL(target.credentials.TG_REACTIVATION_MONGO_URI);
  assert.equal(uri.username,'offline%20user');assert.equal(uri.password,'offline%2Fpassword');
  assert.equal(uri.hostname,'cluster.example.invalid');assert.equal(uri.pathname,'/legacy');
  assert.equal(uri.searchParams.get('retryWrites'),'true');
  assert.equal(target.credentials.TG_REACTIVATION_BOT_TOKEN,credentials.bot.token);
  assert.deepEqual(target.env.slice(-2),[
    {name:'TG_REACTIVATION_MONGO_URI',type:'cred'},{name:'TG_REACTIVATION_BOT_TOKEN',type:'cred'}]);
  const m=structuredClone(snapshot);m.flows.find(n=>n.id==='mongo').hostname='cluster.example.invalid/legacy?authSource=admin&retryWrites=true';
  assert.ok(buildUpdate(m,credentials,{...plan,mongoHash:mongoFingerprint(m.flows.find(n=>n.id==='mongo'))}).flows[0].credentials.TG_REACTIVATION_MONGO_URI.endsWith('?authSource=admin&retryWrites=true'));
});

test('changed runtime code, extra nodes, enabled sender, timers, existing destination secrets and dynamic token all refuse',()=>{
  const {plan,snapshot,credentials}=fixture();
  const mutations=[
    s=>{s.flows[1].func='unexpected';},
    s=>{s.flows[1].initialize="node.warn(env.get('TG_REACTIVATION_BOT_TOKEN'))";},
    s=>{s.flows[1].finalize='unexpected';},
    s=>{s.flows[1].libs=[{var:'anything',module:'unexpected'}];},
    s=>{s.flows.push({id:'extra',type:'function',z:'target',initialize:'unexpected'});},
    s=>{s.flows.push({id:'extra',type:'http in',z:'target'});},
    s=>{s.flows[1].wires=[['outside-target']];},
    s=>{s.flows[0].env[0].value='true';},
    s=>{s.flows[2].once=true;},
    s=>{s.flows[0].env.push({name:'TG_REACTIVATION_BOT_TOKEN',type:'cred'});},
    s=>{s.flows[3].db='other';},
    s=>{s.flows[3].topology='direct';},
    s=>{s.flows[3].connectOptions='authSource=other';},
    s=>{s.flows[3].hostname='cluster.example.invalid';},
    s=>{s.flows[3].hostname='cluster.example.invalid/legacy?unsupported=value';},
    s=>{s.flows[3].hostname='cluster.example.invalid/legacy?w=invalid';},
    s=>{s.flows.push({...s.flows[1]});}
  ];
  for(const mutate of mutations) {const s=structuredClone(snapshot);mutate(s);assert.throws(()=>buildUpdate(s,credentials,plan));}
  for(const c of [{...credentials,target:{keep:'existing'}}, {...credentials,bot:{token:'{dangerousExpression}'}}])
    assert.throws(()=>buildUpdate(snapshot,c,plan));
});

function diskFixture() {
  const f=fixture();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tg-config-offline-'));
  f.plan.userDir=directory;
  const secret='existing synthetic key';
  fs.writeFileSync(path.join(directory,'settings.js'),'module.exports = { credentialSecret: "existing synthetic key" };');
  fs.writeFileSync(path.join(directory,'.config.runtime.json'),JSON.stringify({}));
  fs.writeFileSync(path.join(directory,'flows_cred.json'),JSON.stringify(encrypted(f.credentials,secret)));
  fs.writeFileSync(path.join(directory,'.sessions.json'),JSON.stringify({'offline-bearer':{user:'test_operator',scope:'*',accessToken:'offline-bearer',expires:Date.now()+60000}}));
  return {...f,directory,secret};
}

test('check never writes; apply uses CAS and returns only sanitized receipt with encrypted readback',async()=>{
  const f=diskFixture(),calls=[];
  let current=structuredClone(f.snapshot);
  const request=async(plan,bearer,method,route,body)=>{
    assert.equal(bearer,'offline-bearer');assert.equal(route,'/flows');calls.push(method);
    if(method==='GET') return structuredClone(current);
    assert.equal(body.rev,current.rev);
    const tab=body.flows.find(n=>n.id==='target');
    const all={...f.credentials,target:tab.credentials};
    fs.writeFileSync(path.join(f.directory,'flows_cred.json'),JSON.stringify(encrypted(all,f.secret)));
    current=structuredClone(body);current.rev='new-revision';delete current.flows[0].credentials;
    return {rev:current.rev};
  };
  try {
    assert.deepEqual(await configure(f.plan,{request}),{checked:true,changed:false,targetFlow:'target',sendingEnabled:false});
    assert.deepEqual(calls,['GET']);
    const result=await configure(f.plan,{apply:true,request});
    assert.deepEqual(result,{configured:true,changed:true,targetFlow:'target',sendingEnabled:false,otherNodesUnchanged:true});
    assert.deepEqual(calls,['GET','GET','POST','GET']);
    assert.equal(JSON.stringify(result).includes('offline-bearer'),false);
    assert.equal(JSON.stringify(result).includes('offline/password'),false);
    assert.deepEqual(await configure(f.plan,{apply:true,request}),{configured:true,changed:false,targetFlow:'target',sendingEnabled:false,otherNodesUnchanged:true});
    assert.deepEqual(calls,['GET','GET','POST','GET','GET']);
    assert.deepEqual(fs.readdirSync(f.directory).sort(),['.config.runtime.json','.sessions.json','.tg-reactivation-target-setup.json','flows_cred.json','settings.js'].sort());
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('incidental output from trusted settings loading is never forwarded',async()=>{
  const f=diskFixture();
  fs.writeFileSync(path.join(f.directory,'settings.js'),
    'console.log("private-settings-sentinel"); process.stderr.write("private-settings-sentinel"); module.exports={credentialSecret:"existing synthetic key"};');
  const writes=[];
  const out=mock.method(process.stdout,'write',s=>{writes.push(s);return true;});
  const err=mock.method(process.stderr,'write',s=>{writes.push(s);return true;});
  try {
    await configure(f.plan,{request:async()=>f.snapshot});
    assert.deepEqual(writes,[]);
  } finally {out.mock.restore();err.mock.restore();fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('CAS rejection has no retry and invalid source credentials cannot reach POST',async()=>{
  const f=diskFixture(),calls=[];
  try {
    await assert.rejects(configure(f.plan,{apply:true,request:async(p,b,m)=>{
      calls.push(m);if(m==='GET')return f.snapshot;throw new Error('admin_request_rejected');
    }}),/cloud_configuration_apply_state_uncertain/);
    assert.deepEqual(calls,['GET','POST']);
    fs.writeFileSync(path.join(f.directory,'flows_cred.json'),JSON.stringify(encrypted({},f.secret)));
    calls.length=0;
    await assert.rejects(configure(f.plan,{apply:true,request:async(p,b,m)=>{calls.push(m);return f.snapshot;}}),/source_credentials_unavailable/);
    assert.deepEqual(calls,['GET']);
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('concurrent target-only deploy cannot pass the disabled sender readback',async()=>{
  for(const changedEnv of [false,true]) {
    const f=diskFixture();let read=0,posted;
    try {
      await assert.rejects(configure(f.plan,{apply:true,request:async(p,b,m,r,body)=>{
        if(m==='POST') {posted=structuredClone(body);return {rev:'our-revision'};}
        if(++read===1)return f.snapshot;
        delete posted.flows[0].credentials;
        posted.rev=changedEnv?'our-revision':'someone-else-revision';
        if(changedEnv)posted.flows[0].env.push({name:'TG_REACTIVATION_SEND_ENABLED',type:'str',value:'true'});
        return posted;
      }}),/cloud_configuration_apply_state_uncertain/);
    } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
  }
});

test('POST accepted then transport failed is reconciled by read-only check, never another POST',async()=>{
  const f=diskFixture(),calls=[];
  let current=structuredClone(f.snapshot);
  const request=async(p,b,method,r,body)=>{
    calls.push(method);
    if(method==='GET')return structuredClone(current);
    const tab=body.flows.find(n=>n.id==='target');
    fs.writeFileSync(path.join(f.directory,'flows_cred.json'),JSON.stringify(encrypted({...f.credentials,target:tab.credentials},f.secret)));
    current=structuredClone(body);delete current.flows[0].credentials;current.rev='accepted-unknown-reply';
    throw new Error('private-sensitive-network-message');
  };
  try {
    await assert.rejects(configure(f.plan,{apply:true,request}),/^Error: cloud_configuration_apply_state_uncertain$/);
    assert.deepEqual(calls,['GET','POST']);
    assert.deepEqual(await configure(f.plan,{request}),{configured:true,changed:false,targetFlow:'target',sendingEnabled:false,otherNodesUnchanged:true});
    assert.deepEqual(calls,['GET','POST','GET']);
    current.flows.find(n=>n.id==='unrelated').label='someone else changed this';
    await assert.rejects(configure(f.plan,{request}),/setup_baseline_mismatch/);
    assert.equal(calls.filter(m=>m==='POST').length,1);
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('CLI suppresses arbitrary private parse/filesystem diagnostics',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tg-config-cli-'));
  try {
    const p=path.join(dir,'plan.json');fs.writeFileSync(p,'{"private-sensitive-sentinel":broken');
    const cli=fileURLToPath(new URL('../telegram_reactivation/configure_cloud.mjs',import.meta.url));
    const result=spawnSync(process.execPath,[cli,p,'--check'],{encoding:'utf8'});
    assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.equal(result.stderr,'cloud_configuration_failed\n');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('transport emits exact loopback v2 CAS request and sanitizes rejected provider body',async()=>{
  const {plan}=fixture();
  let actual,data,status=200;
  const mocked=mock.method(http,'request',(options,callback)=>{
    actual=options;
    const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};
    request.end=body=>{
      data=body;
      const response=new EventEmitter();response.statusCode=status;response.setEncoding=()=>{};
      callback(response);
      response.emit('data',status===200?'{}':'private-sensitive-provider-body');response.emit('end');
    };
    return request;
  });
  try {
    await loopbackRequest(plan,'offline-bearer','POST','/flows',{rev:'known',flows:[]});
    assert.equal(actual.hostname,'127.0.0.1');assert.equal(actual.port,1880);assert.equal(actual.path,'/test/flows');
    assert.equal(actual.headers['Node-RED-API-Version'],'v2');assert.equal(actual.headers['Node-RED-Deployment-Type'],'nodes');
    assert.equal(actual.headers.Authorization,'Bearer offline-bearer');assert.deepEqual(JSON.parse(data),{rev:'known',flows:[]});
    status=409;
    await assert.rejects(loopbackRequest(plan,'offline-bearer','POST','/flows',{}),/^Error: admin_request_rejected$/);
  } finally {mocked.mock.restore();}
});

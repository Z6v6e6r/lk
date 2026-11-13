import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { SUBSCRIPTION397_IDS,applySubscription397Body } from '../../lib/subscription397_native_patch.mjs';
import { createSubscription397BodyPreserver,subscription397GraphHash,subscription397OrderedGraphHash } from '../../nodered_reviewed_flow_deploy/subscription397_body_preserver.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const root=process.env.NODERED_RUNTIME_ROOT;
export async function runSubscription397Rehearsal() {
  const require=createRequire(path.join(root,'package.json'));
  assert.equal(require('node-red/package.json').version,'4.0.9');
  const RED=require('node-red'),express=require('express');
  const userDir=fs.mkdtempSync(path.join(os.tmpdir(),'subscription397-runtime-'));
  let providerCalls=0,dbCalls=0,injectInputs=0,outputs=0;
  const logs=[],app=express(),server=http.createServer(app);
  const provider=http.createServer((_req,res)=>{providerCalls++;res.end('unused');});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  RED.init(server,{userDir,flowFile:'flows.json',httpAdminRoot:'/',httpNodeRoot:'/api',disableEditor:true,
    logging:{console:{level:'off'},fixture:{level:'warn',handler:()=>entry=>logs.push(entry)}}});
  RED.nodes.registerType('subscription397-fixture','fixture-db',function(config){RED.nodes.createNode(this,config);this.on('input',()=>dbCalls++);});
  RED.nodes.registerType('subscription397-fixture','fixture-sink',function(config){RED.nodes.createNode(this,config);this.on('input',msg=>{assert.equal(msg.marker,'after');outputs++;});});
  app.use(RED.httpAdmin);app.use('/api',RED.httpNode);
  const deployed=new Set();RED.events.on('runtime-event',e=>{if(e.id==='runtime-deploy')deployed.add(e.payload.revision);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const admin=async(method,body)=>{
    const reply=await new Promise((resolve,reject)=>{
      const request=http.request(base+'/flows',{method,agent:false,headers:{'Content-Type':'application/json','Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes',Connection:'close'}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,text}));
      });request.setTimeout(10000,()=>request.destroy(Error('ISOLATED_ADMIN_TIMEOUT')));request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
    });assert.equal(reply.status,200);const result=JSON.parse(reply.text);
    if(method==='POST'){for(let i=0;i<500&&!deployed.has(result.rev);i++)await new Promise(resolve=>setTimeout(resolve,10));assert(deployed.has(result.rev));}
    return result;
  };
  try{
    await RED.start();
    const before="msg.marker='before';return msg;",after="msg.marker='after';return msg;";
    const artifact=Object.fromEntries(SUBSCRIPTION397_IDS.map(id=>[id,[[before,after]]]));
    const flow=[{id:'tab',type:'tab',label:'isolated S397 rehearsal'},
      {id:'inject',type:'inject',z:'tab',once:false,crontab:'0 0 1 1 *',wires:[[]]},
      {id:'http',type:'http request',z:'tab',method:'GET',ret:'txt',requestTimeout:'25000',url:`http://127.0.0.1:${provider.address().port}`,wires:[[]]},
      {id:'db',type:'fixture-db',z:'tab',nativeOnly:true,wires:[]},{id:'sink',type:'fixture-sink',z:'tab',wires:[]},
      ...SUBSCRIPTION397_IDS.map(id=>({id,type:'function',z:'tab',func:before,initialize:"node.warn('S397_FIXTURE_START');",finalize:"node.warn('S397_FIXTURE_STOP');",outputs:1,wires:[['sink']]}))];
    for(const n of flow)if(n.type!=='tab')Object.assign(n,{x:0,y:0});
    // A fresh Node-RED runtime has no revision until its first flow is stored.
    await admin('POST',{flows:flow});
    const untouched=Object.fromEntries(['inject','http','db','sink'].map(id=>[id,RED.nodes.getNode(id)]));
    for(const n of Object.values(untouched))assert.ok(n);untouched.inject.on('input',()=>injectInputs++);
    const pre=await admin('GET'),candidate=structuredClone(pre.flows);
    for(const id of SUBSCRIPTION397_IDS){const n=candidate.find(n=>n.id===id);n.func=applySubscription397Body(n.func,artifact[id]);}
    const guarded=async(snapshot,next,reverse=false)=>{
      const editor=structuredClone(snapshot.flows).reverse();for(const n of editor){delete n.requestTimeout;delete n.nativeOnly;}
      const pair=g=>sha(JSON.stringify(SUBSCRIPTION397_IDS.map(id=>[id,sha(g.find(n=>n.id===id).func)])));
      const seal={protocol:'source-preserving-v2',planSha256:'b'.repeat(64),attemptSha256:'c'.repeat(64),
        sourceGraphSha256:await subscription397GraphHash(snapshot.flows),candidateGraphSha256:await subscription397GraphHash(next),
        sourceOrderedGraphSha256:await subscription397OrderedGraphHash(snapshot.flows),candidateOrderedGraphSha256:await subscription397OrderedGraphHash(next),
        editorOrderedGraphSha256:await subscription397OrderedGraphHash(editor),preRevisionSha256:sha(snapshot.rev),beforeFunctionSha256:pair(snapshot.flows),afterFunctionSha256:pair(next),reverse};
      const preserve=await createSubscription397BodyPreserver(seal,artifact,snapshot);
      const result=await preserve({request:{url:'http://127.0.0.1:18801/flows',method:'POST',apiVersion:'v2',deploymentType:'nodes'},postBody:{rev:snapshot.rev,flows:editor}});
      assert.deepEqual(JSON.parse(result.postDataText).flows,next);return JSON.parse(result.postDataText);
    };
    await admin('POST',await guarded(pre,candidate));
    for(const[id,original]of Object.entries(untouched))assert.strictEqual(RED.nodes.getNode(id),original,id);
    assert.equal(providerCalls,0);assert.equal(dbCalls,0);assert.equal(injectInputs,0);
    for(const id of SUBSCRIPTION397_IDS)RED.nodes.getNode(id).receive({payload:'synthetic'});
    for(let i=0;i<100&&outputs<2;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(outputs,2);
    await admin('POST',await guarded(await admin('GET'),pre.flows,true));
    const restored=await admin('GET');for(const id of SUBSCRIPTION397_IDS)assert.equal(restored.flows.find(n=>n.id===id).func,before);
    for(const[id,original]of Object.entries(untouched))assert.strictEqual(RED.nodes.getNode(id),original,id);
    for(let i=0;i<500&&logs.filter(l=>l.msg==='S397_FIXTURE_START').length<6;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(logs.filter(l=>l.msg==='S397_FIXTURE_START').length,6);assert.equal(logs.filter(l=>l.msg==='S397_FIXTURE_STOP').length,4);
    assert.equal(providerCalls,0);assert.equal(dbCalls,0);assert.equal(injectInputs,0);
    return{protocol:'subscription397-rehearsal-v1',runtimeVersion:'4.0.9',providerCalls,dbCalls,injectInputs,outputs,unchangedNodeInstances:4,sourceRestored:true};
  }finally{await RED.stop();server.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>provider.close(resolve))]);fs.rmSync(userDir,{recursive:true,force:true});}
}
if(typeof process.send==='function'){
  let failed=false;const failure=error=>{failed=true;process.send?.({protocol:'subscription397-rehearsal-failure-v1',error:String(error?.message||'FIXTURE_ERROR').slice(0,2000)});};
  process.on('uncaughtException',failure);process.on('unhandledRejection',failure);
  try{const result=await runSubscription397Rehearsal();if(!failed)process.send(result);}catch(error){failure(error);}
}

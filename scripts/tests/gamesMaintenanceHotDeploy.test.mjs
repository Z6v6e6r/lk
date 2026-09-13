import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const runtimeRoot=process.env.NODERED_RUNTIME_ROOT;
test('Node-RED 4.0.9 wire-only deployment preserves an already pending provider response', {skip:!runtimeRoot,timeout:30000},async()=>{
  const require=createRequire(path.join(runtimeRoot,'package.json'));
  assert.equal(require('node-red/package.json').version,'4.0.9');
  const RED=require('node-red'), express=require('express');
  const fetch=(url, options={})=>globalThis.fetch(url,{...options,signal:AbortSignal.timeout(10000)});
  const userDir=fs.mkdtempSync(path.join(os.tmpdir(),'games-maintenance-fixture-'));
  const app=express(), server=http.createServer(app);
  let releaseProvider, signalStarted;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  let calls=0;
  const provider=http.createServer((_req,res)=>{calls++;releaseProvider=()=>res.end('provider-result');signalStarted();});
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  RED.init(server,{userDir,flowFile:'flows.json',httpAdminRoot:'/',httpNodeRoot:'/api',
    disableEditor:true,logging:{console:{level:'off'}},functionExternalModules:false});
  app.use(RED.httpAdmin);app.use('/api',RED.httpNode);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const admin=async(method,body)=>{
    const r=await fetch(base+'/flows',{method,headers:{'Content-Type':'application/json','Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes'},body:body?JSON.stringify(body):undefined});
    assert.equal(r.ok,true,await r.clone().text());return r.json();
  };
  try {
    await RED.start();
    const source=[{id:'tab',type:'tab',label:'isolated fixture'},
      {id:'entry',type:'http in',x:0,y:0,z:'tab',url:'/slow',method:'get',wires:[['provider']]},
      {id:'provider',type:'http request',x:0,y:0,z:'tab',method:'GET',ret:'txt',url:`http://127.0.0.1:${provider.address().port}/`,wires:[['response']]},
      {id:'response',type:'http response',x:0,y:0,z:'tab',wires:[]}];
    const initial=await admin('GET');await admin('POST',{rev:initial?.rev,flows:source});
    const pending=fetch(base+'/api/slow');await started;
    const instance=RED.nodes.getNode('provider');assert.ok(instance);
    const next=structuredClone(source);
    next.find(n=>n.id==='entry').wires=[['closed']];
    next.find(n=>n.id==='provider').wires=[['collector']];
    next.push({id:'closed',type:'function',x:0,y:0,z:'tab',outputs:1,func:"msg.statusCode=503;msg.payload='closed';return msg;",wires:[['response']]},
      {id:'collector',type:'function',x:0,y:0,z:'tab',outputs:1,func:"msg.statusCode=202;msg.payload='captured:'+msg.payload;return msg;",wires:[['response']]});
    const rev=(await admin('GET')).rev;
    await admin('POST',{rev,flows:next});
    assert.equal(RED.nodes.getNode('provider'),instance,'provider instance must not be recreated');
    const rejected=await fetch(base+'/api/slow');assert.equal(rejected.status,503);assert.equal(calls,1);
    releaseProvider();const captured=await pending;
    assert.equal(captured.status,202);assert.equal(await captured.text(),'captured:provider-result');
    const stale=await fetch(base+'/flows',{method:'POST',headers:{'Content-Type':'application/json','Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes'},body:JSON.stringify({rev,flows:source})});
    assert.equal(stale.status,409,'stale revision cannot undo maintenance');
  } finally {
    releaseProvider?.();await RED.stop();server.closeAllConnections();provider.closeAllConnections();
    await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>provider.close(resolve))]);
    fs.rmSync(userDir,{recursive:true,force:true});
  }
});

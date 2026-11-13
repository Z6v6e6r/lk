import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {graphFixture} from './fixtures/max-outbox-native-fixture.mjs';
import {buildMaxOutboxOnlyResume, MAX_OUTBOX_RESUME_TOPOLOGY as routes,
  MAX_OUTBOX_RESUME_REQUIRED_IDS, nodeSha256, sha256} from '../nodered_max_outbox_resume.mjs';
import {createMaxOutboxInverseBodyPreserver} from '../nodered_reviewed_flow_deploy/max_outbox_inverse_body_preserver.mjs';
import {createMaxOutboxBodyPreserver, max_outboxGraphHash, max_outboxOrderedGraphHash} from '../nodered_reviewed_flow_deploy/max_outbox_body_preserver.mjs';

const runtimeRoot=process.env.NODERED_RUNTIME_ROOT;
test('real native modified-nodes starts only new outgoing senders; preserves unrelated instances and supports inverse',
  {skip:!runtimeRoot,timeout:30000},async()=>{
    const require=createRequire(path.join(runtimeRoot,'package.json'));
    assert.equal(require('node-red/package.json').version,'4.0.9');
    const RED=require('node-red'),express=require('express'),app=express(),server=http.createServer(app);
    const userDir=fs.mkdtempSync(path.join(os.tmpdir(),'max-outbox-runtime-'));
    const sends=[],runtimeErrors=[];let unrelatedStarts=0,unrelatedInputs=0,incomingStarts=0;
    class Bot {constructor(){this.api={sendMessageToChat:async(chat,text)=>{sends.push({chat,text});return {message:{body:{mid:'synthetic-result'}}};}};}start(){incomingStarts++;throw Error('UNEXPECTED_INCOMING');}}
    RED.init(server,{userDir,flowFile:'flows.json',flowFilePretty:true,httpAdminRoot:'/',httpNodeRoot:'/api',disableEditor:true,
      functionExternalModules:false,logging:{console:{level:'off'},fixture:{level:'error',handler:()=>entry=>runtimeErrors.push(String(entry.msg))}}});
    app.use(RED.httpAdmin);app.use('/api',RED.httpNode);
    const completed=new Set();RED.events.on('runtime-event',e=>{if(e.id==='runtime-deploy')completed.add(e.payload.revision);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const admin=async(method,body,expected=200)=>{
      const response=await fetch(base+'/flows',{method,headers:{'Content-Type':'application/json','Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes'},
        body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});
      assert.equal(response.status,expected);if(expected!==200)return;
      const result=await response.json();if(method==='POST'){
        for(let i=0;i<500&&!completed.has(result.rev);i++)await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(completed.has(result.rev),true);
      }return result;
    };
    try{
      let bootstrapTimer;
      const bootstrap=new Promise((resolve,reject)=>{bootstrapTimer=setTimeout(()=>reject(Error('BOOTSTRAP_NOT_STARTED')),10000);RED.events.once('flows:started',()=>{clearTimeout(bootstrapTimer);resolve();});});
      await RED.start();await bootstrap;
      for(const name of ['maxbot-config','maxbot-send','maxbot-receive']){
        const module={exports:{}};
        vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(new URL(`./fixtures/max-response-guard/${name}.js.txt`,import.meta.url),'utf8')}\n})`)(
          dependency=>{assert.equal(dependency,'@maxhub/max-bot-api');return {Bot};},module,module.exports);
        module.exports.default(RED);
      }
      RED.nodes.registerType('synthetic-startup',function(config){RED.nodes.createNode(this,config);unrelatedStarts++;this.on('input',()=>unrelatedInputs++);});
      const graph=graphFixture();
      for(const n of graph){
        if(n.type!=='tab'&&n.type!=='maxbot-config')Object.assign(n,{x:0,y:0});
        if(n.type==='inject')Object.assign(n,{once:false,repeat:'',crontab:''});
        if(n.type==='function'){
          n.func=n.id===routes[0].dispatch||n.id===routes[1].dispatch?'return [msg,null];':'return null;';
          if(routes.some(r=>r.pull===n.id))n.func+=' // '+routes.find(r=>r.pull===n.id).connector;
        }
      }
      for(const r of routes)graph.find(n=>n.id===r.pull).func=`return null; // /support/outbox/pull?connector=${r.connector}&limit=10`;
      graph.push({id:'unrelated-startup',type:'synthetic-startup',z:routes[0].tab,x:0,y:0,wires:[]});
      await admin('POST',{rev:(await admin('GET'))?.rev,flows:graph,credentials:Object.fromEntries(routes.map(r=>[r.bot,{token:'synthetic-fixture-token'}]))});
      const before=await admin('GET'),source=JSON.stringify(before.flows);
      const trusted={flowSha256:sha256(source),nodeSha256:Object.fromEntries(MAX_OUTBOX_RESUME_REQUIRED_IDS.map(id=>[id,nodeSha256(before.flows.find(n=>n.id===id))]))};
      const candidate=buildMaxOutboxOnlyResume(source,trusted).flow;
      for(const r of routes){assert.deepEqual(RED.nodes.getCredentials(r.bot),{token:'synthetic-fixture-token'});assert.equal(RED.nodes.getNode(r.bot).token,'synthetic-fixture-token');}
      const unrelated=RED.nodes.getNode('unrelated-startup'),httpNodes=routes.map(r=>RED.nodes.getNode(r.http)),configs=routes.map(r=>RED.nodes.getNode(r.bot));
      assert.equal(unrelatedStarts,1);assert.equal(sends.length,0);assert.equal(incomingStarts,0);
      const seal={protocol:'source-preserving-v2',planSha256:'a'.repeat(64),attemptSha256:'b'.repeat(64),
        sourceGraphSha256:await max_outboxGraphHash(before.flows),sourceOrderedGraphSha256:await max_outboxOrderedGraphHash(before.flows),
        candidateGraphSha256:await max_outboxGraphHash(candidate),candidateOrderedGraphSha256:await max_outboxOrderedGraphHash(candidate),
        editorOrderedGraphSha256:await max_outboxOrderedGraphHash(before.flows),preRevisionSha256:sha256(before.rev)};
      const preserve=await createMaxOutboxBodyPreserver(seal,before);
      const output=await preserve({request:{url:'http://127.0.0.1:18801/flows',method:'POST',apiVersion:'v2',deploymentType:'nodes'},postBody:before});
      await admin('POST',JSON.parse(output.postDataText));
      const after=await admin('GET');assert.deepEqual(after.flows,candidate);
      assert.equal(fs.readFileSync(path.join(userDir,'flows.json'),'utf8'),JSON.stringify(candidate,null,4));
      assert.strictEqual(RED.nodes.getNode('unrelated-startup'),unrelated);assert.equal(unrelatedStarts,1);
      for(let i=0;i<routes.length;i++){assert.strictEqual(RED.nodes.getNode(routes[i].http),httpNodes[i]);assert.strictEqual(RED.nodes.getNode(routes[i].bot),configs[i]);assert.deepEqual(RED.nodes.getCredentials(routes[i].bot),{token:'synthetic-fixture-token'});}
      assert.equal(sends.length,0);assert.equal(incomingStarts,0);assert.equal(unrelatedInputs,0);
      for(const r of routes){
        for(const id of [r.sender,r.receiver,r.callback])assert.equal(RED.nodes.getNode(id),null);
        assert.ok(RED.nodes.getNode(r.newSender));
        RED.nodes.getNode(r.dispatch).receive({chatId:'synthetic-chat',payload:'synthetic new reply'});
      }
      for(let i=0;i<100&&sends.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.equal(sends.length,2,JSON.stringify(runtimeErrors));assert.equal(incomingStarts,0);
      await admin('POST',{rev:before.rev,flows:before.flows},409);
      const inverseSeal={...seal,sourceGraphSha256:await max_outboxGraphHash(after.flows),sourceOrderedGraphSha256:await max_outboxOrderedGraphHash(after.flows),
        candidateGraphSha256:await max_outboxGraphHash(before.flows),candidateOrderedGraphSha256:await max_outboxOrderedGraphHash(before.flows),
        editorOrderedGraphSha256:await max_outboxOrderedGraphHash(after.flows),preRevisionSha256:sha256(after.rev)};
      const inverse=await createMaxOutboxInverseBodyPreserver(inverseSeal,after);
      const reversed=await inverse({request:{url:'http://127.0.0.1:18801/flows',method:'POST',apiVersion:'v2',deploymentType:'nodes'},postBody:after});
      await admin('POST',JSON.parse(reversed.postDataText));
      assert.deepEqual((await admin('GET')).flows,before.flows);
      assert.strictEqual(RED.nodes.getNode('unrelated-startup'),unrelated);assert.equal(unrelatedStarts,1);
      for(const r of routes)assert.equal(RED.nodes.getNode(r.newSender),null);
      assert.equal(sends.length,2,JSON.stringify(runtimeErrors));assert.equal(incomingStarts,0);
    }finally{
      await RED.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(userDir,{recursive:true,force:true});
    }
  });

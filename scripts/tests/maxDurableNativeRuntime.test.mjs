import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {durableGraphFixture,durablePins} from './fixtures/max-durable-queue.mjs';
import {buildMaxDurableTransition,buildMaxDurableRecovery,durableOperations} from '../nodered_max_durable_release.mjs';
import {MAX_OUTBOX_RESUME_TOPOLOGY as routes,sha256} from '../nodered_max_outbox_resume.mjs';
import {createMaxDurableBodyPreserver,max_durableGraphHash,max_durableOrderedGraphHash} from '../nodered_reviewed_flow_deploy/max_durable_body_preserver.mjs';
const runtimeRoot=process.env.NODERED_RUNTIME_ROOT;
test('4.0.9 hot upload inherits private key in existing functions; native pause/8+4/paused recovery preserve unrelated runtime',
 {skip:!runtimeRoot,timeout:60000},async()=>{
  const require=createRequire(path.join(runtimeRoot,'package.json'));
  assert.equal(require('node-red/package.json').version,'4.0.9');
  const RED=require('node-red'),express=require('express'),app=express(),server=http.createServer(app);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'max-durable-runtime-')));fs.chmodSync(root,0o700);
  const userDir=path.join(root,'user');fs.mkdirSync(userDir);
  const secret='c'.repeat(64),key='SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN',tokenFile=path.join(root,'integration.env');
  fs.writeFileSync(tokenFile,`${key}=${secret}\n`,{mode:0o600});
  const envKeys=[key,'SUPPORT_INTEGRATION_TOKEN','npm_config_ignore_scripts','npm_config_registry','npm_config_cache'];
  const oldEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  delete process.env[key];process.env.SUPPORT_INTEGRATION_TOKEN='synthetic-legacy';
  process.env.npm_config_ignore_scripts='true';process.env.npm_config_registry='http://127.0.0.1:1';process.env.npm_config_cache=path.join(root,'npm-cache');
  const originalFetch=globalThis.fetch,sends=[],receipts=[],pulls=[],errors=[];let incoming=0,unrelatedStarts=0,enabled=false,probeResult;
  const delivered=new Set();
  const cup=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    assert.equal(req.headers['x-integration-token'],secret);
    res.setHeader('Content-Type','application/json');
    const url=new URL(req.url,'http://synthetic');
    if(url.pathname.endsWith('/pull')){
      const connector=url.searchParams.get('connector');pulls.push(connector);
      assert.equal(url.searchParams.get('receiptProtocol'),'max-lease-v1');
      assert.equal(url.searchParams.get('limit'),'1');
      if(!enabled||delivered.has(connector)){res.end('[]');return;}
      delivered.add(connector);res.end(JSON.stringify([{id:'synthetic-'+connector,leaseToken:randomUUID(),leasedUntil:new Date(Date.now()+120000).toISOString(),
        meta:{maxOutboxProtocol:'max-lease-v1'},targetExternalChatId:'synthetic-'+connector,text:'synthetic only'}]));return;
    }
    assert.match(url.pathname,/\/synthetic-MAX_(?:BOT|ACADEMY_BOT)\/ack$/);
    const receipt=JSON.parse(body);receipts.push(receipt);
    res.end(JSON.stringify({id:url.pathname.split('/').at(-2),status:'SENT',lastReceipt:{token:receipt.leaseToken,kind:'ack'}}));
  });
  await new Promise(resolve=>cup.listen(0,'127.0.0.1',resolve));
  const cupBase=`http://127.0.0.1:${cup.address().port}/api`;
  class Bot{constructor(){this.api={sendMessageToChat:()=>{throw Error('LEGACY_SEND');}};}start(){incoming++;throw Error('INCOMING_START');}}
  globalThis.fetch=async(url,opts)=>{
    const u=new URL(url);
    if(u.hostname==='127.0.0.1')return originalFetch(url,opts);
    assert.equal(u.origin,'https://platform-api2.max.ru');assert.equal(u.pathname,'/messages');
    sends.push(u.searchParams.get('chat_id'));return new Response(JSON.stringify({message:{body:{mid:'synthetic-result'}}}),{status:200});
  };
  RED.init(server,{userDir,flowFile:'flows.json',flowFilePretty:true,httpAdminRoot:'/',httpNodeRoot:'/api',disableEditor:false,
    credentialSecret:'synthetic-only',functionExternalModules:false,externalModules:{autoInstall:false},padlhubMaxOutboxTokenFile:tokenFile,
    logging:{console:{level:'off'},fixture:{level:'error',handler:()=>entry=>errors.push(String(entry.msg))}}});
  app.use(RED.httpAdmin);app.use('/api',RED.httpNode);
  const completed=new Set();RED.events.on('runtime-event',e=>{if(e.id==='runtime-deploy')completed.add(e.payload.revision);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const admin=async(method,body)=>{
    const response=await fetch(base+'/flows',{method,headers:{'Content-Type':'application/json','Node-RED-API-Version':'v2','Node-RED-Deployment-Type':'nodes'},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);
    const result=await response.json();if(method==='POST'){
      for(let i=0;i<500&&!completed.has(result.rev);i++)await new Promise(r=>setTimeout(r,10));assert(completed.has(result.rev));
    }return result;
  };
  const apply=async(before,candidate,purpose)=>{
    const operations=durableOperations(before.flows,candidate,purpose);
    const seal={protocol:'max-durable-source-preserving-v1',purpose,operations,operationsSha256:sha256(JSON.stringify(operations)),
      planSha256:'a'.repeat(64),attemptSha256:sha256(purpose),preRevisionSha256:sha256(before.rev),
      sourceGraphSha256:await max_durableGraphHash(before.flows),sourceOrderedGraphSha256:await max_durableOrderedGraphHash(before.flows),
      editorOrderedGraphSha256:await max_durableOrderedGraphHash(before.flows),candidateGraphSha256:await max_durableGraphHash(candidate),candidateOrderedGraphSha256:await max_durableOrderedGraphHash(candidate)};
    const preserve=await createMaxDurableBodyPreserver(seal,before);
    const result=await preserve({request:{url:'http://127.0.0.1:18801/flows',method:'POST',apiVersion:'v2',deploymentType:'nodes'},postBody:before});
    await admin('POST',JSON.parse(result.postDataText));const after=await admin('GET');assert.deepEqual(after.flows,candidate);
    assert.equal(fs.readFileSync(path.join(userDir,'flows.json'),'utf8'),JSON.stringify(candidate,null,4));return after;
  };
  try{
    fs.writeFileSync(path.join(userDir,'package.json'),JSON.stringify({name:'synthetic-hot-upload',private:true}));
    const started=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('BOOTSTRAP_TIMEOUT')),10000);RED.events.once('flows:started',()=>{clearTimeout(t);resolve();});});
    await RED.start();await started;
    for(const name of ['maxbot-config','maxbot-send','maxbot-receive']){
      const module={exports:{}};vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(new URL(`./fixtures/max-response-guard/${name}.js.txt`,import.meta.url),'utf8')}\n})`)(
        d=>{assert.equal(d,'@maxhub/max-bot-api');return {Bot};},module,module.exports);module.exports.default(RED);
    }
    RED.nodes.registerType('synthetic-startup',function(c){RED.nodes.createNode(this,c);unrelatedStarts++;});
    RED.nodes.registerType('synthetic-capture',function(c){RED.nodes.createNode(this,c);this.on('input',m=>{probeResult=m.payload;});});
    const graph=durableGraphFixture();
    for(const n of graph){if(n.type!=='tab'&&n.type!=='maxbot-config')Object.assign(n,{x:0,y:0});
      if(n.type==='tab')n.env=[{name:'SUPPORT_API_BASE_URL',type:'str',value:cupBase}];
      if(n.type==='inject')Object.assign(n,{once:false,repeat:'',crontab:''});
      if(n.type==='http request')Object.assign(n,{method:'use',ret:'txt'});
      if(routes.some(r=>r.parse===n.id))n.func='msg.payload=JSON.parse(msg.payload); return [msg,null];';
      if(n.type==='split')Object.assign(n,{splt:'\\n',spltType:'str',arraySplt:1,arraySpltType:'len',stream:false});
    }
    graph.push({id:'unrelated-startup',type:'synthetic-startup',z:routes[0].tab,wires:[]},
      {id:'existing-probe',type:'function',z:routes[0].tab,func:`msg.payload=!!env.get('${key}');return msg;`,outputs:1,wires:[['probe-result']]},
      {id:'probe-result',type:'synthetic-capture',z:routes[0].tab,wires:[]});
    await admin('POST',{rev:(await admin('GET')).rev,flows:graph,credentials:Object.fromEntries(routes.map(r=>[r.bot,{token:'synthetic-bot-token'}]))});
    const unrelated=RED.nodes.getNode('unrelated-startup'),probe=RED.nodes.getNode('existing-probe'),httpNodes=routes.map(r=>RED.nodes.getNode(r.http)),bots=routes.map(r=>RED.nodes.getNode(r.bot));
    const probeValue=async expected=>{probeResult=undefined;probe.receive({});for(let i=0;i<100&&probeResult===undefined;i++)await new Promise(r=>setTimeout(r,5));assert.equal(probeResult,expected);};
    await probeValue(false);assert.equal(typeof RED.nodes.getType('max-outbox-send'),'undefined');
    const adapter=fileURLToPath(new URL('../../node-red/max-outbox-adapter',import.meta.url));
    const packed=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--pack-destination',root],{cwd:adapter,encoding:'utf8'}));
    const form=new FormData();form.append('tarball',new Blob([fs.readFileSync(path.join(root,packed[0].filename))]),packed[0].filename);
    const upload=await fetch(base+'/nodes',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
    assert.equal(upload.status,200,await upload.text());
    assert.equal(typeof RED.nodes.getType('max-outbox-send'),'function');assert.equal(typeof RED.nodes.getType('max-outbox-receipt'),'function');
    assert.equal(process.env[key],secret);assert.equal(process.env.SUPPORT_INTEGRATION_TOKEN,'synthetic-legacy');
    assert.strictEqual(RED.nodes.getNode('existing-probe'),probe);await probeValue(true);
    for(const p of ['/settings','/nodes','/flows']){const response=await fetch(base+p);assert(!(await response.text()).includes(secret));}
    const before=await admin('GET'),raw=JSON.stringify(before.flows);
    const pause=await apply(before,buildMaxDurableTransition(raw,durablePins(raw),'pause').flow,'pause');
    const pauseRaw=JSON.stringify(pause.flows);
    const candidate=buildMaxDurableTransition(pauseRaw,durablePins(pauseRaw),'activate').flow;
    enabled=true;const after=await apply(pause,candidate,'activate');
    for(let i=0;i<500&&receipts.length<2;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(sends.length,2,JSON.stringify(errors));assert.equal(receipts.length,2,JSON.stringify(errors));
    assert.deepEqual(new Set(pulls),new Set(routes.map(r=>r.connector)));
    for(let i=0;i<routes.length;i++){assert.strictEqual(RED.nodes.getNode(routes[i].http),httpNodes[i]);assert.strictEqual(RED.nodes.getNode(routes[i].bot),bots[i]);assert.deepEqual(RED.nodes.getCredentials(routes[i].bot),{token:'synthetic-bot-token'});}
    assert.strictEqual(RED.nodes.getNode('unrelated-startup'),unrelated);assert.equal(unrelatedStarts,1);assert.equal(incoming,0);
    await apply(after,buildMaxDurableRecovery(JSON.stringify(after.flows),pauseRaw,durablePins(pauseRaw)).flow,'recover');
    assert.equal(sends.length,2);assert.equal(incoming,0);assert.equal(unrelatedStarts,1);
    assert(errors.every(e=>!e.includes(secret)));
  }finally{
    await RED.stop();server.closeAllConnections();cup.closeAllConnections();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>cup.close(r))]);
    globalThis.fetch=originalFetch;for(const k of envKeys){if(oldEnv[k]===undefined)delete process.env[k];else process.env[k]=oldEnv[k];}
    fs.rmSync(root,{recursive:true,force:true});
  }
 });

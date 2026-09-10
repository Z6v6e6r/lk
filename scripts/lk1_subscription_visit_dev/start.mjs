import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { verifyPacket,newPrivateUserDir } from './packet.mjs';
import { fileURLToPath } from 'node:url';
import RED from 'node-red';
import { createVisitScheduler } from './scheduler.mjs';
import { openVisitDev,validateConfig,RULE,TOKEN,USER_TOKEN } from './runtime.mjs';
export async function startVisitDev({config,flowPath,userDir,workerIntervalMs=0}) {
  validateConfig(config);
  if(!Number.isSafeInteger(workerIntervalMs)||(workerIntervalMs!==0&&(workerIntervalMs<1000||workerIntervalMs>60000)))throw Error('DEV_WORKER_INTERVAL_INVALID');
  const runtime=await openVisitDev(config);
  let scheduler;
  const authorized=req=>req.socket.remoteAddress==='127.0.0.1' && ['Bearer '+TOKEN,'Bearer '+USER_TOKEN].includes(req.headers.authorization)
    && req.headers.host===`127.0.0.1:${config.nodeRedPort}`
    && (!req.headers.origin || req.headers.origin===`http://127.0.0.1:${config.nodeRedPort}`);
  const server=http.createServer(async(req,res)=>{
    if(!authorized(req)){res.writeHead(403);res.end();return;}
    if(req.url.startsWith('/dev/control/')){
      try{let text='';for await(const chunk of req){text+=chunk;if(text.length>4096)throw Error('BODY_TOO_LARGE');}
        const body=text?JSON.parse(text):{};
        const route=req.method+' '+req.url;
        let result;
        if(route==='GET /dev/control/state')result={...await runtime.state(),worker:scheduler?.status()};
        else if(route==='POST /dev/control/seed'&&Object.keys(body).length===0)result=await runtime.seed();
        else if(route==='POST /dev/control/worker'&&Object.keys(body).length===0)result=await scheduler.runOnce();
        else if(route==='POST /dev/control/pay'&&Object.keys(body).join()==='transactionId')result=await runtime.pay(body.transactionId);
        else throw Error('DEV_CONTROL_NOT_IMPLEMENTED');
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));
      }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({code:e.message}));}return;
    }
    RED.httpNode(req,res);
  });
  RED.init(server,{userDir,flowFile:path.resolve(flowPath),uiHost:'127.0.0.1',uiPort:config.nodeRedPort,
    httpAdminRoot:false,disableEditor:true,httpNodeRoot:'/',credentialSecret:false,
    contextStorage:{default:{module:'memory'}},functionGlobalContext:{visitDevIO:runtime.io,vivacrm_access_token:TOKEN,vivacrm_token_expires_at:Date.now()+86400000,
      subscriptions_lk1_product_policy:RULE},externalModules:{autoInstall:false,palette:{allowInstall:false,allowUpload:false},modules:{allowInstall:false}},
    logging:{console:{level:'warn',metrics:false,audit:false}}});
  let startTimer,onStarted;
  const started=new Promise((resolve,reject)=>{
    startTimer=setTimeout(()=>reject(Error('DEV_FLOWS_START_TIMEOUT')),60000);
    onStarted=resolve;RED.events.once('flows:started',onStarted);
  });
  try{await Promise.all([RED.start(),started]);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.nodeRedPort,'127.0.0.1',resolve);});}
  catch(e){await RED.stop();await runtime.close();throw e;}
  finally{clearTimeout(startTimer);RED.events.removeListener('flows:started',onStarted);}
  scheduler=createVisitScheduler({worker:()=>runtime.worker(),intervalMs:workerIntervalMs});
  return {runtime,scheduler,async close(){const closing=new Promise(resolve=>server.close(resolve));await scheduler.stop();await closing;await RED.stop();await runtime.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==5 || process.argv[2]!=='--run') {
    console.log('Disabled. Explicit local rehearsal: --run <packet-directory> <runtime-user-directory>');
  } else {
    const packet=path.resolve(process.argv[3]),userDir=path.resolve(process.argv[4]);
    verifyPacket(packet,fileURLToPath(import.meta.url));
    const config=JSON.parse(fs.readFileSync(path.join(packet,'config.json'),'utf8'));
    newPrivateUserDir(userDir);
    const app=await startVisitDev({config,flowPath:path.join(packet,'flows.json'),userDir});
    console.log(JSON.stringify({state:'DEV_REHEARSAL_READY',nodeRedPort:config.nodeRedPort,providerPort:config.providerPort}));
    for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await app.close();process.exit(0);});
  }
}

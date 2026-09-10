// Foreground synthetic DEV service. Installation and activation are separate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyPacket,newPrivateUserDir} from './packet.mjs';
export function validateServicePacket(packet,expectedManifestHash,entry=fileURLToPath(import.meta.url),nodeVersion=process.versions.node) {
  if(nodeVersion!=='22.23.2')throw Error('DEV_SERVER_PINNED_NODE22_REQUIRED');
  packet=fs.realpathSync(packet);
  if(fs.realpathSync(entry)!==path.join(packet,'scripts/lk1_subscription_visit_dev/serve.mjs'))throw Error('DEV_SERVER_ENTRY_MISMATCH');
  if(!/^[a-f0-9]{64}$/.test(expectedManifestHash||'')||crypto.createHash('sha256').update(fs.readFileSync(path.join(packet,'manifest.json'))).digest('hex')!==expectedManifestHash)throw Error('DEV_SERVER_MANIFEST_MISMATCH');
  const manifest=verifyPacket(packet);
  if(manifest.sourceDirty!==false||!/^[a-f0-9]{40}$/.test(manifest.sourceCommit))throw Error('DEV_SERVER_CLEAN_SOURCE_REQUIRED');
  const config=JSON.parse(fs.readFileSync(path.join(packet,'config.json')));
  if(config.nodeRedPort!==1882||config.providerPort!==3038||config.mongoUri!=='mongodb://127.0.0.1:27030'||config.database!=='lk1_subscription_dev_fixture')throw Error('DEV_SERVER_TARGET_MISMATCH');
  return config;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==5||process.argv[2]!=='--serve') {
    console.log('Disabled. --serve <immutable-packet> <approved-manifest-sha256>');
  }else{
    const packet=fs.realpathSync(process.argv[3]);
    const config=validateServicePacket(packet,process.argv[4]);
    // All lasting visit/provider state is Mongo. A fresh Node-RED userDir avoids
    // importing stale local flow/context on restart and leaves the packet immutable.
    const parent=fs.mkdtempSync('/tmp/lk-visit-service-');fs.chmodSync(parent,0o700);
    const userDir=newPrivateUserDir(path.join(parent,'node-red'));
    const {startVisitDev}=await import('./start.mjs');
    const app=await startVisitDev({config,flowPath:path.join(packet,'flows.json'),userDir,workerIntervalMs:5000});
    console.log(JSON.stringify({state:'SYNTHETIC_DEV_READY',workerIntervalMs:5000,manifestSha256:process.argv[4]}));
    let closing=false;
    const close=async()=>{if(closing)return;closing=true;await app.close();fs.rmSync(parent,{recursive:true});process.exit(0);};
    for(const signal of ['SIGTERM','SIGINT'])process.on(signal,close);
  }
}

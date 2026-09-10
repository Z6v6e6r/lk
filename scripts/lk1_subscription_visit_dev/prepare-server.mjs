// Offline staging only: no SSH, systemctl, privileged writes or dependency install.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyPacket} from './packet.mjs';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function prepareServer({packet,output,auditFile}) {
  packet=fs.realpathSync(packet);
  const manifest=verifyPacket(packet);
  if(manifest.sourceDirty!==false)throw Error('DEV_SERVER_CLEAN_SOURCE_REQUIRED');
  const parent=fs.realpathSync(path.dirname(output)),target=path.join(parent,path.basename(output));
  if(!/^\/(?:private\/)?tmp\//.test(target)||fs.existsSync(target))throw Error('DEV_NEW_EXTERNAL_OUTPUT_REQUIRED');
  const auditBytes=fs.readFileSync(auditFile),audit=JSON.parse(auditBytes);
  if(audit.error||!audit.metadata?.vulnerabilities||!Number.isSafeInteger(audit.metadata.vulnerabilities.total))throw Error('DEV_AUDIT_REQUIRED');
  const temp=fs.mkdtempSync(path.join(parent,'.visit-server-'));fs.chmodSync(temp,0o700);
  const staged=path.join(temp,'visit-packet');fs.mkdirSync(staged,{mode:0o700});
  // Explicit payload only: never copy private exports, .env, caches or node_modules.
  for(const name of ['manifest.json',...manifest.files.map(row=>row.path)]){
    const to=path.join(staged,name);fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.copyFileSync(path.join(packet,name),to,fs.constants.COPYFILE_EXCL);
  }
  const manifestHash=digest(fs.readFileSync(path.join(packet,'manifest.json')));
  const put=(name,bytes)=>fs.writeFileSync(path.join(temp,name),bytes,{mode:0o600,flag:'wx'});
  const unitDir=new URL('./units/',import.meta.url);
  for(const name of ['lk1-subscription-visit-dev.service','mongo-private-network.conf'])put(name,fs.readFileSync(new URL(name,unitDir)));
  put('visit-service.env',`VISIT_MANIFEST_SHA256=${manifestHash}\n`);
  put('dependency-audit.json',auditBytes);
  const plan={formatVersion:1,environment:'DEV',state:'PREPARED_NOT_INSTALLABLE',sourceCommit:manifest.sourceCommit,
    targetHost:'lk-reserve-89',targetRoot:'/srv/lk1-subscription-dev',manifestSha256:manifestHash,
    installAuthorized:false,startAuthorized:false,productionCompatible:false,
    blockers:['NODE22_BINARY_AND_HASH_REQUIRED','DEPENDENCY_CLOSURE_AND_AUDIT_BINDING_REQUIRED','FRESH_HOST_PREIMAGE_REQUIRED',
      ...(audit.metadata.vulnerabilities.total?['DEPENDENCY_ADVISORIES_UNRESOLVED']:[])],
    audit:{sha256:digest(auditBytes),vulnerabilities:audit.metadata.vulnerabilities,evidenceOnly:true},
    deployment:{packetPath:'/srv/lk1-subscription-dev/visit-packet',nodePath:'/srv/lk1-subscription-dev/runtime/node22/bin/node',
      unit:'lk1-subscription-visit-dev.service',mongoUnit:'lk1-subscription-dev-mongo.service',workerIntervalMs:5000,
      network:'PrivateNetwork shared with dedicated Mongo only; no host port or ingress',
      dependencies:'Offline npm ci closure and installed inventory must be approved separately; none bundled here'},
    preconditions:['All dedicated legacy fixture units inactive and disabled','No existing visit-packet, visit unit or visit-service.env',
      'Preserve shared1880/27029 and all production state','Exact stopped-install preimages and service user ownership verified'],
    stop:{unit:'lk1-subscription-visit-dev.service',behavior:'Drain current worker, close HTTP and Mongo; preserve DB and unknown locks',
      restart:'Same Mongo database, fresh private Node-RED userDir; no automatic retry of uncertain provider delta'},
    recovery:'Keep service stopped on failure. Preserve Mongo, logs and candidate. Never reset visits or erase locks as rollback.'};
  put('server-plan.json',JSON.stringify(plan,null,2)+'\n');
  fs.renameSync(temp,target);return plan;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [packet,output,auditFile]=process.argv.slice(2);
  if(!packet||!output||!auditFile)throw Error('Usage: packet new-output audit.json');
  console.log(JSON.stringify(prepareServer({packet,output,auditFile}),null,2));
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PAYLOAD_FILES} from './lk1_subscription_visit_dev/packet.mjs';
import {buildVisitDevGraph} from './lk1_subscription_visit_dev/graph.mjs';
import {validateConfig} from './lk1_subscription_visit_dev/runtime.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export function buildPacket({source,output,config}) {
  validateConfig(config);
  const parent=fs.realpathSync(path.dirname(output)),dir=path.join(parent,path.basename(output));
  if(!/^\/(?:private\/)?tmp\//.test(dir)||fs.existsSync(dir))throw Error('DEV_NEW_EXTERNAL_OUTPUT_REQUIRED');
  const graph=buildVisitDevGraph(fs.readFileSync(source));
  const sources=PAYLOAD_FILES.filter(name=>name.startsWith('scripts/'));
  const temp=fs.mkdtempSync(path.join(parent,'.visit-dev-build-'));fs.chmodSync(temp,0o700);
  const files=[];
  const put=(name,bytes)=>{const file=path.join(temp,name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});files.push({path:name,sha256:sha(bytes)});};
  for(const source of sources)put(source,fs.readFileSync(path.join(ROOT,source)));
  put('flows.json',Buffer.from(JSON.stringify(graph.flow,null,2)+'\n'));
  put('config.json',Buffer.from(JSON.stringify(config,null,2)+'\n'));
  const manifest={formatVersion:1,environment:'DEV',purpose:'SYNTHETIC_PAID_JOIN_REHEARSAL',
    sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    sourceDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8'}).trim()),
    installAuthorized:false,startAuthorized:false,productionCompatible:false,
    target:{host:'lk-reserve-89',userDir:'/srv/lk1-subscription-dev/node-red',expectedFlowPreimage:'ABSENT'},
    graphSourceSha256:graph.sourceSha256,productionFunctions:graph.productionFunctions,routes:graph.routes,limitations:graph.limitations,files};
  put('README.txt',Buffer.from('Local synthetic rehearsal only. No server installation or activation is authorized.\nExplicit local start uses scripts/lk1_subscription_visit_dev/start.mjs --run <packet> <private runtime directory>.\nDependencies: npm ci --ignore-scripts inside packet scripts/lk1_subscription_visit_dev. Keep all services loopback-only.\nProvider state, payment confirmation and roster insertion are fixture-owned. JOIN/checkout and cancellation execute native Node-RED production functions; canonical post-payment branch fails closed.\n'));
  fs.writeFileSync(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(temp,dir);return manifest;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const [source,output,config]=process.argv.slice(2);if(!source||!output||!config)throw Error('Usage: source.flow.json new-external-output config.json');
  const result=buildPacket({source,output,config:JSON.parse(fs.readFileSync(config,'utf8'))});
  console.log(JSON.stringify({output,sourceCommit:result.sourceCommit,routes:result.routes,installAuthorized:false}));
}

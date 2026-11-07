import fs from 'node:fs';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export function patchFprStartBootstrap(bytes,contract,sources){
 if(hash(bytes)!==contract.sourceSha256)throw Error('PREIMAGE');
 const flow=JSON.parse(bytes),prefix='fpr_canonical_start_20261106_';
 for(const name of ['authorize','resolve']){
  const n=flow.find(n=>n.id===prefix+name);if(n?.type!=='function'||hash(JSON.stringify(n))!==contract.nodes[name])throw Error('NODE_PREIMAGE');
  n.func=sources[name];new Function('msg',n.func);
 }
 const a=flow.find(n=>n.id===prefix+'authorize'),resolve=flow.find(n=>n.id===prefix+'resolve'),response=flow.find(n=>n.id===prefix+'response');
 const id='fpr_canonical_bootstrap_20261106';if(flow.some(n=>n.id===id)||(a.wires[0]?.length!==1||a.wires[0][0]!==prefix+'find'))throw Error('GRAPH');
 a.wires[0]=[id];
 flow.push({id,type:'function',z:a.z,name:'Initialize missing CUP FPR starts',func:sources.initialize,outputs:2,timeout:'',noerr:0,initialize:'',finalize:'',
  libs:[{var:'nodeChildProcess',module:'child_process'}],wires:[[resolve.id],[response.id]],x:1100,y:3000});
 const catcher=flow.find(n=>n.id===prefix+'catch');if(hash(JSON.stringify(catcher))!==contract.nodes.catch)throw Error('CATCH_PREIMAGE');catcher.scope.push(id);
 return {bytes:JSON.stringify(flow,null,2)+'\n',changed:[a.id,resolve.id,catcher.id],added:[id]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [input,contract,output]=process.argv.slice(2);if(!output||fs.existsSync(output))throw Error('New output required');
 const sources=Object.fromEntries(['authorize','resolve','initialize'].map(n=>[n,fs.readFileSync(new URL('./nodered_fpr_start_nodes/'+n+'.js',import.meta.url),'utf8')]));
 const result=patchFprStartBootstrap(fs.readFileSync(input),JSON.parse(fs.readFileSync(contract)),sources);fs.writeFileSync(output,result.bytes,{flag:'wx',mode:0o600});
}

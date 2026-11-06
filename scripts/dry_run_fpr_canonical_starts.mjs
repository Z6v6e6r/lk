// Deliberately no apply mode, worker entrypoint, indexes, outbox, or provider call.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFprCanonicalDryRun, dryRunError } from './lib/fprCanonicalDryRun.mjs';

export async function main(args=process.argv.slice(2)) {
  const allowed=new Set(['--root','--flow','--mongo-module','--out']);const values={};
  for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]||values[args[i]])throw Error('FPR_DRY_RUN_ARGUMENTS');values[args[i]]=args[i+1];}
  if(!values['--root'])throw Error('FPR_DRY_RUN_ROOT_REQUIRED');
  const flow=JSON.parse(fs.readFileSync(values['--flow']||'/root/.node-red/flows.json','utf8'));
  const cfg=flow.find(n=>n.type==='mongodb4-client'&&n.dbName==='games'&&typeof n.uri==='string');
  if(!cfg)throw Error('FPR_DRY_RUN_DB_CONFIG');
  const {MongoClient}=createRequire(import.meta.url)(values['--mongo-module']||'mongodb');
  const client=new MongoClient(cfg.uri,{serverSelectionTimeoutMS:10000,connectTimeoutMS:10000});
  try{
    await client.connect();
    const report=await readFprCanonicalDryRun(client.db('games'),values['--root']);
    const bytes=JSON.stringify(report,null,2)+'\n';
    if(values['--out'])fs.writeFileSync(values['--out'],bytes,{flag:'wx',mode:0o600});
    else process.stdout.write(bytes);
  }finally{await client.close();}
}
if(process.env.FPR_CANONICAL_DRY_RUN_STDIN==='1'||process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(e=>{console.error(dryRunError(e));process.exitCode=1;});
}

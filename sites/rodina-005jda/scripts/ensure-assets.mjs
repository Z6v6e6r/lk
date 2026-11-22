import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function ensureAssets(project) {
 const manifest=JSON.parse(await fs.readFile(path.join(project,'audit/source-manifest.json'),'utf8'));
 for(const [name,expected]of Object.entries(manifest.sha256)) {
  if(!/^(?:assets|docs)\/[a-zA-Z0-9_./-]+$/.test(name))continue;
  if(name.split('/').includes('..'))throw Error('Invalid asset path');
  const file=path.join(project,'src',name);
  let bytes;
  try{bytes=await fs.readFile(file);}catch(error){
   if(error.code!=='ENOENT')throw error;
   const args=['--connect-timeout','10','--max-time','30','-fsS'];
   if(process.env.RODINA_DOWNLOAD_PROXY)args.push('--proxy',process.env.RODINA_DOWNLOAD_PROXY);
   const result=await exec('curl',[...args,'https://cg178013.tw1.ru/'+name],{encoding:'buffer',maxBuffer:4*1024*1024});
   bytes=result.stdout;
   if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Public asset changed: '+name);
   await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
  }
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Asset hash mismatch: '+name);
 }
}

#!/usr/bin/env node
// Public source assets only. No production flow is bundled or read here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSubscription397Artifact } from './lib/subscription397_native_artifact.mjs';
import { buildSubscription397BrowserGuard, buildSubscription397EditorReadback } from './nodered_reviewed_flow_deploy/subscription397_browser_guard.mjs';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
export async function buildSubscription397Assets(output, release) {
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
  if(!/^[a-f0-9]{40}$/.test(release||'')||git(['rev-parse','HEAD'])!==release||git(['status','--porcelain']))throw Error('S397_CLEAN_COMMIT_REQUIRED');
  if(!path.isAbsolute(output)||fs.realpathSync(output)!==output||output===repo||output.startsWith(repo+'/')
    ||!fs.statSync(output).isDirectory()||(fs.statSync(output).mode&0o777)!==0o700||fs.readdirSync(output).length)throw Error('S397_NEW_PRIVATE_OUTPUT_REQUIRED');
  const manifest={sourceCommit:release,files:{}};
  const write=(name,b)=>{const dest=path.join(output,name);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,b,{flag:'wx',mode:0o600});manifest.files[name]=sha(b);};
  for(const name of ['scripts/nodered_reviewed_flow_deploy/subscription397_native_operation.mjs',
    'scripts/nodered_reviewed_flow_deploy/subscription397_body_preserver.mjs','scripts/nodered_reviewed_flow_deploy/subscription397_browser_guard.mjs',
    'scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs','scripts/lib/subscription397_native_patch.mjs'])write(name,fs.readFileSync(path.join(repo,name)));
  const artifact=buildSubscription397Artifact();
  write('subscription397-artifact.json',JSON.stringify(artifact,null,2)+'\n');
  write('browser-guard.js',buildSubscription397BrowserGuard(artifact));
  write('editor-readback.js',`window.__subscription397Readback=${buildSubscription397EditorReadback(artifact)};\nconsole.log('SUBSCRIPTION397_READER_READY');\n`);
  const module=await import(pathToFileURL(path.join(output,'scripts/nodered_reviewed_flow_deploy/subscription397_native_operation.mjs')));
  manifest.codeSha256=module.subscription397OperationCodeHash();
  manifest.browserGuardSha256=manifest.files['browser-guard.js'];manifest.sourceOrCandidateIncluded=false;
  fs.writeFileSync(path.join(output,'public-assets.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return manifest;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)console.log(JSON.stringify(await buildSubscription397Assets(...process.argv.slice(2))));

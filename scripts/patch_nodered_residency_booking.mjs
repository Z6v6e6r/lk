import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyWorkspace} from './verify_nodered_source_origin.mjs';
import {assertHubOutputPath} from './patch_live_lk1_hub.mjs';
import {composeResidencyGateway,composeResidencyEvaluator,composeResidencyPreview} from './lib/residencyBookingSources.mjs';

// Reviewed function preimages from the private 147 snapshot of 2026-11-10.
// No export or provider data is included in this repository.
export const RESIDENCY_TARGETS = Object.freeze([
  {id:'lk_subscription_booking_router_20260804',sha256:'f9139fde6fec431b9c306250519e520f6ab8e06bb5df09e276547d13e6ed86c9',compose:composeResidencyGateway},
  {id:'lk_subscription_price_preview_20260908_router',sha256:'b4325899a8579fb727b6a09d3400b91064f19308d6b3f4557e50a642d8391102',compose:composeResidencyPreview},
  {id:'lk_subscription_managed_policy_20260820',sha256:'fcc12d8261873f2b82b17236bfb77669bc59dce27fdada073e656d6384a24cb6',compose:composeResidencyEvaluator},
  {id:'lk_subscription_price_preview_20260908_evaluate',sha256:'988c0a0ccc1c8d86503127abd1b5817d89a44899674e1789341cdcc5eec48d8a',compose:composeResidencyEvaluator}
]);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
export {assertHubOutputPath as assertResidencyOutputPath};
export function composeResidencyFlow(flow) {
  if (!Array.isArray(flow) || new Set(flow.map(n=>n.id)).size!==flow.length) throw new Error('FLOW_INVALID');
  const replacements=new Map();
  for(const target of RESIDENCY_TARGETS) {
    const node=flow.find(n=>n.id===target.id);
    if (!node || node.type!=='function' || hash(node.func)!==target.sha256) throw new Error('RESIDENCY_PREIMAGE_DRIFT:'+target.id);
    replacements.set(target.id,target.compose(node.func));
  }
  const candidate=flow.map(n=>replacements.has(n.id)?{...n,func:replacements.get(n.id)}:n);
  return {candidate,report:{schemaVersion:1,liveMutation:false,flagsEnabled:false,
    changes:RESIDENCY_TARGETS.map(t=>({id:t.id,previousSha256:t.sha256,candidateSha256:hash(replacements.get(t.id))}))}};
}
if (process.argv[1] && fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if (args.length!==4 || args[0]!=='--workspace' || args[2]!=='--output-dir') throw new Error('Usage: --workspace /private/live-workspace --output-dir /private/new-candidate');
    const result=verifyWorkspace(args[1],{quiet:true});
    const out=assertHubOutputPath(args[3]);
    const packet=composeResidencyFlow(result.source);
    fs.mkdirSync(out,{mode:0o700});
    fs.writeFileSync(path.join(out,'candidate.json'),JSON.stringify(packet.candidate),{mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...packet.report,sourceSha256:result.sourceSha256},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify(packet.report));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyWorkspace} from './verify_nodered_source_origin.mjs';
import {assertResidencyOutputPath} from './patch_nodered_residency_booking.mjs';
import {residencySetting} from './lib/residencyBookingContext.mjs';

// Reviewed installed residency functions from the fresh 147 snapshot, 2026-11-10.
// The updater preserves the live paid owner; it does not regenerate an older gateway.
export const RESIDENCY_REFRESH_TARGETS=Object.freeze([
  {id:'lk_subscription_booking_router_20260804',sha256:'35b8aabff3bb4a204e86d3322dc6af4dc9d4a794516d7cc4cba3a99663f487eb',kind:'gateway',routes:2},
  {id:'lk_subscription_price_preview_20260908_router',sha256:'bb8d65269dbf0ac68ea6116796af6ceb8731a8684d8ad2a81c6cbace39e72240',kind:'preview',routes:1},
  {id:'lk_subscription_managed_policy_20260820',sha256:'d453e12a19952c247815dc11b8c1a1c07814864bf4d3687e2734a40df60e3dc1',kind:'evaluator',routes:1},
  {id:'lk_subscription_price_preview_20260908_evaluate',sha256:'f99c00b789357912412c2af4547b31df42bf12f82e888e0fe2c61fb44ab24cac',kind:'evaluator',routes:1}
]);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const reader="residencyTransportConfig(key=>residencySetting(key,k=>global.get(k),k=>typeof env!=='undefined'?env.get(k):undefined))";
export function refreshResidencyFunction(source,kind,routes) {
  if(source.includes('function residencySetting(') || source.split('residency-booking-context').length!==routes+1
    || source.split('function residencyTransportConfig(read) {').length!==2) throw Error('RESIDENCY_REFRESH_SOURCE_DRIFT');
  source=source.replace('function residencyTransportConfig(read) {',residencySetting.toString()+'\nfunction residencyTransportConfig(read) {');
  source=source.replaceAll('residency-booking-context','residency-booking-refresh');
  if(kind==='gateway') {
    const start=source.indexOf('const residencyConfig = (ctx) => {'),end=source.indexOf('const residencyEnsure = ',start);
    if(start<0||end<0) throw Error('RESIDENCY_REFRESH_GATEWAY_DRIFT');
    source=source.slice(0,start)+`const residencyConfig = (ctx) => {try {return ${reader};} catch {return null;}};\n`+source.slice(end);
  } else if(kind==='preview') {
    const old='residencyTransportConfig(key=>global.get(key))';
    if(source.split(old).length!==3) throw Error('RESIDENCY_REFRESH_PREVIEW_DRIFT');
    source=source.replaceAll(old,reader);
  } else if(kind!=='evaluator') throw Error('RESIDENCY_REFRESH_KIND_INVALID');
  new Function('msg','node','env','global',source);
  return source;
}
export function composeResidencyRefreshFlow(flow) {
  if(!Array.isArray(flow)||new Set(flow.map(n=>n.id)).size!==flow.length) throw Error('FLOW_INVALID');
  const replacement=new Map();
  for(const target of RESIDENCY_REFRESH_TARGETS) {
    const node=flow.find(n=>n.id===target.id);
    if(!node||node.type!=='function'||hash(node.func)!==target.sha256) throw Error('RESIDENCY_REFRESH_PREIMAGE_DRIFT:'+target.id);
    replacement.set(target.id,refreshResidencyFunction(node.func,target.kind,target.routes));
  }
  return {candidate:flow.map(n=>replacement.has(n.id)?{...n,func:replacement.get(n.id)}:n),report:{schemaVersion:1,
    liveMutation:false,flagsEnabled:false,changes:RESIDENCY_REFRESH_TARGETS.map(t=>({id:t.id,previousSha256:t.sha256,candidateSha256:hash(replacement.get(t.id))}))}};
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.length!==4||args[0]!=='--workspace'||args[2]!=='--output-dir') throw Error('Usage: --workspace /private/live-workspace --output-dir /private/new-candidate');
    const verified=verifyWorkspace(args[1],{quiet:true}),out=assertResidencyOutputPath(args[3]);
    const packet=composeResidencyRefreshFlow(verified.source);
    fs.mkdirSync(out,{mode:0o700});
    fs.writeFileSync(path.join(out,'candidate.json'),JSON.stringify(packet.candidate),{mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...packet.report,sourceSha256:verified.sourceSha256},null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify(packet.report));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}

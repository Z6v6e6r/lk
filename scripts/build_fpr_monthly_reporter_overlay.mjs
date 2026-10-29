// FPR-only overlay for the separately deployed calendar-month reporter.
// No current-link, timer, environment or report writes are performed here.
import fs from "node:fs";import path from "node:path";import {pathToFileURL} from "node:url";
import {sha256,fprWorkerReplacements} from "./build_fpr_rating_worker_overlay.mjs";
export const monthlyFprFiles=["src/services/community-rating/facts.ts","src/services/community-rating/recalculation.ts","src/services/community-rating/monthly.ts","src/services/community-rating/fpr.ts","src/components/tournaments/fpr6x25.ts","src/services/player-rating/tournamentExclusionGuard.ts"];
export const monthlyContextPatch={before:"extractCommunityRatingFacts({ ...source, feedPosts, collectedAt: updatedAt })",after:"extractCommunityRatingFacts({ ...source, feedPosts, publicationContextPosts: source.feedPosts, collectedAt: updatedAt })"};
export const monthlyExclusionPatch={
before:'if (getTournamentRatingExclusion(input.tournament, standing.id, "community")\n        || input.fpr?.legacySource && getTournamentRatingExclusion(input.fpr.legacySource, standing.id, "community")) return null;',
after:'if (input.fpr && (getTournamentRatingExclusion(input.tournament, standing.id, "community")\n        || input.fpr.legacySource && getTournamentRatingExclusion(input.fpr.legacySource, standing.id, "community"))) return null;'
};
function checked(root,relative,expected){
 if(typeof relative!=="string"||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==="."||p===".."))throw Error("Unsafe path");
 const file=path.join(root,relative);
 if(!fs.lstatSync(file).isFile()||fs.realpathSync(file)!==path.join(fs.realpathSync(root),relative))throw Error("Non-regular file");
 const bytes=fs.readFileSync(file);if(!/^[a-f0-9]{64}$/.test(expected||"")||sha256(bytes)!==expected)throw Error("Hash mismatch: "+relative);return bytes;
}
const replaceOnce=(text,before,after)=>{if(text.split(before).length!==2)throw Error("Non-unique patch anchor");return text.replace(before,after);};
export function buildFprMonthlyReporterOverlay({baselineRoot,sourceRoot,outputRoot,contract}){
 if(fs.existsSync(outputRoot))throw Error("Output already exists");
 if(!/^[a-f0-9]{40}$/.test(contract.sourceCommit||""))throw Error("Source commit required");
 const baseBytes=checked(baselineRoot,"release-manifest.json",contract.baselineManifestSha256),base=JSON.parse(baseBytes);
 if(base.dirtyWorktree!==false||!Array.isArray(base.files)||!base.files.length)throw Error("Clean manifest required");
 const result=new Map();for(const e of base.files){if(result.has(e.path)||e.path==="release-manifest.json")throw Error("Duplicate/reserved path");result.set(e.path,checked(baselineRoot,e.path,e.sha256));}
 if(Object.keys(contract.sourceFiles||{}).sort().join("\n")!==[...monthlyFprFiles].sort().join("\n"))throw Error("Exact monthly FPR allowlist required");
 const source=new Map(monthlyFprFiles.map(file=>[file,checked(sourceRoot,file,contract.sourceFiles[file])]));
 for(const file of monthlyFprFiles.slice(0,3))if(!result.has(file)||sha256(result.get(file))!==contract.baselineFiles?.[file])throw Error("Preimage mismatch");
 for(const file of monthlyFprFiles.slice(3))if(result.has(file))throw Error("Existing FPR requires a new reviewed upgrade");
 // Preserve this installed reporter's legacy semantics. Durable exclusions are
 // added only to the new FPR branch, including its canonical legacy source.
 if(result.get(monthlyFprFiles[0]).toString().includes("getTournamentRatingExclusion"))throw Error("Unexpected legacy exclusion capability");
 result.set(monthlyFprFiles[0],Buffer.from(replaceOnce(source.get(monthlyFprFiles[0]).toString(),monthlyExclusionPatch.before,monthlyExclusionPatch.after)));
 const query=fprWorkerReplacements.find(p=>p.file===monthlyFprFiles[1]);
 for(const [file,patch]of [[monthlyFprFiles[1],query],[monthlyFprFiles[2],monthlyContextPatch]]){
  if(source.get(file).toString().split(patch.after).length!==2)throw Error("Owning source patch mismatch");
  result.set(file,Buffer.from(replaceOnce(result.get(file).toString(),patch.before,patch.after)));
 }
 for(const file of monthlyFprFiles.slice(3))result.set(file,source.get(file));
 const files=[...result].map(([file,bytes])=>({path:file,sha256:sha256(bytes)}));
 const changed=files.filter(e=>base.files.find(old=>old.path===e.path)?.sha256!==e.sha256).map(e=>e.path).sort();
 if(changed.join("\n")!==[...monthlyFprFiles].sort().join("\n"))throw Error("Unexpected monthly overlay delta");
 fs.mkdirSync(outputRoot,{recursive:false,mode:0o755});fs.chmodSync(outputRoot,0o755);
 for(const [file,bytes]of result){
  const target=path.join(outputRoot,file);fs.mkdirSync(path.dirname(target),{recursive:true});let directory=outputRoot;
  for(const segment of file.split("/").slice(0,-1)){directory=path.join(directory,segment);fs.chmodSync(directory,0o755);}
  const mode=fs.existsSync(path.join(baselineRoot,file))?fs.statSync(path.join(baselineRoot,file)).mode&0o777:0o644;
  fs.writeFileSync(target,bytes,{mode});fs.chmodSync(target,mode);
 }
 const next={...base,releaseId:path.basename(outputRoot),generatedAt:new Date().toISOString(),gitSha:contract.sourceCommit,dirtyWorktree:false,
 composition:{kind:"fpr-calendar-reporter-overlay-v1",baselineGitSha:base.gitSha,baselineManifestSha256:contract.baselineManifestSha256,sourceFiles:contract.sourceFiles,changedFiles:changed,legacyExclusionsUnchanged:true},files};
 fs.writeFileSync(path.join(outputRoot,"release-manifest.json"),JSON.stringify(next,null,2)+"\n");fs.chmodSync(path.join(outputRoot,"release-manifest.json"),0o644);
 return {ok:true,files:files.length,changedFiles:changed,legacyExclusionsUnchanged:true,manifestSha256:sha256(fs.readFileSync(path.join(outputRoot,"release-manifest.json")))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const[baselineRoot,sourceRoot,outputRoot,contractPath]=process.argv.slice(2);if(!contractPath)throw Error("Usage: BASE SOURCE NEW_OUTPUT CONTRACT_JSON");console.log(JSON.stringify(buildFprMonthlyReporterOverlay({baselineRoot,sourceRoot,outputRoot,contract:JSON.parse(fs.readFileSync(contractPath))})));}


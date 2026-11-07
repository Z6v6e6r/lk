import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";
import {buildFprMonthlyReporterOverlay,monthlyFprFiles,monthlyContextPatch,monthlyExclusionPatch} from "../build_fpr_monthly_reporter_overlay.mjs";
import {sha256,fprWorkerReplacements} from "../build_fpr_rating_worker_overlay.mjs";
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"fpr-monthly-overlay-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const baselineRoot=root+"/base",sourceRoot=root+"/source",outputRoot=root+"/candidate";fs.mkdirSync(baselineRoot);fs.mkdirSync(sourceRoot);
 const write=(dir,file,bytes)=>{fs.mkdirSync(path.dirname(dir+"/"+file),{recursive:true});fs.writeFileSync(dir+"/"+file,bytes);};
 const query=fprWorkerReplacements.find(p=>p.file===monthlyFprFiles[1]),before=["// installed legacy facts",query.before,monthlyContextPatch.before],after=[monthlyExclusionPatch.before,query.after,monthlyContextPatch.after,"// fpr adapter","// engine","// pure exclusion guard"];
 const baselineFiles={},sourceFiles={};
 for(const[i,file]of monthlyFprFiles.entries()){if(i<3){write(baselineRoot,file,before[i]);baselineFiles[file]=sha256(before[i]);}write(sourceRoot,file,after[i]);sourceFiles[file]=sha256(after[i]);}
 write(baselineRoot,"deploy/reports.sh","unchanged reports-only lock wrapper");fs.chmodSync(baselineRoot+"/deploy/reports.sh",0o755);
 const manifest={gitSha:"a".repeat(40),dirtyWorktree:false,files:[...Object.entries(baselineFiles).map(([file,h])=>({path:file,sha256:h})),{path:"deploy/reports.sh",sha256:sha256("unchanged reports-only lock wrapper")}]};
 const manifestPath=baselineRoot+"/release-manifest.json";fs.writeFileSync(manifestPath,JSON.stringify(manifest));
 const contract={sourceCommit:"b".repeat(40),sourceFiles,baselineFiles,baselineManifestSha256:sha256(fs.readFileSync(manifestPath))};return{baselineRoot,sourceRoot,outputRoot,contract,manifestPath};
}
test("monthly FPR overlay changes six files, preserves ordinary report semantics and wrappers",t=>{
 const f=fixture(t),r=buildFprMonthlyReporterOverlay(f);assert.deepEqual(r.changedFiles,[...monthlyFprFiles].sort());
 assert.equal(fs.readFileSync(f.outputRoot+"/deploy/reports.sh","utf8"),"unchanged reports-only lock wrapper");assert.equal(fs.statSync(f.outputRoot+"/deploy/reports.sh").mode&0o777,0o755);
 const facts=fs.readFileSync(f.outputRoot+"/"+monthlyFprFiles[0],"utf8");assert.equal(facts,monthlyExclusionPatch.after);
 const gate=new Function("getTournamentRatingExclusion","input","standing",facts+"\nreturn 'kept';");
 assert.equal(gate(()=>true,{tournament:{}},{id:"legacy-player"}),"kept");assert.equal(gate(()=>true,{tournament:{},fpr:{legacySource:{}}},{id:"fpr-player"}),null);
 assert.equal(fs.existsSync(f.outputRoot+"/src/services/community-rating/league.ts"),false);
 const m=JSON.parse(fs.readFileSync(f.outputRoot+"/release-manifest.json"));for(const e of m.files)assert.equal(sha256(fs.readFileSync(f.outputRoot+"/"+e.path)),e.sha256);
});
test("month builder preserves file and directory permissions under umask077",t=>{
 const f=fixture(t),prior=process.umask(0o077);try{buildFprMonthlyReporterOverlay(f);assert.equal(fs.statSync(f.outputRoot+"/deploy/reports.sh").mode&0o777,0o755);assert.equal(fs.statSync(f.outputRoot+"/src/services/player-rating").mode&0o777,0o755);assert.equal(fs.statSync(f.outputRoot+"/"+monthlyFprFiles[5]).mode&0o777,0o644);}finally{process.umask(prior);}
});
test("baseline or source drift fails before creating monthly output",t=>{
 const f=fixture(t);fs.appendFileSync(f.baselineRoot+"/deploy/reports.sh","foreign");assert.throws(()=>buildFprMonthlyReporterOverlay(f),/Hash mismatch/);assert.equal(fs.existsSync(f.outputRoot),false);
 const g=fixture(t);g.contract.sourceFiles[monthlyFprFiles[3]]="0".repeat(64);assert.throws(()=>buildFprMonthlyReporterOverlay(g),/Hash mismatch/);
});
test("missing context/query anchors and unexpected legacy exclusions are rejected",t=>{
 const f=fixture(t);const file=monthlyFprFiles[2],s=monthlyContextPatch.after+"\n"+monthlyContextPatch.after;fs.writeFileSync(f.sourceRoot+"/"+file,s);f.contract.sourceFiles[file]=sha256(s);assert.throws(()=>buildFprMonthlyReporterOverlay(f),/Owning source patch/);
 const g=fixture(t),manifest=JSON.parse(fs.readFileSync(g.manifestPath)),legacy="getTournamentRatingExclusion";fs.writeFileSync(g.baselineRoot+"/"+monthlyFprFiles[0],legacy);g.contract.baselineFiles[monthlyFprFiles[0]]=sha256(legacy);manifest.files.find(e=>e.path===monthlyFprFiles[0]).sha256=sha256(legacy);fs.writeFileSync(g.manifestPath,JSON.stringify(manifest));g.contract.baselineManifestSha256=sha256(fs.readFileSync(g.manifestPath));assert.throws(()=>buildFprMonthlyReporterOverlay(g),/legacy exclusion capability/);
});
test("month builder refuses symlinks, extra source paths and existing output",t=>{
 const f=fixture(t);f.contract.sourceFiles["extra.ts"]="0".repeat(64);assert.throws(()=>buildFprMonthlyReporterOverlay(f),/allowlist/);delete f.contract.sourceFiles["extra.ts"];
 const file=f.baselineRoot+"/deploy/reports.sh";fs.renameSync(file,file+".old");fs.symlinkSync(file+".old",file);assert.throws(()=>buildFprMonthlyReporterOverlay(f),/Non-regular/);
 fs.mkdirSync(f.outputRoot);assert.throws(()=>buildFprMonthlyReporterOverlay(f),/Output already exists/);
});

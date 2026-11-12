import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './fixtures/preview363NativeCustodyFixture.mjs';
import { createObservedRecovery } from '../nodered_reviewed_flow_deploy/preview363_observed_recovery.mjs';
import { sha256 } from '../lib/preview363_activation.mjs';

const names = ['preview363_native_operation.mjs','preview363_body_preserver.mjs','preview363_browser_guard.mjs',
  'runtime_contract.mjs','../lib/preview363_activation.mjs','../lib/preview363_body_patch.mjs','../diagnostics/preview-empty-tariff-observer.bundle.cjs'];
async function setup(t) {
  const f = await fixture(t); await f.reserve(); const begun = await f.begin(); await f.applyFixture(begun.seal);
  const old = n => path.join(f.stage,n), read = n => JSON.parse(fs.readFileSync(old(n)));
  const put = (p,v) => fs.writeFileSync(p, JSON.stringify(v),{mode:0o600});
  const code = [];
  for (const n of names) { const p=old('scripts/nodered_reviewed_flow_deploy/'+n); fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});
    fs.writeFileSync(p,'synthetic public code '+n,{mode:0o600});code.push(fs.readFileSync(p)); }
  const plan=read('plan.json');plan.codeSha256=sha256(Buffer.concat(code));put(old('plan.json'),plan);
  const planSha=sha256(fs.readFileSync(old('plan.json'))), attempt=read('attempt.json'); attempt.planSha256=planSha;put(old('attempt.json'),attempt);
  const lease=JSON.parse(fs.readFileSync(f.lease)); Object.assign(lease,{planSha256:planSha,codeSha256:plan.codeSha256});put(f.lease,lease);
  const stage=path.join(f.root,'.padlhub-preview363-recovery-20261112T120000Z-1');fs.mkdirSync(stage,{mode:0o700});
  const ackAt=f.now(); f.advance(600000);
  const native=await f.readback(f.candidate,'synthetic-post-revision');
  const m={kind:'preview363-observed-post-recovery-v1',oldStage:f.stage,oldPlanSha256:planSha,
    oldAttemptSha256:sha256(fs.readFileSync(old('attempt.json'))),oldCodeSha256:plan.codeSha256,
    sourceSha256:plan.sourceSha256,candidateSha256:plan.candidateSha256,postDiskSha256:sha256(fs.readFileSync(f.live)),
    targetSha256:plan.targetSha256,revisionSha256:native.revisionSha256,candidateGraphSha256:plan.candidateGraphSha256,
    candidateOrderedGraphSha256:plan.candidateOrderedGraphSha256,editorOrderedGraphSha256:native.editorOrderedGraphSha256,
    afterFunctionSha256:plan.afterFunctionSha256,settingsSha256:'f'.repeat(64),sourceCommit:plan.sourceCommit,
    bundleSha256:sha256(fs.readFileSync(old('scripts/diagnostics/preview-empty-tariff-observer.bundle.cjs'))),
    actualAckAtMs:ackAt,recoveryCodeSha256:'e'.repeat(64)};
  // Editor is the unchanged pre-deploy editor snapshot; full native body is candidate.
  m.editorOrderedGraphSha256=plan.editorOrderedGraphSha256;native.editorOrderedGraphSha256=m.editorOrderedGraphSha256;
  put(path.join(stage,'recovery-manifest.json'),m);
  let o={status:'SAFE_LOG_OBSERVATION',at:new Date(f.now()).toISOString(),samePid:true,sameRestartCount:true,coverageComplete:true,
    readyExpected:1,unavailable:0,routerRuntimeErrors:0,malformedEnvelopes:0,sourceStableDuringObservation:true,
    sourceSha256:m.postDiskSha256,functionSha256:m.afterFunctionSha256,settingsSha256:m.settingsSha256};
  let fault='';const options={stage,root:f.root,uid:process.getuid(),gid:process.getgid(),now:f.now,
    readTarget:f.options.readTarget,codeHash:()=>m.recoveryCodeSha256,observe:()=>({...o,at:new Date(f.now()).toISOString()}),
    fault:n=>{if(n===fault)throw Error('SIMULATED_CRASH');}};
  const op=()=>createObservedRecovery(options);
  const input=()=>({expectedManifestSha256:sha256(fs.readFileSync(path.join(stage,'recovery-manifest.json'))),
    confirmation:'ADOPT_COMPLETE_PREVIEW363_POST_RECOVERY_NO_REPLAY_147',native:{...native,requestedAt:new Date(f.now()-33595).toISOString(),observedAt:new Date(f.now()).toISOString()}});
  return {...f,stage,old,m,options,op,input,put,observe:o,setFault:n=>{fault=n;}};
}

test('separate long full-body recovery starts a new900s soak and receipt-first releases only own lease',async t=>{
  const f=await setup(t),before=fs.readFileSync(f.live),oldFiles=fs.readdirSync(f.m.oldStage);
  assert.equal((await f.op().adopt(f.input())).status,'RECOVERY_SOAKING');
  const lease=fs.readFileSync(f.lease);
  await assert.rejects(f.op().finish(f.input()),/SOAK_INCOMPLETE/);
  f.advance(900000);await assert.rejects(f.op().finish(f.input()),/SOAK_INCOMPLETE/);
  f.advance(33595);
  assert.equal((await f.op().finish(f.input())).leaseReleased,true);
  assert.equal(fs.existsSync(f.lease),false);assert.equal((await f.op().finish(f.input())).status,'RECOVERY_FINISHED');
  assert.deepEqual(fs.readFileSync(f.live),before);assert.deepEqual(fs.readdirSync(f.m.oldStage),oldFiles);
  assert.equal(JSON.parse(lease).phase,'recovery-soaking');
});

for(const [name,mutate] of [
  ['request121s',(f,x)=>{x.native.requestedAt=new Date(f.now()-120001).toISOString();}],
  ['completion31s',(f,x)=>{x.native.observedAt=new Date(f.now()-30001).toISOString();}],
  ['future',(f,x)=>{x.native.observedAt=new Date(f.now()+1).toISOString();}],
  ['reversed',(f,x)=>{x.native.requestedAt=new Date(f.now()+1).toISOString();}],
  ['beforeACK',(f,x)=>{x.native.requestedAt=new Date(f.m.actualAckAtMs-1).toISOString();}],
  ['revision',(_f,x)=>{x.native.revisionSha256='0'.repeat(64);}],
  ['partial',(_f,x)=>{delete x.native.graphSha256;}],
  ['order',(_f,x)=>{x.native.orderedGraphSha256='0'.repeat(64);}],
  ['editor',(_f,x)=>{x.native.editorOrderedGraphSha256='0'.repeat(64);}],
  ['foreignorigin',(_f,x)=>{x.native.origin='http://example.invalid';}],
  ['foreignlease',f=>{const l=JSON.parse(fs.readFileSync(f.lease));l.stage+='2';f.put(f.lease,l);}],
  ['oldplan',f=>{fs.appendFileSync(f.old('plan.json'),' ');}],
  ['oldattempt',f=>{fs.appendFileSync(f.old('attempt.json'),' ');}],
  ['oldcode',f=>{fs.appendFileSync(f.old('scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs'),' ');}],
  ['newcode',f=>{f.options.codeHash=()=> '0'.repeat(64);}],
  ['disk',f=>{fs.appendFileSync(f.live,' ');}],
  ['identity',f=>{f.driftTarget();}],
  ['READY',f=>{f.observe.readyExpected=0;}],
  ['coverage',f=>{f.observe.coverageComplete=false;}],
  ['restart',f=>{f.observe.sameRestartCount=false;}],
  ['runtimeerror',f=>{f.observe.routerRuntimeErrors=1;}],
  ['settings',f=>{f.observe.settingsSha256='0'.repeat(64);}],
])test(`recovery refuses ${name}, keeps custody and never records adoption`,async t=>{
  const f=await setup(t),x=f.input();mutate(f,x);
  await assert.rejects(async()=>f.op().adopt(x));assert.equal(fs.existsSync(f.lease),true);
  assert.equal(fs.existsSync(path.join(f.stage,'adoption.json')),false);
});

test('120s/30s exact boundaries pass; acquisition timestamps are retained',async t=>{
  const f=await setup(t),x=f.input();x.native.requestedAt=new Date(f.now()-120000).toISOString();x.native.observedAt=new Date(f.now()-30000).toISOString();
  await f.op().adopt(x);const r=JSON.parse(fs.readFileSync(path.join(f.stage,'adoption.json')));assert.deepEqual(r.native,x.native);
});
test('adoption receipt crash resumes without shortening or resetting soak',async t=>{
  const f=await setup(t);f.setFault('after-adoption');await assert.rejects(f.op().adopt(f.input()),/SIMULATED_CRASH/);
  const r=fs.readFileSync(path.join(f.stage,'adoption.json'));assert.equal(JSON.parse(fs.readFileSync(f.lease)).phase,'reserved');
  f.setFault('');f.advance(60000);await f.op().adopt(f.input());assert.deepEqual(fs.readFileSync(path.join(f.stage,'adoption.json')),r);
  const l=JSON.parse(fs.readFileSync(f.lease));assert.equal(l.expiresAtMs,JSON.parse(r).soakUntilMs);
});
test('ticking clock cannot corrupt the durable900s adoption interval',async t=>{
  const f=await setup(t);let tick=f.now();f.options.now=()=>tick++;
  await f.op().adopt(f.input());const r=JSON.parse(fs.readFileSync(path.join(f.stage,'adoption.json')));
  assert.equal(r.soakUntilMs-r.adoptedAtMs,900000);assert.equal(JSON.parse(fs.readFileSync(f.lease)).expiresAtMs,r.soakUntilMs);
});
test('finish receipt crash resumes, but foreign lease and disk drift remain sticky',async t=>{
  const f=await setup(t);await f.op().adopt(f.input());f.advance(933595);f.setFault('after-finish');
  await assert.rejects(f.op().finish(f.input()),/SIMULATED_CRASH/);assert.equal(fs.existsSync(f.lease),true);
  const own=fs.readFileSync(f.lease);f.put(f.lease,{formatVersion:99});f.setFault('');
  await assert.rejects(f.op().finish(f.input()),/OWN_LEASE/);assert.equal(JSON.parse(fs.readFileSync(f.lease)).formatVersion,99);
  fs.writeFileSync(f.lease,own);fs.appendFileSync(f.live,' ');await assert.rejects(f.op().finish(f.input()),/CURRENT_DRIFT/);
  assert.equal(fs.existsSync(f.lease),true);
});
for(const action of ['adopt','finish'])test(`${action} rechecks freshness after receipt and final identity I/O`,async t=>{
  const f=await setup(t);if(action==='finish'){await f.op().adopt(f.input());f.advance(933595);}
  f.options.fault=()=>f.advance(31000);
  await assert.rejects(f.op()[action](f.input()),/PUBLICATION_FRESHNESS/);assert.equal(fs.existsSync(f.lease),true);
  f.options.fault=()=>{};
  assert.equal((await f.op()[action](f.input())).status,action==='adopt'?'RECOVERY_SOAKING':'RECOVERY_FINISHED');
});

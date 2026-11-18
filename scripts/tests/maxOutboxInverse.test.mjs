import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {graphFixture} from './fixtures/max-outbox-native-fixture.mjs';
import {buildMaxOutboxOnlyResume,MAX_OUTBOX_RESUME_REQUIRED_IDS,nodeSha256,sha256} from '../nodered_max_outbox_resume.mjs';
import {buildMaxOutboxOnlyInverse} from '../nodered_max_outbox_inverse.mjs';
import {createMaxOutboxNativeOperation,max_outboxOperationCodeHash} from '../nodered_reviewed_flow_deploy/max_outbox_native_operation.mjs';
import {createMaxOutboxInverseNativeOperation,max_outbox_inverseOperationCodeHash} from '../nodered_reviewed_flow_deploy/max_outbox_inverse_native_operation.mjs';
import {max_outboxGraphHash,max_outboxOrderedGraphHash,createMaxOutboxBodyPreserver} from '../nodered_reviewed_flow_deploy/max_outbox_body_preserver.mjs';
import {createMaxOutboxInverseBodyPreserver} from '../nodered_reviewed_flow_deploy/max_outbox_inverse_body_preserver.mjs';

const raw=flow=>JSON.stringify(flow,null,4);
const setup=()=>{
  const original=raw(graphFixture()),nodes=JSON.parse(original);
  const trustedPins={flowSha256:sha256(original),nodeSha256:Object.fromEntries(MAX_OUTBOX_RESUME_REQUIRED_IDS.map(id=>[id,nodeSha256(nodes.find(n=>n.id===id))]))};
  return {original,trustedPins,current:buildMaxOutboxOnlyResume(original,trustedPins).flow};
};
test('inverse accepts only exact ordered forward graph and restores the original opaque fields',()=>{
  const f=setup();const restored=buildMaxOutboxOnlyInverse(raw(f.current),f.original,f.trustedPins);
  assert.deepEqual(restored.flow,JSON.parse(f.original));assert.equal(restored.removedIds.length,2);
  for(const mutate of [g=>g.reverse(),g=>{g[2].bot='wrong-channel';},g=>{g[3].d=false;},g=>g.push({id:'foreign',type:'debug'})]){
    const current=structuredClone(f.current);mutate(current);
    assert.throws(()=>buildMaxOutboxOnlyInverse(raw(current),f.original,f.trustedPins),/SOURCE_DRIFT/);
  }
  assert.throws(()=>buildMaxOutboxOnlyInverse(raw(f.current),f.original+' ',f.trustedPins),/PREIMAGE_MISMATCH/);
});

async function operationFixture(t){
  const f=setup(),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'max-inverse-')));fs.chmodSync(root,0o700);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const stage=path.join(root,'.padlhub-max_outbox-stage-20261113T110000Z-1');fs.mkdirSync(stage,{mode:0o700});
  const live=path.join(root,'flows.json'),lease=path.join(root,'.padlhub-reviewed-flow-deploy.lease.json');fs.writeFileSync(live,f.original,{mode:0o600});
  let now=Date.parse('2026-11-13T11:00:00Z');const target='b'.repeat(64),commit='c'.repeat(40);
  const opts={root,uid:process.getuid(),gid:process.getgid(),getUid:()=>process.getuid(),now:()=>now,readTarget:()=>target};
  const read=async(flow,rev)=>({origin:'http://127.0.0.1:18801',requestedAt:new Date(now).toISOString(),observedAt:new Date(now).toISOString(),
    graphSha256:await max_outboxGraphHash(flow),orderedGraphSha256:await max_outboxOrderedGraphHash(flow),editorOrderedGraphSha256:await max_outboxOrderedGraphHash(flow),revisionSha256:sha256(rev)});
  const forward=createMaxOutboxNativeOperation({...opts,stage});
  const prepared=await forward.prepare({expectedSourceSha256:sha256(f.original),expectedTargetSha256:target,expectedCodeSha256:max_outboxOperationCodeHash(),sourceCommit:commit,trustedPins:f.trustedPins,native:await read(JSON.parse(f.original),'pre')});
  const plan=prepared.planSha256;
  await forward.reserve({expectedPlanSha256:plan,confirmation:'RESERVE_MAX_OUTBOX_NATIVE_NO_RESTART_147',native:await read(JSON.parse(f.original),'pre')});
  const begun=await forward.begin({expectedPlanSha256:plan,native:await read(JSON.parse(f.original),'pre')});
  const preserve=await createMaxOutboxBodyPreserver(begun.seal,{rev:'pre',flows:JSON.parse(f.original)});
  const request={url:'http://127.0.0.1:18801/flows',method:'POST',apiVersion:'v2',deploymentType:'nodes'};
  const out=await preserve({request,postBody:{rev:'pre',flows:JSON.parse(f.original)}});fs.writeFileSync(live,raw(f.current));
  await forward.confirm({expectedPlanSha256:plan,native:await read(f.current,'forward'),httpStatus:200,ackAt:now,audit:{...out.audit,status:'FORWARDED_AWAITING_READBACK',forwarded:1,rejected:0,notAfter:begun.seal.notAfter}});
  const inverseStage=path.join(root,'.padlhub-max_outbox_inverse-stage-20261113T110001Z-1');fs.mkdirSync(inverseStage,{mode:0o700});
  const inverse=createMaxOutboxInverseNativeOperation({...opts,stage:inverseStage});
  // Evidence is awaited before crossing into the operation.
  const preparedInverse=await inverse.prepare({expectedSourceSha256:sha256(fs.readFileSync(live)),expectedTargetSha256:target,expectedCodeSha256:max_outbox_inverseOperationCodeHash(),sourceCommit:commit,forwardStage:stage,forwardPlanSha256:plan,native:await read(f.current,'forward')});
  return {...f,root,stage,inverseStage,live,lease,forward,inverse,read,request,plan:preparedInverse.planSha256,now:()=>now,advance:n=>{now+=n;}};
}
test('paired exact inverse consumes matching forward custody and restores source without replay',async t=>{
  const f=await operationFixture(t),native=await f.read(f.current,'forward');
  await f.inverse.reserve({expectedPlanSha256:f.plan,confirmation:'RESERVE_MAX_OUTBOX_INVERSE_NATIVE_NO_RESTART_147',native});
  assert.equal(JSON.parse(fs.readFileSync(f.lease)).kind,'max-outbox-inverse-native-nodes');
  const b=await f.inverse.begin({expectedPlanSha256:f.plan,native});
  const preserve=await createMaxOutboxInverseBodyPreserver(b.seal,{rev:'forward',flows:f.current});
  const out=await preserve({request:f.request,postBody:{rev:'forward',flows:f.current}});const restored=JSON.parse(out.postDataText).flows;
  assert.deepEqual(restored,JSON.parse(f.original));fs.writeFileSync(f.live,raw(restored));
  const post=await f.read(restored,'inverse');
  await f.inverse.confirm({expectedPlanSha256:f.plan,native:post,httpStatus:200,ackAt:f.now(),audit:{...out.audit,status:'FORWARDED_AWAITING_READBACK',forwarded:1,rejected:0,notAfter:b.seal.notAfter}});
  await assert.rejects(f.inverse.finish({expectedPlanSha256:f.plan,native:post}),/SOAK_INCOMPLETE/);
  f.advance(900000);await f.inverse.finish({expectedPlanSha256:f.plan,native:await f.read(restored,'inverse')});
  assert.equal(fs.existsSync(f.lease),false);assert.equal(fs.readFileSync(f.live,'utf8'),f.original);
});
test('inverse retains foreign lease and rejects corrupted original backup',async t=>{
  const f=await operationFixture(t);const lease=JSON.parse(fs.readFileSync(f.lease));lease.stage+='-foreign';const foreign=JSON.stringify(lease);fs.writeFileSync(f.lease,foreign);
  await assert.rejects(f.inverse.reserve({expectedPlanSha256:f.plan,confirmation:'RESERVE_MAX_OUTBOX_INVERSE_NATIVE_NO_RESTART_147',native:await f.read(f.current,'forward')}),/EXISTING_LEASE/);
  assert.equal(fs.readFileSync(f.lease,'utf8'),foreign);
  fs.appendFileSync(path.join(f.inverseStage,'original.flow.json'),' ');
  await assert.rejects(f.inverse.reserve({expectedPlanSha256:f.plan,confirmation:'RESERVE_MAX_OUTBOX_INVERSE_NATIVE_NO_RESTART_147',native:await f.read(f.current,'forward')}),/PREIMAGE_MISMATCH/);
});

test('abandoning inverse before attempt retains incomplete forward custody',async t=>{
  const f=await operationFixture(t),native=await f.read(f.current,'forward');
  await f.inverse.reserve({expectedPlanSha256:f.plan,confirmation:'RESERVE_MAX_OUTBOX_INVERSE_NATIVE_NO_RESTART_147',native});
  const result=await f.inverse.abort({expectedPlanSha256:f.plan,native});
  assert.equal(result.leaseReleased,false);assert.equal(result.guardedHandbackRequired,true);assert.equal(fs.existsSync(f.lease),true);
  assert.equal(JSON.parse(fs.readFileSync(f.lease)).kind,'max-outbox-inverse-native-nodes');
});
test('inverse rejects predecessor source/candidate, timestamps and soaking ACK drift',async t=>{
  for(const key of ['sourceSha256','candidateSha256','acquiredAtMs','ackSha256']){
    const f=await operationFixture(t),lease=JSON.parse(fs.readFileSync(f.lease));lease[key]=key==='acquiredAtMs'?0:'0'.repeat(64);
    const original=JSON.stringify(lease);fs.writeFileSync(f.lease,original);
    await assert.rejects(f.inverse.reserve({expectedPlanSha256:f.plan,confirmation:'RESERVE_MAX_OUTBOX_INVERSE_NATIVE_NO_RESTART_147',native:await f.read(f.current,'forward')}),/PREDECESSOR_BINDING|PREDECESSOR_ACK/);
    assert.equal(fs.readFileSync(f.lease,'utf8'),original);
  }
});

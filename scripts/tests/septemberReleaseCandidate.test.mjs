import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {composeSeptemberRelease,writeSeptemberRelease} from '../prepare_lk_september_release_candidate.mjs';
import {validateReviewedFlowContract} from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
test('combined release rejects invalid source and public output paths',()=>{
 assert.throws(()=>composeSeptemberRelease(Buffer.from('[]'),'fixture'),/Node contract/);
 assert.throws(()=>writeSeptemberRelease('/unused','relative','fixture'),/absolute/);
});
const fixture=process.env.LK_RELEASE_SOURCE_FIXTURE;
test('private installed source composes exact eleven functions and four discovery nodes',{skip:!fixture},()=>{
 const bytes=fs.readFileSync(fixture);const before=JSON.parse(bytes);const {candidateBytes,contract}=composeSeptemberRelease(bytes,'fixture-combined');
 validateReviewedFlowContract({liveBytes:bytes,candidateBytes,contract});
 assert.equal(contract.allowedChanges.length,11);assert.equal(contract.allowedAdditions.length,4);
 const after=JSON.parse(candidateBytes);assert.equal(after.length,before.length+4);
 for(let i=0;i<before.length;i++)assert.equal(after[i].id,before[i].id);
 const modified=new Set(contract.allowedChanges.map(n=>n.id));
 before.forEach((n,i)=>{if(!modified.has(n.id))assert.deepEqual(after[i],n);});
 const repeated=()=>composeSeptemberRelease(candidateBytes,'fixture-combined');assert.throws(repeated,/Preimage drift/);
 const altered=structuredClone(before);altered.find(n=>n.id==='lk_split_leave_operation_route_20260801').outputs=5;
 assert.throws(()=>composeSeptemberRelease(Buffer.from(JSON.stringify(altered)),'fixture-drift'),/profile mismatch/);
});

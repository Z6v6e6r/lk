import assert from 'node:assert/strict';import fs from 'node:fs';import test from 'node:test';
import {HUB_LK1_SALE_HELPERS,HUB_LK1_SALE_SOURCE_FILES,buildHubRuntimeEvidence,normalizeFrozenHubSale} from '../lib/hubLk1SaleContract.mjs';
import {PITER_QUOTA48_UPDATE as binding} from '../lib/piterAtomicQuotaUpdateContract.mjs';
import {buildSaleOpeningCandidate} from '../prepare_subscription_sale_opening_candidate.mjs';
import {buildHubAtomicOpeningPlan} from '../lib/hubAtomicOpeningPlan.mjs';
import {sha256} from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
const historyBinding=JSON.parse(fs.readFileSync(new URL('../annual_subscription_history_binding.json',import.meta.url)));
const texts=Object.fromEntries(binding.targets.map(t=>[t.file,fs.readFileSync(new URL('../nodered_games_nodes/'+t.file,import.meta.url),'utf8')]));
test('opening code bindings and generated helpers are exact',()=>{
  for(const t of binding.targets)assert.equal(sha256(texts[t.file]),historyBinding.targets.find(n=>n.file===t.file)?.sourceTextSha256 ?? t.candidateSha256,t.file);
  for(const f of HUB_LK1_SALE_SOURCE_FILES)assert.ok(texts[f].includes('// BEGIN generated hubLk1SaleContract\n'+HUB_LK1_SALE_HELPERS+'// END generated hubLk1SaleContract'),f);
  assert.equal(binding.hubBookingReceipt.bookingUsageScope,'SUBSCRIPTION_BENEFIT_ONLY');
  assert.equal(binding.hubBookingReceipt.policy.maxActiveBookings,4);
});
test('unreviewed source cannot produce an opening artifact',()=>assert.throws(()=>buildSaleOpeningCandidate({liveBytes:Buffer.from('[]'),sourceTexts:texts}),/source drift/));
test('frozen historical and selected-subscription receipts preserve their exact scope and digest',()=>{
 for(const scope of ['ALL_BOOKINGS','SUBSCRIPTION_BENEFIT_ONLY']){
  const receipt={...binding.hubBookingReceipt,bookingUsageScope:scope};
  assert.deepEqual(normalizeFrozenHubSale(receipt),receipt);
 }
 for(const scope of ['UNKNOWN','subscription_benefit_only',null,undefined])assert.equal(normalizeFrozenHubSale({...binding.hubBookingReceipt,bookingUsageScope:scope}),null);
});
const fixture=process.env.SUBSCRIPTION_SALE_LIVE_FIXTURE;
test('private installed-flow composition preserves unrelated graph and supports exact reverse',{skip:!fixture},()=>{
 const liveBytes=fs.readFileSync(fixture);const built=buildSaleOpeningCandidate({liveBytes,sourceTexts:texts});
 assert.equal(built.report.structuralReverseCheckPassed,true);assert.equal(built.report.activationPerformed,false);
 const before=JSON.parse(liveBytes),after=JSON.parse(built.candidateBytes), changed=new Set(binding.targets.map(t=>t.id));
 for(let i=0;i<before.length;i++)if(!changed.has(before[i].id))assert.deepEqual(after[i],before[i]);
 const drift={...texts,[binding.targets[0].file]:texts[binding.targets[0].file]+'\n'};
 assert.throws(()=>buildSaleOpeningCandidate({liveBytes,sourceTexts:drift}),/replacement drift/);
 for(const id of ['lk_subscription_booking_router_20260804','lk_subscription_managed_policy_20260820']){
  const mismatched=structuredClone(before);const n=mismatched.find(n=>n.id===id);
  n.func=n.func.replaceAll('SUBSCRIPTION_BENEFIT_ONLY','ALL_BOOKINGS');
  assert.throws(()=>buildHubRuntimeEvidence(mismatched),/usage scope mismatch/);
 }
 const historical=structuredClone(before);
 for(const id of ['lk_subscription_booking_router_20260804','lk_subscription_managed_policy_20260820']){
  const n=historical.find(n=>n.id===id);n.func=n.func.replaceAll('SUBSCRIPTION_BENEFIT_ONLY','ALL_BOOKINGS');
 }
 assert.equal(buildHubRuntimeEvidence(historical).receipt.bookingUsageScope,'ALL_BOOKINGS');
 assert.notEqual(buildHubRuntimeEvidence(historical).receipt.sourceDigest,binding.hubBookingReceipt.sourceDigest);
 // A valid but different receipt still cannot replace the pinned installed graph.
 assert.throws(()=>buildSaleOpeningCandidate({liveBytes:Buffer.from(JSON.stringify(historical)),sourceTexts:texts}),/source drift/);
});
test('HAB empty bootstrap is inactive, source-bound, rejects history and has exact activation CAS',()=>{
 const input={saleRows:[],capturedAt:'2026-09-09T10:00:00.000Z',now:'2026-09-09T10:01:00.000Z',activeFlowSha256:binding.candidateSha256,
 product:{id:'db7a5250-7369-4f43-8ac5-9111be24bc74',productType:'SUBSCRIPTION',cost:9800000,activationDays:1,validityDays:365,visits:365}};
 const original=structuredClone(input);const plan=buildHubAtomicOpeningPlan(input);
 assert.equal(plan.insert.document.ready,false);assert.equal(plan.insert.document.dailyDate,'2026-09-09');
 assert.equal(plan.insert.document.paidCount,0);assert.equal(plan.insert.document.dailyPaidCount,0);
 assert.deepEqual(plan.activate.filter,plan.insert.document);assert.equal(plan.activate.options.upsert,false);
 assert.equal(plan.activate.update.$set.ready,true);assert.equal(plan.mutationPerformed,false);assert.deepEqual(input,original);
 for(const change of [{saleRows:[{status:'PAID'}]},{saleRows:[plan.insert.document]},{activeFlowSha256:'a'.repeat(64)},
 {now:'2026-09-09T10:10:00.000Z'},{product:{...input.product,activationDays:365}},{product:{...input.product,cost:5680000}}]){
 assert.throws(()=>buildHubAtomicOpeningPlan({...input,...change}));}
});

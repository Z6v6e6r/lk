import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import { composeSubscriptionHistoryRelease, subscriptionDateExclusionBlock } from '../prepare_subscription_history_release.mjs';
import { subscriptionBookingPaginationEdits, applyPaginationEdits, composeSubscriptionBookingPagination } from '../prepare_subscription_booking_pagination.mjs';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture() {
  const booking = applyPaginationEdits(read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
    subscriptionBookingPaginationEdits().reverse().map(([a, b]) => [b, a]));
  const preview = read('../nodered_subscription_price_preview_nodes/router.js').replace(subscriptionDateExclusionBlock, '');
  const start = preview.indexOf('// Collect pages before');
  const end = preview.indexOf("if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {", start);
  const oldPreview = (preview.slice(0, start) + preview.slice(end)).replace('ctx.activeObservedAt ||=', 'ctx.activeObservedAt =')
    .replace('  delete ctx.bookingsPagesDeadlineAt;\n', '');
  return Buffer.from(JSON.stringify([{id:'tab',type:'tab'},
    {id:'lk_subscription_booking_router_20260804',type:'function',z:'tab',func:booking,wires:[[]],initialize:'/* preserve */'},
    {id:'lk_subscription_price_preview_20260908_router',type:'function',z:'tab',func:oldPreview,wires:[[]]},
    {id:'other',type:'function',z:'tab',func:'return msg;',wires:[[]]}]));
}
function options(bytes) {
  const f=JSON.parse(bytes);
  return {release:'a'.repeat(40),expectedSourceSha256:sha(bytes),expectedBookingSha256:sha(f[1].func),expectedPreviewSha256:sha(f[2].func)};
}
test('one combined candidate installs both fixes and preserves every unrelated graph field',()=>{
  const bytes=fixture(), before=JSON.parse(bytes), result=composeSubscriptionHistoryRelease(bytes,options(bytes)), after=JSON.parse(result.candidateBytes);
  assert.equal(result.report.paginationAlreadyInstalled,false);
  assert.equal(result.report.changedNodeIds.length,2);
  for(let i=0;i<before.length;i++) { const restored={...after[i]};if(Object.hasOwn(before[i],'func'))restored.func=before[i].func;assert.deepEqual(restored,before[i]); }
  assert(after[1].func.includes('collectVivaBookingPage'));
  assert(after[2].func.includes('SUBSCRIPTION_DATE_NOT_COVERED'));
  assert.equal(after[2].func.split(subscriptionDateExclusionBlock).length,2);
  assert.equal(result.contract.allowedAdditions.length,0);
});
test('installed pagination stays byte-identical while only preview gains the date reason',()=>{
  const bytes=fixture(), paged=composeSubscriptionBookingPagination(bytes,options(bytes)).candidateBytes;
  const result=composeSubscriptionHistoryRelease(paged,options(paged)), before=JSON.parse(paged), after=JSON.parse(result.candidateBytes);
  assert.equal(result.report.paginationAlreadyInstalled,true);
  assert.deepEqual(result.report.changedNodeIds,['lk_subscription_price_preview_20260908_router']);
  assert.equal(after[1].func,before[1].func);
  assert.equal(after[2].func.replace(subscriptionDateExclusionBlock,''),before[2].func);
});
test('exact source, function, topology and repeated/partial capability drift are refused',()=>{
  const bytes=fixture(), good=options(bytes);
  assert.throws(()=>composeSubscriptionHistoryRelease(bytes,{...good,expectedSourceSha256:'0'.repeat(64)}));
  assert.throws(()=>composeSubscriptionHistoryRelease(bytes,{...good,expectedPreviewSha256:'0'.repeat(64)}));
  for(const mutate of [f=>f.push(f[1]),f=>f[1].d=true,f=>f[0].disabled=true,f=>f[1].func+='\n// collectVivaBookingPage']) {
    const f=JSON.parse(bytes);mutate(f);const changed=Buffer.from(JSON.stringify(f));
    assert.throws(()=>composeSubscriptionHistoryRelease(changed,options(changed)));
  }
  const first=composeSubscriptionHistoryRelease(bytes,good).candidateBytes;
  assert.throws(()=>composeSubscriptionHistoryRelease(first,options(first)),/DATE_ANCHOR_DRIFT/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EVENT_ROUTE_TARGETS as targets, patchEventPaymentBody, composeEventPaymentRoutes as compose,
  writeEventPaymentRoutes } from '../prepare_event_payment_routes_upgrade.mjs';
import { GROUP_UPGRADE_TARGETS, hash } from '../prepare_group_event_payment_upgrade.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read=file=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
function gatewayFixture() {
  let body=read('../nodered_lk1_hub_nodes/gateway.js').replace('  if (lk1NeedsVisitJob(ctx) && !ctx.lk1.visitJob) return lk1Stop(ctx, "LK1_VISIT_JOB_MISSING");\n','');
  const ds=JSON.parse(read('../nodered_lk1_hub_nodes/event_routes_delta.json'));
  // This also detects an edit to the canonical route code without its release delta.
  for(const d of [...ds].reverse()){assert.equal(body.split(d.after).length,2);body=body.replace(d.after,()=>d.before);}
  for(const d of [...GROUP_UPGRADE_TARGETS[0].deltas].reverse()){assert.equal(body.split(d.after).length,2);body=body.replace(d.after,()=>d.before);}
  return read('../nodered_group_booking_confirmation_nodes/helpers.js')+`
const prepareHttp = (ctx, step, method, url, payload, headers = {}) => {
  delete ctx.lk1GroupConfirmationRead;
  if (lk1GroupMoneyBooking(ctx) && step === "confirmation_bookings" && method === "GET"
    && url === VIVA_API_BASE && headers.Authorization === ctx.authHeader) {
    ctx.lk1GroupConfirmationRead = { url };
  }
  ctx.step = step;
};
const adminVersion = ctx.caller === "split" || (lk1GroupMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";
if (ctx.step === "confirmation_bookings") {
    const groupMoney = lk1GroupMoneyBooking(ctx);
    if (groupMoney && !lk1GroupSelfReadback(ctx)) return lk1Stop(ctx, "LK1_BOOKING_READBACK_UNVERIFIED");
    const matches = rows.filter(booking => isObj(booking)
      && (groupMoney ? lk1GroupOwnerMatches(booking, ctx.actorClientId)
        : normalizeId(bookingClientId(booking)) === normalizeId(ctx.actorClientId))
      && (!groupMoney || lk1GroupUnpaidOnPlace(booking)));
}
`+body;
}
function fixture(){
  const bodies=[`const body=msg.payload;msg._subscriptionBooking={\n  caller: "http",\n};return msg;`,gatewayFixture(),
    `if (ctx.lk1) {\n  if (ctx.step === "lk1_payment_products" && responseStatus === 200) {\nreturn msg;} }`,
    'return msg;', '// helper prefix preserved\n// Dedicated advisory graph.\nreturn msg;'];
  const rows=targets.map((t,i)=>({id:t.id,type:'function',func:bodies[i],outputs:1,wires:[[]],name:'fixture',initialize:'// keep'}));
  rows.push({id:'fixture-tab',type:'tab',label:'unchanged'});
  const pins=targets.map((t,i)=>({...t,before:hash(bodies[i]),after:hash(patchEventPaymentBody(bodies[i],t.id))}));
  return{rows,pins,bytes:Buffer.from(JSON.stringify(rows))};
}
test('event release composes five function bodies and preserves graph, installed helpers and game lifecycle',()=>{
  const {rows,pins,bytes}=fixture();const {candidate,candidateBytes,contract}=compose(bytes,'event-fixture',pins);
  for(let i=0;i<rows.length;i++){const{func,...rest}=candidate[i];const{func:old,...oldRest}=rows[i];assert.deepEqual(rest,oldRest);if(i<5)assert.notEqual(func,old);}
  assert.match(candidate[0].func,/expectedTournamentDiscount/);
  assert.match(candidate[1].func,/lk1_tournament_payment_products/);
  assert.doesNotMatch(candidate[1].func,/const lk1GroupSelfReadback/);
  assert.match(candidate[4].func,/^\/\/ helper prefix preserved/);
  for(const mutate of [f=>f[1].wires=[['other']],f=>f[0].initialize='changed',f=>f.push({id:'new',type:'tab'})]){
    const f=structuredClone(candidate);mutate(f);assert.throws(()=>validateReviewedFlowContract({liveBytes:bytes,candidateBytes:Buffer.from(JSON.stringify(f)),contract}));
  }
  validateReviewedFlowContract({liveBytes:bytes,candidateBytes,contract});
});
test('release refuses unknown preimages, non-function drift, repeat apply and bad postimages',()=>{
  const{rows,pins,bytes}=fixture();assert.throws(()=>compose(bytes,'event-fixture'),/Preimage drift/);
  for(const mutate of [f=>f[0].func+='\n// drift',f=>f[1].disabled=true,f=>f[2].outputs=2,f=>f.push({...f[0]}),f=>f.shift()]){
    const f=structuredClone(rows);mutate(f);assert.throws(()=>compose(Buffer.from(JSON.stringify(f)),'event-fixture',pins));
  }
  assert.throws(()=>compose(bytes,'event-fixture',pins.map(t=>({...t,after:'0'.repeat(64)}))),/Postimage drift/);
  const built=compose(bytes,'event-fixture',pins);assert.throws(()=>compose(built.candidateBytes,'event-fixture',pins),/Preimage drift/);
});
test('CLI refuses raw flow export inside Git',()=>{
  const root=new URL('../../',import.meta.url).pathname.replace(/\/$/,'');
  assert.throws(()=>writeEventPaymentRoutes('/missing',root+'/forbidden-event-output','event-fixture'),/outside Git/);
});
test('fresh private live snapshot matches all frozen pins and preserves split function byte-for-byte',{
  skip:!process.env.LK_EVENT_ROUTES_LIVE_FIXTURE,
},()=>{
  const bytes=fs.readFileSync(process.env.LK_EVENT_ROUTES_LIVE_FIXTURE);const before=JSON.parse(bytes);
  const{candidate}=compose(bytes,'event-live-offline');
  for(const node of before.filter(n=>!targets.some(t=>t.id===n.id)))assert.deepEqual(candidate.find(n=>n.id===node.id),node);
});

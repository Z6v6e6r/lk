import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { lk1LegacyCancellationCandidate, lk1LegacyCancellationReadback } from '../lib/lk1LegacyCancellation.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { fixture } from './fixtures/lk1FreeCancellationFixtures.mjs';
import { applyLegacyEdits, legacyRouterEdits, legacyFinalizerEdits, composeLegacyCancellationRecovery, legacySha, LEGACY_IDS } from '../prepare_legacy_cancellation_recovery.mjs';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const protocol = read('../lib/lk1FreeCancellation.mjs').replace(/^export /gm, '');
const guard = read('../nodered_lk1_hub_nodes/daily_visit_guard.js');
const ack = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
function legacyFixture() {
  const f = fixture(); f.op.state = 'RELEASED'; f.op.releasedAt = f.op.updatedAt;
  f.op.releaseBookingId = f.op.bookingId; f.op.releasedBookingIds = [f.op.bookingId];
  f.b.cancelled = f.b.isCancelled = true;
  f.sub.bookings = f.sub.bookings.filter(b => b.id !== f.b.id); f.sub.visitsLeft++;
  return f;
}
const subscriptions = f => ({ content: [f.sub], last: true, totalElements: 1 });
test('legacy readback requires cancelled exact booking and complete, consistent non-consumption', () => {
  const f = legacyFixture(); assert.ok(lk1LegacyCancellationReadback(f.op, f.b, subscriptions(f)));
  for (const mutate of [f => { f.b.cancelled = false; }, f => { f.b.clientId = 'other'; },
    f => { f.b.exerciseId = 'other'; }, f => { f.b.clientSubscriptionId = 'other'; },
    f => { delete f.b.exerciseId; }, f => { f.b.paymentType = 'ONE_TIME'; },
    f => { f.sub.bookings.push(f.b); f.sub.visitsLeft--; }, f => { f.sub.visitsLeft++; },
    f => { f.sub.product.id = 'other'; }, f => { f.sub.bookings[0].clientId = 'other'; },
    f => { f.sub.bookings[0].client = { id: 'other' }; }, f => { f.sub.bookings.push(f.sub.bookings[0]); f.sub.visitsLeft--; },
    f => { f.sub.clientId = 'other'; }, f => { f.sub.clientSubscriptionId = 'other'; },
    f => { f.sub.visitsLeft = 0.5; }]) {
    const changed = legacyFixture(); mutate(changed);
    assert.equal(lk1LegacyCancellationReadback(changed.op, changed.b, subscriptions(changed)), null);
  }
  for (const p of [{ content: [f.sub], last: false, totalElements: 2 },
    { content: [f.sub, f.sub], last: true, totalElements: 2 },
    { content: [f.sub], last: true, totalElements: 2 }]) assert.equal(lk1LegacyCancellationReadback(f.op, f.b, p), null);
});
test('bare RELEASED, money, adjustment and modern cancellation paths cannot use compatibility', () => {
  for (const change of [f => { f.op.releaseBookingId = 'other'; }, f => { f.op.state = 'CONFIRMED'; },
    f => { f.op.releasedAt = 'invalid'; }, f => { f.op.releaseReason = 'CANCELLED_UNPAID_BOOKING'; },
    f => { f.op.releaseSource = 'GAME_LEAVE'; }, f => { f.op.lk1.checkout = {}; },
    f => { f.op.lk1.transactionAttemptedAt = 'date'; }, f => { f.op.lk1.visitJob = {}; },
    f => { f.op.lk1.freeCancellationReturn = {}; }, f => { f.op.lk1.decision.benefit.finalPriceMinor = 1; },
    f => { f.op.managedEntitlementOperationId = 'external'; }]) {
    const f = legacyFixture(); change(f); assert.equal(lk1LegacyCancellationCandidate(f.op), false);
  }
});
// CI fixture runs the actual maintained guard, protocol and new dispatch fragment.
// No production flow or customer data is checked into this synthetic graph.
function syntheticRouter() {
  return `const ctx = msg._subscriptionBooking;
const normalizeId = x => typeof x === 'string' ? x.toLowerCase() : null;
const isValidDateKey = x => /^\\d{4}-\\d{2}-\\d{2}$/.test(x);
const OUTPUT_MONGO_UPDATE = 3, VIVA_API_BASE = 'https://fixture.invalid';
const emit = type => ({ type, msg });
const lk1Stop = (_ctx, code) => ({ type:'stop', code });
const lk1Find = (_ctx, step, query) => { ctx.step=step; return {type:'find', query}; };
const lk1MongoMatched = p => p?.acknowledged === true ? p.matchedCount : null;
const prepareMongoUpdate = (_ctx, step, query, update) => {ctx.step=step;return {type:'update',query,update};};
const preparePreaccept = () => ({type:'preaccept'}), prepareBookingCreate = () => ({type:'booking'});
const lk1ReplayIdentityMatches = () => true;
const finishError = (_ctx, status, error, details) => ({type:'error',status,error,details});
const lk1FreeServiceToken = () => 'fixture-service';
const prepareHttp = (_ctx, step, method, url) => {ctx.step=step;Object.assign(msg,{method,url});return {type:'http',method,url};};
${read('../nodered_lk1_hub_nodes/gateway.js').split('const lk1HttpRejoinIdentity =')[1].split('if (ctx.step === "lk1_http_rejoin_predecessor_find") {')[0].replace(/^/, 'const lk1HttpRejoinIdentity =')}
function predecessor(previous) {return previous.lk1.cancelledAllowanceRelease?.proofId || previous.lk1.freeCancellationReturn?.jobKey, true;}
${protocol}
${guard}
if(ctx.step==='lk1_ingress_operation_find'||ctx.step==='lk1_http_rejoin_predecessor_find') return {type:'rejoin',allowed:lk1HttpReleaseAllowsRejoin(msg.payload[0])};
return {type:'unhandled'};`;
}
const patchedRouter = new Function('msg', applyLegacyEdits(syntheticRouter(), legacyRouterEdits()));
function context(f, extra = {}) {
  return { ...f.op, operationId: 'lk-subscription-new', operationKey: 'new-operation', exerciseId: 'new-exercise',
    caller: 'http', action: 'book', step: 'lk1_daily_visit_owner', lk1: { ...f.op.lk1, dailyVisitPolicyVersion: 1 },
    lk1DailyVisitPrevious: { _id: 'daily-guard', kind: 'LK1_DAILY_VISIT_V1',
      ownerOperationKey: f.op._id, ownerOperationId: f.op.operationId }, ...extra };
}
function start(f = legacyFixture(), ctx = context(f)) {
  const msg = { _subscriptionBooking: ctx, payload: [f.op] };
  const run = payload => { msg.payload = payload; delete msg.error; return patchedRouter(msg); };
  const http = payload => { msg.statusCode = 200; msg.responseUrl = msg.url; return run(payload); };
  return { f, ctx, msg, run, http, first: patchedRouter(msg) };
}
function recover(s) {
  assert.equal(s.first.type, 'http'); assert.equal(s.first.method, 'GET');
  assert.equal(s.http(s.f.b).type, 'http');
  assert.equal(s.http(subscriptions(s.f)).type, 'find');
  return s.run([structuredClone(s.f.op)]);
}
test('old cancellation is read back and transfers only the exact guard through majority+j CAS', () => {
  const s = start(), out = recover(s);
  assert.equal(out.type, 3); assert.equal(s.ctx.step, 'lk1_daily_visit_takeover');
  assert.deepEqual(out.msg.payload[0], { _id: 'daily-guard', kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: s.f.op._id, ownerOperationId: s.f.op.operationId });
  assert.deepEqual(out.msg.payload[2], { writeConcern: { w: 'majority', j: true } });
  assert.equal(s.ctx.lk1DailyVisitOwned, undefined);
  assert.equal(s.run(ack).type, 'preaccept'); assert.equal(s.ctx.lk1DailyVisitOwned, true);
  assert.equal(s.f.op.lk1.freeCancellationReturn, undefined, 'no forged SERVICE proof');
  assert.equal(s.f.op.lk1.legacyCancellationReadback, undefined, 'no old-record rewrite');
});
test('same-event replay and explicit successor use the same reads before allowing rejoin', () => {
  for (const step of ['lk1_ingress_operation_find', 'lk1_http_rejoin_predecessor_find']) {
    const f = legacyFixture(), s = start(f, context(f, { step }));
    const result = recover(s); assert.equal(result.type, 'rejoin'); assert.equal(result.allowed, true);
  }
});
test('legacy successor retains operation identity, generation cap and predecessor lineage guards', () => {
  for (const id of ['custom-operation', 'lk-subscription-fixture:rejoin:1000', 'lk-subscription-fixture:rejoin:1']) {
    const f=legacyFixture(); f.op.operationId=id; f.op._id=`lk1-product:${JSON.stringify([f.op.tenantKey,f.op.actorClientId,id])}`;
    const s=start(f,context(f,{step:'lk1_ingress_operation_find',operationId:id}));
    const result=recover(s);assert.equal(result.type,'rejoin');assert.ok(!result.allowed,id);
  }
});
test('foreign actor/product, changed owner, failed read and redirected response stay blocked', () => {
  for (const extra of [{actorClientId:'other'}, {lk1:{rule:{productId:'other'}}}]) {
    const f = legacyFixture(), s = start(f, context(f, extra)); assert.notEqual(s.first.type, 'http');
    assert.notEqual(s.first.type, 3);
  }
  for (const change of [s => { s.msg.statusCode = 404; }, s => { s.msg.error = true; },
    s => { s.msg.responseUrl = 'https://other.invalid/'; }, s => { s.msg.method = 'POST'; },
    s => { s.ctx.lk1LegacyRecovery.startedAt -= 31000; }, s => { s.ctx.actorClientId = 'other'; }]) {
    const s = start(); s.msg.payload = s.f.b; s.msg.statusCode = 200; s.msg.responseUrl = s.msg.url;
    change(s); assert.equal(patchedRouter(s.msg).type, 'stop');
  }
  const s = start(); s.http(s.f.b); s.http(subscriptions(s.f));
  assert.equal(s.run([{...s.f.op,updatedAt:'2099-11-02T00:00:00Z'}]).code, 'LK1_LEGACY_CANCEL_OWNER_CHANGED');
});
test('lost or conflicting guard ACK rereads ownership and never assumes a new booking', () => {
  for (const ack of [{acknowledged:true,matchedCount:0,modifiedCount:0}, {acknowledged:false},
    {acknowledged:true,matchedCount:1,modifiedCount:0}]) {
    const s = start(); recover(s);
    const out = s.run(ack); assert.equal(out.type, 'find'); assert.equal(s.ctx.step, 'lk1_daily_visit_read');
    assert.equal(s.ctx.lk1DailyVisitOwned, undefined);
    const other = {...s.ctx.lk1DailyVisitPrevious,_id:`lk1-daily-visit:${JSON.stringify([s.ctx.tenantKey,s.ctx.clientSubscriptionId,s.ctx.serviceDate])}`,tenantKey:s.ctx.tenantKey,clientSubscriptionId:s.ctx.clientSubscriptionId,
      serviceDate:s.ctx.serviceDate,ownerOperationKey:'competitor',ownerOperationId:'competitor'};
    assert.equal(s.run([other]).type, 'find');
    const active = {...s.f.op,_id:'competitor',operationId:'competitor',state:'PENDING_CONFIRMATION'};
    assert.equal(s.run([active]).type, 'update'); assert.equal(s.ctx.step,'lk1_daily_visit_conflict_saved');
  }
});
const finalizer = new Function('msg','global', `const ctx=msg._subscriptionBooking,payload=msg.payload,responseStatus=msg.statusCode;\n${applyLegacyEdits(read('../nodered_lk1_hub_nodes/finalize.js'),legacyFinalizerEdits())}\nreturn [null,msg];`);
test('durably saved no-write conflict survives finalization as409; uncertainty stays202', () => {
  const s = start(); // A non-released competing owner causes the ordinary refusal.
  s.ctx.step = 'lk1_daily_visit_owner'; delete s.ctx.lk1LegacyRecovery;
  s.run([{...s.f.op,state:'CONFIRMED'}]); const refused = s.run(ack);
  assert.equal(refused.status,409);
  const msg = {_subscriptionBooking:s.ctx,statusCode:409,payload:{error:refused.error,details:refused.details}};
  assert.equal(finalizer(structuredClone(msg),{})[1].statusCode,409);
  for (const mutate of [m=>{delete m._subscriptionBooking.lk1DailyVisitRefusal;},
    m=>{m._subscriptionBooking.lk1.transactionAttemptedAt='date';},
    m=>{m._subscriptionBooking.lk1.createAttemptedAt='date';},
    m=>{m._subscriptionBooking.confirmedBookingId='booking';},
    m=>{m._subscriptionBooking.operationId='changed';},
    m=>{m._subscriptionBooking.step='booking_create';}]) {
    const changed=structuredClone(msg);mutate(changed);assert.equal(finalizer(changed,{})[1].statusCode,202);
  }
});
test('patch contract preserves unrelated nodes, topology, inverse, and rejects drift/reapply', () => {
  const original=[{id:'tab',type:'tab'}, {id:LEGACY_IDS[0],type:'function',z:'tab',outputs:8,wires:Array.from({length:8},()=>[]),func:syntheticRouter()},
    {id:LEGACY_IDS[1],type:'function',z:'tab',outputs:2,wires:[[],[]],func:'const ctx=msg._subscriptionBooking,payload=msg.payload,responseStatus=msg.statusCode;\n'+read('../nodered_lk1_hub_nodes/finalize.js')},
    {id:'unrelated',type:'function',z:'tab',outputs:1,wires:[[]],func:'return msg;'}];
  const bytes=Buffer.from(JSON.stringify(original)), options={expectedSourceSha256:legacySha(bytes),pins:original.slice(1,3).map(n=>legacySha(n.func))};
  const built=composeLegacyCancellationRecovery(bytes,options), candidate=JSON.parse(built.candidateBytes);
  assert.deepEqual(candidate[3],original[3]); assert.equal(built.contract.allowedAdditions.length,0);
  for(let i=1;i<=2;i++)assert.deepEqual({...candidate[i],func:original[i].func},original[i]);
  assert.throws(()=>composeLegacyCancellationRecovery(bytes,{...options,expectedSourceSha256:'0'.repeat(64)}));
  assert.throws(()=>composeLegacyCancellationRecovery(built.candidateBytes,{...options,expectedSourceSha256:legacySha(built.candidateBytes)}));
});
const livePath=process.env.LK1_LEGACY_CANCEL_LIVE_SOURCE;
test('private full installed router/finalizer composition replays the public guard path', {skip:!livePath&&'Private production source is never exported to CI'}, () => {
  const bytes=fs.readFileSync(livePath), built=composeLegacyCancellationRecovery(bytes,{expectedSourceSha256:legacySha(bytes)});
  const f=JSON.parse(built.candidateBytes), body=f.find(n=>n.id===LEGACY_IDS[0]).func;
  const execute=new Function('msg','node','global','env','flow',body);
  const fix=legacyFixture();
  const fingerprint=new Function(extractSubscriptionPricePreviewSource({source:body,roots:['lk1Fingerprint']}).source+';return lk1Fingerprint;')();
  fix.op.lk1.fingerprint=fingerprint({...fix.op,caller:'http',managedAction:'BOOK_TOURNAMENT'},fix.op.lk1);
  const ctx=context(fix), token='fixture.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fixture';
  const host={get:key=>key==='vivacrm_access_token'?token:undefined};
  const msg={_subscriptionBooking:ctx,payload:[fix.op]};
  const run=()=>execute(msg,{warn(){},error(){},send(){}},host,{get(){}},{});
  let out=run();assert.ok(out[0]);assert.equal(msg.method,'GET');
  for(const payload of [fix.b,subscriptions(fix)]){msg.payload=payload;msg.statusCode=200;msg.responseUrl=msg.url;out=run();}
  assert.ok(out[1]);msg.payload=[fix.op];out=run();assert.ok(out[3]);
  assert.equal(ctx.step,'lk1_daily_visit_takeover');
  // Exercise the real ingress/fingerprint and successor handlers, not a stub.
  for (const step of ['lk1_ingress_operation_find','lk1_http_rejoin_predecessor_find']) {
    const replay={...fix.op,caller:'http',action:'book',step,lk1IngressReplay:true,
      operationId:fix.op.operationId+(step==='lk1_http_rejoin_predecessor_find'?':rejoin:1':'')};
    delete replay.lk1;
    msg._subscriptionBooking=replay;msg.payload=[structuredClone(fix.op)];out=run();assert.ok(out[0]);
    for(const payload of [fix.b,subscriptions(fix)]){msg.payload=payload;msg.statusCode=200;msg.responseUrl=msg.url;out=run();}
    assert.ok(out[1]);msg.payload=[structuredClone(fix.op)];out=run();
    if(step==='lk1_ingress_operation_find') {
      assert.equal(out[4]?.statusCode,409);assert.equal(out[4].payload.details.code,'SUBSCRIPTION_BOOKING_RELEASED');
      assert.equal(out[4].payload.details.nextOperationId,fix.op.operationId+':rejoin:1');
    } else assert.ok(out[7], 'successor enters fresh instance checks');
  }
});

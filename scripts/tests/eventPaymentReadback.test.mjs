import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingReadbackSource } from '../lib/eventPaymentSources.mjs';
const source=bookingReadbackSource();
function helpers(msg={}) {
  return new Function('msg','VIVA_API_BASE','isObj','normalizeId','isSubscriptionBooking',source+
    '\nreturn {bind:lk1BindConfirmationRead,read:lk1BookingSelfReadback,owner:lk1BookingOwnerMatches,event:lk1EventMoneyBooking};')(
    msg,'https://api.vivacrm.ru',v=>v!==null&&typeof v==='object'&&!Array.isArray(v),v=>String(v||'').trim().toLowerCase(),b=>b.paymentType==='SUBSCRIPTION');
}
const context=()=>({caller:'split',managedAction:'JOIN_GAME',category:'open_game',tenantKey:'fixture',authHeader:'Bearer fixture',
 actorClientId:'fixture-actor',operationId:'fixture-op',operationKey:'fixture-key',lk1:{decision:{subscriptionVisitCount:1,benefit:{kind:'PERCENT_DISCOUNT',finalPriceMinor:140000}}}});
test('owner-less self-list requires exact one-use authenticated request proof',()=>{
  for(const mutation of [null,m=>m.method='POST',m=>m.url+='&other=1',m=>m.responseUrl='https://another.test',m=>m.followRedirects=true,m=>m.maxRedirects=1]) {
    const ctx=context();const msg={method:'GET',url:'https://api.vivacrm.ru/end-user/api/v2/fixture/bookings?size=1000',followRedirects:false,maxRedirects:0};
    const h=helpers(msg);h.bind(ctx,'confirmation_bookings',msg.method,msg.url,{Authorization:ctx.authHeader});
    if(mutation)mutation(msg);assert.equal(h.read(ctx),!mutation);assert.equal(h.read(ctx),false);
  }
  for(const field of ['actorClientId','operationId','operationKey','authHeader']) {
    const ctx=context();const msg={method:'GET',url:'https://api.vivacrm.ru/end-user/api/v2/fixture/bookings?size=1000',followRedirects:false,maxRedirects:0};
    const h=helpers(msg);h.bind(ctx,'confirmation_bookings',msg.method,msg.url,{Authorization:ctx.authHeader});ctx[field]='changed';assert.equal(h.read(ctx),false);
  }
});
test('all explicit owner aliases must match; monetary event modes never debit visits',()=>{
  const h=helpers();assert.equal(h.owner({},'fixture-actor'),true);
  for(const b of [{clientId:null},{clientId:'other'},{clientId:'fixture-actor',client:{id:'other'}},{client:[]},{playerId:1}])assert.equal(h.owner(b,'fixture-actor'),false);
  assert.equal(h.owner({clientId:'fixture-actor',client:{id:'fixture-actor'}},'fixture-actor'),true);
  for(const [action,category]of [['BOOK_GROUP_TRAINING','group_training'],['BOOK_TOURNAMENT','tournament']]){
    const ctx=context();ctx.caller='http';ctx.managedAction=action;ctx.category=category;ctx.lk1.decision.subscriptionVisitCount=0;
    assert.equal(h.event(ctx),true);ctx.lk1.decision.subscriptionVisitCount=1;assert.equal(h.event(ctx),false);
  }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyReconciledEdits, timeoutPreservationEdits } from '../prepare_reconciled_cancellation_recovery.mjs';
const raw=fs.readFileSync(new URL('../nodered_games_nodes/fn_split_cleanup_router.js',import.meta.url),'utf8');
const variants=[['maintained source',raw]];
if(process.env.LK1_TIMEOUT_CLEANUP_SOURCE)variants.push(['exact installed source',applyReconciledEdits(fs.readFileSync(process.env.LK1_TIMEOUT_CLEANUP_SOURCE,'utf8'),timeoutPreservationEdits())]);
const ctx=()=>({step:'preflight_actor_booking',mode:'PARTICIPANT_TIMEOUT',token:'fixture-token',gameId:'fixture-game',reason:'PAYMENT_TIMEOUT',
  currentBookingId:'fixture-booking',currentClientId:'fixture-client',currentTransactionUnpaidVerified:true,
  currentProbeRequest:{scope:'admin',method:'GET',path:'/clients/fixture-client/bookings/fixture-booking/cancel',label:'admin_client_cancel_probe'},
  bookingQueue:[],bookingResults:[],initialBookingIds:['fixture-booking'],trace:[],exerciseId:null,exerciseCancelled:true,
  nextParticipants:[],nextWaitlist:[],nextSplitPayments:[],nextLeaveEvents:[],timedOutPayments:[]});
const row=()=>({id:'fixture-booking',client:{id:'fixture-client'},paymentType:'SUBSCRIPTION',clientSubscriptionId:'fixture-subscription',isCancelled:false,cancelled:false});
for(const [label,source]of variants){
  const run=new Function('msg','global','node','env',source);
  const execute=(c,p,status=200)=>{const m={_splitCleanupCtx:c,payload:p,statusCode:status};run(m,{get(){},set(){}},{warn(){},error(){},send(){}},{get(){}});return m};
  test(label+': an unpaid surcharge never cancels its active or already-cancelled subscription visit with NONE',()=>{
    for(const cancelled of [false,true]){const c=ctx(),m=execute(c,{...row(),isCancelled:cancelled,cancelled});
      assert.equal(c.blockReason,'timeout_subscription_return_requires_owner');assert.equal(c.blockLocalMutation,true);
      assert.equal(c.currentTimeoutBookingChecked,undefined);assert.notEqual(m.method,'PUT');assert.notEqual(m.method,'DELETE');
      assert.ok(!c.trace.some(t=>t.step==='cancel_booking_request'));
    }
  });
  test(label+': foreign, unknown, paid or prepaid bookings hold before any cancellation',()=>{
    const changes=[{client:{id:'other'}},{id:'other'},{paymentType:'UNKNOWN',clientSubscriptionId:null},
      {paymentType:'ON_PLACE',clientSubscriptionId:null,isCancelled:'false'},
      {paymentType:'ON_PLACE',clientSubscriptionId:null,paid:true},
      {paymentType:'ON_PLACE',clientSubscriptionId:null,freeVisitId:'visit'},
      {paymentType:'ON_PLACE',clientSubscriptionId:null,clientOneTimeId:'prepaid'},
      ...[{paid:'true'},{isGroup:'true'},{isSubscriptionBooking:true},{amountDue:{paidKopecks:70000}},
        {paidAmountMinor:70000},{pendingPayments:[{}]},{exerciseId:'other',exercise:{id:'fixture-exercise'}}]
        .map(change=>({paymentType:'ON_PLACE',clientSubscriptionId:null,...change}))];
    for(const change of changes){const c=ctx(),m=execute(c,{...row(),...change});assert.equal(c.blockLocalMutation,true);assert.notEqual(m.method,'PUT');assert.notEqual(m.method,'DELETE')}
  });
  test(label+': exact ordinary ON_PLACE retains its previous NONE cancellation after the new read',()=>{
    const c=ctx(),m=execute(c,{...row(),paymentType:'ON_PLACE',clientSubscriptionId:null});
    assert.equal(c.step,'cancel_booking_probe');assert.equal(c.currentTimeoutBookingChecked,true);assert.equal(m.method,'GET');
    const write=execute(c,{bookingId:'fixture-booking',cancellationOptions:{cancellationOnly:{available:true}}});
    assert.equal(write.method,'PUT');assert.deepEqual(write.payload,{refundMethod:'NONE',cancelExercise:false});
  });
  test(label+': a cancellation option cannot bypass a missing or contradictory booking readback',()=>{
    for(const kind of ['subscription','exercise','money','deposit','settlementAccount']){const c=ctx();c.step='cancel_booking_probe';c.currentTimeoutBookingChecked=true;
      const m=execute(c,{bookingId:'fixture-booking',cancellationOptions:{cancellationOnly:{available:true},[kind]:{available:true}}});
      assert.equal(c.blockReason,'timeout_subscription_return_requires_owner');assert.notEqual(m.method,'PUT');
    }
    const missing=ctx();missing.step='cancel_booking_probe';assert.notEqual(execute(missing,{cancellationOptions:{cancellationOnly:{available:true}}}).method,'PUT');
  });
  test(label+': verified unpaid timeout first reads the exact booking including non-actor admin cleanup',()=>{
    const c=ctx();c.step='check_timeout_transaction';delete c.currentTransactionUnpaidVerified;
    c.paymentExerciseId='fixture-exercise';
    c.currentTimedOutPayment={transactionId:'fixture-transaction',bookingIds:['fixture-booking'],clientId:'fixture-client',amountMinor:70000};
    const m=execute(c,{id:'fixture-transaction',status:'UNPAID',client:{id:'fixture-client'},exerciseId:'fixture-exercise',toPay:70000,currency:'RUB',products:[{bookingIds:['fixture-booking']}]});
    assert.equal(m.method,'GET');assert.match(m.url,/\/clients\/fixture-client\/bookings\/fixture-booking$/);assert.equal(c.step,'preflight_actor_booking');
  });
}
test('private installed cleanup replay is explicitly optional in CI', {skip:!process.env.LK1_TIMEOUT_CLEANUP_SOURCE},()=>assert.equal(variants.length,2));

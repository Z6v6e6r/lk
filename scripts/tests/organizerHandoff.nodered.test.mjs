import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const run = (name,msg) => new Function('msg',fs.readFileSync(`scripts/nodered_organizer_handoff_nodes/${name}.js`,'utf8'))(structuredClone(msg));
const oldTime='2026-09-13T10:00:00.000Z';
const actor={id:'actor',phone:'70000000001',name:'Организатор'};
const successor={id:'player',phone:'70000000002',name:'Участник',status:'CONFIRMED'};
export const gameFixture=()=>({id:'game',updatedAt:oldTime,revision:2,organizer:actor,participants:[actor,successor],metadata:{organizerId:'actor',splitPayment:{organizerBookingId:'actor-booking',payments:[{clientId:'actor',bookingId:'actor-booking',status:'PAID'}]}},resultRosterSnapshot:{organizer:actor,organizerInMatch:true}});
const transferMsg=(game=gameFixture())=>({_organizerTransfer:{gameId:'game',actorId:'actor',successorId:'player',expectedUpdatedAt:oldTime},payload:[game]});
export const transferQuery=(game=gameFixture())=>run('fn_transfer_build',transferMsg(game))[0]?.payload;
const leaveMsg=(game=gameFixture())=>({_splitLeaveCtx:{gameId:'game',operationKey:'game:leave:player',targetClientId:'player',game:structuredClone(game)},payload:[game]});
export const leaveQuery=(game=gameFixture())=>run('fn_leave_gate_build',leaveMsg(game))[0]?.payload;
test('transfer has no write before verified auth',()=>{
  assert.equal(run('fn_transfer_prepare',{payload:{successorId:'player',expectedUpdatedAt:oldTime}})[1].statusCode,401);
});
test('transfer uses canonical successor and keeps old organizer membership and bookings',()=>{
  const game=gameFixture(); game.participants[1]={...successor,id:'membership-row',clientId:'player'};
  const [query,update,options]=transferQuery(game);
  assert.equal(update.$set.organizer.id,'player');assert.equal(update.$set['metadata.organizerId'],'player');
  assert.ok(update.$set.participants.some(row=>row.id==='actor'));
  assert.equal(update.$set['metadata.splitPayment'],undefined);
  assert.equal(update.$set.booking,undefined);assert.equal(options.upsert,false);
  assert.deepEqual(query.membershipMutation,{$exists:false});
  assert.equal(update.$set['resultRosterSnapshot.organizer'].id,'player');
});
for(const [name,change] of [
  ['non-organizer',msg=>msg._organizerTransfer.actorId='attacker'],
  ['self target',msg=>msg._organizerTransfer.successorId='actor'],
  ['absent target',msg=>msg._organizerTransfer.successorId='absent'],
  ['stale version',msg=>msg._organizerTransfer.expectedUpdatedAt='old'],
  ['active leave',msg=>msg.payload[0].membershipMutation={operationKey:'other'}],
  ['cancelled target',msg=>msg.payload[0].participants[1].status='CANCELLED'],
  ['pending payment target',msg=>msg.payload[0].participants[1].status='PAYMENT_PENDING'],
  ['phone identity conflict',msg=>msg.payload[0].participants.push({id:'other',phone:successor.phone})],
]) test(`transfer rejects ${name}`,()=>{const msg=transferMsg();change(msg);const result=run('fn_transfer_build',msg);assert.equal(result[0],null);assert.equal(result[1].statusCode,409);});
test('transfer acknowledgement requires one matched durable write',()=>{
  for(const payload of [{acknowledged:true,matchedCount:0},{acknowledged:false,matchedCount:1},{}]) assert.equal(run('fn_transfer_ack',{payload}).statusCode,409);
  assert.equal(run('fn_transfer_ack',{payload:{acknowledged:true,matchedCount:1}}).payload.state,'ORGANIZER_TRANSFERRED');
});
test('leave refuses promoted organizer before any provider output',()=>{
  const msg=leaveMsg();msg.payload[0].organizer=successor;
  assert.equal(run('fn_leave_gate_build',msg)[1].statusCode,409);
});
test('leave refuses fresh generation instead of swapping authorized snapshot',()=>{
  const msg=leaveMsg();msg.payload[0].updatedAt='2026-09-13T11:00:00Z';msg.payload[0].participants[1].bookingId='new-booking';
  assert.equal(run('fn_leave_gate_build',msg)[1].statusCode,409);
});
test('leave cannot steal another operation fence, even an old one',()=>{
  const msg=leaveMsg();msg.payload[0].membershipMutation={operationKey:'another',startedAt:'2000-01-01'};
  assert.equal(run('fn_leave_gate_build',msg)[1].statusCode,409);
});
test('terminal release only removes its own operation and acknowledges absence',()=>{
  const result=run('fn_leave_release_build',{_splitLeaveCtx:{gameId:'game',operationKey:'mine'},payload:{matchedCount:1}})[0];
  assert.equal(result.payload[0]['membershipMutation.operationKey'],'mine');
  const ack=run('fn_leave_release_ack',{...result,payload:{acknowledged:true,matchedCount:0}});
  assert.equal(ack[0].payload.matchedCount,1);
});
test('generic patch rejects authority alias takeover and retains existing aliases',()=>{
  const game=gameFixture();
  assert.equal(run('fn_patch_authority_check',{payload:[game],_organizerGuardBody:{organizer:successor}})[1].statusCode,409);
  assert.equal(run('fn_patch_authority_check',{payload:[game],_organizerGuardBody:{metadata:{organizerId:'player'}}})[1].statusCode,409);
  assert.equal(run('fn_patch_authority_check',{payload:[game],_organizerGuardBody:{metadata:{title:'new'}}})[0].payload.metadata.organizerId,'actor');
});
test('cleanup acquire rejects populated games and binds frozen cancellation options',()=>{
  const msg={payload:[gameFixture()],_organizerCleanupTask:{gameId:'game',expectedUpdatedAt:oldTime,preferredRefundMethod:'DEPOSIT'},_splitCleanupAuth:{actorClientId:'actor'}};
  assert.equal(run('fn_cleanup_gate_build',msg)[1].statusCode,409);
  msg.payload[0].participants=[actor];
  const result=run('fn_cleanup_gate_build',msg)[0];
  assert.equal(result.payload[1].$set.membershipMutation.kind,'CANCEL');
  msg.payload[0].membershipMutation=result.payload[1].$set.membershipMutation;
  msg._organizerCleanupTask.preferredRefundMethod='CURRENCY';
  assert.equal(run('fn_cleanup_gate_build',msg)[1].statusCode,409);
});
test('cleanup acknowledgement cannot report successful cancellation after failed Mongo CAS',()=>{
  const result=run('fn_cleanup_write_ack',{payload:{acknowledged:true,matchedCount:0},_organizerCleanupSummary:{payload:{cancelledInLk:true}}});
  assert.equal(result.payload.cancelledInLk,false);assert.equal(result.payload.withVivaErrors,true);
});

test('cleanup rejects task assembled against old booking generation',()=>{
  const game=gameFixture();game.participants=[actor];game.updatedAt='2026-09-13T11:00:00Z';
  const result=run('fn_cleanup_gate_build',{payload:[game],_organizerCleanupTask:{gameId:'game',expectedUpdatedAt:oldTime,exerciseId:'old-exercise'},_splitCleanupAuth:{actorClientId:'actor'}});
  assert.equal(result[0],null);assert.equal(result[1].statusCode,409);
});

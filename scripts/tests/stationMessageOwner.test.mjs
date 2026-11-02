import test from 'node:test';
import assert from 'node:assert/strict';
import {beginStationMessage,runStationMessage,recoverStationMessageOutbox,beginStationMessageStatus,MESSAGE_OUTBOX_LIMIT} from '../lib/stationMessageOwner.mjs';
import {smTransition} from '../lib/stationMembershipLifetime.mjs';
import {messageDb,uid} from './helpers/stationMessageHarness.mjs';
const input=(n=1)=>({communityId:'station-community',actor:{id:'player-a'},requestId:uid(n),text:'Synthetic message'});
const send=(db,args=input(),hooks)=>runStationMessage(db,beginStationMessage(args),hooks);
const leave=(db,state='LEFT')=>{const c=db.tables.get('lk_communities')[0];c.members=[];c.stationMembershipLifetime=smTransition(c,'player-a',state);};
test('one immutable keyed message/event; changed text conflicts and keyless requests have separate custody',async()=>{
 const db=messageDb(),a=await send(db);assert.equal(a.response.status,200);assert.match(a.response.body.message.id,/^[a-f0-9-]{36}$/);
 assert.equal((await send(db)).response.body.message.id,a.response.body.message.id);
 assert.equal((await send(db,{...input(),text:'changed'})).response.status,409);
 assert.equal(db.tables.get('lk_community_chat_messages').length,1);assert.equal(db.tables.get('lk_community_events').length,1);
 const old={...input(),requestId:undefined};assert.notEqual((await send(db,old)).response.body.requestId,(await send(db,old)).response.body.requestId);
});
test('candidate stays unreadable; failure before acceptance then LEFT cannot be retried into new epoch',async()=>{
 const db=messageDb();const failed=await send(db,input(),{before(op){if(op.ctx.step==='accept_write')return {skip:true,error:true};}});
 assert.equal(failed.response.status,503);const row=db.tables.get('lk_community_chat_messages')[0];assert.equal(row.archived,true);assert.equal(row.text,undefined);assert.equal(row.id,undefined);
 leave(db);assert.equal((await send(db)).response.status,403);assert.equal(db.tables.get('lk_community_events')?.length||0,0);
});
test('acceptance before LEFT survives projection failure and archive/type change',async()=>{
 const db=messageDb();let accepted=false;
 const failed=await send(db,input(),{after(op){if(op.ctx.step==='accept_write'){accepted=true;leave(db);}},before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 assert.equal(accepted,true);assert.equal(failed.response.status,503);
 const c=db.tables.get('lk_communities')[0];c.archived=true;c.communityType='FRIENDS';
 assert.deepEqual(await recoverStationMessageOutbox(db,{dryRun:false}),{pending:1,recovered:1});
 assert.equal(db.tables.get('lk_community_chat_messages')[0].state,'COMMITTED');assert.equal(db.tables.get('lk_community_events').length,1);assert.equal(c.communityMessageOutbox.length,0);
});
test('lost ACKs read back message/event; pending cap never changes roster or blocks LEFT',async()=>{
 const db=messageDb();assert.equal((await send(db,input(),{after(){return {error:true};}})).response.status,503);
 const clean=messageDb();assert.equal((await send(clean,input(),{after(op){if(op.method==='updateOne')return {error:true};}})).response.status,200);
 const full=messageDb(),c=full.tables.get('lk_communities')[0];c.communityMessageOutbox=Array.from({length:MESSAGE_OUTBOX_LIMIT},(_,i)=>({id:'pending-'+i}));
 assert.equal((await send(full)).response.body.error,'MESSAGE_OUTBOX_FULL');leave(full,'BANNED');assert.equal(c.stationMembershipLifetime.players[0].state,'BANNED');
});

const canonical=(db,args=input(),hooks)=>send(db,{...args,requiredContract:true},hooks);
const status=async(db,args=input(),after)=>{
 const calls=[];
 const result=await runStationMessage(db,beginStationMessageStatus(args),{before(op){calls.push(op.method);assert.equal(op.method,'find');},after});
 assert.ok(calls.length>=1&&calls.length<=3);return result;
};
test('canonical receipt is versioned/public only and original-request status never writes',async()=>{
 const db=messageDb(),sent=await canonical(db);assert.equal(sent.response.body.outcome,'CONFIRMED');assert.equal(sent.response.body.contractVersion,1);assert.equal(sent.response.body.contract,'station-message');
 assert.deepEqual(Object.keys(sent.response.body.message).sort(),['author','body','id','isViewer','sentAt']);
 assert.equal(JSON.stringify(sent.response.body).includes('player-a'),false);assert.equal(JSON.stringify(sent.response.body).includes('station-community'),false);
 const snapshot=JSON.stringify([...db.tables]);assert.deepEqual((await status(db)).response,sent.response);assert.equal(JSON.stringify([...db.tables]),snapshot);
 assert.equal((await canonical(db)).response.body.message.id,sent.response.body.message.id);
 assert.equal((await canonical(db,{...input(),text:'Changed'})).response.body.outcome,'UNKNOWN');
 assert.throws(()=>beginStationMessage({...input(),requestId:undefined,requiredContract:true}),/REQUEST_ID_REQUIRED/);
});
test('missing/reserved/event-missing/corrupt receipts stay UNKNOWN without creating or repairing anything',async()=>{
 const absent=messageDb();assert.equal((await status(absent)).response.body.outcome,'UNKNOWN');assert.equal(absent.tables.get('lk_community_chat_messages').length,0);
 for(const mutate of [db=>{db.tables.get('lk_community_events').length=0;},db=>{db.tables.get('lk_community_chat_messages')[0].text='tampered';},db=>{db.tables.get('lk_community_events')[0].payload.textPreview='tampered';}]){
  const db=messageDb();await canonical(db);mutate(db);const snapshot=JSON.stringify([...db.tables]);const read=await status(db);assert.equal(read.response.body.outcome,'UNKNOWN');assert.equal(read.response.body.message,undefined);assert.equal(read.response.body.messageId,undefined);assert.equal(JSON.stringify([...db.tables]),snapshot);
 }
 const pending=messageDb();await canonical(pending,input(),{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 const before=JSON.stringify([...pending.tables]);assert.equal((await status(pending)).response.body.outcome,'UNKNOWN');assert.equal(JSON.stringify([...pending.tables]),before);assert.equal(pending.tables.get('lk_communities')[0].communityMessageOutbox.length,1);
});
test('final ACL read denies LEFT/BAN or another actor; neither status nor canonical POST leaks body',async()=>{
 for(const state of ['LEFT','BANNED']){
  const db=messageDb();await canonical(db);
  const read=await status(db,input(),op=>{if(op.ctx.step==='status_event')leave(db,state);});assert.equal(read.response.status,403);assert.equal(read.response.body.outcome,'UNKNOWN');assert.equal(read.response.body.message,undefined);
  const posting=messageDb();const denied=await canonical(posting,input(),{after(op){if(op.ctx.step==='event_readback')leave(posting,state);}});assert.equal(denied.response.status,403);assert.equal(denied.response.body.message,undefined);
 }
 const db=messageDb();await canonical(db);db.tables.get('lk_communities')[0].members.push({id:'other',status:'ACTIVE'});
 const other=await status(db,{...input(),actor:{id:'other'}});assert.equal(other.response.body.outcome,'UNKNOWN');assert.equal(other.response.body.message,undefined);
 const failed=await runStationMessage(db,beginStationMessageStatus(input()),{before(){return {skip:true,error:true};}});assert.equal(failed.response.status,503);assert.equal(failed.response.body.outcome,'UNKNOWN');
});
test('canonical-required send cannot fall back to legacy on type change and status binds original Mongo identity',async()=>{
 const db=messageDb();db.tables.get('lk_communities')[0].communityType='FRIENDS';const denied=await canonical(db);assert.equal(denied.response.status,403);assert.equal(db.tables.get('lk_community_chat_messages').length,0);
 const committed=messageDb();await canonical(committed);committed.tables.get('lk_communities')[0]._id='recreated';assert.equal((await status(committed)).response.body.outcome,'UNKNOWN');
});
test('ambiguous canonical POST response restores CONFIRMED by read-only status without repeating send',async()=>{
 const db=messageDb(),lost=await canonical(db,input(),{after(op){if(op.ctx.step==='canonical_reply_access')return {error:true};}});assert.equal(lost.response.status,503);assert.equal(lost.response.body.outcome,'UNKNOWN');
 const before=JSON.stringify([...db.tables]);const restored=await status(db);assert.equal(restored.response.body.outcome,'CONFIRMED');assert.equal(restored.response.body.message.body,input().text);assert.equal(JSON.stringify([...db.tables]),before);
});

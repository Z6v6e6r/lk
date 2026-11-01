import test from 'node:test';
import assert from 'node:assert/strict';
import {beginStationMessage,runStationMessage,recoverStationMessageOutbox,MESSAGE_OUTBOX_LIMIT} from '../lib/stationMessageOwner.mjs';
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

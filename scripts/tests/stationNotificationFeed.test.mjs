import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { nfRequest, nfReadiness, stationNotificationReadiness, nfIndexProposal, beginStationNotificationFeed, runStationNotificationFeed, advanceStationNotificationFeed } from '../lib/stationNotificationFeed.mjs';
import { smTransition, smRosterTransition } from '../lib/stationMembershipLifetime.mjs';
import { beginStationMessage, runStationMessage, recoverStationMessageOutbox } from '../lib/stationMessageOwner.mjs';
import { notificationFixture, publications, recipients, eligibility, feedMemory, uid } from './helpers/stationNotificationHarness.mjs';
const run = (f,mode,body,hooks={}) => runStationNotificationFeed(feedMemory(f.db),beginStationNotificationFeed(mode,body,{expiresAtMs:Date.now()+30000}),hooks);
test('published feed is fixed-frontier, contiguous across >2 pages, body-free and read-only',async()=>{
 const f=await notificationFixture({messages:7}),before=JSON.stringify([...f.db.tables]);let after=0;const ids=[];
 do{const result=await run(f,'publications',{...publications(f.c),limit:2,afterSequence:after,throughSequence:7});assert.equal(result.response.status,200);const page=result.response.body;ids.push(...page.items.map(m=>m.sequence));assert.equal(JSON.stringify(page).includes('Synthetic'),false);after=page.nextAfterSequence;}while(after!==null);
 assert.deepEqual(ids,[1,2,3,4,5,6,7]);assert.equal(JSON.stringify([...f.db.tables]),before);
});
test('pending publication holes, missing event and corrupt exact proof never export facts',async()=>{
 const f=await notificationFixture({messages:0});
 await runStationMessage(f.db,beginStationMessage({communityId:f.c.id,actor:{id:'player-a'},requestId:uid(1),text:'Hidden'}),{before(o){if(o.ctx.step==='message_write')return {skip:true,error:true};}});
 await runStationMessage(f.db,beginStationMessage({communityId:f.c.id,actor:{id:'player-a'},requestId:uid(2),text:'Later'}));
 assert.deepEqual((await run(f,'publications',publications(f.c))).response.body.items,[]);
 await recoverStationMessageOutbox(f.db,{dryRun:false});const body=publications(f.c);assert.equal((await run(f,'publications',body)).response.body.items.length,2);
 const events=f.db.tables.get('lk_community_events'),saved=events.pop();assert.equal((await run(f,'publications',body)).response.status,503);events.push(saved);
 f.db.tables.get('lk_community_chat_messages')[0].text='Corrupt';assert.equal((await run(f,'publications',body)).response.status,503);
});
test('fixed 50-scanned recipient keysets cover >100 with author exclusion and zero-eligible continuation',async()=>{
 const f=await notificationFixture({members:125,messages:1});
 for(const p of f.c.stationMembershipLifetime.players.filter(p=>p.playerId<'recipient-060'))p.readPosition.readThroughSequence=1;
 let after=null,seen=[];let first=true;
 do{const p=(await run(f,'recipients',recipients(f.c,f.records[0],after,50))).response.body;if(first){assert.deepEqual(p.items,[]);assert.equal(p.complete,false);first=false;}seen.push(...p.items.map(x=>x.playerId));after=p.nextAfterPlayerId;}while(after!==null);
 assert.equal(seen.length,65);assert.equal(new Set(seen).size,65);assert.equal(seen.includes('player-a'),false);
});
test('recipient pages shrink at final ACL; unrelated progress remains eligible and rejoin cannot rebind old epoch',async()=>{
 const f=await notificationFixture({messages:3}),body=eligibility(f.c,f.records[2]);
 f.c.stationMembershipLifetime.players.find(p=>p.playerId==='recipient-001').readPosition.readThroughSequence=1;
 let response=(await run(f,'eligibility',body)).response;assert.equal(response.body.outcome,'ALLOW');assert.equal(response.body.currentReadThroughSequence,1);
 response=(await run(f,'eligibility',body,{before(o){if(o.ctx.step==='final'){f.c.stationMembershipLifetime=smRosterTransition(f.c,[],'REMOVE','recipient-001','recipient-001');f.c.members=f.c.members.filter(m=>m.id!=='recipient-001');}}})).response;assert.equal(response.body.outcome,'DENY');
 f.c.stationMembershipLifetime=smTransition(f.c,'recipient-001','ACTIVE');f.c.members.push({id:'recipient-001'});
 assert.equal(f.c.stationMembershipLifetime.players.find(p=>p.playerId==='recipient-001').readPosition.baselineSequence,3);
 assert.equal((await run(f,'eligibility',body)).response.body.outcome,'DENY');
 assert.equal((await run(f,'recipients',recipients(f.c,f.records[2]))).response.body.items.some(x=>x.playerId==='recipient-001'),false);
});
test('BAN, admin REMOVE, read covering the message and author are denied without disclosing bodies',async()=>{
 for(const kind of ['BAN','REMOVE','READ','AUTHOR']){const f=await notificationFixture({messages:1});const body=eligibility(f.c,f.records[0],kind==='AUTHOR'?'player-a':'recipient-001');if(kind==='BAN'||kind==='REMOVE'){f.c.stationMembershipLifetime=smRosterTransition(f.c,[],kind,'recipient-001','admin');f.c.members=f.c.members.filter(m=>m.id!=='recipient-001');}if(kind==='READ')f.c.stationMembershipLifetime.players.find(p=>p.playerId==='recipient-001').readPosition.readThroughSequence=1;const r=await run(f,'eligibility',body);assert.equal(r.response.body.outcome,'DENY');assert.equal(JSON.stringify(r.response).includes('Synthetic private body'),false);}
});
test('an acceptance delayed until after ACTIVE baseline can become newly visible, never an earlier published fact',async()=>{
 const f=await notificationFixture({messages:1});
 await runStationMessage(f.db,beginStationMessage({communityId:f.c.id,actor:{id:'player-a'},requestId:uid(2),text:'Delayed'}),{before(o){if(o.ctx.step==='message_write')return {skip:true,error:true};}});
 f.c.stationMembershipLifetime=smTransition(f.c,'recipient-001','ACTIVE');
 assert.equal(f.c.stationMembershipLifetime.players.find(p=>p.playerId==='recipient-001').readPosition.baselineSequence,1);
 await recoverStationMessageOutbox(f.db,{dryRun:false});
 assert.equal((await run(f,'recipients',recipients(f.c,f.records[0]))).response.body.items.some(x=>x.playerId==='recipient-001'),false);
 const d=f.db.tables.get('lk_community_chat_messages').find(d=>d.sequence===2);assert.equal((await run(f,'recipients',recipients(f.c,d))).response.body.items.some(x=>x.playerId==='recipient-001'),true);
});
test('identity, adoption, malformed storage, explicit cursor and proof tampering fail closed',async()=>{
 const f=await notificationFixture(),body=publications(f.c);
 for(const change of [x=>x._id='recreated',x=>x.communityType='FRIENDS',x=>x.archived=true,x=>delete x.stationMembershipLifetime.players[0].readPosition,x=>x.bannedMembers=[{}]]){const row=structuredClone(f.c);change(row);f.db.tables.set('lk_communities',[row]);assert.equal((await run(f,'publications',body)).response.status,503);}f.db.tables.set('lk_communities',[f.c]);
 for(const bad of [{...body,afterSequence:undefined},{...body,afterSequence:-1},{...body,limit:51},{...body,phone:'redacted'},{...body,throughSequence:1,afterSequence:2}])assert.equal(nfRequest('publications',bad),false);
 assert.equal((await run(f,'publications',{...body,throughSequence:999})).response.status,503);
 const tampered=recipients(f.c,f.records[0]);tampered.fact.proofHash='sha256:'+'0'.repeat(64);assert.equal((await run(f,'recipients',tampered)).response.status,503);
 const row=structuredClone(f.c);delete row.communityMessageOutbox;delete row.stationMembershipLifetime;assert.throws(()=>nfReadiness(row));
});
test('duplicate sequence, oversized candidate and record deletion are holes, never successful truncation',async()=>{
 for(const kind of ['DUPLICATE','OVERSIZE','DELETE','READ_COMMAND']){const f=await notificationFixture();const rows=f.db.tables.get('lk_community_chat_messages');if(kind==='DUPLICATE')rows.push({...rows[0],_id:'duplicate'});if(kind==='OVERSIZE')rows[0].unused='x'.repeat(70000);if(kind==='DELETE')rows.splice(0,1);if(kind==='READ_COMMAND')rows[0].recordType='READ_COMMAND';assert.equal((await run(f,'publications',publications(f.c))).response.status,503);}
});
test('bounded deadline/store failure/mutating descriptors never become success or writes',async()=>{
 const f=await notificationFixture(),body=publications(f.c),op=beginStationNotificationFeed('publications',body,{nowMs:1000,expiresAtMs:2000});
 assert.equal(advanceStationNotificationFeed(op.ctx,[f.c],false,2000).response.status,503);
 assert.equal((await runStationNotificationFeed({collection(){throw Error('must not execute');}},{...op,method:'updateOne'})).response.status,503);
 assert.equal((await runStationNotificationFeed({collection(){return {aggregate(){throw Error('missing hint');}};}},beginStationNotificationFeed('publications',body,{expiresAtMs:Date.now()+30000}))).response.status,503);
});
test('immutable owner proof extraction remains byte-identical to reviewed baseline functions',()=>{
 const source=readFileSync(new URL('../lib/stationMessageProof.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
 const extracted=source.slice(source.indexOf('const uuid ='));
 assert.equal(crypto.createHash('sha256').update(extracted).digest('hex'),'90bc2e6ae267d84296d6951439a70f10e0d6e80cd3ba73315c3ae8286ce734d4');
});

test('explicit cold-start readiness verifies exact read-only index evidence without choosing a replay floor',async()=>{
 const f=await notificationFixture(),index={...nfIndexProposal};
 const ready=stationNotificationReadiness(f.c,[index]);assert.equal(ready.observedPublishedSequence,3);assert.equal(ready.initialReplayFloor,'EXPLICIT_ACTIVATION_INPUT_REQUIRED');assert.equal('lifetime' in ready,false);
 for(const indexes of [[],[index,index],[{...index,unique:true}],[{...index,expireAfterSeconds:60}],[{...index,key:{communityId:1}}],[{...index,key:{sequence:1,streamId:1,communityId:1}}],[{...index,collation:{locale:'en'}}],[{...index,partialFilterExpression:{state:'COMMITTED'}}]])assert.throws(()=>stationNotificationReadiness(f.c,indexes));
});

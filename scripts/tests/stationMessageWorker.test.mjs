import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {beginStationMessage,runStationMessage,recoverStationMessageOutbox} from '../lib/stationMessageOwner.mjs';
import {messageDb,uid} from './helpers/stationMessageHarness.mjs';
const source=fs.readFileSync('scripts/rating_worker.mjs','utf8');
const call=source.match(/ {4}const stationMessages = await recoverStationMessageOutbox\(db, [^\n]+/)[0];
const tick=new Function('db','dryRun','recoverStationMessageOutbox','return (async()=>{'+call+'\nreturn stationMessages;})()');
test('actual worker call reuses DB/dry-run and bounded recovery, propagates fixed failure instead of successful tick',async()=>{
 const db=messageDb();await runStationMessage(db,beginStationMessage({communityId:'station-community',actor:{id:'player-a'},requestId:uid(1),text:'Synthetic'}),{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 const c=db.tables.get('lk_communities')[0];c.archived=true;c.communityType='FRIENDS';
 assert.deepEqual(await tick(db,true,recoverStationMessageOutbox),{pending:1,recovered:0});assert.equal(db.tables.get('lk_community_chat_messages')[0].state,'RESERVED');
 assert.deepEqual(await tick(db,false,recoverStationMessageOutbox),{pending:1,recovered:1});
 await assert.rejects(()=>tick({collection(){throw Error('private connection details');}},false,recoverStationMessageOutbox),/^Error: STATION_MESSAGE_RECOVERY_STORE_UNAVAILABLE$/);
 assert.ok(source.indexOf(call)>source.indexOf('const communityPolicies = await processCommunityPolicies'));
});
test('bounded recovery drains its processed intents instead of requiring globally empty backlog',async()=>{
 const db=messageDb();for(let i=0;i<2;i++)await runStationMessage(db,beginStationMessage({communityId:'station-community',actor:{id:'player-a'},requestId:uid(i+2),text:'Synthetic'}),{before(op){if(op.ctx.step==='message_write')return {skip:true,error:true};}});
 assert.deepEqual(await recoverStationMessageOutbox(db,{dryRun:false,maxMessages:1}),{pending:1,recovered:1,bounded:true});
 assert.deepEqual(await recoverStationMessageOutbox(db,{dryRun:false}),{pending:1,recovered:1});
});

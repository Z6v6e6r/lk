import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MongoClient } from 'mongodb';
import { buildOrganizerHandoffCandidate } from '../build_organizer_handoff_candidate.mjs';
const run=(name,msg)=>new Function('msg',fs.readFileSync(`scripts/nodered_organizer_handoff_nodes/${name}.js`,'utf8'))(structuredClone(msg));
const stamp='2026-09-13T10:00:00.000Z';
const actor={id:'actor',phone:'70000000001',name:'Organizer'};
const player={id:'player',phone:'70000000002',name:'Player',status:'CONFIRMED'};
const seed=()=>({id:'game',updatedAt:stamp,organizer:actor,participants:[actor,player],metadata:{organizerId:'actor'}});
const transfer=g=>run('fn_transfer_build',{payload:[g],_organizerTransfer:{gameId:'game',actorId:'actor',successorId:'player',expectedUpdatedAt:stamp}})[0].payload;
const leave=g=>run('fn_leave_gate_build',{payload:[g],_splitLeaveCtx:{game:g,gameId:'game',operationKey:'game:leave',targetClientId:'player'}})[0].payload;
test('real Mongo serializes transfer, leave and stale PATCH without provider calls',{skip:!process.env.HANDOFF_SOURCE},async()=>{
  const client=new MongoClient('mongodb://127.0.0.1:27193',{serverSelectionTimeoutMS:5000});await client.connect();
  const db=client.db('organizer_handoff_verify');const games=db.collection('lk_games');
  try {
    await games.deleteMany({});await games.insertOne(seed());
    let game=await games.findOne({id:'game'});
    const t=transfer(game),l=leave(game);
    // Both operations observed the same preimage; exactly one may commit.
    const outcomes=await Promise.all([games.updateOne(...t),games.updateOne(...l)]);
    assert.equal(outcomes.reduce((sum,row)=>sum+row.matchedCount,0),1);
    game=await games.findOne({id:'game'});
    if(game.organizer.id==='player') assert.equal(game.membershipMutation,undefined);
    else assert.equal(game.membershipMutation.operationKey,'game:leave');
    await games.deleteMany({});await games.insertOne(seed());game=await games.findOne({id:'game'});
    const staleTransfer=transfer(game);await games.updateOne(...leave(game));
    assert.equal((await games.updateOne(...staleTransfer)).matchedCount,0);
    // Semantic fence cannot be stolen even after executor lease timeout.
    await games.updateOne({id:'game'},{$set:{'membershipMutation.startedAt':'2000-01-01'}});
    assert.equal((await games.updateOne(...staleTransfer)).matchedCount,0);
    const release=run('fn_leave_release_build',{_splitLeaveCtx:{gameId:'game',operationKey:'different'},payload:{matchedCount:1}})[0].payload;
    assert.equal((await games.updateOne(...release)).matchedCount,0);
    assert.ok((await games.findOne({id:'game'})).membershipMutation);
    await games.deleteMany({});await games.insertOne(seed());game=await games.findOne({id:'game'});
    await games.updateOne(...transfer(game));
    assert.equal((await games.updateOne(...leave(game))).matchedCount,0);
    const fresh=await games.findOne({id:'game'});
    assert.equal(fresh.organizer.id,'player');assert.ok(fresh.participants.some(row=>row.id==='actor'));
    // Run the deployed PATCH body through the actual candidate, then execute its Mongo query.
    const source=JSON.parse(fs.readFileSync(process.env.HANDOFF_SOURCE));
    const candidate=buildOrganizerHandoffCandidate(source).flow;
    const fn=candidate.find(n=>n.id==='e0d7883bc1a9fa8c');
    const patchMsg={req:{params:{gameId:'game'}},payload:{metadata:{organizerId:'actor'}},_organizerGuardSnapshot:{updatedAt:stamp,organizer:actor}};
    const patch=new Function('msg','global','env',fn.func)(patchMsg,{get:()=>undefined},{get:()=>undefined})[0];
    assert.equal((await games.updateOne(patch.query,patch.payload)).matchedCount,0);
    assert.equal((await games.findOne({id:'game'})).organizer.id,'player');
  } finally { await db.dropDatabase();await client.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LEGACY_CAS_PROFILE, renderLegacyLeaveFunction as render } from '../lib/repeated_booking_leave_profile.mjs';
import { TARGETS, IDS, hash, buildRepeatedBookingLeaveCandidate as build } from '../prepare_repeated_booking_leave_candidate.mjs';
const read = file => fs.readFileSync(`scripts/nodered_games_nodes/${file}`, 'utf8');
const run = (file, msg) => new Function('msg','global','flow',render(file,read(file)))(msg,{get:()=>null},{get:()=>null});
const snapshot = () => ({ id:'fixture-game', updatedAt:'2026-09-13T10:00:00.000Z', organizer:{id:'organizer'}, participants:[{id:'player'}],metadata:{} });
const updateFor = game => run('fn_split_leave_game_update.js',{_splitLeaveCtx:{game,gameId:game.id,targetClientId:'player',operationId:'fixture-leave',operationKey:'fixture-game:fixture-leave'}})[0].payload;

test('legacy profile emits guarded snapshot CAS and does not alter shared lock source',()=>{
 const game=snapshot(); const [query]=updateFor(game);
 assert.deepEqual(query,{id:game.id,archived:{$ne:true},membershipMutation:{$exists:false},updatedAt:game.updatedAt,organizer:game.organizer});
 delete game.updatedAt; delete game.organizer;
 assert.deepEqual(updateFor(game)[0].updatedAt,{$exists:false});
 assert.deepEqual(updateFor(game)[0].organizer,{$exists:false});
 assert.match(read('fn_split_leave_game_update.js'),/"membershipMutation.operationKey": ctx.operationKey/);
 assert.throws(()=>render('fn_split_leave_game_update.js','unreviewed source'),/anchor drift/);
});
test('completed operations and missing return token use wired HTTP response output',()=>{
 for(const state of ['DONE','RETURN_PENDING']){
  const msg={_splitLeaveCtx:{mode:'SELF',gameId:'fixture-game',operationId:'fixture-leave'},payload:[{_id:'fixture-game:fixture-leave',state,bookingIds:['saved-booking']}]};
  const out=run('fn_split_leave_operation_route.js',msg);
  assert.equal(out[2].payload.state,state);assert.equal(out.length,3);assert.equal(out[4],undefined);
 }
});
test('legacy provider path refuses an observed membership lock including null',()=>{
 for(const lock of [null,{operationKey:'other'}]){
  const out=run('fn_split_leave_router.js',{_splitLeaveCtx:{game:{membershipMutation:lock},step:'start_cancel'}});
  assert.equal(out[0],null);assert.equal(out[2].statusCode,409);
 }
});
test('legacy graph cannot run on membership-lock architecture or wrong route output',()=>{
 const pins=TARGETS.map(t=>({...t,beforeSha256:hash('return msg;')}));
 const fixture=()=>[
  ...pins.map(t=>({id:t.id,z:'games',type:'function',func:'return msg;',outputs:t.id===IDS.router?5:t.id===IDS.route?4:1,wires:Array.from({length:t.id===IDS.router?5:t.id===IDS.route?4:1},()=>[])})),
  {id:IDS.update,z:'games',type:'mongodb4',operation:'updateOne',collection:'lk_game_leave_operations',clientNode:'db',wires:[[]]},
  {id:IDS.find,z:'games',type:'mongodb4',operation:'find',collection:'lk_game_leave_operations',clientNode:'db',wires:[[IDS.route]]},
  {id:IDS.response,type:'http response',wires:[]},{id:'db',type:'mongodb4-client'}];
 const candidate=build(fixture(),pins,LEGACY_CAS_PROFILE);
 assert.equal(candidate.find(n=>n.id===IDS.route).outputs,4);
 for(const mutate of [f=>{f.push({id:'handoff',type:'function',func:'game.membershipMutation',outputs:1,wires:[[]]});},f=>{f.find(n=>n.id===IDS.route).outputs=5;}]){
  const f=fixture();mutate(f);assert.throws(()=>build(f,pins,LEGACY_CAS_PROFILE));
 }
});

const container=process.env.LEAVE_CAS_MONGO_CONTAINER;
test('real isolated Mongo rejects concurrent snapshot/organizer/lock changes and replay',{skip:!container},()=>{
 assert.match(container,/^codex-leave-cas-/);
 const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
 assert.equal(info.HostConfig.NetworkMode,'none');assert.ok(info.Mounts.every(m=>m.Type==='tmpfs'));
 assert.equal(info.Config.Labels['codex.fixture'],'leave-cas');
 const game=snapshot();const [query,update]=updateFor(game);
 const missing={...game};delete missing.updatedAt;delete missing.organizer;
 const [missingQuery,missingUpdate]=updateFor(missing);
 const script=`const c=db.getSiblingDB('leave_cas_fixture').games; c.drop();
 const game=${JSON.stringify(game)}, query=${JSON.stringify(query)}, update=${JSON.stringify(update)};
 const changes=[{updatedAt:'new-version'},{organizer:{id:'new-organizer'}},{membershipMutation:{operationKey:'other'}},{membershipMutation:null}];
 for(const change of changes){c.deleteMany({});c.insertOne({...game,...change});if(c.updateOne(query,update).matchedCount!==0)throw Error('stale CAS matched');}
 c.deleteMany({});c.insertOne(game);const results=Array.from({length:10},()=>c.updateOne(query,update).matchedCount);if(results.reduce((a,b)=>a+b,0)!==1)throw Error('replay matched');
 c.deleteMany({});c.insertOne(${JSON.stringify(missing)});if(c.updateOne(${JSON.stringify(missingQuery)},${JSON.stringify(missingUpdate)}).matchedCount!==1)throw Error('missing snapshot rejected');
 c.deleteMany({});c.insertOne({...${JSON.stringify(missing)},updatedAt:'appeared'});if(c.updateOne(${JSON.stringify(missingQuery)},${JSON.stringify(missingUpdate)}).matchedCount!==0)throw Error('missing timestamp race matched');
 c.drop();print('REAL_MONGO_CAS_PASS');`;
 const output=execFileSync('docker',['exec',container,'mongosh','--quiet','--eval',script],{encoding:'utf8',timeout:30000});assert.match(output,/REAL_MONGO_CAS_PASS/);
});

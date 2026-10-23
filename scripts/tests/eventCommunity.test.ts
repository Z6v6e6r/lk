import { EVENT_JUMP_ENGINE_VERSION, eventGameCommandBody } from '../../src/services/eventJumpContract.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { eventRegistration, eventGameApplySource, EVENT_GAME_ACK } from '../lib/eventCommunity.mjs';
import { patchCommunityTypesFlow } from '../patch_live_community_types.mjs';
import { sanitizeTypedCommunityPayload } from '../lib/communityResponseRedaction.mjs';
import { communityType, parseCommunityTypeSettings } from '../../src/services/community-policy.ts';
import { createGame, stepGame, FIXED_STEP } from '../../src/components/padel-jump/engine.ts';

const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/event-community.json','utf8'));
fixture.typeSettings.registrationPolicy={version:'event-registration-v1',responsibleName:'Тестовый Ответственный',contactEmail:['synthetic','example.invalid'].join('@'),startsAt:'2026-10-23T09:00:00.000Z',endsAt:'2026-10-24T20:59:59.999Z',retentionYears:1};
const actor = { id:'player-a', name:'Игрок А', phone:['+7','9990000001'].join('') };
const form = {fullName:'Тестовый Участник', company:'Синтетическая компания', email:['test','example.invalid'].join('@'),policyRevision:1};
const requestId = 'b5361f1b-1e3d-4faf-88b1-8f93813535f1';
const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs','utf8');
const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
const body = (name: string) => common + source.split('const '+name+' = `${commonHelpers}')[1].split('\n`;')[0];
function graph() {
  const flow: any[] = [
    ...[['create','Build community create docs','fnCreate'],['update','Prepare community update','fnUpdatePrepare'],['ranking','Use rating snapshot or fallback','fnRankingSnapshotResponse']].map(([id,name,code])=>({id,type:'function',z:'tab',name,func:body(code),outputs:2,wires:[['response'],[]]})),
    {id:'list',type:'function',z:'tab',name:'Prepare communities list query',func:common+fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_prepare_tail.js','utf8'),outputs:2,wires:[['response'],[]]},
    {id:'autojoin',type:'function',z:'tab',name:'Prepare game station autojoin',func:'return [msg,null];',outputs:2,wires:[[],[]]},
    {id:'response',type:'http response',z:'tab',wires:[]},
    {id:'read-template',type:'mongodb4',z:'tab',collection:'lk_communities',operation:'find',clientNode:'synthetic',mode:'collection',output:'toArray',wires:[]},
  ];
  for (const [id,name,code,outputs,wires] of [
    ['join-prepare','Prepare community join','fnJoinPrepare',3,[['query'],['response'],[]]],
    ['query','Build member games query','fnJoinGamesQuery',3,[['join'],['response'],[]]],
    ['invite-prepare','Prepare invite join','fnInvitePrepare',3,[['invite-query'],['response'],[]]],
    ['invite-query','Build invited member games query','fnJoinGamesQuery',3,[['invite'],['response'],[]]],
    ['join','Apply community join','fnJoinApply',6,[['join-db'],[],[],[],['response'],[]]],
    ['invite','Apply invite join','fnJoinApply',6,[['invite-db'],[],[],[],['response'],[]]],
  ] as any[]) flow.push({id,type:'function',z:'tab',name,func:body(code),outputs,wires});
  for (const id of ['join','invite']) flow.push({id:id+'-db',type:'mongodb4',z:'tab',collection:'lk_communities',operation:'updateOne',clientNode:'synthetic',mode:'collection',wires:[]});
  flow.push({id:'join-http',type:'http in',z:'tab',url:'/lk/communities/:communityId/add-member',method:'post',wires:[['join-prepare']]});
  return patchCommunityTypesFlow(flow,{eventGames:true});
}
const candidate=graph();
class JoinClock extends Date {static now(){return Date.parse('2026-10-23T10:00:00.000Z');}}
const run = (id: string,msg: any) => vm.runInNewContext('(function(msg){'+candidate.flow.find((n:any)=>n.id===id).func+'\n})(msg)',{msg,Date:JoinClock});
function join(doc:any, registration:any=form, invite=false, verified:any=actor) {
  const msg:any={req:{method:'POST',params:{communityId:doc.id},headers:{},query:{}},payload:{member:{id:'spoof',name:'spoof'},inviteCode:'synthetic',eventRegistration:registration},_verifiedCommunityActor:verified};
  const prep=run(invite?'invite-prepare':'join-prepare',msg); assert.equal(prep[2],null,'no private form debug output');
  prep[0].payload=[doc];const query=run(invite?'invite-query':'query',prep[0]);
  if (!query[0]) return query;
  return run(invite?'invite':'join',query[0]);
}
function community(extra:any={}) {return {...structuredClone(fixture),members:[{...actor,role:'MEMBER',status:'ACTIVE'}],eventEntries:[{...form,playerId:actor.id,epoch:fixture.typeSettingsEffectiveAt,registeredAt:fixture.typeSettingsEffectiveAt,policyRevision:1,policyVersion:'event-registration-v1'}],...extra};}

test('EVENT policy is strict, additive and accepts exactly the two supported games',()=>{
 assert.equal(communityType('EVENT'),'EVENT');
 assert.deepEqual(parseCommunityTypeSettings('EVENT',{gameIds:['padel-jump','time-for-friends','padel-jump']}),{gameIds:['padel-jump','time-for-friends']});
 for(const settings of [{},{gameIds:[]},{gameIds:['unknown']},{gameIds:['padel-jump'],email:'bad'}]) assert.throws(()=>parseCommunityTypeSettings('EVENT',settings));
});
test('registration normalizes contacts and rejects missing, excessive, control and unknown fields',()=>{
 assert.deepEqual(eventRegistration({...form,email:' '+form.email.toUpperCase()+' '}),{fullName:form.fullName,company:form.company,email:['test','example.invalid'].join('@')});
 for(const value of [null,[],{...form,fullName:'Одно'},{...form,company:''},{...form,email:'bad'},{...form,company:'x'.repeat(161)},{...form,fullName:'Тест\u0000 Участник'},{...form,playerId:'spoof'}]) assert.throws(()=>eventRegistration(value));
});
test('join/invite cannot bypass registration; registration and roster share one acknowledged CAS',()=>{
 for(const invite of [false,true]) {
  const doc=community({members:[],eventEntries:[]});
  const missing=join(doc,null,invite); assert.equal(missing[4].statusCode,422);assert.equal(missing[0],null);
  const result=join(doc,form,invite), write=result[0];
  assert.ok(write);assert.equal(write.payload.$set.eventRosterRevision,1);assert.equal(write.query.members,undefined);assert.equal(write.query.bannedMembers,undefined);assert.doesNotMatch(JSON.stringify(write.query),/fullName|company|email|79990000001|Игрок/);assert.ok(result.slice(1).every((v:any)=>v===null));
  assert.equal(write.payload.$set.members[0].id,actor.id);
  assert.equal(write.payload.$set.members[0].name,actor.name);
  assert.equal(write.payload.$set.eventEntries[0].email,form.email);
  assert.deepEqual(JSON.parse(JSON.stringify(write.query.eventEntriesRevision)),{$exists:false});
  const ack=run((invite?'invite':'join')+'-typed-roster-ack',{...write,payload:{acknowledged:true,matchedCount:1,modifiedCount:1}});
  assert.equal(ack[3].statusCode,200);assert.doesNotMatch(JSON.stringify(ack[3].payload),/test@example|fullName|company|eventEntries/);
  const conflict=run((invite?'invite':'join')+'-typed-roster-ack',{...write,payload:{acknowledged:true,matchedCount:0}});assert.equal(conflict[3].statusCode,409);
  const unchanged=run((invite?'invite':'join')+'-typed-roster-ack',{...write,payload:{acknowledged:true,matchedCount:1,modifiedCount:0}});assert.equal(unchanged[3].statusCode,409);
 }
});
test('existing/pending/converted members register before success, bans and invite-only still deny',()=>{
 for(const doc of [community({eventEntries:[]}),community({members:[],pendingMembers:[{...actor,role:'MEMBER'}],eventEntries:[],joinRule:'MODERATED'})]) {
  assert.equal(join(doc,null)[4].statusCode,422);
  const result=join(doc,form);assert.ok(result[0].payload.$set.eventEntries);assert.equal(result[4],null);
 }
 const old=community({eventEntries:[{...form,playerId:actor.id,epoch:'old'}]});assert.equal(join(old,null)[4].statusCode,422);
 assert.equal(join(community({members:[],bannedMembers:[{id:actor.id}]}),form)[4].statusCode,403);
 assert.equal(join(community({members:[],joinRule:'INVITE_ONLY'}),form)[4].statusCode,403);
 assert.equal(join(community({members:[]}),form,false,null)[1]?.statusCode ?? 403,403);
});
test('redaction removes private event data even after type rollback, plus contacts from nested payloads',()=>{
 const out=sanitizeTypedCommunityPayload({communityType:'EVENT',eventEntries:[form],rows:[{email:form.email,phone:actor.phone,name:'Игрок'}]});
 assert.doesNotMatch(JSON.stringify(out),/example.invalid|7999|eventEntries|fullName|company/);
 assert.deepEqual(sanitizeTypedCommunityPayload({communityType:'FRIENDS',eventEntries:[form]}),{communityType:'FRIENDS'});
});
test('final graph has complete manifest/auth routes/crypto config/catch and is idempotent',()=>{
 for(const node of candidate.flow)if(node.type==='function')new vm.Script('(function(msg,context,crypto){'+node.func+'\n})');
 for(const node of candidate.flow.filter((n:any)=>n.id.startsWith('community-event-game-v1')))assert.ok(candidate.changes.some((c:any)=>c.id===node.id));
 const apply=candidate.flow.find((n:any)=>n.id==='community-event-game-v1-apply');assert.deepEqual(apply.libs,[{var:'crypto',module:'crypto'}]);
 for(const node of candidate.flow.filter((n:any)=>n.type==='http in'&&n.url.includes('event-game')))assert.match(node.wires[0][0],/community-policy-verified-actor/);
 assert.ok(candidate.flow.find((n:any)=>n.id==='community-event-game-v1-catch').scope.includes('community-event-game-v1-apply'));
 assert.equal(patchCommunityTypesFlow(candidate.flow,{eventGames:true}).changes.length,0);
});

const applyCode=eventGameApplySource();
function gameRuntime(initial:any) {
 let doc=structuredClone(initial), now=Date.parse('2026-10-23T10:00:00Z');const state=new Map();
 const context={get:(key:string)=>state.get(key),set:(key:string,val:any)=>state.set(key,val)};
 class Clock extends Date {static now(){return now;}}
 function call(action:string, body:any={}, extra:any={}) {
  const msg={payload:structuredClone(doc),req:{headers:{'idempotency-key':requestId}},_eventGame:{actor,action,body:{...body,engineVersion:EVENT_JUMP_ENGINE_VERSION},id:doc.id},...extra};
  return vm.runInNewContext('(function(msg,context,crypto){'+applyCode+'\n})(msg,context,crypto)',{msg,context,crypto,Date:Clock});
 }
 function commit(result:any, matchedCount=1, modifiedCount=matchedCount) {
  const message=result[0];assert.ok(message);const [filter,update,options]=message.payload;
  assert.equal(options.upsert,false);assert.equal(filter.members,undefined);assert.equal(filter.bannedMembers,undefined);if(matchedCount===1)assert.deepEqual(JSON.parse(JSON.stringify(filter.eventRosterRevision)),doc.eventRosterRevision ?? {$exists:false});assert.equal(filter.eventEntries,undefined,'private registration is never duplicated into query logs');assert.deepEqual(JSON.parse(JSON.stringify(filter.eventEntriesRevision)),doc.eventEntriesRevision ?? {$exists:false},'revision CAS compares unchanged preimage');
  if(matchedCount===1 && modifiedCount===1)doc={...doc,...JSON.parse(JSON.stringify(update.$set))};
  return vm.runInNewContext('(function(msg){'+EVENT_GAME_ACK+'\n})(msg)',{msg:{...message,payload:{acknowledged:true,matchedCount,modifiedCount}}});
 }
 return {call,commit,doc:()=>doc,change:(value:any)=>{doc={...doc,...value};},advance:(ms:number)=>{now+=ms;}};
}
function trace(seed:number) {const game=createGame(seed);game.mode='running';let ticks=0;while(game.mode==='running'&&ticks<36000){stepGame(game,0);ticks++;}return {inputs:[[0,ticks]],score:game.score,ticks};}

test('start issues server run and random seed, retry is idempotent and a live run cannot be replaced',()=>{
 const runtime=gameRuntime(community());const start=runtime.call('start'),reply=runtime.commit(start);
 assert.equal(reply.statusCode,200);assert.notEqual(reply.payload.runId,requestId);assert.ok(Number.isSafeInteger(reply.payload.seed));
 const retry=runtime.call('start');assert.equal(retry[0],null);assert.equal(retry[1].payload.runId,reply.payload.runId);
 const changed=runtime.call('start',{}, {req:{headers:{'idempotency-key':crypto.randomUUID()}}});assert.equal(changed[1].statusCode,200);assert.equal(changed[1].payload.runId,reply.payload.runId,'a new key resumes the same seed rather than shopping for a new one');
 const missing=runtime.call('start',{}, {req:{headers:{}}});assert.equal(missing[1].statusCode,400);
});
test('server replay matches browser engine; only acknowledged finish updates best, duplicate finish is stable',()=>{
 const runtime=gameRuntime(community());const run=runtime.commit(runtime.call('start')).payload;const replay=trace(run.seed);runtime.advance(replay.ticks*FIXED_STEP*1000+100);
 const result=runtime.call('finish',{runId:run.runId,inputs:replay.inputs,score:99999999});
 assert.equal(result[0].payload[1].$set.eventEntries[0].bestScore,replay.score,'client score is ignored');
 const unchanged=runtime.commit(result,1,0);assert.equal(unchanged.statusCode,409);assert.equal(runtime.doc().eventEntries[0].bestScore,undefined);
 const conflict=runtime.commit(result,0);assert.equal(conflict.statusCode,409);assert.equal(runtime.doc().eventEntries[0].bestScore,undefined);
 const ok=runtime.commit(runtime.call('finish',{runId:run.runId,inputs:replay.inputs}));assert.equal(ok.payload.score,replay.score);
 const retry=runtime.call('finish',{runId:run.runId,inputs:replay.inputs});assert.equal(retry[0],null);assert.equal(retry[1].payload.bestScore,replay.score);
 const ranking=runtime.call('ranking')[1];assert.equal(ranking.payload.rows[0].score,replay.score);assert.deepEqual(Object.keys(ranking.payload.rows[0]).sort(),['name','rank','score']);assert.doesNotMatch(JSON.stringify(ranking.payload),/example.invalid|playerId|company|fullName|seed/);
});
test('malformed/oversized/incomplete/too-fast/expired replays and cross-run writes fail closed',()=>{
 const runtime=gameRuntime(community());const run=runtime.commit(runtime.call('start')).payload;runtime.advance(60000);
 for(const inputs of [[],[[101,1]],[[0,0]],[[0,36001]],[[0,1.1]],[[0,1]],Array(12001).fill([0,1])])assert.equal(runtime.call('finish',{runId:run.runId,inputs})[1].statusCode,400);
 assert.equal(runtime.call('finish',{runId:crypto.randomUUID(),inputs:[[0,1]]})[1].statusCode,409);
 runtime.change({typeSettingsRevision:2});assert.equal(runtime.call('finish',{runId:run.runId,inputs:[[0,1]]})[1].payload.error,'EVENT_REGISTRATION_REQUIRED');
 const fast=gameRuntime(community());const fr=fast.commit(fast.call('start')).payload;assert.equal(fast.call('finish',{runId:fr.runId,inputs:[[0,36000]]})[1].payload.error,'EVENT_REPLAY_TOO_FAST');
 const expired=gameRuntime(community());const er=expired.commit(expired.call('start')).payload;expired.advance(31*60000);assert.equal(expired.call('finish',{runId:er.runId,inputs:[[0,1]]})[1].statusCode,409);
});
test('removed, banned, inactive, unregistered and wrong-epoch players cannot start or submit',()=>{
 for(const extra of [{members:[]},{bannedMembers:[{id:actor.id}]},{bannedMembers:[{phone:actor.phone}]},{members:[{...actor,status:'PENDING'}]},{eventEntries:[]},{eventEntries:[{...form,playerId:actor.id,epoch:'old'}]}])assert.ok([403,422].includes(gameRuntime(community(extra)).call('start')[1].statusCode));
 const off=gameRuntime(community({typeSettings:{gameIds:['time-for-friends']}}));assert.equal(off.call('start')[1].statusCode,409);
});
test('ranking excludes removed/banned and previous activation results with deterministic ties',()=>{
 const doc=community();doc.members.push({id:'player-b',name:'Игрок Б',status:'ACTIVE'});doc.eventEntries[0].bestScore=12;doc.eventEntries[0].bestRun={engineVersion:EVENT_JUMP_ENGINE_VERSION};doc.eventEntries[0].bestAt='2026-10-23T10:00:00Z';doc.eventEntries.push({...doc.eventEntries[0],playerId:'player-b'});
 const runtime=gameRuntime(doc);assert.equal(runtime.call('ranking')[1].payload.rows.length,2);
 runtime.change({bannedMembers:[{id:'player-b'}]});assert.equal(runtime.call('ranking')[1].payload.rows.length,1);
 const mismatched=community();mismatched.eventEntries[0].bestScore=999;mismatched.eventEntries[0].bestRun={engineVersion:'old'};assert.equal(gameRuntime(mismatched).call('ranking')[1].payload.rows.length,0);
});

test('a previously patched four-type graph upgrades auth, registration barrier and redaction, then remains stable',()=>{
 const old = structuredClone(candidate.flow).filter((node:any)=>!node.id.includes('community-event-game-v1'));
 const rosterSource = fs.readFileSync('scripts/lib/communityRosterWrites.mjs','utf8');
 const eventBarrier = rosterSource.split('const EVENT_BARRIER = String.raw`')[1].split('\n`;')[0];
 const legacyBarrier = JSON.parse(rosterSource.split('const LEGACY_BARRIER = ')[1].split(';\n')[0]);
 for(const node of old)if(node.type==='function') {
   node.func=node.func.replace(eventBarrier,legacyBarrier).replaceAll("'STATION','CORPORATE','LEAGUE','EVENT'","'STATION','CORPORATE','LEAGUE'").replaceAll("'STATION', 'CORPORATE', 'LEAGUE', 'EVENT'","'STATION', 'CORPORATE', 'LEAGUE'");
   if(node.func.includes('COMMUNITY_TYPED_RESPONSE_REDACTION')) {
    const a=node.func.indexOf('const redact = '), b=node.func.indexOf(';\nconst output = ',a);
    node.func=node.func.slice(0,a)+'const redact = '+sanitizeTypedCommunityPayload.toString().replace("'LEAGUE', 'EVENT'","'LEAGUE'").split('\n').filter(line=>!line.includes("key === 'eventEntries'")).join('\n')+node.func.slice(b);
   }
 }
 const upgraded=patchCommunityTypesFlow(old,{eventGames:true});
 const apply=upgraded.flow.find((node:any)=>node.id==='join');assert.ok(apply.func.includes('EVENT_REGISTRATION_COMMIT_V2'));
 assert.ok(apply.func.includes("'LEAGUE','EVENT'"));assert.ok(apply.func.includes("key === 'eventEntries'"));
 assert.equal(patchCommunityTypesFlow(upgraded.flow,{eventGames:true}).changes.length,0);
});

test('real API body builder pins engine version and preserves replay without trusting caller version',()=>{ const body=eventGameCommandBody({runId:'server-run',inputs:[[0,10]],engineVersion:'spoofed'});assert.equal(body.engineVersion,EVENT_JUMP_ENGINE_VERSION);assert.deepEqual(body.inputs,[[0,10]]);assert.equal(eventGameCommandBody().engineVersion,EVENT_JUMP_ENGINE_VERSION); });

test('policy gate closes missing, stale, early and ended play; retention closes ranking at the exact instant',()=>{
 const missing=community();delete missing.typeSettings.registrationPolicy;
 assert.equal(gameRuntime(missing).call('start')[1].payload.error,'EVENT_POLICY_NOT_READY');
 assert.equal(join(missing)[4].payload.error,'EVENT_POLICY_NOT_READY');
 assert.equal(join(community({eventEntries:[]}),{...form,policyRevision:0})[4].payload.eventNotice.revision,1);
 const stale=community();stale.eventEntries[0].policyRevision=0;
 assert.equal(gameRuntime(stale).call('start')[1].payload.error,'EVENT_REGISTRATION_REQUIRED');
 const early=community();early.typeSettings.registrationPolicy.startsAt='2026-10-23T11:00:00.000Z';
 assert.equal(gameRuntime(early).call('start')[1].payload.error,'EVENT_CLOSED');
 const ended=community();ended.typeSettings.registrationPolicy.endsAt='2026-10-23T10:00:00.000Z';
 assert.equal(gameRuntime(ended).call('start')[1].payload.error,'EVENT_CLOSED');
 assert.equal(join(ended)[4].payload.error,'EVENT_CLOSED');
 assert.equal(gameRuntime(ended).call('ranking')[1].statusCode,200);
 const retained=gameRuntime(ended);retained.advance(365*86400000-1);assert.equal(retained.call('ranking')[1].statusCode,200);retained.advance(1);assert.equal(retained.call('ranking')[1].payload.error,'EVENT_DATA_EXPIRED');
 const current=gameRuntime(community());const run=current.commit(current.call('start')).payload;
 current.advance(2*86400000);assert.equal(current.call('finish',{runId:run.runId,inputs:[[0,1]]})[1].payload.error,'EVENT_CLOSED');
});

test('inactive archived community copies stay byte-identical and ambiguous active copies fail closed',()=>{
 const original=structuredClone(candidate.flow);
 const legacy={id:'archived-list',z:'archive',type:'function',name:'Prepare communities list query',func:'return msg;',outputs:3,wires:[[],[],[]]};
 const input=[...original,{id:'archive',type:'tab',disabled:true},legacy];
 const result=patchCommunityTypesFlow(input,{eventGames:true});
 assert.deepEqual(result.flow.find((n:any)=>n.id==='archived-list'),legacy);
 assert.equal(result.changes.length,0);
 assert.throws(()=>patchCommunityTypesFlow([...original,{...legacy,z:'tab'}],{eventGames:true}),/AMBIGUOUS_ACTIVE_FUNCTION/);
 const drift=structuredClone(original), apply=drift.find((n:any)=>n.id==='community-event-game-v1-apply');apply.func=apply.func.replace('const ctx = msg._eventGame', 'const ctx = msg._foreignGame');
 assert.throws(()=>patchCommunityTypesFlow(drift,{eventGames:true}),/UPGRADE_DRIFT/);
});

test('foreign duplicate active routes and inactive fixed generated ids fail closed',()=>{
 const duplicate={id:'foreign-event-route',type:'http in',z:'tab',method:'post',url:'/lk/communities/:other/event-game/:action',wires:[]};
 assert.throws(()=>patchCommunityTypesFlow([...structuredClone(candidate.flow),duplicate],{eventGames:true}),/AMBIGUOUS_ACTIVE_ROUTE/);
 const base=structuredClone(candidate.flow).filter((n:any)=>!n.id.startsWith('community-event-game-v1') && !n.id.startsWith('community-policy-verified-actor-v1-entry-community-event-game-v1'));
 const inactive={id:'community-event-game-v1-in',type:'http in',z:'archive',method:'post',url:'/lk/communities/:communityId/event-game/:action',wires:[]};
 assert.throws(()=>patchCommunityTypesFlow([...base,{id:'archive',type:'tab',disabled:true},inactive],{eventGames:true}),/INACTIVE_ID_COLLISION/);
 const bad=structuredClone(candidate.flow);bad.find((n:any)=>n.id==='community-event-game-v1-write').wires=[['missing-active-node']];
 assert.throws(()=>patchCommunityTypesFlow(bad,{eventGames:true}),/GENERATED_GRAPH_DRIFT|ACTIVE_GRAPH_TARGET_MISSING/);
});

test('EVENT roster and ban changes are fenced numerically without profile arrays in Mongo filters',()=>{
 const runtime=gameRuntime(community({eventRosterRevision:3}));
 const result=runtime.call('start'),filter=result[0].payload[0];
 assert.equal(filter.eventRosterRevision,3);assert.doesNotMatch(JSON.stringify(filter),/members|phone|fullName|company|email|Игрок/);
 runtime.change({eventRosterRevision:4,bannedMembers:[{id:actor.id}]});
 assert.equal(runtime.commit(result,0).statusCode,409);
 assert.equal(runtime.call('start')[1].statusCode,403);
 const malformed=community({eventRosterRevision:'bad'});assert.equal(gameRuntime(malformed).call('start')[1].payload.error,'EVENT_ROSTER_REVISION_INVALID');
});

test('known generated EVENT graph shape is exact: routes, auth instance, Mongo, libs, catches and wires',()=>{
 const cases: Array<[string,(n:any)=>void]> = [
  ['-in',n=>n.url='/lk/unprotected/event'],['-in',n=>n.method='get'],
  ['-find',n=>n.collection='other'],['-find',n=>n.operation='findOne'],
  ['-write',n=>n.collection='other'],['-write',n=>n.operation='insertOne'],['-write',n=>n.wires=[['response']]],
  ['-apply',n=>n.libs=[]],['-catch',n=>n.scope=[]],['-prepare',n=>n.func='return [msg,null];'],
 ];
 for(const [suffix,change] of cases) {const drift=structuredClone(candidate.flow);change(drift.find((n:any)=>n.id==='community-event-game-v1'+suffix));assert.throws(()=>patchCommunityTypesFlow(drift,{eventGames:true}),/DRIFT|ROUTES_REQUIRED/);}
 const auth=structuredClone(candidate.flow);auth.find((n:any)=>n.id==='community-policy-verified-actor-v1-entry-community-event-game-v1-in').type='function';assert.throws(()=>patchCommunityTypesFlow(auth,{eventGames:true}),/INSTANCE_DRIFT|GRAPH_DRIFT/);
});

test('shared auth graph refuses Bearer destination, wiring and subflow-port drift',()=>{
 const cases: Array<[string,(n:any)=>void]> = [
  ['-http',n=>n.url='https://untrusted.invalid/profile'],['-http',n=>n.wires=[['response']]],
  ['',n=>n.out=[]],['-prepare',n=>n.outputs=2],['-response',n=>n.wires=[['response'],[]]],
 ];
 for(const [suffix,change] of cases) {const drift=structuredClone(candidate.flow);change(drift.find((n:any)=>n.id==='community-policy-verified-actor-v1'+suffix));assert.throws(()=>patchCommunityTypesFlow(drift,{eventGames:true}),/SUBFLOW_DRIFT/);}
});

test('response sanitizer refuses drifted tail/ports and join auth cannot fan out private forms',()=>{
 for(const edit of [(s:string)=>s.replace('message.payload = redact(message.payload, message._typedCommunity === true);','message.payload = message.payload;'),(s:string)=>s.replace(/const ports = \[[^\n]*\];/,'const ports = [];')]) {
  const drift=structuredClone(candidate.flow),node=drift.find((n:any)=>n.id==='join');node.func=edit(node.func);assert.throws(()=>patchCommunityTypesFlow(drift,{eventGames:true}),/WRAPPER_DRIFT/);
 }
 const fanout=structuredClone(candidate.flow);fanout.find((n:any)=>n.id==='community-policy-verified-actor-v1-entry-join-http').wires[0].push('response');assert.throws(()=>patchCommunityTypesFlow(fanout,{eventGames:true}),/INSTANCE_DRIFT/);
 const bypass=structuredClone(candidate.flow);bypass.find((n:any)=>n.id==='community-policy-verified-actor-v1-entry-join-http').wires=[['response']];assert.throws(()=>patchCommunityTypesFlow(bypass,{eventGames:true}),/JOIN_TARGET_DRIFT/);
});

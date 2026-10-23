import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCommunityTypeSettings, parseEventRegistrationPolicy, eventRetentionUntil } from '../../src/services/community-policy.ts';
import { prepareEventErasure, verifyEventErasureAck, validateEventErasurePaths } from '../prepare_event_erasure.mjs';
import { buildEventCommunityGuard, sha256 } from '../nginx/prepare_event_community_guard.mjs';
const fixture=JSON.parse(fs.readFileSync('scripts/fixtures/event-community.json','utf8'));
fixture.typeSettings.registrationPolicy={version:'event-registration-v1',responsibleName:'Тестовый Ответственный',contactEmail:['synthetic','example.invalid'].join('@'),startsAt:'2026-10-23T09:00:00.000Z',endsAt:'2026-10-24T20:59:59.999Z',retentionYears:1};
const policy=fixture.typeSettings.registrationPolicy;
test('policy parity, exact UTC instants, safe contact/strict fields and calendar-year retention',()=>{
 assert.equal(fs.readFileSync('src/services/community-policy.ts','utf8').includes('registrationPolicy'),true);
 assert.deepEqual(parseCommunityTypeSettings('EVENT',fixture.typeSettings),fixture.typeSettings);
 for(const changed of [{contactEmail:'bad'},{version:'other'},{retentionYears:2},{endsAt:policy.startsAt},{startsAt:'2026-11-16'},{startsAt:'2026-11-16T00:00:00+03:00'},{responsibleName:'Name\nInjected'},{unknown:'value'}]) assert.throws(()=>parseEventRegistrationPolicy({...policy,...changed}));
 assert.equal(eventRetentionUntil('2026-11-20T20:59:59.999Z'),'2027-11-20T20:59:59.999Z');
 assert.equal(eventRetentionUntil('2028-02-29T09:30:00.000Z'),'2029-02-28T09:30:00.000Z');
});
const source=`server {\n    listen 8080;\n    server_name localhost;\n    location = /unrelated { return 200 'unrelated'; }\n    location = /lk/communities {\n        add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-API-Key" always;\n        proxy_pass http://127.0.0.1:1880;\n    }\n    location ^~ /lk/communities/ {\n        add_header Access-Control-Allow-Headers "Content-Type, Authorization, X-API-Key" always;\n        proxy_pass http://127.0.0.1:1880;\n    }\n}\n`;
export const syntheticNginxSource=source;
test('nginx candidate is exact-source guarded, scoped, bounded, offline and idempotent',()=>{
 const origins=['https://padlhub.ru','https://padlhub.su'];
 const result=buildEventCommunityGuard(source,sha256(source),origins);
 assert.equal(result.changed,true);assert.doesNotMatch(result.candidate,/limit_req zone=/);assert.ok(result.candidate.includes("location = /unrelated { return 200 'unrelated'; }"));
 assert.equal(buildEventCommunityGuard(result.candidate,sha256(result.candidate),origins).changed,false);
 assert.match(result.candidate,/client_max_body_size 192k/);assert.match(result.candidate,/client_max_body_size 8k/);
 assert.match(result.http,/limit_req_zone \$binary_remote_addr/);assert.match(result.http,/limit_req_zone \$server_name/);
 assert.match(result.common,/limit_conn lk_community_conn_global 30/);assert.match(result.common,/limit_conn lk_community_conn_ip 6/);
 assert.match(result.common,/Idempotency-Key \$http_idempotency_key/);assert.match(result.common,/X-Correlation-ID \$lk_event_correlation/);
 assert.match(result.common,/access_log off/);assert.doesNotMatch(result.common,/Access-Control-Allow-Origin \*/);
 for(const [input,hash,allow] of [[source,'wrong',origins],[source,sha256(source),['https://padlhub.ru/']],[source,sha256(source),['http://padlhub.ru']],[source.replace('proxy_pass','include'),sha256(source.replace('proxy_pass','include')),origins]])assert.throws(()=>buildEventCommunityGuard(input,hash,allow));
 assert.throws(()=>buildEventCommunityGuard(source+source,sha256(source+source),origins));
});
function doc() {return {...structuredClone(fixture),eventEntriesRevision:4,eventEntries:[
 {playerId:'synthetic-a',epoch:'old',fullName:'Synthetic A',company:'Synthetic',email:['a','example.invalid'].join('@'),retentionUntil:'2027-10-24T20:59:59.999Z'},
 {playerId:'synthetic-a',epoch:'current',run:{id:'run'},bestScore:12,retentionUntil:'2027-10-24T20:59:59.999Z'},
 {playerId:'synthetic-b',epoch:'current',retentionUntil:'2028-10-24T20:59:59.999Z'},
]};}
function applySynthetic(document:any, command:any) {
 if (!command) return {acknowledged:true,matchedCount:0,modifiedCount:0};
 const f=command.filter;
 if(document.id!==f.id || document.typeSettingsRevision!==f.typeSettingsRevision || document.eventEntriesRevision!==f.eventEntriesRevision) return {acknowledged:true,matchedCount:0,modifiedCount:0};
 const pull=command.update.$pull.eventEntries;
 document.eventEntries=document.eventEntries.filter((e:any)=>pull.playerId?e.playerId!==pull.playerId:!(e.retentionUntil<=pull.retentionUntil.$lte));document.eventEntriesRevision++;
 return {acknowledged:true,matchedCount:1,modifiedCount:1};
}
test('synthetic erasure removes all epochs/results of exactly one actor, CAS conflicts do not overwrite; repeat is no-op',()=>{
 const document=doc(), other=structuredClone(document.eventEntries[2]);
 const plan=prepareEventErasure(document,{actorId:'synthetic-a',now:'2026-10-23T10:00:00.000Z'});
 assert.equal(plan.receipt.removedCount,2);assert.equal(plan.command.options.upsert,false);
 assert.doesNotMatch(JSON.stringify(plan.command.filter),/eventEntries"|fullName|company|email/);
 assert.doesNotMatch(JSON.stringify(plan.receipt),/synthetic-a|Synthetic A|example.invalid/);
 const conflict=structuredClone(document);conflict.eventEntriesRevision++;
 assert.throws(()=>verifyEventErasureAck(applySynthetic(conflict,plan.command)),/CONFLICT/);assert.equal(conflict.eventEntries.length,3);
 const drift=structuredClone(document);drift.typeSettingsRevision++;
 assert.throws(()=>verifyEventErasureAck(applySynthetic(drift,plan.command)),/CONFLICT/);
 assert.equal(verifyEventErasureAck(applySynthetic(document,plan.command)),true);assert.deepEqual(document.eventEntries,[other]);
 assert.equal(prepareEventErasure(document,{actorId:'synthetic-a',now:'2026-10-23T10:00:00.000Z'}).command,null);assert.equal(document.eventEntriesRevision,5);
 assert.throws(()=>verifyEventErasureAck({acknowledged:false,matchedCount:1,modifiedCount:1}));
 assert.throws(()=>verifyEventErasureAck({acknowledged:true,matchedCount:1,modifiedCount:0}));
});
test('retention cutoff is inclusive, preserves later entries and works after type change; malformed preimage denies',()=>{
 const document=doc();document.communityType='FRIENDS';
 assert.equal(prepareEventErasure(document,{expired:true,now:'2027-10-24T20:59:59.998Z'}).receipt.removedCount,0);
 const plan=prepareEventErasure(document,{expired:true,now:'2027-10-24T20:59:59.999Z'});assert.equal(plan.receipt.removedCount,2);
 verifyEventErasureAck(applySynthetic(document,plan.command));assert.equal(document.eventEntries[0].playerId,'synthetic-b');
 for(const change of [{eventEntriesRevision:-1},{eventEntriesRevision:Number.MAX_SAFE_INTEGER},{typeSettingsRevision:null},{eventEntries:[{playerId:'synthetic-a'}]}]) assert.throws(()=>prepareEventErasure({...doc(),...change},{expired:true,now:'2027-10-24T20:59:59.999Z'}));
 assert.throws(()=>prepareEventErasure(doc(),{actorId:'synthetic-a',expired:true,now:'2027-10-24T20:59:59.999Z'}));
});

test('erasure plans require a private external workspace and random unlinkable receipt id',()=>{
 const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'event-erasure-test-'));fs.chmodSync(root,0o700);
 const input=path.join(root,'input.json'),output=path.join(root,'plan.json');fs.writeFileSync(input,JSON.stringify(doc()),{mode:0o600});
 try {
  assert.doesNotThrow(()=>validateEventErasurePaths(input,output));
  assert.throws(()=>validateEventErasurePaths(path.resolve('scripts/fixtures/event-community.json'),output));
  assert.throws(()=>validateEventErasurePaths(input,path.resolve('tmp/erasure-plan.json')));
  fs.chmodSync(root,0o755);assert.throws(()=>validateEventErasurePaths(input,output));fs.chmodSync(root,0o700);
  fs.chmodSync(input,0o644);assert.throws(()=>validateEventErasurePaths(input,output));fs.chmodSync(input,0o600);
  const repoAlias=path.join(root,'repo-alias');fs.symlinkSync(process.cwd(),repoAlias);assert.throws(()=>validateEventErasurePaths(input,path.join(repoAlias,'private-plan.json')));fs.unlinkSync(repoAlias);
  const privateAlias=path.join(root,'private-alias');fs.symlinkSync(root,privateAlias);assert.throws(()=>validateEventErasurePaths(input,path.join(privateAlias,'private-plan.json')));fs.unlinkSync(privateAlias);
  fs.symlinkSync(input,output);assert.throws(()=>validateEventErasurePaths(input,output));fs.unlinkSync(output);
  const first=prepareEventErasure(doc(),{actorId:'synthetic-a',now:'2026-10-23T10:00:00.000Z'}),second=prepareEventErasure(doc(),{actorId:'synthetic-a',now:'2026-10-23T10:00:00.000Z'});
  assert.notEqual(first.receipt.operationId,second.receipt.operationId);assert.equal(first.receipt.targetDigest,undefined);
 } finally {fs.rmSync(root,{recursive:true});}
});

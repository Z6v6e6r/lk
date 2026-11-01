import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const component=fs.readFileSync('src/components/cabinet/CommunitiesSection.tsx','utf8');
const handler=component.split('  const handleSendChatMessage = async (event: FormEvent) => {')[1].split('\n  const canPostInSelectedCommunity')[0];
function harness(api){return new Function('apiCreateCommunityChatMessage','crypto',`
 let chatDraft='Synthetic',isCurrentChatSending=false;const chatDraftRevisionRef={current:0},chatRequestRef={current:new Map()},currentMember={id:'actor'},selectedCommunity={id:'community'},canChatInSelectedCommunity=true,chatScrollActionRef={current:null};
 const setChatSendingId=()=>{},setChatError=()=>{},setChatByCommunityId=()=>{},setChatLoadedByCommunityId=()=>{},communityErrorMessage=()=>'';
 const setChatDraft=value=>{chatDraft=typeof value==='function'?value(chatDraft):value;};
 const handleSendChatMessage=async(event)=>{${handler}
 return {send:()=>handleSendChatMessage({preventDefault(){}}),edit:value=>{chatDraftRevisionRef.current++;setChatDraft(value);},draft:()=>chatDraft,request:()=>chatRequestRef.current,actor:id=>{currentMember.id=id;},community:id=>{selectedCommunity.id=id;}};
`)(api,crypto);}
test('actual LK1 manual retry keeps original key/body, preserves failed/edited draft and clears only success',async()=>{
 const calls=[];let fail=true,ui;
 ui=harness(async(_id,body)=>{calls.push(body);return fail?{error:'offline'}:{data:{id:'public-message'}};});
 await ui.send();assert.equal(ui.draft(),'Synthetic');const key=calls[0].requestId;assert.ok(key);
 await ui.send();assert.equal(calls[1].requestId,key);ui.edit('Edited');await ui.send();assert.notEqual(calls[2].requestId,key);
 fail=false;await ui.send();assert.equal(calls[3].requestId,calls[2].requestId);assert.equal(ui.draft(),'');assert.equal(ui.request().size,1);
 const edited=harness(async()=>{edited.edit('New draft while sending');return {data:{id:'message'}};});await edited.send();assert.equal(edited.draft(),'New draft while sending');
 const identical=harness(async()=>{identical.edit('Synthetic');return {data:{id:'late'}};});await identical.send();assert.equal(identical.draft(),'Synthetic');
});
test('legacy API serializes optional original request key without automatic replay',()=>{
 const source=fs.readFileSync('src/utils/communityApi.ts','utf8').split('export async function apiCreateCommunityChatMessage')[1].split('\nexport ')[0];
 assert.match(source,/requestId: payload.requestId/);assert.match(source,/retries: 0/);assert.match(source,/false, \/\/ Manual retry/);
});

test('unresolved originals survive edits and identity switches; cap preserves old retry custody',async()=>{
 const calls=[],ui=harness(async(_id,body)=>{calls.push(body);return {error:'unknown'};});
 await ui.send();const original=calls.at(-1).requestId;ui.edit('Other');await ui.send();ui.edit('Synthetic');await ui.send();assert.equal(calls.at(-1).requestId,original);
 ui.actor('another');await ui.send();assert.notEqual(calls.at(-1).requestId,original);ui.actor('actor');ui.community('elsewhere');await ui.send();assert.notEqual(calls.at(-1).requestId,original);ui.community('community');await ui.send();assert.equal(calls.at(-1).requestId,original);
 for(let i=0;i<8;i++){ui.edit('Distinct '+i);await ui.send();}assert.equal(ui.request().size,8);const before=calls.length;ui.edit('No room');await ui.send();assert.equal(calls.length,before);ui.edit('Synthetic');await ui.send();assert.equal(calls.at(-1).requestId,original);
});

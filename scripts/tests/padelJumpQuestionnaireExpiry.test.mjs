import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {patchCommunityTypesFlow} from '../patch_live_community_types.mjs';

const target='community_1794221739126_корпспорт-падлхаб-2026';
const prefix='community-exhibition-retention-v1';
const at='2027-11-10T14:00:00.000Z';
const source=fs.readFileSync('scripts/patch_nodered_communities_flow.mjs','utf8');
const common=source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
const body=name=>common+source.split('const '+name+' = `${commonHelpers}')[1].split('\n`;')[0];
function graph() {
  const base=[{id:'tab',type:'tab'},
    ...[['create','Build community create docs','fnCreate'],['update','Prepare community update','fnUpdatePrepare'],['ranking','Use rating snapshot or fallback','fnRankingSnapshotResponse']].map(([id,name,code])=>({id,type:'function',z:'tab',name,func:body(code),outputs:2,wires:[[],[]]})),
    {id:'list',type:'function',z:'tab',name:'Prepare communities list query',func:common+fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_prepare_tail.js','utf8'),outputs:2,wires:[[],[]]},
    {id:'autojoin',type:'function',z:'tab',name:'Prepare game station autojoin',func:'return [msg,null];',outputs:2,wires:[[],[]]},
    {id:'mongo',type:'mongodb4',z:'tab',mode:'collection',collection:'lk_communities',operation:'find',clientNode:'fixture-client',output:'toArray',wires:[]}];
  return patchCommunityTypesFlow(base,{eventAdmission:true,eventRetention:true}).flow;
}
function document() {
  const epoch='2026-11-09T09:00:00.000Z';
  const entry=(id,registeredAt,retentionUntil)=>({playerId:id,epoch,policyRevision:2,policyVersion:'event-registration-v1',retentionMode:'submitted-year-v1',registeredAt,retentionUntil,fullName:'Private Participant',company:'Private Company',email:[id,'example.invalid'].join('@')});
  return {id:target,communityType:'EVENT',typeSettingsRevision:2,typeSettingsEffectiveAt:epoch,eventEntriesRevision:4,members:[{id:'synthetic-owner',role:'OWNER'}],eventEntries:[entry('synthetic-expired','2026-11-10T14:00:00.000Z',at),entry('synthetic-live','2027-11-10T13:00:00.000Z','2028-11-10T13:00:00.000Z')]};
}
function project(doc,projection) {
  const out={};
  for(const key of ['id','communityType','typeSettingsRevision','typeSettingsEffectiveAt','eventEntriesRevision']) if(projection[key] && Object.hasOwn(doc,key)) out[key]=doc[key];
  if(doc.eventEntries) out.eventEntries=doc.eventEntries.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>projection['eventEntries.'+key])));
  return structuredClone(out);
}
function execute(nodes,initial,{writeAckLost=false,conflict=false,postReadCorrupt=false,clockRollback=false}={}) {
  let doc=structuredClone(initial),writes=0,reads=0,steps=0;
  const logs=[];
  const tick=nodes.find(n=>n.id===prefix+'-tick');assert.ok(tick,'a periodic canonical expiry writer is missing');
  let clockReads=0;
  class Clock extends Date {constructor(value=at){super(value);}static now(){return Date.parse(at)-(clockRollback && ++clockReads>1?1000:0);}}
  const byId=new Map(nodes.map(n=>[n.id,n]));
  let pending=[{id:tick.wires[0][0],msg:{payload:{now:'2099-01-01T00:00:00.000Z'},req:{headers:{authorization:'private-canary'}}}}];
  while(pending.length) {
    assert.ok(++steps<40,'bounded worker graph must terminate');
    const {id,msg}=pending.shift(),node=byId.get(id);assert.ok(node);
    let outputs;
    try {
      if(node.type==='function') {
        const result=vm.runInNewContext('(function(msg,node,crypto){'+node.func+'\n})(msg,node,crypto)',{msg,node:{warn:value=>logs.push(value),status(){}},crypto,Date:Clock});
        outputs=Array.isArray(result)?result:[result];
      } else if(node.type==='mongodb4') {
        assert.equal(node.collection,'lk_communities');assert.equal(node.clientNode,'fixture-client');assert.equal(node.maxTimeMS,5000);
        if(node.operation==='find') {
          reads++;
          const [query,options]=msg.payload;assert.deepEqual(JSON.parse(JSON.stringify(query)),{id:target});
          assert.equal(options.maxTimeMS,5000);assert.equal(options.projection._id,0);
          for(const field of ['fullName','company','email','run','bestScore']) assert.equal(options.projection['eventEntries.'+field],undefined,'expiry reads metadata, not questionnaire values');
          msg.payload=doc?[project(doc,options.projection)]:[];
          if(postReadCorrupt && reads===2) msg.payload[0].eventEntriesRevision++;
        } else {
          assert.equal(node.operation,'updateOne');writes++;
          const [filter,update,options]=msg.payload;
          assert.equal(options.upsert,false);assert.equal(options.maxTimeMS,5000);
          assert.equal(filter.id,target);assert.equal(filter.eventEntriesRevision,4);
          assert.doesNotMatch(JSON.stringify(filter),/fullName|company|email|Private/);
          if(!conflict) {
            assert.equal(update.$pull.eventEntries.retentionUntil.$lte,at,'caller time must never authorize deletion');
            doc.eventEntries=doc.eventEntries.filter(row=>row.retentionUntil>update.$pull.eventEntries.retentionUntil.$lte);
            doc.eventEntriesRevision+=update.$inc.eventEntriesRevision;
          }
          if(writeAckLost) throw new Error('private-canary transport failure');
          msg.payload={acknowledged:true,matchedCount:conflict?0:1,modifiedCount:conflict?0:1};
        }
        outputs=[msg];
      } else throw new Error('unexpected worker node type');
    } catch(error) {
      const catcher=nodes.find(n=>n.type==='catch' && n.scope.includes(id));assert.ok(catcher,'errors need an owned sanitizer');
      msg.error={message:error.message,source:{id}};
      pending.push({id:catcher.wires[0][0],msg});continue;
    }
    for(let port=0;port<outputs.length;port++) if(outputs[port]) for(const next of node.wires[port]||[]) pending.push({id:next,msg:outputs[port]});
  }
  return {doc,writes,reads,logs};
}

test('canonical hourly expiry executes the CAS/readback pipeline over owned metadata doubles without reading contacts',()=>{
  const nodes=graph(),tick=nodes.find(n=>n.id===prefix+'-tick');
  assert.ok(tick,'perpetual collection needs a scheduled expiry path, not an offline plan only');
  assert.equal(tick.repeat,'3600');assert.equal(tick.once,true);
  assert.ok(nodes.filter(n=>n.id.startsWith(prefix)).every(n=>n.type!=='http in'),'no public cleanup route');
  const before=document(),remaining=structuredClone(before.eventEntries[1]);
  const result=execute(nodes,before);
  assert.equal(result.writes,1);assert.equal(result.reads,2);
  assert.deepEqual(result.doc.eventEntries,[remaining]);assert.deepEqual(result.doc.members,before.members);
  assert.equal(result.doc.eventEntriesRevision,5);
  assert.match(result.logs.join('\n'),/PURGED/);
  assert.doesNotMatch(result.logs.join('\n'),/Private|@|synthetic-expired|synthetic-live|private-canary|authorization|fullName|company|email/);
});

test('empty and unexpired retention ticks do not write or slide deadlines, including after type rollback',()=>{
  for(const state of [null,{id:target,communityType:'FRIENDS'}, {...document(),eventEntries:[]}]) {
    const result=execute(graph(),state);
    assert.equal(result.writes,0);assert.deepEqual(result.doc,state);assert.match(result.logs.join('\n'),/NOOP/);
  }
  const live=document();live.eventEntries.shift();
  const noExpiry=execute(graph(),live);assert.equal(noExpiry.writes,0);assert.deepEqual(noExpiry.doc,live);
  const rolledBack=document();rolledBack.communityType='FRIENDS';rolledBack.archived=true;
  const expired=execute(graph(),rolledBack);assert.equal(expired.writes,1);assert.equal(expired.doc.eventEntries.length,1);assert.deepEqual(expired.doc.members,rolledBack.members);
});

test('expiry fails closed before mutation for foreign, malformed, forged-deadline and rollback-clock metadata',()=>{
  for(const mutate of [
    value=>{value.id='foreign-community';},
    value=>{value.eventEntries[0].retentionUntil='2027-11-09T14:00:00.000Z';},
    value=>{value.eventEntries[0].retentionMode='unknown';},
    value=>{value.eventEntries[0].registeredAt='invalid-private-canary';},
    value=>{value.eventEntriesRevision=-1;},
  ]) {
    const before=document();mutate(before);
    const result=execute(graph(),before);assert.equal(result.writes,0);assert.deepEqual(result.doc,before);
    assert.match(result.logs.join('\n'),/RECONCILE_REQUIRED/);assert.doesNotMatch(result.logs.join('\n'),/private-canary|@|Private/);
  }
  const result=execute(graph(),document(),{clockRollback:true});assert.equal(result.writes,0);assert.match(result.logs.join('\n'),/RECONCILE_REQUIRED/);
});

test('CAS conflicts and readback drift never report a completed purge or retry a mutation',()=>{
  for(const options of [{conflict:true},{postReadCorrupt:true},{writeAckLost:true}]) {
    const before=document(),result=execute(graph(),before,options);
    assert.equal(result.writes,1);assert.equal(result.reads,2,'even acknowledgement loss needs a fresh read, not a write replay');
    assert.match(result.logs.join('\n'),/RECONCILE_REQUIRED/);assert.doesNotMatch(result.logs.join('\n'),/PURGED|private-canary|@|Private/);
    if(options.conflict) assert.deepEqual(result.doc,before);
    else assert.deepEqual(result.doc.eventEntries,[before.eventEntries[1]]);
  }
});

test('expiry graph remains idempotent, canonical-client-bound and refuses partial or foreign runtime drift',()=>{
  const nodes=graph();
  assert.equal(patchCommunityTypesFlow(nodes,{eventAdmission:true,eventRetention:true}).changes.length,0);
  for(const mutate of [
    value=>{value.find(n=>n.id===prefix+'-write').collection='foreign';},
    value=>{value.find(n=>n.id===prefix+'-tick').repeat='1';},
    value=>{value.find(n=>n.id===prefix+'-plan').func+='\n// unknown';},
    value=>{value.find(n=>n.id===prefix+'-find').clientNode='foreign';},
  ]) {
    const copy=structuredClone(nodes);mutate(copy);
    assert.throws(()=>patchCommunityTypesFlow(copy,{eventAdmission:true,eventRetention:true}),/EXHIBITION_RETENTION_GRAPH_DRIFT/);
  }
  const partial=nodes.filter(n=>n.id!==prefix+'-verify');
  assert.throws(()=>patchCommunityTypesFlow(partial,{eventAdmission:true,eventRetention:true}),/EXHIBITION_RETENTION_GRAPH_DRIFT/);
  assert.throws(()=>patchCommunityTypesFlow(nodes,{eventRetention:true}),/EXHIBITION_RETENTION_CANONICAL_ADMISSION_REQUIRED/);
});

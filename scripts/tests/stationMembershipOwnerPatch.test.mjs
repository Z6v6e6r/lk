import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildStationMembershipOwner, stationOwnerIds } from '../patch_nodered_station_membership_owner.mjs';
import { addCommunityRosterWrites } from '../lib/communityRosterWrites.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function base() {
  const nodes = [{ id: 'tab', type: 'tab' }, { id: 'mongo', type: 'mongodb4-client' }, { id: 'response', type: 'http response', wires: [] }, { id: 'foreign', type: 'function', name: 'unrelated', func: 'return msg;', wires: [] }];
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  nodes.push({ id:'create',type:'function',z:'tab',name:'Build community create docs',outputs:6,func:common+source.split('const fnCreate = `${commonHelpers}')[1].split('\n`;')[0],wires:[['create-store'],[],[],[],['response'],[]] },
    { id:'create-store',type:'mongodb4',z:'tab',collection:'lk_communities',operation:'updateOne',clientNode:'mongo',wires:[] });
  for (const [i, name] of ['Apply community join','Apply invite join','Apply member management'].entries()) {
    nodes.push({ id: 'fn' + i, type: 'function', z: 'tab', name, func: '// COMMUNITY_TYPED_ACCESS_GUARD\nreturn [null,null,null,null,null,null];', outputs: 6, wires: [['db' + i], ...Array.from({ length: 5 }, () => ['response'])] });
    nodes.push({ id: 'db' + i, type: 'mongodb4', z: 'tab', collection: 'lk_communities', operation: 'updateOne', clientNode: 'mongo', wires: [] });
  }
  return addCommunityRosterWrites(nodes);
}
test('exact reviewed graph gains isolated receiver, no provider graph or foreign edits', () => {
  const original = base(), bytes = JSON.stringify(original);
  const result = buildStationMembershipOwner(bytes, { expectedFlowSha256: digest(bytes), mongoClientId: 'mongo' });
  assert.equal(result.providerNodesAdded, 0);
  assert.deepEqual(result.flow.find(n => n.id === 'foreign'), original.find(n => n.id === 'foreign'));
  assert.equal(result.flow.filter(n => n.type === 'http in').length, 2);
  assert.equal(result.flow.filter(n => n.type === 'http request').length, 0);
  assert.deepEqual(result.flow.find(n => n.id === stationOwnerIds.admissionIn).wires, [[stationOwnerIds.admissionVerify]]);
  assert.ok(result.flow.find(n => n.id === 'fn2').func.includes('STATION_LIFETIME_ROSTER_V1'));
  assert.throws(() => buildStationMembershipOwner(bytes, { expectedFlowSha256: '0'.repeat(64), mongoClientId: 'mongo' }), /PREIMAGE/);
  const installed = JSON.stringify(result.flow);
  assert.throws(() => buildStationMembershipOwner(installed, { expectedFlowSha256: digest(installed), mongoClientId: 'mongo' }), /ALREADY_PRESENT/);
});
test('pre-existing references to any new owner/create guard id fail before composition', () => {
  for (const id of Object.values(stationOwnerIds)) for (const reference of [{ wires:[[id]] }, { links:[id] }, { scope:[id] }, { z:id }]) {
    const nodes=base(); Object.assign(nodes.find(n=>n.id==='foreign'),reference); const bytes=JSON.stringify(nodes);
    assert.throws(()=>buildStationMembershipOwner(bytes,{expectedFlowSha256:digest(bytes),mongoClientId:'mongo'}),/PREEXISTING_RESERVED_REFERENCE/);
  }
});
test('create protection refuses different Mongo owner or another ingress to the old writer',()=>{
  for(const mutate of [nodes=>{nodes.find(n=>n.id==='create-store').clientNode='other';},nodes=>{nodes.find(n=>n.id==='foreign').wires=[['create-store']];}]){
    const nodes=base();mutate(nodes);const bytes=JSON.stringify(nodes);
    assert.throws(()=>buildStationMembershipOwner(bytes,{expectedFlowSha256:digest(bytes),mongoClientId:'mongo'}),/STATION_CREATE_(STORE_DRIFT|EXTRA_STORE_INGRESS)/);
  }
});
test('actual create writer holds all effects until protected collision or acknowledged mutation', () => {
  const bytes=JSON.stringify(base()),{flow}=buildStationMembershipOwner(bytes,{expectedFlowSha256:digest(bytes),mongoClientId:'mongo'});
  const run=(id,msg)=>new Function('msg','env',flow.find(n=>n.id===id).func)(msg,{get:()=> 'true'});
  const out=run('create',{payload:{id:'station-community',name:'Synthetic',description:'Synthetic',city:'Synthetic',creator:{id:'player-a'}}});
  assert.ok(out[0]); assert.ok(out.slice(1).every(x=>x===null));
  assert.deepEqual(out[0].payload[0],{id:'station-community'});
  const expression=out[0].payload[1][0].$replaceWith.$cond;
  assert.equal(expression[1],'$$ROOT'); assert.equal(expression[2].$mergeObjects[0],'$$ROOT');
  assert.equal(expression[2].$mergeObjects[1].$literal.id,'station-community');
  const denied=run(stationOwnerIds.createAck,{...out[0],payload:{acknowledged:true,matchedCount:1,modifiedCount:0}});
  assert.equal(denied[3].statusCode,409); assert.ok(denied.slice(0,3).every(x=>x===null));
  const accepted=run(stationOwnerIds.createAck,{...out[0],payload:{acknowledged:true,matchedCount:0,upsertedCount:1}});
  assert.equal(accepted[3].statusCode,200);
  const drift=base();drift.find(n=>n.id==='create').func=drift.find(n=>n.id==='create').func.replace('$setOnInsert: {','$setOnInsert: { unexpected: true,');
  const changed=JSON.stringify(drift), guarded=buildStationMembershipOwner(changed,{expectedFlowSha256:digest(changed),mongoClientId:'mongo'}).flow.find(n=>n.id==='create');
  assert.throws(()=>new Function('msg','env',guarded.func)({payload:{id:'station-community',name:'Synthetic',description:'Synthetic',city:'Synthetic',creator:{id:'player-a'}}},{get:()=> 'true'}),/STATION_CREATE_UPDATE_DRIFT/);
});

test('composed authenticated graph accepts explicit CREATE kind through existing routes, without provider nodes or alternate authority', async () => {
  const { message, environment, admissionBody } = await import('./helpers/stationMembershipOwnerHarness.mjs');
  const bytes=JSON.stringify(base()),{flow}=buildStationMembershipOwner(bytes,{expectedFlowSha256:digest(bytes),mongoClientId:'mongo'});
  const body={...admissionBody(),activity:{kind:'GAME_CREATE',id:'00000000-0000-4000-8000-000000000090'}};
  const ingress=flow.find(n=>n.id===stationOwnerIds.admissionIn),verify=flow.find(n=>n.id===ingress.wires[0][0]);
  assert.equal(ingress.method,'post');assert.equal(ingress.url,'/lk/integrations/v1/station-memberships/operations/:operationId/admission');
  const evaluate=msg=>new Function('msg','env','nodeCrypto',verify.func)(msg,{get:key=>environment[key]},crypto);
  const accepted=evaluate(message('admission',body));
  assert.ok(accepted[0]);assert.equal(accepted[1],null);
  assert.equal(accepted[0]._stationMembership.request.activity.kind,'GAME_CREATE');
  assert.deepEqual(verify.wires,[[stationOwnerIds.admissionFind],[stationOwnerIds.response]]);
  const router=flow.find(n=>n.id===stationOwnerIds.router);
  assert.ok(router.func.includes("kind === 'GAME_CREATE' ? 'GAME_CREATE_ORGANIZER'"));
  assert.equal(flow.filter(n=>n.type==='http request').length,0);
  const unsigned=message('admission',body);delete unsigned.req.headers['x-station-membership-delegation'];
  const rejected=evaluate(unsigned);assert.equal(rejected[0],null);assert.equal(rejected[1].statusCode,401);
});

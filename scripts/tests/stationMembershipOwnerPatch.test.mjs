import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildStationMembershipOwner, stationOwnerIds } from '../patch_nodered_station_membership_owner.mjs';
import { addCommunityRosterWrites } from '../lib/communityRosterWrites.mjs';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function base() {
  const nodes = [{ id: 'tab', type: 'tab' }, { id: 'mongo', type: 'mongodb4-client' }, { id: 'response', type: 'http response', wires: [] }, { id: 'foreign', type: 'function', name: 'unrelated', func: 'return msg;', wires: [] }];
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

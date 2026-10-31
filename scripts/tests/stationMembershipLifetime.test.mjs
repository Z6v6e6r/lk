import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { smTransition, smFence, smConfirmation, smAdmission, smClaim } from '../lib/stationMembershipLifetime.mjs';
import { sanitizeTypedCommunityPayload } from '../lib/communityResponseRedaction.mjs';
import { addCommunityRosterWrites } from '../lib/communityRosterWrites.mjs';
import { community, admissionBody, uid } from './helpers/stationMembershipOwnerHarness.mjs';
test('epoch is monotonic, restoration cannot revive claims, private state is redacted', () => {
  let c = community();
  for (const [i, state] of ['LEFT','REMOVED','BANNED','ACTIVE'].entries()) {
    c.stationMembershipLifetime = smTransition(c, 'player-a', state);
    assert.equal(c.stationMembershipLifetime.players[0].epoch, i + 1);
  }
  assert.equal(sanitizeTypedCommunityPayload(c).stationMembershipLifetime, undefined);
  assert.deepEqual(smFence(c), { 'stationMembershipLifetime.version': 1, 'stationMembershipLifetime.revision': 4 });
});
test('real LK roster barrier atomically writes voluntary/admin lifetime with existing roster CAS', () => {
  const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
  const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
  const body = common + source.split('const fnMemberManageApply = `${commonHelpers}')[1].split('\n`;')[0];
  const graph = addCommunityRosterWrites([
    { id: 'manage', type: 'function', name: 'Apply member management', func: body, outputs: 6, wires: [['write'],['ranking'],['feed'],['event'],['response'],['debug']] },
    { id: 'write', type: 'mongodb4', operation: 'updateOne', collection: 'lk_communities', wires: [] },
  ]);
  for (const [action, actor, state] of [['REMOVE','player-a','LEFT'],['REMOVE','owner','REMOVED'],['BAN','owner','BANNED']]) {
    const c = { ...community(), members: [{ id: 'owner', name: 'Owner', role: 'OWNER' }, { id: 'player-a', name: 'Player', role: 'MEMBER' }] };
    const msg = { payload: [c], _communityPolicyPreimage: c, _verifiedCommunityActor: { id: actor }, _communityMemberManage: { actor: { id: actor }, member: { id: 'player-a' }, action } };
    const out = vm.runInNewContext('(function(msg,env){' + graph[0].func + '\n})(msg,env)', { msg, env: { get: () => 'true' } });
    assert.equal(out[0].payload.$set.stationMembershipLifetime.players[0].state, state);
    assert.equal(out[0].payload.$set.stationMembershipLifetime.players[0].epoch, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(out[0].query.stationMembershipLifetime)), { $exists: false });
    assert.ok(out.slice(1).every(x => x === null));
  }
});
test('same old generation cannot repair a missing membership after an applied proof', () => {
  const c = community(), actor = { tenantId: uid(22), canonicalUserId: uid(20), playerId: 'player-a', providerMappingId: uid(23) };
  const a = smAdmission([c], actor, admissionBody());
  const claim = smClaim(a, { confirmation: { generationId: uid(80), activityId: uid(90) } });
  const first = smConfirmation([c], a, claim);
  Object.assign(c, first.update.$set); c.members = [];
  assert.equal(smConfirmation([c], a, claim).reason, 'APPLIED_MEMBER_MISSING');
});

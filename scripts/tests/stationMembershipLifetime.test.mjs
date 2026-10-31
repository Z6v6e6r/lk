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
  const phone = ['+7', '9990000001'].join('');
  const evaluate = (c, actor, member, action) => {
    const msg = { payload: [c], _communityPolicyPreimage: c, _verifiedCommunityActor: { id: actor }, _communityMemberManage: { actor: { id: actor }, member, action } };
    return vm.runInNewContext('(function(msg,env){' + graph[0].func + '\n})(msg,env)', { msg, env: { get: () => 'true' } });
  };
  for (const [action, actor, state] of [['REMOVE','player-a','LEFT'],['REMOVE','owner','REMOVED'],['BAN','owner','BANNED']]) for (const member of [{ id: 'player-a' }, { id: 'wrong', phone }, { phone }]) {
    const c = { ...community(), members: [{ id: 'owner', name: 'Owner', role: 'OWNER' }, { id: 'player-a', phone, name: 'Player', role: 'MEMBER' }] };
    const out = evaluate(c, actor, member, action);
    assert.equal(out[0].payload.$set.stationMembershipLifetime.players[0].playerId, 'player-a');
    assert.equal(out[0].payload.$set.stationMembershipLifetime.players[0].state, state);
    assert.equal(out[0].payload.$set.stationMembershipLifetime.players[0].epoch, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(out[0].query.stationMembershipLifetime)), { $exists: false });
    assert.ok(out.slice(1).every(x => x === null));
    const admission = smAdmission([c], { tenantId: uid(22), canonicalUserId: uid(20), playerId: 'player-a', providerMappingId: uid(23) }, admissionBody());
    const claim = smClaim(admission, { confirmation: { generationId: uid(80), activityId: uid(90) } });
    assert.equal(smConfirmation([{ ...c, ...out[0].payload.$set }], admission, claim).reason, 'MEMBERSHIP_EPOCH_CHANGED');
  }
  const ambiguous = { ...community(), members: [{ id: 'owner', role: 'OWNER' }, { id: 'player-a', phone, role: 'MEMBER' }, { id: 'player-b', phone, role: 'MEMBER' }] };
  assert.throws(() => evaluate(ambiguous, 'owner', { phone }, 'REMOVE'), /STATION_REMOVED_TARGET_AMBIGUOUS/);
});
test('same old generation cannot repair a missing membership after an applied proof', () => {
  const c = community(), actor = { tenantId: uid(22), canonicalUserId: uid(20), playerId: 'player-a', providerMappingId: uid(23) };
  const a = smAdmission([c], actor, admissionBody());
  const claim = smClaim(a, { confirmation: { generationId: uid(80), activityId: uid(90) } });
  const first = smConfirmation([c], a, claim);
  Object.assign(c, first.update.$set); c.members = [];
  assert.equal(smConfirmation([c], a, claim).reason, 'APPLIED_MEMBER_MISSING');
});

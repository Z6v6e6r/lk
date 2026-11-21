import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { patchCupOnlyPlayerLevel } from '../patch_cup_only_player_level.mjs';
import { removeImplicitCommunityLevel } from '../lib/cupLevelCompatibility.mjs';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const fn = (id, func = 'return msg;') => ({ id, type: 'function', z: 'tab', name: id, func, wires: [] });
  return [{ id: 'tab', type: 'tab' }, { id: '4e820638cc39c730', type: 'mongodb4-client' },
    { id: '60fed6840a99b741', type: 'http in', z: 'tab', method: 'post', url: '/lk/games/ratings/live', wires: [] },
    { id: 'ad36d8dd848c89dd', type: 'http in', z: 'tab', method: 'post', url: '/lk/onboarding/level', wires: [] },
    ...['74ae1729191fc747','b2c3d4e5f6011223','d4e5f60112233445','bcff3bb938651dc9','4401a1baa1a06b81', '0dafa71f5e7361d2','fda494e359188dd4','6c5512b06d079e30','321cfd8582108cc7','d0f0fd9ca2dc9f5d','21d3e90986ed5b82','0c63087697cb16c0'].map(id => fn(id)),
    { id: '22d45839d507e03b', type: 'join', z: 'tab', wires: [] },
    { id: 'synthetic-membership', type: 'http in', z: 'tab', method: 'post', url: '/lk/communities/:communityId/members/manage', wires: [['original-membership-handler']] }, fn('original-membership-handler'),
  ];
}
test('offline candidate pins source, preserves original permission handler, rewires canonical reads and adds no provider writes', () => {
  const before = fixture(), bytes = Buffer.from(JSON.stringify(before));
  assert.throws(() => patchCupOnlyPlayerLevel(bytes, 'wrong'), /PREIMAGE/);
  const result = patchCupOnlyPlayerLevel(bytes, hash(bytes)), after = JSON.parse(result.output), byId = new Map(after.map(n => [n.id, n]));
  assert.equal(after.length, new Set(after.map(n => n.id)).size);
  assert.deepEqual(byId.get('original-membership-handler'), before.find(n => n.id === 'original-membership-handler'));
  const membership = byId.get('synthetic-membership'), snapshot = byId.get(membership.wires[0][0]);
  assert.deepEqual(snapshot.wires[0], ['original-membership-handler']);
  assert.deepEqual(byId.get('60fed6840a99b741').wires, [['cup_level_batch']]);
  assert.deepEqual(byId.get('ad36d8dd848c89dd').wires, [['cup_level_initial']]);
  assert.equal(result.report.providerLevelFieldReferences, 0);
  assert.throws(() => patchCupOnlyPlayerLevel(Buffer.from(result.output), hash(result.output)), /FLOW_SHAPE/);
  for (const n of after.filter(n => n.type === 'function')) new Function('msg', 'node', n.func);
});
test('unknown surviving provider field reference blocks candidate instead of hiding an unhandled reader', () => {
  const flow = [...fixture(), { id: 'unmanaged', type: 'function', func: 'const id = "eabfe27b"; return msg;', wires: [] }];
  const bytes = Buffer.from(JSON.stringify(flow)); assert.throws(() => patchCupOnlyPlayerLevel(bytes, hash(bytes)), /PROVIDER_FIELD_REMAINS/);
});
test('an unreviewed FPR readback body or a partial installed branch blocks composition', () => {
  const flow = [...fixture(), {
    id: 'fpr_start_level_readback_prepare_001', type: 'function', z: 'tab',
    func: 'const id = "eabfe27b"; return msg;', wires: [],
  }];
  const bytes = Buffer.from(JSON.stringify(flow));
  assert.throws(() => patchCupOnlyPlayerLevel(bytes, hash(bytes)), /FPR_MIRROR_PREIMAGE/);
});
test('compatibility normalization preserves absence and uses the CUP grade scale', () => {
  const source = `const buildLevelLabel = (score) => { const normalized = Number.isFinite(score) ? score : 3.2;
    if (normalized >= 5.75) return 'A'; if (normalized >= 5.25) return 'B+'; if (normalized >= 4.75) return 'B';
    if (normalized >= 4.25) return 'C+'; if (normalized >= 3.75) return 'C'; if (normalized >= 3.25) return 'D+'; return 'D'; }; return buildLevelLabel;`;
  const grade = new Function(removeImplicitCommunityLevel(source))();
  assert.equal(grade(null), null); assert.equal(grade(0), null); assert.equal(grade(2.1), 'D+'); assert.equal(grade(4.1), 'B'); assert.equal(grade(5.5), 'A');
});

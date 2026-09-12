import assert from 'node:assert/strict';
import test from 'node:test';
import { applySplitReplacements } from '../patch_live_split_nominal_share.mjs';

test('a reviewed replacement is applied exactly once', () => {
  const body = 'const a = 1;\nconst shareAmount = Math.max(0, toNumber(ctx.shareAmount) ?? 0);\nconst b = 2;\n';
  const next = applySplitReplacements(body, [[
    'const shareAmount = Math.max(0, toNumber(ctx.shareAmount) ?? 0);',
    'const shareAmount = null;',
  ]]);
  assert.match(next, /const shareAmount = null;/);
  assert.doesNotMatch(next, /toNumber\(ctx\.shareAmount\)/);
});

test('an anchor that cannot be found fails closed', () => {
  assert.throws(
    () => applySplitReplacements('const a = 1;\n', [['missing anchor', 'replacement']]),
    /matched 0 times/,
  );
});

test('a drifted duplicate anchor fails closed instead of patching ambiguity', () => {
  const body = 'target\nmiddle\ntarget\n';
  assert.throws(() => applySplitReplacements(body, [['target', 'patched']]), /matched 2 times/);
});

test('a replacement that changes nothing is rejected', () => {
  assert.throws(() => applySplitReplacements('same text\n', [['same', 'same']]), /no change/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformPreviewPayments } from './previewTransform.ts';

for (const [path, count] of [['games/GamesPage.tsx', 2], ['group-schedule/GroupSchedulePage.tsx', 1], ['tournament-signup/TournamentSignupPage.tsx', 1]] as const) {
  test(`preview replaces only the checkout regions in ${path}`, () => {
    const original = readFileSync(new URL(`../../src/components/${path}`, import.meta.url), 'utf8');
    const transformed = transformPreviewPayments(original, path.split('/').pop()!);
    assert.equal(transformed?.match(/<MatrixPaymentOptions\b/g)?.length, count);
    assert.ok(transformed?.includes('import { MatrixPaymentOptions }'));
    assert.equal(readFileSync(new URL(`../../src/components/${path}`, import.meta.url), 'utf8'), original);
  });
}
test('source drift fails the preview build instead of silently mixing two payment interfaces', () => {
  assert.throws(() => transformPreviewPayments('<div />', 'GamesPage.tsx'), /checkout regions changed/);
  assert.equal(transformPreviewPayments('<div />', 'Unrelated.tsx'), null);
});

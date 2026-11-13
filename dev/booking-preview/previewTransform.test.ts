import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformPreviewFriendlyLabel, transformPreviewPayments } from './previewTransform.ts';

for (const [path, count] of [['games/GamesPage.tsx', 2], ['group-schedule/GroupSchedulePage.tsx', 1], ['tournament-signup/TournamentSignupPage.tsx', 1]] as const) {
  test(`preview replaces only the checkout regions in ${path}`, () => {
    const original = readFileSync(new URL(`../../src/components/${path}`, import.meta.url), 'utf8');
    const transformed = transformPreviewPayments(original, path.split('/').pop()!);
    assert.equal(transformed?.match(/<MatrixPaymentOptions\b/g)?.length, count);
    assert.ok(transformed?.includes('import { MatrixPaymentOptions }'));
    if (path === 'games/GamesPage.tsx') {
      assert.equal(transformed?.match(/<GamePayerChoice\b/g)?.length, 1);
      assert.ok(transformed?.includes('gamePaymentScope={paymentMode === "split" ? "quarter" : "court"}'));
      assert.ok(!transformed?.includes('game-create-payment-method-card'), 'The legacy split checkout must not render beside the new one');
      assert.ok(!transformed?.includes('На следующем шаге выберите способ записи'));
      assert.ok(transformed?.includes('date: dateLabel, time: publicCreateSummaryTimeLabel'));
      assert.ok(transformed?.includes('[studio?.name, studio?.address, selectedCourt?.name]'));
      assert.ok(transformed?.includes('station: studio?.name'));
      assert.ok(transformed?.includes('station: detailsStudioName'));
      assert.ok(transformed?.includes('date: detailsDateLabel, time: [detailsTimeFrom, detailsTimeTo]'));
    } else if (path === 'group-schedule/GroupSchedulePage.tsx') {
      assert.ok(transformed?.includes('date: selectedTraining.date, time: selectedTraining.timeLabel'));
      assert.ok(transformed?.includes('selectedTraining.roomName'));
      assert.ok(transformed?.includes('station: selectedTraining.studioName'));
    } else {
      assert.ok(transformed?.includes('date: selectedTournament?.date, time: detailTimeLabel'));
      assert.ok(transformed?.includes('[detailStationLabel, selectedTournament?.address]'));
      assert.ok(transformed?.includes('station: detailStationLabel'));
    }
    assert.equal(readFileSync(new URL(`../../src/components/${path}`, import.meta.url), 'utf8'), original);
  });
}
test('source drift fails the preview build instead of silently mixing two payment interfaces', () => {
  assert.throws(() => transformPreviewPayments('<div />', 'GamesPage.tsx'), /checkout regions changed/);
  assert.equal(transformPreviewPayments('<div />', 'Unrelated.tsx'), null);
});

test('preview changes only the friendly badge label, preserving source and navigation', () => {
  const path = new URL('../../src/components/games/FindGamePage.tsx', import.meta.url);
  const original = readFileSync(path, 'utf8');
  const result = transformPreviewFriendlyLabel(original, 'FindGamePage.tsx');
  assert.equal(result, original.replace('const FRIENDLY_TAG_LABEL = "Лето.Падел";', 'const FRIENDLY_TAG_LABEL = "РА";'));
  assert.equal(transformPreviewFriendlyLabel(result, 'FindGamePage.tsx'), result);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(transformPreviewFriendlyLabel(original, 'Unrelated.tsx'), original);
});

test('friendly label drift stops the preview build', () => {
  for (const source of ['const label = "Лето.Падел";', 'const FRIENDLY_TAG_LABEL = "Другой продукт";', 'const FRIENDLY_TAG_LABEL = computeLabel();']) {
    assert.throws(() => transformPreviewFriendlyLabel(source, 'FindGamePage.tsx'), /friendly label changed/);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { previewScreenForUrl } from './previewNavigation.ts';
import { transformPreviewNavigation } from './previewTransform.ts';

test('production invitation and cabinet URLs resolve only to fixture screens', () => {
  for (const [path, screen] of [['/game_join?joinGame=demo', 'game-join'], ['/game_create', 'game-booking'], ['/group', 'training-join'], ['/tournament-signup', 'tournament-join'], ['/lk_new', 'game-list']]) {
    assert.equal(previewScreenForUrl(`https://padlhub.su${path}`, 'matrix'), screen);
  }
  assert.equal(previewScreenForUrl('https://payments.example/checkout', 'matrix'), 'matrix');
});

test('preview rewrites imperative navigation, preserving location reads and the source files', () => {
  const source = 'const value = window.location.href; window.location.href = buildJoinUrl(game); window.location.assign(target); window.open(target, "_blank"); window.top.location.href = target;';
  const result = transformPreviewNavigation(source, 'Example.tsx');
  assert.ok(result.includes('const value = window.location.href;'));
  assert.ok(result.includes('navigatePreview(buildJoinUrl(game))'));
  assert.equal(result.match(/navigatePreview\(target\)/g)?.length, 3);
  assert.ok(!result.includes('window.open('));
  for (const path of ['games/FindGamePage.tsx', 'games/GamesPage.tsx']) {
    const file = new URL(`../../src/components/${path}`, import.meta.url);
    const original = readFileSync(file, 'utf8');
    const transformed = transformPreviewNavigation(original, path);
    assert.ok(!/window(?:\.top)?\.location\.href\s*=|window\.open\(/.test(transformed));
    assert.equal(readFileSync(file, 'utf8'), original);
  }
});

test('navigation retains event identity, selected date and profile, excluding arbitrary URL data', async () => {
  const { previewNavigationUrl } = await import('./previewNavigation.ts');
  const base = 'https://padlhub.su/lk/booking-preview/version/dev/booking-preview/frame.html?screen=game-list&skin=lk2&stage=current&pass=1';
  const next = new URL(previewNavigationUrl('/group?exerciseId=demo-training-2&date=2026-11-15&token=private', base)!);
  assert.equal(next.pathname, new URL(base).pathname);
  assert.equal(next.searchParams.get('eventId'), 'demo-training-2');
  assert.equal(next.searchParams.get('date'), '2026-11-15');
  assert.equal(next.searchParams.get('screen'), 'training-join');
  assert.equal(next.searchParams.get('pass'), '1');
  assert.equal(next.searchParams.get('token'), null);
  assert.equal(previewNavigationUrl('https://payments.example/pay?token=private', base), null);
  const game = new URL(previewNavigationUrl('/game_join?joinGame=demo-game&date=2026-11-15', base)!);
  assert.equal(game.searchParams.get('eventId'), 'demo-game');
  assert.equal(game.searchParams.get('date'), '2026-11-15');
});

test('no places and empty detail return to the appropriate schedule, keeping the scenario profile', async () => {
  const { previewScheduleUrl } = await import('./previewNavigation.ts');
  for (const [screen, expected] of [['training-join', 'training-booking'], ['tournament-join', 'tournament-booking'], ['game-join', 'game-list']]) {
    const target = new URL(previewScheduleUrl(`https://preview.test/frame.html?screen=${screen}&state=empty&eventId=demo-game&date=2026-11-17&subscription=1`));
    assert.equal(target.searchParams.get('screen'), expected);
    assert.equal(target.searchParams.get('state'), 'ready');
    assert.equal(target.searchParams.get('eventId'), null);
    assert.equal(target.searchParams.get('subscription'), '1');
    assert.equal(target.searchParams.get('date'), '2026-11-17');
    if (expected === 'game-list') assert.equal(target.searchParams.get('atlasDate'), '2026-11-17');
  }
});

test('shared scenarios preserve actual event and search filters without copying credentials', async () => {
  const { copyPreviewRoute } = await import('./previewNavigation.ts');
  const shared = copyPreviewRoute(new URLSearchParams('screen=game-list&state=ready&stage=current&subscription=1'), new URLSearchParams('screen=game-list&atlasDate=2026-11-17&atlasSearch=тест&atlasStation=demo-seliger&atlasCategory=open&token=private&access_token=secret'));
  assert.equal(shared.get('atlasDate'), '2026-11-17');
  assert.equal(shared.get('atlasStation'), 'demo-seliger');
  assert.equal(shared.get('atlasSearch'), 'тест');
  assert.equal(shared.get('stage'), 'current');
  assert.equal(shared.get('subscription'), '1');
  assert.equal(shared.has('token'), false);
  assert.equal(shared.has('access_token'), false);
});

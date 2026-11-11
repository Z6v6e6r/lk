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

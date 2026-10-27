import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

test('ordinary cabinet cannot statically reach game code or artwork', async () => {
  const source = readFileSync('src/MyApp.tsx', 'utf8');
  assert.doesNotMatch(source, /import\s+(?:PadelJump|RaceEntry)\s+from/);
  const result = await build({ entryPoints: ['src/main.tsx'], outfile: 'cabinet-fixture.js', bundle: true, write: false, metafile: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }), __PADLHUB_JUMP_WIDGET_URL__: JSON.stringify('https://padlhub.su/lk/padel-jump-team-fixture/assets/cabinet.js') }, loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl' }, logLevel: 'silent' });
  const paths = Object.keys(result.metafile.inputs);
  assert.deepEqual(paths.filter(path => /components\/padel-jump\/(?:RaceEntry|RaceJump|PadelJump|render|engine|yasenevo-assets)\./.test(path)), []);
  assert.deepEqual(paths.filter(path => /assets\/(?:station-actors|station-backgrounds|yasenevo-v2)\//.test(path)), []);
});

test('game build publishes an explicit independently loadable cabinet module', () => {
  const config = readFileSync('games/padel-jump/vite.config.ts', 'utf8');
  assert.match(config, /cabinet:\s*'src\/padel-jump-widget\.tsx'/);
  assert.match(config, /preserveEntrySignatures:\s*'strict'/);
});

test('unrelated cabinet commits cannot select an unpublished game module', () => {
  const config = readFileSync('vite.config.ts', 'utf8');
  assert.match(config, /const gameSource = '109e43d49f35e7e705d9117fee308bf49c722572'/);
  assert.doesNotMatch(config, /execFileSync\('git'/);
});

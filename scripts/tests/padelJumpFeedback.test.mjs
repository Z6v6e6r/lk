import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({ stdin: { contents: `export * from './src/components/padel-jump/RaceJump'; export { default as RaceJump } from './src/components/padel-jump/RaceJump'; export { default as RaceAdmission } from './src/components/padel-jump/RaceAdmission';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl', '.webp': 'dataurl' }, logLevel: 'silent' });
const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const source = readFileSync('src/components/padel-jump/RaceJump.tsx', 'utf8');

test('HUD renders five balls, with only remaining lives yellow and spent lives grey', () => {
  assert.ok(source.includes('pj-race-life'));
  for (const remaining of [5, 4, 1, 0]) {
    const html = renderToStaticMarkup(React.createElement(module.exports.RaceLives, { remaining }));
    assert.equal((html.match(/class="pj-race-life(?: is-spent)?"/g) || []).length, 5);
    assert.equal((html.match(/is-spent/g) || []).length, 5 - remaining);
    assert.ok(html.includes(`aria-label="Осталось жизней: ${remaining} из 5"`));
    assert.ok(!html.includes('♥'));
  }
  const css = readFileSync('src/components/padel-jump/live.css', 'utf8');
  assert.match(css, /\.pj-race-hud small\{display:inline/);
  assert.match(css, /\.pj-race-life\.is-spent\{[^}]*background:#/);
});

test('race has no lower control row, retaining touch fallback on the play field', () => {
  assert.ok(!source.includes('<footer>'));
  assert.match(source, /<canvas[^>]*onPointerDown=/s);
  for (const name of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture']) assert.ok(source.includes(name));
  assert.ok(source.includes('ArrowLeft') && source.includes('ArrowRight') && source.includes('tilt.direction()'));
});

test('entry uses requested copy and explains phone tilt before starting', () => {
  const previous = globalThis.window;
  try {
    globalThis.window = { isSecureContext: true };
    const html = renderToStaticMarkup(React.createElement(module.exports.RaceJump));
    assert.ok(html.includes('На каждую попытку у тебя всего 5 жизней. Чем больше звезд ты наберешь, тем выше твой рейтинг в сообществе. Если количество звезд равное, выше тот, кто потратил меньше времени.'));
    assert.ok(html.includes('Игра на ретинг'));
    assert.ok(html.includes('Управляй мячом наклоном телефона влево и вправо.'));
    assert.ok(html.indexOf('Управляй мячом') < html.indexOf('Игра на ретинг'));
    const admission = renderToStaticMarkup(React.createElement(module.exports.RaceAdmission, { onChangeProfile() {} }));
    assert.ok(admission.includes('ПадлхАБ Jump - займи свое место в рейтинге'));
    assert.match(source, /view\.mode === 'paused'[^\n]*pj-race-control-hint/);
  } finally {
    if (previous === undefined) delete globalThis.window; else globalThis.window = previous;
  }
});

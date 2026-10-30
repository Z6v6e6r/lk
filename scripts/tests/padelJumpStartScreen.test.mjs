import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function startScreen() {
  const result = await build({ entryPoints: ['src/components/padel-jump/RaceStart.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty', '.svg': 'dataurl' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return props => renderToStaticMarkup(React.createElement(module.exports.RaceStart, { checking: false, pending: false, onBegin() {}, onRetryProfile() {}, onChangeProfile() {}, ...props }));
}

test('start screen keeps real profile, accessible lives, both destinations and per-mode notes', async () => {
  const render = await startScreen();
  const html = render({ profile: { name: 'Мария Тестовая', communityId: 'fixture-community' } });
  assert.match(html, /jump-avatar[^>]*>МТ</);
  assert.match(html, /Мария Тестовая/);
  assert.doesNotMatch(html, /Alexey Sergeev|стрелк|клавиатур|половин/);
  assert.equal((html.match(/class="jump-ball"/g) || []).length, 5);
  assert.match(html, /class="jump-balls" aria-hidden="true"/);
  assert.equal((html.match(/Управляй мячом наклоном телефона/g) || []).length, 1);
  assert.match(html, /Твоё имя, игра и результат будут видны на общем экране\./);
  assert.match(html, /Личный прогресс сохраняется отдельно\./);
  assert.match(html, /href="\.\/padel-jump\.html"/);
  assert.match(html, /href="\.\/padel-jump-live\.html"/);
  assert.match(html, /aria-label="Выйти из профиля"/);
  for (const [, id] of html.matchAll(/aria-describedby="([^"]+)"/g)) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /<details class="jump-rules">/);
  assert.match(html, /При равном числе звёзд/);
});

test('pending and unconfirmed profiles cannot start ranked play or show demo identity', async () => {
  const render = await startScreen();
  for (const props of [{ profile: null, checking: true }, { profile: null }, { profile: { name: 'Игрок', communityId: 'fixture-community' }, pending: true }]) {
    const html = render(props);
    assert.match(html, /class="jump-button jump-button--primary"[^>]*disabled=""/);
    assert.doesNotMatch(html, /Alexey Sergeev/);
  }
});

test('direct cabinet module installs all screen CSS inside its owned mount generation', async () => {
  const result = await build({ entryPoints: ['src/padel-jump-widget.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], plugins: [{ name: 'isolated-mount', setup(builder) {
    builder.onResolve({ filter: /react-dom\/client/ }, () => ({ path: 'root', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function createRoot(){return {render(){},unmount(){}}}' }));
    builder.onResolve({ filter: /components\/padel-jump\/(RaceEntry|PadelJump)$/ }, args => ({ path: args.path, namespace: 'screen' }));
    builder.onLoad({ filter: /.*/, namespace: 'screen' }, () => ({ contents: 'export default function Screen(){return null}' }));
    builder.onResolve({ filter: /\.css\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?inline', '')), namespace: 'styles' }));
    builder.onLoad({ filter: /.*/, namespace: 'styles' }, args => ({ contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}` }));
  } }], logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  const element = tag => ({ tag, children: [], append(...items) { this.children.push(...items); }, remove() { this.removed = true; } });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: element };
  try {
    const target = element('target');
    module.exports.mount(target, 'race');
    const first = target.children[0], css = first.children[0].textContent;
    for (const file of ['live.css', 'padel-jump.css', 'jump-start.css']) assert.ok(css.includes(readFileSync(`src/components/padel-jump/${file}`, 'utf8')), `${file} must accompany direct JS mount`);
    assert.match(css, /background: #f8d52c/);
    module.exports.mount(target, 'practice');
    await new Promise(queueMicrotask);
    assert.equal(first.removed, true);
    assert.notEqual(target.children[1].removed, true);
    module.exports.unmount(target);
    await new Promise(queueMicrotask);
    assert.equal(target.children[1].removed, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

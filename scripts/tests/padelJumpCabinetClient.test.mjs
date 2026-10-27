import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
const compiled = await build({ entryPoints: ['src/components/padel-jump/live-client.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, logLevel: 'silent' });
const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);

test('cabinet race reads its existing origin session and calls only fixed game API, not an auth exchange', async () => {
  const priorWindow = globalThis.window, priorDocument = globalThis.document, priorFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.window = { location: { origin: 'https://padlhub.ru' }, localStorage: { getItem: () => null } };
    globalThis.document = { cookie: 'padlhubAuthToken=fixture-access' };
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'fixture-member', name: 'Игрок', communityId: 'fixture-community' })); };
    await module.exports.raceProfile(new AbortController().signal);
    await module.exports.entryRequest('entry', new AbortController().signal);
    await module.exports.liveRequest('runs', { consent: true }, new AbortController().signal);
    assert.deepEqual(calls.map(x => x.url), ['me', 'entry', 'runs'].map(path => 'https://padlhub.su/jump-live-api/' + path));
    for (const { url, init } of calls) {
      assert.equal(init.headers.Authorization, 'Bearer fixture-access');
      assert.equal(init.credentials, 'omit');
      assert.ok(!url.includes('fixture-access'));
    }
    globalThis.window.location.origin = 'https://padlhub.su'; calls.length = 0;
    await module.exports.raceProfile(new AbortController().signal);
    assert.equal(calls[0].url, '/jump-live-api/me');
  } finally {
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
    globalThis.fetch = priorFetch;
  }
});

test('cabinet race route loads the authenticated entry module before ordinary app lifecycle', () => {
  const source = readFileSync('src/MyApp.tsx', 'utf8');
  assert.match(source, /get\("padelJumpRace"\) === "1"/);
  const route = source.indexOf('return <PadelJumpHost mode="race"');
  assert.ok(route >= 0 && route < source.lastIndexOf('return (\n    <AuthProvider'));
  assert.match(readFileSync('src/padel-jump-widget.tsx', 'utf8'), /mode === 'race' \? <RaceEntry/);
});

test('cabinet game actions do not navigate to absent standalone HTML on the cabinet host', () => {
  for (const file of ['RaceJump.tsx', 'RaceEntry.tsx']) {
    const source = readFileSync('src/components/padel-jump/' + file, 'utf8');
    assert.ok(!source.includes('href="./padel-jump'));
  }
});

test('actual race entry reuses cabinet session and isolates pending callbacks', async () => {
  const result = await build({ entryPoints: ['src/components/padel-jump/RaceEntry.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl', '.webp': 'dataurl' }, logLevel: 'silent' });
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const priorWindow = globalThis.window, priorDocument = globalThis.document;
  try {
    for (const [stored, callback] of [[true, false], [false, false], [true, true]]) {
      const url = new URL('https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1' + (callback ? '&code=fixture-code&state=fixture-state' : ''));
      globalThis.window = { location: { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: '' }, localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null } };
      const token = ['fixture', Buffer.from(JSON.stringify({ phone_number: 'fixture-phone', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'fixture'].join('.');
      globalThis.document = { cookie: stored ? 'padlhubAuthToken=' + token : '' };
      const compiled = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, compiled, compiled.exports);
      const html = renderToStaticMarkup(React.createElement(compiled.exports.default));
      if (callback) { assert.ok(html.includes('Восстанавливаем вход')); assert.ok(!html.includes('pj-admission')); }
      else if (stored) { assert.ok(html.includes('pj-admission')); assert.ok(!html.includes('Войди через Яндекс')); }
      else { assert.ok(html.includes('Войди через Яндекс')); assert.ok(!html.includes('pj-admission')); }
    }
  } finally {
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
    if (priorDocument === undefined) delete globalThis.document; else globalThis.document = priorDocument;
  }
});

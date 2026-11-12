import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const EXHIBITION_COMMUNITY_ID = 'community_1794221739126_корпспорт-падлхаб-2026';

async function panelRenderer() {
  const result = await build({ entryPoints: ['src/components/cabinet/EventCommunityPanel.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return props => renderToStaticMarkup(React.createElement(module.exports.EventCommunityPanel, { community: { id: EXHIBITION_COMMUNITY_ID, name: 'КорпСпорт ПадлхАБ 2026' }, onRegister() {}, ...props }));
}

test('non-members see the questionnaire and game actions', async () => {
  const render = await panelRenderer();
  const html = render({ isMember: false });
  assert.match(html, /ПадлхАБ Jump — 5 жизней/);
  assert.match(html, /Заполнить анкету/);
  assert.match(html, /Играть в Jump/);
  assert.ok(!html.includes('Включить уведомления'));
  const otherCommunity = render({ isMember: false, community: { id: 'another-community' } });
  assert.equal(otherCommunity, '');
});

test('members get a bell button that hands off to LK2 with the KorpSport source marker', async () => {
  const render = await panelRenderer();
  const html = render({ isMember: true });
  assert.match(html, /Уведомления о результатах/);
  assert.match(html, /Включить уведомления/);
  assert.match(html, /community-event-push__button/);
  assert.match(html, /href="https:\/\/lk2\.padlhub\.su\/push\?/);
  assert.ok(html.includes('source=korp-sport-2026'));
  assert.ok(html.includes('community=community_1794221739126_'));
  assert.ok(!html.includes('Заполнить анкету'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const EXHIBITION_COMMUNITY_ID = 'community_1794221739126_корпспорт-падлхаб-2026';

async function headerRenderer() {
  const result = await build({ entryPoints: ['src/components/cabinet/community-feed/CommunityHeader.tsx'], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return community => renderToStaticMarkup(React.createElement(module.exports.CommunityHeader, { community, onOpenMenu() {}, onClose() {} }));
}

test('the exhibition community header uses the emblem instead of initials', async () => {
  const render = await headerRenderer();
  const html = render({ id: EXHIBITION_COMMUNITY_ID, name: 'КорпСпорт ПадлхАБ 2026', logo: null, logoUrl: null, memberCount: 4 });
  assert.match(html, /community-header-avatar-image/);
  assert.ok(html.includes('src="data:image/png;base64,iVBORw0KGgo'));
  assert.ok(!html.includes('community-header-avatar-fallback'));
  const other = render({ id: 'another-community', name: 'Другое сообщество', logo: null, logoUrl: null, memberCount: 1 });
  assert.match(other, /community-header-avatar-fallback/);
});

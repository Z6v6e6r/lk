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
  return props => renderToStaticMarkup(React.createElement(module.exports.EventCommunityPanel, { community: { id: EXHIBITION_COMMUNITY_ID }, onRegister() {}, ...props }));
}

test('exhibition panel is only a pre-membership call to action', async () => {
  const render = await panelRenderer();
  const member = render({ isMember: true });
  assert.equal(member, '', 'an active community member must not see the join/questionnaire block');
  const nonMember = render({ isMember: false });
  assert.match(nonMember, /ПадлхАБ Jump — 5 жизней/);
  assert.match(nonMember, /Заполнить анкету/);
  assert.match(nonMember, /Играть в Jump/);
  const otherCommunity = render({ isMember: false, community: { id: 'another-community' } });
  assert.equal(otherCommunity, '');
});

test('a member who declined notifications sees a reconnect prompt on every entry', async () => {
  const render = await panelRenderer();
  const previous = globalThis.localStorage;
  const values = new Map([['padlhub_exhibition_push_opt_in_v1', '0']]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), clear: () => values.clear(), key: () => null, length: values.size };
  try {
    const declined = render({ isMember: true });
    assert.match(declined, /Уведомления о результатах/);
    assert.match(declined, /Подключить уведомления/);
    values.set('padlhub_exhibition_push_opt_in_v1', '1');
    assert.equal(render({ isMember: true }), '', 'a member who opted in must not see the reconnect prompt');
  } finally {
    if (previous === undefined) delete globalThis.localStorage; else globalThis.localStorage = previous;
  }
});

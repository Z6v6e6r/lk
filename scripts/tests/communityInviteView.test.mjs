import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({ stdin: { contents: "export { default as Page } from './src/components/communities/CommunityJoinPage'; export * from './src/components/communities/CommunityInviteView';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl' }, logLevel: 'silent' });
const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
test('invitation checking state uses the scoped archive card and original brand without invite disclosure', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.Page, { inviteCode: 'never-display-this-invite' }));
  assert.match(html, /class="ph-community-invite"/);
  assert.match(html, /alt="ПадлхАБ"/);
  assert.match(html, /role="status"/);
  assert.ok(!html.includes('never-display-this-invite'));
  assert.ok(!html.includes('Отказаться'));
});

test('participant counts use server values with all requested Russian plural forms', () => {
  const cases = [[0,'0 участников'],[1,'1 участник'],[2,'2 участника'],[5,'5 участников'],[11,'11 участников'],[21,'21 участник'],[22,'22 участника'],[111,'111 участников']];
  for (const [count, expected] of cases) assert.equal(module.exports.formatCommunityParticipants(count), expected);
  for (const value of [undefined, -1, NaN, 1.5]) assert.equal(module.exports.formatCommunityParticipants(value), '');
});

test('member and invitation render distinct actions, server metadata and no service token', () => {
  const community = { id:'fixture-community', name:'Тестовое сообщество', city:'Тестовый город', visibility:'OPEN', memberCount:21, minimumLevel:'D', description:'Описание владельца', inviteCode:'never-display-this-invite' };
  const render = state => renderToStaticMarkup(React.createElement(module.exports.CommunityInviteView, { state, community, onPrimary() {}, onSecondary() {} }));
  const member = render('member');
  for (const text of ['Вы уже в сообществе', 'Открыть сообщество', 'В личный кабинет', '21 участник', 'Тестовый город', 'Описание владельца']) assert.ok(member.includes(text));
  for (const text of ['Отказаться','Вступить в сообщество','never-display-this-invite']) assert.ok(!member.includes(text));
  assert.match(member, /<h1[^>]*>Тестовое сообщество<\/h1>/);
  const invited = render('invited');assert.ok(invited.includes('Вступить в сообщество'));assert.ok(invited.includes('Не сейчас'));
  const unverified = render('unverified');assert.ok(unverified.includes('Условия вступления проверит сервер.'));assert.ok(unverified.includes('Вступить в сообщество'));assert.ok(unverified.includes('Не сейчас'));assert.ok(!unverified.includes('Вы уже в сообществе'));
  const guest = render('guest');assert.ok(guest.includes('Войти и продолжить'));assert.ok(guest.includes('Не сейчас'));
  const blocked = render('blocked');assert.match(blocked, /disabled=""/);assert.ok(blocked.includes('Вступление недоступно'));
});

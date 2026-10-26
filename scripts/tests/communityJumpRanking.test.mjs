import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const require = createRequire(import.meta.url), React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compiled = await build({ stdin: { contents: `export * from './src/components/cabinet/community-feed/communityJumpRanking'; export * from './src/components/cabinet/community-feed/CommunityJumpRankingScreen';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty', '.svg': 'text', '.png': 'dataurl' }, logLevel: 'silent' });
const module = { exports: {} }; new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { JUMP_RANKING_COMMUNITY_ID: communityId, usesJumpRanking, parseCommunityJumpRanking: parse, fetchCommunityJumpRanking: load, formatJumpRankingTime: format, CommunityJumpRankingResults: Results } = module.exports;
const row = (changes = {}) => ({ id: randomUUID(), rank: 1, name: 'Тестовый участник', stars: 6, elapsedMs: 54194, isCurrentUser: true, ...changes });
const data = (changes = {}) => { const me = row(); return { schema: 'jump-community-ranking-v1', communityId, rule: 'five-lives-stars-v2', lives: 5, retentionHours: 48, total: 1, rows: [me], me, ...changes }; };

test('only exact owner-selected community uses Jump, preserving installed provider paths; sport API is skipped', async () => {
  for (const id of [undefined, null, '', communityId + '-other', 'other-community']) {
    assert.equal(usesJumpRanking(id), false);
    await assert.rejects(load(id, new AbortController().signal, { token: 'fixture', fetcher: () => { throw new Error('must not fetch'); } }), /не подключён/);
  }
  assert.equal(usesJumpRanking(communityId), true);
  const source = readFileSync('src/components/cabinet/CommunitiesSection.tsx', 'utf8');
  assert.match(source, /if \(usesJumpRanking\(selectedCommunity\.id\)\) \{\s*return;/);
  assert.match(source, /activeCommunityTab === "RANKING" && !usesJumpRanking\(selectedCommunity\.id\) && \(/);
  assert.match(source, /key=\{`\$\{selectedCommunity\.id\}:\$\{profileId \?\? ''\}`\}/);
});

test('client GET keeps token out of URL, omits cookies and forwards cancellation; errors never become zero scores', async () => {
  const controller = new AbortController(); let requested;
  const result = await load(communityId, controller.signal, { token: 'fixture-secret', fetcher: async (url, init) => {
    requested = { url, init }; return new Response(JSON.stringify(data()));
  } });
  const url = new URL(requested.url);
  assert.equal(url.origin, 'https://padlhub.su'); assert.equal(url.pathname, '/jump-live-api/community-ranking');
  assert.deepEqual([...url.searchParams], [['communityId', communityId]]);
  assert.ok(!requested.url.includes('fixture-secret')); assert.equal(requested.init.credentials, 'omit');
  assert.equal(requested.init.headers.Authorization, 'Bearer fixture-secret'); assert.equal(requested.init.cache, 'no-store');
  assert.equal(result.me.stars, 6);
  for (const status of [401, 403, 503]) await assert.rejects(load(communityId, controller.signal, { token: 'fixture', fetcher: async () => new Response('private-upstream-value', { status }) }), error => error.status === status && !error.message.includes('private-upstream-value'));
  await assert.rejects(load(communityId, controller.signal, { token: '', fetcher: () => { throw new Error('must not fetch'); } }), error => error.status === 401);
  const pending = load(communityId, controller.signal, { token: 'fixture', fetcher: async (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

test('parser accepts Unicode names and strips unexpected fields, rejects foreign scope, malformed scores and conflicting own identity', () => {
  const unicode = row({ name: '🎾'.repeat(48) });
  const parsed = parse(JSON.stringify(data({ rows: [{ ...unicode, actorId: 'private' }], me: unicode, token: 'private' })), communityId);
  assert.equal([...parsed.me.name].length, 48); assert.ok(!JSON.stringify(parsed).includes('private'));
  for (const change of [{ communityId: 'other' }, { total: 1, rows: [] }, { rows: [row({ stars: -1 })] }, { rows: [row({ elapsedMs: null })] }, { rows: [row({ name: '<script>' })] }, { me: row() }, { me: null }]) assert.throws(() => parse(JSON.stringify(data(change)), communityId));
  for (const raw of ['null', '{}', '[]', 'bad-json', ' '.repeat(262145)]) assert.throws(() => parse(raw, communityId));
  const first = row({ stars: 3, rank: 1, isCurrentUser: false }), second = row({ stars: 4, rank: 2 });
  assert.throws(() => parse(JSON.stringify(data({ total: 2, rows: [first, second], me: second })), communityId), /порядок/);
});

test('actual result renders stars and precise time, self marker is server-owned even for identical names; search and no-attempt state work', () => {
  const other = row({ rank: 1, stars: 7, isCurrentUser: false }), own = row({ rank: 2 });
  const fixture = data({ total: 2, rows: [other, own], me: own });
  const html = renderToStaticMarkup(React.createElement(Results, { data: fixture, currentUserAvatar: '/fixture-own-avatar.png' }));
  assert.match(html, /★ 6/); assert.match(html, /00:54\.1/);
  assert.equal((html.match(/Моя позиция/g) || []).length, 1); assert.equal((html.match(/is-current/g) || []).length, 1);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.equal(format(60000), '01:00.0'); assert.equal(format(54194), '00:54.1');
  const missing = renderToStaticMarkup(React.createElement(Results, { data: fixture, search: 'нет такого' }));
  assert.match(missing, /не найден/); assert.ok(!missing.includes('★ 6'));
  const empty = renderToStaticMarkup(React.createElement(Results, { data: data({ total: 0, rows: [], me: null }) }));
  assert.match(empty, /Заездов пока нет/); assert.ok(!empty.includes('★ 0'));
  const unplayed = renderToStaticMarkup(React.createElement(Results, { data: data({ rows: [other], me: null }) }));
  assert.match(unplayed, /ещё нет завершённого заезда/);
});

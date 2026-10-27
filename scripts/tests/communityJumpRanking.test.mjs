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

test('only exact owner-selected community uses Jump on the installed baseline; sport API is skipped', async () => {
  for (const id of [undefined, null, '', communityId + '-other', 'other-community']) {
    assert.equal(usesJumpRanking(id), false);
    await assert.rejects(load(id, new AbortController().signal, { token: 'fixture', fetcher: () => { throw new Error('must not fetch'); } }), /не подключён/);
  }
  assert.equal(usesJumpRanking(communityId), true);
  const source = readFileSync('src/components/cabinet/CommunitiesSection.tsx', 'utf8');
  assert.match(source, /if \(usesJumpRanking\(selectedCommunity\.id\)\) \{\s*return;/);

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
  assert.equal(requested.init.headers.Authorization, 'Bearer fixture-secret'); assert.equal(requested.init.headers.Accept, 'application/vnd.padlhub.jump-community-ranking.v2+json'); assert.equal(requested.init.cache, 'no-store');
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

test('ranking screen uses the requested title and rule without the redundant run note', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.CommunityJumpRankingScreen, {
    community: { id: communityId, name: 'Тестовое сообщество', memberCount: 0 },
    profileKey: 'synthetic-profile', chatBadgeCount: 0,
    onOpenMenu() {}, onClose() {}, onSelectSectionNav() {}, onSelectBottomNav() {},
  }));
  assert.match(html, /<h3>Рейтинг ПадлхАБ Jump<\/h3>/);
  assert.match(html, /aria-label="Рейтинг ПадлхАБ Jump"/);
  assert.ok(html.includes('Чем больше звезд, тем выше место. Если звезд одинаково, то выше тот у кого ниже время.'));
  assert.ok(!html.includes('Лучший заезд каждого участника'));
  assert.ok(!html.includes('Больше звёзд — выше.'));
  const source = readFileSync('src/components/cabinet/community-feed/CommunityJumpRankingScreen.tsx', 'utf8');
  assert.ok(!source.includes('Лучший заезд каждого участника'));
});

test('permanent v2 accepts profiles beyond old capacity and nullable retention; legacy v1 stays explicitly windowed', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => row({ rank: index + 1, stars: 1000 - index, isCurrentUser: false }));
  const me = row({ rank: 601, stars: 1 });
  const allTime = data({ schema: 'jump-community-ranking-v2', retentionHours: null, total: 601, rows, me });
  const parsed = parse(JSON.stringify(allTime), communityId);
  assert.equal(parsed.total, 601); assert.equal(parsed.me.rank, 601); assert.equal(parsed.retentionHours, null);
  const loaded = await load(communityId, new AbortController().signal, { token: 'fixture', fetcher: async (_, init) => {
    assert.equal(init.headers.Accept, 'application/vnd.padlhub.jump-community-ranking.v2+json');
    return new Response(JSON.stringify(allTime));
  } });
  assert.equal(loaded.schema, 'jump-community-ranking-v2');
  const html = renderToStaticMarkup(React.createElement(Results, { data: loaded }));
  assert.match(html, /Моя позиция/); assert.match(html, /Место 601/);
  for (const change of [{ schema: 'jump-community-ranking-v1' }, { retentionHours: 48 }, { retentionHours: 0 }, { total: Number.MAX_SAFE_INTEGER + 1 }]) assert.throws(() => parse(JSON.stringify({ ...allTime, ...change }), communityId));
  assert.throws(() => parse(JSON.stringify(data({ retentionHours: null })), communityId));
  assert.equal(parse(JSON.stringify(data()), communityId).retentionHours, 48);
});

test('play link stays on the cabinet origin and contains no session material', () => {
  const url = new URL(module.exports.JUMP_GAME_URL);
  assert.equal(url.origin, 'https://padlhub.ru');
  assert.equal(url.pathname, '/lk_new');
  assert.deepEqual([...url.searchParams], [['authMode', 'viva'], ['padelJumpRace', '1']]);
  assert.equal(url.hash, '');
});

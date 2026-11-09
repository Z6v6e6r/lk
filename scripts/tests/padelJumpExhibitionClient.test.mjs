import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
async function load(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, format: 'cjs', platform: 'node', define: { 'import.meta.env': JSON.stringify({ MODE: 'production' }) }, logLevel: 'silent' });
  const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports); return module.exports;
}
test('exhibition client and navigation stay in the fixed separate target without leaking query/session or falling back to team', async () => {
  const client = await load('src/components/padel-jump/live-client.ts'), navigation = await load('src/components/padel-jump/race-navigation.ts');
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const calls = [];
  try {
    globalThis.window = { location: { origin: 'https://padlhub.ru', search: '?padelJumpRace=1&jumpExhibition=1&api=https://evil.invalid&token=private-query' }, localStorage: { getItem: () => null } };
    globalThis.document = { cookie: 'padlhubAuthToken=fixture-access' };
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ id: 'fixture-player', name: 'Verified Profile', communityId: 'fixture-event' })); };
    await client.raceProfile(new AbortController().signal);
    await client.entryRequest('entry', new AbortController().signal);
    await client.liveRequest('runs', { consent: true }, new AbortController().signal);
    assert.deepEqual(calls.map(call => call.url), ['me', 'entry', 'runs'].map(path => 'https://padlhub.su/jump-exhibition-api/' + path));
    assert.equal(navigation.racePageUrl('race'), 'https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1&jumpExhibition=1');
    assert.equal(navigation.racePageUrl('live'), 'https://padlhub.ru/lk_new?authMode=viva&padelJumpLive=1&jumpExhibition=1');
    assert.equal(navigation.racePageUrl('practice'), 'https://padlhub.ru/lk_new?authMode=viva&padelJump=1&jumpExhibition=1');
    globalThis.window.location.search = '';
    globalThis.window.location.pathname = '/lk/padel-jump-exhibition-aaaaaaaa/padel-jump-race.html';
    await client.raceProfile(new AbortController().signal);
    assert.equal(calls.at(-1).url, 'https://padlhub.su/jump-exhibition-api/me', 'Direct exhibition HTML must not silently fall back to the team');
    assert.ok(calls.every(call => call.options.headers.Authorization === 'Bearer fixture-access' && !call.url.includes('fixture-access') && !call.url.includes('evil.invalid')));
  } finally {
    for (const name of ['window', 'document', 'fetch']) { if (previous[name] === undefined) delete globalThis[name]; else globalThis[name] = previous[name]; }
  }
});

test('confirmed exhibition community selects only its own ranking and game while the team keeps its endpoint', async () => {
  const ranking = await load('src/components/cabinet/community-feed/communityJumpRanking.ts');
  const id = 'community_1794221739126_корпспорт-падлхаб-2026';
  assert.equal(ranking.usesJumpRanking(id), true);
  assert.equal(ranking.jumpGameUrl(id), 'https://padlhub.ru/lk_new?authMode=viva&padelJumpRace=1&jumpExhibition=1');
  const calls = [];
  const fetcher = async url => { calls.push(String(url)); return new Response(JSON.stringify({ schema: 'jump-community-ranking-v2', communityId: id, rule: 'fixture-rule', lives: 5, retentionHours: null, total: 0, rows: [], me: null })); };
  await ranking.fetchCommunityJumpRanking(id, new AbortController().signal, { fetcher, token: 'fixture-access' });
  assert.equal(new URL(calls[0]).pathname, '/jump-exhibition-api/community-ranking');
  assert.equal(new URL(calls[0]).searchParams.get('communityId'), id);
  assert.equal(ranking.jumpGameUrl(ranking.JUMP_RANKING_COMMUNITY_ID), ranking.JUMP_GAME_URL);
});

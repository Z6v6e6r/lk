import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';
import { racePageUrl } from '../../src/components/padel-jump/race-navigation.ts';

const origin = 'https://padlhub.ru';
test('cabinet navigation never carries identity and standalone paths remain compatible', () => {
  assert.equal(racePageUrl('race', origin), origin + '/lk_new?authMode=viva&padelJumpRace=1');
  assert.equal(racePageUrl('practice', origin), origin + '/lk_new?authMode=viva&padelJump=1');
  assert.equal(new URL(racePageUrl('live', origin)).origin, 'https://padlhub.su');
  for (const host of ['https://padlhub.su', 'http://127.0.0.1:5192']) {
    assert.equal(racePageUrl('race', host), './padel-jump-race.html');
    assert.equal(racePageUrl('practice', host), './padel-jump.html');
    assert.equal(racePageUrl('live', host), './padel-jump-live.html');
  }
});
test('practice return link uses the origin-aware race destination', () => {
  const source = readFileSync(new URL('../../src/components/padel-jump/PadelJump.tsx', import.meta.url), 'utf8');
  assert.match(source, /import\s*\{\s*racePageUrl\s*\}\s*from\s*['"]\.\/race-navigation['"]/);
  assert.match(source, /href=\{racePageUrl\('race'\)\}/);
  assert.doesNotMatch(source, /href=["']\.\/padel-jump-race\.html["']/);
});
async function harness(t) {
  let verified = 0;
  const actor = { id: 'fixture-member', name: 'Игрок', communityId: 'fixture-community' };
  const authenticate = async req => { verified++; if (req.headers.authorization !== 'Bearer fixture-access') throw Object.assign(new Error('PROFILE_AUTH_REQUIRED'), { code: 401 }); return actor; };
  const server = createLiveServer({ origin: 'https://padlhub.su', communityId: actor.communityId, authenticate, enrollment: { status: async req => ({ state: 'ready', ...await authenticate(req) }), submit: async req => ({ state: 'ready', ...await authenticate(req) }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/jump-live-api/`, verified: () => verified };
}

test('exact cabinet origin can preflight and play using bearer plus own run capability, never cookies', async t => {
  const h = await harness(t);
  const options = await fetch(h.url + 'runs', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(options.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(h.verified(), 0);
  const entry = await fetch(h.url + 'entry', { headers: { Origin: origin, Authorization: 'Bearer fixture-access' } });
  assert.equal(entry.status, 200); assert.equal(entry.headers.get('Access-Control-Allow-Origin'), origin);
  const headers = { Origin: origin, Authorization: 'Bearer fixture-access', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' };
  const joined = await fetch(h.url + 'runs', { method: 'POST', headers, body: JSON.stringify({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }) });
  assert.equal(joined.status, 201); const ticket = await joined.json();
  const paused = await fetch(h.url + 'runs/' + ticket.id, { method: 'POST', headers: { ...headers, 'X-Jump-Run-Token': ticket.token }, body: JSON.stringify({ seq: 1, command: 'pause' }) });
  assert.equal(paused.status, 200); assert.equal((await paused.json()).player.state, 'paused');
});

test('cabinet CORS rejects foreign origins, methods, headers and public stream access', async t => {
  const h = await harness(t);
  for (const source of ['https://evil.invalid', 'https://padlhub.ru.evil.invalid', 'http://padlhub.ru', 'null']) {
    const preflight = await fetch(h.url + 'runs', { method: 'OPTIONS', headers: { Origin: source, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.notEqual(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
    const write = await fetch(h.url + 'runs', { method: 'POST', headers: { Origin: source, Authorization: 'Bearer fixture-access', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(write.status, 403);
  }
  for (const [path, method, headers] of [['runs', 'DELETE', 'authorization'], ['entry', 'POST', 'authorization'], ['runs', 'POST', 'cookie'], ['runs', 'POST', 'x-jump-run-token']]) {
    const response = await fetch(h.url + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': headers } });
    assert.equal(response.status, 403);
  }
  for (const path of ['board', 'stream', 'health']) {
    const preflight = await fetch(h.url + path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(h.verified(), 0);
});

test('allowed cabinet origin never replaces verified bearer or run-owner capability', async t => {
  const h = await harness(t);
  for (const path of ['me', 'entry']) {
    const response = await fetch(h.url + path, { headers: { Origin: origin, Cookie: 'padlhubAuthToken=fixture-access' } });
    assert.equal(response.status, 401); assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  }
  const headers = { Origin: origin, Authorization: 'Bearer fixture-access', 'Content-Type': 'application/json' };
  const joined = await fetch(h.url + 'runs', { method: 'POST', headers, body: JSON.stringify({ consent: true, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE }) });
  const ticket = await joined.json();
  const denied = await fetch(h.url + 'runs/' + ticket.id, { method: 'POST', headers: { ...headers, 'X-Jump-Run-Token': '0'.repeat(64) }, body: JSON.stringify({ seq: 1, command: 'pause' }) });
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error, 'RUN_ACCESS_DENIED');
});

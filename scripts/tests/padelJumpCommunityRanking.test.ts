import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRegistry, fail } from '../../games/padel-jump/live/registry.mjs';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';
import { LIVE_ENGINE_VERSION, LIVE_RULE } from '../../src/components/padel-jump/live-contract.ts';

const communityId = 'fixture-community';
function fixtures() {
  const directory = mkdtempSync(join(tmpdir(), 'jump-community-'));
  const add = (actorId: string, stars: number, elapsedMs: number, overrides = {}) => {
    const row = { id: randomUUID(), actorId, alias: 'Одинаковое имя', communityId, engine: LIVE_ENGINE_VERSION, rule: LIVE_RULE,
      stars, elapsedMs, playMs: elapsedMs, failures: 5, finishedAt: new Date().toISOString(), ...overrides };
    writeFileSync(join(directory, row.id + '.json'), JSON.stringify(row)); return row;
  };
  return { directory, add, clear: () => rmSync(directory, { recursive: true, force: true }) };
}

test('member ranking uses verified actor, preserves best-star order and private receipts; same names are not identities', () => {
  const h = fixtures();
  try {
    h.add('own-private-id', 5, 1000); const own = h.add('own-private-id', 6, 54194);
    const faster = h.add('other-private-id', 6, 50000), more = h.add('third-private-id', 7, 100000);
    h.add('foreign-private-id', 999, 1, { communityId: 'other-community' });
    const historical = h.add('historical-private-id', 999, 1, { finishedAt: new Date(Date.now() - 49 * 3600000).toISOString() });
    h.add('old-rule-private-id', 999, 1, { rule: 'active-total-community-v1' });
    const registry = createRegistry({ communityId, directory: h.directory });
    const before = readdirSync(h.directory).map(name => [name, readFileSync(join(h.directory, name), 'utf8')]);
    const result = registry.communityRanking({ id: 'own-private-id', communityId });
    assert.deepEqual(result.rows.map(row => row.id), [more.id, faster.id, own.id]);
    assert.equal(result.rows.filter(row => row.isCurrentUser).length, 1);
    assert.equal(result.me.id, own.id); assert.equal(result.me.rank, 3);
    assert.equal(result.me.stars, 6); assert.equal(result.me.elapsedMs, 54194);
    assert.equal(registry.communityRanking({ id: 'no-result', communityId }).me, null);
    const permanent = registry.communityRanking({ id: 'own-private-id', communityId }, { allTime: true });
    assert.equal(permanent.schema, 'jump-community-ranking-v2'); assert.equal(permanent.retentionHours, null);
    assert.deepEqual(permanent.rows.map(row => row.id), [historical.id, more.id, faster.id, own.id]);
    assert.deepEqual(registry.board().results.map(row => row.id), permanent.rows.map(row => row.id));
    assert.deepEqual(readdirSync(h.directory).map(name => [name, readFileSync(join(h.directory, name), 'utf8')]), before);
    for (const row of result.rows) assert.deepEqual(Object.keys(row).sort(), ['elapsedMs', 'id', 'isCurrentUser', 'name', 'rank', 'stars']);
    for (const privateValue of ['own-private-id', 'other-private-id', 'actorId', 'phone', 'email', 'token', 'invite']) assert.ok(!JSON.stringify(result).includes(privateValue));
    for (const actor of [null, { id: 'own-private-id', communityId: 'other-community' }]) assert.throws(() => registry.communityRanking(actor), /VERIFIED_PROFILE_REQUIRED/);
  } finally { h.clear(); }
});

test('own best result outside first 100 keeps actual rank and never impersonates a displayed row', () => {
  const h = fixtures();
  try {
    for (let i = 0; i < 101; i++) h.add('member-' + i, 200 - i, 1000);
    const own = h.add('own-private-id', 6, 54194);
    const result = createRegistry({ communityId, directory: h.directory }).communityRanking({ id: 'own-private-id', communityId });
    assert.equal(result.total, 102); assert.equal(result.rows.length, 100);
    assert.equal(result.me.rank, 102); assert.equal(result.me.id, own.id);
    assert.ok(result.rows.every(row => !row.isCurrentUser));
  } finally { h.clear(); }
});

test('ranking CORS stays read-only; wrong scope, membership, origin and upstream errors fail closed', async () => {
  const calls: boolean[] = [];
  const server = createLiveServer({ communityId, origin: 'https://padlhub.su', authenticate: async (req, options) => {
    calls.push(options?.fresh === true);
    if (req.headers.authorization === 'Bearer member') return { id: 'verified-member', communityId };
    if (req.headers.authorization === 'Bearer nonmember') fail(403, 'COMMUNITY_MEMBER_REQUIRED');
    if (req.headers.authorization === 'Bearer outage') fail(503, 'PROFILE_UNAVAILABLE');
    fail(401, 'AUTH_REQUIRED');
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/jump-live-api/`, path = 'community-ranking?communityId=' + communityId;
  try {
    const headers = { Origin: 'https://padlhub.ru', Authorization: 'Bearer member' };
    const preflight = await fetch(base + path, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin);
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET'); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    assert.equal(calls.length, 0);
    const result = await fetch(base + path, { headers }); assert.equal(result.status, 200);
    assert.equal(result.headers.get('vary'), 'Origin, Accept'); assert.equal(result.headers.get('cache-control'), 'no-store');
    const permanent = await fetch(base + path, { headers: { ...headers, Accept: 'application/vnd.padlhub.jump-community-ranking.v2+json' } });
    assert.equal(permanent.status, 200); const permanentBody = await permanent.json();
    assert.equal(permanentBody.schema, 'jump-community-ranking-v2'); assert.equal(permanentBody.retentionHours, null);
    assert.equal((await (await fetch(base + 'health')).json()).resultStoragePolicy, 'permanent-v1');
    assert.deepEqual((await result.json()).rows, []); assert.deepEqual(calls, [false, false]);
    assert.equal((await fetch(base + path, { headers: { ...headers, Origin: 'https://padlhub.su' } })).status, 200);
    for (const origin of ['https://evil.example', 'https://padlhub.ru.evil.example', 'null']) {
      const response = await fetch(base + path, { headers: { ...headers, Origin: origin } });
      assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    for (const query of ['', '?communityId=other', '?communityId=' + communityId + '&communityId=other', '?communityId=' + communityId + '&actorId=other']) assert.equal((await fetch(base + 'community-ranking' + query, { headers })).status, 404);
    for (const [token, expected] of [['', 401], ['nonmember', 403], ['outage', 503]] as const) {
      const response = await fetch(base + path, { headers: { ...headers, Authorization: 'Bearer ' + token } });
      assert.equal(response.status, expected); assert.ok(!('rows' in await response.json()));
      assert.equal(response.headers.get('access-control-allow-origin'), headers.Origin);
    }
    assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 405);
    assert.equal((await fetch(base + path, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST' } })).status, 403);
    assert.equal((await fetch(base + path, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-jump-run-token' } })).status, 403);
    for (const oldPath of ['runs', 'enrollment']) {
      const denied = await fetch(base + oldPath, { method: 'POST', headers: { ...headers, Origin: 'https://padlhub.ru.evil.example', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await fetch(base + 'stream', { headers })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

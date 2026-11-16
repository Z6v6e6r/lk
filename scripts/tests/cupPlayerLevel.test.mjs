import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { readCupPlayerLevels, initializeCupPlayerLevel } from '../lib/cupPlayerLevel.mjs';
import { replayPlayerRatingEvents } from '../../src/services/player-rating/ledger.ts';
import { planFprRatingReconciliation } from '../../src/services/player-rating/fprRatingReplay.ts';
import { processFprProjectionOutbox } from '../lib/fprLevelLedger.mjs';
const at = '2026-11-16T10:00:00.000Z';
const get = (row, key) => key.split('.').reduce((value, part) => value?.[part], row);
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(clause => matches(row, clause));
    const actual = get(row, key);
    if (value && typeof value === 'object' && '$ne' in value) return actual !== value.$ne;
    return Array.isArray(actual) ? actual.includes(value) : actual === value;
  });
}
function database() {
  const collections = new Map();
  const db = { collection(name) {
    if (!collections.has(name)) collections.set(name, { docs: [],
      find(query) { let rows = this.docs.filter(row => matches(row, query)); return { limit(n) { rows = rows.slice(0, n); return this; }, async toArray() { return structuredClone(rows); } }; },
      async findOne(query) { return structuredClone(this.docs.find(row => matches(row, query)) || null); },
      async insertOne(row) { if (this.docs.some(old => old._id === row._id || row.idempotencyKey && old.idempotencyKey === row.idempotencyKey)) throw Error('duplicate'); this.docs.push(structuredClone(row)); },
    }); return collections.get(name);
  } };
  const client = { startSession() { return { async withTransaction(work) {
    const before = new Map([...collections].map(([key, value]) => [key, structuredClone(value.docs)]));
    try { await work(); } catch (error) { for (const [key, value] of collections) value.docs = before.get(key) || []; throw error; }
  }, async endSession() {} }; } };
  return { db, client };
}
const assign = (db, client, extra = {}) => initializeCupPlayerLevel(db, client, { clientId: 'synthetic-1', name: 'Synthetic Player', ratingNumeric: 3.12345, ...extra }, at);

test('new player remains unrated; numeric and letter provider fields are never a fallback', async () => {
  const { db } = database();
  const [row] = await readCupPlayerLevels(db, ['synthetic-1']);
  assert.deepEqual([row.status, row.ratingNumeric, row.rating], ['UNRATED', null, null]);
  assert.equal(db.collection('rating_events').docs.length, 0);
});
test('onboarding writes a single immutable baseline and canonical state; same result retries do not overwrite', async () => {
  const { db, client } = database(); const first = await assign(db, client);
  assert.equal(first.ratingNumeric, 3.12345); assert.equal(first.rating, 'C');
  assert.equal(db.collection('rating_events').docs.length, 1);
  assert.equal(replayPlayerRatingEvents(db.collection('rating_events').docs).ratingNumeric, first.ratingNumeric);
  assert.equal(planFprRatingReconciliation(db.collection('rating_events').docs), null);
  assert.equal(db.collection('rating_projection_outbox').docs.length, 0);
  assert.deepEqual(await assign(db, client), first);
  await assert.rejects(assign(db, client, { ratingNumeric: 4 }), /LEVEL_ALREADY_ASSIGNED/);
  assert.equal(db.collection('rating_events').docs.length, 1);
});
test('orphan client/phone history and ambiguous aliases block initial assignment', async () => {
  for (const row of [ { player: { clientId: 'synthetic-1' } }, { player: { key: 'phone:79990000001' } } ]) {
    const { db, client } = database(); db.collection('rating_events').docs.push(row);
    await assert.rejects(assign(db, client, { phone: '+7 999 000 00 01' }), /LEVEL_(REBUILD_REQUIRED|IDENTITY_CONFLICT)/);
    assert.equal(db.collection('player_rating_state').docs.length, 0);
  }
  const { db, client } = database();
  db.collection('player_rating_state').docs.push({ _id: 'other', playerKey: 'phone:79990000001' });
  await assert.rejects(assign(db, client, { phone: '79990000001' }), /IDENTITY_CONFLICT/);
  db.collection('player_rating_state').docs = [{ clientId: 'a', identityAliases: { clientIds: ['synthetic-1'] } }, { clientId: 'b', identityAliases: { clientIds: ['synthetic-1'] } }];
  await assert.rejects(readCupPlayerLevels(db, ['synthetic-1']), /IDENTITY_CONFLICT/);
});
test('invalid/out-of-range input and partial database failure leave no baseline', async () => {
  const { db, client } = database();
  for (const ratingNumeric of [null, 0, 7.1, NaN, Infinity, 3.123456]) await assert.rejects(assign(db, client, { ratingNumeric }), /LEVEL_ARGUMENTS/);
  db.collection('player_ratings').insertOne = async () => { throw Error('synthetic failure'); };
  await assert.rejects(assign(db, client), /synthetic failure/);
  assert.equal(db.collection('rating_events').docs.length, 0); assert.equal(db.collection('player_rating_state').docs.length, 0);
});
test('canonical read returns explicit aliases and opaque version without contacts or raw event IDs', async () => {
  const { db, client } = database(); await assign(db, client);
  db.collection('player_rating_state').docs[0].identityAliases.clientIds.push('synthetic-alias');
  const [row] = await readCupPlayerLevels(db, ['synthetic-alias']);
  assert.equal(row.clientId, 'synthetic-alias'); assert.match(row.version, /^v1-[a-f0-9]+$/);
  const batch = await readCupPlayerLevels(db, ['synthetic-1', 'synthetic-alias']);
  assert.equal(batch.length, 2); assert.equal(batch[0].ratingNumeric, batch[1].ratingNumeric);
  const { prepareFprStarts } = await import('../lib/fprStartBootstrap.mjs');
  await assert.rejects(prepareFprStarts(db, client, ['synthetic-1', 'synthetic-alias'], 'host'), /FPR_START_IDENTITY_CONFLICT/);
  assert.equal('phoneNorm' in row, false); assert.equal('lastEventId' in row, false);
});
test('retired FPR dispatcher performs no DB or provider I/O', async () => {
  const bad = new Proxy({}, { get() { throw Error('unexpected I/O'); } });
  assert.equal((await processFprProjectionOutbox(bad, 'https://invalid', at, false)).reason, 'CUP_ONLY');
});
test('node authorization binds the authenticated client, refuses spoofing and ignores caller audit fields', () => {
  const authorize = new Function('msg', fs.readFileSync('scripts/nodered_player_level_nodes/authorize.js', 'utf8'));
  const profile = { id: 'synthetic-1', firstName: 'Synthetic', lastName: 'Player', phone: '79990000001' };
  const input = body => ({ statusCode: 200, payload: profile, _cupLevel: { operation: 'initialize', body } });
  assert.equal(authorize(input({ clientId: 'foreign', levelNumeric: 3 }))[1].statusCode, 403);
  const [valid] = authorize(input({ clientId: 'synthetic-1', levelNumeric: '3,12345', changedById: 'spoofed', source: 'CUP_ADMIN' }));
  assert.equal(valid.payload.actorId, profile.id); assert.equal(valid.payload.ratingNumeric, 3.12345);
  assert.equal('source' in valid.payload, false);
  assert.equal(authorize({ ...input({ levelNumeric: 3 }), statusCode: 401 })[1].statusCode, 401);
  const prepare = new Function('msg', fs.readFileSync('scripts/nodered_player_level_nodes/prepare.js', 'utf8'));
  assert.equal(prepare({ payload: {}, req: { headers: {} } })[1].statusCode, 401);
});
test('profile hydration ignores stale Viva fields, distinguishes no level from error and filters outgoing fields', async () => {
  const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
  const block = source.slice(source.indexOf('const RETIRED_LEVEL_FIELDS'), source.indexOf('export interface OnboardingLevelPayload')).replace(/\bexport\s+/g, '');
  const js = stripTypeScriptTypes(block);
  const retired = 'eabfe27b-3f72-4496-9185-1a2ec6e6465e';
  for (const unavailable of [false, true]) {
    let sent;
    const request = async (url, options) => {
      if (url === '/lk/games/ratings/me') return unavailable ? { data: null, status: 503, error: { message: 'busy' } } : { data: { ok: true, items: [{ clientId: 'synthetic-1', source: 'CUP_CANONICAL', status: 'UNRATED', rating: null, ratingNumeric: null }] } };
      if (options.method === 'PATCH') sent = JSON.parse(options.body);
      return { data: { id: 'synthetic-1', customFields: [{ id: retired, value: ['6'] }] }, status: 200, error: null };
    };
    const api = new Function('request', 'getServ2Origin', 'TENANT_KEY', js + '; return { apiFetchProfile, apiUpdateProfile };')(request, () => 'https://synthetic.invalid', 'synthetic');
    const profile = (await api.apiFetchProfile()).data;
    assert.equal(profile.level.status, unavailable ? 'UNAVAILABLE' : 'UNRATED'); assert.deepEqual(profile.customFields, []);
    await api.apiUpdateProfile({ customFields: [{ id: retired, value: ['6'] }, { id: 'other', value: ['keep'] }] });
    assert.deepEqual(sent.customFields, [{ id: 'other', value: ['keep'] }]);
    await api.apiUpdateProfile({ customFields: [{ id: retired, value: ['6'] }] });
    assert.equal('customFields' in sent, false, 'filtering only retired fields must not send a destructive empty array');
  }
});

test('child authentication binds initialize after verification and cannot be bypassed by an empty snapshot', async () => {
  const { authorizeCupLevelInput } = await import('../lib/cupLevelAuth.mjs');
  let checks = 0;
  const verify = async token => { checks++; return token === 'Bearer synthetic-valid' ? 'player-a' : null; };
  await assert.rejects(authorizeCupLevelInput({ actorId: 'player-b', clientId: 'player-b', operation: 'initialize', authorization: 'Bearer synthetic-valid' }, verify), /LEVEL_FORBIDDEN/);
  await assert.rejects(authorizeCupLevelInput({ actorId: 'system:level', operation: 'verify', authorization: 'Bearer invalid' }, verify), /LEVEL_AUTH_REQUIRED/);
  await assert.rejects(authorizeCupLevelInput({ actorId: 'system:level', operation: 'verify', _verified: true }, verify), /LEVEL_AUTH_REQUIRED/);
  const out = await authorizeCupLevelInput({ actorId: 'system:level', operation: 'verify', authorization: 'Bearer synthetic-valid' }, verify);
  assert.equal(out.actorId, 'player-a'); assert.equal('authorization' in out, false); assert.equal(checks, 3);
});

test('snapshot refresh covers every accepted member alias, autojoin context, and empty/phone-only authentication', async () => {
  const { EventEmitter } = await import('node:events');
  const execute = new Function('msg', 'node', 'nodeChildProcess', fs.readFileSync('scripts/nodered_player_level_nodes/snapshot.js', 'utf8'));
  for (const alias of ['member', 'creator', 'actor', 'owner', 'user', 'manager', 'target', 'participant', 'phone-only', 'autojoin']) {
    const stale = { id: 'synthetic-1', levelScore: 6, levelLabel: 'A', levelNumeric: 6, ratingNumeric: 6, rating: 'A', level: 'A' };
    const msg = { payload: alias === 'autojoin' ? [] : { [alias]: alias === 'phone-only' ? { phone: '70000000001', levelScore: 6 } : stale }, req: { headers: { authorization: 'Bearer synthetic' } } };
    if (alias === 'autojoin') msg._gameCommunityAutoJoin = { member: stale };
    let sent, input;
    await new Promise(done => execute(msg, { send: output => { sent = output; }, done }, { spawn(command, args, options) {
      assert.equal(JSON.stringify([command, args, options]).includes('Bearer'), false);
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {};
      child.stdin.end = bytes => { input = JSON.parse(bytes); queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, items: input.clientIds.length ? [{ clientId: 'synthetic-1', ratingNumeric: null, rating: null }] : [] })));
        child.emit('close', 0);
      }); }; return child;
    } }));
    assert.equal(sent[1], null); assert.equal(input.authorization, 'Bearer synthetic');
    if (alias === 'phone-only') assert.equal(input.operation, 'verify');
    else { assert.equal(stale.levelScore, null); assert.equal(stale.levelNumeric, null); assert.equal(stale.level, null); }
  }
});

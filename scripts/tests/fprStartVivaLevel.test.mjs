import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFprVivaStartLevel, createFprVivaStartReader } from '../lib/fprStartVivaLevel.mjs';
const numeric = 'eabfe27b-3f72-4496-9185-1a2ec6e6465e', grade = 'f9790818-25fd-4b73-a781-79c02720727d';
const at = '2026-11-06T14:00:00.000Z';
const config = async () => ({ tokenUrl: 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token',
  clientId: 'synthetic-service', username: 'synthetic-user', password: 'synthetic-test-value' });
const profile = value => ({ id: 'synthetic', customFields: [{ id: numeric, value }] });

test('exact Viva numeric retains precision; successful empty profile is explicitly verified unrated', () => {
  const result = parseFprVivaStartLevel(profile(['3,65432']), 'synthetic', at);
  assert.equal(result.ratingNumeric, 3.65432); assert.equal(result.source, 'VIVA_NUMERIC');
  assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/); assert.equal(Object.isFrozen(result), true);
  assert.equal(parseFprVivaStartLevel({ id: 'synthetic', customFields: [] }, 'synthetic', at).source, 'VERIFIED_VIVA_UNRATED_DEFAULT_1');
  assert.equal(parseFprVivaStartLevel(profile(['']), 'synthetic', at).ratingNumeric, 1);
  assert.equal(JSON.stringify(result).includes('rawNumeric'), false);
});

test('malformed, ambiguous, zero, grade-only and wrong identity never become an unrated default', () => {
  for (const bad of [
    ...[0, false, {}, ['3', '4'], ['0'], ['8'], ['NaN'], ['3e0'], [true], [3.2, 3.3]].map(profile),
    { id: 'foreign', customFields: [] }, { id: 'synthetic' }, { id: 'synthetic', customFields: {} },
    { id: 'synthetic', customFields: [{}] }, { id: 'synthetic', customFields: [null] },
    { id: 'synthetic', customFields: [{ id: numeric, value: [] }, { id: grade, value: ['C'] }] },
    { id: 'synthetic', customFields: [{ id: numeric, value: ['3'] }, { id: numeric, value: ['3'] }] },
  ]) assert.throws(() => parseFprVivaStartLevel(bad, 'synthetic', at), e => /^FPR_START_/.test(e.message) && e.playerId === 'synthetic');
});

test('one auth and bounded parallel exact-profile reads, with credentials confined to the provider', async () => {
  let auth = 0, active = 0, peak = 0;
  const ids = Array.from({ length: 28 }, (_, i) => 'synthetic-' + i);
  const reader = createFprVivaStartReader({ readConfig: config, now: () => at, fetchImpl: async (url, init) => {
    assert.equal(init.headers instanceof Headers, true);
    assert.equal(init.headers.get('user-agent'), 'PadlHub-LK/1.0');
    if (url.startsWith('https://kc.')) { auth++; return { status: 200, json: async () => ({ access_token: 'synthetic-bearer', expires_in: 3600 }) }; }
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    const id = decodeURIComponent(url.split('/').at(-1)); assert.ok(ids.includes(id));
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return { status: 200, json: async () => ({ id, customFields: [{ id: numeric, value: ['3.65432'] }] }) };
  } });
  const result = await reader(ids);
  assert.equal(auth, 1); assert.equal(result.size, 28); assert.ok(peak > 1 && peak <= 6);
  assert.equal(result.get(ids[0]).ratingNumeric, 3.65432);
  assert.equal(JSON.stringify([...result.values()]).includes('synthetic-bearer'), false);
});

test('provider auth/HTTP/JSON/transport errors fail with sanitized participant errors', async () => {
  for (const scenario of ['auth', 'http', 'json', 'transport', 'identity']) {
    const reader = createFprVivaStartReader({ readConfig: config, now: () => at, fetchImpl: async url => {
      if (url.startsWith('https://kc.')) return { status: scenario === 'auth' ? 401 : 200,
        json: async () => ({ access_token: 'synthetic-bearer', expires_in: 3600 }) };
      if (scenario === 'transport') throw Error('raw-provider-sensitive-detail');
      return { status: scenario === 'http' ? 500 : 200, json: async () => {
        if (scenario === 'json') throw Error('raw-provider-sensitive-detail');
        return { id: 'foreign', customFields: [] };
      } };
    } });
    await assert.rejects(reader(['synthetic']), error => error.message === 'FPR_START_VIVA_UNAVAILABLE' && error.playerId === 'synthetic');
  }
});

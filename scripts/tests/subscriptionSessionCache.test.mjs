import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import fs from 'node:fs';
import ts from 'typescript';

const bundle = (await build({
  stdin: { contents: 'export * from "./src/utils/subscriptionSessionCache"; export * from "./src/utils/subscriptionSnapshotData";', resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', globalName: 'cache', platform: 'browser',
})).outputFiles[0].text;
const token = (sub, extra = {}) => ['header', Buffer.from(JSON.stringify({ iss: 'fixture', sub, sid: 'session', exp: 9999999999, ...extra })).toString('base64url'), 'signature'].join('.');
function browser(saved = new Map()) {
  const sessionStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const context = vm.createContext({ window: { sessionStorage }, crypto: webcrypto, TextEncoder, URL, atob });
  vm.runInContext(bundle, context);
  return { context, cache: context.cache, saved };
}
const ok = data => ({ data, error: null, status: 200 });
function reader(cache) {
  let current = token('a'); let calls = 0;
  return {
    setToken: value => { current = value; },
    get calls() { return calls; },
    read: (key = 'list', extra = {}) => cache.readSubscriptionSnapshot({ key, token: current, currentToken: () => current,
      sanitize: value => value && typeof value.value === 'number' ? { value: value.value } : null,
      load: async () => ok({ value: ++calls }), ...extra }),
  };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setTimeout(resolve, 15));

test('concurrent list/name consumers and separate IIFE bundles share one request per key', async () => {
  const { cache, context } = browser(); const a = reader(cache);
  vm.runInContext(bundle, context); const b = reader(context.cache);
  const results = await Promise.all([a.read(), a.read(), b.read()]);
  assert.deepEqual(results.map(result => result.data.value), [1, 1, 1]);
  assert.equal(a.calls + b.calls, 1);
  await a.read('name'); await b.read('name'); assert.equal(a.calls + b.calls, 2);
});

test('full page navigation restores snapshot; API variants and environment remain separate', async () => {
  const first = browser(); const a = reader(first.cache); await a.read('prod:active');
  const b = reader(browser(first.saved).cache);
  assert.equal((await b.read('prod:active')).data.value, 1); assert.equal(b.calls, 0);
  await b.read('prod:history'); await b.read('dev:active'); assert.equal(b.calls, 2);
});

test('JWT refresh preserves identity; account, issuer and login session changes refetch', async () => {
  const { cache, saved } = browser(); const a = reader(cache); await a.read();
  a.setToken(token('a', { exp: 9999999998 })); await a.read(); assert.equal(a.calls, 1);
  a.setToken(token('b')); await a.read(); assert.equal(a.calls, 2);
  a.setToken(token('b', { iss: 'other' })); await a.read(); assert.equal(a.calls, 3);
  a.setToken(token('b', { sid: 'other' })); await a.read(); assert.equal(a.calls, 4);
  assert.ok(![...saved.values()].join('').includes('signature'));
});

test('logout clears disk and memory; missing auth cannot return previous user data', async () => {
  const { cache, saved } = browser(); const a = reader(cache); await a.read();
  cache.invalidateSubscriptionSnapshot(); assert.equal(saved.size, 0);
  a.setToken(null); const result = await a.read('list', { load: async () => ({ data: null, error: { status: 401, message: 'auth' }, status: 401 }) });
  assert.equal(result.status, 401); a.setToken(token('a')); await a.read(); assert.equal(a.calls, 2);
});

test('invalidation and account change discard old inflight response, never refill snapshot', async () => {
  for (const switchAccount of [false, true]) {
    const { cache } = browser(); const a = reader(cache); const gate = deferred();
    const old = a.read('list', { load: () => gate.promise }); await tick();
    if (switchAccount) a.setToken(token('b')); else cache.invalidateSubscriptionSnapshot();
    await a.read(); gate.resolve(ok({ value: 99 })); assert.equal((await old).data, null);
    assert.equal((await a.read()).data.value, 1);
  }
});

test('fresh reload supersedes old flight and updates snapshot; caller mutation cannot change it', async () => {
  const { cache } = browser(); const a = reader(cache); const gate = deferred();
  const old = a.read('list', { load: () => gate.promise }); await tick();
  cache.invalidateSubscriptionSnapshot();
  const fresh = await a.read(); fresh.data.value = 999;
  gate.resolve(ok({ value: 99 })); assert.equal((await old).data, null);
  assert.equal((await a.read()).data.value, 1); assert.equal(a.calls, 1);
});

test('errors and malformed data are retryable; storage failure does not prevent memory caching', async () => {
  const { cache, context } = browser(); const a = reader(cache);
  await a.read('list', { load: async () => ({ data: null, error: { status: 503, message: 'fail' }, status: 503 }) });
  await a.read('list', { load: async () => ok({ wrong: true }) });
  Object.defineProperty(context.window, 'sessionStorage', { get() { throw new Error('disabled'); } });
  await a.read(); await a.read(); assert.equal(a.calls, 1);
});

test('corrupt and expired disk data fall back to network', async () => {
  const first = browser(); const a = reader(first.cache); await a.read();
  const key = [...first.saved.keys()][0]; const data = JSON.parse(first.saved.get(key));
  data.entries[0][1].savedAt = 0; first.saved.set(key, JSON.stringify(data));
  const b = reader(browser(first.saved).cache); await b.read(); assert.equal(b.calls, 1);
  first.saved.set(key, '{broken'); const c = reader(browser(first.saved).cache); await c.read(); assert.equal(c.calls, 1);
});

test('persisted subscription contract drops personal/provider fields recursively', () => {
  const { cache } = browser();
  const result = cache.sanitizeSubscriptionSnapshot({ content: [{ subscriptionId: 'sub', type: 'VISIT', visitsLeft: 2,
    phone: 'private', name: 'Annual', availableStudios: [{ id: 'studio', name: 'Court', token: 'secret' }] }],
    phone: 'private', pageable: { phone: 'private', sort: { sorted: false, token: 'secret' } } });
  const json = JSON.stringify(result); assert.ok(!json.includes('private')); assert.ok(!json.includes('secret'));
  assert.equal(result.content[0].visitsLeft, 2);
  assert.equal(JSON.stringify(cache.sanitizeSubscriptionName({ sertName: 'Annual', phone: 'private' })), '{"sertName":"Annual"}');
  assert.equal(cache.sanitizeSubscriptionName({ sertName: '' }), null);
});

test('only entitlement writes invalidate; quotes, availability, polling and dry runs do not', () => {
  const { requestChangesSubscriptions: changes } = browser().cache;
  for (const path of ['/lk/subscription-bookings?operationId=one', '/lk/games/split/create', '/lk/games/game/split/join', '/lk/games/game/split/leave', '/lk/games/split/cleanup', '/end-user/api/v2/tenant/transactions', '/end-user/api/v1/tenant/bookings/booking/cancel']) {
    assert.equal(changes(path, 'POST'), true, path); assert.equal(changes(path, 'GET'), false);
  }
  assert.equal(changes('/end-user/api/v1/tenant/bookings/booking', 'DELETE'), true);
  for (const path of ['/lk/subscriptions/game-price-preview', '/end-user/api/v1/tenant/transactions/preview', '/lk/games/payment/confirm']) assert.equal(changes(path, 'POST'), false);
  assert.equal(changes('/lk/games/split/cleanup', 'POST', '{"dryRun":true}'), false);
});

test('actual list API facade uses snapshot and preserves query variants', async () => {
  const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
  const body = source.slice(source.indexOf('export async function apiFetchSubscriptions('), source.indexOf('export async function apiFetchExercisesByDate('));
  const js = ts.transpileModule(body.replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { cache } = browser(); const calls = [];
  const api = new Function('URLSearchParams', 'API_BASE', 'TENANT_KEY', 'SERV2', 'SERV2_FALLBACK', 'IS_DEV_RELEASE_CHANNEL', 'readAuthToken', 'readSubscriptionSnapshot', 'sanitizeSubscriptionSnapshot', 'request', `${js}; return apiFetchSubscriptions;`)(
    URLSearchParams, 'https://fixture.invalid', 'tenant', 'https://serv.invalid', '', true, () => token('a'), cache.readSubscriptionSnapshot, cache.sanitizeSubscriptionSnapshot,
    async (url, options) => { calls.push({ url, options }); return ok({ content: [{ subscriptionId: 'sub', type: 'VISIT' }] }); });
  await Promise.all([api(), api()]); await api(); assert.equal(calls.length, 1);
  cache.invalidateSubscriptionSnapshot();
  await api(); assert.equal(calls.length, 2);
  await api({ includeFinished: true, size: 1000 }); assert.equal(calls.length, 3);
});

test('cached annual discount candidates retain product, ownership and lifecycle evidence', () => {
  const { cache } = browser();
  const source = fs.readFileSync('src/utils/tournamentSignupApi.ts', 'utf8');
  const start = source.indexOf('function collectLk1MoneyDiscountCandidates(');
  const end = source.indexOf('export async function apiFetchTournamentVivaPublicCheckout', start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const instant = Date.parse('2026-09-09T09:00:00Z');
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } }
  const collect = new Function('Date', `${js}; return collectLk1MoneyDiscountCandidates;`)(FixedDate);
  const exercise = { timeFrom: '2026-09-10T09:00:00Z', timeTo: '2026-09-10T10:00:00Z' };
  const base = { subscriptionId: 'fixture-sub', productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', clientId: 'actor',
    status: 'ACTIVE', purchaseDate: '2026-09-01', activationDate: '2026-09-01', expirationDate: '2027-09-01' };
  for (const delta of [{}, { product: { id: base.productId } }, { product: { id: 'wrong' } }, { client: { id: 'wrong' } },
    { subscriptionProductId: 'wrong' }, { templateId: 'wrong' }, { id: 'wrong' }, { purchaseAt: '2026-08-31' },
    { frozenUntil: '2027-01-01' }, { isFrozen: true }, { expirationDate: null }, { clientId: ['actor'] }]) {
    const network = { content: [{ ...base, ...delta }], last: true, totalElements: 1 };
    const cached = cache.sanitizeSubscriptionSnapshot(network);
    if (cached === null) { assert.ok(Array.isArray(delta.clientId)); continue; }
    const original = collect(network, 'actor', exercise); const restored = collect(cached, 'actor', exercise);
    assert.equal(restored.length, original.length, JSON.stringify(delta));
    if (Object.keys(delta).length === 0) assert.equal(restored.length, 1);
  }
});

test('daily-limit plan classification is unchanged by snapshot serialization', async () => {
  const code = (await build({ entryPoints: ['src/utils/subscriptionCategoryDailyLimit.ts'], bundle: true, write: false,
    format: 'iife', globalName: 'limits', platform: 'browser' })).outputFiles[0].text;
  const { cache, context } = browser(); vm.runInContext(code, context);
  const classify = context.limits.resolveSubscriptionCategoryDailyLimitPlanKey;
  for (const marker of [{ productName: 'Энергия 5' }, { product: { name: 'Падел.Дружба.ХАБ' } },
    { raw: { subscription: { subscriptionProductName: 'Энергия 5' } } }]) {
    const sub = { subscriptionId: 'sub', ...marker };
    assert.equal(classify(cache.sanitizeSubscriptionSnapshot({ content: [sub] }).content[0]), classify(sub));
  }
});

test('actual request boundary invalidates before and after partial/ambiguous writes, not quote reads', async () => {
  const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
  const start = source.indexOf('async function rawRequest<T>(');
  const end = source.indexOf('export async function request<T>(', start);
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const mode of ['success', 'partial', 'transport', 'preview', 'dryRun']) {
    const { cache } = browser(); let invalidations = 0;
    const isRead = mode === 'preview' || mode === 'dryRun';
    const api = new Function('API_BASE', 'Headers', 'FormData', 'readAuthToken', 'requestChangesSubscriptions',
      'invalidateSubscriptionSnapshot', 'fetch', 'isLkIdleRequestPausedError', 'trackClientError', 'isRecord',
      'pickString', 'summarizeApiErrorPayload', `${js}; return rawRequest;`)(
      'https://fixture.invalid', Headers, FormData, () => token('a'), cache.requestChangesSubscriptions,
      () => { invalidations += 1; }, async () => {
        assert.equal(invalidations, isRead ? 0 : 1);
        if (mode === 'transport') throw new Error('fixture network failure');
        return new Response(JSON.stringify({ ok: mode !== 'partial', bookingSuccessCount: 1 }), {
          status: mode === 'partial' ? 409 : 200, headers: { 'Content-Type': 'application/json' },
        });
      }, () => false, () => {}, value => value && typeof value === 'object', () => null, () => ({}));
    await api(mode === 'preview' ? '/lk/subscriptions/game-price-preview' : mode === 'dryRun' ? '/lk/games/split/cleanup' : '/lk/games/game/split/leave',
      { method: 'POST', auth: true, ...(mode === 'dryRun' ? { body: '{"dryRun":true}' } : {}) });
    assert.equal(invalidations, isRead ? 0 : 2, mode);
  }
});

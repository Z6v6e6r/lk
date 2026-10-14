import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
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

test('actual list API facade shares in-flight reads, refreshes balances and preserves query variants', async () => {
  const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
  const body = source.slice(source.indexOf('export async function apiFetchSubscriptions('), source.indexOf('export async function apiFetchExercisesByDate('));
  const js = ts.transpileModule(body.replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { cache } = browser(); const calls = []; const gate = deferred(); let hold = true;
  const api = new Function('URLSearchParams', 'API_BASE', 'TENANT_KEY', 'SERV2', 'SERV2_FALLBACK', 'IS_DEV_RELEASE_CHANNEL', 'readAuthToken', 'readSubscriptionSnapshot', 'sanitizeSubscriptionSnapshot', 'request', `${js}; return apiFetchSubscriptions;`)(
    URLSearchParams, 'https://fixture.invalid', 'tenant', 'https://serv.invalid', '', true, () => token('a'), cache.readSubscriptionSnapshot, cache.sanitizeSubscriptionSnapshot,
    async (url, options) => { calls.push({ url, options }); if (hold) await gate.promise; return ok({ content: [{ subscriptionId: 'sub', type: 'VISIT' }] }); });
  const concurrent = Promise.all([api(), api()]); await tick(); assert.equal(calls.length, 1);
  hold = false; gate.resolve(); await concurrent;
  await api(); assert.equal(calls.length, 2);
  cache.invalidateSubscriptionSnapshot();
  await api(); assert.equal(calls.length, 3);
  await api({ includeFinished: true, size: 1000 }); assert.equal(calls.length, 4);
  assert.ok(calls.every(({ options }) => options.method === 'GET' && options.auth === true && options.cache === 'no-store' && options.body === undefined));
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

test('live balances ignore and remove legacy 12h disk entries; later reads always reload', async () => {
  const first = browser(); const a = reader(first.cache);
  await a.read('list', { load: async () => ok({ value: 99 }) });
  await a.read('name');
  const second = browser(first.saved); const b = reader(second.cache);
  assert.equal((await b.read('list', { cacheResult: false })).data.value, 1);
  assert.equal((await b.read('list', { cacheResult: false })).data.value, 2);
  const persisted = JSON.parse([...second.saved.values()][0]);
  assert.ok(persisted.entries.every(([key]) => key !== 'list'));
  assert.equal((await b.read('name')).data.value, 1);
  assert.equal(b.calls, 2);
  const c = reader(browser(second.saved).cache);
  assert.equal((await c.read('list', { cacheResult: false })).data.value, 1);
  assert.equal(c.calls, 1);
});

test('live balance reads across IIFE bundles share only an in-flight request', async () => {
  const { cache, context, saved } = browser(); const a = reader(cache);
  vm.runInContext(bundle, context); const b = reader(context.cache);
  const gate = deferred(); let calls = 0;
  const load = () => { calls += 1; return gate.promise; };
  const x = a.read('list', { cacheResult: false, load });
  const y = b.read('list', { cacheResult: false, load });
  await tick(); assert.equal(calls, 1);
  gate.resolve(ok({ value: 24 }));
  assert.deepEqual((await Promise.all([x, y])).map(r => r.data.value), [24, 24]);
  assert.equal(JSON.parse([...saved.values()][0]).entries.length, 0);
  await b.read('list', { cacheResult: false }); assert.equal(b.calls, 1);
});

test('live balance invalidation and account changes fence late old responses', async () => {
  for (const switchAccount of [false, true]) {
    const { cache } = browser(); const a = reader(cache); const gate = deferred();
    const old = a.read('list', { cacheResult: false, load: () => gate.promise }); await tick();
    if (switchAccount) a.setToken(token('b')); else cache.invalidateSubscriptionSnapshot();
    assert.equal((await a.read('list', { cacheResult: false })).data.value, 1);
    gate.resolve(ok({ value: 99 }));
    assert.equal((await old).status, 409); assert.equal((await old).data, null);
    assert.equal((await a.read('list', { cacheResult: false })).data.value, 2);
  }
});

test('selected subscription keys never join another subscription read or consume its balance', async () => {
  const { cache } = browser(); const a = reader(cache); const gate = deferred();
  const oldA = a.read('subscription:A', { cacheResult: false, load: () => gate.promise }); await tick();
  assert.equal((await a.read('subscription:B', { cacheResult: false, load: async () => ok({ value: 30 }) })).data.value, 30);
  gate.resolve(ok({ value: 24 })); assert.equal((await oldA).data.value, 24);
  assert.equal((await a.read('subscription:B', { cacheResult: false, load: async () => ok({ value: 29 }) })).data.value, 29);
});

test('no-crypto and missing/expired-token paths also discard invalidated or foreign late reads', async () => {
  for (const mode of ['no-crypto', 'no-token', 'expired-token']) {
    for (const invalidate of [false, true]) {
      const { cache, context } = browser(); const a = reader(cache); const gate = deferred();
      if (mode === 'no-crypto') context.crypto = undefined;
      if (mode === 'no-token') a.setToken(null);
      if (mode === 'expired-token') a.setToken(token('a', { exp: 1 }));
      const old = a.read('list', { cacheResult: false, load: () => gate.promise }); await tick();
      if (invalidate) cache.invalidateSubscriptionSnapshot(); else a.setToken(token('b'));
      gate.resolve(ok({ value: 99 }));
      assert.equal((await old).data, null, mode); assert.equal((await old).status, 409, mode);
    }
  }
});

test('unavailable/malformed live reads stay unknown, never reuse the old balance or an invented zero', async () => {
  const { cache } = browser(); const a = reader(cache);
  await a.read('list', { load: async () => ok({ value: 24 }) });
  for (const response of [
    { data: null, error: { status: 503, message: 'source unavailable' }, status: 503 },
    { data: { value: 24 }, error: { status: 503, message: 'partial' }, status: 503 },
    { data: { value: 24 }, error: null, status: 206 },
    { data: null, error: null, status: 204 },
    ok({ missing: 'balance' }),
  ]) {
    const result = await a.read('list', { cacheResult: false, load: async () => response });
    assert.equal(result.data, null); assert.ok(result.error);
  }
  const rejected = new Error('synthetic transport');
  await assert.rejects(a.read('list', { cacheResult: false, load: () => Promise.reject(rejected) }), /synthetic transport/);
  assert.equal((await a.read('list', { cacheResult: false, load: async () => ok({ value: 0 }) })).data.value, 0);
  assert.equal((await a.read('list', { cacheResult: false, load: async () => ok({ value: 23 }) })).data.value, 23);
});

test('no-crypto malformed or partial source payloads are unknown rather than usable balances', async () => {
  const { cache, context } = browser(); context.crypto = undefined; const a = reader(cache);
  for (const response of [ok({ missing: true }), { data: { value: 24 }, error: null, status: 206 }, { data: { value: 24 }, error: { status: 503, message: 'partial' }, status: 503 }]) {
    const result = await a.read('list', { cacheResult: false, load: async () => response });
    assert.equal(result.data, null); assert.ok(result.error);
  }
});

// Existing Node/esbuild/React SSR contour, synthetic props only; no browser/API/provider I/O.
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const bundled = await build({
  entryPoints: ['src/components/cabinet/SubscriptionsContainer.tsx'], bundle: true, write: false,
  format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'no-api-io', setup(build) {
    build.onResolve({ filter: /utils\/apiClient$/ }, () => ({ path: 'no-api-io', namespace: 'no-api-io' }));
    build.onLoad({ filter: /.*/, namespace: 'no-api-io' }, () => ({
      contents: 'export function apiFetchSubscriptioName() { throw new Error("SSR_MUST_NOT_CALL_API"); }',
      loader: 'js',
    }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports);
const render = data => renderToStaticMarkup(React.createElement(module.exports.SubscriptionsContainer, {
  UserSubscriptions: data, phone: 'synthetic-not-a-contact', openSubInfo() {},
}));

test('failed subscription loading is announced as unknown, distinct from a confirmed empty list', () => {
  const unavailable = render(null);
  assert.match(unavailable, /Не удалось загрузить абонементы/);
  assert.match(unavailable, /role="status"/);
  assert.doesNotMatch(unavailable, /У вас пока нет абонементов|0 занятий/);
  const empty = render({ content: [] });
  assert.match(empty, /У вас пока нет абонементов/);
  assert.doesNotMatch(empty, /Не удалось загрузить/);
});

test('the actual card preserves exact balances and never changes an unknown balance to zero', () => {
  const sub = { subscriptionId: 'synthetic-sub', name: 'Энергия 5', status: 'ACTIVE', expirationDate: null };
  assert.match(render({ content: [{ ...sub, visitsLeft: 24 }] }), /24 занятия/);
  assert.match(render({ content: [{ ...sub, visitsLeft: 23 }] }), /23 занятия/);
  assert.match(render({ content: [{ ...sub, visitsLeft: 0 }] }), /0 занятий/);
  assert.doesNotMatch(render({ content: [{ ...sub, visitsLeft: null }] }), /0 занятий/);
});

const cabinet = ts.createSourceFile('Cabinet.tsx', fs.readFileSync('src/components/cabinet/Cabinet.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate) {
  let result;
  const walk = node => { if (predicate(node)) result = node; ts.forEachChild(node, walk); };
  walk(cabinet); assert.ok(result); return result;
}

test('the open information panel resolves the selected exact ID from the current list, never its old object or another row', () => {
  const panel = findNode(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(cabinet) === 'SubscriptionInformation');
  const attribute = panel.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(cabinet) === 'sub');
  const expression = attribute.initializer.expression.getText(cabinet);
  const resolve = new Function('userSubscriptions', 'currenSub', `return (${expression});`);
  const old = { subscriptionId: 'A', visitsLeft: 24 };
  const fresh = { subscriptionId: 'A', visitsLeft: 23 };
  const other = { subscriptionId: 'B', visitsLeft: 30 };
  assert.equal(resolve({ content: [other, fresh] }, old), fresh);
  assert.equal(resolve({ content: [other, fresh] }, other), other);
  assert.equal(resolve({ content: [other] }, old), null);
  assert.equal(resolve(null, old), null);
});

test('failed refresh clears the cabinet balance instead of retaining the old snapshot', () => {
  const write = findNode(node => ts.isCallExpression(node) && node.expression.getText(cabinet) === 'setUserSubscriptions'
    && node.arguments[0]?.getText(cabinet).includes('userSubscriptionsData'));
  assert.ok(ts.isExpressionStatement(write.parent) && ts.isBlock(write.parent.parent));
  let shown = { content: [{ subscriptionId: 'A', visitsLeft: 24 }] };
  new Function('setUserSubscriptions', 'userSubscriptionsData', write.getText(cabinet))(value => { shown = value; }, { data: null });
  assert.equal(shown, null);
  assert.match(render(shown), /Не удалось загрузить абонементы/);
});

test('application guard accepts first scope restore but rejects changed token or invalidation epoch', async () => {
  const { cache } = browser(); let current = token('a'); const a = reader(cache);
  const beforeRestore = cache.captureSubscriptionSnapshotGuard(() => current);
  await a.read('list', { cacheResult: false });
  assert.equal(beforeRestore(), true);
  cache.invalidateSubscriptionSnapshot(); assert.equal(beforeRestore(), false);
  const beforeTokenChange = cache.captureSubscriptionSnapshotGuard(() => current);
  current = token('b'); assert.equal(beforeTokenChange(), false);
});

test('actual Cabinet application blocks reject already-returned stale lists and stale-null after delayed Promise.all siblings', async () => {
  const declaration = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(cabinet) === 'beginSubscriptionLoad');
  const callback = declaration.initializer.arguments[0].getText(cabinet);
  const blocks = [];
  const walk = node => {
    if (ts.isIfStatement(node) && node.expression.getText(cabinet) === 'isCurrentSubscriptionLoad()') blocks.push(node.getText(cabinet));
    ts.forEachChild(node, walk);
  };
  walk(cabinet); assert.equal(blocks.length, 2);
  const apply = blocks.map(block => new Function('isCurrentSubscriptionLoad', 'subsRes', 'referralSubsRes',
    'userSubscriptionsData', 'referralSubscriptionsData', 'setUserSubscriptions', 'setReferralUserSubscriptions', block));
  for (const oldPath of [0, 1]) {
    for (const mode of ['newer-batch', 'account', 'invalidation', 'same-batch-account', 'same-batch-invalidation']) {
      for (const failOld of [false, true]) {
        const { cache } = browser(); let current = token('a');
        const begin = new Function('subscriptionLoadSequenceRef', 'captureSubscriptionSnapshotGuard', 'readAuthToken',
          'return (' + callback + ');')({ current: 0 }, cache.captureSubscriptionSnapshotGuard, () => current);
        let shown = null, referral = null;
        const response = (id, visitsLeft) => ok({ content: [{ subscriptionId: id, visitsLeft }] });
        const batch = async (path, raw, sibling, returned = () => {}) => {
          const isCurrent = begin();
          const subscriptions = cache.readSubscriptionSnapshot({
            key: 'list', token: current, currentToken: () => current, cacheResult: false,
            sanitize: cache.sanitizeSubscriptionSnapshot, load: () => Promise.resolve(raw),
          }).then(result => { returned(); return result; });
          const [result] = await Promise.all([subscriptions, sibling]);
          apply[path](isCurrent, result, result, result, result, value => { shown = value; }, value => { referral = value; });
        };
        const held = deferred(), readReturned = deferred();
        const raw = failOld ? { data: null, status: 503, error: { status: 503, message: 'synthetic unavailable' } } : response('A', 24);
        const old = batch(oldPath, raw, held.promise, readReturned.resolve);
        await readReturned.promise;
        if (mode.includes('account')) current = token('b');
        if (mode.includes('invalidation')) cache.invalidateSubscriptionSnapshot();
        if (mode.startsWith('same-batch')) {
          held.resolve(); await old;
          assert.equal(shown, null, mode); assert.equal(referral, null, mode);
          continue;
        }
        const freshId = mode === 'account' ? 'B' : 'A';
        await batch(1 - oldPath, response(freshId, 23), Promise.resolve());
        assert.equal(shown.content[0].visitsLeft, 23);
        held.resolve(); await old;
        assert.equal(shown.content[0].subscriptionId, freshId, mode);
        assert.equal(shown.content[0].visitsLeft, 23, mode);
        assert.equal(referral.content[0].visitsLeft, 23, mode);
      }
    }
  }
});

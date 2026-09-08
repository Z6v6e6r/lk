import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { createGateway, LOCAL_ORIGIN, readPlan, productionTransport, webHeaders } from '../lk1_local_gateway.mjs';

const phone = '7' + '0'.repeat(10);
const otherPhone = '7' + '1'.repeat(10);
const sid = result => result.cookie?.split(';')[0].split('=')[1];

test('web and HMR header allowlist excludes all credentials and custom forwarding headers', () => {
  assert.deepEqual(webHeaders({ host: '127.0.0.1:5180', cookie: 'private', authorization: 'private', 'proxy-authorization': 'private',
    'x-api-key': 'private', 'x-forwarded-host': 'foreign', 'sec-websocket-protocol': 'vite-hmr' }),
  { host: '127.0.0.1:5180', 'sec-websocket-protocol': 'vite-hmr' });
});

function fixture(options = {}) {
  let time = 1_800_000_000_000;
  let sequence = 0;
  const calls = [];
  const realTokens = [];
  const makeToken = () => {
    const payload = { iss: 'https://kc.vivacrm.ru/realms/clients', azp: 'widget', sub: 'fixture-subject', phone_number: phone, exp: time / 1000 + 3600, ...options.claims };
    const token = `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature-${++sequence}`;
    realTokens.push(token); return token;
  };
  const gateway = createGateway({ now: () => time, transport: async plan => {
    calls.push(plan);
    if (options.beforeCall) await options.beforeCall(plan);
    if (options.error) throw new Error('fixture private upstream error');
    if (plan.sms) return { status: 200, data: {} };
    if (plan.url.endsWith('/token')) return options.tokenFailure ? { status: 400, data: { private: 'must not escape' } }
      : { status: 200, data: { access_token: makeToken(), refresh_token: `provider-refresh-${sequence}`, refresh_expires_in: 7200 } };
    assert.ok(realTokens.includes(plan.token), 'only provider-issued credentials go upstream');
    if (plan.url.endsWith('/profile')) return { status: 200, data: { id: 'fixture-client', phone, ...options.profile } };
    return { status: 200, data: { content: [] } };
  } });
  const code = () => gateway.dispatch({ route: 'auth.code', payload: { phone, channel: 'cascade' } });
  const login = async () => {
    const challenge = await code();
    assert.equal(challenge.status, 200);
    const result = await gateway.dispatch({ route: 'auth.token', payload: { phone, code: '1234' } }, sid(challenge));
    return { challenge, result, session: sid(result), token: result.data.access_token, refresh: result.data.refresh_token };
  };
  return { gateway, calls, realTokens, code, login, advance: ms => { time += ms; } };
}

test('only five fixed GET templates; arbitrary URLs, tenant/identity fields and detail IDs fail closed', () => {
  for (const route of ['profile', 'bookings', 'history', 'subscriptions', 'studios']) {
    assert.equal(readPlan(route).method, 'GET');
    assert.match(readPlan(route).url, /^https:\/\/api\.vivacrm\.ru\/end-user\/api\/v[12]\/iSkq6G\//);
    for (const payload of [{ clientId: 'other' }, { phone }, { url: 'http://localhost' }, { tenant: 'other' }, { subscriptionId: 'other' }]) assert.equal(readPlan(route, payload), null);
  }
  for (const route of ['games', 'profile.patch', 'payment.confirm', 'auth.verify-phone', 'consent', 'push', 'http://localhost']) assert.equal(readPlan(route), null);
  for (const size of [0, 1001, -1, 1.5, '10']) assert.equal(readPlan('bookings', { size }), null);
  assert.equal(readPlan('subscriptions', { sort: ['id;delete'] }), null);
  assert.match(readPlan('subscriptions', { includeFinished: true, size: 100, sort: ['id,asc', 'createdDate,desc'] }).url, /sort=id%2Casc&sort=createdDate%2Cdesc/);
});

test('SMS challenge, token, canonical profile and rotated session; provider credentials never reach browser', async () => {
  const f = fixture(); const auth = await f.login();
  assert.equal(auth.result.status, 200);
  assert.notEqual(auth.session, sid(auth.challenge));
  assert.match(auth.result.cookie, /HttpOnly; SameSite=Strict; Path=\/__lk1_local/);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[2].url.endsWith('/profile'));
  for (const secret of [...f.realTokens, 'provider-refresh-1']) assert.equal(JSON.stringify(auth.result).includes(secret), false);
  const display = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString());
  assert.equal(display.phone_number, 'local-preview');
  assert.equal(display.iss, LOCAL_ORIGIN);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: auth.token }, auth.session)).status, 200);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: auth.token }, sid(auth.challenge))).status, 401);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: 'forged' }, auth.session)).status, 401);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: f.realTokens[0] }, auth.session)).status, 401);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: auth.token, url: 'https://example.invalid' }, auth.session)).status, 403);
});

test('unknown, expired or wrong-phone challenge cannot exchange a token; rate limit survives new cookies', async () => {
  const f = fixture();
  assert.equal((await f.gateway.dispatch({ route: 'auth.token', payload: { phone, code: '1234' } })).status, 401);
  const challenge = await f.code();
  assert.equal((await f.code()).status, 429);
  assert.equal((await f.gateway.dispatch({ route: 'auth.token', payload: { phone: otherPhone, code: '1234' } }, sid(challenge))).status, 403);
  f.advance(600001);
  assert.equal((await f.gateway.dispatch({ route: 'auth.token', payload: { phone, code: '1234' } }, sid(challenge))).status, 401);
  assert.equal(f.calls.length, 1);
});

test('OTP attempts capped without forwarding upstream error bodies', async () => {
  const f = fixture({ tokenFailure: true }); const challenge = await f.code();
  for (let i = 0; i < 5; i++) {
    const result = await f.gateway.dispatch({ route: 'auth.token', payload: { phone, code: '1234' } }, sid(challenge));
    assert.equal(result.status, 401); assert.equal(JSON.stringify(result).includes('must not escape'), false);
  }
  assert.equal((await f.gateway.dispatch({ route: 'auth.token', payload: { phone, code: '1234' } }, sid(challenge))).status, 403);
  assert.equal(f.calls.length, 6);
});

test('issuer, client, JWT phone and canonical profile mismatches never create an authenticated session', async () => {
  for (const options of [{ claims: { iss: 'https://example.invalid' } }, { claims: { azp: 'other' } }, { claims: { phone_number: otherPhone } }, { profile: { phone: otherPhone } }, { profile: { id: '' } }]) {
    const f = fixture(options); const auth = await f.login();
    assert.equal(auth.result.status, 502); assert.equal(auth.token, undefined);
    assert.equal((await f.gateway.dispatch({ route: 'profile', token: 'forged' }, sid(auth.challenge))).status, 401);
  }
});

test('refresh uses only server-held token, rejects replay, and logout/expiry delete authority', async () => {
  const f = fixture(); const auth = await f.login();
  const before = f.calls.length;
  assert.equal((await f.gateway.dispatch({ route: 'auth.refresh', payload: { refreshHandle: 'foreign' } }, auth.session)).status, 401);
  assert.equal(f.calls.length, before);
  f.advance(3600001);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: auth.token }, auth.session)).status, 401);
  const refreshed = await f.gateway.dispatch({ route: 'auth.refresh', payload: { refreshHandle: auth.refresh } }, auth.session);
  assert.equal(refreshed.status, 200);
  assert.match(f.calls.at(-2).body, /refresh_token=provider-refresh-1/);
  assert.equal((await f.gateway.dispatch({ route: 'auth.refresh', payload: { refreshHandle: auth.refresh } }, auth.session)).status, 401);
  const loggedOut = await f.gateway.dispatch({ route: 'auth.logout' }, auth.session);
  assert.match(loggedOut.cookie, /Max-Age=0/);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: refreshed.data.access_token }, auth.session)).status, 401);
  assert.equal(f.calls.at(-1).method, 'GET', 'logout never revokes at provider');
});

test('logout while profile verification is pending cannot resurrect the session', async () => {
  let release;
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforeCall: async plan => { if (plan.url.endsWith('/profile')) { reached(); await blocked; } } });
  const challenge = await f.code();
  const session = sid(challenge);
  const pending = f.gateway.dispatch({ route: 'auth.token', payload: { phone, code: '1234' } }, session);
  await waiting;
  assert.equal((await f.gateway.dispatch({ route: 'auth.logout' }, session)).status, 200);
  release();
  const result = await pending;
  assert.equal(result.status, 401); assert.equal(result.cookie, undefined);
  assert.equal((await f.gateway.dispatch({ route: 'profile', token: 'forged' }, session)).status, 401);
});

test('production transport prohibits redirects, forwards only explicit headers and bounds response bodies', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const plan = { url: readPlan('profile').url, method: 'GET', token: 'provider-fixture', headers: { Cookie: 'not forwarded' } };
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, 'Bearer provider-fixture');
    assert.match(options.headers['X-Correlation-ID'], /^lk1-local-/);
    return new Response('{"id":"fixture"}', { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'must-not-forward' } });
  };
  assert.deepEqual(await productionTransport(plan), { status: 200, data: { id: 'fixture' } });
  globalThis.fetch = async () => new Response('<html>private error</html>', { status: 401 });
  assert.deepEqual(await productionTransport(plan), { status: 401, data: {} });
  globalThis.fetch = async () => new Response('<html>not JSON</html>');
  await assert.rejects(productionTransport(plan), /response type/);
  globalThis.fetch = async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(productionTransport(plan), /response size/);
  let attempts = 0;
  globalThis.fetch = async () => { attempts += 1; throw new Error('timeout fixture'); };
  await assert.rejects(productionTransport(plan));
  assert.equal(attempts, 1);
});

test('HTTP trust boundary rejects cross-site/missing origin, method, header, framing and malformed envelope without upstream', async () => {
  const f = fixture();
  const request = async overrides => {
    const body = JSON.stringify({ route: 'profile', token: 'fake' });
    const req = Readable.from([Buffer.from(body)]);
    req.method = 'POST'; req.headers = { host: '127.0.0.1:5180', origin: LOCAL_ORIGIN, 'x-lk1-preview': 'readonly-v1', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...overrides.headers };
    if (overrides.method) req.method = overrides.method;
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = value; } };
    await f.gateway.handle(req, res); return res;
  };
  for (const headers of [{ origin: undefined }, { origin: 'null' }, { origin: 'http://127.0.0.1:5173' }, { host: 'example.invalid:5180' }, { 'x-lk1-preview': undefined }, { 'content-type': 'text/plain' }, { 'content-length': '99999' }, { 'transfer-encoding': 'chunked' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await request({ headers })).status, 403);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) assert.equal((await request({ method })).status, 403);
  assert.equal((await request({})).status, 401);
  assert.equal(f.calls.length, 0);
});

test('browser bridge emits route enums, strips URL/headers and suppresses durable analytics', async () => {
  const calls = [];
  function MemoryStorage() { this.values = new Map(); }
  MemoryStorage.prototype.setItem = function (key, value) { this.values.set(key, value); };
  MemoryStorage.prototype.getItem = function (key) { return this.values.get(key) ?? null; };
  MemoryStorage.prototype.removeItem = function (key) { this.values.delete(key); };
  MemoryStorage.prototype.key = function (index) { return [...this.values.keys()][index] ?? null; };
  Object.defineProperty(MemoryStorage.prototype, 'length', { get() { return this.values.size; } });
  const storage = new MemoryStorage();
  storage.setItem('iSkq6G_lk_analytics_user_v1', 'old private profile');
  storage.setItem('padlhub_auth_token_v1', JSON.stringify({ token: 'provider-access-fixture' }));
  storage.setItem('padlhub_refresh_token_v1', JSON.stringify({ token: 'provider-refresh-fixture' }));
  storage.setItem(`padlhub.referral-window.v1.${phone}`, 'private subscription');
  function Xhr() {} Xhr.prototype.open = () => {};
  const context = { window: { localStorage: storage, fetch: async (...args) => { calls.push(args); return new Response('{}'); } },
    navigator: {}, Storage: MemoryStorage, XMLHttpRequest: Xhr, Request, URL, URLSearchParams,
    location: { href: `${LOCAL_ORIGIN}/lk_new`, origin: LOCAL_ORIGIN }, document: { addEventListener() {} }, Element: class {} };
  runInNewContext(readFileSync(new URL('../lk1_local_preview_browser.js', import.meta.url), 'utf8'), context);
  await context.window.fetch(`https://kc.vivacrm.ru/realms/clients/sms/authentication-code?phoneNumber=${phone}&channel=cascade&tenantKey=iSkq6G`);
  await context.window.fetch('https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile', { headers: { Authorization: 'Bearer local-display' } });
  assert.deepEqual(JSON.parse(calls[0][1].body), { route: 'auth.code', payload: { phone, channel: 'cascade' } });
  assert.deepEqual(JSON.parse(calls[1][1].body), { route: 'profile', payload: {}, token: 'local-display' });
  for (const call of calls) {
    assert.equal(call[0], '/__lk1_local/gateway'); assert.equal(call[1].method, 'POST');
    assert.equal(call[1].headers['X-LK1-Preview'], 'readonly-v1');
    assert.equal(JSON.stringify(call).includes('Bearer'), false);
  }
  assert.equal(storage.getItem('iSkq6G_lk_analytics_user_v1'), null);
  assert.equal(storage.getItem('padlhub_auth_token_v1'), null);
  assert.equal(storage.getItem('padlhub_refresh_token_v1'), null);
  storage.setItem('iSkq6G_lk_analytics_pending_v1', 'private');
  assert.equal(storage.values.has('iSkq6G_lk_analytics_pending_v1'), false);
  assert.equal(storage.values.has(`padlhub.referral-window.v1.${phone}`), false);
  for (const kind of ['order', 'last-seen', 'chat-last-read']) {
    const key = `padlhub.communities.${kind}.v1:fixture-client`;
    storage.setItem(key, 'private'); assert.equal(storage.values.has(key), false); assert.equal(storage.getItem(key), null);
  }
  storage.setItem('iSkq6G_pending_auth_consent_v1:fixture-binding', 'private consent');
  assert.equal(storage.getItem('iSkq6G_pending_auth_consent_v1:fixture-binding'), null);
  await context.window.fetch('https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile', { method: 'PATCH', body: '{}' });
  assert.equal(calls.at(-1)[0], '/__lk1_local/blocked');
});

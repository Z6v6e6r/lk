import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';

const clientSource = fs.readFileSync('src/utils/authConsents.ts', 'utf8');
const buildSource = fs.readFileSync('scripts/nodered_auth_consent_nodes/fn_auth_consent_build_upsert.js', 'utf8');
const prepareSource = fs.readFileSync('scripts/nodered_auth_consent_nodes/fn_auth_consent_prepare.js', 'utf8');
function storage() {
  const map = new Map();
  return { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,String(v)), removeItem: k => map.delete(k) };
}
function client({ status = 401, saved = storage(), crypto = webcrypto } = {}) {
  let token = 'fixture-subject:token-a';
  const calls = [], telemetry = [], timers = new Map();
  let timerId = 0;
  const module = { exports: {} };
  const context = { exports: module.exports, module, TextEncoder, crypto, URL, AbortController,
    window: { localStorage: saved, sessionStorage: storage(),
      setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id) },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: status >= 200 && status < 300, status }; },
    require: id => {
      if (id.endsWith('api_config')) return { SERV2: 'https://api.example.test', SERV2_FALLBACK: 'https://fallback.example.test', TENANT_KEY: 'fixture' };
      if (id.endsWith('authTokenStorage')) return { readAuthToken: () => token };
      if (id.endsWith('analytics')) return { trackAnalyticsEvent: () => {}, trackClientError: (...args) => telemetry.push(args) };
      if (id.endsWith('lkApiBaseUrls')) return { buildProjectUrlCandidates: () => ['https://api.example.test/lk/analytics/auth-consents', 'https://fallback.example.test/lk/analytics/auth-consents'] };
      if (id.endsWith('lkIdleDataGuard')) return { isLkIdleRequestPausedError: () => false };
      if (id.endsWith('vivaAuthJwt')) return { extractJwtStringClaim: value => value.split(':')[0] };
      throw new Error('Unexpected import: ' + id);
    },
  };
  vm.runInNewContext(ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { api: module.exports, calls, telemetry, timers, saved, setStatus: x => { status = x; }, setToken: x => { token = x; } };
}
const attempt = { authMethod: 'sms', bindingType: 'sms-phone', bindingValue: 'fixture-attempt' };

for (const status of [401, 403]) test(`consent ${status} keeps pending audit and stops same-token retries including reload`, async () => {
  const c = client({ status });
  await c.api.stageAuthConsents(attempt);
  assert.equal(await c.api.syncPendingAuthConsents(attempt), false);
  assert.equal(c.calls.length, 1, 'denial must not try fallback origin');
  assert.equal(c.api.hasPendingAuthConsents(), true);
  const pending = c.saved.getItem(c.saved.key(0));
  assert.match(pending, /deniedTokenFingerprint/);
  assert.ok(!pending.includes('token-a'));
  await c.api.syncPendingAuthConsents();
  await c.api.syncPendingAuthConsents();
  assert.equal(c.calls.length, 1, 'visibility/online retries must not reuse rejected token');
  assert.equal(c.telemetry.length, 1);
  const reload = client({ status, saved: c.saved });
  await reload.api.syncPendingAuthConsents();
  assert.equal(reload.calls.length, 0);
  c.setToken('fixture-subject:token-b'); c.setStatus(201);
  assert.equal(await c.api.syncPendingAuthConsents(), true);
  assert.equal(c.calls.length, 2);
  assert.equal(c.api.hasPendingAuthConsents(), false);
});

test('503 remains retryable, denial cancels pending timer, another account cannot consume audit', async () => {
  const c = client({ status: 503 });
  await c.api.stageAuthConsents(attempt);
  await c.api.syncPendingAuthConsents(attempt);
  assert.equal(c.calls.length, 2);
  assert.equal(c.timers.size, 1);
  c.setStatus(401); await c.api.syncPendingAuthConsents();
  assert.equal(c.timers.size, 0);
  c.setToken('other-subject:token-b'); c.setStatus(200);
  await c.api.syncPendingAuthConsents();
  assert.equal(c.calls.length, 3);
  assert.equal(c.api.hasPendingAuthConsents(), true);
});

test('without WebCrypto denial is gated in memory and weak token fingerprint is not stored', async () => {
  const c = client({ crypto: null });
  await c.api.stageAuthConsents(attempt); await c.api.syncPendingAuthConsents(attempt);
  await c.api.syncPendingAuthConsents();
  assert.equal(c.calls.length, 1);
  assert.ok(!c.saved.getItem(c.saved.key(0)).includes('deniedTokenFingerprint'));
});

test('concurrent consent triggers share one in-flight request', async () => {
  const c = client(); await c.api.stageAuthConsents(attempt);
  await Promise.all([c.api.syncPendingAuthConsents(attempt), c.api.syncPendingAuthConsents(attempt)]);
  assert.equal(c.calls.length, 1);
});

test('userinfo denial only emits fixed challenge enum and unverified boolean hints', () => {
  const warnings = [];
  const msg = { statusCode: 403, payload: 'fixture-private-response',
    headers: { 'www-authenticate': 'Bearer realm="fixture-private-realm", error="insufficient_scope", error_description="fixture-private-description"' },
    _authConsent: { tokenDiagnosticFlags: { openidPresent: false, expiredByClaim: true, clientMatchesClaim: 'fixture-private-claim' } } };
  const ports = new Function('msg', 'node', buildSource)(msg, { warn: v => warnings.push(JSON.parse(v)) });
  assert.equal(ports[0], null);
  assert.equal(ports[1].statusCode, 401, 'diagnostic hints must not change authorization');
  assert.equal(warnings[0].providerError, 'insufficient_scope');
  assert.deepEqual(warnings[0].unverifiedTokenHints, { openidPresent: false, expiredByClaim: true, clientMatchesClaim: null, issuerMatchesClaim: null });
  assert.ok(!JSON.stringify([warnings, ports[1].payload]).includes('fixture-private'));
});

test('unknown, non-Bearer, duplicate and oversized challenges never leak raw values', () => {
  for (const value of ['Basic error="invalid_token"', 'Bearer error="private_error"', 'Bearer error="invalid_token", error="insufficient_scope"', 'Bearer error="invalid_token", error="private_error"', 'Bearer ' + 'x'.repeat(2100)]) {
    const warnings = [];
    new Function('msg', 'node', buildSource)({ statusCode: 403, payload: null, headers: { 'www-authenticate': value }, _authConsent: {} }, { warn: v => warnings.push(JSON.parse(v)) });
    assert.equal(warnings[0].providerError, 'unknown');
    assert.ok(!JSON.stringify(warnings).includes('private_error'));
  }
});

test('prepare produces only unverified hints and retains provider validation as authority', () => {
  const body = { schemaVersion: 1, documentSetVersion: '2026-07-14', documents: [
    { id: 'public-offer', version: '2026-07-14', url: 'https://padlhub.ru/docs', accepted: true },
    { id: 'personal-data-policy', version: '2026-07-14', url: 'https://padlhub.ru/politica', accepted: true } ] };
  const claims = { scope: 'profile openid', exp: 1, azp: 'widget', iss: 'https://kc.vivacrm.ru/realms/clients', sub: 'fixture-private-subject' };
  const token = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.unverified';
  const prepared = new Function('msg', 'Buffer', prepareSource)({ payload: body, req: { headers: { authorization: 'Bearer ' + token } } }, Buffer)[0];
  assert.equal(prepared.method, 'GET');
  assert.deepEqual(prepared._authConsent.tokenDiagnosticFlags, { unverifiedHints: true, openidPresent: true, expiredByClaim: true, clientMatchesClaim: true, issuerMatchesClaim: true });
  assert.equal(prepared._authConsent.subject, undefined);
});

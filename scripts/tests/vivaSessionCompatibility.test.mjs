import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const config = { AUTH_RUNTIME_KEYCLOAK_BASE: 'https://identity.example.test', AUTH_RUNTIME_TENANT_KEY: 'fixture-tenant' };
const jwt = (claims = {}) => 'header.' + Buffer.from(JSON.stringify({ sub: 'fixture-subject', iss: config.AUTH_RUNTIME_KEYCLOAK_BASE + '/realms/clients', azp: 'widget', scope: 'openid profile', phone_number: 'fixture-phone', exp: Date.now() / 1000 + 10, ...claims })).toString('base64url') + '.signature';

function harness({ token = jwt(), refresh = 'fixture-refresh', response = { access_token: jwt(), refresh_token: 'rotated' }, ok = true, pending = null, location = '', beforeReply } = {}) {
  const state = [], effects = [], listeners = new Map(), timers = new Map(), requests = [], persisted = [], cache = new Map();
  let clears = 0, sessionClears = 0, consentClears = 0, consentSyncs = 0, nextTimer = 1;
  const storage = { readVivaAccessToken: () => token, readVivaRefreshToken: () => refresh,
    shouldRestoreVivaSession: value => !value && Boolean(refresh),
    persistVivaAuthTokens: (...args) => { persisted.push(args); [token,,refresh] = args; },
    clearVivaAuthTokens: () => { clears++; token = refresh = null; },
    clearVivaSessionTokens: () => { sessionClears++; token = refresh = null; } };
  const load = filename => {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const exports = {}; cache.set(filename, exports);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const require = id => {
      if (id === 'react') return { useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }), useState: initial => { const i = state.length; state.push(initial); return [initial, v => { state[i] = v; }]; }, useEffect: fn => effects.push(fn) };
      if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
      if (id.includes('authRuntime')) return config;
      if (id.endsWith('/authShared')) return { AuthContext: { Provider: 'provider' } };
      if (id.endsWith('/analytics') || id.endsWith('/pushNotifications')) return new Proxy({}, { get: () => () => {} });
      if (id.endsWith('/authConsents')) return { syncPendingAuthConsents: async () => { consentSyncs++; }, hasRetryablePendingAuthConsents: () => true, clearPendingAuthConsents: () => { consentClears++; }, stageAuthConsents: async () => true };
      if (id.endsWith('/vivaAuthStorage')) return storage;
      if (id.endsWith('/vivaOAuth')) return { isVivaOAuthCallbackUrl: load('src/utils/vivaOAuth.ts').isVivaOAuthCallbackUrl, readPendingVivaOAuth: () => pending, clearPendingVivaOAuth: () => {}, cleanupVivaOAuthCallbackUrl: () => {}, startVivaOAuthRedirect: () => {} };
      if (id.endsWith('/lkIdleDataGuard')) return { isLkIdleRequestPausedError: () => false };
      const base = path.resolve(path.dirname(filename), id);
      return load(fs.existsSync(base) ? base : base + '.ts');
    };
    const context = { exports, require, Buffer, atob, Date, URL, URLSearchParams,
      window: { location: { search: location, href: 'https://cabinet.example.test/' + location, origin: 'https://cabinet.example.test', pathname: '/', replace: () => {} }, setTimeout: cb => { const n = nextTimer++; timers.set(n, cb); return n; }, clearTimeout: n => timers.delete(n), addEventListener: (k, fn) => listeners.set('window:' + k, fn), removeEventListener: () => {} },
      document: { visibilityState: 'visible', addEventListener: (k, fn) => listeners.set('document:' + k, fn), removeEventListener: () => {} },
      fetch: async (url, options) => { requests.push({ url, options }); await beforeReply?.({ setTokens: (a, r) => { token = a; refresh = r; } }); return { ok, status: ok ? 200 : 400, json: async () => response }; } };
    vm.runInNewContext(compiled, context, { filename });
    return exports;
  };
  const helpers = load('src/utils/vivaSessionCompatibility.ts');
  const component = load('src/context/VivaAuthProvider.tsx').VivaAuthProvider({ children: null });
  return { helpers, state, requests, persisted, timers, runEffects: () => effects.forEach(fn => fn()), refresh: () => listeners.get('document:visibilitychange')(), login: component.props.value.login,
    counts: () => ({ clears, sessionClears, consentClears, consentSyncs }), token: () => token, setTokens: (a, r) => { token = a; refresh = r; } };
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

test('compatibility hints reject explicit scope/issuer/client/tenant changes without authorizing unknown claims', () => {
  const h = harness(); const check = h.helpers.vivaSessionProblem;
  for (const [claims, expected] of [[{ scope: 'profile' }, 'missing_openid'], [{ iss: 'https://other.example.test/realms/clients' }, 'issuer_mismatch'], [{ azp: 'other' }, 'client_mismatch'], [{ tenantKey: 'other' }, 'tenant_mismatch']]) assert.equal(check(jwt(claims)), expected);
  assert.equal(check('opaque'), 'invalid_claims');
  assert.equal(check(jwt({ scope: undefined, tenantKey: undefined })), null);
  assert.equal(check(jwt({ sub: 'other' }), jwt()), 'subject_mismatch');
});

test('old clients-realm SMS session without openid asks for login and makes no refresh/consent request', async () => {
  const h = harness({ token: jwt({ scope: 'profile' }) });
  assert.equal(h.state[0], false); assert.equal(h.state[1], ''); assert.equal(h.state[2], h.helpers.VIVA_REAUTH_MESSAGE);
  h.runEffects(); await settle();
  assert.equal(h.requests.length, 0); assert.equal(h.counts().consentSyncs, 0);
  assert.equal(h.counts().sessionClears, 1); assert.equal(h.counts().clears, 0); assert.equal(h.counts().consentClears, 0);
});

test('refresh retains its granted scopes and persists a compatible same-subject rotation', async () => {
  const h = harness(); h.runEffects(); h.refresh(); await settle();
  assert.equal(new URLSearchParams(h.requests[0].options.body).has('scope'), false);
  assert.equal(h.state[1], 'fixture-phone');
  assert.equal(h.persisted.length, 1); assert.equal(h.counts().clears, 0);
});

test('bad refresh scope, subject and provider invalid_scope stop without deleting pending evidence or rescheduling', async () => {
  for (const options of [{ response: { access_token: jwt({ scope: 'profile' }) } }, { response: { access_token: jwt({ sub: 'other' }) } }, { ok: false, response: { error: 'invalid_scope' } }]) {
    const h = harness(options); h.runEffects(); h.refresh(); await settle();
    assert.equal(h.persisted.length, 0); assert.equal(h.counts().sessionClears, 1);
    assert.equal(h.counts().clears, 0); assert.equal(h.counts().consentClears, 0); assert.equal(h.timers.size, 0);
    assert.equal(h.state[2], h.helpers.VIVA_REAUTH_MESSAGE);
  }
});

test('refresh response cannot overwrite or clear a newer session after logout/login', async () => {
  const newer = jwt({ sub: 'new-session' });
  const h = harness({ beforeReply: ({ setTokens }) => setTokens(newer, 'new-refresh') });
  h.runEffects(); h.refresh(); await settle();
  assert.equal(h.persisted.length, 0); assert.equal(h.token(), newer);
  assert.equal(h.counts().clears + h.counts().sessionClears, 0);
});

test('refresh-only restore remains supported and validates before persistence', async () => {
  const h = harness({ token: null }); h.runEffects(); await settle();
  assert.equal(h.requests.length, 1); assert.equal(h.persisted.length, 1);
  assert.equal(h.state[0], true);
});

test('fresh SMS response missing openid is not persisted or submitted as consent', async () => {
  const h = harness({ token: null, refresh: null, response: { access_token: jwt({ scope: 'profile' }) } });
  assert.equal(await h.login('fixture-phone', 'fixture-code'), false);
  assert.equal(h.persisted.length, 0); assert.equal(h.counts().consentSyncs, 0);
});

test('OAuth can replace an old incompatible cookie and retains social phone-completion behavior', async () => {
  const h = harness({ token: jwt({ scope: 'profile' }), location: '?code=fixture-code&state=fixture-state', pending: { state: 'fixture-state', provider: 'yandex', codeVerifier: 'fixture-verifier', redirectUri: 'https://cabinet.example.test', returnTo: '' }, response: { access_token: jwt({ phone_number: undefined }) } });
  h.runEffects(); await settle();
  assert.equal(h.persisted.length, 1); assert.equal(h.state[0], false); assert.equal(h.state[3], true); assert.equal(h.state[2], null);
});

test('a fresh OAuth response without openid preserves its pending consent', async () => {
  const h = harness({ token: null, refresh: null, location: '?code=fixture-code&state=fixture-state', pending: { state: 'fixture-state', provider: 'yandex' }, response: { access_token: jwt({ scope: 'profile' }) } });
  h.runEffects(); await settle(); assert.equal(h.persisted.length, 0); assert.equal(h.counts().consentClears, 0);
});


test('mount checks current storage before clearing an old incompatible render snapshot', async () => {
  const h = harness({ token: jwt({ scope: 'profile' }) });
  const newer = jwt({ sub: 'new-session' });
  h.setTokens(newer, 'new-refresh'); h.runEffects(); await settle();
  assert.equal(h.token(), newer); assert.equal(h.counts().sessionClears, 0);
  assert.equal(h.state[0], true); assert.equal(h.state[2], null);
});

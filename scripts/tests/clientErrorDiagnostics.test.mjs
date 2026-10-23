import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import * as core from '../../src/utils/errorDiagnosticsCore.mjs';
import * as budget from '../../src/utils/diagnosticBudget.mjs';
const read = p => fs.readFileSync(p, 'utf8');
function load(source, mocks, globals = {}) {
 const exports = {};
 const compiled = ts.transpileModule(source.replaceAll('import.meta.env', '__env'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 const context = vm.createContext({ exports, require: name => { assert(Object.hasOwn(mocks, name), name); return mocks[name]; }, __env: {}, crypto: { randomUUID }, performance, Date, Map, Set, JSON, Headers, FormData, URL, AbortController, setTimeout, clearTimeout, ...globals });
 vm.runInContext(compiled, context); return exports;
}
const helpers = load(read('src/utils/errorDiagnostics.ts'), { './errorDiagnosticsCore.mjs': core });
test('pending resend keeps event ID; legacy preserves untrusted device time; no raw envelope reaches transport/Firebase', async () => {
 const storage = new Map(), bodies = [], firebase = [];
 const key = 'synthetic_lk_analytics_pending_v1';
 storage.set(key, JSON.stringify([JSON.stringify({ event: 'client_error', timestamp: '2000-01-01T00:00:00.000Z', sessionId: 'private-session', payload: { errorStack: 'private-stack', context: { url: 'private-url' } } })]));
 let delivery = false;
 const api = load(read('src/utils/analytics.ts'), {
   react: { useEffect() {} }, './errorDiagnostics': helpers, './errorDiagnosticsCore.mjs': core, './diagnosticBudget.mjs': budget,
   '../consts/api_config': { SERV2: 'https://synthetic.invalid', TENANT_KEY: 'synthetic' },
   './firebase': { trackFirebaseAnalyticsEvent: (...args) => firebase.push(args) },
   './lkApiBaseUrls': { resolveLkApiBaseUrlCandidates: () => ['https://synthetic.invalid'], buildProjectUrlCandidates: v => [v] },
   './lkIdleDataGuard': { isLkIdleRequestPaused: () => false },
 }, { window: { location: { href: 'https://example.invalid/?private-query', pathname: '/', search: '?private-query' }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, val) => storage.set(key, val) } },
      fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: delivery, status: delivery ? 200 : 503 }; } });
 const tick = () => new Promise(resolve => setTimeout(resolve, 10));
 api.trackClientError('api.request_http_error', Error('private-error'), { httpStatus: 502, url: 'private-url' }); await tick();
 const first = bodies[0].payload;
 assert.equal(first.deviceEventTime, '2000-01-01T00:00:00.000Z'); assert.equal(first.deviceClockTrusted, false); assert.equal(first.legacyEvent, true);
 const queued = JSON.parse(storage.get(key)); assert(queued.length >= 1);
 delivery = true;
 api.trackClientError('api.request_http_error', Error('private-error'), { httpStatus: 502 }); await tick();
 const replays = bodies.filter(b => b.payload.diagnosticEventId === first.diagnosticEventId);
 assert(replays.length >= 2); assert.equal(replays[0].payload.deviceEventTime, replays[1].payload.deviceEventTime);
 assert(!JSON.stringify(bodies).includes('private')); assert.equal(firebase.length, 0);
 assert(bodies.every(b => !('sessionId' in b) && !('page' in b) && !('device' in b) && !('user' in b)));
});
test('raw API errors have one logical operation, distinct attempts, proven abort cause, unchanged requests/results', async () => {
 const source = read('src/utils/apiClient.ts');
 const snippet = source.slice(source.indexOf('async function rawRequest<T>'), source.indexOf('\nexport async function request<T>')) + '\nexports.rawRequest = rawRequest;';
 const events = [], requests = [], requestId = randomUUID();
 let failNetwork = false;
 const module = load(snippet, {}, {
  API_BASE: 'https://synthetic.invalid', requestChangesSubscriptions: () => false, invalidateSubscriptionSnapshot() {},
  trackClientError: (source, error, context) => events.push(helpers.clientDiagnostic(context)),
  UUID: core.UUID, diagnosticId: randomUUID, routeTemplate: core.routeTemplate, abortCause: helpers.abortCause,
  isLkIdleRequestPausedError: () => false, isRecord: v => v && typeof v === 'object', pickString: () => null,
  window: { location: { href: 'https://synthetic.invalid' } },
  fetch: async (url, options) => { requests.push({ url, options }); if (failNetwork) throw Error('private transport');
    return { ok: false, status: 409, headers: new Headers({ 'Content-Type': 'application/json', 'X-LK-Request-ID': requestId }), json: async () => ({ code: 'GAME_PATCH_VERSION_CONFLICT', message: 'private' }) }; },
 });
 const diagnosticContext = { logicalOperation: randomUUID(), attempt: 0 };
 const first = await module.rawRequest('/lk/games/private-id?private=hidden', { method: 'PATCH', diagnosticContext, body: '{}' });
 await module.rawRequest('/lk/games/private-id?private=hidden', { method: 'PATCH', diagnosticContext, body: '{}' });
 assert.equal(first.status, 409); assert.equal(events[0].logicalOperation, events[1].logicalOperation);
 assert.notEqual(events[0].requestId, events[1].requestId); assert.equal(events[0].attempt, 1); assert.equal(events[1].attempt, 2);
 assert.equal(events[0].serverRequestId, requestId);
 for (const cause of ['deadline', 'scope_disposed', 'explicit_cancel', 'other']) {
  const controller = new AbortController(); controller.abort(cause); failNetwork = true;
  await module.rawRequest('/lk/subscriptions/game-price-preview', { signal: controller.signal });
  assert.equal(events.at(-1).abortCause, cause === 'other' ? 'unknown' : cause);
 }
 assert.equal(requests.length, 6); assert(!JSON.stringify(events).includes('private'));
 assert(requests.every(r => !r.options.headers.has('X-LK-Request-ID') && !('diagnosticContext' in r.options)));
});
test('older browser uses CSPRNG fallback; unavailable randomness is explicitly counted', () => {
 const old = load(read('src/utils/errorDiagnostics.ts'), { './errorDiagnosticsCore.mjs': core }, { crypto: { getRandomValues(bytes) { bytes.fill(17); return bytes; } } });
 assert.match(old.diagnosticId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 const unavailable = load(read('src/utils/errorDiagnostics.ts'), { './errorDiagnosticsCore.mjs': core }, { crypto: {} });
 assert.equal(unavailable.clientDiagnostic(), null); assert.equal(unavailable.diagnosticHealth().unavailable, 1);
});
test('legacy migration keeps a session-stable event ID even if localStorage writes fail', async () => {
 const legacy = JSON.stringify([JSON.stringify({ event: 'client_error', timestamp: '2000-01-01T00:00:00.000Z', payload: { raw: 'private' } })]);
 const sent = [];
 const api = load(read('src/utils/analytics.ts'), {
  react: { useEffect() {} }, './errorDiagnostics': helpers, './errorDiagnosticsCore.mjs': core, './diagnosticBudget.mjs': budget,
  '../consts/api_config': { SERV2: 'https://synthetic.invalid', TENANT_KEY: 'synthetic' },
  './firebase': { trackFirebaseAnalyticsEvent() {} },
  './lkApiBaseUrls': { resolveLkApiBaseUrlCandidates: () => ['https://synthetic.invalid'], buildProjectUrlCandidates: v => [v] },
  './lkIdleDataGuard': { isLkIdleRequestPaused: () => false },
 }, { window: { location: {}, localStorage: { getItem: key => key.endsWith('pending_v1') ? legacy : null, setItem() { throw Error('quota'); } } },
 fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } });
 api.trackClientError('window.error', null); await new Promise(r => setTimeout(r, 10));
 api.trackClientError('window.error', null); await new Promise(r => setTimeout(r, 10));
 const migrated = sent.filter(e => e.payload.legacyEvent); assert.equal(migrated.length, 2);
 assert.equal(migrated[0].payload.diagnosticEventId, migrated[1].payload.diagnosticEventId);
 assert(!JSON.stringify(sent).includes('private'));
});
test('browser error burst bounds online delivery and retains exact aggregate suppression count', async () => {
 const sent = [];
 const api = load(read('src/utils/analytics.ts'), {
  react: { useEffect() {} }, './errorDiagnostics': helpers, './errorDiagnosticsCore.mjs': core, './diagnosticBudget.mjs': budget,
  '../consts/api_config': { SERV2: 'https://synthetic.invalid', TENANT_KEY: 'synthetic' },
  './firebase': { trackFirebaseAnalyticsEvent() {} },
  './lkApiBaseUrls': { resolveLkApiBaseUrlCandidates: () => ['https://synthetic.invalid'], buildProjectUrlCandidates: v => [v] },
  './lkIdleDataGuard': { isLkIdleRequestPaused: () => false },
 }, { window: { location: {}, localStorage: { getItem: () => null, setItem() {} } },
 fetch: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } });
 for (let i = 0; i < 10000; i++) api.trackClientError('window.error', Error('private'));
 api.flushClientDiagnosticSuppression(); await new Promise(r => setTimeout(r, 10));
 assert.equal(sent.length, 121);
 const aggregate = sent.find(e => e.payload.aggregate);
 assert.equal(aggregate.payload.suppressedCount, 9880); assert.equal(aggregate.payload.requestId, undefined);
 assert(!JSON.stringify(sent).includes('private'));
});

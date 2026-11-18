import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as core from '../../src/utils/errorDiagnosticsCore.mjs';
import * as trace from '../../src/utils/splitLeaveTrace.mjs';
import * as budget from '../../src/utils/diagnosticBudget.mjs';
import { createDiagnostics } from '../diagnostics/runtime.mjs';
import { schemaV1 } from '../diagnostics/schema.mjs';
const read = path => fs.readFileSync(path, 'utf8');
const privateValue = 'SENSITIVE_TEST_SENTINEL';
function load(source, mocks = {}, globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(source.replaceAll('import.meta.env', '__env'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = vm.createContext({ exports, require: name => {
    assert(Object.hasOwn(mocks, name), name); return mocks[name];
  }, __env: { VITE_DIAGNOSTIC_BUILD: 'a'.repeat(40) }, crypto: { randomUUID },
  performance, Date, Map, Set, JSON, URL, Headers, FormData, AbortController, setTimeout, clearTimeout, ...globals });
  vm.runInContext(compiled, context); return exports;
}
const helpers = load(read('src/utils/errorDiagnostics.ts'), { './errorDiagnosticsCore.mjs': core });
const event = leaveTrace => helpers.clientDiagnostic({ method: 'POST', routeTemplate: '/lk/games/:gameId/split/leave',
  stage: 'leave_initiator', code: 'SPLIT_LEAVE_INITIATED', logicalOperation: randomUUID(), leaveTrace });

test('V8/WebKit frames contain only fixed asset enum and bounded source coordinates', () => {
  const raw = `Error: ${privateValue}\n    at ${privateValue} (https://private.invalid/release/games.js?token=${privateValue}:1:12345)\n${privateValue}@https://private.invalid/bundle.js#${privateValue}:2:34\n    at fn (https://private.invalid/${privateValue}.js:1:999)\n    at fn (https://private.invalid/games.js:70000000001:1)\n    at fn (https://private.invalid/src/utils/apiClient.ts:4329:3)`;
  assert.deepEqual(trace.leaveStackFrames(raw), [
    { asset: 'games.js', line: 1, column: 12345 }, { asset: 'bundle.js', line: 2, column: 34 },
    { asset: 'apiClient.ts', line: 4329, column: 3 },
  ]);
  assert.equal(trace.leaveStackFrames('Error\n' + ' at f (https://private.invalid/games.js:1:2)\n'.repeat(40)).length, 8);
  assert.deepEqual(trace.leaveStackFrames(undefined), []);
  assert.deepEqual(trace.leaveStackFrames('x'.repeat(8192) + raw), []);
  assert(!JSON.stringify(trace.leaveStackFrames(raw)).includes(privateValue));
});

test('recorder bounds history/age/rate, handles clock rollback and keeps no DOM/raw values', () => {
  let now = 1000;
  const state = trace.createLeaveRecorder(() => now);
  state.record(privateValue, 'click', true);
  for (let i = 0; i < 20; i++) state.record('GAME_JOIN', 'click', true);
  now += 500;
  const first = state.capture(`Error: ${privateValue}`, 'visible');
  assert.equal(first.actions.length, 8); assert.equal(first.actions[0].ageMs, 500);
  for (let i = 0; i < 5; i++) assert(state.capture('', 'hidden'));
  assert.equal(state.capture('', 'visible'), null);
  now += 60000; assert(state.capture('', 'hidden'));
  now += 120001; assert.deepEqual(state.capture('', 'visible').actions, []);
  now = 0; assert.deepEqual(state.capture('', 'visible').actions, []);
  assert(!JSON.stringify(first).includes(privateValue));
});

test('nested closed schema is idempotent across queue and server intake; arbitrary strings never survive', () => {
  const dirty = { frames: [{ asset: 'games.js', line: 1, column: 23, url: privateValue, function: privateValue },
    { asset: privateValue, line: 1, column: 1 }], actions: [{ action: 'GAME_LEAVE', kind: 'click', ageMs: 9,
    trusted: true, text: privateValue, value: privateValue, href: privateValue, target: privateValue }], visibility: privateValue,
  stack: privateValue, token: privateValue, clientId: privateValue };
  const safe = event(dirty);
  assert.deepEqual(safe.leaveTrace, { frames: [{ asset: 'games.js', line: 1, column: 23 }],
    actions: [{ action: 'GAME_LEAVE', kind: 'click', ageMs: 9, trusted: true }], visibility: 'UNKNOWN' });
  assert.deepEqual(core.sanitizeEvent(JSON.parse(JSON.stringify(safe))), safe);
  const server = createDiagnostics({ release: 'b'.repeat(40) });
  const envelope = server.clientEnvelope({ event: 'client_error', payload: safe });
  assert.deepEqual(envelope.payload.leaveTrace, safe.leaveTrace);
  assert(!JSON.stringify(envelope).includes(privateValue));
  for (const mismatch of [{ method: 'GET' }, { source: 'node_red' }, { code: 'CLIENT_HTTP_ERROR' },
    { stage: 'api_request' }, { routeTemplate: '/lk/games/:gameId' }, { eventKind: 'stage' }]) {
    assert.equal(core.sanitizeEvent({ ...safe, ...mismatch }).leaveTrace, undefined);
  }
  assert.equal(schemaV1().properties.leaveTrace.additionalProperties, false);
  assert.equal(schemaV1().allOf[1].then.properties.code.const, 'SPLIT_LEAVE_INITIATED');
});

function browserFixture(send = () => {}, sharedDocument) {
  const listeners = new Map();
  class Element {
    constructor(marker, inside = true) { this.marker = marker; this.inside = inside; }
    closest(selector) { return selector === 'button, a, [role="button"]' || this.inside ? this : null; }
    getAttribute() { return this.marker; }
    get textContent() { throw Error('must not read text'); }
    get value() { throw Error('must not read input'); }
  }
  const document = sharedDocument ?? { visibilityState: 'visible', addEventListener(kind, fn, options) {
    assert.equal(options.capture, true); assert.equal(options.passive, true); listeners.set(kind, fn);
  } };
  const api = load(read('src/utils/splitLeaveDiagnostics.ts'), {
    './analytics': { trackAnalyticsEvent: send }, './errorDiagnostics': helpers,
    './splitLeaveTrace.mjs': trace,
  }, { document, Element });
  return { api, document, listeners, Element };
}

test('main/games share one recorder/listener set/budget; observed controls have no text/key contents', () => {
  const sent = [], first = browserFixture((_kind, payload) => sent.push(payload));
  first.api.installSplitLeaveDiagnostics(); first.api.installSplitLeaveDiagnostics();
  const second = browserFixture((_kind, payload) => sent.push(payload), first.document);
  second.api.installSplitLeaveDiagnostics();
  assert.equal(first.listeners.size, 3);
  const click = (marker, extra = {}) => first.listeners.get('click')({ target: new first.Element(marker),
    type: 'click', isTrusted: true, ...extra });
  click('GAME_JOIN');
  click(privateValue);
  first.listeners.get('keydown')({ target: new first.Element('GAME_LEAVE'), type: 'keydown', key: privateValue });
  click('GAME_LEAVE'); second.api.recordSplitLeaveConfirmation(true);
  first.api.captureSplitLeaveInitiator('/lk/games/private-game/split/leave?token=private', 'POST', randomUUID());
  assert.deepEqual(sent[0].leaveTrace.actions.map(row => row.action), ['GAME_JOIN', 'OTHER_CONTROL', 'GAME_LEAVE', 'CONFIRM_ACCEPT']);
  assert.equal(sent[0].logicalOperation.length, 36);
  for (let i = 0; i < 20; i++) second.api.captureSplitLeaveInitiator('/lk/games/private/split/leave', 'POST');
  assert.equal(sent.length, 6); assert(!JSON.stringify(sent).includes(privateValue));
  assert(!JSON.stringify(sent).includes('private-game'));
});

test('only exact leave POST emits, outside controls ignored, missing recorder/throwing transport cannot escape', () => {
  let emitted = 0;
  const { api, listeners, Element } = browserFixture(() => { emitted++; throw Error(privateValue); });
  api.captureSplitLeaveInitiator('/lk/games/private/split/leave', 'POST'); assert.equal(emitted, 0);
  api.installSplitLeaveDiagnostics();
  listeners.get('click')({ target: new Element(null, false), type: 'click', isTrusted: true });
  for (const [url, method] of [['/lk/games/private/split/leave', 'GET'], ['/lk/games/private/split/join', 'POST'],
    ['/lk/games/private/split/leave/extra', 'POST'], ['/lk/games/private', 'PATCH']]) api.captureSplitLeaveInitiator(url, method);
  assert.equal(emitted, 0);
  assert.doesNotThrow(() => api.captureSplitLeaveInitiator('/lk/games/private/split/leave', 'POST'));
  assert.equal(emitted, 1);
  const noDocument = load(read('src/utils/splitLeaveDiagnostics.ts'), { './analytics': {},
    './errorDiagnostics': helpers, './splitLeaveTrace.mjs': trace });
  assert.doesNotThrow(() => noDocument.installSplitLeaveDiagnostics());
  assert.doesNotThrow(() => noDocument.captureSplitLeaveInitiator('/lk/games/private/split/leave', 'POST'));
});

test('actual analytics wire + failed-delivery queue + replay contain no auth, cookies, Firebase or user envelope', async () => {
  const bodies = [], storage = new Map(), firebase = [];
  let success = false;
  const analytics = load(read('src/utils/analytics.ts'), {
    react: { useEffect() {} }, './errorDiagnostics': helpers, './errorDiagnosticsCore.mjs': core,
    './diagnosticBudget.mjs': budget, '../consts/api_config': { SERV2: 'https://synthetic.invalid', TENANT_KEY: 'synthetic' },
    './firebase': { trackFirebaseAnalyticsEvent: (...args) => firebase.push(args) },
    './lkApiBaseUrls': { resolveLkApiBaseUrlCandidates: () => ['https://synthetic.invalid'], buildProjectUrlCandidates: v => [v] },
    './lkIdleDataGuard': { isLkIdleRequestPaused: () => false },
  }, { window: { location: { href: privateValue, pathname: '/', search: privateValue },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } },
  fetch: async (_url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.keepalive, true);
    assert(!Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)));
    bodies.push(JSON.parse(options.body)); return { ok: success, status: success ? 200 : 503 };
  } });
  const safe = event({ frames: [{ asset: 'games.js', line: 1, column: 42, raw: privateValue }], actions: [] });
  analytics.trackAnalyticsEvent('client_error', safe);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(bodies.length); assert([...storage.values()].some(v => v.includes('leaveTrace')));
  success = true; analytics.trackAnalyticsEvent('client_error', safe);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert(bodies.length >= 3); assert.equal(firebase.length, 0);
  assert(bodies.every(body => Object.keys(body).sort().join(',') === 'event,payload,timestamp'));
  assert(bodies.every(body => body.payload.leaveTrace.frames[0].column === 42));
  assert(!JSON.stringify([bodies, [...storage.values()]]).includes(privateValue));
});

test('request captures once synchronously before dispatch, preserves business options/result and does not await telemetry', async () => {
  const source = read('src/utils/apiClient.ts');
  const snippet = source.slice(source.indexOf('export async function request<T>('), source.indexOf('\nexport function getServ2Origin'));
  const calls = [], businessOptions = { method: 'POST', auth: true, retries: 0,
    body: JSON.stringify({ reason: 'PLAYER_LEFT', token: privateValue }), baseUrl: 'https://private.invalid' };
  const result = { data: { state: 'DONE' }, status: 200 };
  const module = load(snippet, {}, { UUID: core.UUID, diagnosticId: randomUUID,
    captureSplitLeaveInitiator: (...args) => { calls.push(['trace', ...args]); return new Promise(() => {}); },
    resolveRequestCacheConfig: () => null,
    executeRequestWithResolvedBaseUrls: async (url, options) => { calls.push(['business', url, options]); return result; },
  });
  const returned = module.request('/lk/games/private/split/leave', businessOptions);
  assert.equal(calls[0][0], 'trace'); assert.equal(calls[1][0], 'business');
  assert.equal(await returned, result);
  const actual = calls[1][2];
  for (const [key, value] of Object.entries(businessOptions)) assert.equal(actual[key], value);
  assert.equal(calls[0].length, 4); assert.equal(calls[0][3], actual.diagnosticContext.logicalOperation);
  assert.equal(calls[1][1], '/lk/games/private/split/leave');
});

test('server middleware for newly named route observes response only; no changed request/body/result or replay', () => {
  const sink = [], server = createDiagnostics({ sink: item => sink.push(item), release: 'a'.repeat(40) });
  const req = { path: '/lk/games/private/split/leave', method: 'POST', headers: { authorization: privateValue },
    body: { clientId: privateValue }, on() {} };
  const res = new EventEmitter(); res.statusCode = 200;
  const headers = {}; res.setHeader = (key, value) => { headers[key] = value; }; res.getHeader = key => headers[key];
  let ended = 0; res.end = () => { ended++; };
  let next = 0; const before = JSON.stringify(req);
  server.middleware(req, res, () => next++);
  res.end(); res.emit('finish');
  assert.equal(ended, 1); assert.equal(sink.length, 3);
  assert(core.UUID.test(headers['X-LK-Request-ID']));
  assert.equal(next, 1); assert.equal(JSON.stringify(req), before);
  assert(!JSON.stringify(sink).includes(privateValue));
  assert(sink.every(row => row.routeTemplate === '/lk/games/:gameId/split/leave'));
});

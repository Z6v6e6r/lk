import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function loader({ rejectTelemetry = false } = {}) {
  const listeners = {};
  const calls = [];
  const scripts = [];
  const location = { pathname: '/lk_dev', search: '?authMode=viva', href: 'https://padlhub.ru/lk_dev' };
  const window = { location, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const context = {
    window, location, URLSearchParams, Date,
    navigator: { sendBeacon: () => { throw new Error('Beacon must not be used'); } },
    document: { head: { appendChild: (script) => scripts.push(script) }, createElement: () => ({}) },
    setTimeout: () => 1, clearTimeout: () => {},
    fetch: (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'POST') {
        return rejectTelemetry ? Promise.reject(new Error('Network down')) : Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true, json: async () => ({ version: 'test-version' }) });
    },
  };
  const source = fs.readFileSync('docs/tilda-loader.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(source, context);
  return { window, listeners, calls, scripts, posts: () => calls.filter((call) => call.options?.method === 'POST') };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('loader still mounts DEV bundle with version and charset', async () => {
  const h = loader();
  await settle();
  assert.equal(h.scripts.length, 1);
  assert.match(h.scripts[0].src, /\/bundle-dev\.js\?v=test-version&charset=utf-8$/);
  assert.equal(h.scripts[0].charset, 'utf-8');
});

test('image errors are not bootstrap runtime errors; script failures remain visible', () => {
  const h = loader();
  h.listeners.error({ target: { tagName: 'IMG', src: 'https://example.test/missing' } });
  assert.equal(h.posts().length, 0);
  h.listeners.error({ target: { tagName: 'SCRIPT', src: 'https://example.test/app.js' } });
  const post = h.posts()[0];
  assert.equal(JSON.parse(post.options.body).kind, 'window.resource_error');
  assert.equal(post.options.credentials, 'omit');
  assert.equal(post.options.keepalive, true);
});

test('loader deduplicates, bounds diagnostics and hands runtime tracking to the widget', () => {
  const h = loader();
  h.listeners.error({ message: 'broken', filename: 'app.js', lineno: 1 });
  h.listeners.error({ message: 'broken', filename: 'app.js', lineno: 1 });
  assert.equal(h.posts().length, 1);
  h.window.__LK_GLOBAL_ERROR_TRACKING_INSTALLED__ = true;
  h.listeners.error({ message: 'after init' });
  h.listeners.unhandledrejection({ reason: 'after init rejection' });
  assert.equal(h.posts().length, 1);
  h.window.__LK_GLOBAL_ERROR_TRACKING_INSTALLED__ = false;
  for (let i = 0; i < 40; i++) h.listeners.error({ message: `failure ${i}` });
  assert.equal(h.posts().length, 20);
});

test('failed diagnostic delivery does not leak an unhandled rejection', async () => {
  const h = loader({ rejectTelemetry: true });
  h.listeners.unhandledrejection({ reason: 'real rejection' });
  await settle();
  assert.equal(h.posts().length, 1);
});

function extractedFunction(path, start, end, globals) {
  const source = fs.readFileSync(path, 'utf8');
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  const code = ts.transpileModule(source.slice(from, to).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return vm.runInNewContext(`${code}\n${start.match(/function (\w+)/)[1]}`, globals);
}

test('community logo absence produces no requests; explicit legacy and modern URLs survive', () => {
  const candidates = extractedFunction('src/utils/communityApi.ts', 'export function buildCommunityLogoCandidates(', 'function decodeInviteSegment', {
    toAbsoluteCommunityAssetUrl: (value) => value ? (value.startsWith('/') ? `https://example.test${value}` : value) : null,
  });
  assert.deepEqual(Array.from(candidates({ id: 'community-no-logo', logo: null })), []);
  const legacy = '/lk/media/community-logo-legacy/existing/thumb';
  assert.deepEqual(Array.from(candidates({ id: 'community', logoThumbUrl: legacy, logoUrl: '/logo.png', logo: legacy })), [
    `https://example.test${legacy}`, 'https://example.test/logo.png',
  ]);
});

function sender(fetch, paused = false) {
  return extractedFunction('src/utils/analytics.ts', 'async function sendEvent(', 'async function flushPendingEvents(', {
    fetch, isLkIdleRequestPaused: () => paused,
    resolveAnalyticsEndpoints: () => ['https://example.test/lk/analytics/events'],
    NON_RETRYABLE_HTTP_STATUSES: new Set([400, 401, 403, 404, 405, 413, 415, 422]),
    navigator: { sendBeacon: () => { throw new Error('Must observe HTTP delivery'); } },
  });
}

test('bundle telemetry omits credentials and observes HTTP success', async () => {
  const send = sender(async (_url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.keepalive, true);
    assert.equal(options.body, '{}');
    return { ok: true, status: 201 };
  });
  const result = await send('{}');
  assert.equal(result.delivered, true);
  assert.equal(result.status, 201);
});

test('bundle telemetry preserves network/server retry, permanent rejection and idle pause', async () => {
  const network = await sender(async () => { throw new Error('offline'); })('{}');
  assert.equal(network.delivered, false);
  assert.equal(network.retryable, true);
  const server = await sender(async () => ({ ok: false, status: 503 }))('{}');
  assert.equal(server.retryable, true);
  const denied = await sender(async () => ({ ok: false, status: 403 }))('{}');
  assert.equal(denied.retryable, false);
  const paused = await sender(() => { throw new Error('Must not fetch'); }, true)('{}');
  assert.equal(paused.paused, true);
});

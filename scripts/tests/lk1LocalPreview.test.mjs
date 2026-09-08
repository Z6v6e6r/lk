import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { localPreviewPlugin, PREVIEW_CSP } from '../lk1_local_preview.mjs';

function middlewareHarness() {
  let handler;
  localPreviewPlugin().configureServer({ middlewares: { use(value) { handler = value; } } });
  return (url, { method = 'GET', headers = {} } = {}) => {
    const result = { headers: {}, next: false };
    const response = {
      setHeader(key, value) { result.headers[key] = value; },
      writeHead(status, values) { result.status = status; Object.assign(result.headers, values); },
      end(body) { result.body = body; },
    };
    handler({ url, method, headers: { host: '127.0.0.1:5180', ...headers } }, response, () => { result.next = true; });
    return result;
  };
}

test('all business/auth methods are rejected, including status POST', () => {
  const request = middlewareHarness();
  for (const path of ['/lk/games', '/__lk1_local/status', '/realms/clients/protocol/openid-connect/token']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = request(path, { method });
      assert.equal(response.status, 403);
      assert.equal(response.next, false);
    }
  }
});

test('cross-site and rebound hosts cannot reach local resources', () => {
  const request = middlewareHarness();
  for (const headers of [{ origin: 'https://example.invalid' }, { origin: 'null' }, { host: 'example.invalid:5180' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(request('/__lk1_local/status', { headers }).status, 403);
  }
});

test('status exposes aggregate counters only, never request values', () => {
  const request = middlewareHarness();
  request('/__lk1_local/blocked?private=test-value');
  const response = request('/__lk1_local/status');
  assert.deepEqual(JSON.parse(response.body), { mode: 'offline', upstreamConnections: 0, blockedRequests: 1 });
  assert.equal(response.body.includes('test-value'), false);
});

test('shell confines navigation and app bootstrap precedes modules', () => {
  const request = middlewareHarness();
  const shell = request('/');
  assert.match(shell.body, /sandbox="allow-scripts allow-same-origin allow-forms"/);
  assert.doesNotMatch(shell.body, /allow-popups|allow-top-navigation|allow-downloads/);
  assert.match(PREVIEW_CSP, /frame-src 'self'/);
  assert.match(PREVIEW_CSP, /form-action 'self'/);
  assert.match(PREVIEW_CSP, /worker-src 'none'/);
  assert.match(PREVIEW_CSP, /connect-src 'self' ws:\/\/127\.0\.0\.1:5180/);
  assert.doesNotMatch(PREVIEW_CSP, /https:|\*/);
  const direct = request('/lk_new', { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.Location, '/');
  const script = localPreviewPlugin().transformIndexHtml.handler()[0];
  assert.equal(script.injectTo, 'head-prepend');
  assert.equal(script.attrs.type, undefined);
});

test('browser guard never forwards external URLs, bodies or auth headers', async () => {
  const calls = [];
  const listeners = {};
  const window = { fetch: async (...args) => { calls.push(args); return new Response('{}', { status: 403 }); } };
  function Xhr() {}
  Xhr.prototype.open = () => { throw new Error('unexpected native XHR'); };
  const context = {
    window, navigator: {}, XMLHttpRequest: Xhr, Request, URL, location: { href: 'http://127.0.0.1:5180/lk_new', origin: 'http://127.0.0.1:5180' },
    document: { addEventListener(name, fn) { listeners[name] = fn; } }, Element: class {},
  };
  runInNewContext(readFileSync(new URL('../lk1_local_preview_browser.js', import.meta.url), 'utf8'), context);
  for (const [url, method] of [
    ['https://example.invalid/realms/clients/sms/authentication-code?phoneNumber=test', 'GET'],
    ['https://example.invalid/token', 'POST'],
    ['https://example.invalid/lk/games', 'PATCH'],
    ['/lk/games', 'DELETE'],
  ]) {
    await window.fetch(url, { method, headers: { Authorization: 'Bearer example' }, ...(method !== 'GET' ? { body: 'private-payload' } : {}) });
  }
  for (const call of calls) {
    assert.equal(call[0], '/__lk1_local/blocked');
    assert.deepEqual(JSON.parse(JSON.stringify(call[1])), { method: 'GET', credentials: 'omit', cache: 'no-store' });
  }
  assert.equal(context.navigator.sendBeacon('https://example.invalid', 'private'), false);
  assert.equal(window.open('https://example.invalid'), null);
  assert.throws(() => new Xhr().open('GET', 'https://example.invalid'), /EXTERNAL_ACCESS_DISABLED/);
  assert.equal(typeof listeners.click, 'function');
});

test('Vite runtime stays on the internal network without credential mounts', () => {
  const compose = readFileSync(new URL('../../compose.lk1-local.yaml', import.meta.url), 'utf8');
  assert.match(compose, /internal: true/);
  assert.match(compose, /127\.0\.0\.1:5180:5180/);
  assert.match(compose.split('\n  web:\n')[1], /networks: \[offline\]/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.doesNotMatch(compose, /docker\.sock|env_file:|network_mode:|privileged:|\.env:/);
  assert.doesNotMatch(compose, /\.\/scripts:\/workspace\/scripts/);
  const ignores = readFileSync(new URL('../../Dockerfile.lk1-local.dockerignore', import.meta.url), 'utf8');
  assert.equal(ignores.trim(), '**\n!package.json\n!package-lock.json');
});

test('entry service has a single fixed local upstream and rejects tunnels', () => {
  const source = readFileSync(new URL('../lk1_local_preview_ingress.mjs', import.meta.url), 'utf8');
  assert.match(source, /hostname: 'web', port: 5173/);
  assert.match(source, /net\.connect\(5173, 'web'/);
  assert.match(source, /server\.on\('connect', \(_req, socket\) => socket\.destroy\(\)\)/);
  assert.doesNotMatch(source, /https:|process\.env|new URL\(req/);
});

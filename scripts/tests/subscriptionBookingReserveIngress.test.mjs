import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import test from 'node:test';
import {buildReserveBookingNginxCandidate, reserveBookingLocation} from '../nginx/prepare_subscription_booking_reserve.mjs';
import {sha256} from '../nginx/patch_subscription_booking_proxy.mjs';

const source = `server {
    location = /lk/subscriptions/game-price-preview { return 401; }
    location /lk/ {
        try_files $uri =404;
    }
}
`;

test('reserve booking candidate changes only the exact missing route, guards drift and is idempotent', () => {
  const fragment = reserveBookingLocation();
  const built = buildReserveBookingNginxCandidate(source, sha256(source));
  assert.equal(built.candidate.replace(`${fragment}\n`, ''), source);
  assert.equal(buildReserveBookingNginxCandidate(built.candidate, built.candidateSha).changed, false);
  assert.throws(() => buildReserveBookingNginxCandidate(source, 'stale'), /SHA mismatch/);
  for (const invalid of [source + source, 'server {}', source.replace('    location /lk/',
    '    location = /lk/subscription-bookings { return 418; }\n    location /lk/')]) {
    assert.throws(() => buildReserveBookingNginxCandidate(invalid, sha256(invalid)));
  }
  assert.match(fragment, /proxy_ssl_verify on;/);
  assert.match(fragment, /proxy_ssl_verify_depth 3;/);
  assert.match(fragment, /proxy_ssl_session_reuse off;/);
  assert.match(fragment, /proxy_next_upstream off;/);
  assert.match(fragment, /proxy_pass https:\/\/padlhub\.su;/);
  assert.doesNotMatch(fragment, /proxy_cache|proxy_set_header Authorization|limit_req/);
});

test('isolated nginx: preflight, method/body boundaries, verified TLS POST with intact operation and auth',
  {skip: process.env.LK_BOOKING_RESERVE_NGINX_TEST !== '1' && 'Opt-in isolated Docker fixture', timeout: 60000}, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'booking-reserve-nginx-')));
    let id;
    const docker = args => execFileSync('docker', args, {encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']}).trim();
    t.after(() => {
      if (id) spawnSync('docker', ['rm', '-f', id], {stdio: 'ignore', timeout: 10000});
      fs.rmSync(root, {recursive: true, force: true});
    });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=padlhub.su', '-addext', 'subjectAltName=DNS:padlhub.su',
      '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], {stdio: 'ignore'});
    fs.writeFileSync(path.join(root, 'nginx.conf'), `pid /tmp/nginx.pid; error_log stderr warn; events {} http {
      access_log off;
      server {listen 443 ssl; server_name padlhub.su;
        ssl_certificate /fixture/cert.pem; ssl_certificate_key /fixture/key.pem;
        access_log /tmp/upstream.log;
        location / {add_header Access-Control-Allow-Origin upstream-invalid always;
          return 401 "$request_method|$request_uri|$http_authorization";}}
      server {listen 18080; ${reserveBookingLocation()} location /lk/ {return 404;}}
    }`);
    id = docker(['run', '-d', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/var/cache/nginx',
      '--add-host', 'padlhub.su:127.0.0.1', '--platform', 'linux/amd64', '-v', `${root}:/fixture:ro`,
      '-v', `${root}/cert.pem:/etc/ssl/certs/ca-certificates.crt:ro`, '--entrypoint', 'nginx',
      'nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1',
      '-p', '/tmp/', '-c', '/fixture/nginx.conf', '-g', 'daemon off;']);
    const request = (method, route = '/lk/subscription-bookings?operationId=fixture-op', body = '{}', auth = true) =>
      docker(['exec', id, 'curl', '--max-time', '5', '-si', '-X', method,
        '-H', 'Origin: https://padlhub.ru', '-H', 'Content-Type: application/json',
        '-H', 'Access-Control-Request-Method: POST', '-H', 'Access-Control-Request-Headers: authorization,content-type',
        ...(auth ? ['-H', 'Authorization: Bearer fixture-only'] : []), '--data-binary', body, `http://127.0.0.1:18080${route}`]);
    let ready = false;
    for (let n = 0; n < 20 && !ready; n++) {
      try { ready = request('OPTIONS').includes('204'); } catch { /* Bounded fixture startup. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready);
    const options = request('OPTIONS');
    assert.match(options, /204 No Content/);
    assert.match(options, /Access-Control-Allow-Methods: POST, OPTIONS/i);
    assert.match(options, /Access-Control-Allow-Headers: Content-Type, Authorization/i);
    assert.match(request('GET'), /405 Not Allowed/);
    assert.match(request('DELETE'), /405 Not Allowed/);
    assert.match(request('POST', undefined, 'x'.repeat(17000)), /413/);
    assert.match(request('POST', '/lk/subscription-bookings-extra'), /404/);
    assert.equal(docker(['exec', id, 'cat', '/tmp/upstream.log']), '');
    const post = request('POST');
    assert.match(post, /401 Unauthorized/);
    assert.match(post, /POST\|\/lk\/subscription-bookings\?operationId=fixture-op\|Bearer fixture-only/);
    assert.match(post, /Cache-Control: no-store/i);
    assert.equal((post.match(/Access-Control-Allow-Origin:/gi) || []).length, 1);
    assert.doesNotMatch(post, /upstream-invalid/);
    const noAuth = request('POST', undefined, '{}', false);
    assert.match(noAuth, /401 Unauthorized/);
    assert.doesNotMatch(noAuth, /Bearer fixture-only/);
    assert.equal(docker(['exec', id, 'cat', '/tmp/upstream.log']).split('\n').length, 2);
  });

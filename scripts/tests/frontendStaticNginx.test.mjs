import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildFrontendStaticCandidate, sha256 } from '../nginx/prepare_frontend_static_bootstrap.mjs';
import { files } from '../frontend-release.mjs';
import { legacyStaticServer } from './fixtures/frontendStaticNginx.mjs';
import { buildDevStaticCandidate } from '../nginx/prepare_lk1_dev_static_bootstrap.mjs';
import { devFiles } from '../lk1-dev-frontend-release.mjs';
import { reserveDevNginx } from './fixtures/lk1DevStaticNginx.mjs';

export const NGINX_IMAGE = 'nginx@sha256:2e26275ed7a47e8e93f264d39a09ca4bc3f4058c904c75087e237f4ea883f2a1';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('real nginx keeps legacy URLs, exact cache/CORS and backend routing through switch and rollback', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'lk-nginx-isolation-'));
  const publicRoot = join(root, 'public'); fs.mkdirSync(publicRoot, { mode: 0o755 });
  const legacy = join(publicRoot, 'lk'); fs.mkdirSync(legacy);
  const extras = ['index.html', 'ffc-academy-lk.js', 'ffc-academy-lk-dev.js', 'release-dev.json', 'assets/legacy.txt', 'fonts/legacy.ttf'];
  for (const name of [...files, ...extras]) {
    const file = join(legacy, name); fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, `legacy:${name}`);
  }
  for (const version of ['old', 'next']) {
    for (const name of files) {
      const file = join(publicRoot, 'lk-frontend-releases', version, name);
      fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, `${version}:${name}`);
    }
  }
  const active = join(publicRoot, 'lk-frontend-current');
  fs.symlinkSync('lk-frontend-releases/old', active);
  const { candidate } = buildFrontendStaticCandidate(legacyStaticServer, sha256(legacyStaticServer));
  fs.writeFileSync(join(root, 'nginx.conf'), `pid /tmp/nginx.pid;\nerror_log stderr notice;\nevents {}\nhttp {\naccess_log off;\n${candidate}\n}\n`);
  let id;
  t.after(() => { if (id) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore', timeout: 10000 }); fs.rmSync(root, { recursive: true, force: true }); });
  id = docker(['run', '-d', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/var/cache/nginx', '--platform', 'linux/amd64',
    '--tmpfs', '/var/www/html', '-v', `${root}:/fixture:ro`, '--entrypoint', 'sh', NGINX_IMAGE,
    '-c', 'cp -a /fixture/public/. /var/www/html/ && exec nginx -p /tmp/ -c /fixture/nginx.conf -g "daemon off;"']);
  let ready = false; let lastError = '';
  for (let i = 0; i < 30 && !ready; i++) {
    try { ready = docker(['exec', id, 'curl', '-fsS', 'http://127.0.0.1:18080/lk/bundle.js']).startsWith('old:'); }
    catch (error) { lastError = String(error.stderr || error.message); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(ready, true, ready ? '' : lastError + (() => { const logs = spawnSync('docker', ['logs', id], { encoding: 'utf8' }); return logs.stdout + logs.stderr; })() + docker(['inspect', '--format', '{{json .State}}', id]));
  const logs = () => { const result = spawnSync('docker', ['logs', id], { encoding: 'utf8' }); return result.stdout + result.stderr; };
  const get = (name, method = 'GET') => docker(['exec', id, 'curl', '-sS', '-i', '-X', method, `http://127.0.0.1:18080/lk/${name}?v=fixture`]);
  for (const version of ['old', 'next', 'old']) {
    docker(['exec', id, 'sh', '-c', `ln -s lk-frontend-releases/${version} /var/www/html/.switch && mv -Tf /var/www/html/.switch /var/www/html/lk-frontend-current`]);
    for (const name of files) {
      const response = get(name);
      assert.match(response, /HTTP\/1.1 200/, name + '\n' + logs());
      assert.ok(response.endsWith(`${version}:${name}`), `${name} must follow current symlink`);
      assert.match(response, /Access-Control-Allow-Origin: \*/i);
      assert.match(response, name === 'release.json' ? /Cache-Control: no-store, no-cache/i : /Cache-Control: public, max-age=31536000, immutable/i);
    }
    for (const name of extras) assert.ok(get(name).endsWith(`legacy:${name}`), `${name} must stay on legacy path`);
    assert.ok(get('subscription-bookings').endsWith('backend-contract-preserved'));
  }
  assert.match(get('bundle.js', 'OPTIONS'), /HTTP\/1.1 204/);
  assert.match(get('bundle.js', 'POST'), /HTTP\/1.1 403/);
  assert.match(get('missing.js'), /HTTP\/1.1 404/);
});

test('real DEV nginx preserves both reserve servers through twelve-file switch and bootstrap rollback', { timeout: 60000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lk-dev-nginx-')));
  const publicRoot = join(root, 'public'); fs.mkdirSync(publicRoot, { mode: 0o755 });
  const protectedFiles = ['bundle.js', 'release.json', 'fonts/fixture.woff2', 'assets/fixture.txt', 'index.html'];
  for (const name of [...devFiles, ...protectedFiles]) {
    const file = join(publicRoot, 'lk', name); fs.mkdirSync(join(file, '..'), { recursive: true });
    fs.writeFileSync(file, 'legacy:' + name);
  }
  for (const version of ['old', 'next']) for (const name of devFiles) {
    const file = join(publicRoot, 'lk-frontend-dev-releases', version, name);
    fs.mkdirSync(join(file, '..'), { recursive: true }); fs.writeFileSync(file, `${version}:${name}`);
  }
  fs.symlinkSync('lk-frontend-dev-releases/old', join(publicRoot, 'lk-frontend-dev-current'));
  const wrap = server => `pid /tmp/nginx.pid;\nerror_log stderr notice;\nevents {}\nhttp {\naccess_log off;\nmap $host $lk_dev_suffix { default ""; }\n${server}\n}\n`;
  const { candidate } = buildDevStaticCandidate(reserveDevNginx, sha256(reserveDevNginx));
  fs.writeFileSync(join(root, 'candidate.conf'), wrap(candidate));
  fs.writeFileSync(join(root, 'source.conf'), wrap(reserveDevNginx));
  let id;
  t.after(() => {
    if (id) spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore', timeout: 10000 });
    fs.rmSync(root, { recursive: true, force: true });
  });
  id = docker(['run', '-d', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--tmpfs', '/var/cache/nginx',
    '--platform', 'linux/amd64', '--tmpfs', '/var/www/html', '-v', `${root}:/fixture:ro`, '--entrypoint', 'sh', NGINX_IMAGE,
    '-c', 'cp -a /fixture/public/. /var/www/html/ && cp /fixture/candidate.conf /tmp/nginx.conf && exec nginx -p /tmp/ -c /tmp/nginx.conf -g "daemon off;"']);
  const get = (port, name, method = 'GET') => docker(['exec', id, 'curl', '-sS', '-i', '-X', method,
    '-H', `Host: ${port === 18081 ? 'lk-reserve.tsup.space' : 'lk-reserve.89-108-64-209.sslip.io'}`,
    `http://127.0.0.1:${port}/lk/${name}?v=fixture`]);
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    try { ready = get(18081, 'bundle-dev.js').endsWith('old:bundle-dev.js'); }
    catch { /* wait only for this owned fixture */ }
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);
  docker(['exec', id, 'nginx', '-t', '-p', '/tmp/', '-c', '/tmp/nginx.conf']);
  for (const version of ['old', 'next', 'old']) {
    docker(['exec', id, 'sh', '-c', `ln -s lk-frontend-dev-releases/${version} /var/www/html/.dev-switch && mv -Tf /var/www/html/.dev-switch /var/www/html/lk-frontend-dev-current`]);
    for (const port of [18081, 18082]) {
      for (const name of devFiles) {
        const response = get(port, name);
        assert.match(response, /HTTP\/1.1 200/);
        assert.ok(response.endsWith(`${version}:${name}`));
        assert.match(response, /Access-Control-Allow-Origin: \*/i);
        assert.match(response, name.endsWith('.json') ? /Cache-Control: no-store, no-cache/i : /Cache-Control: public, max-age=31536000, immutable/i);
      }
      for (const name of protectedFiles) assert.ok(get(port, name).endsWith('legacy:' + name));
      assert.ok(get(port, 'subscription-bookings').endsWith('backend-preserved'));
      assert.match(get(port, 'bundle-dev.js', 'OPTIONS'), /HTTP\/1.1 204/);
      assert.match(get(port, 'bundle-dev.js', 'POST'), /HTTP\/1.1 403/);
    }
  }
  docker(['exec', id, 'sh', '-c', 'cp /fixture/source.conf /tmp/nginx.conf && nginx -t -p /tmp/ -c /tmp/nginx.conf && nginx -s reload -p /tmp/ -c /tmp/nginx.conf']);
  let restored = false;
  for (let i = 0; i < 30 && !restored; i++) {
    restored = get(18081, 'bundle-dev.js').endsWith('legacy:bundle-dev.js');
    if (!restored) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(restored, true);
  for (const port of [18081, 18082]) for (const name of [...devFiles, ...protectedFiles]) {
    assert.ok(get(port, name).endsWith('legacy:' + name));
  }
});

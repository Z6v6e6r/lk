import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildFrontendStaticCandidate, sha256 } from '../nginx/prepare_frontend_static_bootstrap.mjs';
import { files } from '../frontend-release.mjs';
import { legacyStaticServer } from './fixtures/frontendStaticNginx.mjs';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildDevStaticCandidate, prepareDevBootstrap } from '../nginx/prepare_lk1_dev_static_bootstrap.mjs';
import { sha256 } from '../nginx/prepare_frontend_static_bootstrap.mjs';
import { devFiles, devInventory, devUploadEnvironment, DEV_RELEASES_ROOT, DEV_ASSET_BASE } from '../lk1-dev-frontend-release.mjs';
import { reserveDevNginx, devManifestLocation } from './fixtures/lk1DevStaticNginx.mjs';

test('DEV readback uses the verified reserve HTTPS origin', () => {
  assert.equal(DEV_ASSET_BASE, 'https://lk-reserve.89-108-64-209.sslip.io/lk/');
});

test('DEV nginx replaces only two manifest blocks with twelve exact paths per server', () => {
  const result = buildDevStaticCandidate(reserveDevNginx, sha256(reserveDevNginx));
  assert.equal(result.candidate.replaceAll(result.fragment, devManifestLocation), reserveDevNginx);
  assert.equal((result.fragment.match(/location = /g) || []).length, 12);
  assert.equal((result.fragment.match(/open_file_cache off;/g) || []).length, 12);
  assert.doesNotMatch(result.fragment, /fonts\/|assets\/|\/lk\/bundle\.js|\/lk\/release\.json|proxy_pass/);
  assert.equal(result.liveMutationAuthorized, false);
  assert.throws(() => buildDevStaticCandidate(reserveDevNginx, '0'.repeat(64)), /SHA/);
  for (const mutate of [
    s => s.replace('lk-reserve.tsup.space', 'foreign.invalid'),
    s => s.replace('root /var/www/html;', 'root /foreign;'),
    s => s.replace('    location /lk/', '    location = /lk/bundle-dev.js { return 404; }\n    location /lk/'),
    s => s.replace('try_files $uri =404;', 'proxy_pass http://foreign;'),
  ]) {
    const source = mutate(reserveDevNginx);
    assert.throws(() => buildDevStaticCandidate(source, sha256(source)), /Unexpected|Existing|preimage/);
  }
  assert.throws(() => buildDevStaticCandidate(result.candidate, result.candidateSha), /already present/);
});

test('DEV offline bootstrap binds immutable baseline and upload destination without fonts or routing writes', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'lk-dev-bootstrap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist'); fs.mkdirSync(dist);
  for (const name of devFiles) fs.writeFileSync(path.join(dist, name), name === 'release-dev.json'
    ? JSON.stringify({ sourceCommit: '1'.repeat(40), sourceDirty: false, version: 'fixture-dev' }) : 'fixture:' + name);
  fs.writeFileSync(path.join(dist, 'bundle.js'), 'unrelated prod');
  const installed = devInventory(dist);
  const sourceNginx = path.join(root, 'nginx.conf'); fs.writeFileSync(sourceNginx, reserveDevNginx);
  const args = { sourceNginx, expectedSourceSha: sha256(reserveDevNginx), installed, distDir: dist, outDir: path.join(root, 'packet') };
  const plan = prepareDevBootstrap(args);
  assert.equal(plan.host, 'lk-reserve-89');
  assert.equal(plan.liveMutationAuthorized, false);
  assert.deepEqual(fs.readdirSync(path.join(args.outDir, 'release')).sort(), [...devFiles].sort());
  assert.throws(() => prepareDevBootstrap(args), /EEXIST/);
  const token = 'a'.repeat(32), destination = `${DEV_RELEASES_ROOT}/${installed.source}-${token.slice(0, 16)}`;
  const env = devUploadEnvironment(dist, destination, installed, token);
  assert.equal(env.DEPLOY_DEV_ISOLATED, '1'); assert.equal(env.DEPLOY_PRUNE_OPPOSITE_CHANNEL, '0');
  for (const bad of [destination.replace('-dev-releases', '-releases'), '/var/www/html/lk', destination + '/..']) {
    assert.throws(() => devUploadEnvironment(dist, bad, installed, token), /destination/);
  }
  fs.writeFileSync(path.join(dist, 'bundle-dev.js'), 'drift');
  assert.throws(() => prepareDevBootstrap({ ...args, outDir: path.join(root, 'drift') }), /inventory differs/);
  assert.equal(fs.existsSync(path.join(root, 'drift')), false);
});


test('DEV readback survives blocked uploads with fresh verified TLS and preserves failure/rollback gates', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'lk-dev-readback-tls-'));
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Synthetic local certificate only; no private key is committed or sent off-host.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const serverCode = `
    import https from 'node:https'; import fs from 'node:fs';
    let connection = 0;
    const server = https.createServer({ key: fs.readFileSync(process.argv[1]), cert: fs.readFileSync(process.argv[2]) }, (req, res) => {
      const url = new URL(req.url, 'https://localhost'); const mode = url.searchParams.get('v');
      res.once('finish', () => { const timer = setTimeout(() => req.socket.end(), 75); timer.unref(); });
      res.setHeader('X-Test-Connection', req.socket.fixtureId);
      res.setHeader('Keep-Alive', 'timeout=10');
      if (mode !== 'bad-cache') res.setHeader('Cache-Control', 'no-store');
      if (mode === 'redirect') { res.writeHead(302, { Location: '/must-not-follow' }); res.end(); return; }
      if (mode === 'status') { res.writeHead(503); res.end(); return; }
      if (mode === 'slow' || mode === 'drop') {
        res.writeHead(200, { 'Content-Length': 100 }); res.write('partial');
        if (mode === 'drop') setTimeout(() => res.destroy(), 10);
        return;
      }
      res.end(mode === 'bad-hash' ? 'wrong' : url.pathname.split('/').pop());
    });
    server.on('secureConnection', socket => { socket.fixtureId = ++connection; });
    server.keepAliveTimeout = 50;
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `;
  const server = spawn(process.execPath, ['--input-type=module', '-e', serverCode, key, cert], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { const exited = once(server, 'exit'); server.kill(); await exited; });
  const [{ port }] = await once(server, 'message');
  const moduleUrl = new URL('../lk1-dev-frontend-release.mjs', import.meta.url).href;
  const deployUrl = new URL('../frontend-release.mjs', import.meta.url).href;
  const run = async (code, trusted = true) => {
    const env = { ...process.env }; delete env.NODE_TLS_REJECT_UNAUTHORIZED; delete env.NODE_OPTIONS;
    if (trusted) env.NODE_EXTRA_CA_CERTS = cert; else delete env.NODE_EXTRA_CA_CERTS;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const [status] = await once(child, 'exit'); assert.equal(status, 0, output);
  };
  const imports = `import assert from 'node:assert/strict'; import { createHash } from 'node:crypto';
    import { readDevArtifact, readback, devFiles } from ${JSON.stringify(moduleUrl)};
    const baseUrl = 'https://localhost:${port}/lk/';
    const expected = { version: 'ok', hashes: Object.fromEntries(devFiles.map(name => [name, createHash('sha256').update(name).digest('hex')])) };
  `;
  await run(imports + `
    import { deploy } from ${JSON.stringify(deployUrl)};
    // Reproduce the old pooled-fetch failure in a separate server process while this
    // event loop is blocked, then exercise the real fixed readback under the same pause.
    for (let i = 0; i < 2; i++) { const r = await fetch(baseUrl + 'release-dev.json'); await r.arrayBuffer(); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    await assert.rejects(fetch(baseUrl + 'release-dev.json'), error => error.cause?.code === 'UND_ERR_SOCKET');
    const before = await readDevArtifact(baseUrl + 'release-dev.json');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    const after = await readDevArtifact(baseUrl + 'release-dev.json');
    assert.notEqual(before.headers['x-test-connection'], after.headers['x-test-connection']);
    assert.equal(after.status, 200);
    await readback(expected, { baseUrl }); // All twelve hashes and manifest cache header.
    for (const [version, message] of [['bad-hash', /bytes mismatch: bundle-dev.js/],
      ['bad-cache', /manifest cache guard/], ['redirect', /HTTP 302: bundle-dev.js/], ['status', /HTTP 503: bundle-dev.js/],
      ['slow', /bundle-dev.js \\(READBACK_TIMEOUT\\)/], ['drop', /bundle-dev.js \\(ECONNRESET\\)/]]) {
      await assert.rejects(readback({ ...expected, version }, { baseUrl, timeoutMs: version === 'slow' ? 200 : 2000 }), message);
    }
    await assert.rejects(readDevArtifact('https://127.0.0.1:${port}/lk/release-dev.json'), error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    const ops = []; const bad = { ...expected, version: 'drop' };
    await assert.rejects(deploy({ previous: expected, expected: bad, token: 'a'.repeat(32), upload: () => {},
      remote: request => { ops.push(request.op); return {}; }, smoke: state => readback(state, { baseUrl }),
    }), /previous complete set restored and verified: DEV public readback failed: bundle-dev.js \\(ECONNRESET\\)/);
    assert.deepEqual(ops, ['acquire', 'publish', 'rollback', 'finish']);
    await assert.rejects(deploy({ previous: bad, expected: bad, token: 'b'.repeat(32), upload: () => {},
      remote: () => ({}), smoke: state => readback(state, { baseUrl }),
    }), /recovery incomplete, lease retained/);
  `);
  await run(imports + `await assert.rejects(readDevArtifact(baseUrl + 'release-dev.json'),
    error => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));`, false);
});

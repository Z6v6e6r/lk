import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildDevStaticCandidate, prepareDevBootstrap } from '../nginx/prepare_lk1_dev_static_bootstrap.mjs';
import { sha256 } from '../nginx/prepare_frontend_static_bootstrap.mjs';
import { devFiles, devInventory, devUploadEnvironment, DEV_RELEASES_ROOT } from '../lk1-dev-frontend-release.mjs';
import { reserveDevNginx, devManifestLocation } from './fixtures/lk1DevStaticNginx.mjs';

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

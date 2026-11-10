import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prepareAcademyPreviewCache, ACADEMY_PREVIEW_HOST, ACADEMY_MUTABLE_PATHS } from '../nginx/prepare_academy_preview_cache.mjs';
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const plain = `server {\n listen 80;\n server_name ${ACADEMY_PREVIEW_HOST};\n return 301 https://$host$request_uri;\n}\n`;
const tls = `server {\n listen 443 ssl;\n server_name ${ACADEMY_PREVIEW_HOST};\n root /var/www/html;\n # } is a comment\n location /lk/analytics/ { proxy_pass http://unchanged; }\n}\n`;
test('cache candidate preserves every existing byte and adds only two exact static locations inside HTTPS', () => {
  const source = plain + tls, result = prepareAcademyPreviewCache(source, hash(source));
  assert.ok(result.candidate.startsWith(plain));
  assert.equal(result.candidate.replace(/\n {4}# BEGIN academy preview cache v1[\s\S]*? {4}# END academy preview cache v1\n/, ''), source);
  assert.deepEqual(result.paths, ACADEMY_MUTABLE_PATHS);
  for (const uri of ACADEMY_MUTABLE_PATHS) assert.ok(result.candidate.includes(`location = ${uri} {`));
  assert.equal((result.candidate.match(/add_header Cache-Control/g) || []).length, 2);
  assert.equal((result.candidate.match(/proxy_pass http:\/\/unchanged/g) || []).length, 1);
});
test('cache candidate rejects stale preimage, conflicting routes and duplicate HTTPS targets', () => {
  assert.throws(() => prepareAcademyPreviewCache(tls, '0'.repeat(64)), /SHA mismatch/);
  const conflicting = tls.replace(' root ', ' location = /lk/academy-preview/index.html { return 403; }\n root ');
  assert.throws(() => prepareAcademyPreviewCache(conflicting, hash(conflicting)), /reconciliation/);
  assert.throws(() => prepareAcademyPreviewCache(tls + tls, hash(tls + tls)), /exactly one/);
  const applied = prepareAcademyPreviewCache(tls, hash(tls)).candidate;
  assert.throws(() => prepareAcademyPreviewCache(applied, hash(applied)), /already present/);
});
test('HTTP-only host and nested fake TLS directive cannot select a target', () => {
  assert.throws(() => prepareAcademyPreviewCache(plain, hash(plain)), /exactly one/);
  const nested = `server {\n server_name ${ACADEMY_PREVIEW_HOST};\n location / {\n listen 443;\n }\n}\n`;
  assert.throws(() => prepareAcademyPreviewCache(nested, hash(nested)), /exactly one/);
});

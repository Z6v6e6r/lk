import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUNDLE_FILES, verifyBundle } from '../lk1_unpaid_cancel_service/verify_bundle.mjs';

test('worker bundle rejects manifest drift and unlisted install inputs', t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-unpaid-bundle-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.mkdirSync(path.join(folder, 'lib'), { mode: 0o700 });
  const files = {};
  for (const name of BUNDLE_FILES) {
    const bytes = Buffer.from(`fixture: ${name}\n`);
    fs.writeFileSync(path.join(folder, name), bytes, { mode: 0o600 });
    files[name] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ schema: 1,
    sourceCommit: 'a'.repeat(40), files }), { mode: 0o600 });
  const receipt = verifyBundle(folder);
  assert.equal(receipt.fileCount, BUNDLE_FILES.length);
  assert.throws(() => verifyBundle(folder, { expectedManifestSha: 'b'.repeat(64) }),
    /BUNDLE_MANIFEST_DRIFT/);
  fs.writeFileSync(path.join(folder, '.npmrc'), 'registry=https://other.example.test/');
  assert.throws(() => verifyBundle(folder), /BUNDLE_EXTRA_FILE/);
  fs.rmSync(path.join(folder, '.npmrc'));
  fs.mkdirSync(path.join(folder, 'node_modules'));
  assert.throws(() => verifyBundle(folder), /BUNDLE_EXTRA_FILE/);
  assert.equal(verifyBundle(folder, { installed: true, expectedManifestSha: receipt.manifestSha256 }).fileCount,
    BUNDLE_FILES.length);
  fs.writeFileSync(path.join(folder, BUNDLE_FILES[0]), 'changed');
  assert.throws(() => verifyBundle(folder, { installed: true }), /BUNDLE_DIGEST_MISMATCH/);
});

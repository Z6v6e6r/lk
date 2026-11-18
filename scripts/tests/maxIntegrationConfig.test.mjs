import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { loadIntegrationConfig } = require('../../node-red/max-outbox-adapter/max-integration-config.js');
const { loadSupportMediaConfig } = require('../../node-red/max-outbox-adapter/max-media-config.js');
const key = 'SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN', value = 'a'.repeat(64);
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-key-'))), file = path.join(dir, 'key.env');
  fs.chmodSync(dir, 0o700); fs.writeFileSync(file, key + '=' + value + '\n', { mode: 0o600 });
  return { dir, file, clear: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('private bounded single-key file initializes only dedicated key; equal reload is idempotent', () => {
  const f = fixture(), env = { SUPPORT_INTEGRATION_TOKEN: 'synthetic-old', OTHER: 'retained' };
  try {
    assert.equal(loadIntegrationConfig({ file: f.file, environment: env }), true);
    assert.deepEqual(env, { SUPPORT_INTEGRATION_TOKEN: 'synthetic-old', OTHER: 'retained', [key]: value });
    assert.equal(loadIntegrationConfig({ file: f.file, environment: env }), true);
    for (const current of ['', 'b'.repeat(64)]) {
      const conflicting = { [key]: current };
      assert.throws(() => loadIntegrationConfig({ file: f.file, environment: conflicting }), /ENV_CONFLICT/);
      assert.equal(conflicting[key], current);
    }
  } finally { f.clear(); }
});
test('missing is optional; malformed, extra keys, encoding, size, ownership and mode fail closed without env changes', () => {
  const f = fixture();
  try {
    assert.equal(loadIntegrationConfig({ file: f.file + '.absent', environment: {} }), false);
    const invalid = ['', key + '=' + value, 'export ' + key + '=' + value + '\n',
      key + '=' + value + '\nOTHER=unsafe\n', key + '=' + value + '\n\n', 'x'.repeat(200),
      Buffer.from([...Buffer.from(key + '='), ...Buffer.alloc(64, 0xe1), 10])];
    for (const body of invalid) {
      fs.writeFileSync(f.file, body); const env = {};
      assert.throws(() => loadIntegrationConfig({ file: f.file, environment: env }), /MAX_INTEGRATION_/);
      assert.deepEqual(env, {});
    }
    fs.writeFileSync(f.file, key + '=' + value + '\n'); fs.chmodSync(f.file, 0o644);
    assert.throws(() => loadIntegrationConfig({ file: f.file, environment: {} }), /CUSTODY/);
    fs.chmodSync(f.file, 0o600);
    assert.throws(() => loadIntegrationConfig({ file: f.file, environment: {}, uid: process.getuid() + 1 }), /CUSTODY/);
  } finally { f.clear(); }
});
test('symlinks, hardlinks, writable directories and inode replacement are refused; errors contain no credential', () => {
  const f = fixture(), originalRead = fs.readSync;
  try {
    const link = path.join(f.dir, 'alias'); fs.symlinkSync(f.file, link);
    assert.throws(() => loadIntegrationConfig({ file: link, environment: {} }), /UNAVAILABLE/); fs.unlinkSync(link);
    fs.linkSync(f.file, link);
    assert.throws(() => loadIntegrationConfig({ file: f.file, environment: {} }), /CUSTODY/); fs.unlinkSync(link);
    fs.chmodSync(f.dir, 0o777);
    assert.throws(() => loadIntegrationConfig({ file: f.file, environment: {} }), /DIRECTORY_CUSTODY/); fs.chmodSync(f.dir, 0o700);
    fs.readSync = (...args) => { const result = originalRead(...args); fs.renameSync(f.file, f.file + '.old');
      fs.writeFileSync(f.file, key + '=' + value + '\n', { mode: 0o600 }); return result; };
    const env = {};
    assert.throws(() => loadIntegrationConfig({ file: f.file, environment: env }), e => /FILE_CHANGED/.test(e.message) && !e.message.includes(value));
    assert.deepEqual(env, {});
  } finally { fs.readSync = originalRead; f.clear(); }
});

test('nonregular FIFO refuses in bounded time instead of blocking the event loop', () => {
  const f=fixture();try {
    fs.unlinkSync(f.file);execFileSync('mkfifo',[f.file]);fs.chmodSync(f.file,0o600);
    const loader=fileURLToPath(new URL('../../node-red/max-outbox-adapter/max-integration-config.js',import.meta.url));
    const code="try{require(process.argv[1]).loadIntegrationConfig({file:process.argv[2],environment:{}});process.exit(2)}catch(e){if(e.message!=='MAX_INTEGRATION_FILE_CUSTODY')process.exit(3)}";
    const result=spawnSync(process.execPath,['-e',code,loader,f.file],{timeout:2000,encoding:'utf8'});
    assert.equal(result.error,undefined);assert.equal(result.status,0);
  }finally{f.clear();}
});

test('media hot bootstrap loads exactly two fields atomically and refuses conflicting or extra authority', () => {
  const f = fixture(), body = { mediaToken: value, sourceHosts: ['media.synthetic.invalid'] };
  try {
    fs.writeFileSync(f.file, JSON.stringify(body));
    const env = { SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN: 'synthetic-queue', OTHER: 'retained' };
    assert.equal(loadSupportMediaConfig({ file: f.file, environment: env }), true);
    assert.deepEqual(env, { SUPPORT_MAX_OUTBOX_INTEGRATION_TOKEN: 'synthetic-queue', OTHER: 'retained',
      SUPPORT_MEDIA_INTEGRATION_TOKEN: value, SUPPORT_MAX_MEDIA_SOURCE_HOSTS: 'media.synthetic.invalid' });
    assert.equal(loadSupportMediaConfig({ file: f.file, environment: env }), true);
    const conflict = { SUPPORT_MAX_MEDIA_SOURCE_HOSTS: 'other.synthetic.invalid' };
    assert.throws(() => loadSupportMediaConfig({ file: f.file, environment: conflict }), /ENV_CONFLICT/);
    assert.deepEqual(conflict, { SUPPORT_MAX_MEDIA_SOURCE_HOSTS: 'other.synthetic.invalid' });
    for (const invalid of [{ ...body, signingKey: 'forbidden' }, { ...body, mediaToken: '' },
      ...[[], ['*.synthetic.invalid'], ['127.0.0.1'], ['localhost'], ['https://media.synthetic.invalid'],
        ['media.synthetic.invalid:443'], ['media.synthetic.invalid', 'media.synthetic.invalid']].map(sourceHosts => ({ ...body, sourceHosts }))]) {
      fs.writeFileSync(f.file, JSON.stringify(invalid)); const isolated = {};
      assert.throws(() => loadSupportMediaConfig({ file: f.file, environment: isolated }), /FORMAT/);
      assert.deepEqual(isolated, {});
    }
  } finally { f.clear(); }
});

test('media config refuses insecure custody, aliases, replacement and unbounded/non-ASCII bodies without leaking its token', () => {
  const f = fixture(), body = JSON.stringify({ mediaToken: value, sourceHosts: ['media.synthetic.invalid'] });
  const originalRead = fs.readSync;
  const probe = () => { const isolated = {}; assert.throws(() => loadSupportMediaConfig({ file: f.file, environment: isolated }),
    error => /^MAX_MEDIA_CONFIG_/.test(error.message) && !error.message.includes(value)); assert.deepEqual(isolated, {}); };
  try {
    assert.equal(loadSupportMediaConfig({ file: f.file + '.absent', environment: {} }), false);
    for (const invalid of ['', 'x'.repeat(2049), '{broken', Buffer.from([0xff])]) { fs.writeFileSync(f.file, invalid); probe(); }
    fs.writeFileSync(f.file, body); fs.chmodSync(f.file, 0o644); probe(); fs.chmodSync(f.file, 0o600);
    assert.throws(() => loadSupportMediaConfig({ file: f.file, environment: {}, uid: process.getuid() + 1 }), /CUSTODY/);
    const link = path.join(f.dir, 'alias'); fs.symlinkSync(f.file, link);
    assert.throws(() => loadSupportMediaConfig({ file: link, environment: {} }), /UNAVAILABLE/); fs.unlinkSync(link);
    fs.linkSync(f.file, link); probe(); fs.unlinkSync(link);
    fs.chmodSync(f.dir, 0o777); probe(); fs.chmodSync(f.dir, 0o700);
    fs.readSync = (...args) => { const result = originalRead(...args); fs.renameSync(f.file, f.file + '.old');
      fs.writeFileSync(f.file, body, { mode: 0o600 }); return result; };
    probe(); fs.readSync = originalRead;
    fs.unlinkSync(f.file); execFileSync('mkfifo', [f.file]); fs.chmodSync(f.file, 0o600);
    const loader = fileURLToPath(new URL('../../node-red/max-outbox-adapter/max-media-config.js', import.meta.url));
    const code = "try{require(process.argv[1]).loadSupportMediaConfig({file:process.argv[2],environment:{}});process.exit(2)}catch(e){if(e.message!=='MAX_MEDIA_CONFIG_CUSTODY')process.exit(3)}";
    const result = spawnSync(process.execPath, ['-e', code, loader, f.file], { timeout: 2000, encoding: 'utf8' });
    assert.equal(result.error, undefined); assert.equal(result.status, 0);
  } finally { fs.readSync = originalRead; f.clear(); }
});

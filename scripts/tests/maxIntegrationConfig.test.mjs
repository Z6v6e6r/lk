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

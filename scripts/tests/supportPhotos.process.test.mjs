import test from 'node:test';
import assert from 'node:assert/strict';
import { readSupportPhotosProcessIdentity } from '../nodered_reviewed_flow_deploy/support_photos_native_operation.mjs';

function fixture() {
  const pid = 1234, proc = '/proc/' + pid, entry = '/synthetic/node-red/red.js';
  let ticks = '100', statReads = 0;
  const files = new Map([
    [proc + '/environ', Buffer.from('pm_exec_path=' + entry + '\0UNRELATED_TOKEN=synthetic-secret\0')],
    [proc + '/cmdline', Buffer.from('node-red\0')],
    ['/synthetic/node-red/package.json', Buffer.from(JSON.stringify({ name: 'node-red', version: '4.0.9' }))],
  ]);
  const info = (directory = false) => ({ uid: 0, nlink: 1, mode: 0o755,
    isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false });
  const io = {
    listeners: () => 'LISTEN 0 511 *:1880 *:* users:(("node-red",pid=1234,fd=19))\n',
    stat: file => { assert([proc, entry].includes(file)); return info(file === proc); },
    read: (file, limit) => {
      assert(limit <= 2 * 1024 * 1024);
      if (file === proc + '/stat') {
        statReads++;
        const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = ticks;
        return Buffer.from(pid + ' (node-red (worker)) ' + fields.join(' '));
      }
      assert(files.has(file), 'unscoped process read'); return files.get(file);
    },
    realpath: file => { assert.equal(file, entry); return file; },
    readlink: file => {
      assert([proc + '/exe', proc + '/cwd'].includes(file));
      return file.endsWith('/exe') ? '/synthetic/node' : '/synthetic/userDir';
    },
  };
  return { io, files, proc, entry, info, setTicks: value => { ticks = value; }, statReads: () => statReads };
}
test('OS-only identity reads the live listener and process epoch without exposing other environment values', () => {
  const f = fixture(), result = readSupportPhotosProcessIdentity({ io: f.io });
  assert.equal(result.pid, 1234); assert.equal(result.startTicks, '100');
  assert.equal(result.entry, f.entry); assert.equal(result.version, '4.0.9');
  assert.equal(f.statReads(), 2); assert(!JSON.stringify(result).includes('synthetic-secret'));
});
test('missing or ambiguous listeners fail before reading a process', () => {
  for (const listeners of ['', 'LISTEN *:1880 users:(("a",pid=1234,fd=1),("b",pid=2345,fd=2))\n',
    'LISTEN *:1880 users:(("a",pid=1234,fd=1))\nLISTEN *:1880 users:(("b",pid=2345,fd=2))\n']) {
    const f = fixture(); f.io.listeners = () => listeners;
    assert.throws(() => readSupportPhotosProcessIdentity({ io: f.io }), /LISTENER_OWNER/);
    assert.equal(f.statReads(), 0);
  }
});
test('an unavailable listener query only refuses and never falls back to a lifecycle manager', () => {
  const f = fixture(); f.io.listeners = () => { throw Error('synthetic endpoint unavailable'); };
  f.io.stat = () => assert.fail('no process operation after listener failure');
  assert.throws(() => readSupportPhotosProcessIdentity({ io: f.io }), /synthetic endpoint unavailable/);
});
test('a non-root process or writable entry is rejected', () => {
  const f = fixture(); f.io.stat = file => ({ ...f.info(file === f.proc), uid: 1000 });
  assert.throws(() => readSupportPhotosProcessIdentity({ io: f.io }), /PROCESS_OWNER/);
  const g = fixture(), stat = g.io.stat; g.io.stat = file => ({ ...stat(file), mode: file === g.entry ? 0o777 : 0o755 });
  assert.throws(() => readSupportPhotosProcessIdentity({ io: g.io }), /PROCESS_ENTRY/);
});
test('missing, duplicate or relative PM2 entry metadata is rejected without a daemon query', () => {
  for (const environment of ['OTHER=value\0', 'pm_exec_path=relative/red.js\0',
    'pm_exec_path=/synthetic/node-red/red.js\0pm_exec_path=/other/red.js\0']) {
    const f = fixture(); f.files.set(f.proc + '/environ', Buffer.from(environment));
    assert.throws(() => readSupportPhotosProcessIdentity({ io: f.io }), /PROCESS_ENTRY/);
  }
});
test('PID reuse during collection is rejected', () => {
  const f = fixture(), readlink = f.io.readlink;
  f.io.readlink = file => { f.setTicks('200'); return readlink(file); };
  assert.throws(() => readSupportPhotosProcessIdentity({ io: f.io }), /PROCESS_EPOCH/);
});
test('malformed stat and a different installed runtime refuse the target', () => {
  const f = fixture(), read = f.io.read;
  f.io.read = (file, limit) => file.endsWith('/stat') ? Buffer.from('malformed') : read(file, limit);
  assert.throws(() => readSupportPhotosProcessIdentity({ io: f.io }), /PROCESS_STAT/);
  const g = fixture(); g.files.set('/synthetic/node-red/package.json', Buffer.from('{"name":"node-red","version":"4.1.0"}'));
  assert.throws(() => readSupportPhotosProcessIdentity({ io: g.io }), /RUNTIME_VERSION/);
});
test('changing the kernel epoch changes identity while unrelated environment metadata does not', () => {
  const f = fixture(), first = readSupportPhotosProcessIdentity({ io: f.io });
  f.files.set(f.proc + '/environ', Buffer.from('pm_exec_path=' + f.entry + '\0UNRELATED_TOKEN=other-synthetic-secret\0'));
  assert.deepEqual(readSupportPhotosProcessIdentity({ io: f.io }), first);
  f.setTicks('200'); assert.notDeepEqual(readSupportPhotosProcessIdentity({ io: f.io }), first);
});

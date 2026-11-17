import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { buildSupportAdapterEditorReadback } from '../nodered_reviewed_flow_deploy/support_photos_adapter_upload_guard.mjs';
import { assertAdapterLocks, adapterLockPaths, adapterFiles, validateAdapterNativeProof,
  validateAdapterInventoryTransition, expectedAdapterRegistryEntry, assertNoAdapterDescendants } from '../nodered_reviewed_flow_deploy/support_photos_adapter_host.mjs';

function lockFixture() {
  let parent = true, missing = false, contention = 1, signal = null, error, replaced = false;
  const calls = [], st = { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, nlink: 1, mode: 0o100600, dev: 2, ino: 3 };
  const io = { stat: () => ({ ...st, ino: replaced ? 4 : 3 }), fstat: () => st,
    read: () => missing ? '' : 'lock:\t1: FLOCK  ADVISORY  WRITE 10 00:01:3 0 EOF\n',
    epoch: () => ({ startTicks: parent ? '777' : '888' }), ppid: () => 10,
    contender: file => { calls.push(file); return { status: contention, signal, error }; } };
  return { io, calls, locks: { fds: [3, 4, 5, 6], parentPid: 10, parentStartTicks: '777' },
    parentLost: () => { parent = false; }, lockLost: () => { missing = true; }, free: () => { contention = 0; },
    badExit: () => { contention = 73; }, signal: () => { signal = 'SIGTERM'; }, ioError: () => { error = Error('ENOENT'); },
    replace: () => { replaced = true; } };
}
test('four-lock proof checks inherited FD, current parent epoch and a fresh named contender for every mutex', () => {
  const f = lockFixture(); assert.equal(assertAdapterLocks(f.locks, f.io), true);
  assert.deepEqual(f.calls, adapterLockPaths);
  for (const mutation of ['parentLost', 'lockLost', 'free', 'badExit', 'signal', 'ioError', 'replace']) {
    const broken = lockFixture(); broken[mutation](); assert.throws(() => assertAdapterLocks(broken.locks, broken.io), /ADAPTER_/);
  }
  assert.throws(() => assertAdapterLocks({ ...f.locks, fds: [3, 3, 4, 5] }, f.io), /DESCRIPTORS/);
});

test('holder recovery preserves old records, forbids replay and permits a new explicit close', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./supportPhotosAdapterHolder.test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /Ran 5 tests/);
});

test('unrelated non-root processes are allowed; a non-root child or grandchild of Node-RED blocks idle', () => {
  const rows = [{ pid: 10, parentPid: 1, uid: 0 }, { pid: 11, parentPid: 1, uid: 33 }];
  assert.equal(assertNoAdapterDescendants(rows, 10), true);
  assert.throws(() => assertNoAdapterDescendants([...rows, { pid: 12, parentPid: 10, uid: 33 }], 10), /DESCENDANTS/);
  assert.throws(() => assertNoAdapterDescendants([...rows, { pid: 13, parentPid: 12, uid: 33 }, { pid: 12, parentPid: 10, uid: 0 }], 10), /DESCENDANTS/);
  assert.throws(() => assertNoAdapterDescendants(rows.filter(row => row.pid !== 10), 10), /CENSUS/);
});

function nativeFixture() {
  const now = Date.now(), pins = { count: 4, revisionSha256: 'a'.repeat(64), graphSha256: 'b'.repeat(64),
    orderedGraphSha256: 'c'.repeat(64), editorOrderedGraphSha256: 'd'.repeat(64) };
  const native = { ...pins, origin: 'http://127.0.0.1:18801', requestedAt: new Date(now - 2000).toISOString(),
    observedAt: new Date(now - 1000).toISOString(), dirty: false, revisionMatchesEditor: true, adapter: null };
  const adapter = { name: 'node-red-contrib-padlhub-max-outbox', version: '1.1.0', nodeSets: [{ name: 'max-outbox-send',
    enabled: true, types: ['max-outbox-send', 'max-legacy-outbox-send', 'max-outbox-receipt'], error: false, pending: false }] };
  return { now, pins, native, adapter };
}
test('native graph proof stays fresh, exact and distinct from runtime adapter registration', () => {
  const f = nativeFixture(); assert.equal(validateAdapterNativeProof(f.native, f.pins, false, f.now), true);
  assert.throws(() => validateAdapterNativeProof(f.native, f.pins, true, f.now), /REGISTRATION/);
  f.native.adapter = f.adapter; assert.equal(validateAdapterNativeProof(f.native, f.pins, true, f.now), true);
  for (const alter of [v => { v.dirty = true; }, v => { v.graphSha256 = 'f'.repeat(64); },
    v => { v.origin = 'http://127.0.0.1:1880'; }, v => { v.revisionMatchesEditor = false; },
    v => { v.adapter.nodeSets[0].error = true; }, v => { v.adapter.nodeSets[0].pending = true; },
    v => { v.adapter.nodeSets[0].types.pop(); }, v => { v.adapter.nodeSets.push(v.adapter.nodeSets[0]); },
    v => { v.adapter.nodeSets[0].loaded = true; }]) {
    const value = structuredClone(f.native); alter(value); assert.throws(() => validateAdapterNativeProof(value, f.pins, true, f.now));
  }
  assert.throws(() => validateAdapterNativeProof(f.native, f.pins, true, f.now + 31000), /STALE/);
  assert.throws(() => validateAdapterNativeProof(f.native, f.pins, true, f.now - 5000), /STALE/);
  assert.equal(Object.hasOwn(expectedAdapterRegistryEntry().nodes['max-outbox-send'], 'loaded'), false);
});

test('original editor reader requests exact native JSON and detects even empty err/pending properties', async () => {
  for (const mode of ['absent', 'ready', 'empty-error', 'empty-pending', 'revision-race']) {
    const flow = [{ id: 'synthetic-node', type: 'inject', wires: [] }], calls = [];
    const row = { id: 'node-red-contrib-padlhub-max-outbox/max-outbox-send', name: 'max-outbox-send',
      module: 'node-red-contrib-padlhub-max-outbox', version: '1.1.0', enabled: true,
      types: ['max-outbox-send', 'max-legacy-outbox-send', 'max-outbox-receipt'] };
    if (mode === 'empty-error') row.err = {};
    if (mode === 'empty-pending') row.pending_version = '';
    let version = 'synthetic-revision';
    const view = { location: { origin: 'http://127.0.0.1:18801' }, crypto: webcrypto,
      RED: { nodes: { dirty: () => false, version: () => version, createCompleteNodeSet: () => flow } },
      jQuery: { ajax: options => {
        calls.push({ url: options.url, method: options.method, headers: options.headers });
        if (options.url === 'flows') options.success({ rev: version, flows: flow });
        else { if (mode === 'revision-race') version = 'changed'; options.success(mode === 'absent' ? [] : [row]); }
      } } };
    view.top = view;
    const context = vm.createContext({ window: view, Date, Promise, Object, Array, Error, structuredClone, TextEncoder, Uint8Array });
    const read = vm.runInContext(buildSupportAdapterEditorReadback(), context);
    if (mode === 'revision-race') await assert.rejects(read(), /EDITOR_CHANGED/);
    else {
      const result = await read();
      assert.equal(result.count, 1); assert.equal(Object.hasOwn(result, 'flows'), false); assert.equal(Object.hasOwn(result, 'rev'), false);
      if (mode === 'absent') assert.equal(result.adapter, null);
      else { assert.equal(result.adapter.nodeSets[0].error, mode === 'empty-error'); assert.equal(result.adapter.nodeSets[0].pending, mode === 'empty-pending'); }
    }
    assert.equal(calls.length, 2); assert.equal(calls[1].method, 'GET'); assert.equal(calls[1].headers.Accept, 'application/json');
  }
});

test('rehearsal transition permits exact eight published adapter files and inner lock only', () => {
  const before = { existing: { bytes: 2, sha256: 'a'.repeat(64) }, '.package-lock.json': { bytes: 2, sha256: 'b'.repeat(64) } };
  const expected = Object.fromEntries(adapterFiles.map(name => [name, { bytes: 3, sha256: 'c'.repeat(64) }]));
  const after = { ...structuredClone(before), '.package-lock.json': { bytes: 3, sha256: 'd'.repeat(64) },
    ...Object.fromEntries(adapterFiles.map(name => ['node-red-contrib-padlhub-max-outbox/' + name, expected[name]])) };
  assert.equal(validateAdapterInventoryTransition(before, after, expected), true);
  for (const mutation of [v => { delete v.existing; }, v => { v.extra = { bytes: 1, sha256: 'f'.repeat(64) }; },
    v => { v['node-red-contrib-padlhub-max-outbox/max-media.js'].sha256 = 'f'.repeat(64); }]) {
    const changed = structuredClone(after); mutation(changed); assert.throws(() => validateAdapterInventoryTransition(before, changed, expected));
  }
});

test('real inherited flock lifetime survives either holder or child loss and malformed/EOF client input', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lock-lifetime-')));
  const holder = fileURLToPath(new URL('../nodered_reviewed_flow_deploy/support_photos_adapter_holder.py', import.meta.url));
  const script = `import importlib.util,os,sys,fcntl,subprocess,time,signal
from pathlib import Path
spec=importlib.util.spec_from_file_location('holder',sys.argv[1]);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
home=Path(sys.argv[2]);locks=[]
for n in range(4):
 p=home/str(n);p.write_bytes(b'');p.chmod(0o600);locks.append(p)
def blocked():
 for p in locks:
  fd=os.open(p,os.O_RDWR)
  try:
   try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);raise AssertionError('FREE_LOCK')
   except BlockingIOError:pass
  finally:os.close(fd)
def free():
 for p in locks:
  fd=os.open(p,os.O_RDWR);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);os.close(fd)
# Child loss: parent holds all original OFDs. No LOCK_UN is used.
fds=mod.acquire_locks(locks,os.getuid());child=subprocess.Popen([sys.executable,'-c','import sys;sys.stdin.read()'],stdin=subprocess.PIPE,pass_fds=tuple(fds))
child.stdin.write(b'malformed command');child.stdin.close();child.wait(timeout=5);blocked()
for fd in fds:os.close(fd)
free()
# Parent loss: inherited child OFDs keep all four until explicit child exit.
ready=home/'ready';release=home/'release'
code='''import importlib.util,os,sys,subprocess,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('h',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
home=Path(sys.argv[2]);fds=h.acquire_locks([home/str(i) for i in range(4)],os.getuid())
childcode="from pathlib import Path;import sys,time;h=Path(sys.argv[1]);(h/'ready').write_text('ready');"+chr(10)+"while not (h/'release').exists():time.sleep(.02)"
p=subprocess.Popen([sys.executable,'-c',childcode,str(home)],pass_fds=tuple(fds),start_new_session=True)
(home/'child-pid').write_text(str(p.pid))
while True:time.sleep(1)
'''
parent=subprocess.Popen([sys.executable,'-c',code,sys.argv[1],str(home)])
try:
 end=time.monotonic()+5
 while not ready.exists() and time.monotonic()<end:time.sleep(.02)
 assert ready.exists(),'NO_CHILD_READY'
 parent.kill();parent.wait(timeout=5);blocked();release.write_text('release')
 end=time.monotonic()+5
 while time.monotonic()<end:
  try:free();break
  except BlockingIOError:time.sleep(.02)
 else:raise AssertionError('CHILD_DID_NOT_RELEASE')
finally:
 if parent.poll() is None:parent.kill();parent.wait()
 if (home/'child-pid').exists():
  try:os.kill(int((home/'child-pid').read_text()),signal.SIGKILL)
  except ProcessLookupError:pass
print('PASS: four inherited OFDs retained across each parent/child lifetime and input failure')
`;
  try {
    const result = spawnSync('python3', ['-c', script, holder, home], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS: four inherited/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { createSupportAdapterCustody, supportAdapterCustodyCodeHash } from '../nodered_reviewed_flow_deploy/support_photos_adapter_custody.mjs';
import { buildSupportAdapterUploadGuard } from '../nodered_reviewed_flow_deploy/support_photos_adapter_upload_guard.mjs';
import { createReviewedFlowRuntime } from '../nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const NAME = 'node-red-contrib-padlhub-max-outbox-1.1.0.tgz';
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'support-adapter-')));
  fs.chmodSync(home, 0o700);
  const root = path.join(home, 'root'), stage = path.join(root, '.padlhub-support-adapter-stage-20261117T000000Z-1'),
    backupStage = path.join(home, 'support-adapter-backup-20261117T000000Z-1'), cacheDirectory = path.join(home, 'cache');
  for (const dir of [root, stage, backupStage, cacheDirectory]) fs.mkdirSync(dir, { mode: 0o700 });
  const lease = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json'), policy = path.join(root, '.npmrc');
  const original = Buffer.from(JSON.stringify({ formatVersion: 2, deploymentId: 'previous-synthetic-release',
    token: 'synthetic-owner-token', phase: 'soaking', sourceSha256: 'b'.repeat(64), candidateSha256: 'c'.repeat(64),
    acquiredAtMs: 1, expiresAtMs: 2 }, null, 3) + '\n');
  fs.writeFileSync(lease, original, { mode: 0o600 });
  let now = Date.now(), exclusive = true, idle = true, target = 'd'.repeat(64), installed = false;
  const preimage = { packageSha256: 'e'.repeat(64), modulesSha256: 'f'.repeat(64) },
    postimage = { packageSha256: '1'.repeat(64), modulesSha256: '2'.repeat(64) };
  const args = { root, stage, backupStage, cacheDirectory, uid: process.getuid(), gid: process.getgid(),
    getUid: () => process.getuid(), now: () => now, assertExclusive: () => exclusive,
    readTarget: () => target, readPreimage: () => installed ? postimage : preimage,
    readPostimage: () => installed ? postimage : preimage, installerIdle: () => idle };
  const controller = () => createSupportAdapterCustody(args), op = controller();
  const prepared = op.prepare({ expectedTargetSha256: target, expectedCodeSha256: supportAdapterCustodyCodeHash(),
    operatorSha256: '3'.repeat(64), ownerAgreementSha256: '4'.repeat(64),
    expectedPredecessor: { sha256: sha(original), deploymentId: 'previous-synthetic-release' },
    sourceFlowSha256: 'c'.repeat(64), artifact: { fileName: NAME, size: 3, sha256: sha('abc') },
    cacheDirectory, preimage, postimage });
  const input = { expectedPlanSha256: prepared.planSha256 };
  const reserve = () => op.reserve(input), publish = () => op.publishPolicy(input), begin = () => op.begin(input);
  const audit = seal => ({ planSha256: seal.planSha256, attemptSha256: seal.attemptSha256, fileSha256: seal.fileSha256,
    nonce: seal.nonce, forwarded: 1, rejected: 0, terminal: true, httpStatus: 200, cancelledBeforeForward: false });
  return { root, stage, backupStage, lease, policy, original, op, controller, input, reserve, publish, begin, audit,
    install: () => { installed = true; }, setIdle: value => { idle = value; }, setExclusive: value => { exclusive = value; },
    driftTarget: () => { target = '5'.repeat(64); }, advance: ms => { now += ms; },
    cleanup: () => fs.rmSync(home, { force: true, recursive: true }) };
}

test('native adapter loan is durable through operator reconstruction and returns exact foreign bytes only after terminal postcheck', () => {
  const f = fixture();
  try {
    f.reserve(); f.publish(); const seal = f.begin(), loan = fs.readFileSync(f.lease);
    assert.equal(JSON.parse(loan).kind, 'support-media-adapter-install');
    assert.equal(Object.hasOwn(JSON.parse(loan), 'token'), false);
    assert.equal(Object.hasOwn(JSON.parse(loan), 'expiresAtMs'), false);
    f.advance(3600000); const recovered = f.controller();
    assert.throws(() => recovered.begin(f.input), /PREIMAGE|ATTEMPT_CONSUMED/);
    assert.throws(() => recovered.removePolicy(f.input));
    assert.deepEqual(fs.readFileSync(f.lease), loan);
    f.install(); recovered.confirm({ ...f.input, audit: f.audit(seal) });
    recovered.removePolicy(f.input); recovered.handback(f.input);
    assert.deepEqual(fs.readFileSync(f.lease), f.original); assert.equal(fs.existsSync(f.policy), false);
    recovered.handback(f.input); assert.deepEqual(fs.readFileSync(f.lease), f.original);
  } finally { f.cleanup(); }
});

test('unknown or non-200 native outcome never removes policy or releases custody', () => {
  for (const status of [null, 0, 400, 500]) {
    const f = fixture();
    try {
      f.reserve(); f.publish(); const seal = f.begin(), loan = fs.readFileSync(f.lease);
      f.install();
      assert.throws(() => f.op.confirm({ ...f.input, audit: { ...f.audit(seal), httpStatus: status } }), /TERMINAL_REQUIRED/);
      assert.throws(() => f.op.handback(f.input));
      assert.equal(fs.existsSync(f.policy), true); assert.deepEqual(fs.readFileSync(f.lease), loan);
    } finally { f.cleanup(); }
  }
});

test('npm child still running, registration incomplete or runtime drift blocks terminal admission', () => {
  for (const mode of ['child', 'registration', 'target', 'mutex']) {
    const f = fixture();
    try {
      f.reserve(); f.publish(); const seal = f.begin(), lease = fs.readFileSync(f.lease);
      if (mode !== 'registration') f.install();
      if (mode === 'child') f.setIdle(false);
      if (mode === 'target') f.driftTarget();
      if (mode === 'mutex') f.setExclusive(false);
      assert.throws(() => f.op.confirm({ ...f.input, audit: f.audit(seal) }), /NOT_IDLE|POSTIMAGE|TARGET_DRIFT|EXCLUSIVE/);
      assert.deepEqual(fs.readFileSync(f.lease), lease); assert.equal(fs.existsSync(f.policy), true);
    } finally { f.cleanup(); }
  }
});

test('before-upload cancellation restores custody; consumed attempt needs a quiescent native guard proof', () => {
  for (const started of [false, true]) {
    const f = fixture();
    try {
      f.reserve(); f.publish(); let proof;
      if (started) {
        const seal = f.begin(); assert.throws(() => f.op.cancel(f.input), /AUDIT/);
        proof = { ...f.audit(seal), forwarded: 0, terminal: false, httpStatus: null, cancelledBeforeForward: true };
      }
      f.op.cancel({ ...f.input, ...(proof ? { audit: proof } : {}) });
      f.op.removePolicy(f.input); f.op.handback(f.input);
      assert.deepEqual(fs.readFileSync(f.lease), f.original);
    } finally { f.cleanup(); }
  }
});

test('foreign policy inode and foreign or missing returned lease are never overwritten', () => {
  for (const mode of ['policy', 'foreign-lease', 'missing-lease', 'corrupt-backup']) {
    const f = fixture();
    try {
      f.reserve(); f.publish(); f.op.cancel(f.input);
      if (mode === 'policy') {
        fs.unlinkSync(f.policy); fs.writeFileSync(f.policy, 'foreign=true\n', { mode: 0o600 });
        assert.throws(() => f.op.removePolicy(f.input), /POLICY|CUSTODY/);
        assert.equal(fs.readFileSync(f.policy, 'utf8'), 'foreign=true\n');
      } else {
        f.op.removePolicy(f.input); f.op.handback(f.input);
        if (mode === 'foreign-lease') fs.writeFileSync(f.lease, Buffer.from(f.original + ' '));
        if (mode === 'missing-lease') fs.unlinkSync(f.lease);
        if (mode === 'corrupt-backup') fs.writeFileSync(path.join(f.backupStage, 'predecessor.lease.json'), 'corrupt');
        assert.throws(() => f.op.handback(f.input));
        if (mode === 'missing-lease') assert.equal(fs.existsSync(f.lease), false);
        if (mode === 'foreign-lease') assert.deepEqual(fs.readFileSync(f.lease), Buffer.from(f.original + ' '));
      }
    } finally { f.cleanup(); }
  }
});

test('handback retries directory durability after rename succeeds but fsync fails', () => {
  const f = fixture(), fsync = fs.fsyncSync;
  try {
    f.reserve(); f.op.cancel(f.input); f.op.removePolicy(f.input); let failed = false;
    fs.fsyncSync = function (fd) {
      if (!failed && fs.fstatSync(fd).isDirectory() && fs.readFileSync(f.lease).equals(f.original)) {
        failed = true; throw Error('SYNTHETIC_FSYNC');
      }
      return fsync.call(fs, fd);
    };
    assert.throws(() => f.op.handback(f.input), /SYNTHETIC_FSYNC/);
    assert.deepEqual(fs.readFileSync(f.lease), f.original); let synced = false;
    fs.fsyncSync = function (fd) { if (fs.fstatSync(fd).isDirectory()) synced = true; return fsync.call(fs, fd); };
    f.controller().handback(f.input); assert.equal(synced, true);
  } finally { fs.fsyncSync = fsync; f.cleanup(); }
});

test('expired operator window does not allow the generic reviewed writer to remove installer custody', () => {
  const f = fixture();
  try {
    f.reserve(); f.advance(86400000); const raw = fs.readFileSync(f.lease);
    const generic = createReviewedFlowRuntime({ deploymentLeasePath: f.lease, uid: process.getuid(), gid: process.getgid(),
      getUid: () => process.getuid(), now: () => Date.now() + 86400000, pm2: { assertOnline: () => { throw Error('MUST_NOT_RUN'); } } });
    assert.throws(() => generic.preflight({}), /lease contract mismatch/);
    assert.deepEqual(fs.readFileSync(f.lease), raw);
  } finally { f.cleanup(); }
});

test('interrupted policy publication remains owned and can be cancelled without uploading', () => {
  const f = fixture(), fsync = fs.fsyncSync;
  try {
    f.reserve(); let failed = false;
    fs.fsyncSync = function (fd) {
      if (!failed && fs.fstatSync(fd).isDirectory() && fs.existsSync(f.policy)) {
        failed = true; throw Error('SYNTHETIC_POLICY_FSYNC');
      }
      return fsync.call(fs, fd);
    };
    assert.throws(() => f.publish(), /SYNTHETIC_POLICY_FSYNC/); fs.fsyncSync = fsync;
    assert.equal(failed, true); assert.equal(fs.existsSync(f.policy), true);
    f.controller().cancel(f.input); f.op.removePolicy(f.input); f.op.handback(f.input);
    assert.deepEqual(fs.readFileSync(f.lease), f.original); assert.equal(fs.existsSync(f.policy), false);
  } finally { fs.fsyncSync = fsync; f.cleanup(); }
});

test('interrupted lease publication leaves either the exact foreign lease or recoverable own custody', () => {
  for (const afterRename of [false, true]) {
    const f = fixture(), rename = fs.renameSync, fsync = fs.fsyncSync;
    try {
      if (afterRename) fs.fsyncSync = function (fd) {
        if (fs.fstatSync(fd).isDirectory() && !fs.readFileSync(f.lease).equals(f.original)) throw Error('SYNTHETIC_LEASE_FSYNC');
        return fsync.call(fs, fd);
      };
      else fs.renameSync = function (from, to) { if (to === f.lease) throw Error('SYNTHETIC_LEASE_RENAME'); return rename.call(fs, from, to); };
      assert.throws(() => f.reserve(), /SYNTHETIC_LEASE_/); fs.renameSync = rename; fs.fsyncSync = fsync;
      assert.equal(fs.existsSync(f.policy), false);
      if (afterRename) { f.controller().cancel(f.input); f.op.removePolicy(f.input); f.op.handback(f.input); }
      assert.deepEqual(fs.readFileSync(f.lease), f.original);
    } finally { fs.renameSync = rename; fs.fsyncSync = fsync; f.cleanup(); }
  }
});

async function browserFixture({ storage = new Map() } = {}) {
  const sent = [], listeners = new WeakMap(); let time = 0;
  class XHR {
    status = 0;
    open(method, url) { this.method = method; this.url = url; }
    send(body) { sent.push({ xhr: this, body }); }
    abort() { this.aborted = true; }
    addEventListener(event, callback) { const map = listeners.get(this) || {}; (map[event] ||= []).push(callback); listeners.set(this, map); }
    finish(status) { this.status = status; for (const fn of listeners.get(this)?.load || []) fn(); }
    error() { for (const fn of listeners.get(this)?.error || []) fn(); }
  }
  const view = { location: { origin: 'http://127.0.0.1:18801' }, XMLHttpRequest: XHR, FormData, File, Blob,
    fetch: async () => 'native', crypto: webcrypto,
    navigator: { locks: { request: async (_key, _options, callback) => callback({ name: 'synthetic-lock' }) } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
  view.top = view;
  const context = vm.createContext({ window: view, performance: { now: () => time }, Date, structuredClone, URL, TextEncoder,
    Uint8Array, Promise, WeakMap, Error, Object, Number });
  const seal = { planSha256: 'a'.repeat(64), attemptSha256: 'b'.repeat(64), fileSha256: sha('abc'), fileName: NAME,
    fileSize: 3, nonce: '11111111-1111-4111-8111-111111111111', deadline: Date.now() + 120000 };
  const install = () => vm.runInContext(buildSupportAdapterUploadGuard(), context)(seal);
  const untracked = new XHR(); untracked.open('POST', '/nodes'); await install();
  const request = (data = 'abc', name = NAME) => {
    const xhr = new view.XMLHttpRequest(); xhr.open('POST', '/nodes');
    const body = new FormData(); body.append('tarball', new File([data], name)); return { xhr, body };
  };
  const settled = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  return { view, seal, storage, untracked, sent, request, settled, install, expire: () => { time = 300001; } };
}

test('native upload guard forwards the original multipart body once and never inspects authentication', async () => {
  const f = await browserFixture(), { xhr, body } = f.request(); xhr.send(body); await f.settled();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].body, body); xhr.finish(200);
  assert.equal(f.view.__supportAdapterUploadAudit().httpStatus, 200);
  const second = f.request(); second.xhr.send(second.body); await f.settled(); assert.equal(f.sent.length, 1);
  await assert.rejects(f.install(), /CONSUMED/);
  assert.throws(() => f.view.__supportAdapterUploadCancel(), /MAY_HAVE_EFFECT/);
});

test('wrong artifact, expired deadline, sibling writes and fetch cannot forward a palette upload', async () => {
  for (const mode of ['bytes', 'name', 'expiry', 'sibling', 'extra-field']) {
    const f = await browserFixture(), { xhr, body } = f.request(mode === 'bytes' ? 'bad' : 'abc', mode === 'name' ? 'wrong.tgz' : NAME);
    if (mode === 'expiry') f.expire();
    if (mode === 'sibling') xhr.open('POST', '/flows');
    if (mode === 'extra-field') body.append('another', 'value');
    xhr.send(body); await f.settled(); assert.equal(f.sent.length, 0); assert.equal(xhr.aborted, true);
    await assert.rejects(f.view.fetch('/nodes', { method: 'POST', body }), /NATIVE_XHR_ONLY/);
  }
});

test('guard cancellation prevents delayed async validation from ever forwarding', async () => {
  const f = await browserFixture(), { xhr, body } = f.request(); xhr.send(body);
  assert.equal(f.view.__supportAdapterUploadCancel().cancelledBeforeForward, true);
  await f.settled(); assert.equal(f.sent.length, 0);
  assert.equal(f.view.__supportAdapterUploadAudit().forwarded, 0);
  await assert.rejects(f.install(), /CONSUMED/);
});

test('a pre-opened XHR, changed multipart body or caller-mutated seal cannot bypass the guard', async () => {
  for (const mode of ['pre-opened', 'multipart', 'seal']) {
    const f = await browserFixture(), { xhr, body } = f.request();
    if (mode === 'seal') f.seal.fileSha256 = sha('bad');
    if (mode === 'pre-opened') f.untracked.send(body);
    else {
      xhr.send(body);
      if (mode === 'multipart') body.set('tarball', new File(['bad'], NAME));
    }
    await f.settled(); assert.equal(f.sent.length, mode === 'seal' ? 1 : 0);
  }
});

test('a consumed seal cannot be armed again in a reloaded context sharing its attempt marker', async () => {
  const f = await browserFixture();
  await assert.rejects(browserFixture({ storage: f.storage }), /CONSUMED/);
});

test('independent tabs sharing origin storage cannot arm the same root attempt twice', async () => {
  const storage = new Map(), results = await Promise.allSettled([browserFixture({ storage }), browserFixture({ storage })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && /CONSUMED/.test(r.reason.message)).length, 1);
  const f = results.find(r => r.status === 'fulfilled').value, request = f.request();
  request.xhr.send(request.body); await f.settled(); assert.equal(f.sent.length, 1);
});

test('GET reuse and late load events never turn an unknown upload into a successful native result', async () => {
  for (const mode of ['reuse', 'error', 'abort']) {
    const f = await browserFixture(), { xhr, body } = f.request(); xhr.send(body); await f.settled();
    assert.equal(f.sent.length, 1);
    if (mode === 'reuse') { xhr.open('GET', '/settings'); xhr.send(); }
    if (mode === 'error') xhr.error();
    if (mode === 'abort') xhr.abort();
    xhr.finish(200); assert.equal(f.view.__supportAdapterUploadAudit().httpStatus, 0);
    assert.equal(f.view.__supportAdapterUploadAudit().terminal, true);
  }
});

test('policy cancellation reconciles an exact unpublished alias and a partial intent pair', () => {
  for (const mode of ['link-failure', 'partial-intent']) {
    const f = fixture(), link = fs.linkSync, open = fs.openSync;
    try {
      f.reserve();
      if (mode === 'link-failure') fs.linkSync = function (from, to) {
        if (to === f.policy) throw Error('SYNTHETIC_PRE_LINK'); return link.call(fs, from, to);
      };
      else fs.openSync = function (file, ...args) {
        if (file === path.join(f.backupStage, 'policy-intent.json')) throw Error('SYNTHETIC_INTENT_COPY');
        return open.call(fs, file, ...args);
      };
      assert.throws(() => f.publish(), /SYNTHETIC_/); fs.linkSync = link; fs.openSync = open;
      assert.equal(fs.existsSync(f.policy), false);
      f.controller().cancel(f.input); f.op.removePolicy(f.input); f.op.handback(f.input);
      assert.deepEqual(fs.readFileSync(f.lease), f.original); assert.equal(fs.existsSync(f.policy), false);
    } finally { fs.linkSync = link; fs.openSync = open; f.cleanup(); }
  }
});

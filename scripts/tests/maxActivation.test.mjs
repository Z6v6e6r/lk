import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { createActivation, FILES, hash, PAUSE, DIRECT_PINS, classifyStartup } from '../nodered_max_activation.mjs';
import { buildSources } from '../prepare_max_response_guard.mjs';
const fixtures = new URL('./fixtures/max-response-guard/', import.meta.url);
const source = n => fs.readFileSync(new URL(n + '.js.txt', fixtures), 'utf8');
const client = 'dist/core/network/api/client.js', messages = 'dist/core/network/api/modules/messages/api.js';
const candidates = buildSources(source('client'), source('messages-api'));
function scenario(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-activation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'node_modules/@maxhub/max-bot-api');
  const contrib = path.join(root, 'node_modules/node-red-contrib-maxbot');
  const stage = path.join(root, '.padlhub-max-guard-stage-synthetic');
  fs.mkdirSync(stage, { mode: 0o700 });
  const put = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
  put(path.join(sdk, 'package.json'), JSON.stringify({ name: '@maxhub/max-bot-api', version: '0.2.2' }));
  put(path.join(contrib, 'package.json'), JSON.stringify({ version: '0.6.1' }));
  for (const n of ['maxbot-send', 'maxbot-receive', 'maxbot-config']) put(path.join(contrib, `dist/nodes/${n}.js`), source(n));
  put(path.join(sdk, client), source('client')); put(path.join(sdk, messages), source('messages-api'));
  for (let i = 0; i < 41; i++) put(path.join(sdk, `dist/synthetic-${i}.js`), '// synthetic\n');
  const entries = () => { const items = []; const walk = d => { for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) items.push([path.relative(sdk, p), hash(fs.readFileSync(p))]);
  } }; walk(path.join(sdk, 'dist')); return items.sort((a, b) => a[0].localeCompare(b[0])); };
  const before = entries(), preClosure = hash(JSON.stringify(before));
  const postClosure = hash(JSON.stringify(before.map(([p, h]) => [p, candidates[p] ? hash(candidates[p]) : h])));
  for (const [file, name] of FILES) { put(path.join(stage, name), candidates[file]); fs.chmodSync(path.join(stage, name), 0o600); }
  const types = ['maxbot-receive', 'maxbot-receive', 'maxbot-send', 'maxbot-send', 'inject', 'inject', 'function', 'function'];
  const flow = types.map((type, i) => ({ id: 'synthetic-' + i, type, wires: [], d: false }));
  const directPins = new Map();
  for (const n of flow.slice(6, 8)) { n.func = "msg.method='POST'; msg.url='https://platform-api.max.ru/answers'; return msg;"; directPins.set(hash(n.id), hash(n.func)); }
  flow.push({ id: 'unrelated', type: 'function', func: 'return msg;', wires: [] });
  const pause = new Map(flow.slice(0, 8).map(n => [hash(n.id), n.type]));
  put(path.join(root, 'flows.json'), JSON.stringify(flow));
  for (const n of ['settings.js', 'package.json', 'flows_cred.json']) put(path.join(root, n), '{}');
  let clock = 100000, stopCalls = 0, startCalls = 0;
  let state = { pid: 900001, status: 'online', restarts: 100, uptime: 1000, watchEnabled: !!options.watch, cronEnabled: !!options.cron, definitionHash: '0'.repeat(64) };
  const initial = structuredClone(state);
  const pm2 = {
    inspect: () => structuredClone(state),
    captureStartup: () => ({ inode: 1, offset: 0, pathSha256: '3'.repeat(64) }),
    readiness: () => ({ startedFlows: !options.notReady, startupFailure: !!options.startupError }),
    stop() {
      stopCalls++;
      if (options.stopUnknown) return false;
      state = { ...state, pid: 0, status: 'stopped' }; return !options.stopAckLost;
    },
    start() {
      startCalls++;
      assert.equal(state.status, 'stopped');
      assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'flows.json'))).slice(0, 8).every(n => n.d === true));
      for (const [p,,, h] of FILES) assert.equal(hash(fs.readFileSync(path.join(sdk, p))), h);
      state = { ...state, status: 'online', pid: 900002, uptime: 2000, restarts: initial.restarts + (options.restartLoop ? 2 : options.counterUnchanged ? 0 : 1) };
      return !options.startAckLost;
    },
  };
  const runtime = createActivation({ root, pm2, uid: process.getuid(), gid: process.getgid(), now: () => clock,
    machineHash: () => '1'.repeat(64), installerHash: () => '2'.repeat(64), resolveSdk: () => path.join(sdk, 'dist/index.js'),
    preClosure, postClosure, pause, directPins, readinessTimeoutMs: 0, processAbsent: () => !options.stopUnknown,
    checkpoint: value => {
      if (value === options.failAt) throw Error('synthetic-private-error');
      if (value === 'VERIFIED_PAUSED' && options.foreignAfterStart === 'settings') fs.appendFileSync(path.join(root, 'settings.js'), '\n');
      if (value === 'VERIFIED_PAUSED' && options.foreignAfterStart === 'lease') {
        const p = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json'), l = JSON.parse(fs.readFileSync(p));
        l.token = 'foreign-token'; fs.writeFileSync(p, JSON.stringify(l));
      }
      if (value === 'VERIFIED_PAUSED' && options.foreignAfterStart) throw Error('MAX_FOREIGN_AFTER_START');
      if (value === 'STARTING' && options.foreignBeforeStart) fs.writeFileSync(path.join(sdk, FILES[0][0]), 'foreign');
    },
  });
  const packet = runtime.prepare(stage), packetSha = hash(Buffer.from(JSON.stringify(packet)));
  return { root, sdk, stage, runtime, packet, initial, activate: () => runtime.activate(stage, packet, packetSha),
    stopCalls: () => stopCalls, startCalls: () => startCalls, driftRuntime: () => { state = { ...state, pid: 900003, restarts: state.restarts + 1 }; }, advance: () => { clock += 900001; },
    journal: () => JSON.parse(fs.readFileSync(path.join(stage, 'transaction/journal.json'))),
    lease: () => JSON.parse(fs.readFileSync(path.join(root, '.padlhub-reviewed-flow-deploy.lease.json'))) };
}
test('production pause set has exactly two receivers, senders, pollers and callback formatters', () => {
  assert.equal(PAUSE.size, 8);
  for (const type of ['maxbot-receive', 'maxbot-send', 'inject', 'function']) assert.equal([...PAUSE.values()].filter(x => x === type).length, 2);
});
test('stopped transaction commits complete SDK, only eight disabled flags, one start and soak', t => {
  const s = scenario(t), original = fs.readFileSync(path.join(s.root, 'flows.json'));
  const result = s.activate();
  assert.equal(result.status, 'ACTIVATED_MAX_PAUSED'); assert.equal(s.stopCalls(), 1); assert.equal(s.startCalls(), 1);
  const paused = JSON.parse(fs.readFileSync(path.join(s.root, 'flows.json'))), before = JSON.parse(original);
  assert.deepEqual(paused, before.map((n, i) => i < 8 ? { ...n, d: true } : n));
  assert.equal(s.lease().phase, 'soaking'); assert.equal(s.journal().phase, 'VERIFIED_PAUSED');
  assert.equal(fs.statSync(path.join(s.stage, 'transaction/flows.before.json')).mode & 0o777, 0o600);
  assert.equal(s.runtime.observe(s.stage, s.packet, hash(Buffer.from(JSON.stringify(s.packet)))).status, 'SOAKING_MAX_PAUSED');
  s.advance(); assert.equal(s.runtime.observe(s.stage, s.packet, hash(Buffer.from(JSON.stringify(s.packet)))).status, 'SOAK_VERIFIED_MAX_PAUSED');
  assert.ok(!fs.existsSync(path.join(s.root, '.padlhub-reviewed-flow-deploy.lease.json')));
});
for (const option of ['stopAckLost', 'startAckLost', 'counterUnchanged']) test(`${option}: reconcile without second start`, t => {
  const s = scenario(t, { [option]: true }); assert.equal(s.activate().status, 'ACTIVATED_MAX_PAUSED');
  assert.equal(s.stopCalls(), 1); assert.equal(s.startCalls(), 1);
});
test('ambiguous stop makes no flow/SDK publication or start', t => {
  const s = scenario(t, { stopUnknown: true }), original = fs.readFileSync(path.join(s.root, 'flows.json'));
  assert.throws(s.activate, /MAX_STOP_NOT_CONFIRMED/); assert.equal(s.startCalls(), 0);
  assert.deepEqual(fs.readFileSync(path.join(s.root, 'flows.json')), original);
  assert.equal(s.journal().failurePhase, 'STOPPING'); assert.equal(s.lease().phase, 'applying');
});
for (const failAt of ['FLOW_PAUSED', 'HELPER_COMMITTED', 'MESSAGES_COMMITTED', 'CLIENT_COMMITTED', 'FILES_COMMITTED']) test(`interruption after ${failAt}: stopped, no rollback to enabled graph`, t => {
  const s = scenario(t, { failAt }); assert.throws(s.activate, /MAX_ACTIVATION_INTERRUPTED/);
  assert.equal(s.stopCalls(), 1); assert.equal(s.startCalls(), 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(s.root, 'flows.json'))).slice(0, 8).every(n => n.d));
  assert.equal(s.journal().phase, 'OWNER_RECOVERY_REQUIRED'); assert.equal(s.lease().phase, 'applying');
  assert.ok(!JSON.stringify(s.journal()).includes('synthetic-private-error'));
});
test('foreign SDK bytes before start remain stopped with custody', t => {
  const s = scenario(t, { foreignBeforeStart: true }); assert.throws(s.activate, /MAX_SDK_STATE_DRIFT/);
  assert.equal(s.startCalls(), 0); assert.equal(s.lease().phase, 'applying');
});
test('unhealthy/restarting start quarantines with stop and never starts twice', t => {
  const s = scenario(t, { restartLoop: true }); assert.throws(s.activate, /MAX_START_UNVERIFIED/);
  assert.equal(s.startCalls(), 1); assert.equal(s.stopCalls(), 2); assert.equal(s.lease().phase, 'applying');
});
test('foreign flow, config, asset, package and active lease are refused before stop', t => {
  for (const target of ['flow', 'settings', 'asset', 'package', 'lease']) {
    const s = scenario(t);
    if (target === 'flow') fs.appendFileSync(path.join(s.root, 'flows.json'), '\n');
    if (target === 'settings') fs.appendFileSync(path.join(s.root, 'settings.js'), '\n');
    if (target === 'asset') fs.appendFileSync(path.join(s.stage, FILES[0][1]), '\n');
    if (target === 'package') fs.appendFileSync(path.join(s.sdk, 'package.json'), '\n');
    if (target === 'lease') fs.writeFileSync(path.join(s.root, '.padlhub-reviewed-flow-deploy.lease.json'), JSON.stringify({ phase: 'applying', formatVersion: 2 }));
    assert.throws(s.activate); assert.equal(s.stopCalls(), 0); assert.equal(s.startCalls(), 0);
  }
});
test('extra MAX caller or direct provider source is refused before stop', t => {
  for (const extra of [{ id: 'extra', type: 'max-outbox-send' }, { id: 'http', type: 'http request', url: 'https://platform-api2.max.ru/messages' }]) {
    const s = scenario(t), p = path.join(s.root, 'flows.json'), flow = JSON.parse(fs.readFileSync(p));
    flow.push(extra); fs.writeFileSync(p, JSON.stringify(flow));
    assert.throws(() => s.runtime.prepare(s.stage), /MAX_CUSTOM_CALLER|MAX_PAUSE_COVERAGE/); assert.equal(s.stopCalls(), 0);
  }
});
test('source symlinks and helper aliases cannot pass preflight', t => {
  const s = scenario(t), p = path.join(s.sdk, FILES[0][0]); fs.symlinkSync('/missing/synthetic', p);
  assert.throws(() => s.runtime.prepare(s.stage)); assert.equal(s.stopCalls(), 0);
});

test('runtime drift during soak quarantines once, retains nonexpiring custody, never restarts', t => {
  const s = scenario(t); s.activate(); s.driftRuntime();
  assert.throws(() => s.runtime.observe(s.stage, s.packet, hash(Buffer.from(JSON.stringify(s.packet)))), /MAX_SOAK_DRIFT/);
  assert.equal(s.startCalls(), 1); assert.equal(s.stopCalls(), 2);
  assert.equal(s.lease().phase, 'applying'); assert.equal(s.journal().phase, 'OWNER_RECOVERY_REQUIRED');
});

for (const option of ['notReady', 'startupError']) test(`${option}: never verifies flow readiness or retries start`, t => {
  const s = scenario(t, { [option]: true }); assert.throws(s.activate, /MAX_NODE_RED_/);
  assert.equal(s.startCalls(), 1); assert.equal(s.stopCalls(), 2); assert.equal(s.lease().phase, 'applying');
});
test('interruption after soaking publication retains applying custody before quarantine', t => {
  const s = scenario(t, { failAt: 'SOAK_LEASE_PUBLISHED' }); assert.throws(s.activate, /MAX_ACTIVATION_INTERRUPTED/);
  assert.equal(s.startCalls(), 1); assert.equal(s.stopCalls(), 2); assert.equal(s.lease().phase, 'applying');
});
test('malformed expired leases cannot be reclaimed', t => {
  for (const value of [{ phase: 'soaking', formatVersion: 2, expiresAtMs: 1 },
    { phase: 'soaking', formatVersion: 2, deploymentId: 'valid-owner', acquiredAtMs: 10, expiresAtMs: 1 }]) {
    const s = scenario(t); fs.writeFileSync(path.join(s.root, '.padlhub-reviewed-flow-deploy.lease.json'), JSON.stringify(value), { mode: 0o600 });
    assert.throws(s.activate, /MAX_FOREIGN_DEPLOY_LEASE/); assert.equal(s.stopCalls(), 0);
  }
});
test('observe requires the supplied packet hash', t => {
  const s = scenario(t); s.activate(); assert.throws(() => s.runtime.observe(s.stage, s.packet, '0'.repeat(64)), /MAX_OBSERVATION_PACKET/);
});
test('foreign settings or lease during soak are never quarantined/overwritten', t => {
  for (const foreign of ['settings', 'lease']) {
    const s = scenario(t); s.activate();
    const leasePath = path.join(s.root, '.padlhub-reviewed-flow-deploy.lease.json');
    let value;
    if (foreign === 'settings') fs.appendFileSync(path.join(s.root, 'settings.js'), '\n');
    else { value = s.lease(); value.token = 'foreign-token'; fs.writeFileSync(leasePath, JSON.stringify(value)); }
    assert.throws(() => s.runtime.observe(s.stage, s.packet, hash(Buffer.from(JSON.stringify(s.packet)))));
    assert.equal(s.stopCalls(), 1); assert.equal(s.startCalls(), 1);
    if (value) assert.equal(s.lease().token, 'foreign-token');
  }
});

test('watch/cron policies refuse prepare without any stop or start', t => {
  for (const option of ['watch', 'cron']) assert.throws(() => scenario(t, { [option]: true }), /MAX_PM2_AUTOSTART_POLICY/);
});
test('foreign state after start is not quarantined by apply catch', t => {
  for (const foreignAfterStart of ['settings', 'lease']) {
    const s = scenario(t, { foreignAfterStart }); assert.throws(s.activate, /MAX_FOREIGN_AFTER_START/);
    assert.equal(s.stopCalls(), 1); assert.equal(s.startCalls(), 1);
    if (foreignAfterStart === 'lease') assert.equal(s.lease().token, 'foreign-token');
  }
});

test('startup readiness requires a new complete boot and rejects startup failures', () => {
  const started = 'Welcome to Node-RED\n12 Nov - [info] Starting flows\n12 Nov - [info] Started flows\n';
  assert.deepEqual(classifyStartup(started), { startedFlows: true, startupFailure: false });
  assert.equal(classifyStartup('[info] Started flows').startedFlows, false);
  assert.equal(classifyStartup(started + '[info] Stopping flows').startedFlows, false);
  assert.equal(classifyStartup(started.replace('[info] Started flows', 'Error loading module\n[info] Started flows')).startupFailure, true);
  assert.equal(classifyStartup(started + 'SyntaxError in unrelated background operation').startupFailure, false);
});

test('direct callback allowlist requires pinned identity and exact disabled source', t => {
  assert.equal(DIRECT_PINS.size, 2);
  const s = scenario(t), p = path.join(s.root, 'flows.json'), flow = JSON.parse(fs.readFileSync(p));
  flow[6].func += '\n'; fs.writeFileSync(p, JSON.stringify(flow));
  assert.throws(() => s.runtime.prepare(s.stage), /MAX_DIRECT_SOURCE_DRIFT/); assert.equal(s.stopCalls(), 0);
});

test('pinned formatter cannot authorize extra direct-provider initializer or URL fields', t => {
  const s = scenario(t), p = path.join(s.root, 'flows.json'), flow = JSON.parse(fs.readFileSync(p));
  flow[6].initialize = "fetch('https://platform-api.max.ru/messages')";
  fs.writeFileSync(p, JSON.stringify(flow)); assert.throws(() => s.runtime.prepare(s.stage), /MAX_PAUSE_COVERAGE/);
  assert.equal(s.stopCalls(), 0);
});

test('explicit target modes survive restrictive production umask', t => {
  const s = scenario(t), targets = [path.join(s.root, 'flows.json'), path.join(s.sdk, client), path.join(s.sdk, messages)];
  for (const p of targets) fs.chmodSync(p, 0o644);
  const previous = process.umask(0o077);
  try {
    s.activate();
    for (const p of targets) assert.equal(fs.statSync(p).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(s.stage, 'transaction/journal.json')).mode & 0o777, 0o600);
  } finally { process.umask(previous); }
});

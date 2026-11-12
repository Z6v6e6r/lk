#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const self = fileURLToPath(import.meta.url);
const SOURCE = '8aca5f369689047468b3e1f6daaa94b7f8fd85dd';
const CLIENT = 'dist/core/network/api/client.js', MESSAGES = 'dist/core/network/api/modules/messages/api.js';
const HELPER = 'dist/core/network/api/max-response-guard.cjs';
export const FILES = [
  [HELPER, 'max-response-guard.cjs', null, '2dab53a9b206dd84aa855cdd407c333f5ab27c82756861e68c3006a29a37221e'],
  [MESSAGES, 'messages.candidate.js', 'fa2b34c762f0c912c9e923ffe9cdf4c70f054fda19b124bd34adb6c1751b1769', '5bf3c505355b7ba2b1464777cd90e1aabd43d802b1062355d56414219f49e786'],
  [CLIENT, 'client.candidate.js', '5287d8c7f596fe9d11c79d2ed32d074c788302860d42b9303b169d1e60ce6c77', '4b730894297c41ed0c50a8053e59ac4fc0361dae170bb8ca3e03d4e2e9fda68b'],
];
export const PAUSE = new Map([
  ['16e3a875ebdc3b732d8c80146c837208fee28c7933b1c27bf62414465fc09336', 'maxbot-receive'],
  ['31c6c1562f313e81e32b442f4a3eaa6e2218923905fbca94190714d7369f7e9d', 'maxbot-receive'],
  ['3dacb768bb21bd88afbcccc110e8be92a54e29401133cc1ce0cc13f7fe3f58ea', 'maxbot-send'],
  ['002ccefeee7a5777e7c6eac2217bbc41cdbe7c45a7dcec85c70a52a94d030de9', 'maxbot-send'],
  ['86593a32f10baa2c97514089aeae1d504fb0bf595d5b24d0152ae91da4111157', 'inject'],
  ['07012cfff48f1f340d20a18b91ff92171cdd13bceb1acc913ac9db672b37e43a', 'inject'],
]);
export const DIRECT_PINS = new Map([
  ['c4181506f9fd49b5dedbf113db7f17430a8f900bd87b3ff9d4c64a2c26105b29', 'f613dee82da08b62e245e709df946b309b5da023251a28dc075c0f5ec0d4ea4c'],
  ['bce91ef6d5d011c542ce5e697eb14b87d7440c87616a85ca4f55469d67568467', 'fb8bb2f015021be4f800e9e0f22ba9428d5dd001ab596f6227b23e8c359dee19'],
]);
for (const idHash of DIRECT_PINS.keys()) PAUSE.set(idHash, 'function');
const CALLERS = {
  'maxbot-send': '1f959b7b6fd6971ea57b4f53b844c77ec53eb25e79fcb2adb9be2c5bd75a162e',
  'maxbot-receive': '4ef4dbe52a57841f7209de25a2b2811be564ea12738dd27e5fd831cd903e1ab0',
  'maxbot-config': '5789597afd7b8ec12762ea46c1c00707f46ba77a4ffd879312b9cc861860a74e',
};
const PRE_CLOSURE = 'a47f1bf36ac3520556abdd508fde704ea89035832dfd12ce0fbeb1a5c69470eb';
const POST_CLOSURE = 'bac670afd0109949a5b1add89aefbfc1b59370d8f464447ad1d4a3743cf3e1e4';
const check = (ok, code) => { if (!ok) throw Error(code); };
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hex = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export function classifyStartup(text) {
  const welcome = text.lastIndexOf('Welcome to Node-RED'), start = text.lastIndexOf('[info] Starting flows');
  const finish = text.lastIndexOf('[info] Started flows'), stop = text.lastIndexOf('[info] Stopping flows');
  const boot = welcome >= 0 ? text.slice(welcome, finish > welcome ? finish : undefined) : '';
  return { startedFlows: welcome >= 0 && start > welcome && finish > start && stop < start,
    startupFailure: /Flows stopped due to missing node types|Error loading|Failed to start|Error starting flows|Cannot find module|SyntaxError/.test(boot) };
}

export function createPm2() {
  const run = (args, timeout = 15000) => spawnSync('pm2', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  const details = () => {
    const r = run(['jlist']); check(!r.error && r.status === 0, 'MAX_PM2_INSPECT_FAILED');
    const items = JSON.parse(r.stdout).filter(x => x.name === 'node-red'); check(items.length === 1, 'MAX_PM2_AMBIGUOUS');
    return items[0];
  };
  const logFile = () => {
    const p = details().pm2_env.pm_out_log_path;
    check(typeof p === 'string' && p.startsWith('/root/.pm2/logs/') && fs.realpathSync(p) === p, 'MAX_STARTUP_LOG_PATH');
    const s = fs.lstatSync(p); check(s.isFile() && s.nlink === 1 && s.uid === 0 && !(s.mode & 0o022), 'MAX_STARTUP_LOG_CUSTODY');
    return p;
  };
  return {
    inspect() {
      const p = details(), e = p.pm2_env;
      const definition = Object.fromEntries(['pm_exec_path', 'pm_cwd', 'exec_interpreter', 'node_args', 'args', 'exec_mode', 'instances', 'env', 'autorestart', 'watch', 'cron_restart'].map(k => [k, e[k] ?? null]));
      return { pid: p.pid || 0, status: e.status, restarts: e.restart_time, uptime: e.pm_uptime,
        watchEnabled: Array.isArray(e.watch) ? e.watch.length > 0 : !!e.watch,
        cronEnabled: typeof e.cron_restart === 'string' ? !!e.cron_restart.trim() : !!e.cron_restart,
        definitionHash: hash(JSON.stringify(canonical(definition))) };
    },
    captureStartup() {
      const p = logFile(), s = fs.statSync(p); return { inode: s.ino, offset: s.size, pathSha256: hash(p) };
    },
    readiness(cursor) {
      const p = logFile(), st = fs.statSync(p);
      check(hash(p) === cursor.pathSha256 && st.ino === cursor.inode && st.size >= cursor.offset && st.size - cursor.offset < 8 * 1024 * 1024, 'MAX_STARTUP_LOG_DRIFT');
      const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), b = Buffer.alloc(st.size - cursor.offset);
      try { fs.readSync(fd, b, 0, b.length, cursor.offset); } finally { fs.closeSync(fd); }
      return classifyStartup(b.toString('utf8'));
    },
    stop() { const r = run(['stop', 'node-red'], 60000); return !r.error && r.status === 0; },
    start() { const r = run(['start', 'node-red'], 60000); return !r.error && r.status === 0; },
  };
}

export function createActivation({ root = '/root/.node-red', pm2 = createPm2(), uid = 0, gid = 0,
  now = Date.now, preClosure = PRE_CLOSURE, postClosure = POST_CLOSURE,
  machineHash = () => hash(fs.readFileSync('/etc/machine-id')),
  installerHash = () => hash(fs.readFileSync(self)), resolveSdk,
  pause = PAUSE, directPins = DIRECT_PINS, releaseCommit = SOURCE, readinessTimeoutMs = 60000, checkpoint = () => {}, processAbsent = pid => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } },
} = {}) {
  const sdk = path.join(root, 'node_modules/@maxhub/max-bot-api');
  const contrib = path.join(root, 'node_modules/node-red-contrib-maxbot');
  const flowPath = path.join(root, 'flows.json');
  const leasePath = path.join(root, '.padlhub-reviewed-flow-deploy.lease.json');
  const protectedPaths = ['settings.js', 'package.json', 'flows_cred.json'];
  const syncDir = dir => { const fd = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  const regular = (p, directory = false) => {
    check(fs.realpathSync(p) === p, 'MAX_PATH_ALIAS');
    const s = fs.lstatSync(p);
    check((directory ? s.isDirectory() : s.isFile() && s.nlink === 1) && s.uid === uid && s.gid === gid && !(s.mode & 0o022), 'MAX_FILE_CUSTODY');
    return s;
  };
  const read = p => {
    const before = regular(p), fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd), b = fs.readFileSync(fd), after = fs.lstatSync(p);
      check(st.ino === before.ino && st.dev === before.dev && st.ino === after.ino && st.dev === after.dev && st.size === after.size && st.mtimeMs === after.mtimeMs, 'MAX_FILE_REPLACED');
      return b;
    } finally { fs.closeSync(fd); }
  };
  const writeExclusive = (p, b, mode = 0o600) => {
    const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, b); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDir(path.dirname(p));
  };
  const atomic = (p, b, mode = 0o600) => {
    regular(path.dirname(p), true);
    if (exists(p)) regular(p);
    const tmp = path.join(path.dirname(p), `.max-guard-${crypto.randomUUID()}`);
    writeExclusive(tmp, b, mode); fs.renameSync(tmp, p); syncDir(path.dirname(p));
  };
  const jsonWrite = (p, value) => atomic(p, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
  const snapshot = () => Object.fromEntries(protectedPaths.map(p => [p, exists(path.join(root, p)) ? hash(read(path.join(root, p))) : null]));
  const closure = () => {
    const items = [];
    const walk = d => { regular(d, true); for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), s = fs.lstatSync(p); check(!s.isSymbolicLink(), 'MAX_SDK_ALIAS');
      if (s.isDirectory()) walk(p); else if (n.endsWith('.js')) items.push([path.relative(sdk, p), hash(read(p))]);
    } };
    walk(path.join(sdk, 'dist')); items.sort((a, b) => a[0].localeCompare(b[0]));
    check(items.length === 43, 'MAX_SDK_FILE_COUNT'); return hash(JSON.stringify(items));
  };
  const assertBindings = () => {
    regular(root, true); regular(sdk, true);
    const meta = JSON.parse(read(path.join(sdk, 'package.json'))), cm = JSON.parse(read(path.join(contrib, 'package.json')));
    check(meta.name === '@maxhub/max-bot-api' && meta.version === '0.2.2' && cm.version === '0.6.1', 'MAX_PACKAGE_VERSION');
    for (const [name, h] of Object.entries(CALLERS)) {
      const caller = path.join(contrib, 'dist/nodes', name + '.js'); check(hash(read(caller)) === h, 'MAX_CALLER_DRIFT');
      const resolved = resolveSdk ? resolveSdk(caller) : createRequire(caller).resolve('@maxhub/max-bot-api');
      check(resolved === path.join(sdk, 'dist/index.js'), 'MAX_RESOLUTION_DRIFT');
    }
  };
  const paused = b => {
    const flow = JSON.parse(b); check(Array.isArray(flow), 'MAX_FLOW_SHAPE');
    const ids = new Set(flow.map(n => n.id)); check(ids.size === flow.length && !ids.has(undefined), 'MAX_FLOW_IDS');
    const found = new Set(); let direct = 0;
    for (const n of flow) {
      const h = hash(n.id), type = pause.get(h);
      if (type) { check(n.type === type, 'MAX_PAUSE_NODE_TYPE');
        if (directPins.has(h)) check(n.type === 'function' && hash(n.func || '') === directPins.get(h), 'MAX_DIRECT_SOURCE_DRIFT');
        found.add(h); n.d = true; }
      if (['maxbot-send', 'maxbot-receive'].includes(n.type)) check(type === n.type, 'MAX_EXTRA_CALLER');
      check(!(/max/i.test(n.type) && !['maxbot-send', 'maxbot-receive', 'maxbot-config'].includes(n.type)), 'MAX_CUSTOM_CALLER');
      const extras = [n.url, n.initialize, ...(n.libs || []).map(x => x.module)].filter(x => typeof x === 'string').join('\n');
      const src = [extras, n.func].filter(x => typeof x === 'string').join('\n');
      if (/(?:platform-api\d*\.max\.ru|@maxhub\/max-bot-api)/i.test(src)
        && !(directPins.has(h) && n.d === true && hash(n.func || '') === directPins.get(h)
          && !/(?:platform-api\d*\.max\.ru|@maxhub\/max-bot-api)/i.test(extras))) direct++;
    }
    check(found.size === pause.size && direct === 0, 'MAX_PAUSE_COVERAGE');
    return Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  };
  const assertPaused = b => { const flow = JSON.parse(b); check(flow.filter(n => pause.has(hash(n.id)) && n.d === true).length === pause.size, 'MAX_PAUSE_NOT_ACTIVE'); };
  const currentHashes = () => Object.fromEntries(FILES.map(([p]) => [p, exists(path.join(sdk, p)) ? hash(read(path.join(sdk, p))) : null]));
  const assetBytes = stage => {
    regular(stage, true); check((fs.statSync(stage).mode & 0o777) === 0o700, 'MAX_STAGE_MODE');
    return FILES.map(([, name,, h]) => { check((fs.statSync(path.join(stage, name)).mode & 0o777) === 0o600, 'MAX_ASSET_MODE'); const b = read(path.join(stage, name)); check(hash(b) === h, 'MAX_ASSET_DRIFT'); return b; });
  };
  const noLease = () => {
    if (!exists(leasePath)) return;
    const l = JSON.parse(read(leasePath));
    check(l.formatVersion === 2 && l.phase === 'soaking' && /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(l.deploymentId || '')
      && Number.isSafeInteger(l.acquiredAtMs) && Number.isSafeInteger(l.expiresAtMs) && l.expiresAtMs > l.acquiredAtMs && l.expiresAtMs <= now()
      && (fs.statSync(leasePath).mode & 0o777) === 0o600, 'MAX_FOREIGN_DEPLOY_LEASE');
    // Same documented expired-soak rule; never expire applying/editor/unknown custody.
    check(hex(l.sourceSha256) && hex(l.candidateSha256) && typeof l.token === 'string' && l.token.trim().length > 0, 'MAX_LEASE_INVALID');
  };
  const prepare = stage => {
    assetBytes(stage); assertBindings(); noLease();
    const state = pm2.inspect(); check(!state.watchEnabled && !state.cronEnabled, 'MAX_PM2_AUTOSTART_POLICY'); check(state.status === 'online' && state.pid > 0, 'MAX_RUNTIME_NOT_ONLINE');
    const raw = read(flowPath), candidate = paused(raw);
    check(closure() === preClosure, 'MAX_SDK_CLOSURE_DRIFT');
    const expected = Object.fromEntries(FILES.map(([p,, pre]) => [p, pre]));
    check(equal(currentHashes(), expected), 'MAX_SDK_PREIMAGE');
    return { formatVersion: 1, sourceCommit: SOURCE, releaseCommit, installerSha256: installerHash(), createdAtMs: now(), machineIdSha256: machineHash(),
      flowSha256: hash(raw), pausedFlowSha256: hash(candidate), flowNodeCount: JSON.parse(raw).length,
      protected: snapshot(), sdkPackageSha256: hash(read(path.join(sdk, 'package.json'))), pm2: state };
  };
  const assertState = (p, wantedFlow, wantedSdk) => {
    assertBindings(); check(equal(snapshot(), p.protected) && hash(read(path.join(sdk, 'package.json'))) === p.sdkPackageSha256, 'MAX_CONFIG_DRIFT');
    check(hash(read(flowPath)) === wantedFlow, 'MAX_FLOW_DRIFT');
    if (wantedSdk) check(equal(currentHashes(), wantedSdk), 'MAX_SDK_STATE_DRIFT');
  };
  const activate = (stage, packet, packetSha) => {
    check(hash(Buffer.from(JSON.stringify(packet))) === packetSha && packet.formatVersion === 1 && packet.sourceCommit === SOURCE
      && packet.releaseCommit === releaseCommit && packet.installerSha256 === installerHash() && packet.machineIdSha256 === machineHash()
      && now() >= packet.createdAtMs && now() - packet.createdAtMs <= 300000, 'MAX_PACKET_BINDING');
    const assets = assetBytes(stage), fresh = prepare(stage);
    check(equal({ ...fresh, createdAtMs: 0 }, { ...packet, createdAtMs: 0 }), 'MAX_PREFLIGHT_DRIFT');
    const before = FILES.map(([p,, pre]) => [p, pre]), beforeMap = Object.fromEntries(before);
    const afterMap = Object.fromEntries(FILES.map(([p,,, h]) => [p, h]));
    const raw = read(flowPath), candidate = paused(raw), token = crypto.randomUUID();
    const stateDir = path.join(stage, 'transaction'); fs.mkdirSync(stateDir, { mode: 0o700 }); syncDir(stage);
    writeExclusive(path.join(stateDir, 'flows.before.json'), raw);
    writeExclusive(path.join(stateDir, 'flows.paused.json'), candidate);
    for (const [p, name, pre] of FILES) if (pre) writeExclusive(path.join(stateDir, name + '.before'), read(path.join(sdk, p)));
    const journalPath = path.join(stateDir, 'journal.json');
    const journal = { formatVersion: 1, token, packetSha256: packetSha, installerSha256: installerHash(), phase: 'PREPARED',
      sourceCommit: SOURCE, flowSha256: packet.flowSha256, pausedFlowSha256: packet.pausedFlowSha256,
      before: packet.pm2, beforeSdk: beforeMap, afterSdk: afterMap, operations: [], updatedAtMs: now() };
    const phase = value => { journal.phase = value; journal.updatedAtMs = now(); jsonWrite(journalPath, journal); checkpoint(value); };
    phase('PREPARED'); noLease();
    const lease = { formatVersion: 2, deploymentId: 'max-sdk-guard-paused-20261112', token, phase: 'applying',
      acquiredAtMs: now(), expiresAtMs: now() + 900000, sourceSha256: packet.flowSha256, candidateSha256: packet.pausedFlowSha256,
      sdkJournalSha256: hash(read(journalPath)) };
    if (exists(leasePath)) { fs.unlinkSync(leasePath); syncDir(root); }
    writeExclusive(leasePath, Buffer.from(JSON.stringify(lease, null, 2) + '\n'));
    const ownLease = (phases = ['applying']) => { const l = JSON.parse(read(leasePath)); check(l.formatVersion === 2 && l.token === token && phases.includes(l.phase) && l.sourceSha256 === packet.flowSha256 && l.candidateSha256 === packet.pausedFlowSha256, 'MAX_LEASE_LOST'); return l; };
    const retain = () => { const l = ownLease(['applying', 'soaking']); if (l.phase !== 'applying') { l.phase = 'applying'; jsonWrite(leasePath, l); } };
    const stopped = () => { const s = pm2.inspect(); check(s.status === 'stopped' && s.pid === 0 && s.definitionHash === packet.pm2.definitionHash
      && processAbsent(packet.pm2.pid), 'MAX_STOP_NOT_CONFIRMED'); return s; };
    try {
      assertState(packet, packet.flowSha256, beforeMap); check(equal(pm2.inspect(), packet.pm2), 'MAX_RUNTIME_DRIFT'); ownLease();
      journal.bootCursor = pm2.captureStartup(); phase('STOPPING'); journal.operations.push('stop'); jsonWrite(journalPath, journal);
      const acknowledged = pm2.stop();
      // A lost acknowledgment may still be reconciled by independently confirmed stop.
      stopped(); phase(acknowledged ? 'STOPPED' : 'STOPPED_RECONCILED');
      ownLease(); assertState(packet, packet.flowSha256, beforeMap); stopped();
      atomic(flowPath, candidate, fs.statSync(flowPath).mode & 0o777); phase('FLOW_PAUSED');
      for (let i = 0; i < FILES.length; i++) {
        ownLease(); stopped();
        const [p,, pre] = FILES[i], dest = path.join(sdk, p);
        check((exists(dest) ? hash(read(dest)) : null) === pre, 'MAX_TARGET_DRIFT');
        atomic(dest, assets[i], pre ? fs.statSync(dest).mode & 0o777 : 0o644); phase(['HELPER_COMMITTED', 'MESSAGES_COMMITTED', 'CLIENT_COMMITTED'][i]);
      }
      ownLease(); stopped(); assertState(packet, packet.pausedFlowSha256, afterMap); assertPaused(read(flowPath));
      check(closure() === postClosure, 'MAX_POST_CLOSURE'); phase('FILES_COMMITTED');
      phase('STARTING'); ownLease(); stopped(); assertState(packet, packet.pausedFlowSha256, afterMap);
      check(closure() === postClosure, 'MAX_POST_CLOSURE'); journal.operations.push('start'); jsonWrite(journalPath, journal);
      pm2.start();
      const readinessDeadline = performance.now() + readinessTimeoutMs;
      let ready;
      do {
        ready = pm2.readiness(journal.bootCursor);
        check(!ready.startupFailure, 'MAX_NODE_RED_STARTUP_FAILED');
        if (ready.startedFlows) break;
        if (performance.now() >= readinessDeadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      } while (!ready.startedFlows && performance.now() < readinessDeadline);
      check(ready.startedFlows, 'MAX_NODE_RED_NOT_READY');
      const after = pm2.inspect();
      check(after.status === 'online' && after.pid > 0 && after.pid !== packet.pm2.pid && after.uptime > packet.pm2.uptime
        && after.restarts >= packet.pm2.restarts && after.restarts <= packet.pm2.restarts + 1
        && after.definitionHash === packet.pm2.definitionHash, 'MAX_START_UNVERIFIED');
      ownLease(); assertState(packet, packet.pausedFlowSha256, afterMap); assertPaused(read(flowPath));
      check(closure() === postClosure, 'MAX_POST_CLOSURE');
      journal.after = after; phase('VERIFIED_PAUSED');
      lease.phase = 'soaking'; lease.acquiredAtMs = now(); lease.expiresAtMs = now() + 900000;
      lease.sdkJournalSha256 = hash(read(journalPath)); jsonWrite(leasePath, lease); checkpoint('SOAK_LEASE_PUBLISHED');
      return { status: 'ACTIVATED_MAX_PAUSED', sourceCommit: SOURCE, sdkFiles: 3, pausedNodes: pause.size,
        flowSha256: packet.pausedFlowSha256, sdkJsClosureSha256: postClosure, beforePid: packet.pm2.pid,
        afterPid: after.pid, beforeRestarts: packet.pm2.restarts, afterRestarts: after.restarts,
        protectedUnchanged: true, naturalErrorPathObserved: false, testProviderCalls: 0, soakUntilMs: lease.expiresAtMs };
    } catch (error) {
      const previous = journal.phase;
      // Never start again or restore an enabled graph. If STARTING may have left
      // an unhealthy/autorestarting process, quarantine with stop only.
      let retained = false;
      try { retain(); retained = true; } catch { /* never stop under foreign/uncertain custody */ }
      if (retained && ['STARTING', 'VERIFIED_PAUSED'].includes(previous)) {
        try {
          ownLease(); assertState(packet, packet.pausedFlowSha256, afterMap); assertPaused(read(flowPath));
          check(closure() === postClosure, 'MAX_POST_CLOSURE');
          const s = pm2.inspect();
          if (s.definitionHash === packet.pm2.definitionHash && (s.status !== 'stopped' || s.pid !== 0)) { journal.operations.push('quarantine-stop'); pm2.stop(); }
        } catch { /* foreign state is not ours to stop */ }
      }
      journal.failurePhase = previous; journal.failure = /^MAX_[A-Z_]+$/.test(error.message) ? error.message : 'MAX_ACTIVATION_INTERRUPTED';
      phase('OWNER_RECOVERY_REQUIRED');
      throw Error(journal.failure);
    }
  };
  const observe = (stage, packet, packetSha) => {
    check(packetSha === hash(Buffer.from(JSON.stringify(packet))) && packet.formatVersion === 1 && packet.sourceCommit === SOURCE
      && packet.releaseCommit === releaseCommit && packet.installerSha256 === installerHash() && packet.machineIdSha256 === machineHash(), 'MAX_OBSERVATION_PACKET');
    const journalPath = path.join(stage, 'transaction/journal.json'), j = JSON.parse(read(journalPath));
    check(j.phase === 'VERIFIED_PAUSED' && j.packetSha256 === hash(Buffer.from(JSON.stringify(packet))), 'MAX_OBSERVATION_JOURNAL');
    const l = JSON.parse(read(leasePath));
    check(l.token === j.token && l.phase === 'soaking' && l.sourceSha256 === packet.flowSha256 && l.candidateSha256 === packet.pausedFlowSha256, 'MAX_OBSERVATION_LEASE');
    const afterMap = Object.fromEntries(FILES.map(([p,,, h]) => [p, h]));
    try {
      assertState(packet, packet.pausedFlowSha256, afterMap); assertPaused(read(flowPath));
      check(closure() === postClosure && equal(pm2.inspect(), j.after), 'MAX_SOAK_DRIFT');
      const ready = pm2.readiness(j.bootCursor); check(ready.startedFlows && !ready.startupFailure, 'MAX_NODE_RED_NOT_READY');
    } catch (error) {
      let owned = false;
      try {
        const currentLease = JSON.parse(read(leasePath));
        check(currentLease.formatVersion === 2 && currentLease.token === j.token && currentLease.sourceSha256 === packet.flowSha256 && currentLease.candidateSha256 === packet.pausedFlowSha256, 'MAX_LEASE_LOST');
        currentLease.phase = 'applying'; jsonWrite(leasePath, currentLease); owned = true;
      } catch { /* do not overwrite foreign custody or stop its process */ }
      if (owned) try {
        assertState(packet, packet.pausedFlowSha256, afterMap); assertPaused(read(flowPath));
        check(closure() === postClosure, 'MAX_POST_CLOSURE');
        const current = pm2.inspect();
        if (current.definitionHash === j.after.definitionHash && (current.status !== 'stopped' || current.pid !== 0)) pm2.stop();
      } catch { /* unknown config/source is not ours to stop */ }
      j.phase = 'OWNER_RECOVERY_REQUIRED'; j.failure = 'MAX_SOAK_DRIFT'; j.updatedAtMs = now(); jsonWrite(journalPath, j);
      throw error;
    }
    const complete = now() >= l.expiresAtMs;
    if (complete) {
      j.phase = 'SOAK_VERIFIED_MAX_PAUSED'; j.updatedAtMs = now(); jsonWrite(journalPath, j);
      fs.unlinkSync(leasePath); syncDir(root);
    }
    return { status: complete ? 'SOAK_VERIFIED_MAX_PAUSED' : 'SOAKING_MAX_PAUSED', pausedNodes: pause.size,
      pid: j.after.pid, restarts: j.after.restarts, sdkJsClosureSha256: postClosure,
      flowSha256: packet.pausedFlowSha256, naturalErrorPathObserved: false, leaseReleased: complete };
  };
  return { prepare, activate, observe };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try {
    check(process.getuid() === 0, 'MAX_ROOT_REQUIRED'); process.umask(0o077);
    const [action, stage, packetSha] = process.argv.slice(2);
    check(['prepare', 'apply', 'observe'].includes(action) && path.dirname(stage || '') === '/root/.node-red'
      && /^\.padlhub-max-guard-stage-[a-z0-9-]{10,80}$/.test(path.basename(stage)), 'MAX_STAGE_PATH');
    const lockPath = '/root/.node-red/.padlhub-reviewed-flow-deploy.lock';
    check(fs.realpathSync('/root/.node-red') === '/root/.node-red', 'MAX_ROOT_ALIAS');
    if (exists(lockPath)) {
      const lock = fs.lstatSync(lockPath);
      check(fs.realpathSync(lockPath) === lockPath && lock.isFile() && lock.nlink === 1 && lock.uid === 0 && !(lock.mode & 0o022), 'MAX_LOCK_CUSTODY');
    }
    if (process.env.PADLHUB_MAX_ACTIVATION_LOCKED !== '1') {
      const r = spawnSync('flock', ['-n', '-E', '75', '/root/.node-red/.padlhub-reviewed-flow-deploy.lock', process.execPath, self, ...process.argv.slice(2)], {
        env: { ...process.env, PADLHUB_MAX_ACTIVATION_LOCKED: '1' }, encoding: 'utf8', timeout: 600000,
      });
      if (r.stdout) process.stdout.write(r.stdout);
      check(!r.error && r.status === 0, r.status === 75 ? 'MAX_DEPLOY_LOCK_BUSY' : 'MAX_CHILD_FAILED');
    } else {
      const releaseCommit = process.env.PADLHUB_MAX_ACTIVATION_SOURCE_COMMIT;
      check(/^[a-f0-9]{40}$/.test(releaseCommit || ''), 'MAX_RELEASE_COMMIT_REQUIRED');
      const runtime = createActivation({ releaseCommit });
      if (action === 'prepare') {
        const packet = runtime.prepare(stage), bytes = JSON.stringify(packet);
        // Safe packet contains only hashes/counts/enums/timestamps; no raw graph or env.
        console.log(JSON.stringify({ packet, packetSha256: hash(Buffer.from(bytes)) }));
      } else {
        check(hex(packetSha), 'MAX_PACKET_HASH_REQUIRED');
        const packetPath = path.join(stage, 'packet.json'), st = fs.lstatSync(packetPath);
        check(st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && (st.mode & 0o777) === 0o600, 'MAX_PACKET_CUSTODY');
        const packet = JSON.parse(fs.readFileSync(packetPath));
        console.log(JSON.stringify(action === 'apply' ? runtime.activate(stage, packet, packetSha) : runtime.observe(stage, packet, packetSha)));
      }
    }
  } catch (e) {
    console.error(/^MAX_[A-Z_]+$/.test(e.message) ? e.message : 'MAX_ACTIVATION_FAILED'); process.exitCode = 1;
  }
}

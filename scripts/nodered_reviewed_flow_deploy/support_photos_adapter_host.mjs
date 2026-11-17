// Read-only host bindings for the one-shot native palette installer. No npm,
// provider, PM2, database, flow writer or service-manager mutation is exposed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { readSupportPhotosProcessIdentity } from './support_photos_native_operation.mjs';
import { support_photosGraphHash, support_photosOrderedGraphHash } from './support_photos_body_preserver.mjs';

export const adapterLockPaths = ['/root/.node-red/.padlhub-reviewed-flow-deploy.lock',
  '/run/lock/phab-api-release.lock', '/run/lock/phab-cup-release.lock', '/opt/padlhub-max-inbound/.release.lock'];
export const adapterFiles = ['README.md', 'max-integration-config.js', 'max-media-config.js', 'max-media.js',
  'max-outbox-receipt.js', 'max-outbox-send.html', 'max-outbox-send.js', 'package.json'];
const ROOT = '/root/.node-red', MODULE = 'node-red-contrib-padlhub-max-outbox';
const UNIT_NAMES = ['phab-api-p32-2be5b1f.service', 'padlhub-max-inbound.service'];
const NR = '/usr/local/lib/node_modules/node-red/';
export const adapterRequiredInvariants = ['/root/.node-red/flows.json', '/root/.node-red/settings.js',
  '/root/.node-red/flows_cred.json', '/root/.node-red/.config.runtime.json',
  '/root/.node-red/.padlhub-runtime-hardening/harden_mongodb_logging.cjs',
  '/etc/phab-traffic/max-media-integration.json', '/etc/phab-traffic/support-media.env',
  '/etc/padlhub/max-padlhub-webhook.json', NR + 'red.js', NR + 'package.json',
  ...['registry/lib/installer.js', 'registry/lib/externalModules.js', 'registry/lib/index.js', 'registry/lib/loader.js',
    'registry/lib/registry.js', 'registry/lib/localfilesystem.js', 'editor-api/lib/admin/nodes.js',
    'editor-api/lib/admin/index.js', 'runtime/lib/api/nodes.js', 'runtime/lib/nodes/index.js', 'runtime/lib/settings.js',
    'runtime/lib/storage/localfilesystem/settings.js', 'runtime/lib/storage/localfilesystem/util.js',
    'util/lib/exec.js', 'util/lib/hooks.js'].map(name => NR + 'node_modules/@node-red/' + name)];
export const adapterSha = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));
const need = (value, code) => { if (!value) throw Error(code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const adapterObjectSha = value => adapterSha(encode(canonical(value)));

export function readAdapterFile(file, limit = 32 * 1024 * 1024, privateOnly = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd), named = fs.lstatSync(file);
    need(st.isFile() && st.uid === 0 && st.gid === 0 && st.nlink === 1 && !(st.mode & 0o022)
      && (!privateOnly || (st.mode & 0o777) === 0o600) && st.size <= limit
      && st.dev === named.dev && st.ino === named.ino, 'ADAPTER_HOST_FILE_CUSTODY');
    const raw = fs.readFileSync(fd); need(raw.length <= limit, 'ADAPTER_HOST_FILE_LIMIT'); return raw;
  } finally { fs.closeSync(fd); }
}
function directory(file) {
  const st = fs.lstatSync(file);
  need(st.isDirectory() && !st.isSymbolicLink() && st.uid === 0 && st.gid === 0
    && !(st.mode & 0o022) && fs.realpathSync(file) === file, 'ADAPTER_HOST_DIRECTORY');
}
export function readAdapterInventory(root) {
  directory(root); const result = {}; let total = 0, count = 0;
  const walk = current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), st = fs.lstatSync(file), rel = path.relative(root, file).split(path.sep).join('/');
      need(++count <= 50000, 'ADAPTER_HOST_INVENTORY_LIMIT');
      if (st.isSymbolicLink()) {
        const link = fs.readlinkSync(file), real = fs.realpathSync(file);
        need(!path.isAbsolute(link) && real.startsWith(root + path.sep), 'ADAPTER_HOST_LINK_ESCAPE');
        result[rel] = { link };
      } else if (st.isDirectory()) { directory(file); walk(file); }
      else {
        total += st.size;
        need(total <= 512 * 1024 * 1024, 'ADAPTER_HOST_INVENTORY_LIMIT');
        const raw = readAdapterFile(file); result[rel] = { bytes: raw.length, sha256: adapterSha(raw) };
      }
    }
  };
  walk(root); return result;
}
function procEpoch(pid) {
  const fd = fs.openSync('/proc/' + pid + '/stat', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let raw;
  try {
    need(fs.fstatSync(fd).isFile(), 'ADAPTER_HOST_PROCESS_STAT');
    const buffer = Buffer.alloc(65537), length = fs.readSync(fd, buffer, 0, buffer.length, null);
    need(length <= 65536, 'ADAPTER_HOST_PROCESS_STAT'); raw = buffer.subarray(0, length).toString();
  } finally { fs.closeSync(fd); }
  need(raw.startsWith(pid + ' (') && raw.lastIndexOf(') ') > 0, 'ADAPTER_HOST_PROCESS_STAT');
  const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/);
  need(/^[1-9]\d*$/.test(fields[19]), 'ADAPTER_HOST_PROCESS_EPOCH');
  return { pid, startTicks: fields[19], parentPid: Number(fields[1]) };
}
export function assertAdapterLocks({ fds, parentPid, parentStartTicks }, io = {
  stat: file => fs.lstatSync(file), fstat: fd => fs.fstatSync(fd), read: file => fs.readFileSync(file, 'utf8'),
  epoch: procEpoch, ppid: () => process.ppid,
  contender: file => spawnSync('/usr/bin/flock', ['--nonblock', '--exclusive', file, '/usr/bin/true'],
    { stdio: 'ignore', timeout: 5000 }),
}) {
  need(Array.isArray(fds) && fds.length === 4 && new Set(fds).size === 4
    && fds.every(fd => Number.isSafeInteger(fd) && fd >= 3), 'ADAPTER_LOCK_DESCRIPTORS');
  need(io.ppid() === parentPid && io.epoch(parentPid).startTicks === parentStartTicks, 'ADAPTER_HOLDER_EPOCH');
  const parent = io.stat('/proc/' + parentPid);
  need(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0, 'ADAPTER_HOLDER_OWNER');
  adapterLockPaths.forEach((file, i) => {
    const named = io.stat(file), open = io.fstat(fds[i]);
    need(named.isFile() && !named.isSymbolicLink() && named.uid === 0 && named.gid === 0 && named.nlink === 1
      && (named.mode & 0o777) === 0o600 && named.dev === open.dev && named.ino === open.ino, 'ADAPTER_LOCK_INODE');
    const info = io.read('/proc/self/fdinfo/' + fds[i]);
    need(/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+/m.test(info), 'ADAPTER_LOCK_NOT_HELD');
    const result = io.contender(file); // fresh open, never the inherited descriptor
    need(!result.error && result.signal === null && result.status === 1, 'ADAPTER_LOCK_CANARY');
    const after = io.stat(file); need(after.dev === named.dev && after.ino === named.ino, 'ADAPTER_LOCK_INODE');
  });
  need(io.epoch(parentPid).startTicks === parentStartTicks && io.ppid() === parentPid, 'ADAPTER_HOLDER_EPOCH');
  return true;
}

export function expectedAdapterRegistryEntry() {
  return { name: MODULE, version: '1.1.0', local: true, user: true, nodes: { 'max-outbox-send': {
    name: 'max-outbox-send', types: ['max-outbox-send', 'max-legacy-outbox-send', 'max-outbox-receipt'],
    enabled: true, local: true, user: false, module: MODULE, file: ROOT + '/node_modules/' + MODULE + '/max-outbox-send.js',
  } } };
}
export function validateAdapterInventoryTransition(before, after, expectedFiles) {
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !isDeepStrictEqual(before[key], after[key])).sort();
  need(isDeepStrictEqual(changes, ['.package-lock.json', ...adapterFiles.map(name => MODULE + '/' + name)].sort()), 'ADAPTER_REHEARSAL_CHANGESET');
  need(!Object.keys(before).some(key => key === MODULE || key.startsWith(MODULE + '/')), 'ADAPTER_REHEARSAL_PREEXISTING');
  for (const name of adapterFiles) need(isDeepStrictEqual(after[MODULE + '/' + name], expectedFiles[name]), 'ADAPTER_REHEARSAL_SOURCE');
  return true;
}
export function validateAdapterNativeProof(native, pins, installed, now = Date.now()) {
  const keys = ['origin', 'requestedAt', 'observedAt', 'count', 'dirty', 'revisionMatchesEditor', 'revisionSha256',
    'graphSha256', 'orderedGraphSha256', 'editorOrderedGraphSha256', 'adapter'];
  need(native && Object.keys(native).sort().join(',') === keys.sort().join(',')
    && native.origin === 'http://127.0.0.1:18801' && native.dirty === false && native.revisionMatchesEditor === true
    && native.count === pins.count && ['revisionSha256', 'graphSha256', 'orderedGraphSha256', 'editorOrderedGraphSha256']
      .every(k => hex(native[k]) && native[k] === pins[k]), 'ADAPTER_NATIVE_GRAPH_DRIFT');
  const from = Date.parse(native.requestedAt), to = Date.parse(native.observedAt);
  need(Number.isFinite(from) && Number.isFinite(to) && from <= to && to <= now && now - from <= 30000, 'ADAPTER_NATIVE_STALE');
  if (!installed) need(native.adapter === null, 'ADAPTER_NATIVE_ALREADY_INSTALLED');
  else need(isDeepStrictEqual(native.adapter, { name: MODULE, version: '1.1.0',
    nodeSets: [{ name: 'max-outbox-send', enabled: true, types: ['max-outbox-send', 'max-legacy-outbox-send', 'max-outbox-receipt'],
      error: false, pending: false }] }), 'ADAPTER_NATIVE_REGISTRATION');
  return true;
}

export function readAdapterTarget(config) {
  need(adapterRequiredInvariants.every(file => hex(config.invariantFiles?.[file])), 'ADAPTER_HOST_INVARIANT_CLOSURE');
  const identity = readSupportPhotosProcessIdentity(), env = Object.fromEntries(readAdapterFile('/proc/' + identity.pid + '/environ', 2 * 1024 * 1024)
    .toString().split('\0').filter(s => s.includes('=')).map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
  need(env.HOME === '/root' && !Object.keys(env).some(k => /^npm_config_/i.test(k) || ['NODE_OPTIONS', 'NODE_PATH'].includes(k)), 'ADAPTER_NPM_ENV_OVERRIDE');
  // Do not export PATH or any environment values. Resolve without shell.
  const tools = {};
  for (const command of ['npm', 'node']) {
    const matches = (env.PATH || '').split(':').filter(Boolean).map(dir => path.join(dir, command))
      .filter(file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } });
    need(matches.length > 0 && matches.every(file => path.isAbsolute(file)), 'ADAPTER_NPM_PATH');
    const real = fs.realpathSync(matches[0]); tools[command] = { path: real, sha256: adapterSha(readAdapterFile(real, 128 * 1024 * 1024)) };
  }
  for (const file of ['/root/.npmrc', '/usr/local/etc/npmrc', '/usr/local/lib/node_modules/npm/npmrc'])
    need(!fs.existsSync(file), 'ADAPTER_FOREIGN_NPM_CONFIG');
  const invariants = Object.fromEntries(Object.entries(config.invariantFiles).map(([file, pin]) => {
    need(path.isAbsolute(file) && hex(pin), 'ADAPTER_HOST_INVARIANT');
    const hash = adapterSha(readAdapterFile(file, 128 * 1024 * 1024)); need(hash === pin, 'ADAPTER_HOST_INVARIANT_DRIFT'); return [file, hash];
  }));
  const units = Object.fromEntries(UNIT_NAMES.map(unit => {
    const raw = execFileSync('/usr/bin/systemctl', ['show', unit, '--property=MainPID,ActiveState,SubState,NRestarts,ExecMainStartTimestampMonotonic'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    const values = Object.fromEntries(raw.trim().split('\n').map(s => s.split('=')));
    need(values.ActiveState === 'active' && values.SubState === 'running' && Number(values.MainPID) > 1, 'ADAPTER_DEPENDENT_SERVICE');
    return [unit, { ...values, startTicks: procEpoch(Number(values.MainPID)).startTicks }];
  }));
  return adapterObjectSha({ machine: adapterSha(readAdapterFile('/etc/machine-id')), identity, tools, invariants, units });
}

/** Request proof is supplied by the original authenticated editor; never auth headers or graph bodies. */
export function createAdapterHostBindings({ config, locks, native, installed }) {
  need(config?.schema === 'SUPPORT_ADAPTER_HOST_V1' && process.getuid() === 0, 'ADAPTER_HOST_CONFIG');
  const configKeys = ['schema', 'stage', 'backupStage', 'targetSha256', 'invariantFiles', 'nativePins',
    'beforeInventorySha256', 'afterInventorySha256', 'beforeRegistrySha256', 'images', 'prepare'];
  need(Object.keys(config).sort().join(',') === configKeys.sort().join(',') && hex(config.targetSha256)
    && path.dirname(config.stage) === ROOT && hex(config.beforeInventorySha256) && hex(config.afterInventorySha256)
    && hex(config.beforeRegistrySha256), 'ADAPTER_HOST_CONFIG');
  const load = (name, pin) => {
    const raw = readAdapterFile(path.join(config.stage, name), 16 * 1024 * 1024, true);
    need(adapterSha(raw) === pin, 'ADAPTER_HOST_INPUT_DRIFT'); return JSON.parse(raw);
  };
  const before = load('modules-before.json', config.beforeInventorySha256), after = load('modules-after.json', config.afterInventorySha256),
    registry = load('registry-before.json', config.beforeRegistrySha256);
  validateAdapterInventoryTransition(before, after, Object.fromEntries(adapterFiles.map(name => {
    const raw = fs.readFileSync(new URL('../../node-red/max-outbox-adapter/' + name, import.meta.url));
    return [name, { bytes: raw.length, sha256: adapterSha(raw) }];
  })));
  const expectedRegistry = { ...registry, [MODULE]: expectedAdapterRegistryEntry() };
  need(!Object.hasOwn(registry, MODULE), 'ADAPTER_REGISTRY_PREIMAGE');
  const assertExclusive = () => assertAdapterLocks(locks);
  const target = () => { assertExclusive(); return readAdapterTarget(config); };
  const idle = () => {
    const identity = readSupportPhotosProcessIdentity();
    const processes = new Map();
    for (const name of fs.readdirSync('/proc').filter(s => /^[1-9]\d*$/.test(s))) {
      try { const row = procEpoch(Number(name)); processes.set(row.pid, row); }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    assertNoAdapterDescendants([...processes.values()], identity.pid);
    need(readSupportPhotosProcessIdentity().startTicks === identity.startTicks, 'ADAPTER_INSTALLER_EPOCH');
    return true;
  };
  const image = post => {
    validateAdapterNativeProof(native(), config.nativePins, post);
    const files = config.images[post ? 'post' : 'pre'];
    need(files && Object.keys(files).sort().join(',') === 'innerLockSha256,packageLockSha256,packageSha256', 'ADAPTER_IMAGE_PINS');
    const result = {};
    for (const [key, file] of [['packageSha256', 'package.json'], ['packageLockSha256', 'package-lock.json'], ['innerLockSha256', 'node_modules/.package-lock.json']])
      result[key] = adapterSha(readAdapterFile(path.join(ROOT, file)));
    const inventory = readAdapterInventory(path.join(ROOT, 'node_modules'));
    need(isDeepStrictEqual(inventory, post ? after : before), 'ADAPTER_MODULE_INVENTORY_DRIFT');
    result.modulesSha256 = adapterObjectSha(inventory);
    const actualRegistry = JSON.parse(readAdapterFile(path.join(ROOT, '.config.nodes.json')));
    need(isDeepStrictEqual(actualRegistry, post ? expectedRegistry : registry), 'ADAPTER_REGISTRY_DRIFT');
    result.registrySha256 = adapterObjectSha(actualRegistry);
    if (post) {
      need(adapterSha(readAdapterFile(path.join(ROOT, '.config.nodes.json.backup'))) === config.beforeRegistrySha256, 'ADAPTER_REGISTRY_BACKUP_DRIFT');
      const tarball = path.join(ROOT, 'nodes', config.prepare.artifact.fileName);
      need(adapterSha(readAdapterFile(tarball)) === config.prepare.artifact.sha256, 'ADAPTER_NATIVE_TARBALL_DRIFT');
    } else need(!fs.existsSync(path.join(ROOT, 'nodes', config.prepare.artifact.fileName)), 'ADAPTER_NATIVE_TARBALL_PREIMAGE');
    need(Object.entries(files).every(([key, hash]) => hex(hash) && result[key] === hash), 'ADAPTER_PACKAGE_IMAGE_DRIFT');
    return result;
  };
  return { assertExclusive, readTarget: target, readPreimage: () => image(false), readPostimage: () => image(true), installerIdle: idle,
    // Explicitly fsync only expected installer outputs after exact postcheck, then recheck.
    syncPostimage() {
      need(installed() === true, 'ADAPTER_SYNC_BEFORE_TERMINAL');
      assertExclusive(); image(true); idle();
      const files = ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', '.config.nodes.json', '.config.nodes.json.backup',
        'nodes/' + config.prepare.artifact.fileName, ...adapterFiles.map(name => 'node_modules/' + MODULE + '/' + name)];
      for (const rel of files) { const fd = fs.openSync(path.join(ROOT, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      for (const dir of [ROOT, ROOT + '/nodes', ROOT + '/node_modules', ROOT + '/node_modules/' + MODULE]) {
        directory(dir); const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      image(true); idle(); assertExclusive();
    },
  };
}

export function assertNoAdapterDescendants(processes, rootPid) {
  need(Number.isSafeInteger(rootPid) && rootPid > 1 && processes.some(row => row.pid === rootPid), 'ADAPTER_INSTALLER_CENSUS');
  const descendants = new Set([rootPid]); let changed = true;
  while (changed) { changed = false; for (const row of processes) if (descendants.has(row.parentPid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; } }
  // This runtime has no baseline children. Any child blocks, including another UID.
  need(descendants.size === 1, 'ADAPTER_INSTALLER_DESCENDANTS');
  return true;
}

export async function validateAdapterGraphPins(raw, pins) {
  const flow = JSON.parse(raw);
  need(Array.isArray(flow) && flow.length === pins.count && await support_photosGraphHash(flow) === pins.graphSha256
    && await support_photosOrderedGraphHash(flow) === pins.orderedGraphSha256, 'ADAPTER_SOURCE_GRAPH_DRIFT');
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { inspectBookingSource, BOOKING_HTTP_CONSUMER_SHA256 } from './lib/bookingTransportLiveContract.mjs';
import { sha256 } from './lib/subscriptionBookingTransportRecovery.mjs';
import { UNPAID_SOURCE_FILES } from './lib/unpaidWorkerSourceFiles.mjs';
import { lk1VivaBinding } from './lib/lk1LiveGatewayGuard.mjs';
import { assertUnpaidWorkerIdentity } from './lib/unpaidWorkerIdentity.mjs';

const flowPath = '/root/.node-red/flows.json';
const envPath = '/etc/padlhub/lk1-unpaid-cancel.env';
const workerLink = '/opt/padlhub-lk1-unpaid-cancel/current';
const origin = 'http://127.0.0.1:1880';
const BUNDLE_FILES = Object.keys(UNPAID_SOURCE_FILES);
let stage = 'INPUT';
const privateFile = (file, privateDirectory = true) => {
  const dir = path.dirname(file), stat = fs.lstatSync(dir);
  if (fs.realpathSync(dir) !== dir || !stat.isDirectory() || stat.uid !== process.getuid()
    || (stat.mode & (privateDirectory ? 0o077 : 0o022))) throw new Error('PRIVATE_INPUT_INVALID');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('PRIVATE_INPUT_INVALID');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
};
const processes = () => JSON.parse(execFileSync('/usr/local/bin/pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 10_000_000, timeout: 10000 }));
const identity = p => [p.pid, p.pm2_env.pm_uptime, p.pm2_env.restart_time, p.pm2_env.status];
const workerIdentity = config => {
  const names = ['MainPID', 'ActiveState', 'SubState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'WorkingDirectory', 'EnvironmentFiles', 'ExecStart'];
  const properties = Object.fromEntries(execFileSync('systemctl', ['show', 'lk1-unpaid-cancel.service', ...names.flatMap(n => ['-p', n])], { encoding: 'utf8' })
    .trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (!/^[1-9][0-9]*$/.test(properties.MainPID || '')) throw new Error('WORKER_PID_INVALID');
  const proc = '/proc/' + properties.MainPID, releasePath = fs.realpathSync(workerLink);
  const raw = fs.readFileSync(proc + '/stat', 'utf8');
  return assertUnpaidWorkerIdentity({ properties, config,
    processEnvironment: Object.fromEntries(fs.readFileSync(proc + '/environ', 'utf8').split('\0').filter(Boolean).map(l => { const at = l.indexOf('='); return [l.slice(0, at), l.slice(at + 1)]; })),
    argv: fs.readFileSync(proc + '/cmdline', 'utf8').split('\0').filter(Boolean),
    startedAt: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19],
    cwd: fs.realpathSync(proc + '/cwd'), executable: fs.realpathSync(proc + '/exe'), expectedExecutable: fs.realpathSync('/usr/local/bin/node'), releasePath,
    unitSha256: sha256(fs.readFileSync('/etc/systemd/system/lk1-unpaid-cancel.service')),
    environmentSha256: sha256(Buffer.from(privateFile(envPath, false))),
    manifestSha256: sha256(fs.readFileSync(path.join(releasePath, 'manifest.json'))) });
};
const read = async (route, headers) => {
  if (!['/flows', '/lk/subscription-bookings'].includes(route)) throw new Error('READ_ROUTE_FORBIDDEN');
  const response = await fetch(origin + route, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
  return { status: response.status, body: await response.json() };
};

try {
  const beforeProcesses = processes(), nodeRed = beforeProcesses.filter(p => p.name === 'node-red');
  if (nodeRed.length !== 1 || nodeRed[0].pm2_env.status !== 'online') throw new Error('NODE_RED_NOT_STABLE');
  const disk = fs.readFileSync(flowPath), originalFlow = JSON.parse(disk);
  const nodeRedRoot = path.dirname(fs.realpathSync(nodeRed[0].pm2_env.pm_exec_path));
  const httpConsumerSha256 = sha256(fs.readFileSync(path.join(nodeRedRoot, 'node_modules/@node-red/nodes/core/network/21-httprequest.js')));
  if (httpConsumerSha256 !== BOOKING_HTTP_CONSUMER_SHA256) throw new Error('HTTP_CONSUMER_DRIFT');
  if (fs.statSync(flowPath).mtimeMs > nodeRed[0].pm2_env.pm_uptime) throw new Error('DISK_NOT_LOADED');
  const envBytes = privateFile(envPath, false), config = Object.fromEntries(envBytes.split('\n')
    .filter(l => /^[A-Z][A-Z0-9_]*=/.test(l)).map(l => { const at = l.indexOf('='); return [l.slice(0, at), l.slice(at + 1).replace(/^["']|["']$/g, '')]; }));
  stage = 'BINDING';
  const initialWorker = workerIdentity(config);
  if (lk1VivaBinding(nodeRed[0])?.sha256 !== config.LK1_UNPAID_CANCEL_BINDING_SHA256) throw new Error('VIVA_BINDING_DRIFT');
  const token = privateFile(config.LK1_UNPAID_CANCEL_NODE_RED_ADMIN_TOKEN_FILE).trim();
  if (token.length < 16 || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('TOKEN_SHAPE_INVALID');
  stage = 'ADMIN_GET';
  const active = await read('/flows', { Authorization: `Bearer ${token}`, 'Node-RED-API-Version': 'v2' });
  if (active.status !== 200 || !active.body.rev || !isDeepStrictEqual(active.body.flows, originalFlow)) throw new Error('ACTIVE_FLOW_DRIFT');
  const probes = [];
  stage = 'CAPABILITIES';
  for (const [version, policy] of [['1', 'ATOMIC_MANAGED_V1'], ['2', 'MANAGED_JOIN_V2'], ['3', 'MANAGED_SELF_LEAVE_V1'], ['training', 'TRAINING_LEGACY_V1']]) {
    const headers = version === 'training' ? { 'x-training-registration-owner-contract': '1' } : { 'x-booked-operation-owner-contract': version };
    const response = await read('/lk/subscription-bookings', headers);
    const unsupportedCode = version === 'training' ? 'TRAINING_REGISTRATION_OWNER_UNAVAILABLE' : 'BOOKED_OPERATION_OWNER_PROBE_NOT_FOUND';
    if (['3', 'training'].includes(version) && response.status === 404 && response.body.code === unsupportedCode) {
      probes.push({ version, status: 404, supported: false, code: unsupportedCode }); continue;
    }
    if (response.status !== 200 || response.body.owner !== 'LK1_SUBSCRIPTION_BOOKING_OWNER'
      || response.body.policy !== policy || response.body.contractVersion !== (version === 'training' ? 1 : Number(version))) throw new Error('LIVE_CAPABILITY_FAILED');
    probes.push({ version, status: 200, supported: true, policy });
  }
  stage = 'OWNER_VM';
  const proof = inspectBookingSource(disk);
  stage = 'WORKER';
  const releasePath = fs.realpathSync(workerLink), manifestBytes = fs.readFileSync(path.join(releasePath, 'manifest.json'));
  const baseManifest = JSON.parse(manifestBytes);
  if (baseManifest.schema !== 1 || Object.keys(baseManifest).sort().join() !== 'files,schema,sourceCommit'
    || Object.keys(baseManifest.files).sort().join() !== [...BUNDLE_FILES].sort().join()
    || sha256(Buffer.from(JSON.stringify(baseManifest, null, 2) + '\n')) !== sha256(manifestBytes)) throw new Error('BASE_MANIFEST_INVALID');
  for (const file of BUNDLE_FILES) if (sha256(fs.readFileSync(path.join(releasePath, file))) !== baseManifest.files[file]) throw new Error('WORKER_FILE_DRIFT');
  stage = 'READBACK';
  const activeAfter = await read('/flows', { Authorization: `Bearer ${token}`, 'Node-RED-API-Version': 'v2' });
  const after = processes().filter(p => p.name === 'node-red');
  if (after.length !== 1 || !isDeepStrictEqual(identity(after[0]), identity(nodeRed[0]))
    || sha256(fs.readFileSync(flowPath)) !== proof.sourceSha256 || activeAfter.body.rev !== active.body.rev
    || !isDeepStrictEqual(activeAfter.body.flows, originalFlow) || sha256(Buffer.from(privateFile(envPath, false))) !== sha256(Buffer.from(envBytes))
    || !isDeepStrictEqual(workerIdentity(config), initialWorker)) throw new Error('RUNTIME_CHANGED_DURING_PROOF');
  const unit = fs.readFileSync('/etc/systemd/system/lk1-unpaid-cancel.service');
  const serviceState = execFileSync('systemctl', ['is-active', 'lk1-unpaid-cancel.service'], { encoding: 'utf8' }).trim();
  const unitNames = execFileSync('systemctl', ['list-units', '--all', '--type=service', '--no-legend', '--plain'], { encoding: 'utf8' });
  const otherWorkerPresent = beforeProcesses.some(p => p.name !== 'node-red' && /subscription|visit|unpaid/i.test(p.name))
    || unitNames.split('\n').some(l => /subscription.*visit|visit.*subscription/i.test(l));
  if (otherWorkerPresent || serviceState !== 'active' || sha256(unit) !== baseManifest.files['lk1-unpaid-cancel.service']) throw new Error('WORKER_INVENTORY_CHANGED');
  const settings = fs.readFileSync('/root/.node-red/settings.js', 'utf8');
  const retainedAuthModuleRefs = [...new Set(settings.match(/\/opt\/padlhub-lk1-unpaid-cancel\/releases\/[a-zA-Z0-9._-]+\/lib\/lk1FlowReadTokenAuth\.cjs/g) || [])]
    .map(modulePath => ({ modulePath, sha256: sha256(fs.readFileSync(modulePath)) }));
  console.log(JSON.stringify({ schema: 1, observedUtc: new Date().toISOString(), ...proof,
    httpConsumerSha256, transportGap: 'SENDERR_TRUE_WITHOUT_HTTP_CATCH',
    activeFlowMatchesDisk: true, processStable: true, bindingMatchesWorker: true, probes,
    worker: { releasePath, baseManifest, baseManifestSha256: sha256(manifestBytes), serviceActive: true,
      unitSha256: sha256(unit), environmentSha256: sha256(Buffer.from(envBytes)), otherWorkerPresent: false,
      identity: initialWorker, retainedAuthModuleRefs },
    productionWrites: 0, businessRequests: 0, privateSourceExported: false }));
} catch {
  console.error('BOOKING_TRANSPORT_RUNTIME_INSPECTION_FAILED_' + stage); process.exitCode = 1;
}

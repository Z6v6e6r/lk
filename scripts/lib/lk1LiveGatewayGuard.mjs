import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const LK1_UNPAID_FLOW_SHA256 = 'd9764f7b6a883a644ee319a6fed44c1b087e701d030aef2c7d7c718751840087';
export const LK1_UNPAID_GATEWAY_SHA256 = 'e3b46e691517118cabbe259bb3831b99896b3f8a32202b437fa452d8349f17ee';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const bindingNames = ['VIVA_SERVICE_TOKEN_URL', 'VIVA_SERVICE_CLIENT_ID',
  'VIVA_SERVICE_USERNAME', 'VIVA_SERVICE_PASSWORD'];

function liveProcesses() {
  return JSON.parse(execFileSync('/usr/local/bin/pm2', ['jlist'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 10_000_000,
  }));
}

async function readAdminToken(file) {
  if (!path.isAbsolute(file || '')) throw new Lk1LiveGatewayError('LIVE_GATEWAY_ADMIN_AUTH_UNAVAILABLE');
  const directory = path.dirname(file);
  let handle;
  try {
    const dirStat = await fsp.lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()
      || dirStat.uid !== process.getuid() || (dirStat.mode & 0o077) !== 0
      || await fsp.realpath(directory) !== directory) throw new Error('UNSAFE_DIRECTORY');
    handle = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0 || stat.size < 16 || stat.size > 4096) {
      throw new Error('UNSAFE_FILE');
    }
    const token = (await handle.readFile('utf8')).trim();
    if (token.length < 16 || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error('UNSAFE_TOKEN');
    }
    return token;
  } catch {
    throw new Lk1LiveGatewayError('LIVE_GATEWAY_ADMIN_AUTH_UNAVAILABLE');
  } finally {
    await handle?.close();
  }
}

export function lk1VivaBinding(nodeRed) {
  const source = nodeRed?.pm2_env;
  if (!source) return null;
  const values = bindingNames.map(name => source[name] || source.env?.[name]);
  if (values.some(value => typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value))) return null;
  return { values, sha256: sha(JSON.stringify(values)) };
}

export class Lk1LiveGatewayError extends Error {
  constructor(reason) {
    super(reason);
    this.code = reason;
  }
}

// A new worker may bind to a restarted PM2 process only after the exact
// approved flow, service credentials and live HTTP route all pass again.
export async function createLk1LiveGatewayGuard({
  flowPath = '/root/.node-red/flows.json', processes = liveProcesses,
  expectedFlowSha = LK1_UNPAID_FLOW_SHA256,
  expectedGatewaySha = LK1_UNPAID_GATEWAY_SHA256,
  expectedBindingSha = process.env.LK1_UNPAID_CANCEL_BINDING_SHA256,
  adminTokenFile = process.env.LK1_UNPAID_CANCEL_NODE_RED_ADMIN_TOKEN_FILE,
  fetchImpl = fetch,
  readinessUrl = 'http://127.0.0.1:1880/lk/subscription-bookings',
  adminUrl = 'http://127.0.0.1:1880/flows',
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedFlowSha) || !/^[a-f0-9]{64}$/.test(expectedBindingSha || '')) {
    throw new Lk1LiveGatewayError('LIVE_GATEWAY_BINDING_INVALID');
  }
  function snapshot() {
    let bytes, flow, stat;
    try {
      bytes = fs.readFileSync(flowPath);
      flow = JSON.parse(bytes);
      stat = fs.statSync(flowPath);
    } catch { return { state: 'DRIFT' }; }
    if (!Array.isArray(flow) || sha(bytes) !== expectedFlowSha) return { state: 'DRIFT' };
    const gateway = flow.filter(node => node?.id === 'lk_subscription_booking_router_20260804');
    if (gateway.length !== 1 || gateway[0].type !== 'function'
      || sha(gateway[0].func || '') !== expectedGatewaySha) return { state: 'DRIFT' };
    let matches;
    try { matches = processes().filter(item => item?.name === 'node-red'); }
    catch { return { state: 'RESTART_PENDING' }; }
    if (matches.length === 0) return { state: 'RESTART_PENDING' };
    if (matches.length !== 1) return { state: 'DRIFT' };
    const nodeRed = matches[0];
    if (nodeRed?.pm2_env?.status !== 'online' || !Number.isSafeInteger(nodeRed.pid)
      || nodeRed.pid <= 0 || !Number.isSafeInteger(nodeRed.pm2_env.pm_uptime)
      || !Number.isSafeInteger(nodeRed.pm2_env.restart_time)
      || Date.now() - nodeRed.pm2_env.pm_uptime < 30_000) return { state: 'RESTART_PENDING' };
    if (stat.mtimeMs > nodeRed.pm2_env.pm_uptime
      || lk1VivaBinding(nodeRed)?.sha256 !== expectedBindingSha) return { state: 'DRIFT' };
    return { state: 'ONLINE', pid: nodeRed.pid, uptime: nodeRed.pm2_env.pm_uptime,
      restart: nodeRed.pm2_env.restart_time, flow };
  }

  const initial = snapshot();
  if (initial.state !== 'ONLINE') throw new Lk1LiveGatewayError(
    initial.state === 'DRIFT' ? 'LIVE_GATEWAY_DRIFT' : 'LIVE_GATEWAY_RESTART_PENDING');
  const token = await readAdminToken(adminTokenFile);
  const activeFlowFailure = () => {
    const current = snapshot();
    if (current.state === 'DRIFT') return 'LIVE_GATEWAY_DRIFT';
    if (current.state !== 'ONLINE'
      || ['pid', 'uptime', 'restart'].some(key => current[key] !== initial[key])) {
      return 'LIVE_GATEWAY_RESTART_PENDING';
    }
    return 'LIVE_GATEWAY_ACTIVE_FLOW_UNVERIFIED';
  };
  async function readActiveFlow() {
    let response;
    try {
      response = await fetchImpl(adminUrl, { method: 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Node-RED-API-Version': 'v2' },
        signal: AbortSignal.timeout(8000) });
    } catch { throw new Lk1LiveGatewayError(activeFlowFailure()); }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (response.status !== 200 || !body || typeof body.rev !== 'string'
      || !body.rev || !Array.isArray(body.flows)) {
      throw new Lk1LiveGatewayError(activeFlowFailure());
    }
    const gateway = body.flows.filter(node => node?.id === 'lk_subscription_booking_router_20260804');
    if (gateway.length !== 1 || gateway[0].type !== 'function'
      || sha(gateway[0].func || '') !== expectedGatewaySha
      || !isDeepStrictEqual(body.flows, initial.flow)) {
      throw new Lk1LiveGatewayError(activeFlowFailure());
    }
    return body.rev;
  }
  const firstRevision = await readActiveFlow();
  let response;
  try {
    response = await fetchImpl(readinessUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'error',
      signal: AbortSignal.timeout(8000) });
  } catch {
    const state = activeFlowFailure();
    throw new Lk1LiveGatewayError(state === 'LIVE_GATEWAY_ACTIVE_FLOW_UNVERIFIED'
      ? 'LIVE_GATEWAY_ROUTE_UNVERIFIED' : state);
  }
  let body;
  try { body = await response.json(); } catch { body = null; }
  const secondRevision = await readActiveFlow();
  const after = snapshot();
  if (after.state !== 'ONLINE' || ['pid', 'uptime', 'restart'].some(key => after[key] !== initial[key])) {
    throw new Lk1LiveGatewayError(after.state === 'DRIFT' ? 'LIVE_GATEWAY_DRIFT' : 'LIVE_GATEWAY_RESTART_PENDING');
  }
  if (response.status !== 401 || body?.details?.code !== 'SUBSCRIPTION_BOOKING_AUTH_REQUIRED') {
    throw new Lk1LiveGatewayError('LIVE_GATEWAY_ROUTE_UNVERIFIED');
  }
  if (firstRevision !== secondRevision || !isDeepStrictEqual(after.flow, initial.flow)) {
    throw new Lk1LiveGatewayError('LIVE_GATEWAY_ACTIVE_FLOW_UNVERIFIED');
  }
  return { check() {
    const current = snapshot();
    if (current.state === 'DRIFT') return 'DRIFT';
    if (current.state !== 'ONLINE'
      || ['pid', 'uptime', 'restart'].some(key => current[key] !== initial[key])) return 'RESTART_PENDING';
    return 'HEALTHY';
  } };
}

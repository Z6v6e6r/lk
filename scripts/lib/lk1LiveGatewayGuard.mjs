import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const LK1_UNPAID_GATEWAY_SHA256 = 'e3b46e691517118cabbe259bb3831b99896b3f8a32202b437fa452d8349f17ee';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function liveProcesses() {
  return JSON.parse(execFileSync('/usr/local/bin/pm2', ['jlist'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 10_000_000,
  }));
}

// Pin both the deployed flow bytes and the running Node-RED instance. Every
// ENFORCE_NEW attempt rechecks this pin, including immediately before Viva PUT.
export function createLk1LiveGatewayGuard({
  flowPath = '/root/.node-red/flows.json', processes = liveProcesses,
  expectedGatewaySha = LK1_UNPAID_GATEWAY_SHA256,
} = {}) {
  function snapshot() {
    try {
      const bytes = fs.readFileSync(flowPath);
      const flow = JSON.parse(bytes);
      if (!Array.isArray(flow)) return null;
      const gateway = flow.filter(node => node?.id === 'lk_subscription_booking_router_20260804');
      if (gateway.length !== 1 || gateway[0].type !== 'function'
        || sha(gateway[0].func || '') !== expectedGatewaySha) return null;
      const matches = processes().filter(item => item?.name === 'node-red');
      const nodeRed = matches[0];
      if (matches.length !== 1 || nodeRed?.pm2_env?.status !== 'online'
        || !Number.isSafeInteger(nodeRed.pid) || nodeRed.pid <= 0
        || !Number.isSafeInteger(nodeRed.pm2_env.pm_uptime)
        || !Number.isSafeInteger(nodeRed.pm2_env.restart_time)
        || fs.statSync(flowPath).mtimeMs > nodeRed.pm2_env.pm_uptime) return null;
      return { flowSha: sha(bytes), pid: nodeRed.pid,
        uptime: nodeRed.pm2_env.pm_uptime, restart: nodeRed.pm2_env.restart_time };
    } catch { return null; }
  }
  const initial = snapshot();
  if (!initial) throw new Error('LIVE_GATEWAY_GUARD_NOT_VERIFIED');
  return { check() {
    const current = snapshot();
    return current !== null && Object.keys(initial).every(key => current[key] === initial[key]);
  } };
}

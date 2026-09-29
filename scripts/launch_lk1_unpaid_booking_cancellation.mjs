#!/usr/bin/env node

// Runtime bridge to credentials already held by the production Node-RED
// process. It writes no credential or bearer-token file. OFF exits before
// reading either the live flow or PM2 environment.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lk1VivaBinding } from './lib/lk1LiveGatewayGuard.mjs';

const mode = process.env.LK1_UNPAID_CANCEL_MODE || 'OFF';
if (process.argv.slice(2).some(arg => ['--mode', '--tenant', '--cohort-from'].includes(arg))) {
  throw new Error('LAUNCH_ARGUMENT_OVERRIDE_FORBIDDEN');
}
if (mode !== 'OFF') {
  if (!['SHADOW', 'ENFORCE_NEW'].includes(mode)) throw new Error('MODE_INVALID');
  if (process.env.LK1_UNPAID_CANCEL_TOKEN_FILE
    || process.env.LK1_UNPAID_CANCEL_VIVA_SERVICE_CONFIG_FILE
    || process.env.LK1_UNPAID_CANCEL_MONGO_URI) throw new Error('CREDENTIAL_SOURCE_CONFLICT');
  const flow = JSON.parse(fs.readFileSync('/root/.node-red/flows.json', 'utf8'));
  if (!Array.isArray(flow)) throw new Error('LIVE_FLOW_UNAVAILABLE');
  const mongo = flow.find(node => node?.id === '4e820638cc39c730');
  if (mongo?.type !== 'mongodb4-client' || mongo.dbName !== 'games'
    || typeof mongo.uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//.test(mongo.uri)) {
    throw new Error('LIVE_MONGO_BINDING_INVALID');
  }
  let processes;
  try {
    processes = JSON.parse(execFileSync('/usr/local/bin/pm2', ['jlist'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 10_000_000,
    }));
  } catch { throw new Error('NODE_RED_PROCESS_READ_UNAVAILABLE'); }
  const nodeRed = processes.find(item => item?.name === 'node-red');
  if (nodeRed?.pm2_env?.status !== 'online') throw new Error('NODE_RED_NOT_ONLINE');
  const binding = lk1VivaBinding(nodeRed);
  if (!binding) throw new Error('VIVA_SERVICE_BINDING_INVALID');
  if (mode === 'ENFORCE_NEW'
    && binding.sha256 !== process.env.LK1_UNPAID_CANCEL_BINDING_SHA256) {
    process.stdout.write('{"state":"STOPPED","reason":"VIVA_SERVICE_BINDING_DRIFT"}\n');
    process.exit(78);
  }
  for (const [index, name] of ['VIVA_SERVICE_TOKEN_URL', 'VIVA_SERVICE_CLIENT_ID',
    'VIVA_SERVICE_USERNAME', 'VIVA_SERVICE_PASSWORD'].entries()) {
    process.env[name] = binding.values[index];
  }
  if (process.env.VIVA_SERVICE_TOKEN_URL
    !== 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token') {
    throw new Error('VIVA_SERVICE_BINDING_INVALID');
  }
  process.env.LK1_UNPAID_CANCEL_MONGO_URI = mongo.uri;
  process.env.LK1_UNPAID_CANCEL_DB = 'games';
}
await import('./run_lk1_unpaid_booking_cancellation.mjs');

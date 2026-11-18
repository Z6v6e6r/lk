import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLk1LiveGatewayGuard, lk1VivaBinding } from '../lib/lk1LiveGatewayGuard.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-native-guard-')));
  fs.chmodSync(folder, 0o700);
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const flowPath = path.join(folder, 'flows.json'), adminTokenFile = path.join(folder, 'token');
  const flow = [{ id: 'lk_subscription_booking_router_20260804', type: 'function', func: 'return msg;' }];
  fs.writeFileSync(flowPath, JSON.stringify(flow));
  fs.writeFileSync(adminTokenFile, 'fixture-admin-native-token', { mode: 0o600 });
  const timestamp = Date.now() - 10000;
  const touch = (mtime = timestamp) => fs.utimesSync(flowPath, mtime / 1000, mtime / 1000);
  touch();
  const nodeRed = { name: 'node-red', pid: 123, pm2_env: {
    status: 'online', pm_uptime: Date.now() - 60000, restart_time: 7,
    VIVA_SERVICE_TOKEN_URL: 'https://example.test/token', VIVA_SERVICE_CLIENT_ID: 'fixture',
    VIVA_SERVICE_USERNAME: 'fixture', VIVA_SERVICE_PASSWORD: 'fixture',
  } };
  let calls = 0;
  const create = hook => createLk1LiveGatewayGuard({ flowPath, adminTokenFile,
    expectedFlowSha: sha(fs.readFileSync(flowPath)), expectedGatewaySha: sha(flow[0].func),
    expectedBindingSha: lk1VivaBinding(nodeRed).sha256, processes: () => [nodeRed],
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(options.method, url.endsWith('/flows') ? 'GET' : 'POST');
      if (!url.endsWith('/flows')) assert.equal(options.body, '{}');
      await hook?.(calls, nodeRed);
      return url.endsWith('/flows')
        ? { status: 200, json: async () => ({ rev: 'fixed-revision', flows: structuredClone(flow) }) }
        : { status: 401, json: async () => ({ details: { code: 'SUBSCRIPTION_BOOKING_AUTH_REQUIRED' } }) };
    } });
  return { flowPath, touch, timestamp, nodeRed, create, calls: () => calls };
}

test('native deployment after PM2 start requires two exact active reads and a route refusal', async t => {
  const f = fixture(t), guard = await f.create();
  assert.equal(f.calls(), 3);
  assert.equal(guard.check(), 'HEALTHY');
  f.touch(f.timestamp + 1000);
  assert.equal(guard.check(), 'DRIFT');
});

for (const stage of [1, 2, 3]) test(`same-byte touch during attestation step ${stage} fails closed`, async t => {
  const f = fixture(t);
  await assert.rejects(f.create(call => { if (call === stage) f.touch(f.timestamp + 1000); }), /LIVE_GATEWAY_DRIFT/);
});

test('future timestamp fails before any HTTP request', async t => {
  const f = fixture(t); f.touch(Date.now() + 60000);
  await assert.rejects(f.create(), /LIVE_GATEWAY_DRIFT/);
  assert.equal(f.calls(), 0);
});

test('changed bytes with the same timestamp fail after successful attestation', async t => {
  const f = fixture(t), guard = await f.create();
  fs.appendFileSync(f.flowPath, '\n'); f.touch();
  assert.equal(guard.check(), 'DRIFT');
});

for (const stage of [1, 2, 3]) test(`process restart during native attestation step ${stage} is refused`, async t => {
  const f = fixture(t);
  await assert.rejects(f.create((call, p) => { if (call === stage) p.pid++; }), /LIVE_GATEWAY_RESTART_PENDING/);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCancellationSyncRecovery } from '../prepare_cancellation_sync_recovery.mjs';
import { fixture } from './fixtures/lk1FreeCancellationFixtures.mjs';
import { lk1SeatReleasedOperation } from '../lib/lk1FreeCancellation.mjs';
const root = process.env.NODERED_RUNTIME_ROOT, input = process.env.CANCELLATION_SYNC_LIVE_SOURCE;
test('real isolated Node-RED runs exact candidate router, has no startup effects and restores inverse', {
  skip: (!root || !input) && 'requires isolated runtime and private baseline', timeout: 30000,
}, async () => {
  const require = createRequire(path.join(root, 'package.json'));
  assert.equal(require('node-red/package.json').version, '4.0.9');
  const RED = require('node-red'), express = require('express'), app = express(), server = http.createServer(app);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-sync-runtime-'));
  const f = fixture(); f.b.isCancelled = f.b.cancelled = true;
  Object.assign(f.sub, { status: 'ACTIVE', variant: 'BY_VISITS', visitsLeft: 29,
    bookings: [{ ...f.sub.bookings[1], exerciseDate: '2099-11-10T09:00:00Z' }] });
  const key = `lk1-daily-visit:${JSON.stringify([f.op.tenantKey, f.op.clientSubscriptionId, f.op.serviceDate])}`;
  const guard = { _id: key, kind: 'LK1_DAILY_VISIT_V1', tenantKey: f.op.tenantKey,
    clientSubscriptionId: f.op.clientSubscriptionId, serviceDate: f.op.serviceDate,
    ownerOperationKey: f.op._id, ownerOperationId: f.op.operationId };
  f.db.rows.set(key, guard);
  const token = 'fixture.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url') + '.fixture';
  const errors = [];
  RED.init(server, { userDir, flowFile: 'flows.json', httpAdminRoot: '/', disableEditor: true,
    functionExternalModules: false, functionGlobalContext: { vivacrm_access_token: token },
    logging: { console: { level: 'off' }, fixture: { level: 'error', handler: () => e => errors.push(e.msg) } } });
  app.use(RED.httpAdmin);
  let finish, reject, hops = 0;
  const done = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  RED.nodes.registerType('cancellation-fixture-io', function(config) {
    RED.nodes.createNode(this, config);
    this.on('input', async msg => {
      try {
        if (++hops > 100) throw Error('HOP_LIMIT');
        const port = Number(config.port);
        if (msg._subscriptionBooking?.step === 'lk1_daily_visit_takeover') {
          assert.equal(port, 3); assert.equal(msg.payload[0].ownerOperationKey, f.op._id); finish(); return;
        }
        if (port === 0) {
          assert.equal(msg.method, 'GET'); const u = new URL(msg.url);
          const r = await f.provider.request({ method: msg.method, path: u.pathname + u.search });
          msg.payload = r.payload; msg.statusCode = r.status; msg.responseUrl = msg.url;
        } else if (port === 1) msg.payload = await f.db.find(JSON.parse(JSON.stringify(msg.payload))).limit(1001).toArray();
        else if (port === 3) msg.payload = await f.db.updateOne(...JSON.parse(JSON.stringify(msg.payload)));
        else throw Error('UNEXPECTED_PORT_' + port);
        this.send(msg);
      } catch(e) { reject(e); }
    });
  });
  const versions = new Set(); RED.events.on('runtime-event', e => { if (e.id === 'runtime-deploy') versions.add(e.payload.revision); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/flows`;
  const admin = async flow => {
    const current = await (await fetch(url, { headers: { 'Node-RED-API-Version': 'v2' } })).json();
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'Node-RED-API-Version': 'v2', 'Node-RED-Deployment-Type': 'nodes' }, body: JSON.stringify({ rev: current?.rev, flows: flow }) });
    assert.equal(response.status, 200); const ack = await response.json();
    for (let i = 0; i < 500 && !versions.has(ack.rev); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(versions.has(ack.rev));
  };
  try {
    await RED.start();
    const source = JSON.parse(fs.readFileSync(input)).find(n => n.id === 'lk_subscription_booking_router_20260804').func;
    const candidate = JSON.parse(composeCancellationSyncRecovery(fs.readFileSync(input)).candidateBytes)
      .find(n => n.id === 'lk_subscription_booking_router_20260804').func;
    // Only one reviewed function and synthetic I/O enter the isolated runtime.
    // No production injects, DB configs, startup hooks or network nodes are loaded.
    const graph = body => [{ id: 'tab', type: 'tab', label: 'Synthetic cancellation rehearsal' },
      { id: 'unrelated', type: 'function', z: 'tab', func: 'return msg;', outputs: 1, wires: [[]], x: 0, y: 0 },
      { id: 'router', type: 'function', z: 'tab', func: body, outputs: 8,
        wires: Array.from({ length: 8 }, (_, i) => ['io' + i]), x: 0, y: 0 },
      ...Array.from({ length: 8 }, (_, i) => ({ id: 'io' + i, type: 'cancellation-fixture-io', port: i,
        z: 'tab', wires: [['router']], x: 0, y: 0 }))];
    await admin(graph(source)); const unrelated = RED.nodes.getNode('unrelated');
    await admin(graph(candidate)); assert.strictEqual(RED.nodes.getNode('unrelated'), unrelated);
    assert.equal(f.provider.calls.length, 0); assert.equal(f.db.writes.length, 0); assert.equal(hops, 0);
    RED.nodes.getNode('router').receive({ _subscriptionBooking: { ...f.op, operationKey: 'new-operation',
      operationId: 'lk-subscription-new', action: 'book', caller: 'http', exerciseId: 'new-exercise',
      step: 'lk1_daily_visit_owner', lk1DailyVisitPrevious: guard, lk1: { ...f.op.lk1, dailyVisitPolicyVersion: 1 } }, payload: [f.op] });
    await Promise.race([done, new Promise((_, fail) => { const t = setTimeout(() => fail(Error('ROUTER_TIMEOUT')), 10000); t.unref(); })]);
    assert.ok(lk1SeatReleasedOperation(f.db.rows.get(f.op._id)));
    assert.ok(f.provider.calls.every(c => c.method === 'GET')); assert.equal(errors.length, 0);
    const before = f.provider.calls.length, writes = f.db.writes.length;
    await admin(graph(source)); assert.strictEqual(RED.nodes.getNode('unrelated'), unrelated);
    assert.equal(f.provider.calls.length, before); assert.equal(f.db.writes.length, writes);
  } finally {
    await RED.stop(); server.closeAllConnections(); await new Promise(r => server.close(r));
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
